//! P1 task 1.6, Gate 2: the local media server against the TEST account.
//! Run it as a release build (`cargo run --release -p dc-core --example serve`).
//! A relay in front of Telegram (the core's `telegram_api` setting) counts
//! downloads per file — it never prints a path: they carry the bot token.
//! Through the media server only: a grid thumbnail; then, while nothing of
//! the video is in memory, AVFoundation opens a multi-part video as AVPlayer
//! would and draws a frame from its middle (examples/avplayer_check.swift),
//! with Telegram downloads counted; then the video in full, compared with the
//! production worker's bytes, and three ranges.
//! Password from the macOS Keychain item `daemonclient-test` (see
//! examples/sign_in.rs). Read-only. Prints sizes, timings and counts — never
//! ids, paths or tokens.
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use bytes::Bytes;
use dc_core::chunk_plan::PART_SIZE;
use dc_core::session::{Deployment, HOSTED_API};
use dc_core::{Core, CoreConfig, TELEGRAM_API};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::{Request, Response, StatusCode};
use sha2::{Digest, Sha256};

type Error = Box<dyn std::error::Error>;
/// Telegram file path → downloads started, and finished (a cancelled
/// prefetch starts and never finishes).
type Counts = Arc<Mutex<HashMap<String, (usize, usize)>>>;

fn security(args: &[&str]) -> Result<String, Error> {
    let out = std::process::Command::new("security").args(args).output()?;
    if !out.status.success() {
        return Err("no Keychain item `daemonclient-test` — see examples/sign_in.rs".into());
    }
    // Never `?` the decode error: its Debug output would print the raw bytes.
    let text = String::from_utf8(out.stdout).map_err(|_| "the Keychain value is not UTF-8")?;
    Ok(text.trim().to_owned())
}

/// Forwards the core's Telegram requests and counts the file downloads.
async fn relay(counts: Counts) -> Result<String, Error> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = format!("http://{}", listener.local_addr()?);
    let http = dc_core::http::client()?;
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let (counts, http) = (counts.clone(), http.clone());
            tokio::spawn(async move {
                let service = hyper::service::service_fn(move |request: Request<Incoming>| {
                    let (counts, http) = (counts.clone(), http.clone());
                    async move {
                        let path = request
                            .uri()
                            .path_and_query()
                            .map(|p| p.as_str().to_owned())
                            .unwrap_or_default();
                        let file = path.starts_with("/file/");
                        let count = |finished: bool| {
                            let mut counts = counts.lock().unwrap_or_else(|e| e.into_inner());
                            let entry = counts.entry(path.clone()).or_default();
                            if finished { entry.1 += 1 } else { entry.0 += 1 }
                        };
                        if file {
                            count(false);
                        }
                        // Never print `path` or a reqwest error: both carry the bot token.
                        let (status, body) =
                            match http.get(format!("{TELEGRAM_API}{path}")).send().await {
                                Ok(reply) => {
                                    let status = reply.status().as_u16();
                                    reply
                                        .bytes()
                                        .await
                                        .map_or((502, Bytes::new()), |body| (status, body))
                                }
                                Err(_) => (502, Bytes::new()),
                            };
                        if file && status == 200 {
                            count(true);
                        }
                        let mut response = Response::new(Full::new(body));
                        *response.status_mut() =
                            StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
                        Ok::<_, Infallible>(response)
                    }
                });
                let io = hyper_util::rt::TokioIo::new(stream);
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(io, service)
                    .await;
            });
        }
    });
    Ok(address)
}

/// Status, Content-Type and body of a GET.
async fn get(
    http: &reqwest::Client,
    url: &str,
    bearer: Option<&str>,
    range: Option<(u64, u64)>,
) -> Result<(u16, String, Vec<u8>), Error> {
    let mut request = http.get(url);
    if let Some(token) = bearer {
        request = request.bearer_auth(token);
    }
    if let Some((first, last)) = range {
        request = request.header("range", format!("bytes={first}-{last}"));
    }
    let reply = request.send().await.map_err(|_| "a request failed")?;
    let status = reply.status().as_u16();
    let kind = reply
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let body = reply.bytes().await.map_err(|_| "a reply broke off")?;
    Ok((status, kind, body.to_vec()))
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Error> {
    let password = security(&["find-generic-password", "-s", "daemonclient-test", "-w"])?;
    let attributes = security(&["find-generic-password", "-s", "daemonclient-test"])?;
    let email = attributes
        .lines()
        .find_map(|l| {
            l.trim()
                .strip_prefix("\"acct\"<blob>=\"")?
                .strip_suffix('"')
        })
        .ok_or("the Keychain item has no account (email)")?
        .to_owned();
    let counts: Counts = Arc::default();
    let dir = std::env::temp_dir().join("dc-serve-check");
    let mut config = CoreConfig::new(dir.join("data"), dir.join("cache"));
    config.telegram_api = relay(counts.clone()).await?;
    let core = Arc::new(Core::start(config)?);
    core.sign_in(HOSTED_API, Deployment::Hosted, &email, &password)
        .await?;
    let checked = check(&core, &counts).await;
    // Always, so no decrypted test-account pictures stay in the temp folder.
    core.sign_out()?;
    checked
}

async fn check(core: &Arc<Core>, counts: &Counts) -> Result<(), Error> {
    let worker = core.worker()?;
    let session = worker.session().clone();
    let (base, token) = (session.worker_url.clone(), session.token.expose().clone());
    let http = dc_core::http::client()?;

    // Pick an image and the smallest video of three parts or more.
    let buckets: serde_json::Value = serde_json::from_slice(
        &get(
            &http,
            &format!("{base}/api/timeline/buckets"),
            Some(&token),
            None,
        )
        .await?
        .2,
    )?;
    let mut ids = vec![];
    for bucket in buckets.as_array().ok_or("buckets: not a list")? {
        let month = bucket
            .get("timeBucket")
            .and_then(|m| m.as_str())
            .ok_or("a bucket without a month")?;
        let url = format!("{base}/api/timeline/bucket?timeBucket={month}");
        let assets: serde_json::Value =
            serde_json::from_slice(&get(&http, &url, Some(&token), None).await?.2)?;
        for id in assets
            .get("id")
            .and_then(|i| i.as_array())
            .ok_or("a bucket without ids")?
        {
            ids.push(id.as_str().ok_or("an id is not text")?.to_owned());
        }
    }
    let (mut image, mut video): (Option<String>, Option<(String, u64, usize)>) = (None, None);
    let (mut pending, mut running) = (ids.iter(), tokio::task::JoinSet::new());
    loop {
        while running.len() < 8
            && let Some(id) = pending.next()
        {
            let (core, worker, id) = (core.clone(), worker.clone(), id.clone());
            running.spawn(async move {
                let asset = id.clone();
                (
                    id,
                    core.run(async move { worker.manifest(&asset).await }).await,
                )
            });
        }
        let Some(done) = running.join_next().await else {
            break;
        };
        let (id, manifest) = done?;
        let Ok(Ok(m)) = manifest else { continue };
        if image.is_none() && m.mime_type.starts_with("image/") && !m.thumb_id.is_empty() {
            image = Some(id.clone());
        }
        let smaller = video
            .as_ref()
            .is_none_or(|(_, size, _)| m.file_size < *size);
        if m.mime_type.starts_with("video/") && m.chunks.len() >= 3 && smaller {
            video = Some((id, m.file_size, m.chunks.len()));
        }
    }
    let (image, (video, size, parts)) = (
        image.ok_or("no image")?,
        video.ok_or("no video of 3+ parts")?,
    );
    let urls = core.media_server()?;
    let mut failures = 0;

    let url = format!(
        "{}/api/assets/{image}/thumbnail?size=thumbnail",
        urls.grid_base
    );
    let (status, kind, thumb) = get(&http, &url, None, None).await?;
    let jpeg = thumb.starts_with(&[0xff, 0xd8]);
    failures += usize::from(status != 200 || !jpeg);
    println!(
        "grid thumbnail: {status} {kind}, {} KB, {}",
        thumb.len() / 1024,
        if jpeg { "a JPEG" } else { "NOT A JPEG" }
    );

    // First, while nothing of the video is in memory: a cold open.
    counts.lock().unwrap_or_else(|e| e.into_inner()).clear();
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/examples/avplayer_check.swift");
    let playback = format!("{}/api/assets/{video}/video/playback", urls.viewer_base);
    // On a blocking thread: the relay runs on this runtime and must keep serving.
    let out = tokio::task::spawn_blocking(move || {
        std::process::Command::new("swift")
            .arg(script)
            .arg(&playback)
            .output()
    })
    .await??;
    failures += usize::from(!out.status.success());
    print!("{}", String::from_utf8_lossy(&out.stdout));
    let mut per_file: Vec<(usize, usize)> = counts
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .copied()
        .collect();
    per_file.sort_unstable();
    println!(
        "Telegram downloads during that load: {} of the {parts} parts, (started, finished) each: {per_file:?}",
        per_file.len()
    );

    let ours_url = format!("{}/api/assets/{video}/original", urls.viewer_base);
    let theirs_url = format!("{base}/api/assets/{video}/original");
    let started = Instant::now();
    let (status, kind, ours) = get(&http, &ours_url, None, None).await?;
    let seconds = started.elapsed().as_secs_f64();
    let theirs = get(&http, &theirs_url, Some(&token), None).await?.2;
    let same = digest(&ours) == digest(&theirs);
    failures += usize::from(status != 200 || !same);
    let mb = ours.len() as f64 / 1_048_576.0;
    println!(
        "video in full: {status} {kind}, {mb:.1} MB in {parts} parts, {seconds:.1} s ({:.1} MB/s) — SHA-256 {}",
        mb / seconds,
        if same {
            "equal to the worker's"
        } else {
            "DIFFERENT"
        }
    );

    let mut equal = 0;
    for (first, last) in [
        (PART_SIZE - 1_000, PART_SIZE + 999),
        (0, 1),
        (size - 65_536, size - 1),
    ] {
        let (status, _, ours) = get(&http, &ours_url, None, Some((first, last))).await?;
        let theirs = get(&http, &theirs_url, Some(&token), Some((first, last)))
            .await?
            .2;
        equal += usize::from(status == 206 && ours == theirs);
    }
    failures += 3 - equal;
    println!(
        "ranges (one across a part boundary, the first 2 bytes, the last 64 KiB): {equal} of 3 equal"
    );

    if failures > 0 {
        return Err(format!("{failures} checks failed").into());
    }
    Ok(())
}
