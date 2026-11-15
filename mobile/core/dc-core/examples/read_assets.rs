//! P1 task 1.5, Gate 2: read every asset shape of the TEST account through
//! the core and compare the bytes with what the production worker serves.
//! Lists assets through the worker's timeline (the web's calls), groups them
//! by storage shape and, for the smallest of each shape, reads thumbnail,
//! preview and original. Originals up to 40 MB are compared in full
//! (SHA-256); larger ones are read in full through the core (every part's
//! length checked) and compared on three ranges, one across a part boundary.
//! Password from the macOS Keychain item `daemonclient-test` (see
//! examples/sign_in.rs). Read-only. Prints shapes, sizes and timings — never
//! ids, names or tokens.
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Instant;

use dc_core::chunk_plan::{PART_SIZE, RangePlan, plan_range};
use dc_core::reader::Rendition;
use dc_core::sched::Class;
use dc_core::session::{Deployment, HOSTED_API};
use dc_core::worker::AssetManifest;
use dc_core::{Core, CoreConfig, CoreError};
use sha2::{Digest, Sha256};

type Error = Box<dyn std::error::Error>;

fn security(args: &[&str]) -> Result<String, Error> {
    let out = std::process::Command::new("security").args(args).output()?;
    if !out.status.success() {
        return Err("no Keychain item `daemonclient-test` — see examples/sign_in.rs".into());
    }
    // Never `?` the decode error: its Debug output would print the raw bytes.
    let text = String::from_utf8(out.stdout).map_err(|_| "the Keychain value is not UTF-8")?;
    Ok(text.trim().to_owned())
}

fn shape(m: &AssetManifest) -> String {
    let parts = match (m.chunks.len(), m.original_id.is_empty()) {
        (0, false) => "originalId only".to_owned(),
        (0, true) => "no file".to_owned(),
        (n, _) => format!(
            "{} part{}",
            if n <= 3 {
                n.to_string()
            } else {
                "4+".to_owned()
            },
            if n == 1 { "" } else { "s" }
        ),
    };
    format!(
        "{} {} {}{}{}",
        if m.encryption_mode.is_empty() {
            "\"\""
        } else {
            &m.encryption_mode
        },
        m.mime_type.split('/').next().unwrap_or(""),
        parts,
        if m.preview_id.is_empty() {
            ""
        } else {
            " +preview"
        },
        if m.playback_chunks.as_ref().is_some_and(|p| !p.is_empty()) {
            " +rendition"
        } else {
            ""
        },
    )
}

/// The core's bytes for `start..=end` of the original.
async fn core_range(
    core: &Core,
    id: &str,
    size: u64,
    start: u64,
    end: u64,
) -> Result<Vec<u8>, Error> {
    let RangePlan::Partial(slices) = plan_range(size, start, end) else {
        return Err("no such range".into());
    };
    let mut reader = core
        .range(id, Rendition::Original, slices, Class::Opened)
        .await?;
    let mut bytes = vec![];
    while let Some(piece) = reader.next().await {
        bytes.extend_from_slice(&piece?);
    }
    Ok(bytes)
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
    let dir = std::env::temp_dir().join("dc-read-check");
    let core = Arc::new(Core::start(CoreConfig::new(
        dir.join("data"),
        dir.join("cache"),
    ))?);
    core.sign_in(HOSTED_API, Deployment::Hosted, &email, &password)
        .await?;
    let worker = core.worker()?;
    let session = worker.session().clone();
    let http = dc_core::http::client()?;
    // The production path: the worker's own answer for the same bytes.
    let from_worker = |path: String, range: Option<(u64, u64)>| {
        let mut request = http
            .get(format!("{}{path}", session.worker_url))
            .bearer_auth(session.token.expose());
        if let Some((start, end)) = range {
            request = request.header("range", format!("bytes={start}-{end}"));
        }
        async move {
            let reply = request
                .send()
                .await
                .map_err(|_| "a worker request failed")?;
            if !reply.status().is_success() {
                return Err(format!("the worker answered {}", reply.status().as_u16()));
            }
            Ok(reply
                .bytes()
                .await
                .map_err(|_| "a worker reply broke off")?
                .to_vec())
        }
    };

    let buckets: serde_json::Value =
        serde_json::from_slice(&from_worker("/api/timeline/buckets".into(), None).await?)?;
    let mut ids = vec![];
    for bucket in buckets.as_array().ok_or("buckets: not a list")? {
        let month = bucket
            .get("timeBucket")
            .and_then(|m| m.as_str())
            .ok_or("a bucket without a month")?;
        let assets: serde_json::Value = serde_json::from_slice(
            &from_worker(format!("/api/timeline/bucket?timeBucket={month}"), None).await?,
        )?;
        for id in assets
            .get("id")
            .and_then(|i| i.as_array())
            .ok_or("a bucket without ids")?
        {
            ids.push(id.as_str().ok_or("an id is not text")?.to_owned());
        }
    }
    // Every asset: its manifest (for the shapes) and its grid thumbnail
    // through the core, 8 at a time — every tile of the account must load.
    let mut shapes: BTreeMap<String, (usize, String, u64)> = BTreeMap::new();
    let mut tiles: BTreeMap<&str, usize> = BTreeMap::new();
    let (mut pending, mut running) = (ids.iter(), tokio::task::JoinSet::new());
    let started = Instant::now();
    loop {
        while running.len() < 8
            && let Some(id) = pending.next()
        {
            let (core, worker, id) = (core.clone(), worker.clone(), id.clone());
            running.spawn(async move {
                let asset = id.clone();
                let manifest = core.run(async move { worker.manifest(&asset).await }).await;
                let tile = core.image(&id, Rendition::Thumbnail, Class::Visible).await;
                (id, manifest, tile)
            });
        }
        let Some(done) = running.join_next().await else {
            break;
        };
        let (id, manifest, tile) = done?;
        let kind = match &tile {
            Ok(b) if b.starts_with(&[0xff, 0xd8]) => "jpeg",
            Ok(b) if b.starts_with(&[0x89, b'P', b'N', b'G']) => "png",
            Ok(_) => "NOT A PICTURE",
            Err(CoreError::Corrupt(_)) => "DAMAGED",
            Err(_) => "FAILED",
        };
        *tiles.entry(kind).or_default() += 1;
        let m = manifest??;
        let entry = shapes
            .entry(shape(&m))
            .or_insert((0, id.clone(), m.file_size));
        entry.0 += 1;
        if m.file_size < entry.2 {
            (entry.1, entry.2) = (id, m.file_size);
        }
    }
    println!(
        "every grid thumbnail, through the core, in {} s: {tiles:?}",
        started.elapsed().as_secs()
    );
    let mut failures = tiles
        .iter()
        .filter(|(kind, _)| !matches!(**kind, "jpeg" | "png"))
        .map(|(_, n)| n)
        .sum::<usize>();
    println!(
        "{} assets, {} shapes; the smallest of each read:",
        ids.len(),
        shapes.len()
    );

    for (shape, (count, id, _)) in &shapes {
        let started = Instant::now();
        let thumb = core.image(id, Rendition::Thumbnail, Class::Visible).await?;
        let thumb_ms = started.elapsed().as_millis();
        let preview = core.image(id, Rendition::Preview, Class::Opened).await?;
        let layout = core.layout(id, Rendition::Original).await?;
        let started = Instant::now();
        let all = core_range(&core, id, layout.size, 0, u64::MAX).await?;
        let read_ms = started.elapsed().as_millis();
        let same = if layout.size <= 40 * 1024 * 1024 {
            let theirs = from_worker(format!("/api/assets/{id}/original"), None).await?;
            format!(
                "full SHA-256 {}",
                if digest(&all) == digest(&theirs) {
                    "equal"
                } else {
                    "DIFFERENT"
                }
            )
        } else {
            let mut equal = 0;
            let mut random = [0u8; 16];
            getrandom::fill(&mut random)?;
            let pick = |i: usize| -> u64 {
                let bytes: [u8; 8] = random
                    .get(i..i + 8)
                    .and_then(|b| b.try_into().ok())
                    .unwrap_or_default();
                u64::from_le_bytes(bytes) % layout.size.saturating_sub(65_536).max(1)
            };
            for start in [PART_SIZE - 1_000, pick(0), pick(8)] {
                let end = (start + 65_535).min(layout.size - 1);
                let ours = core_range(&core, id, layout.size, start, end).await?;
                let theirs =
                    from_worker(format!("/api/assets/{id}/original"), Some((start, end))).await?;
                equal += usize::from(
                    ours == theirs
                        && all.get(usize::try_from(start)?..=usize::try_from(end)?)
                            == Some(&ours[..]),
                );
            }
            format!("3 ranges, {equal} equal")
        };
        if !same.ends_with(" equal")
            || same.contains("DIFFERENT")
            || (same.starts_with('3') && !same.contains("3 equal"))
        {
            failures += 1;
        }
        let jpeg = |b: &[u8]| {
            if b.starts_with(&[0xff, 0xd8, 0xff]) {
                "jpeg"
            } else {
                "not jpeg"
            }
        };
        println!(
            "{count:>5} × {shape:<32} thumb {} KB {} ({thumb_ms} ms) · preview {} KB {} · original {} KB in {} parts, read in {read_ms} ms · {same}",
            thumb.len() / 1024,
            jpeg(&thumb),
            preview.len() / 1024,
            jpeg(&preview),
            layout.size / 1024,
            layout.parts,
        );
    }
    // Leaves no decrypted test-account pictures in the temp folder.
    core.sign_out()?;
    if failures > 0 {
        return Err(format!("{failures} thumbnails or shapes failed").into());
    }
    Ok(())
}
