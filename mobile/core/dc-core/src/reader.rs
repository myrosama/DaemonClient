//! Reading an asset (P1 design §5.6): which stored file answers which
//! request — the web's `selectFileIds` and playback rule
//! (immich/web/src/service-worker/telegram-media.ts and index.ts), ported
//! exactly — and the checks that keep every byte at its offset.

use std::sync::Weak;

use bytes::Bytes;

use crate::CoreError;
use crate::chunk_plan::{PART_SIZE, PartSlice, PartSlices, part_count};
use crate::sched::{Class, Scheduler};
use crate::worker::{AssetManifest, ManifestChunk};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Rendition {
    /// The grid's small JPEG.
    Thumbnail,
    /// The viewer's large JPEG (`size=preview` and `size=fullsize`).
    Preview,
    Original,
    /// What a video player gets: the H.264 rendition when one exists.
    Playback,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selection {
    /// Telegram files in order: one for an image rendition, every part for an original.
    pub file_ids: Vec<String>,
    /// Plaintext bytes in all; 0 when the manifest does not say.
    pub size: u64,
    pub mime: String,
}

impl Selection {
    /// The plaintext length part `index` must have; `None` when unknown.
    pub fn part_len(&self, index: usize) -> Option<u64> {
        let last = self.file_ids.len().checked_sub(1)?;
        match self.size {
            0 => None,
            _ if index < last => Some(PART_SIZE),
            size => size.checked_sub(PART_SIZE * last as u64),
        }
    }
}

const JPEG: &str = "image/jpeg";

pub fn select(m: &AssetManifest, rendition: Rendition) -> Result<Selection, CoreError> {
    let single = m.chunks.len() <= 1;
    let image = |id: &str| one(id, JPEG, 0);
    let original = |id: &str| check(vec![id.to_owned()], m.file_size, &m.mime_type);
    match rendition {
        Rendition::Thumbnail if !m.thumb_id.is_empty() => image(&m.thumb_id),
        Rendition::Thumbnail if !m.preview_id.is_empty() => image(&m.preview_id),
        Rendition::Preview if !m.preview_id.is_empty() => image(&m.preview_id),
        Rendition::Thumbnail | Rendition::Preview if single && !m.original_id.is_empty() => {
            original(&m.original_id)
        }
        Rendition::Preview if !m.thumb_id.is_empty() => image(&m.thumb_id),
        Rendition::Thumbnail | Rendition::Preview => Err(CoreError::NotFound),
        Rendition::Original if single && !m.original_id.is_empty() => original(&m.original_id),
        Rendition::Original => in_order(&m.chunks, m.file_size, &m.mime_type),
        Rendition::Playback => match m.playback_chunks.as_deref() {
            Some(parts) if !parts.is_empty() => {
                let size = m.playback_size.filter(|&s| s > 0).unwrap_or(m.file_size);
                in_order(parts, size, &m.mime_type)
            }
            _ => select(m, Rendition::Original),
        },
    }
}

fn one(id: &str, mime: &str, size: u64) -> Result<Selection, CoreError> {
    Ok(Selection {
        file_ids: vec![id.to_owned()],
        size,
        mime: mime.to_owned(),
    })
}

fn in_order(parts: &[ManifestChunk], size: u64, mime: &str) -> Result<Selection, CoreError> {
    let mut parts: Vec<&ManifestChunk> = parts.iter().collect();
    parts.sort_by_key(|p| p.index);
    // By declared index: a missing or repeated entry would otherwise put every
    // later part at the wrong offset.
    if parts.iter().enumerate().any(|(i, p)| p.index != i as u64) {
        return Err(CoreError::Corrupt(
            "its parts are not numbered 0 to n−1".to_owned(),
        ));
    }
    check(
        parts.iter().map(|p| p.file_id.clone()).collect(),
        size,
        mime,
    )
}

/// The part count must match the size; one file with no size is a 0-byte
/// upload or an older one whose size was never stored — served as it is.
fn check(file_ids: Vec<String>, size: u64, mime: &str) -> Result<Selection, CoreError> {
    let n = file_ids.len() as u64;
    let fits = match size {
        0 => n == 1,
        _ => n == part_count(size),
    };
    match n {
        0 => Err(CoreError::NotFound),
        _ if !fits => Err(CoreError::Corrupt(
            "its size does not match its parts".to_owned(),
        )),
        _ => Ok(Selection {
            file_ids,
            size,
            mime: mime.to_owned(),
        }),
    }
}

/// What a player needs before asking for bytes (`HEAD`, `Content-Range`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    pub size: u64,
    pub parts: usize,
    pub mime: String,
}

/// Encrypted by the worker or a client; anything else (`off`, `""`) is plain.
pub fn is_encrypted(m: &AssetManifest) -> bool {
    matches!(m.encryption_mode.as_str(), "server" | "client")
}

/// How a stored file is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Stored {
    Plain,
    Encrypted,
    /// An encrypted library's thumbnail or preview. Older uploads stored it
    /// plain, so when decryption fails the bytes are used if they are a JPEG
    /// or PNG — the worker's own rule (immich-api-shim `assets.ts`).
    Picture,
}

impl Stored {
    pub(crate) fn of(m: &AssetManifest) -> Self {
        if is_encrypted(m) {
            Self::Encrypted
        } else {
            Self::Plain
        }
    }
}

/// The scheduler's key for one stored file: how to read it, and its id.
pub(crate) fn job_key(file_id: &str, stored: Stored) -> String {
    let how = match stored {
        Stored::Plain => "p:",
        Stored::Encrypted => "e:",
        Stored::Picture => "i:",
    };
    format!("{how}{file_id}")
}

pub(crate) fn parse_job_key(key: &str) -> Option<(&str, Stored)> {
    match key.split_at_checked(2)? {
        ("p:", id) => Some((id, Stored::Plain)),
        ("e:", id) => Some((id, Stored::Encrypted)),
        ("i:", id) => Some((id, Stored::Picture)),
        _ => None,
    }
}

/// JPEG or PNG, by the same magic bytes the worker checks.
pub(crate) fn is_picture(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xff, 0xd8]) || bytes.starts_with(&[0x89, b'P', b'N', b'G'])
}

/// One stored file, through the account's scheduler, its length checked when known.
pub(crate) async fn read_file(
    scheduler: &Weak<Scheduler>,
    selection: &Selection,
    stored: Stored,
    index: usize,
    class: Class,
) -> Result<Bytes, CoreError> {
    let file_id = selection
        .file_ids
        .get(index)
        .ok_or_else(|| CoreError::Corrupt("a part is missing".to_owned()))?;
    let ticket = scheduler
        .upgrade()
        .ok_or(CoreError::SignedOut)?
        .read(job_key(file_id, stored), class);
    let bytes = ticket.wait().await?;
    match selection.part_len(index) {
        Some(len) if bytes.len() as u64 != len => {
            Err(CoreError::Corrupt("a part has the wrong length".to_owned()))
        }
        _ => Ok(bytes),
    }
}

/// A byte range of an original or a video, one part at a time, so memory
/// stays at a part however large the file. Ends with an error if the account
/// signs out meanwhile.
pub struct RangeReader {
    pub(crate) scheduler: Weak<Scheduler>,
    pub(crate) selection: Selection,
    pub(crate) stored: Stored,
    pub(crate) slices: PartSlices,
    pub(crate) class: Class,
}

impl RangeReader {
    /// The next piece of the range, `None` when it is all read.
    pub async fn next(&mut self) -> Option<Result<Bytes, CoreError>> {
        let slice = self.slices.next()?;
        Some(self.piece(slice).await)
    }

    async fn piece(&self, slice: PartSlice) -> Result<Bytes, CoreError> {
        let short = || CoreError::Corrupt("a part is shorter than the range".to_owned());
        let index = usize::try_from(slice.index).map_err(|_| short())?;
        let part = read_file(
            &self.scheduler,
            &self.selection,
            self.stored,
            index,
            self.class,
        )
        .await?;
        let start = usize::try_from(slice.start).map_err(|_| short())?;
        let end = usize::try_from(slice.end_inclusive).map_err(|_| short())?;
        if start > end || end >= part.len() {
            return Err(short());
        }
        Ok(part.slice(start..=end))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const MIB: u64 = 1024 * 1024;

    fn manifest(fields: serde_json::Value) -> AssetManifest {
        let mut m = json!({"encryptionMode": "server", "mimeType": "image/heic", "fileSize": 1000});
        if let (Some(m), Some(f)) = (m.as_object_mut(), fields.as_object()) {
            m.extend(f.clone());
        }
        serde_json::from_value(m).unwrap()
    }

    fn ids(s: &Selection) -> Vec<&str> {
        s.file_ids.iter().map(String::as_str).collect()
    }

    fn chunks(indexes: &[u64]) -> serde_json::Value {
        indexes
            .iter()
            .map(|i| json!({"index": i, "file_id": format!("c{i}")}))
            .collect()
    }

    #[test]
    fn grid_thumbnail_prefers_thumb_then_preview_then_a_single_original() {
        let pick = |f| select(&manifest(f), Rendition::Thumbnail);
        let s = pick(json!({"thumbId": "t", "previewId": "p", "originalId": "o"})).unwrap();
        assert_eq!((ids(&s), s.mime.as_str()), (vec!["t"], "image/jpeg"));
        assert_eq!(
            ids(&pick(json!({"previewId": "p", "originalId": "o"})).unwrap()),
            ["p"]
        );
        let s = pick(json!({"originalId": "o"})).unwrap();
        assert_eq!(
            (ids(&s), s.mime.as_str(), s.size),
            (vec!["o"], "image/heic", 1000)
        );
        assert!(matches!(
            pick(json!({"chunks": chunks(&[0, 1]), "fileSize": 30 * MIB})),
            Err(CoreError::NotFound)
        ));
        assert!(
            matches!(
                pick(json!({"chunks": chunks(&[0])})),
                Err(CoreError::NotFound)
            ),
            "the web needs originalId"
        );
    }

    #[test]
    fn preview_prefers_preview_then_a_single_original_then_thumb() {
        let pick = |f| select(&manifest(f), Rendition::Preview);
        assert_eq!(
            ids(&pick(json!({"thumbId": "t", "previewId": "p", "originalId": "o"})).unwrap()),
            ["p"]
        );
        assert_eq!(
            ids(&pick(json!({"thumbId": "t", "originalId": "o"})).unwrap()),
            ["o"]
        );
        assert_eq!(
            ids(&pick(json!({"thumbId": "t", "chunks": chunks(&[0])})).unwrap()),
            ["t"]
        );
        let multi = json!({"thumbId": "t", "originalId": "o", "chunks": chunks(&[0, 1]), "fileSize": 30 * MIB});
        assert_eq!(ids(&pick(multi).unwrap()), ["t"]);
        assert!(matches!(pick(json!({})), Err(CoreError::NotFound)));
    }

    #[test]
    fn original_is_every_part_in_order_or_the_one_original_file() {
        let pick = |f| select(&manifest(f), Rendition::Original);
        assert_eq!(ids(&pick(json!({"originalId": "o"})).unwrap()), ["o"]);
        assert_eq!(
            ids(&pick(json!({"originalId": "o", "chunks": chunks(&[0])})).unwrap()),
            ["o"]
        );
        assert_eq!(ids(&pick(json!({"chunks": chunks(&[0])})).unwrap()), ["c0"]);
        let s =
            pick(json!({"originalId": "o", "chunks": chunks(&[2, 0, 1]), "fileSize": 40 * MIB}))
                .unwrap();
        assert_eq!((ids(&s), s.size), (vec!["c0", "c1", "c2"], 40 * MIB));
        assert!(matches!(
            pick(json!({"thumbId": "t"})),
            Err(CoreError::NotFound)
        ));
    }

    #[test]
    fn playback_prefers_the_h264_rendition() {
        let pick = |f| select(&manifest(f), Rendition::Playback);
        let base = json!({"originalId": "o", "fileSize": 30 * MIB,
            "playbackChunks": [{"index": 0, "file_id": "r0"}], "playbackSize": 5 * MIB});
        let s = pick(base).unwrap();
        assert_eq!((ids(&s), s.size), (vec!["r0"], 5 * MIB));
        let s = pick(json!({"originalId": "o", "fileSize": 7 * MIB, "playbackChunks": [{"index": 0, "file_id": "r0"}]})).unwrap();
        assert_eq!(
            s.size,
            7 * MIB,
            "no playbackSize: the original's, as the web does"
        );
        assert_eq!(
            ids(&pick(json!({"originalId": "o", "playbackChunks": []})).unwrap()),
            ["o"]
        );
    }

    #[test]
    fn parts_that_do_not_add_up_are_refused() {
        let pick = |f| select(&manifest(f), Rendition::Original);
        let corrupt = |f| matches!(pick(f), Err(CoreError::Corrupt(_)));
        assert!(
            corrupt(json!({"chunks": chunks(&[0, 2]), "fileSize": 30 * MIB})),
            "a gap"
        );
        assert!(
            corrupt(json!({"chunks": chunks(&[0, 0]), "fileSize": 30 * MIB})),
            "a repeat"
        );
        assert!(
            corrupt(json!({"chunks": chunks(&[0, 1, 2]), "fileSize": 30 * MIB})),
            "too many for the size"
        );
        assert!(
            corrupt(json!({"chunks": chunks(&[0, 1]), "fileSize": 0})),
            "parts without a size"
        );
        assert!(
            corrupt(json!({"originalId": "o", "fileSize": 25 * MIB})),
            "one file over a part"
        );
        assert!(
            pick(json!({"chunks": chunks(&[0]), "fileSize": 0})).is_ok(),
            "a 0-byte or older upload"
        );
    }

    #[test]
    fn every_part_but_the_last_is_a_full_part() {
        let s = select(
            &manifest(json!({"chunks": chunks(&[0, 1, 2]), "fileSize": 40 * MIB})),
            Rendition::Original,
        )
        .unwrap();
        let lens: Vec<_> = (0..3).map(|i| s.part_len(i)).collect();
        assert_eq!(lens, [Some(19 * MIB), Some(19 * MIB), Some(2 * MIB)]);
        let s = select(&manifest(json!({"thumbId": "t"})), Rendition::Thumbnail).unwrap();
        assert_eq!(s.part_len(0), None, "a thumbnail's length is not known");
    }
}
