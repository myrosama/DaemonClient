//! The local media server (P1 design §5.7): Immich's image loaders and the
//! platform video players fetch `http://127.0.0.1:PORT/<secret>/api/…`, and
//! the core answers from the read path, a part ahead. Two listeners (C10):
//! the grid's and the viewer's, so an opened photo never queues behind
//! thumbnails in Android's six-connections-per-host pool. Request paths are
//! never logged: the secret is in them.

use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Weak};
use std::task::{Context, Poll, ready};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Empty, Full};
use hyper::body::{Body, Frame, Incoming};
use hyper::header::{
    ACCEPT_RANGES, CONNECTION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, HeaderValue, RANGE,
};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use subtle::ConstantTimeEq;

use crate::chunk_plan::{RangePlan, plan_range, plan_suffix};
use crate::reader::{RangeReader, Rendition};
use crate::sched::Class;
use crate::{Core, CoreError};

/// Any app on the phone can connect: one that sends no request is dropped.
const HEADER_TIMEOUT: Duration = Duration::from_secs(30);
/// Connections served at once per listener; more wait in the kernel's
/// queue, so another app cannot use up this one's file descriptors.
const MAX_CONNECTIONS: usize = 32;
/// How long a liveness challenge may take, connection and reply together.
const CHALLENGE_TIME: Duration = Duration::from_millis(750);
/// Accept errors in a row before a listener gives up (2 s with the pause);
/// another one then opens, with a new secret.
const ACCEPT_RETRIES: u32 = 20;

/// Where the apps fetch media; each base ends with its listener's secret.
/// No `Debug`: printing it would print the secrets.
#[derive(Clone, PartialEq, Eq)]
pub struct MediaServer {
    pub grid_base: String,
    pub viewer_base: String,
}

#[derive(Default)]
pub(crate) struct Listeners {
    grid: Option<Listener>,
    viewer: Option<Listener>,
}

struct Listener {
    base: String,
    secret: Arc<str>,
    address: std::net::SocketAddr,
    task: tokio::task::JoinHandle<()>,
}

impl Listener {
    /// Whether it is still ours and listening. iOS can close a suspended
    /// app's socket while its accept loop never notices, and another app can
    /// then take the port — so the port must answer a fresh challenge with
    /// an HMAC of this listener's secret. The secret itself is never sent.
    fn answers(&self) -> bool {
        let pass = || challenge(self.address, &self.secret);
        // Once more after a moment: a busy listener may just be slow. If it
        // still fails, reopening is safe (invariant a) — and staying could
        // mean staying with another app.
        !self.task.is_finished()
            && (pass() || {
                std::thread::sleep(Duration::from_millis(250));
                pass()
            })
    }
}

fn challenge(address: std::net::SocketAddr, secret: &str) -> bool {
    use std::io::{Read, Write};
    let mut nonce = [0u8; 32];
    if getrandom::fill(&mut nonce).is_err() {
        return false;
    }
    let nonce = crate::disk_cache::hex(&nonce);
    // One deadline for all of it: whatever holds the port, `ensure_running`
    // returns in bounded time.
    let deadline = Instant::now() + CHALLENGE_TIME;
    let left = || {
        deadline
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(1))
    };
    let (Some(expected), Ok(mut stream)) = (
        proof(secret, &nonce),
        std::net::TcpStream::connect_timeout(&address, left()),
    ) else {
        return false;
    };
    let request =
        format!("GET /alive/{nonce} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    if stream.set_write_timeout(Some(left())).is_err()
        || stream.write_all(request.as_bytes()).is_err()
    {
        return false;
    }
    let (mut reply, mut chunk) = (Vec::new(), [0u8; 128]);
    while reply.len() < 512 && Instant::now() < deadline {
        if stream.set_read_timeout(Some(left())).is_err() {
            return false;
        }
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => reply.extend(chunk.iter().take(n)),
            Err(_) => return false,
        }
    }
    String::from_utf8_lossy(&reply).ends_with(&expected)
}

/// HMAC-SHA256 of a challenge under a listener's secret, in hex.
fn proof(secret: &str, nonce: &str) -> Option<String> {
    use hmac::{KeyInit, Mac};
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(nonce.as_bytes());
    Some(crate::disk_cache::hex(&mac.finalize().into_bytes()))
}

impl Listeners {
    /// What iOS does to a suspended app: the sockets close, the tasks live on.
    #[cfg(test)]
    pub(crate) fn close(&mut self, handle: &tokio::runtime::Handle) {
        for listener in [&mut self.grid, &mut self.viewer].into_iter().flatten() {
            listener.task.abort();
            listener.task = handle.spawn(std::future::pending());
        }
    }
}

/// Opens whatever is not listening — on first use, or after the OS closed it.
pub(crate) fn ensure_running(
    core: &Arc<Core>,
    listeners: &mut Listeners,
) -> Result<MediaServer, CoreError> {
    for (slot, class) in [
        (&mut listeners.grid, Class::Visible),
        (&mut listeners.viewer, Class::Opened),
    ] {
        if !slot.as_ref().is_some_and(Listener::answers) {
            if let Some(dead) = slot.take() {
                dead.task.abort();
            }
            *slot = Some(listen(core, class)?);
        }
    }
    let base = |l: &Option<Listener>| l.as_ref().map(|l| l.base.clone());
    match (base(&listeners.grid), base(&listeners.viewer)) {
        (Some(grid_base), Some(viewer_base)) => Ok(MediaServer {
            grid_base,
            viewer_base,
        }),
        _ => Err(CoreError::Internal(
            "the media server did not start".to_owned(),
        )),
    }
}

/// One listener on a random loopback port, with a secret of its own (an
/// app that takes over a closed port must not learn the next one's); what
/// it reads goes at `class`.
fn listen(core: &Arc<Core>, class: Class) -> Result<Listener, CoreError> {
    let failed =
        |e: std::io::Error| CoreError::Internal(format!("the media server cannot listen: {e}"));
    let mut random = [0u8; 32];
    getrandom::fill(&mut random)
        .map_err(|_| CoreError::Internal("no random numbers for the media server".to_owned()))?;
    let secret: Arc<str> = crate::disk_cache::hex(&random).into();
    let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(failed)?;
    socket.set_nonblocking(true).map_err(failed)?;
    let address = socket.local_addr().map_err(failed)?;
    let base = format!("http://{address}/{secret}");
    let handle = core.handle().clone();
    let listener = {
        let _runtime = handle.enter();
        tokio::net::TcpListener::from_std(socket).map_err(failed)?
    };
    let secret_for_check = secret.clone();
    let core = Arc::downgrade(core);
    let slots = Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS));
    let task = handle.spawn(async move {
        // Its connections belong to this task: when it ends or is aborted
        // (a reopen), they end too, and the secret with them (invariant a).
        let mut connections = tokio::task::JoinSet::new();
        let mut errors = 0;
        loop {
            while connections.try_join_next().is_some() {}
            let Ok(slot) = slots.clone().acquire_owned().await else {
                return;
            };
            let stream = match listener.accept().await {
                Ok((stream, _)) => stream,
                // A client gone before it was accepted, no file descriptors
                // left, or the socket itself gone: pause, never spin, and
                // after a while give up — `ensure_running` opens another,
                // with a new secret.
                Err(_) => {
                    errors += 1;
                    if errors >= ACCEPT_RETRIES {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
            errors = 0;
            let (core, secret) = (core.clone(), secret.clone());
            connections.spawn(async move {
                let _slot = slot; // freed when the connection ends
                let service = hyper::service::service_fn(move |request| {
                    answer(core.clone(), secret.clone(), class, request)
                });
                // `half_close` stays off: a hang-up ends the connection and drops the work.
                let _ = hyper::server::conn::http1::Builder::new()
                    .timer(TokioTimer::new())
                    .header_read_timeout(HEADER_TIMEOUT)
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    Ok(Listener {
        base,
        secret: secret_for_check,
        address,
        task,
    })
}

type Reply = Response<UnsyncBoxBody<Bytes, std::io::Error>>;

async fn answer(
    core: Weak<Core>,
    secret: Arc<str>,
    class: Class,
    request: Request<Incoming>,
) -> Result<Reply, Infallible> {
    Ok(route(core, &secret, class, &request)
        .await
        .unwrap_or_else(empty))
}

/// The response, or the status of an empty one.
async fn route(
    core: Weak<Core>,
    secret: &str,
    class: Class,
    request: &Request<Incoming>,
) -> Result<Reply, StatusCode> {
    let path = request.uri().path().strip_prefix('/').unwrap_or_default();
    // `ensure_running`'s challenge: answered without the secret, proving it,
    // and touching no lock of the core — `ensure_running` holds one while it asks.
    if let Some(nonce) = path.strip_prefix("alive/") {
        let fresh = nonce.len() == 64 && nonce.bytes().all(|b| b.is_ascii_hexdigit());
        let proof = proof(secret, nonce).filter(|_| fresh && request.method() == Method::GET);
        let proof = proof.ok_or(StatusCode::NOT_FOUND)?;
        let mut reply = Response::new(
            Full::new(Bytes::from(proof))
                .map_err(|never| match never {})
                .boxed_unsync(),
        );
        reply
            .headers_mut()
            .insert(CONNECTION, HeaderValue::from_static("close"));
        return Ok(reply);
    }
    let (given, rest) = path.split_once('/').unwrap_or((path, ""));
    if !bool::from(given.as_bytes().ct_eq(secret.as_bytes())) {
        // Not the app: do not keep its connection open either.
        let mut reply = empty(StatusCode::FORBIDDEN);
        reply
            .headers_mut()
            .insert(CONNECTION, HeaderValue::from_static("close"));
        return Ok(reply);
    }
    let head = match *request.method() {
        Method::GET => false,
        Method::HEAD => true,
        _ => return Err(StatusCode::METHOD_NOT_ALLOWED),
    };
    let segments: Vec<&str> = rest.split('/').collect();
    let ["api", "assets", id, what @ ..] = segments.as_slice() else {
        return Err(StatusCode::NOT_FOUND);
    };
    let core = core.upgrade().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    match what {
        ["thumbnail"] => {
            let size = request
                .uri()
                .query()
                .unwrap_or_default()
                .split('&')
                .find_map(|p| p.strip_prefix("size="));
            let rendition = match size {
                Some("preview" | "fullsize") => Rendition::Preview,
                _ => Rendition::Thumbnail,
            };
            image(&core, id, rendition, class, head).await
        }
        ["original"] => media(&core, id, Rendition::Original, class, request, head).await,
        ["video", "playback"] => media(&core, id, Rendition::Playback, class, request, head).await,
        _ => Err(StatusCode::NOT_FOUND),
    }
}

async fn image(
    core: &Core,
    id: &str,
    rendition: Rendition,
    class: Class,
    head: bool,
) -> Result<Reply, StatusCode> {
    let image = core
        .image(id, rendition, class)
        .await
        .map_err(|e| status(&e))?;
    let length = image.bytes.len() as u64;
    let body = if head { Bytes::new() } else { image.bytes };
    let mut reply = Response::new(
        Full::new(body)
            .map_err(|never| match never {})
            .boxed_unsync(),
    );
    let headers = reply.headers_mut();
    headers.insert(CONTENT_TYPE, content_type(&image.mime));
    headers.insert(CONTENT_LENGTH, HeaderValue::from(length));
    Ok(reply)
}

/// An original or a video: the requested range, streamed a part at a time.
async fn media(
    core: &Core,
    id: &str,
    rendition: Rendition,
    class: Class,
    request: &Request<Incoming>,
    head: bool,
) -> Result<Reply, StatusCode> {
    let layout = core.layout(id, rendition).await.map_err(|e| status(&e))?;
    let size = layout.size;
    let range = request.headers().get(RANGE).and_then(|v| v.to_str().ok());
    let (code, slices) = match range.and_then(|r| parse_range(r, size)) {
        Some(RangePlan::Partial(slices)) => (StatusCode::PARTIAL_CONTENT, Some(slices)),
        Some(RangePlan::Unsatisfiable) => {
            let mut reply = empty(StatusCode::RANGE_NOT_SATISFIABLE);
            reply
                .headers_mut()
                .insert(CONTENT_RANGE, text(format!("bytes */{size}")));
            return Ok(reply);
        }
        // No range, several, or one we cannot read: the whole file.
        Some(RangePlan::Ignore) | None => match plan_range(size, 0, u64::MAX) {
            RangePlan::Partial(slices) => (StatusCode::OK, Some(slices)),
            _ => (StatusCode::OK, None), // an empty file
        },
    };
    let bounds = slices.as_ref().map(|s| s.bounds());
    let body = match slices.filter(|_| !head) {
        None => Empty::new().map_err(|never| match never {}).boxed_unsync(),
        Some(slices) => {
            let mut reader = core
                .range(id, rendition, size, slices, class)
                .await
                .map_err(|e| status(&e))?;
            // The first part decides the status; later failures can only cut the stream.
            let first = match reader.next().await {
                Some(Ok(bytes)) => bytes,
                Some(Err(e)) => return Err(status(&e)),
                None => Bytes::new(),
            };
            Parts {
                ready: Some(first),
                pending: Some(step(reader)),
            }
            .boxed_unsync()
        }
    };
    let mut reply = Response::new(body);
    *reply.status_mut() = code;
    let headers = reply.headers_mut();
    headers.insert(CONTENT_TYPE, content_type(&layout.mime));
    headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    let length = bounds.map_or(0, |(first, last)| last - first + 1);
    headers.insert(CONTENT_LENGTH, HeaderValue::from(length));
    if let (StatusCode::PARTIAL_CONTENT, Some((first, last))) = (code, bounds) {
        headers.insert(CONTENT_RANGE, text(format!("bytes {first}-{last}/{size}")));
    }
    Ok(reply)
}

/// One `bytes=` range (RFC 9110 §14.1.2); anything else is `None`, and the
/// whole file is served.
fn parse_range(header: &str, size: u64) -> Option<RangePlan> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    match (start.trim(), end.trim()) {
        ("", "") => None,
        ("", suffix) => Some(plan_suffix(size, suffix.parse().ok()?)),
        (start, "") => Some(plan_range(size, start.parse().ok()?, u64::MAX)),
        (start, end) => Some(plan_range(size, start.parse().ok()?, end.parse().ok()?)),
    }
}

fn status(e: &CoreError) -> StatusCode {
    match e {
        CoreError::SignedOut => StatusCode::UNAUTHORIZED,
        CoreError::NotFound | CoreError::BadAddress => StatusCode::NOT_FOUND,
        CoreError::Corrupt(_) => StatusCode::BAD_GATEWAY,
        _ => StatusCode::SERVICE_UNAVAILABLE,
    }
}

/// The type the worker gave, if it is an image or a video named in safe
/// characters; anything else would let a worker choose how the app reads it.
fn content_type(mime: &str) -> HeaderValue {
    // SVG is a document that can run script, not a picture.
    let lower = mime.to_ascii_lowercase();
    let media =
        (lower.starts_with("image/") || lower.starts_with("video/")) && !lower.contains("svg");
    let safe = mime
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"/.+-".contains(&b));
    match (media && safe)
        .then(|| HeaderValue::from_str(mime).ok())
        .flatten()
    {
        Some(value) => value,
        None => HeaderValue::from_static("application/octet-stream"),
    }
}

fn text(value: String) -> HeaderValue {
    HeaderValue::try_from(value).unwrap_or(HeaderValue::from_static(""))
}

fn empty(code: StatusCode) -> Reply {
    let mut reply = Response::new(Empty::new().map_err(|never| match never {}).boxed_unsync());
    *reply.status_mut() = code;
    reply
        .headers_mut()
        .insert(CONTENT_LENGTH, HeaderValue::from(0u64));
    reply
}

type Step = Pin<Box<dyn Future<Output = (RangeReader, Option<Result<Bytes, CoreError>>)> + Send>>;

fn step(mut reader: RangeReader) -> Step {
    Box::pin(async move {
        let piece = reader.next().await;
        (reader, piece)
    })
}

/// A range's parts, the first in hand, the rest read as the client takes
/// them: a hang-up drops this, and the downloads behind it stop.
struct Parts {
    ready: Option<Bytes>,
    pending: Option<Step>,
}

impl Body for Parts {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        if let Some(bytes) = self.ready.take() {
            return Poll::Ready(Some(Ok(Frame::data(bytes))));
        }
        let Some(pending) = self.pending.as_mut() else {
            return Poll::Ready(None);
        };
        let (reader, piece) = ready!(pending.as_mut().poll(cx));
        self.pending = None;
        Poll::Ready(match piece {
            None => None,
            Some(Ok(bytes)) => {
                self.pending = Some(step(reader));
                Some(Ok(Frame::data(bytes)))
            }
            // The headers are out: all that is left is to cut the stream.
            Some(Err(_)) => Some(Err(std::io::Error::other("the storage failed mid-stream"))),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CoreConfig;
    use crate::chunk_plan::PART_SIZE;
    use crate::core::tests::{library, mount_file, photo, sealed};
    use serde_json::json;
    use std::time::{Duration, Instant};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    type Served = (
        wiremock::MockServer,
        Arc<Core>,
        MediaServer,
        tempfile::TempDir,
    );

    async fn served(manifest: serde_json::Value, files: Vec<(&str, Vec<u8>, u64)>) -> Served {
        let (server, core, dir) = library(manifest, true, files, 1).await;
        let core = Arc::new(core);
        let urls = core.media_server().unwrap();
        (server, core, urls, dir)
    }

    async fn get(url: &str, range: Option<&str>) -> (u16, reqwest::header::HeaderMap, Vec<u8>) {
        let mut request = crate::http::client().unwrap().get(url);
        if let Some(range) = range {
            request = request.header("range", range);
        }
        let reply = request.send().await.unwrap();
        let (status, headers) = (reply.status().as_u16(), reply.headers().clone());
        (status, headers, reply.bytes().await.unwrap().to_vec())
    }

    async fn head(url: &str, range: Option<&str>) -> (u16, reqwest::header::HeaderMap) {
        let mut request = crate::http::client().unwrap().head(url);
        if let Some(range) = range {
            request = request.header("range", range);
        }
        let reply = request.send().await.unwrap();
        (reply.status().as_u16(), reply.headers().clone())
    }

    fn header(headers: &reqwest::header::HeaderMap, name: &str) -> String {
        headers
            .get(name)
            .map(|v| v.to_str().unwrap().to_owned())
            .unwrap_or_default()
    }

    /// Writes one request on a raw socket, as a player would, and reads only its headers.
    async fn raw_request(base: &str, path: &str) -> (tokio::net::TcpStream, String) {
        let rest = base.strip_prefix("http://").unwrap();
        let (address, secret) = rest.split_once('/').unwrap();
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        let request = format!("GET /{secret}{path} HTTP/1.1\r\nHost: localhost\r\n\r\n");
        socket.write_all(request.as_bytes()).await.unwrap();
        let mut head = vec![];
        while !head.ends_with(b"\r\n\r\n") {
            let mut byte = [0u8; 1];
            if socket.read(&mut byte).await.unwrap() == 0 {
                break;
            }
            head.push(byte[0]);
        }
        (socket, String::from_utf8_lossy(&head).into_owned())
    }

    #[tokio::test]
    async fn only_requests_with_the_secret_are_answered_on_known_routes() {
        let m = photo(json!({"thumbId": "t", "previewId": "p"}));
        let files = vec![("t", sealed(b"thumb"), 1), ("p", sealed(b"preview"), 1)];
        let (_server, _core, urls, _dir) = served(m, files).await;
        let base = urls.grid_base.clone();
        let (origin, secret) = base.rsplit_once('/').unwrap();
        let path = "/api/assets/a1/thumbnail?size=thumbnail";
        assert_eq!(
            get(&format!("{origin}{path}"), None).await.0,
            403,
            "no secret"
        );
        let wrong = "0".repeat(secret.len());
        assert_eq!(
            get(&format!("{origin}/{wrong}{path}"), None).await.0,
            403,
            "wrong secret"
        );
        let (status, headers, body) = get(&format!("{base}{path}"), None).await;
        assert_eq!(
            (status, header(&headers, "content-type").as_str(), &body[..]),
            (200, "image/jpeg", &b"thumb"[..])
        );
        for size in ["preview", "fullsize"] {
            let body = get(&format!("{base}/api/assets/a1/thumbnail?size={size}"), None)
                .await
                .2;
            assert_eq!(body, b"preview");
        }
        assert_eq!(
            get(&format!("{base}/api/assets/a1/thumbnail"), None)
                .await
                .2,
            b"thumb",
            "no size: the grid's"
        );
        for path in [
            "/api/assets/a1/nothing",
            "/api/other",
            "/api/assets/..%2Fx/thumbnail",
        ] {
            assert_eq!(get(&format!("{base}{path}"), None).await.0, 404, "{path}");
        }
        let posted = crate::http::client()
            .unwrap()
            .post(format!("{base}{path}"))
            .send()
            .await
            .unwrap();
        assert_eq!(posted.status().as_u16(), 405);
    }

    #[tokio::test]
    async fn ranges_are_served_across_parts_and_past_the_end_is_refused() {
        let size = PART_SIZE + 10;
        let m = photo(json!({"fileSize": size, "mimeType": "video/mp4",
            "chunks": [{"index": 0, "file_id": "c0"}, {"index": 1, "file_id": "c1"}]}));
        let first = vec![7u8; usize::try_from(PART_SIZE).unwrap()];
        // Each part downloaded once: the rest of the requests read memory.
        let files = vec![("c0", sealed(&first), 1), ("c1", sealed(b"0123456789"), 1)];
        let (_server, _core, urls, _dir) = served(m, files).await;
        let url = format!("{}/api/assets/a1/original", urls.viewer_base);
        let (status, headers, body) = get(
            &url,
            Some(&format!("bytes={}-{}", PART_SIZE - 3, PART_SIZE + 2)),
        )
        .await;
        assert_eq!(status, 206);
        assert_eq!(
            header(&headers, "content-range"),
            format!("bytes {}-{}/{size}", PART_SIZE - 3, PART_SIZE + 2)
        );
        assert_eq!(body, b"\x07\x07\x07012");
        let (status, headers, body) = get(&url, Some("bytes=-4")).await;
        assert_eq!((status, &body[..]), (206, &b"6789"[..]));
        assert_eq!(
            header(&headers, "content-range"),
            format!("bytes {}-{}/{size}", size - 4, size - 1)
        );
        let (status, headers, _) = get(&url, Some(&format!("bytes={size}-"))).await;
        assert_eq!(
            (status, header(&headers, "content-range")),
            (416, format!("bytes */{size}"))
        );
        let (status, _, body) = get(
            &url,
            Some(&format!("bytes={}-{}", PART_SIZE + 5, size + 100)),
        )
        .await;
        assert_eq!(
            (status, &body[..]),
            (206, &b"56789"[..]),
            "an end past the file is trimmed"
        );
        let (status, headers, body) = get(&url, None).await;
        assert_eq!((status, body.len() as u64), (200, size));
        assert_eq!(body.get(body.len() - 10..), Some(&b"0123456789"[..]));
        assert_eq!(header(&headers, "accept-ranges"), "bytes");
        assert_eq!(header(&headers, "content-type"), "video/mp4");
    }

    #[tokio::test]
    async fn head_and_unusable_ranges_download_nothing() {
        let size = PART_SIZE + 10;
        let m = photo(json!({"fileSize": size, "mimeType": "video/mp4",
            "chunks": [{"index": 0, "file_id": "c0"}, {"index": 1, "file_id": "c1"}]}));
        let (_server, _core, urls, _dir) =
            served(m, vec![("c0", vec![], 0), ("c1", vec![], 0)]).await;
        for route in ["original", "video/playback"] {
            let url = format!("{}/api/assets/a1/{route}", urls.viewer_base);
            let (status, headers) = head(&url, None).await;
            assert_eq!(
                (status, header(&headers, "content-length")),
                (200, size.to_string())
            );
            assert_eq!(header(&headers, "accept-ranges"), "bytes");
            for unusable in ["bytes=0-1,5-6", "items=1-2", "bytes=x-y"] {
                assert_eq!(
                    head(&url, Some(unusable)).await.0,
                    200,
                    "{unusable}: the whole file"
                );
            }
            let (status, headers) = head(&url, Some("bytes=0-9")).await;
            assert_eq!(
                (status, header(&headers, "content-range")),
                (206, format!("bytes 0-9/{size}"))
            );
            assert_eq!(header(&headers, "content-length"), "10");
            assert_eq!(head(&url, Some(&format!("bytes={size}-"))).await.0, 416);
        }
    }

    #[tokio::test]
    async fn content_types_come_from_an_allow_list() {
        let m = photo(json!({"originalId": "o", "mimeType": "text/html", "fileSize": 4}));
        let (_server, _core, urls, _dir) = served(m, vec![("o", sealed(b"<h1>"), 1)]).await;
        let headers = get(
            &format!("{}/api/assets/a1/original", urls.viewer_base),
            None,
        )
        .await
        .1;
        assert_eq!(header(&headers, "content-type"), "application/octet-stream");
        let m = photo(json!({"originalId": "o", "mimeType": "image/svg+xml", "fileSize": 4}));
        let (_server, _core, urls, _dir) = served(m, vec![("o", sealed(b"<sv>"), 1)]).await;
        let url = format!("{}/api/assets/a1/original", urls.viewer_base);
        let headers = get(&url, None).await.1;
        assert_eq!(
            header(&headers, "content-type"),
            "application/octet-stream",
            "no SVG"
        );
        let m = photo(
            json!({"originalId": "o", "mimeType": "video/quicktime", "fileSize": 4,
            "playbackChunks": [{"index": 0, "file_id": "r0"}], "playbackSize": 3}),
        );
        let files = vec![("o", sealed(b"mov!"), 1), ("r0", sealed(b"mp4"), 1)];
        let (_server, _core, urls, _dir) = served(m, files).await;
        let (_, headers, body) = get(
            &format!("{}/api/assets/a1/video/playback", urls.viewer_base),
            None,
        )
        .await;
        assert_eq!(
            (header(&headers, "content-type").as_str(), &body[..]),
            ("video/mp4", &b"mp4"[..])
        );
        let headers = get(
            &format!("{}/api/assets/a1/original", urls.viewer_base),
            None,
        )
        .await
        .1;
        assert_eq!(header(&headers, "content-type"), "video/quicktime");
    }

    #[tokio::test]
    async fn a_videos_preview_is_its_thumbnail() {
        let m = photo(
            json!({"thumbId": "t", "originalId": "o", "mimeType": "video/quicktime", "fileSize": 5}),
        );
        let files = vec![("t", sealed(b"jpeg!"), 1), ("o", sealed(b"video"), 0)];
        let (_server, _core, urls, _dir) = served(m, files).await;
        let (status, headers, body) = get(
            &format!("{}/api/assets/a1/thumbnail?size=preview", urls.viewer_base),
            None,
        )
        .await;
        assert_eq!(
            (status, header(&headers, "content-type").as_str(), &body[..]),
            (200, "image/jpeg", &b"jpeg!"[..])
        );
    }

    #[tokio::test]
    async fn the_next_part_downloads_early_without_holding_the_grid_back() {
        let size = PART_SIZE + 10;
        let m = photo(
            json!({"thumbId": "t", "fileSize": size, "mimeType": "video/mp4",
            "chunks": [{"index": 0, "file_id": "c0"}, {"index": 1, "file_id": "c1"}]}),
        );
        let first = vec![7u8; usize::try_from(PART_SIZE).unwrap()];
        let files = vec![("t", sealed(b"thumb"), 1), ("c0", sealed(&first), 1)];
        let (server, _core, urls, _dir) = served(m, files).await;
        mount_file(
            &server,
            "c1",
            sealed(b"0123456789"),
            1,
            Duration::from_secs(3),
        )
        .await;
        // A player that reads the headers, then nothing more.
        let (_socket, head) = raw_request(&urls.viewer_base, "/api/assets/a1/original").await;
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        let asked = Instant::now();
        loop {
            let requests = server.received_requests().await.unwrap_or_default();
            if requests.iter().any(|r| r.url.path() == "/file/bot1:A/p/c1") {
                break;
            }
            assert!(
                asked.elapsed() < Duration::from_secs(2),
                "the next part was not asked for"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // Part 1 is still downloading (3 s), as Next: the grid goes on (D17).
        let started = Instant::now();
        let body = get(
            &format!("{}/api/assets/a1/thumbnail?size=thumbnail", urls.grid_base),
            None,
        )
        .await
        .2;
        assert_eq!(body, b"thumb");
        assert!(
            started.elapsed() < Duration::from_millis(1500),
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn a_hang_up_stops_the_download() {
        let m = photo(json!({"thumbId": "t", "previewId": "p"}));
        let (server, _core, urls, _dir) = served(m, vec![("p", sealed(b"preview"), 1)]).await;
        mount_file(&server, "t", sealed(b"thumb"), 2, Duration::from_secs(1)).await;
        // The session's bot and key first, so the hang-up meets the download.
        let warm = format!("{}/api/assets/a1/thumbnail?size=preview", urls.grid_base);
        assert_eq!(get(&warm, None).await.2, b"preview");
        let path = "/api/assets/a1/thumbnail?size=thumbnail";
        let rest = urls.grid_base.strip_prefix("http://").unwrap();
        let (address, secret) = rest.split_once('/').unwrap();
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        let request = format!("GET /{secret}{path} HTTP/1.1\r\nHost: localhost\r\n\r\n");
        socket.write_all(request.as_bytes()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        drop(socket); // the image loader gave up
        tokio::time::sleep(Duration::from_millis(100)).await;
        // Downloads again (2 in all): the first was stopped, not joined.
        assert_eq!(
            get(&format!("{}{path}", urls.grid_base), None).await.2,
            b"thumb"
        );
    }

    #[tokio::test]
    async fn it_runs_signed_out_and_reopens_a_closed_listener() {
        let dir = tempfile::tempdir().unwrap();
        let core = Arc::new(
            Core::start(CoreConfig::new(dir.path().join("d"), dir.path().join("c"))).unwrap(),
        );
        let urls = core.media_server().unwrap();
        let path = "/api/assets/a1/thumbnail?size=thumbnail";
        assert_eq!(get(&format!("{}{path}", urls.grid_base), None).await.0, 401);
        let again = core.media_server().unwrap();
        assert_eq!(
            (&again.grid_base, &again.viewer_base),
            (&urls.grid_base, &urls.viewer_base)
        );
        // As iOS does to a suspended app: the sockets die, the tasks may not notice.
        core.close_listeners_for_test();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let reopened = core.media_server().unwrap();
        assert_eq!(
            get(&format!("{}{path}", reopened.grid_base), None).await.0,
            401
        );
        assert_eq!(
            get(&format!("{}{path}", reopened.viewer_base), None)
                .await
                .0,
            401
        );
        // A new secret too: whoever took the old port learnt nothing that opens the new one.
        let old_secret = urls.grid_base.rsplit_once('/').unwrap().1;
        let (origin, new_secret) = reopened.grid_base.rsplit_once('/').unwrap();
        assert_ne!(old_secret, new_secret);
        assert_eq!(
            get(&format!("{origin}/{old_secret}{path}"), None).await.0,
            403
        );
    }

    #[tokio::test]
    async fn other_apps_cannot_hold_more_than_a_few_connections() {
        let dir = tempfile::tempdir().unwrap();
        let core = Arc::new(
            Core::start(CoreConfig::new(dir.path().join("d"), dir.path().join("c"))).unwrap(),
        );
        let urls = core.media_server().unwrap();
        let address = urls
            .grid_base
            .strip_prefix("http://")
            .unwrap()
            .split_once('/')
            .unwrap()
            .0
            .to_owned();
        let mut idle = vec![];
        for _ in 0..MAX_CONNECTIONS {
            idle.push(tokio::net::TcpStream::connect(&address).await.unwrap());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        let path = "/api/assets/a1/thumbnail?size=thumbnail";
        let waiting = tokio::spawn({
            let url = format!("{}{path}", urls.grid_base);
            async move { get(&url, None).await.0 }
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!waiting.is_finished(), "served beyond the connection limit");
        idle.pop();
        let status = tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status, 401, "served once a connection closed");
    }

    #[tokio::test]
    async fn a_request_without_the_secret_loses_its_connection() {
        let dir = tempfile::tempdir().unwrap();
        let core = Arc::new(
            Core::start(CoreConfig::new(dir.path().join("d"), dir.path().join("c"))).unwrap(),
        );
        let urls = core.media_server().unwrap();
        let address = urls
            .grid_base
            .strip_prefix("http://")
            .unwrap()
            .split_once('/')
            .unwrap()
            .0
            .to_owned();
        let mut socket = tokio::net::TcpStream::connect(&address).await.unwrap();
        socket
            .write_all(b"GET /nope HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();
        let mut reply = vec![];
        let read =
            tokio::time::timeout(Duration::from_secs(5), socket.read_to_end(&mut reply)).await;
        assert!(read.is_ok(), "the connection stayed open");
        assert!(String::from_utf8_lossy(&reply).starts_with("HTTP/1.1 403"));
    }

    #[test]
    fn only_plain_image_and_video_types_pass() {
        for (given, sent) in [
            ("video/mp4", "video/mp4"),
            ("image/heic", "image/heic"),
            ("image/SVG+XML", "application/octet-stream"),
            ("text/html", "application/octet-stream"),
            ("image/jpeg;x=1", "application/octet-stream"),
            ("image/jpeg\r\nSet-Cookie: x", "application/octet-stream"),
        ] {
            assert_eq!(content_type(given), sent, "{given}");
        }
    }

    #[tokio::test]
    async fn damaged_and_unreachable_files_get_statuses_players_understand() {
        let wrong = crate::crypto::encrypt_part(
            &crate::crypto::derive_key("other", "c2FsdC1zYWx0LXNhbHQhIQ==").unwrap(),
            b"0123456789",
        )
        .unwrap();
        let m = photo(json!({"originalId": "o", "fileSize": 10}));
        let (_server, _core, urls, _dir) = served(m.clone(), vec![("o", wrong, 1)]).await;
        assert_eq!(
            get(
                &format!("{}/api/assets/a1/original", urls.viewer_base),
                Some("bytes=0-1")
            )
            .await
            .0,
            502
        );
        let (server, _core, urls, _dir) = served(m, vec![]).await;
        use wiremock::matchers::{path, query_param};
        wiremock::Mock::given(path("/bot1:A/getFile"))
            .and(query_param("file_id", "o"))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(json!({"ok": true, "result": {"file_path": "p/o"}})),
            )
            .mount(&server)
            .await;
        wiremock::Mock::given(path("/file/bot1:A/p/o"))
            .respond_with(wiremock::ResponseTemplate::new(500))
            .mount(&server)
            .await;
        assert_eq!(
            get(
                &format!("{}/api/assets/a1/original", urls.viewer_base),
                Some("bytes=0-1")
            )
            .await
            .0,
            503
        );
    }

    #[tokio::test]
    async fn signing_out_or_in_again_keeps_the_listeners() {
        let m = photo(json!({"thumbId": "t"}));
        let (_server, core, _dir) = library(m, true, vec![("t", sealed(b"thumb"), 1)], 1).await;
        let core = Arc::new(core);
        let urls = core.media_server().unwrap();
        let url = format!("{}/api/assets/a1/thumbnail?size=thumbnail", urls.grid_base);
        assert_eq!(get(&url, None).await.0, 200);
        let session = core.worker().unwrap().session().clone();
        core.sign_out().unwrap();
        assert_eq!(get(&url, None).await.0, 401, "same address, signed out");
        core.restore(session).unwrap();
        // Signed in again (a bad id is 404, not 401), on the same address.
        let odd = format!("{}/api/assets/zz/thumbnail?size=thumbnail", urls.grid_base);
        assert_eq!(get(&odd, None).await.0, 404);
    }

    #[tokio::test]
    async fn a_streams_first_part_runs_at_the_viewers_class() {
        let m = photo(json!({"thumbId": "t", "previewId": "p", "originalId": "o"}));
        let files = vec![("t", sealed(b"thumb"), 1), ("p", sealed(b"preview"), 1)];
        let (server, _core, urls, _dir) = served(m, files).await;
        mount_file(
            &server,
            "o",
            sealed(b"0123456789"),
            1,
            Duration::from_millis(1500),
        )
        .await;
        let warm = format!("{}/api/assets/a1/thumbnail?size=preview", urls.grid_base);
        assert_eq!(get(&warm, None).await.2, b"preview"); // the session's bot and key
        let original = format!("{}/api/assets/a1/original", urls.viewer_base);
        let playing = tokio::spawn(async move { get(&original, None).await.0 });
        tokio::time::sleep(Duration::from_millis(200)).await;
        // The opened item goes first (D17): the grid waits for it.
        let started = Instant::now();
        let thumb = format!("{}/api/assets/a1/thumbnail?size=thumbnail", urls.grid_base);
        assert_eq!(get(&thumb, None).await.2, b"thumb");
        assert!(
            started.elapsed() >= Duration::from_millis(800),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(playing.await.unwrap(), 200);
    }

    #[tokio::test]
    async fn an_app_on_our_old_port_is_not_taken_for_us() {
        let dir = tempfile::tempdir().unwrap();
        let core = Arc::new(
            Core::start(CoreConfig::new(dir.path().join("d"), dir.path().join("c"))).unwrap(),
        );
        let urls = core.media_server().unwrap();
        let (address, secret) = urls
            .grid_base
            .strip_prefix("http://")
            .unwrap()
            .split_once('/')
            .unwrap();
        let (address, secret) = (address.to_owned(), secret.to_owned());
        core.close_listeners_for_test();
        tokio::time::sleep(Duration::from_millis(50)).await;
        // Another app takes the freed port and answers anything.
        let impostor = std::net::TcpListener::bind(&address).unwrap();
        let heard = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = heard.clone();
        std::thread::spawn(move || {
            for stream in impostor.incoming().flatten() {
                let mut stream = stream;
                let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
                let mut buffer = [0u8; 2048];
                let n = std::io::Read::read(&mut stream, &mut buffer).unwrap_or(0);
                log.lock().unwrap().extend_from_slice(&buffer[..n]);
                let _ = std::io::Write::write_all(
                    &mut stream,
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
                );
            }
        });
        let reopened = core.media_server().unwrap();
        assert_ne!(
            reopened.grid_base, urls.grid_base,
            "kept an address another app holds"
        );
        let heard = String::from_utf8_lossy(&heard.lock().unwrap()).into_owned();
        assert!(!heard.contains(&secret), "the probe gave the secret away");
    }

    /// Invariant (a): a secret works only on connections its live listener
    /// owns. Busy slots make `ensure_running` reopen (the production path:
    /// `dead.task.abort()`); a connection held from before must die with it.
    #[tokio::test]
    async fn a_replaced_listener_takes_its_connections_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let core = Arc::new(
            Core::start(CoreConfig::new(dir.path().join("d"), dir.path().join("c"))).unwrap(),
        );
        let urls = core.media_server().unwrap();
        let (address, secret) = urls
            .grid_base
            .strip_prefix("http://")
            .unwrap()
            .split_once('/')
            .unwrap();
        let (address, secret) = (address.to_owned(), secret.to_owned());
        let request = format!("GET /{secret}/api/assets/a1/thumbnail HTTP/1.1\r\nHost: l\r\n\r\n");
        let mut held = tokio::net::TcpStream::connect(&address).await.unwrap();
        held.write_all(request.as_bytes()).await.unwrap();
        let mut head = vec![];
        while !head.ends_with(b"\r\n\r\n") {
            head.push(held.read_u8().await.unwrap());
        }
        assert!(
            head.starts_with(b"HTTP/1.1 401"),
            "the secret works on its own listener"
        );
        let mut idle = vec![];
        for _ in 1..MAX_CONNECTIONS {
            idle.push(tokio::net::TcpStream::connect(&address).await.unwrap());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        let reopened = tokio::task::spawn_blocking({
            let core = core.clone();
            move || core.media_server().unwrap()
        })
        .await
        .unwrap();
        assert_ne!(
            reopened.grid_base, urls.grid_base,
            "all slots busy: reopened"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
        // The same request, on the connection held from before the reopen.
        let again = held.write_all(request.as_bytes()).await;
        let mut answer = [0u8; 12];
        let read = tokio::time::timeout(Duration::from_secs(2), held.read_exact(&mut answer)).await;
        let answered = again.is_ok() && matches!(read, Ok(Ok(_)));
        assert!(!answered, "the old secret still works on an old connection");
    }

    /// Invariant (c): `ensure_running` returns in bounded time, whatever holds the port.
    #[tokio::test]
    async fn a_slow_impostor_cannot_hold_the_app_up() {
        let dir = tempfile::tempdir().unwrap();
        let core = Arc::new(
            Core::start(CoreConfig::new(dir.path().join("d"), dir.path().join("c"))).unwrap(),
        );
        let urls = core.media_server().unwrap();
        let address = urls
            .grid_base
            .strip_prefix("http://")
            .unwrap()
            .split_once('/')
            .unwrap()
            .0
            .to_owned();
        core.close_listeners_for_test();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let impostor = std::net::TcpListener::bind(&address).unwrap();
        std::thread::spawn(move || {
            for stream in impostor.incoming().flatten() {
                std::thread::spawn(move || {
                    let mut stream = stream;
                    // One byte every 200 ms, forever.
                    while std::io::Write::write_all(&mut stream, b"H").is_ok() {
                        std::thread::sleep(Duration::from_millis(200));
                    }
                });
            }
        });
        let started = Instant::now();
        let reopened = tokio::task::spawn_blocking({
            let core = core.clone();
            move || core.media_server().unwrap()
        })
        .await
        .unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{:?}",
            started.elapsed()
        );
        assert_ne!(reopened.grid_base, urls.grid_base);
    }
}
