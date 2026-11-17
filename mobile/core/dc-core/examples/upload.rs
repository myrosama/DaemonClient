//! P1 task 1.7, Gate 2: uploads to the TEST account (uploads and deletes
//! there are approved by the operator). Makes fresh files on this Mac — a JPEG
//! and a HEIC with `sips` (random quality, so new checksums), and a video
//! over 100 MB remuxed with `avconvert` from one of the account's videos —
//! uploads them through the core, reads each back through the core (byte for
//! byte), resumes one upload the way the background uploader will (two parts
//! sent by hand through the hand-off), checks a duplicate sends nothing, and
//! deletes every test asset at the end, even after a failure. A relay in
//! front of Telegram counts what is sent; it never prints a path (they carry
//! the bot token). Password from the Keychain item `daemonclient-test`.
//! Prints sizes, timings and counts — never ids, paths or tokens.
use std::collections::HashMap;
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use bytes::Bytes;
use dc_core::chunk_plan::{RangePlan, plan_range};
use dc_core::reader::Rendition;
use dc_core::sched::Class;
use dc_core::session::{Deployment, HOSTED_API};
use dc_core::upload::{Begun, UploadRequest};
use dc_core::{Core, CoreConfig, TELEGRAM_API};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::{Request, Response, StatusCode};
use sha2::{Digest, Sha256};

type Error = Box<dyn std::error::Error>;
/// The name each document was sent under → times sent.
type Sends = Arc<Mutex<HashMap<String, usize>>>;

fn security(args: &[&str]) -> Result<String, Error> {
    let out = std::process::Command::new("security").args(args).output()?;
    if !out.status.success() {
        return Err("no Keychain item `daemonclient-test` — see examples/sign_in.rs".into());
    }
    // Never `?` the decode error: its Debug output would print the raw bytes.
    let text = String::from_utf8(out.stdout).map_err(|_| "the Keychain value is not UTF-8")?;
    Ok(text.trim().to_owned())
}

/// Forwards the core's Telegram requests and counts the documents sent, by name.
async fn relay(sends: Sends) -> Result<String, Error> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = format!("http://{}", listener.local_addr()?);
    let http = dc_core::http::upload_client()?;
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let (sends, http) = (sends.clone(), http.clone());
            tokio::spawn(async move {
                let service = hyper::service::service_fn(move |request: Request<Incoming>| {
                    let (sends, http) = (sends.clone(), http.clone());
                    async move {
                        let path = request
                            .uri()
                            .path_and_query()
                            .map(|p| p.as_str().to_owned())
                            .unwrap_or_default();
                        let post = request.method() == hyper::Method::POST;
                        let kind = request.headers().get("content-type").cloned();
                        let body = request
                            .into_body()
                            .collect()
                            .await
                            .map(|b| b.to_bytes())
                            .unwrap_or_default();
                        if let Some(name) = document_name(&body) {
                            *sends
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .entry(name)
                                .or_default() += 1;
                        }
                        // Never print `path` or a reqwest error: both carry the bot token.
                        let url = format!("{TELEGRAM_API}{path}");
                        let mut forward = if post {
                            http.post(url).body(body)
                        } else {
                            http.get(url)
                        };
                        if let Some(kind) = kind {
                            forward = forward.header("content-type", kind);
                        }
                        let (status, reply) = match forward.send().await {
                            Ok(reply) => {
                                let status = reply.status().as_u16();
                                reply
                                    .bytes()
                                    .await
                                    .map_or((502, Bytes::new()), |b| (status, b))
                            }
                            Err(_) => (502, Bytes::new()),
                        };
                        let mut response = Response::new(Full::new(reply));
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

/// The `filename` of a multipart document field, from the head of its body.
fn document_name(body: &[u8]) -> Option<String> {
    let head = String::from_utf8_lossy(body.get(..body.len().min(4096))?);
    let after = head.split("name=\"document\"; filename=\"").nth(1)?;
    after.split('"').next().map(str::to_owned)
}

fn run(program: &str, args: &[&str]) -> Result<(), Error> {
    let out = std::process::Command::new(program).args(args).output()?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("{program} failed").into())
    }
}

fn random_below(n: u32) -> Result<u32, Error> {
    let mut b = [0u8; 4];
    getrandom::fill(&mut b)?;
    Ok(u32::from_le_bytes(b) % n)
}

fn sha256(path: &Path) -> Result<String, Error> {
    Ok(hex::encode(Sha256::digest(std::fs::read(path)?)))
}

fn request(
    path: &Path,
    name: &str,
    mime: &str,
    thumb: Option<Vec<u8>>,
    preview: Option<Vec<u8>>,
) -> Result<UploadRequest, Error> {
    let mut id = [0u8; 8];
    getrandom::fill(&mut id)?;
    Ok(UploadRequest {
        path: path.to_owned(),
        file_name: name.to_owned(),
        mime: mime.to_owned(),
        // A month of their own, so leftovers are easy to find.
        created_at: "2001-01-01T00:00:00.000Z".to_owned(),
        modified_at: "2001-01-01T00:00:00.000Z".to_owned(),
        device_asset_id: format!("gate2-{}", hex::encode(id)),
        device_id: "dc-core-gate2".to_owned(),
        width: 0,
        height: 0,
        duration: None,
        favorite: false,
        live_photo_video_id: None,
        thumbnail: thumb,
        preview,
        thumbhash: None,
        exif: None,
    })
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
    let sends: Sends = Arc::default();
    let work = std::env::temp_dir().join("dc-upload-check");
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work)?;
    let mut config = CoreConfig::new(work.join("data"), work.join("cache"));
    config.telegram_api = relay(sends.clone()).await?;
    let core = Arc::new(Core::start(config)?);
    core.sign_in(HOSTED_API, Deployment::Hosted, &email, &password)
        .await?;
    // Test assets an earlier run could not delete go first.
    let old = leftovers(&core).await?;
    remove(&core, &old).await?;
    println!("leftovers from earlier runs deleted: {}", old.len());
    // Reads go straight to Telegram: the relay, which only counts sends,
    // answers after a whole part has arrived and would trip the read limit.
    let direct = Arc::new(Core::start(CoreConfig::new(
        work.join("data2"),
        work.join("cache2"),
    ))?);
    direct
        .sign_in(HOSTED_API, Deployment::Hosted, &email, &password)
        .await?;
    let mut created = vec![];
    let checked = check(&core, &direct, &sends, &work, &mut created).await;
    // Always: the test assets go, and no decrypted pictures stay behind.
    let removed = remove(&core, &created).await;
    core.sign_out()?;
    direct.sign_out()?;
    let _ = std::fs::remove_dir_all(&work);
    match &removed {
        Ok(()) => println!("cleanup: {} test assets deleted", created.len()),
        Err(_) => println!(
            "cleanup FAILED: {} test assets left — the next run deletes them",
            created.len()
        ),
    }
    checked.and(removed)
}

/// Assets this tool made (device id `dc-core-gate2`) in the months it uses.
async fn leftovers(core: &Core) -> Result<Vec<String>, Error> {
    let session = core.worker()?.session().clone();
    let http = dc_core::http::client()?;
    let get = |path: String| {
        let request = http
            .get(format!("{}{path}", session.worker_url))
            .bearer_auth(session.token.expose());
        async move {
            let reply = request
                .send()
                .await
                .map_err(|_| "a leftover lookup failed")?;
            serde_json::from_slice::<serde_json::Value>(
                &reply.bytes().await.map_err(|_| "a reply broke off")?,
            )
            .map_err(|_| "a leftover reply is not JSON")
        }
    };
    let buckets = get("/api/timeline/buckets".to_owned()).await?;
    let mut found = vec![];
    for bucket in buckets.as_array().ok_or("buckets: not a list")? {
        let month = bucket
            .get("timeBucket")
            .and_then(|m| m.as_str())
            .unwrap_or_default();
        if !(month.starts_with("2001-01") || month.starts_with("2026-11")) {
            continue;
        }
        let assets = get(format!("/api/timeline/bucket?timeBucket={month}")).await?;
        for id in assets
            .get("id")
            .and_then(|i| i.as_array())
            .into_iter()
            .flatten()
            .filter_map(|i| i.as_str())
        {
            let asset = get(format!("/api/assets/{id}")).await?;
            if asset.get("deviceId").and_then(|d| d.as_str()) == Some("dc-core-gate2") {
                found.push(id.to_owned());
            }
        }
    }
    Ok(found)
}

async fn remove(core: &Core, ids: &[String]) -> Result<(), Error> {
    if ids.is_empty() {
        return Ok(());
    }
    let session = core.worker()?.session().clone();
    let reply = dc_core::http::client()?
        .delete(format!("{}/api/assets", session.worker_url))
        .bearer_auth(session.token.expose())
        .json(&serde_json::json!({"ids": ids, "force": true}))
        .send()
        .await
        .map_err(|_| "the delete request failed")?;
    if reply.status().is_success() {
        Ok(())
    } else {
        Err(format!("delete answered {}", reply.status().as_u16()).into())
    }
}

/// The original, read back through the core, against the file on disk.
async fn same_as(core: &Core, id: &str, source: &Path) -> Result<bool, Error> {
    let layout = core.layout(id, Rendition::Original).await?;
    let RangePlan::Partial(slices) = plan_range(layout.size, 0, u64::MAX) else {
        return Ok(false);
    };
    let mut reader = core
        .range(id, Rendition::Original, layout.size, slices, Class::Opened)
        .await?;
    let mut hasher = Sha256::new();
    while let Some(piece) = reader.next().await {
        hasher.update(&piece?);
    }
    Ok(hex::encode(hasher.finalize()) == sha256(source)?)
}

async fn check(
    core: &Arc<Core>,
    direct: &Arc<Core>,
    sends: &Sends,
    work: &Path,
    created: &mut Vec<String>,
) -> Result<(), Error> {
    let source = "/System/Library/Desktop Pictures/iMac Blue.heic";
    let (jpg, heic) = (work.join("photo.jpg"), work.join("photo.heic"));
    let quality = (60 + random_below(35)?).to_string();
    run(
        "sips",
        &[
            "-s",
            "format",
            "jpeg",
            "-s",
            "formatOptions",
            &quality,
            source,
            "--out",
            &jpg.to_string_lossy(),
        ],
    )?;
    run(
        "sips",
        &[
            "-s",
            "format",
            "heic",
            "-s",
            "formatOptions",
            &quality,
            source,
            "--out",
            &heic.to_string_lossy(),
        ],
    )?;
    let picture = |from: &Path, size: &str, out: &str| -> Result<Vec<u8>, Error> {
        let out = work.join(out);
        run(
            "sips",
            &[
                "-Z",
                size,
                "-s",
                "format",
                "jpeg",
                &from.to_string_lossy(),
                "--out",
                &out.to_string_lossy(),
            ],
        )?;
        Ok(std::fs::read(out)?)
    };
    let mut failures = 0;

    // A JPEG and a HEIC (with its preview), in the foreground.
    for (path, name, mime, preview) in [
        (&jpg, "gate2.jpg", "image/jpeg", false),
        (&heic, "gate2.heic", "image/heic", true),
    ] {
        let thumb = picture(path, "256", "thumb.jpg")?;
        let preview = if preview {
            Some(picture(path, "1440", "preview.jpg")?)
        } else {
            None
        };
        let started = Instant::now();
        let done = core
            .upload(request(path, name, mime, Some(thumb), preview)?)
            .await?;
        created.push(done.asset_id.clone());
        let same = same_as(direct, &done.asset_id, path).await?;
        let tile = core
            .image(&done.asset_id, Rendition::Thumbnail, Class::Visible)
            .await?;
        let jpeg = tile.bytes.starts_with(&[0xff, 0xd8]);
        failures += usize::from(done.duplicate || !same || !jpeg);
        println!(
            "{mime}: {} KB uploaded in {:.1} s — read back {}, thumbnail {}",
            std::fs::metadata(path)?.len() / 1024,
            started.elapsed().as_secs_f64(),
            if same { "byte-identical" } else { "DIFFERENT" },
            if jpeg { "a JPEG" } else { "NOT A JPEG" }
        );
    }

    // The same JPEG again: a duplicate, nothing sent.
    let before: usize = sends
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .sum();
    let again = core
        .upload(request(&jpg, "gate2.jpg", "image/jpeg", None, None)?)
        .await?;
    let after: usize = sends
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .sum();
    failures += usize::from(!again.duplicate || after != before);
    println!(
        "the same JPEG again: {}, {} sends",
        if again.duplicate {
            "a duplicate"
        } else {
            "NOT A DUPLICATE"
        },
        after - before
    );

    // A video over 100 MB, made from one of the account's, uploaded the way
    // the background uploader will: two parts sent by hand, then resumed.
    let video = make_video(direct, work).await?;
    let size = std::fs::metadata(&video)?.len();
    run(
        "qlmanage",
        &[
            "-t",
            "-s",
            "256",
            "-o",
            &work.to_string_lossy(),
            &video.to_string_lossy(),
        ],
    )?;
    let poster = work.join(format!(
        "{}.png",
        video
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
    ));
    let thumb = picture(&poster, "256", "video-thumb.jpg")?;
    // The same file each time: the same device ids, so a second call resumes.
    let first = request(
        &video,
        "gate2.mov",
        "video/quicktime",
        Some(thumb.clone()),
        None,
    )?;
    let device_asset_id = first.device_asset_id.clone();
    let make = || -> Result<UploadRequest, Error> {
        let mut again = request(
            &video,
            "gate2.mov",
            "video/quicktime",
            Some(thumb.clone()),
            None,
        )?;
        again.device_asset_id = device_asset_id.clone();
        Ok(again)
    };
    let earlier: std::collections::HashSet<String> = sends
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .keys()
        .cloned()
        .collect();
    let Begun::Job(job) = core.begin_upload(make()?).await? else {
        return Err("the new video was taken for a duplicate".into());
    };
    let pending = job.pending();
    let http = dc_core::http::upload_client()?;
    for index in pending.iter().take(2) {
        let part = core.part(&job, *index).await?;
        let body = std::fs::read(&part.body_path)?;
        let answer = http
            .post(part.address())
            .header("content-type", &part.content_type)
            .body(body)
            .send()
            .await
            .map_err(|_| "a hand-off send failed")?
            .bytes()
            .await
            .map_err(|_| "a hand-off answer broke off")?;
        core.part_sent(&job, *index, &answer).await?;
    }
    drop(job); // the app was suspended; the foreground picks it up
    let started = Instant::now();
    let done = core.upload(make()?).await?;
    let seconds = started.elapsed().as_secs_f64();
    created.push(done.asset_id.clone());
    let counts: Vec<usize> = sends
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|(name, _)| name.contains(".part") && !earlier.contains(*name))
        .map(|(_, n)| *n)
        .collect();
    let twice = counts.iter().filter(|n| **n > 1).count();
    failures += usize::from(twice > 0 || counts.len() != pending.len());
    // Printed before the read-back, so a later failure cannot hide it.
    println!(
        "video: {:.1} MB in {} parts — 2 sent by hand (hand-off), {} resumed in {seconds:.1} s; parts sent: {}, twice: {twice}",
        size as f64 / 1_048_576.0,
        pending.len(),
        pending.len().saturating_sub(2),
        counts.len()
    );
    let same = same_as(direct, &done.asset_id, &video).await?;
    failures += usize::from(!same);
    println!(
        "video read back: {}",
        if same { "byte-identical" } else { "DIFFERENT" }
    );
    if failures > 0 {
        return Err(format!("{failures} checks failed").into());
    }
    Ok(())
}

/// The smallest video over 100 MB in the account, read through the core and
/// remuxed (`PresetPassthrough`: same streams, new bytes, so a new checksum).
async fn make_video(core: &Arc<Core>, work: &Path) -> Result<PathBuf, Error> {
    let session = core.worker()?.session().clone();
    let http = dc_core::http::client()?;
    let get = |path: String| {
        let request = http
            .get(format!("{}{path}", session.worker_url))
            .bearer_auth(session.token.expose());
        async move {
            let reply = request
                .send()
                .await
                .map_err(|_| "a timeline request failed")?;
            serde_json::from_slice::<serde_json::Value>(
                &reply.bytes().await.map_err(|_| "a reply broke off")?,
            )
            .map_err(|_| "a timeline reply is not JSON")
        }
    };
    let buckets = get("/api/timeline/buckets".to_owned()).await?;
    let mut ids = vec![];
    for bucket in buckets.as_array().ok_or("buckets: not a list")? {
        let month = bucket
            .get("timeBucket")
            .and_then(|m| m.as_str())
            .ok_or("a bucket without a month")?;
        let assets = get(format!("/api/timeline/bucket?timeBucket={month}")).await?;
        ids.extend(
            assets
                .get("id")
                .and_then(|i| i.as_array())
                .into_iter()
                .flatten()
                .filter_map(|i| i.as_str())
                .map(str::to_owned),
        );
    }
    let worker = core.worker()?;
    let (mut pending, mut running, mut best) = (
        ids.into_iter(),
        tokio::task::JoinSet::new(),
        None::<(u64, String)>,
    );
    loop {
        while running.len() < 8
            && let Some(id) = pending.next()
        {
            let (core, worker) = (core.clone(), worker.clone());
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
        let fits = m.mime_type.starts_with("video/") && m.file_size > 100 << 20;
        if fits && best.as_ref().is_none_or(|(size, _)| m.file_size < *size) {
            best = Some((m.file_size, id));
        }
    }
    let (_, id) = best.ok_or("no video over 100 MB in the account")?;
    let source = work.join("source.mov");
    let layout = core.layout(&id, Rendition::Original).await?;
    let RangePlan::Partial(slices) = plan_range(layout.size, 0, u64::MAX) else {
        return Err("an empty video".into());
    };
    let mut reader = core
        .range(&id, Rendition::Original, layout.size, slices, Class::Opened)
        .await?;
    let mut file = std::fs::File::create(&source)?;
    while let Some(piece) = reader.next().await {
        std::io::Write::write_all(&mut file, &piece?)?;
    }
    let out = work.join("gate2.mov");
    run(
        "avconvert",
        &[
            "-s",
            &source.to_string_lossy(),
            "-o",
            &out.to_string_lossy(),
            "-p",
            "PresetPassthrough",
            "--replace",
        ],
    )?;
    std::fs::remove_file(&source)?;
    Ok(out)
}
