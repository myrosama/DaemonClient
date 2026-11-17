//! dc-cli: the core from a terminal, for testing against the real worker and
//! storage without an app (P1 task 1.8, design §5.10). Each run signs in from
//! a macOS Keychain item, does one thing and signs out; no session is kept on
//! disk. Never prints a session token or a storage address.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use dc_core::chunk_plan::{RangePlan, plan_range};
use dc_core::reader::{Rendition, select};
use dc_core::sched::Class;
use dc_core::session::{Deployment, HOSTED_API};
use dc_core::telegram::Telegram;
use dc_core::upload::UploadRequest;
use dc_core::{Core, CoreConfig, CoreError, Secret, TELEGRAM_API};
use sha1::{Digest, Sha1};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

type Error = Box<dyn std::error::Error>;

const USAGE: &str = "usage: dc-cli <command>
  whoami                  the account, its worker, encryption, the storage answering
  list [n]                the newest n assets (20)
  upload <file>...        back up files, byte for byte
  download <asset> <out>  the original, checked against the checksum the worker stored
  delete <asset>...       delete assets and their stored parts
  serve <asset>           the local media server's addresses, until Ctrl-C
  bench reads [n]         read limits, with n thumbnails (100, at most 200)
  bench sends [n]         send limits, at most n tiny messages (40, at most 100), deleted after
  bench parts <video>     two parts one after the other against both at once
Signs in from the Keychain item `daemonclient-test` (or $DC_KEYCHAIN).";

#[derive(Debug, PartialEq)]
enum Command {
    Whoami,
    List(usize),
    Upload(Vec<PathBuf>),
    Download { asset: String, out: PathBuf },
    Delete(Vec<String>),
    Serve(String),
    BenchReads(usize),
    BenchSends(usize),
    BenchParts(String),
}

fn parse(args: &[String]) -> Result<Command, String> {
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    // A typo must not flood the test bot: counts are capped.
    let count = |word: Option<&&str>, default: usize, most: usize| match word {
        None => Ok(default),
        Some(word) => match word.parse::<usize>() {
            Ok(n) if n > 0 => Ok(n.min(most)),
            _ => Err(USAGE.to_owned()),
        },
    };
    match words.as_slice() {
        ["whoami"] => Ok(Command::Whoami),
        ["list"] | ["list", _] => Ok(Command::List(count(words.get(1), 20, 1000)?)),
        ["upload", files @ ..] if !files.is_empty() => {
            Ok(Command::Upload(files.iter().map(PathBuf::from).collect()))
        }
        ["download", asset, out] => Ok(Command::Download {
            asset: (*asset).to_owned(),
            out: PathBuf::from(out),
        }),
        ["delete", ids @ ..] if !ids.is_empty() => Ok(Command::Delete(
            ids.iter().map(|id| (*id).to_owned()).collect(),
        )),
        ["serve", asset] => Ok(Command::Serve((*asset).to_owned())),
        ["bench", "reads"] | ["bench", "reads", _] => {
            Ok(Command::BenchReads(count(words.get(2), 100, 200)?))
        }
        ["bench", "sends"] | ["bench", "sends", _] => {
            Ok(Command::BenchSends(count(words.get(2), 40, 100)?))
        }
        ["bench", "parts", video] => Ok(Command::BenchParts((*video).to_owned())),
        _ => Err(USAGE.to_owned()),
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = match parse(&args) {
        Ok(command) => command,
        Err(usage) => {
            eprintln!("{usage}");
            return ExitCode::from(2);
        }
    };
    // Before Core::start: the sink is fixed once per process (1.0).
    dc_core::logging::install(Some(Box::new(|line: &str| eprintln!("{line}"))));
    match run(command).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("dc-cli: {e}");
            ExitCode::FAILURE
        }
    }
}

async fn run(command: Command) -> Result<(), Error> {
    let (email, password) = credentials()?;
    let dir = std::env::temp_dir().join(format!("dc-cli-{}", std::process::id()));
    let core = Arc::new(Core::start(CoreConfig::new(
        dir.join("data"),
        dir.join("cache"),
    ))?);
    let signed_in = core
        .sign_in(
            HOSTED_API,
            Deployment::Hosted,
            &email,
            password.expose().trim(),
        )
        .await;
    drop(password);
    let serving = matches!(command, Command::Serve(_));
    let result = match signed_in {
        Err(e) => Err(e.into()),
        // It stops measuring at Ctrl-C itself, then deletes what it sent.
        Ok(_) if matches!(command, Command::BenchSends(_)) => work(&core, command, &dir).await,
        // Ctrl-C ends `serve`; anything else is cut short. Both clean up below.
        Ok(_) => tokio::select! {
            result = work(&core, command, &dir) => result,
            _ = tokio::signal::ctrl_c() => if serving { Ok(()) } else { Err("interrupted".into()) },
        },
    };
    // Always: no session and no decrypted picture stays behind.
    let _ = core.sign_out();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

async fn work(core: &Arc<Core>, command: Command, dir: &Path) -> Result<(), Error> {
    match command {
        Command::Whoami => whoami(core).await,
        Command::List(n) => list(core, n).await,
        Command::Upload(files) => upload(core, &files, dir).await,
        Command::Download { asset, out } => download(core, &asset, &out).await,
        Command::Delete(ids) => delete(core, &ids).await,
        Command::Serve(asset) => serve(core, &asset).await,
        Command::BenchReads(n) => bench_reads(core, n).await,
        Command::BenchSends(n) => bench_sends(core, n).await,
        Command::BenchParts(video) => bench_parts(core, &video).await,
    }
}

fn credentials() -> Result<(String, Secret<String>), Error> {
    let item = std::env::var("DC_KEYCHAIN").unwrap_or_else(|_| "daemonclient-test".to_owned());
    let security = |args: &[&str]| -> Result<String, Error> {
        let out = std::process::Command::new("/usr/bin/security")
            .args(args)
            .output()?;
        if !out.status.success() {
            return Err(format!("no Keychain item `{item}` (macOS only)").into());
        }
        // Never `?` the decode error: its Debug output would print the raw bytes.
        Ok(String::from_utf8(out.stdout).map_err(|_| "the Keychain value is not UTF-8")?)
    };
    // Untrimmed, so the only copy is the one the Secret wipes.
    let password = Secret::new(security(&["find-generic-password", "-s", &item, "-w"])?);
    let email = account(&security(&["find-generic-password", "-s", &item])?)
        .ok_or("the Keychain item has no account (email)")?;
    Ok((email, password))
}

/// The account (email) in `security find-generic-password`'s attributes.
fn account(attributes: &str) -> Option<String> {
    attributes.lines().find_map(|l| {
        l.trim()
            .strip_prefix("\"acct\"<blob>=\"")?
            .strip_suffix('"')
            .map(str::to_owned)
    })
}

/// A JSON answer from the worker (metadata only).
async fn worker_json(core: &Core, path: &str) -> Result<serde_json::Value, Error> {
    let worker = core.worker()?;
    let session = worker.session();
    let reply = dc_core::http::client()?
        .get(format!("{}{path}", session.worker_url))
        .bearer_auth(session.token.expose())
        .send()
        .await
        .map_err(|_| "the worker did not answer")?;
    let status = reply.status();
    if !status.is_success() {
        return Err(format!("the worker answered {}", status.as_u16()).into());
    }
    Ok(reply
        .json()
        .await
        .map_err(|_| "the worker's answer is not JSON")?)
}

fn text<'a>(value: &'a serde_json::Value, key: &str) -> &'a str {
    value.get(key).and_then(|v| v.as_str()).unwrap_or_default()
}

/// The newest `n` asset ids, from the timeline.
async fn newest(core: &Core, n: usize) -> Result<Vec<String>, Error> {
    let buckets = worker_json(core, "/api/timeline/buckets").await?;
    let mut ids = vec![];
    for bucket in buckets.as_array().ok_or("the timeline is not a list")? {
        if ids.len() >= n {
            break;
        }
        let month = text(bucket, "timeBucket");
        let assets = worker_json(core, &format!("/api/timeline/bucket?timeBucket={month}")).await?;
        let found = assets.get("id").and_then(|i| i.as_array());
        ids.extend(
            found
                .into_iter()
                .flatten()
                .filter_map(|id| id.as_str())
                .take(n - ids.len())
                .map(str::to_owned),
        );
    }
    Ok(ids)
}

async fn whoami(core: &Core) -> Result<(), Error> {
    let worker = core.worker()?;
    println!("account   {}", worker.session().user_id);
    println!("worker    {}", worker.session().worker_url);
    let encryption = match worker.encryption().await? {
        (false, _) => "off",
        (true, Some(_)) => "on",
        (true, None) => "on, but its settings are incomplete (uploads refused)",
    };
    println!("encrypted {encryption}");
    core.telegram().await?;
    println!("storage   answers (HTTP {})", core.check_telegram().await?);
    Ok(())
}

async fn list(core: &Core, n: usize) -> Result<(), Error> {
    for id in newest(core, n).await? {
        let asset = worker_json(core, &format!("/api/assets/{id}")).await?;
        let size = asset
            .pointer("/exifInfo/fileSizeInByte")
            .and_then(|s| s.as_u64())
            .map_or("?".to_owned(), |s| format!("{:.1} MB", s as f64 / 1e6));
        let device = match text(&asset, "deviceId") {
            "" => "website",
            device => device,
        };
        println!(
            "{id}  {:5}  {size:>9}  {:24}  {device:14}  {}",
            text(&asset, "type"),
            text(&asset, "fileCreatedAt"),
            text(&asset, "originalFileName"),
        );
    }
    Ok(())
}

async fn upload(core: &Core, files: &[PathBuf], work: &Path) -> Result<(), Error> {
    for path in files {
        let request = describe(path, work)?;
        let name = request.file_name.clone();
        let started = Instant::now();
        let done = core.upload(request).await?;
        println!(
            "{name}: {} in {:.1} s — https://photos.daemonclient.uz/photos/{}",
            if done.duplicate {
                "already stored, nothing sent"
            } else {
                "uploaded"
            },
            started.elapsed().as_secs_f64(),
            done.asset_id
        );
    }
    Ok(())
}

/// What the app's image engine gives the core (D23), from macOS tools here;
/// elsewhere no thumbnail and 0×0.
fn describe(path: &Path, work: &Path) -> Result<UploadRequest, Error> {
    // Absolute: the tools never take a name like `-x.jpg` for an option.
    let path = &std::fs::canonicalize(path)?;
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() {
        return Err(format!("not a file: {}", path.display()).into());
    }
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("the file name is not UTF-8")?
        .to_owned();
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "mov" => "video/quicktime",
        "mp4" | "m4v" => "video/mp4",
        _ => return Err(format!("{file_name}: not a photo or video this tool knows").into()),
    };
    let video = mime.starts_with("video/");
    let modified = meta.modified()?;
    let path_text = path.to_str().ok_or("the path is not UTF-8")?;
    // shortcut: a video's size and length come from Spotlight, which skips
    // unindexed folders (0×0, no length then); read the file's header if the
    // website's tiles need them.
    let (width, height) = if video {
        let number = |key| {
            tool("mdls", &["-raw", "-name", key, path_text])?
                .parse()
                .ok()
        };
        number("kMDItemPixelWidth").zip(number("kMDItemPixelHeight"))
    } else {
        tool(
            "sips",
            &["-g", "pixelWidth", "-g", "pixelHeight", path_text],
        )
        .as_deref()
        .and_then(sips_size)
    }
    .unwrap_or((0, 0));
    let picture = |size: &str, out: &Path| -> Option<Vec<u8>> {
        let out_text = out.to_str()?;
        tool(
            "sips",
            &[
                "-s", "format", "jpeg", "-Z", size, path_text, "--out", out_text,
            ],
        )?;
        std::fs::read(out).ok()
    };
    std::fs::create_dir_all(work)?;
    let thumbnail = if video {
        // Quick Look's poster frame, as PNG, then a JPEG.
        let png = work.join(format!("{file_name}.png"));
        tool(
            "qlmanage",
            &[
                "-t",
                "-s",
                "256",
                "-o",
                work.to_str().unwrap_or("."),
                path_text,
            ],
        );
        let jpeg = work.join("poster.jpg");
        let poster = png
            .to_str()
            .and_then(|png| {
                tool(
                    "sips",
                    &["-s", "format", "jpeg", png, "--out", jpeg.to_str()?],
                )
            })
            .and_then(|_| std::fs::read(&jpeg).ok());
        let _ = std::fs::remove_file(&png);
        let _ = std::fs::remove_file(&jpeg);
        poster
    } else {
        picture("256", &work.join("thumb.jpg"))
    };
    // The website cannot show HEIC: it gets a JPEG preview (D23).
    let preview = matches!(mime, "image/heic" | "image/heif")
        .then(|| picture("1440", &work.join("preview.jpg")))
        .flatten();
    let created_at = tool(
        "mdls",
        &["-raw", "-name", "kMDItemContentCreationDate", path_text],
    )
    .as_deref()
    .and_then(mdls_date)
    .unwrap_or_else(|| iso(modified));
    let seconds = video
        .then(|| {
            tool(
                "mdls",
                &["-raw", "-name", "kMDItemDurationSeconds", path_text],
            )
        })
        .flatten()
        .and_then(|s| s.parse::<f64>().ok());
    let modified_ms = modified
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    Ok(UploadRequest {
        path: path.to_owned(),
        // As the website names its uploads: `web-<name>-<lastModified>`.
        device_asset_id: format!("dc-cli-{file_name}-{modified_ms}"),
        device_id: "dc-cli".to_owned(),
        file_name,
        mime: mime.to_owned(),
        created_at,
        modified_at: iso(modified),
        width,
        height,
        duration: seconds.map(duration),
        favorite: false,
        live_photo_video_id: None,
        thumbnail,
        preview,
        thumbhash: None,
        exif: None,
    })
}

/// A macOS tool's output; `None` when it is missing or fails.
fn tool(program: &str, args: &[&str]) -> Option<String> {
    // By full path, never through PATH.
    let out = std::process::Command::new(Path::new("/usr/bin").join(program))
        .args(args)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

async fn download(core: &Core, asset: &str, out: &Path) -> Result<(), Error> {
    let stored = text(
        &worker_json(core, &format!("/api/assets/{asset}")).await?,
        "checksum",
    )
    .to_owned();
    let layout = core.layout(asset, Rendition::Original).await?;
    let RangePlan::Partial(slices) = plan_range(layout.size, 0, u64::MAX) else {
        return Err("the file is empty".into());
    };
    let started = Instant::now();
    let mut reader = core
        .range(
            asset,
            Rendition::Original,
            layout.size,
            slices,
            Class::Opened,
        )
        .await?;
    let mut file = std::fs::File::create(out)?;
    let mut hasher = Sha1::new();
    while let Some(piece) = reader.next().await {
        let piece = piece?;
        hasher.update(&piece);
        file.write_all(&piece)?;
    }
    file.sync_all()?;
    let seconds = started.elapsed().as_secs_f64();
    let digest = hasher.finalize();
    println!(
        "{:.1} MB in {} parts, {seconds:.1} s ({:.2} MB/s)",
        layout.size as f64 / 1e6,
        layout.parts,
        layout.size as f64 / 1e6 / seconds.max(0.001)
    );
    if stored.is_empty() {
        println!("checksum: the worker has none for this asset");
    } else if same_sha1(&digest, &stored) {
        println!("checksum: matches — byte-identical to what was uploaded");
    } else {
        return Err("checksum DIFFERS from the one the worker stored".into());
    }
    Ok(())
}

/// A stored checksum is this SHA-1: base64 from the Immich app and this core,
/// hex from the website.
fn same_sha1(digest: &[u8], stored: &str) -> bool {
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    stored == base64::engine::general_purpose::STANDARD.encode(digest)
        || stored.eq_ignore_ascii_case(&hex)
}

async fn delete(core: &Core, ids: &[String]) -> Result<(), Error> {
    let worker = core.worker()?;
    let session = worker.session();
    let reply = dc_core::http::client()?
        .delete(format!("{}/api/assets", session.worker_url))
        .bearer_auth(session.token.expose())
        .json(&serde_json::json!({ "ids": ids, "force": true }))
        .send()
        .await
        .map_err(|_| "the worker did not answer")?;
    if !reply.status().is_success() {
        return Err(format!("the worker answered {}", reply.status().as_u16()).into());
    }
    println!("deleted {}", ids.len());
    Ok(())
}

async fn serve(core: &Arc<Core>, asset: &str) -> Result<(), Error> {
    // Blocks up to ~2 s per listener: off the async threads.
    let opener = core.clone();
    let urls = tokio::task::spawn_blocking(move || opener.media_server()).await??;
    // These carry the listener's secret: loopback only, gone when this stops.
    println!("original  {}/api/assets/{asset}/original", urls.viewer_base);
    println!(
        "playback  {}/api/assets/{asset}/video/playback",
        urls.viewer_base
    );
    println!(
        "thumbnail {}/api/assets/{asset}/thumbnail?size=thumbnail",
        urls.grid_base
    );
    eprintln!("serving until Ctrl-C");
    // Until Ctrl-C: run() stops it and cleans up.
    std::future::pending::<()>().await;
    Ok(())
}

/// A storage client of its own: its own path cache and send pacer.
async fn fresh(core: &Core) -> Result<Arc<Telegram>, Error> {
    let config = core.worker()?.telegram_config().await?;
    Ok(Arc::new(Telegram::new(
        dc_core::http::client()?,
        TELEGRAM_API.to_owned(),
        config.bot_token,
        config.channel_id,
    )?))
}

struct Phase {
    done: usize,
    seconds: f64,
    times: Vec<Duration>,
    limited: usize,
    retry_after: u64,
    failed: usize,
}

impl Phase {
    fn print(&self, what: &str) {
        let mut times = self.times.clone();
        times.sort();
        let at = |q: usize| {
            times
                .get(times.len() * q / 100)
                .map_or(0, |t| t.as_millis())
        };
        println!(
            "{what}: {} in {:.1} s, {:.1}/s, p50 {} ms, p95 {} ms, rate-limited {}{}, failed {}",
            self.done,
            self.seconds,
            self.done as f64 / self.seconds.max(0.001),
            at(50),
            at(95),
            self.limited,
            if self.limited > 0 {
                format!(" (retry_after {} s)", self.retry_after)
            } else {
                String::new()
            },
            self.failed,
        );
    }
}

/// `ids` through `read` with `at_once` running; nothing new starts after the
/// first rate limit.
async fn phase<F, Fut>(ids: &[String], at_once: usize, read: F) -> Phase
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<(), CoreError>> + Send + 'static,
{
    let gate = Arc::new(Semaphore::new(at_once));
    let stop = Arc::new(AtomicBool::new(false));
    let mut tasks = JoinSet::new();
    let started = Instant::now();
    for id in ids {
        let (gate, stop, work) = (gate.clone(), stop.clone(), read(id.clone()));
        tasks.spawn(async move {
            let _permit = gate.acquire_owned().await;
            if stop.load(Ordering::Relaxed) {
                return None;
            }
            let began = Instant::now();
            let result = work.await;
            if matches!(result, Err(CoreError::RateLimited { .. })) {
                stop.store(true, Ordering::Relaxed);
            }
            Some((began.elapsed(), result))
        });
    }
    let mut result = Phase {
        done: 0,
        seconds: 0.0,
        times: vec![],
        limited: 0,
        retry_after: 0,
        failed: 0,
    };
    while let Some(joined) = tasks.join_next().await {
        match joined {
            Ok(Some((took, Ok(())))) => {
                result.done += 1;
                result.times.push(took);
            }
            Ok(Some((_, Err(CoreError::RateLimited { retry_after })))) => {
                result.limited += 1;
                result.retry_after = result.retry_after.max(retry_after);
            }
            Ok(None) => {}
            _ => result.failed += 1,
        }
    }
    result.seconds = started.elapsed().as_secs_f64();
    result
}

async fn bench_reads(core: &Arc<Core>, n: usize) -> Result<(), Error> {
    let assets = newest(core, n).await?;
    let worker = core.worker()?;
    let mut thumbnails = vec![];
    for id in &assets {
        if let Ok(selection) = select(&worker.manifest(id).await?, Rendition::Thumbnail)
            && let Some(file) = selection.file_ids.into_iter().next()
        {
            thumbnails.push(file);
        }
    }
    println!("{} thumbnails", thumbnails.len());
    // The Bot API's side (file paths), then the file server's (bytes), at
    // rising concurrency; a fresh client each time, so no path is known.
    for at_once in [4, 8, 16, 32] {
        let telegram = fresh(core).await?;
        let paths = {
            let t = telegram.clone();
            phase(&thumbnails, at_once, move |id| {
                let t = t.clone();
                async move { t.get_file(&id).await.map(|_| ()) }
            })
            .await
        };
        paths.print(&format!("paths, {at_once} at once"));
        // After a rate limit, nothing more goes out until it has passed.
        let bytes = if paths.limited > 0 {
            None
        } else {
            let t = telegram.clone();
            Some(
                phase(&thumbnails, at_once, move |id| {
                    let t = t.clone();
                    async move { t.download(&id).await.map(|_| ()) }
                })
                .await,
            )
        };
        if let Some(bytes) = &bytes {
            bytes.print(&format!("bytes, {at_once} at once"));
        }
        let limited = paths.limited + bytes.as_ref().map_or(0, |b| b.limited);
        let waited = paths
            .retry_after
            .max(bytes.as_ref().map_or(0, |b| b.retry_after))
            .min(120);
        if limited > 0 {
            // Right after a rate limit has passed: does a burst trip it again?
            println!("waiting out {waited} s");
            tokio::time::sleep(Duration::from_secs(waited)).await;
            let telegram = fresh(core).await?;
            let burst: Vec<String> = thumbnails.iter().take(10).cloned().collect();
            phase(&burst, 10, move |id| {
                let t = telegram.clone();
                async move { t.get_file(&id).await.map(|_| ()) }
            })
            .await
            .print("a burst of 10 after it");
            break;
        }
    }
    // The core's own path: the scheduler's numbers, all asked for at once.
    let core_reads = {
        let core = core.clone();
        phase(&assets, assets.len().max(1), move |id| {
            let core = core.clone();
            async move {
                core.image(&id, Rendition::Thumbnail, Class::Visible)
                    .await
                    .map(|_| ())
            }
        })
        .await
    };
    core_reads.print("through the core");
    Ok(())
}

async fn bench_sends(core: &Core, n: usize) -> Result<(), Error> {
    // Made first: deleting must not depend on the worker answering later.
    let telegram = fresh(core).await?;
    let mut sent = vec![];
    let measured = tokio::select! {
        result = measure_sends(core, n, &mut sent) => result,
        _ = tokio::signal::ctrl_c() => Err("interrupted".into()),
    };
    // Always: every message the bench made goes.
    let mut left = vec![];
    for message in &sent {
        let mut tries = 0;
        loop {
            match telegram.delete_message(*message).await {
                Ok(()) => break,
                Err(CoreError::RateLimited { retry_after }) if tries < 3 && retry_after <= 120 => {
                    tries += 1;
                    tokio::time::sleep(Duration::from_secs(retry_after.min(120))).await;
                }
                Err(_) => {
                    left.push(*message);
                    break;
                }
            }
        }
    }
    println!(
        "deleted {} of {} messages",
        sent.len() - left.len(),
        sent.len()
    );
    if !left.is_empty() {
        println!("left in the channel, message ids: {left:?}");
    }
    measured
}

async fn measure_sends(core: &Core, n: usize, sent: &mut Vec<i64>) -> Result<(), Error> {
    let tiny = || -> Result<Vec<u8>, Error> {
        let mut bytes = vec![0u8; 64];
        getrandom::fill(&mut bytes)?;
        Ok(bytes)
    };
    // The core's pacer, long enough to show its steady rate holds.
    let paced = (n / 2).min(50);
    let telegram = fresh(core).await?;
    let started = Instant::now();
    let mut limit = None;
    for _ in 0..paced {
        match telegram.send_document("bench.bin", tiny()?).await {
            Ok(message) => sent.push(message.message_id),
            Err(CoreError::RateLimited { retry_after }) => {
                limit = Some(retry_after);
                break;
            }
            Err(e) => return Err(e.into()),
        }
    }
    let report = |what: &str, count: usize, seconds: f64, limit: Option<u64>| {
        println!(
            "{what}: {count} sends in {seconds:.1} s ({:.2}/s){}",
            count as f64 / seconds.max(0.001),
            limit.map_or(String::new(), |r| format!(
                ", then rate-limited: retry_after {r} s"
            ))
        );
    };
    report("paced", sent.len(), started.elapsed().as_secs_f64(), limit);
    if let Some(retry_after) = limit {
        tokio::time::sleep(Duration::from_secs(retry_after.min(120))).await;
        return Ok(());
    }
    // As fast as the storage takes them: a new client (each starts with the
    // pacer's full burst of 3) every 3 sends, one at a time, until the first
    // rate limit.
    let before = sent.len();
    let started = Instant::now();
    let mut telegram = fresh(core).await?;
    for i in 0..n.saturating_sub(paced) {
        if i % 3 == 0 {
            telegram = fresh(core).await?;
        }
        match telegram.send_document("bench.bin", tiny()?).await {
            Ok(message) => sent.push(message.message_id),
            Err(CoreError::RateLimited { retry_after }) => {
                limit = Some(retry_after);
                break;
            }
            Err(e) => return Err(e.into()),
        }
    }
    report(
        "unpaced",
        sent.len() - before,
        started.elapsed().as_secs_f64(),
        limit,
    );
    if let Some(retry_after) = limit {
        tokio::time::sleep(Duration::from_secs(retry_after.min(120))).await;
    }
    Ok(())
}

async fn bench_parts(core: &Core, video: &str) -> Result<(), Error> {
    let manifest = core.worker()?.manifest(video).await?;
    let parts = select(&manifest, Rendition::Original)?.file_ids;
    // Whole parts only (not the last), each pair new to the storage's caches.
    let whole: Vec<String> = parts
        .iter()
        .take(parts.len().saturating_sub(1))
        .cloned()
        .collect();
    if whole.len() < 4 {
        return Err("needs a video of at least five parts".into());
    }
    for (round, [a, b]) in whole.as_chunks::<2>().0.iter().take(4).enumerate() {
        let telegram = fresh(core).await?;
        let started = Instant::now();
        let together = round % 2 == 1;
        if together {
            let (x, y) = tokio::join!(telegram.download(a), telegram.download(b));
            x?;
            y?;
        } else {
            telegram.download(a).await?;
            telegram.download(b).await?;
        }
        let seconds = started.elapsed().as_secs_f64();
        println!(
            "two parts {}: {seconds:.1} s ({:.2} MB/s)",
            if together {
                "at once"
            } else {
                "one after the other"
            },
            2.0 * dc_core::chunk_plan::PART_SIZE as f64 / 1e6 / seconds.max(0.001)
        );
    }
    Ok(())
}

/// `sips -g pixelWidth -g pixelHeight` → (width, height).
fn sips_size(text: &str) -> Option<(u32, u32)> {
    let value = |key: &str| {
        text.lines()
            .find_map(|l| l.trim().strip_prefix(key)?.trim().parse().ok())
    };
    value("pixelWidth:").zip(value("pixelHeight:"))
}

/// `mdls -raw` prints dates in UTC: `2024-05-01 10:20:30 +0000`.
fn mdls_date(text: &str) -> Option<String> {
    let mut words = text.split_whitespace();
    let (date, time, zone) = (words.next()?, words.next()?, words.next()?);
    let shaped = date.len() == 10 && time.len() == 8 && zone == "+0000";
    let digits = |s: &str| {
        s.chars()
            .all(|c| c.is_ascii_digit() || c == '-' || c == ':')
    };
    (shaped && digits(date) && digits(time)).then(|| format!("{date}T{time}.000Z"))
}

/// A time as the worker's dates: `2024-05-01T10:20:30.000Z`.
fn iso(time: SystemTime) -> String {
    let ms = time
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let secs = i64::try_from(ms / 1000).unwrap_or(0);
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's days-to-civil.
    let z = days + 719_468;
    let (era, doe) = (z.div_euclid(146_097), z.rem_euclid(146_097));
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60,
        ms % 1000
    )
}

/// Immich's video length: `H:MM:SS.ffffff`.
fn duration(seconds: f64) -> String {
    let hours = (seconds / 3_600.0).floor();
    let minutes = (seconds % 3_600.0 / 60.0).floor();
    format!("{hours:.0}:{minutes:02.0}:{:09.6}", seconds % 60.0)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    use super::*;

    fn args(line: &str) -> Vec<String> {
        line.split_whitespace().map(str::to_owned).collect()
    }

    #[test]
    fn every_command_parses() {
        assert_eq!(parse(&args("whoami")), Ok(Command::Whoami));
        assert_eq!(parse(&args("list")), Ok(Command::List(20)));
        assert_eq!(parse(&args("list 5")), Ok(Command::List(5)));
        assert_eq!(
            parse(&args("upload a.jpg b.mov")),
            Ok(Command::Upload(vec!["a.jpg".into(), "b.mov".into()]))
        );
        assert_eq!(
            parse(&args("download x out.bin")),
            Ok(Command::Download {
                asset: "x".into(),
                out: "out.bin".into()
            })
        );
        assert_eq!(
            parse(&args("delete x y")),
            Ok(Command::Delete(vec!["x".into(), "y".into()]))
        );
        assert_eq!(parse(&args("serve x")), Ok(Command::Serve("x".into())));
        assert_eq!(parse(&args("bench reads")), Ok(Command::BenchReads(100)));
        assert_eq!(parse(&args("bench reads 30")), Ok(Command::BenchReads(30)));
        assert_eq!(parse(&args("bench sends")), Ok(Command::BenchSends(40)));
        assert_eq!(
            parse(&args("bench parts v")),
            Ok(Command::BenchParts("v".into()))
        );
    }

    #[test]
    fn a_wrong_command_gets_the_usage() {
        for line in [
            "",
            "frobnicate",
            "upload",
            "download x",
            "delete",
            "serve",
            "serve a b",
            "list 0",
            "list -1",
            "list many",
            "bench",
            "bench parts",
            "whoami extra",
        ] {
            assert!(parse(&args(line)).is_err(), "{line:?}");
        }
    }

    #[test]
    fn bench_counts_are_capped() {
        // A typo must not flood the test bot.
        assert_eq!(
            parse(&args("bench reads 100000")),
            Ok(Command::BenchReads(200))
        );
        assert_eq!(
            parse(&args("bench sends 100000")),
            Ok(Command::BenchSends(100))
        );
    }

    #[test]
    fn the_checksum_is_the_workers() {
        // base64(SHA-1("abc")), as the app and the worker store it.
        let digest = Sha1::digest(b"abc");
        assert!(same_sha1(&digest, "qZk+NkcGgWq6PiVxeFDCbJzQ2J0="));
        // The website stores it as hex.
        assert!(same_sha1(
            &digest,
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        ));
        assert!(same_sha1(
            &digest,
            "A9993E364706816ABA3E25717850C26C9CD0D89D"
        ));
        assert!(!same_sha1(&digest, "qZk+NkcGgWq6PiVxeFDCbJzQ2J1="));
        assert!(!same_sha1(&digest, ""));
    }

    #[test]
    fn the_account_is_read_from_the_keychain_attributes() {
        let text = "keychain: \"/x.keychain-db\"\nattributes:\n    \"acct\"<blob>=\"a@b.uz\"\n    \"svce\"<blob>=\"daemonclient-test\"\n";
        assert_eq!(account(text), Some("a@b.uz".to_owned()));
        assert_eq!(account("attributes:\n    \"acct\"<blob>=<NULL>\n"), None);
        assert_eq!(account(""), None);
    }

    #[test]
    fn sips_dimensions_are_read() {
        let text = "/tmp/a.jpg\n  pixelWidth: 4032\n  pixelHeight: 3024\n";
        assert_eq!(sips_size(text), Some((4032, 3024)));
        assert_eq!(sips_size("/tmp/a.jpg\n  pixelWidth: 4032\n"), None);
        assert_eq!(sips_size("Error: unsupported\n"), None);
    }

    #[test]
    fn mdls_dates_become_iso() {
        assert_eq!(
            mdls_date("2024-05-01 10:20:30 +0000"),
            Some("2024-05-01T10:20:30.000Z".to_owned())
        );
        assert_eq!(mdls_date("(null)"), None);
        assert_eq!(mdls_date("2024-05-01 10:20:30 +0200"), None);
        assert_eq!(mdls_date("garbage"), None);
    }

    #[test]
    fn file_times_become_iso() {
        assert_eq!(iso(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso(UNIX_EPOCH + Duration::from_millis(1_700_000_000_123)),
            "2023-11-14T22:13:20.123Z"
        );
        // A leap day.
        assert_eq!(
            iso(UNIX_EPOCH + Duration::from_secs(951_782_400)),
            "2000-02-29T00:00:00.000Z"
        );
    }

    #[test]
    fn durations_are_immichs() {
        assert_eq!(duration(5.0), "0:00:05.000000");
        assert_eq!(duration(3_725.5), "1:02:05.500000");
    }
}
