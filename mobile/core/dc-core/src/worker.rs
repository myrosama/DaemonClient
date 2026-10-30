//! The user's worker: the metadata routes the core calls (RESEARCH §11).
//! Every call carries the session token; no file bytes go through here.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};

use crate::session::Session;
use crate::{CoreError, Secret, crypto};

pub struct Worker {
    http: reqwest::Client,
    session: Session,
}

impl Worker {
    pub fn new(http: reqwest::Client, session: Session) -> Self {
        Self { http, session }
    }

    pub fn session(&self) -> &Session {
        &self.session
    }

    async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, CoreError> {
        let reply = self
            .http
            .get(format!("{}{path}", self.session.worker_url))
            .bearer_auth(self.session.token.expose())
            .send()
            .await?;
        read_json(reply).await
    }

    pub async fn telegram_config(&self) -> Result<TelegramConfig, CoreError> {
        self.get("/api/server/telegram-config").await
    }

    pub async fn zke_config(&self) -> Result<ZkeConfig, CoreError> {
        self.get("/api/server/zke-config").await
    }

    /// The Photos key, or `None` when the library is not encrypted.
    pub async fn photos_key(&self) -> Result<Option<crypto::Key>, CoreError> {
        let zke = self.zke_config().await?;
        // The D1 worker sends "" for missing settings; the web treats that as no key too.
        let password = zke.password.filter(|p| !p.expose().is_empty());
        let salt = zke.salt.filter(|s| !s.is_empty());
        let (true, Some(password), Some(salt)) = (zke.enabled, password, salt) else {
            return Ok(None);
        };
        // PBKDF2 is slow on purpose: keep it off the async threads.
        let key = tokio::task::spawn_blocking(move || crypto::derive_key(password.expose(), &salt))
            .await
            .map_err(|e| CoreError::Internal(format!("key derivation stopped: {e}")))?
            .map_err(|e| CoreError::Server(format!("unusable encryption settings: {e}")))?;
        Ok(Some(key))
    }

    pub async fn manifest(&self, asset_id: &str) -> Result<AssetManifest, CoreError> {
        let valid = (1..=64).contains(&asset_id.len())
            && asset_id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-');
        if !valid {
            return Err(CoreError::BadAddress);
        }
        self.get(&format!("/api/assets/{asset_id}/dc-manifest"))
            .await
    }

    /// `items` are `(client id, base64 SHA-1)`.
    pub async fn bulk_upload_check(
        &self,
        items: &[(String, String)],
    ) -> Result<Vec<UploadCheck>, CoreError> {
        let assets: Vec<_> = items
            .iter()
            .map(|(id, checksum)| serde_json::json!({"id": id, "checksum": checksum}))
            .collect();
        let reply = self
            .http
            .post(format!(
                "{}/api/assets/bulk-upload-check",
                self.session.worker_url
            ))
            .bearer_auth(self.session.token.expose())
            .json(&serde_json::json!({ "assets": assets }))
            .send()
            .await?;
        Ok(read_json::<BulkCheckReply>(reply).await?.results)
    }
}

/// A worker reply as `T`: `401` → `SignedOut`, `404` → `NotFound`, any other
/// failure → `Server` with the reply's own `message`, scrubbed and short.
pub(crate) async fn read_json<T: DeserializeOwned>(
    reply: reqwest::Response,
) -> Result<T, CoreError> {
    match reply.status() {
        s if s.is_success() => Ok(reply.json().await?),
        reqwest::StatusCode::UNAUTHORIZED => Err(CoreError::SignedOut),
        reqwest::StatusCode::NOT_FOUND => Err(CoreError::NotFound),
        status => {
            let body: Option<serde_json::Value> = reply.json().await.ok();
            let message = body
                .as_ref()
                .and_then(|v| v.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or_default();
            // Scrub before cutting (a cut token is no longer recognisable), and
            // drop control and bidi characters: this text reaches logs and screens.
            let text: String = crate::logging::scrub(&format!("{} {message}", status.as_u16()))
                .chars()
                .filter(|c| {
                    !c.is_control()
                        && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
                })
                .take(200)
                .collect();
            Err(CoreError::Server(text))
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramConfig {
    #[serde(deserialize_with = "crate::secret::deserialize")]
    pub bot_token: Secret<String>,
    #[serde(deserialize_with = "string_or_number")]
    pub channel_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZkeConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, deserialize_with = "crate::secret::deserialize_option")]
    pub password: Option<Secret<String>>,
    #[serde(default)]
    pub salt: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetManifest {
    #[serde(default)]
    pub thumb_id: String,
    #[serde(default)]
    pub preview_id: String,
    #[serde(default)]
    pub original_id: String,
    #[serde(default)]
    pub chunks: Vec<ManifestChunk>,
    #[serde(default)]
    pub playback_chunks: Option<Vec<ManifestChunk>>,
    #[serde(default)]
    pub playback_size: Option<u64>,
    #[serde(default)]
    pub encryption_mode: String,
    #[serde(default)]
    pub mime_type: String,
    #[serde(default)]
    pub file_size: u64,
    #[serde(default)]
    pub is_heic: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ManifestChunk {
    pub index: u64,
    pub file_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadCheck {
    pub id: String,
    pub action: String,
    #[serde(default)]
    pub asset_id: Option<String>,
    #[serde(default)]
    pub is_trashed: bool,
}

impl UploadCheck {
    /// `false` means the library already holds this checksum (`asset_id`).
    pub fn accepted(&self) -> bool {
        self.action == "accept"
    }
}

#[derive(Deserialize)]
struct BulkCheckReply {
    results: Vec<UploadCheck>,
}

/// Telegram channel ids arrive as a string or a number, depending on where
/// the worker read them from.
fn string_or_number<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    match serde_json::Value::deserialize(d)? {
        serde_json::Value::String(s) => Ok(s),
        serde_json::Value::Number(n) => Ok(n.to_string()),
        _ => Err(serde::de::Error::custom("expected a string or a number")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn worker(server: &MockServer) -> Worker {
        Worker::new(
            crate::http::client().unwrap(),
            Session {
                worker_url: server.uri(),
                token: Secret::new("tok".to_owned()),
                user_id: "u1".into(),
                email: "a@b.uz".into(),
                name: "A".into(),
            },
        )
    }

    async fn serve(server: &MockServer, route: &str, reply: ResponseTemplate) {
        Mock::given(method("GET"))
            .and(path(route))
            .and(header("authorization", "Bearer tok"))
            .respond_with(reply)
            .expect(1)
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn reads_the_telegram_config_with_a_numeric_channel_and_hides_the_token() {
        let server = MockServer::start().await;
        let body = json!({"botToken": "123456789:AAH", "channelId": -1001234567890_i64, "proxyUrl": "https://x/proxy"});
        serve(
            &server,
            "/api/server/telegram-config",
            ResponseTemplate::new(200).set_body_json(body),
        )
        .await;
        let cfg = worker(&server).telegram_config().await.unwrap();
        assert_eq!(cfg.bot_token.expose(), "123456789:AAH");
        assert_eq!(cfg.channel_id, "-1001234567890");
        assert!(!format!("{cfg:?}").contains("AAH"));
    }

    #[tokio::test]
    async fn an_expired_session_is_signed_out_and_other_failures_carry_the_message() {
        let server = MockServer::start().await;
        serve(
            &server,
            "/api/server/zke-config",
            ResponseTemplate::new(401),
        )
        .await;
        assert!(matches!(
            worker(&server).zke_config().await,
            Err(CoreError::SignedOut)
        ));
        let server = MockServer::start().await;
        let reply = ResponseTemplate::new(500).set_body_json(json!({"message": "D1 unavailable"}));
        serve(&server, "/api/server/zke-config", reply).await;
        let err = worker(&server).zke_config().await.unwrap_err();
        assert!(
            matches!(&err, CoreError::Server(m) if m.contains("D1 unavailable")),
            "{err}"
        );
    }

    #[tokio::test]
    async fn server_messages_are_scrubbed_before_they_are_cut_and_lose_control_characters() {
        let server = MockServer::start().await;
        let message = format!(
            "{}https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/x\nFAKE LOG LINE\u{202e}",
            "x".repeat(130)
        );
        let reply = ResponseTemplate::new(500).set_body_json(json!({ "message": message }));
        serve(&server, "/api/server/zke-config", reply).await;
        let err = worker(&server).zke_config().await.unwrap_err().to_string();
        assert!(
            !err.contains("AAHdq") && !err.contains('\n') && !err.contains('\u{202e}'),
            "{err}"
        );
    }

    #[tokio::test]
    async fn a_reply_that_is_not_the_expected_json_is_a_server_error() {
        let server = MockServer::start().await;
        serve(
            &server,
            "/api/server/telegram-config",
            ResponseTemplate::new(200).set_body_string("<html>"),
        )
        .await;
        assert!(matches!(
            worker(&server).telegram_config().await,
            Err(CoreError::Server(_))
        ));
    }

    #[tokio::test]
    async fn derives_the_photos_key_only_when_encryption_is_on() {
        let server = MockServer::start().await;
        let on = json!({"enabled": true, "password": "correct horse battery staple",
                        "salt": "c2FsdC1zYWx0LXNhbHQhIQ==", "mode": "auto"});
        serve(
            &server,
            "/api/server/zke-config",
            ResponseTemplate::new(200).set_body_json(on),
        )
        .await;
        let key = worker(&server).photos_key().await.unwrap().unwrap();
        // The key the JavaScript derives from these (compat vectors, key 0) opens its parts.
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../../compat/vectors.json")).unwrap();
        let part =
            crypto::forgiving_base64(v["js_parts"][0]["part_b64"].as_str().unwrap()).unwrap();
        assert!(crypto::decrypt_part(&key, part).is_ok());
        let server = MockServer::start().await;
        serve(
            &server,
            "/api/server/zke-config",
            ResponseTemplate::new(200).set_body_json(json!({"enabled": false})),
        )
        .await;
        assert!(worker(&server).photos_key().await.unwrap().is_none());
        // The D1 worker sends empty strings for missing settings: that is no key, not a key from "".
        let server = MockServer::start().await;
        let incomplete = json!({"enabled": true, "password": "", "salt": "", "mode": "server"});
        serve(
            &server,
            "/api/server/zke-config",
            ResponseTemplate::new(200).set_body_json(incomplete),
        )
        .await;
        assert!(worker(&server).photos_key().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_missing_asset_is_not_found_and_an_undecodable_reply_echoes_no_values() {
        let server = MockServer::start().await;
        serve(
            &server,
            "/api/assets/abc/dc-manifest",
            ResponseTemplate::new(404),
        )
        .await;
        assert!(matches!(
            worker(&server).manifest("abc").await,
            Err(CoreError::NotFound)
        ));
        let server = MockServer::start().await;
        let wrong_type = json!({"enabled": "hunter2-secret"});
        serve(
            &server,
            "/api/server/zke-config",
            ResponseTemplate::new(200).set_body_json(wrong_type),
        )
        .await;
        let err = worker(&server).zke_config().await.unwrap_err();
        assert!(
            matches!(&err, CoreError::Server(m) if !m.contains("hunter2")),
            "{err}"
        );
    }

    #[tokio::test]
    async fn reads_a_manifest_and_refuses_odd_asset_ids() {
        let server = MockServer::start().await;
        let body = json!({
            "thumbId": "t", "previewId": "", "originalId": "o",
            "chunks": [{"index": 0, "file_id": "f0"}, {"index": 1, "file_id": "f1"}],
            "playbackChunks": [{"index": 0, "file_id": "p0"}], "playbackSize": 123,
            "encryptionMode": "server", "mimeType": "video/mp4", "fileSize": 20000000, "isHeic": false
        });
        serve(
            &server,
            "/api/assets/0a1b-2c/dc-manifest",
            ResponseTemplate::new(200).set_body_json(body),
        )
        .await;
        let m = worker(&server).manifest("0a1b-2c").await.unwrap();
        assert_eq!(
            (
                m.thumb_id.as_str(),
                m.original_id.as_str(),
                m.chunks.len(),
                m.file_size
            ),
            ("t", "o", 2, 20_000_000)
        );
        assert_eq!(m.playback_size, Some(123));
        let long = "a".repeat(65);
        for bad in ["../x", "a/b", "", "ABC", long.as_str()] {
            assert!(
                matches!(
                    worker(&server).manifest(bad).await,
                    Err(CoreError::BadAddress)
                ),
                "{bad}"
            );
        }
    }

    #[tokio::test]
    async fn bulk_checks_checksums() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/assets/bulk-upload-check"))
            .and(header("authorization", "Bearer tok"))
            .and(body_json(
                json!({"assets": [{"id": "a", "checksum": "c1"}, {"id": "b", "checksum": "c2"}]}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"results": [
                {"id": "a", "action": "accept"},
                {"id": "b", "action": "reject", "assetId": "x", "isTrashed": false}
            ]})))
            .expect(1)
            .mount(&server)
            .await;
        let items = [
            ("a".to_owned(), "c1".to_owned()),
            ("b".to_owned(), "c2".to_owned()),
        ];
        let r = worker(&server).bulk_upload_check(&items).await.unwrap();
        assert!(r[0].accepted() && !r[1].accepted());
        assert_eq!(r[1].asset_id.as_deref(), Some("x"));
    }
}
