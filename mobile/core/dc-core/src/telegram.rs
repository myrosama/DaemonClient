//! The user's own bot, spoken to directly (P1 design §5.4). The token is put
//! into a URL only at the moment of a request; errors never carry it.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use tokio::time::Instant;

use crate::sched::bucket::TokenBucket;
use crate::{CoreError, Secret};

/// Telegram's bot API serves files up to 20 MB; an encrypted part is 19 MiB + 28 B.
pub const MAX_DOWNLOAD: usize = 20 * 1024 * 1024;
/// The longest pause a `retry_after` can cause; Telegram's real ones are seconds to hours.
pub const MAX_PAUSE_SECS: u64 = 24 * 60 * 60;
const PATH_TTL: Duration = Duration::from_secs(55 * 60);
const PATH_CACHE_MAX: usize = 4096;

pub struct Telegram {
    http: reqwest::Client,
    api: String,
    token: Secret<String>,
    channel_id: String,
    paths: Mutex<HashMap<String, (String, Instant)>>,
    pacer: SendPacer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sent {
    pub message_id: i64,
    pub file_id: String,
}

impl Telegram {
    pub fn new(
        http: reqwest::Client,
        api: String,
        token: Secret<String>,
        channel_id: String,
    ) -> Self {
        let api = api.trim_end_matches('/').to_owned();
        Self {
            http,
            api,
            token,
            channel_id,
            paths: Mutex::new(HashMap::new()),
            pacer: SendPacer::new(),
        }
    }

    fn method_url(&self, method: &str) -> String {
        format!("{}/bot{}/{method}", self.api, self.token.expose())
    }

    /// The file's path on Telegram's file server; kept 55 minutes (Telegram's
    /// paths last about an hour), so a thumbnail usually costs one request.
    pub async fn get_file(&self, file_id: &str) -> Result<String, CoreError> {
        let now = Instant::now();
        if let Some((path, at)) = self.paths.lock().ok().and_then(|p| p.get(file_id).cloned())
            && now.saturating_duration_since(at) < PATH_TTL
        {
            return Ok(path);
        }
        let url =
            reqwest::Url::parse_with_params(&self.method_url("getFile"), [("file_id", file_id)])
                .map_err(|_| CoreError::Internal("the storage address is malformed".to_owned()))?;
        let file: FileInfo = answer(self.http.get(url).send().await?).await?;
        if let Ok(mut paths) = self.paths.lock() {
            if paths.len() >= PATH_CACHE_MAX {
                paths.retain(|_, (_, at)| now.saturating_duration_since(*at) < PATH_TTL);
                // shortcut: drops everything when 4,096 live paths are cached; an LRU if that ever matters.
                if paths.len() >= PATH_CACHE_MAX {
                    paths.clear();
                }
            }
            paths.insert(file_id.to_owned(), (file.file_path.clone(), now));
        }
        Ok(file.file_path)
    }

    /// The file's bytes (at most 20 MiB). A path that went stale is asked for once more.
    pub async fn download(&self, file_id: &str) -> Result<Vec<u8>, CoreError> {
        let path = self.get_file(file_id).await?;
        match self.fetch(&path).await? {
            Some(bytes) => Ok(bytes),
            None => {
                if let Ok(mut paths) = self.paths.lock() {
                    paths.remove(file_id);
                }
                let path = self.get_file(file_id).await?;
                self.fetch(&path).await?.ok_or_else(|| {
                    CoreError::Server("the storage no longer has this file".to_owned())
                })
            }
        }
    }

    /// `None` when the path is stale (400/404).
    async fn fetch(&self, path: &str) -> Result<Option<Vec<u8>>, CoreError> {
        let url = format!("{}/file/bot{}/{path}", self.api, self.token.expose());
        let mut reply = self.http.get(url).send().await?;
        let status = reply.status();
        if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::BAD_REQUEST {
            return Ok(None);
        }
        if status.is_server_error() {
            return Err(CoreError::Network(format!(
                "the storage answered {}",
                status.as_u16()
            )));
        }
        if !status.is_success() {
            return Err(CoreError::Server(format!(
                "the storage answered {}",
                status.as_u16()
            )));
        }
        let too_large = || CoreError::Server("a stored file is larger than 20 MiB".to_owned());
        if reply
            .content_length()
            .is_some_and(|n| n > MAX_DOWNLOAD as u64)
        {
            return Err(too_large());
        }
        // Bounded by the check above; avoids growing a 19 MiB part to 32 MiB.
        let mut bytes =
            Vec::with_capacity(reply.content_length().unwrap_or(0).try_into().unwrap_or(0));
        while let Some(chunk) = reply.chunk().await? {
            if bytes.len() + chunk.len() > MAX_DOWNLOAD {
                return Err(too_large());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(Some(bytes))
    }

    /// Sends one part (or an encrypted thumbnail) into the channel; paced.
    pub async fn send_document(&self, name: &str, bytes: Vec<u8>) -> Result<Sent, CoreError> {
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(name.to_owned())
            .mime_str("application/octet-stream")
            .map_err(|e| CoreError::Internal(format!("multipart: {e}")))?;
        let message: Message = self.send("sendDocument", "document", part).await?;
        let file_id = message.document.map(|d| d.file_id).ok_or_else(unexpected)?;
        Ok(Sent {
            message_id: message.message_id,
            file_id,
        })
    }

    /// Sends a JPEG thumbnail of an unencrypted library; paced.
    pub async fn send_photo(&self, jpeg: Vec<u8>) -> Result<Sent, CoreError> {
        let part = reqwest::multipart::Part::bytes(jpeg)
            .file_name("thumb.jpg")
            .mime_str("image/jpeg")
            .map_err(|e| CoreError::Internal(format!("multipart: {e}")))?;
        let message: Message = self.send("sendPhoto", "photo", part).await?;
        let file_id = message
            .photo
            .and_then(|sizes| sizes.into_iter().last())
            .map(|p| p.file_id)
            .ok_or_else(unexpected)?;
        Ok(Sent {
            message_id: message.message_id,
            file_id,
        })
    }

    async fn send(
        &self,
        method: &str,
        field: &str,
        part: reqwest::multipart::Part,
    ) -> Result<Message, CoreError> {
        self.pacer.acquire().await;
        let form = reqwest::multipart::Form::new()
            .text("chat_id", self.channel_id.clone())
            .part(field.to_owned(), part);
        let result = answer(
            self.http
                .post(self.method_url(method))
                .multipart(form)
                .send()
                .await?,
        )
        .await;
        if let Err(CoreError::RateLimited { retry_after }) = &result {
            self.pacer.pause_for(Duration::from_secs(*retry_after));
        }
        result
    }

    pub async fn delete_message(&self, message_id: i64) -> Result<(), CoreError> {
        let body = serde_json::json!({ "chat_id": self.channel_id, "message_id": message_id });
        let _: bool = answer(
            self.http
                .post(self.method_url("deleteMessage"))
                .json(&body)
                .send()
                .await?,
        )
        .await?;
        Ok(())
    }
}

fn unexpected() -> CoreError {
    CoreError::Server("unexpected reply from the storage".to_owned())
}

#[derive(Deserialize)]
struct Reply<T> {
    ok: bool,
    result: Option<T>,
    error_code: Option<u16>,
    description: Option<String>,
    parameters: Option<ReplyParameters>,
}

#[derive(Deserialize)]
struct ReplyParameters {
    retry_after: Option<u64>,
}

#[derive(Deserialize)]
struct FileInfo {
    file_path: String,
}

#[derive(Deserialize)]
struct Message {
    message_id: i64,
    document: Option<FileRef>,
    photo: Option<Vec<FileRef>>,
}

#[derive(Deserialize)]
struct FileRef {
    file_id: String,
}

/// Classifies a bot API answer: rate limits, refusals for good, the rest.
async fn answer<T: DeserializeOwned>(reply: reqwest::Response) -> Result<T, CoreError> {
    let status = reply.status();
    let Ok(body) = reply.json::<Reply<T>>().await else {
        return Err(match status.as_u16() {
            429 | 420 => CoreError::RateLimited { retry_after: 5 },
            code if code >= 500 => CoreError::Network(format!("the storage answered {code}")),
            _ if status.is_success() => unexpected(),
            code => CoreError::Server(format!("the storage answered {code}")),
        });
    };
    if body.ok
        && let Some(result) = body.result
    {
        return Ok(result);
    }
    let code = body.error_code.unwrap_or(status.as_u16());
    let description = crate::error::clean(body.description.as_deref().unwrap_or_default());
    match code {
        429 | 420 => Err(CoreError::RateLimited {
            retry_after: body
                .parameters
                .and_then(|p| p.retry_after)
                .unwrap_or(5)
                .min(MAX_PAUSE_SECS),
        }),
        400 | 401 | 403 | 404 => Err(CoreError::TelegramRejected(description)),
        code if code >= 500 => Err(CoreError::Network(format!(
            "the storage answered {code}: {description}"
        ))),
        _ => Err(CoreError::Server(format!(
            "the storage answered {code}: {description}"
        ))),
    }
}

/// Paces sends per bot: 1 per 1.5 s, bursts of 8 (RESEARCH §12), and a full
/// stop after Telegram says `retry_after`.
pub(crate) struct SendPacer {
    state: Mutex<(TokenBucket, Option<Instant>)>,
}

impl SendPacer {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new((TokenBucket::new(1.0 / 1.5, 8.0, Instant::now()), None)),
        }
    }

    pub(crate) async fn acquire(&self) {
        loop {
            let wait = {
                // A poisoned lock must not switch pacing off.
                let mut state = self
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let now = Instant::now();
                match state.1 {
                    Some(until) if until > now => until - now,
                    _ => {
                        state.1 = None;
                        if state.0.try_take(now) {
                            Duration::ZERO
                        } else {
                            state.0.wait(now)
                        }
                    }
                }
            };
            if wait.is_zero() {
                return;
            }
            tokio::time::sleep(wait).await;
        }
    }

    /// Stops sends for `wait` (at most a day); an earlier, longer pause wins.
    pub(crate) fn pause_for(&self, wait: Duration) {
        let wait = wait.min(Duration::from_secs(MAX_PAUSE_SECS));
        let until = Instant::now().checked_add(wait);
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.1 = state.1.max(until);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    const TOKEN: &str = "123456:TESTTOKEN";

    fn telegram(server: &MockServer) -> Telegram {
        Telegram::new(
            crate::http::client().unwrap(),
            server.uri(),
            Secret::new(TOKEN.to_owned()),
            "-100777".to_owned(),
        )
    }

    async fn get_file(server: &MockServer, id: &str, file_path: &str, times: u64) {
        Mock::given(method("GET"))
            .and(path(format!("/bot{TOKEN}/getFile")))
            .and(query_param("file_id", id))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"ok": true, "result": {"file_path": file_path}})),
            )
            .expect(times)
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn downloads_a_file_and_remembers_its_path() {
        let server = MockServer::start().await;
        get_file(&server, "f1", "documents/file_1.bin", 1).await;
        Mock::given(path(format!("/file/bot{TOKEN}/documents/file_1.bin")))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"part bytes".to_vec()))
            .expect(2)
            .mount(&server)
            .await;
        let tg = telegram(&server);
        assert_eq!(tg.download("f1").await.unwrap(), b"part bytes");
        assert_eq!(tg.download("f1").await.unwrap(), b"part bytes");
    }

    #[tokio::test]
    async fn a_stale_path_is_asked_for_once_more() {
        let server = MockServer::start().await;
        Mock::given(path(format!("/bot{TOKEN}/getFile")))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"ok": true, "result": {"file_path": "old"}})),
            )
            .up_to_n_times(1)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(path(format!("/bot{TOKEN}/getFile")))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"ok": true, "result": {"file_path": "new"}})),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(path(format!("/file/bot{TOKEN}/old")))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        Mock::given(path(format!("/file/bot{TOKEN}/new")))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"fresh".to_vec()))
            .mount(&server)
            .await;
        assert_eq!(telegram(&server).download("f1").await.unwrap(), b"fresh");
    }

    #[tokio::test]
    async fn refuses_files_over_twenty_mebibytes() {
        let server = MockServer::start().await;
        get_file(&server, "big", "big", 1).await;
        Mock::given(path(format!("/file/bot{TOKEN}/big")))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![0u8; MAX_DOWNLOAD + 1]))
            .mount(&server)
            .await;
        assert!(matches!(
            telegram(&server).download("big").await,
            Err(CoreError::Server(_))
        ));
    }

    #[tokio::test]
    async fn sends_a_document_into_the_channel() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(format!("/bot{TOKEN}/sendDocument")))
            .and(|req: &Request| {
                let body = String::from_utf8_lossy(&req.body);
                body.contains("name=\"chat_id\"")
                    && body.contains("-100777")
                    && body.contains("name=\"document\"; filename=\"0123abcd.part001\"")
                    && body.contains("secret bytes")
            })
            .respond_with(ResponseTemplate::new(200).set_body_json(
                json!({"ok": true, "result": {"message_id": 42, "document": {"file_id": "doc-id"}}}),
            ))
            .expect(1)
            .mount(&server)
            .await;
        let sent = telegram(&server)
            .send_document("0123abcd.part001", b"secret bytes".to_vec())
            .await
            .unwrap();
        assert_eq!((sent.message_id, sent.file_id.as_str()), (42, "doc-id"));
    }

    #[tokio::test]
    async fn a_photo_reports_its_largest_size() {
        let server = MockServer::start().await;
        Mock::given(path(format!("/bot{TOKEN}/sendPhoto")))
            .and(|req: &Request| {
                String::from_utf8_lossy(&req.body)
                    .contains("name=\"photo\"; filename=\"thumb.jpg\"")
            })
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"ok": true, "result": {
                    "message_id": 7, "photo": [{"file_id": "small"}, {"file_id": "large"}]
                }})),
            )
            .mount(&server)
            .await;
        let sent = telegram(&server)
            .send_photo(b"jpeg".to_vec())
            .await
            .unwrap();
        assert_eq!((sent.message_id, sent.file_id.as_str()), (7, "large"));
    }

    #[tokio::test]
    async fn classifies_rate_limits_and_refusals() {
        let server = MockServer::start().await;
        Mock::given(path(format!("/bot{TOKEN}/deleteMessage")))
            .respond_with(ResponseTemplate::new(429).set_body_json(json!({
                "ok": false, "error_code": 429, "description": "Too Many Requests: retry after 7",
                "parameters": {"retry_after": 7}
            })))
            .mount(&server)
            .await;
        let err = telegram(&server).delete_message(1).await.unwrap_err();
        assert!(
            matches!(err, CoreError::RateLimited { retry_after: 7 }),
            "{err}"
        );
        let server = MockServer::start().await;
        Mock::given(path(format!("/bot{TOKEN}/deleteMessage")))
            .respond_with(ResponseTemplate::new(403).set_body_json(json!({
                "ok": false, "error_code": 403, "description": "Forbidden: bot was kicked from the channel chat"
            })))
            .mount(&server)
            .await;
        let err = telegram(&server).delete_message(1).await.unwrap_err();
        assert!(
            matches!(&err, CoreError::TelegramRejected(m) if m.contains("bot was kicked")),
            "{err}"
        );
    }

    #[tokio::test]
    async fn errors_never_carry_the_bot_token() {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let token = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
        let tg = Telegram::new(
            crate::http::client().unwrap(),
            format!("http://127.0.0.1:{port}"),
            Secret::new(token.to_owned()),
            "-1".to_owned(),
        );
        let err = tg.download("f").await.unwrap_err().to_string();
        assert!(
            !err.contains("AAHdq") && !err.contains("123456789"),
            "{err}"
        );
    }

    #[tokio::test]
    async fn refuses_a_streamed_file_over_twenty_mebibytes_without_a_length() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).await;
            // No Content-Length: the body ends when the connection closes.
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
            let _ = socket.write_all(&vec![0u8; MAX_DOWNLOAD + 1]).await;
        });
        let tg = Telegram::new(
            crate::http::client().unwrap(),
            format!("http://{address}"),
            Secret::new(TOKEN.to_owned()),
            "-1".to_owned(),
        );
        assert!(matches!(tg.fetch("big").await, Err(CoreError::Server(_))));
    }

    #[tokio::test]
    async fn server_trouble_is_transient_and_a_bare_429_still_means_wait() {
        let server = MockServer::start().await;
        Mock::given(path(format!("/bot{TOKEN}/deleteMessage")))
            .respond_with(ResponseTemplate::new(502).set_body_string("Bad Gateway"))
            .mount(&server)
            .await;
        assert!(matches!(
            telegram(&server).delete_message(1).await,
            Err(CoreError::Network(_))
        ));
        let server = MockServer::start().await;
        Mock::given(path(format!("/bot{TOKEN}/deleteMessage")))
            .respond_with(ResponseTemplate::new(429).set_body_string("slow down"))
            .mount(&server)
            .await;
        let err = telegram(&server).delete_message(1).await.unwrap_err();
        assert!(
            matches!(err, CoreError::RateLimited { retry_after: 5 }),
            "{err}"
        );
    }

    #[tokio::test]
    async fn a_huge_retry_after_is_capped_and_refusals_are_cleaned() {
        let server = MockServer::start().await;
        Mock::given(path(format!("/bot{TOKEN}/deleteMessage")))
            .respond_with(ResponseTemplate::new(429).set_body_json(json!({
                "ok": false, "error_code": 429, "parameters": {"retry_after": u64::MAX}
            })))
            .mount(&server)
            .await;
        let err = telegram(&server).delete_message(1).await.unwrap_err();
        assert!(
            matches!(
                err,
                CoreError::RateLimited {
                    retry_after: MAX_PAUSE_SECS
                }
            ),
            "{err}"
        );
        let server = MockServer::start().await;
        let description = format!("Forbidden:\nFAKE LINE\u{202e}{}", "x".repeat(500));
        Mock::given(path(format!("/bot{TOKEN}/deleteMessage")))
            .respond_with(ResponseTemplate::new(403).set_body_json(json!({
                "ok": false, "error_code": 403, "description": description
            })))
            .mount(&server)
            .await;
        let err = telegram(&server).delete_message(1).await.unwrap_err();
        let CoreError::TelegramRejected(text) = &err else {
            panic!("{err}")
        };
        assert!(
            !text.contains('\n') && !text.contains('\u{202e}') && text.chars().count() <= 200,
            "{text}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_pacer_survives_a_huge_pause_and_keeps_the_longer_one() {
        let pacer = SendPacer::new();
        pacer.pause_for(std::time::Duration::from_secs(u64::MAX));
        let start = tokio::time::Instant::now();
        pacer.acquire().await;
        assert!(start.elapsed() <= std::time::Duration::from_secs(MAX_PAUSE_SECS + 1));
        let pacer = SendPacer::new();
        pacer.pause_for(std::time::Duration::from_secs(300));
        pacer.pause_for(std::time::Duration::from_secs(5));
        let start = tokio::time::Instant::now();
        pacer.acquire().await;
        assert!(start.elapsed() >= std::time::Duration::from_secs(300));
    }

    #[tokio::test(start_paused = true)]
    async fn sends_are_paced_eight_at_once_then_one_per_one_and_a_half_seconds() {
        let pacer = SendPacer::new();
        let start = tokio::time::Instant::now();
        for _ in 0..8 {
            pacer.acquire().await;
        }
        assert_eq!(start.elapsed(), std::time::Duration::ZERO);
        pacer.acquire().await;
        assert_eq!(start.elapsed(), std::time::Duration::from_millis(1500));
        pacer.pause_for(std::time::Duration::from_secs(10));
        pacer.acquire().await;
        assert!(start.elapsed() >= std::time::Duration::from_millis(11_500));
    }
}
