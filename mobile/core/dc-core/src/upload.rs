//! Uploading (P1 design §5.8, SPEC D22/D23): the phone sends every byte to
//! Telegram itself — the original, byte for byte, in 19 MiB parts, each
//! encrypted with its own IV — and gives the worker only the metadata
//! (`clientUpload`). Each part is prepared as a whole request on disk, so the
//! platform's background uploader can send it as it is (D22); the foreground
//! sends the same file. A journal per upload records what Telegram accepted:
//! a resume never sends a part twice. An upload belongs to the account that
//! began it: it stops if another account signs in, and its files go.

use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime};

use base64::Engine;
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

use crate::chunk_plan::{PART_SIZE, part_count};
use crate::crypto::Key;
use crate::telegram::{Sent, Telegram};
use crate::worker::Worker;
use crate::{Core, CoreError};

/// Prepared parts waiting on disk at most (C7; the background window is P2's).
const WAITING: usize = 2;
/// Bytes AES-GCM adds to a part: its IV and tag.
const SEAL: u64 = 12 + 16;

/// One file to back up. The pictures, thumbhash and EXIF are made by the
/// app's image engine (D23); the core sends everything.
pub struct UploadRequest {
    /// The original, sent byte for byte.
    pub path: PathBuf,
    pub file_name: String,
    pub mime: String,
    pub created_at: String,
    pub modified_at: String,
    /// Required: a creation retried after an unrecorded success then finds
    /// the asset the worker already made.
    pub device_asset_id: String,
    pub device_id: String,
    pub width: u32,
    pub height: u32,
    pub duration: Option<String>,
    pub favorite: bool,
    pub live_photo_video_id: Option<String>,
    /// The grid's JPEG.
    pub thumbnail: Option<Vec<u8>>,
    /// A larger JPEG for viewers that cannot show the original (HEIC/RAW on
    /// the website).
    pub preview: Option<Vec<u8>>,
    pub thumbhash: Option<String>,
    /// The worker's `PhotoExif` shape.
    pub exif: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Uploaded {
    pub asset_id: String,
    /// The library already had these bytes: nothing was sent.
    pub duplicate: bool,
}

pub enum Begun {
    Duplicate(Uploaded),
    Job(Box<UploadJob>),
}

/// An upload under way; its state lives in its journal. Tied to the account
/// it began under (its worker and bot), and the only one for its file.
pub struct UploadJob {
    request: UploadRequest,
    dir: PathBuf,
    size: u64,
    modified: Option<SystemTime>,
    parts: u64,
    key: Option<Arc<Key>>,
    worker: Arc<Worker>,
    telegram: Arc<Telegram>,
    journal: Mutex<Journal>,
    uploading: Arc<Mutex<HashSet<PathBuf>>>,
}

impl Drop for UploadJob {
    fn drop(&mut self) {
        lock(&self.uploading).remove(&self.dir);
    }
}

/// What Telegram accepted for one upload. No secrets.
#[derive(Serialize, Deserialize, Default)]
struct Journal {
    checksum: String,
    /// The fingerprint of the key the parts were encrypted with.
    key: Option<String>,
    /// The random name the parts go by (C3).
    name: String,
    parts: Vec<Stored>,
    thumbnail: Option<Stored>,
    preview: Option<Stored>,
    /// Asked the worker to make the asset: it may exist and point at these
    /// parts, so from here nothing listed is ever taken out of the channel.
    #[serde(default)]
    creating: bool,
}

#[derive(Serialize, Deserialize, Clone, PartialEq)]
struct Stored {
    index: u64,
    message_id: i64,
    file_id: String,
}

/// A part ready for the platform uploader (D22): send the file at
/// `body_path` to `address()` as it is, with `content_type`. No `Debug`:
/// the address holds the bot token.
pub struct PartToSend {
    pub index: u64,
    pub body_path: PathBuf,
    pub content_type: String,
    address: String,
}

impl PartToSend {
    pub fn address(&self) -> &str {
        &self.address
    }
}

impl UploadJob {
    /// Parts Telegram has not accepted yet, in order.
    pub fn pending(&self) -> Vec<u64> {
        let journal = lock(&self.journal);
        (0..self.parts)
            .filter(|i| !journal.parts.iter().any(|p| p.index == *i))
            .collect()
    }

    /// The name part `index` is sent under (C3: random when encrypted).
    pub(crate) fn part_name(&self, index: u64) -> String {
        let journal = lock(&self.journal);
        match (&self.key, self.parts) {
            (Some(_), _) => format!("{}.part{:03}", journal.name, index + 1),
            (None, 1) => crate::telegram::clean_name(&self.request.file_name),
            (None, _) => format!(
                "{}.part{:03}",
                crate::telegram::clean_name(&self.request.file_name),
                index + 1
            ),
        }
    }

    /// The size of part `index` as Telegram stores it.
    pub(crate) fn document_len(&self, index: u64) -> u64 {
        let plain = self.size.saturating_sub(index * PART_SIZE).min(PART_SIZE);
        plain + if self.key.is_some() { SEAL } else { 0 }
    }

    fn body_path(&self, index: u64) -> PathBuf {
        self.dir.join(format!("{index}.body"))
    }

    fn save(&self, journal: &Journal) -> Result<(), CoreError> {
        let json = serde_json::to_vec(journal)
            .map_err(|e| CoreError::Internal(format!("journal: {e}")))?;
        write_atomically(&self.dir.join("journal.json"), &json)
    }
}

impl Core {
    /// Backs one file up, in the foreground: everything below, in order.
    /// Dropping the future stops it; calling again resumes it.
    pub async fn upload(&self, request: UploadRequest) -> Result<Uploaded, CoreError> {
        let job = match self.begin_upload(request).await? {
            Begun::Duplicate(done) => return Ok(done),
            Begun::Job(job) => *job,
        };
        let scheduler = self.scheduler().await?;
        for index in job.pending() {
            let part = self.part(&job, index).await?;
            let path = part.body_path.clone();
            let body = self
                .handle()
                .spawn_blocking(move || std::fs::read(path))
                .await
                .map_err(|_| CoreError::Internal("reading a part stopped".to_owned()))?
                .map_err(|e| CoreError::Internal(format!("cannot read a prepared part: {e}")))?;
            let _slot = scheduler.send_slot().await?; // one part at a time (1.4)
            self.signed_in_as(&job.worker)?;
            let body = Bytes::from(body);
            let sent = with_retries(|| job.telegram.send_request(body.clone(), &part.content_type))
                .await?;
            self.record(&job, index, sent).await?;
        }
        self.finish_upload(job).await
    }

    /// The checksum, the library's dedupe, the encryption check, and the
    /// journal (resumed, or started over when the file or the key changed).
    pub async fn begin_upload(&self, request: UploadRequest) -> Result<Begun, CoreError> {
        if request.device_asset_id.is_empty() || request.device_id.is_empty() {
            return Err(CoreError::Internal(
                "an upload needs its device ids".to_owned(),
            ));
        }
        // The account it belongs to, for all of it.
        let worker = self.worker()?;
        let telegram = self.telegram().await?;
        self.signed_in_as(&worker)?;
        let dir = uploads_dir(self.data_dir(), &worker).join(job_id(&request));
        if !lock(self.uploading()).insert(dir.clone()) {
            return Err(CoreError::Internal(
                "this file is already being uploaded".to_owned(),
            ));
        }
        // From here the slot is released by `UploadJob`'s drop, or below.
        let release = |e: CoreError| {
            lock(self.uploading()).remove(&dir);
            e
        };
        let path = request.path.clone();
        let file = self
            .handle()
            .spawn_blocking(move || checksum(&path))
            .await
            .map_err(|_| release(CoreError::Internal("the checksum stopped".to_owned())))?
            .map_err(|e| release(CoreError::Internal(format!("cannot read the file: {e}"))))?;
        let (checksum, size, modified) = file;
        let mut journal: Journal = std::fs::read(dir.join("journal.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        // The same SHA-1 both ways: the website stores it as hex, the Immich
        // app (and this core) as base64, and the worker compares them as text.
        let hex = base64::engine::general_purpose::STANDARD
            .decode(&checksum)
            .map(|digest| crate::disk_cache::hex(&digest))
            .unwrap_or_default();
        let items = [
            (request.device_asset_id.clone(), checksum.clone()),
            (request.device_asset_id.clone(), hex),
        ];
        let check = worker.clone();
        let checks = self
            .run(async move { check.bulk_upload_check(&items).await })
            .await?
            .map_err(release)?;
        if let Some(check) = checks.iter().find(|c| !c.accepted()) {
            // Stored already. Unless that is our own asset (`creating`), what
            // an earlier attempt sent is of no use.
            if !journal.creating {
                discard(&telegram, &journal).await;
            }
            let _ = std::fs::remove_dir_all(&dir);
            lock(self.uploading()).remove(&dir);
            return Ok(Begun::Duplicate(Uploaded {
                asset_id: check.asset_id.clone().unwrap_or_default(),
                duplicate: true,
            }));
        }
        let encryption = self.encryption().await.map_err(release)?;
        if encryption.enabled && encryption.key.is_none() {
            // Never a plaintext upload into a library meant to be encrypted.
            return Err(release(CoreError::NotProvisioned));
        }
        let fingerprint = encryption.key.as_ref().map(|k| k.fingerprint());
        if journal.checksum != checksum || journal.key != fingerprint {
            // Another file or another key: what was sent cannot be used —
            // take it out of the channel (unless an asset may point at it),
            // and start over.
            if !journal.creating {
                discard(&telegram, &journal).await;
            }
            let _ = std::fs::remove_dir_all(&dir);
            let mut random = [0u8; 8];
            getrandom::fill(&mut random)
                .map_err(|_| release(CoreError::Internal("no random numbers".to_owned())))?;
            journal = Journal {
                checksum,
                key: fingerprint,
                name: crate::disk_cache::hex(&random),
                ..Journal::default()
            };
        }
        std::fs::create_dir_all(&dir)
            .map_err(|e| release(CoreError::Internal(format!("cannot keep the upload: {e}"))))?;
        let job = UploadJob {
            parts: part_count(size).max(1),
            request,
            dir: dir.clone(),
            size,
            modified,
            key: encryption.key,
            worker,
            telegram,
            journal: Mutex::new(Journal::default()),
            uploading: self.uploading().clone(),
        };
        job.save(&journal)?;
        *lock(&job.journal) = journal;
        Ok(Begun::Job(Box::new(job)))
    }

    /// Prepares part `index` as a whole `sendDocument` request on disk.
    pub async fn part(&self, job: &UploadJob, index: u64) -> Result<PartToSend, CoreError> {
        self.signed_in_as(&job.worker)?;
        if index >= job.parts {
            return Err(CoreError::Internal("no such part".to_owned()));
        }
        let body_path = job.body_path(index);
        let waiting = std::fs::read_dir(&job.dir)
            .map(|d| {
                d.flatten()
                    .filter(|e| e.path().extension().is_some_and(|x| x == "body"))
                    .count()
            })
            .unwrap_or_default();
        if waiting >= WAITING && !body_path.exists() {
            return Err(CoreError::Internal(
                "parts are already waiting to be sent".to_owned(),
            ));
        }
        let name = job.part_name(index);
        let (path, key, size, modified) = (
            job.request.path.clone(),
            job.key.clone(),
            job.size,
            job.modified,
        );
        let (telegram, target) = (job.telegram.clone(), body_path.clone());
        let content_type = self
            .handle()
            .spawn_blocking(move || -> Result<String, CoreError> {
                // The file read now must be the one checksummed at the start.
                let now = std::fs::metadata(&path)
                    .map_err(|e| CoreError::Internal(format!("cannot read the file: {e}")))?;
                if now.len() != size || now.modified().ok() != modified {
                    return Err(CoreError::Internal(
                        "the file changed during its upload; it starts over".to_owned(),
                    ));
                }
                let slice = read_part(&path, index)
                    .map_err(|e| CoreError::Internal(format!("cannot read the file: {e}")))?;
                let bytes = match key {
                    Some(key) => crate::crypto::encrypt_part(&key, &slice)?,
                    None => slice,
                };
                let (body, content_type) = telegram.document_request(&name, &bytes)?;
                write_atomically(&target, &body)?;
                Ok(content_type)
            })
            .await
            .map_err(|_| CoreError::Internal("preparing a part stopped".to_owned()))??;
        Ok(PartToSend {
            index,
            body_path,
            content_type,
            address: job.telegram.document_address(),
        })
    }

    /// Telegram's answer to a part the platform uploader sent (D22). It must
    /// be for this part: its index, name and size.
    pub async fn part_sent(
        &self,
        job: &UploadJob,
        index: u64,
        answer: &[u8],
    ) -> Result<(), CoreError> {
        let answered = crate::telegram::sent_from(answer)?;
        let ours = index < job.parts
            && answered.name.as_deref() == Some(job.part_name(index).as_str())
            && answered.size == Some(job.document_len(index));
        if !ours {
            return Err(CoreError::Internal("an answer for another part".to_owned()));
        }
        self.record(job, index, answered.sent).await
    }

    async fn record(&self, job: &UploadJob, index: u64, sent: Sent) -> Result<(), CoreError> {
        self.signed_in_as(&job.worker)?;
        let stray = {
            let mut journal = lock(&job.journal);
            match journal.parts.iter().find(|p| p.index == index) {
                Some(known) if known.file_id == sent.file_id => None, // told twice
                Some(_) => Some(sent.message_id),                     // sent twice
                None => {
                    journal.parts.push(Stored {
                        index,
                        message_id: sent.message_id,
                        file_id: sent.file_id,
                    });
                    job.save(&journal)?;
                    None
                }
            }
        };
        // Recorded first, then the body goes: a crash in between leaves a
        // file to remove, never a sent part the journal does not know.
        let _ = std::fs::remove_file(job.body_path(index));
        if let Some(message_id) = stray {
            let _ = job.telegram.delete_message(message_id).await;
        }
        Ok(())
    }

    /// The thumbnail and preview (sent by the core, D23), then the asset —
    /// metadata only — then the upload's files go.
    pub async fn finish_upload(&self, job: UploadJob) -> Result<Uploaded, CoreError> {
        if !job.pending().is_empty() {
            return Err(CoreError::Internal("parts are still to be sent".to_owned()));
        }
        for preview in [false, true] {
            let picture = if preview {
                &job.request.preview
            } else {
                &job.request.thumbnail
            };
            let done = {
                let journal = lock(&job.journal);
                if preview {
                    journal.preview.is_some()
                } else {
                    journal.thumbnail.is_some()
                }
            };
            let Some(jpeg) = picture.as_ref().filter(|_| !done) else {
                continue;
            };
            let _slot = self.scheduler().await?.send_slot().await?; // like a part
            self.signed_in_as(&job.worker)?;
            let telegram = &job.telegram;
            let sent = match (&job.key, preview) {
                (Some(key), _) => {
                    let name = if preview { "preview.bin" } else { "thumb.bin" };
                    let sealed = crate::crypto::encrypt_part(key, jpeg)?;
                    with_retries(|| telegram.send_document(name, sealed.clone())).await?
                }
                // As the website: a plain thumbnail is a photo; a preview a
                // document, so Telegram does not recompress it.
                (None, false) => with_retries(|| telegram.send_photo(jpeg.clone())).await?,
                (None, true) => {
                    with_retries(|| telegram.send_document("preview.jpg", jpeg.clone())).await?
                }
            };
            let mut journal = lock(&job.journal);
            let stored = Some(Stored {
                index: 0,
                message_id: sent.message_id,
                file_id: sent.file_id,
            });
            if preview {
                journal.preview = stored;
            } else {
                journal.thumbnail = stored;
            }
            job.save(&journal)?;
        }
        let fields = fields(&job)?;
        self.signed_in_as(&job.worker)?;
        {
            let mut journal = lock(&job.journal);
            journal.creating = true;
            job.save(&journal)?;
        }
        let worker = job.worker.clone();
        let asset_id = self
            .run(async move { worker.create_asset(fields).await })
            .await??;
        let _ = std::fs::remove_dir_all(&job.dir);
        if let Some(account) = job.dir.parent() {
            let _ = std::fs::remove_dir(account); // only when no other upload is left
        }
        Ok(Uploaded {
            asset_id,
            duplicate: false,
        })
    }
}

/// Takes what an abandoned attempt sent out of the channel (best effort).
async fn discard(telegram: &Telegram, journal: &Journal) {
    let sent = journal
        .parts
        .iter()
        .chain(&journal.thumbnail)
        .chain(&journal.preview);
    for message_id in sent.map(|s| s.message_id).collect::<Vec<_>>() {
        let _ = telegram.delete_message(message_id).await;
    }
}

/// A send again after a rate limit (the client waits first) or, with
/// growing pauses, after network trouble; a refusal ends it.
async fn with_retries<F, Fut>(mut send: F) -> Result<Sent, CoreError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<Sent, CoreError>>,
{
    let (mut limits, mut waits) = (0, [1, 2, 4].into_iter());
    loop {
        match send().await {
            Err(CoreError::RateLimited { .. }) if limits < 5 => limits += 1,
            Err(e @ CoreError::Network(_)) => match waits.next() {
                Some(seconds) => tokio::time::sleep(Duration::from_secs(seconds)).await,
                None => return Err(e),
            },
            other => return other,
        }
    }
}

/// The worker's names (`clientUpload`), as the website sends them, plus the
/// preview and EXIF (D23).
fn fields(job: &UploadJob) -> Result<Vec<(&'static str, String)>, CoreError> {
    let journal = lock(&job.journal);
    let r = &job.request;
    let mut parts = journal.parts.clone();
    parts.sort_by_key(|p| p.index);
    let chunks =
        serde_json::to_string(&parts).map_err(|e| CoreError::Internal(format!("parts: {e}")))?;
    let original = match parts.as_slice() {
        [one] => one.file_id.clone(),
        _ => String::new(),
    };
    let id = |s: &Option<Stored>| s.as_ref().map(|s| s.file_id.clone()).unwrap_or_default();
    let encrypted = job.key.is_some();
    let mut fields = vec![
        ("clientUpload", "true".to_owned()),
        ("telegramChunks", chunks),
        ("telegramOriginalId", original),
        ("telegramThumbId", id(&journal.thumbnail)),
        ("telegramPreviewId", id(&journal.preview)),
        (
            "thumbEncrypted",
            (encrypted && journal.thumbnail.is_some()).to_string(),
        ),
        (
            "encryptionMode",
            if encrypted { "server" } else { "off" }.to_owned(),
        ),
        ("fileName", r.file_name.clone()),
        ("fileSize", job.size.to_string()),
        ("mimeType", r.mime.clone()),
        ("checksum", journal.checksum.clone()),
        ("fileCreatedAt", r.created_at.clone()),
        ("fileModifiedAt", r.modified_at.clone()),
        ("deviceAssetId", r.device_asset_id.clone()),
        ("deviceId", r.device_id.clone()),
        ("width", r.width.to_string()),
        ("height", r.height.to_string()),
        ("isFavorite", r.favorite.to_string()),
    ];
    let optional = [
        ("duration", r.duration.clone()),
        ("livePhotoVideoId", r.live_photo_video_id.clone()),
        ("thumbhash", r.thumbhash.clone()),
        ("exif", r.exif.as_ref().map(serde_json::Value::to_string)),
        // Until worker release W2 reads `exif`, location comes only from these.
        ("latitude", coordinate(r, "latitude")),
        ("longitude", coordinate(r, "longitude")),
    ];
    fields.extend(
        optional
            .into_iter()
            .filter_map(|(name, value)| Some((name, value?))),
    );
    Ok(fields)
}

fn coordinate(request: &UploadRequest, name: &str) -> Option<String> {
    request
        .exif
        .as_ref()?
        .get(name)?
        .as_f64()
        .map(|v| v.to_string())
}

/// base64 SHA-1 of the whole file (what the worker dedupes on), its size
/// and modified time — read in 1 MiB pieces so a video never sits in memory.
pub(crate) fn checksum(path: &Path) -> std::io::Result<(String, u64, Option<SystemTime>)> {
    let mut file = std::fs::File::open(path)?;
    let modified = file.metadata()?.modified().ok();
    let (mut hasher, mut size, mut buffer) = (Sha1::new(), 0u64, vec![0u8; 1 << 20]);
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(buffer.get(..n).unwrap_or_default());
        size += n as u64;
    }
    Ok((
        base64::engine::general_purpose::STANDARD.encode(hasher.finalize()),
        size,
        modified,
    ))
}

fn read_part(path: &Path, index: u64) -> std::io::Result<Vec<u8>> {
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(index * PART_SIZE))?;
    let mut slice = Vec::new();
    file.take(PART_SIZE).read_to_end(&mut slice)?;
    Ok(slice)
}

/// Each account's uploads apart (another account never resumes them).
fn uploads_dir(data_dir: &Path, worker: &Worker) -> PathBuf {
    let session = worker.session();
    let account = sha2::Sha256::new()
        .chain_update(session.user_id.as_bytes())
        .chain_update(b"\n")
        .chain_update(session.worker_url.as_bytes())
        .finalize();
    data_dir
        .join("uploads")
        .join(crate::disk_cache::hex(&account))
}

/// One folder per file to back up, named so the same file always finds it.
fn job_id(request: &UploadRequest) -> String {
    let id = sha2::Sha256::new()
        .chain_update(request.device_id.as_bytes())
        .chain_update(b"\n")
        .chain_update(request.device_asset_id.as_bytes())
        .finalize();
    crate::disk_cache::hex(&id)
}

/// Written to a temporary file of its own, flushed to disk, then renamed:
/// a crash or a power cut leaves the old file or the new one, never half.
fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), CoreError> {
    let failed = |e: std::io::Error| CoreError::Internal(format!("cannot keep the upload: {e}"));
    let mut random = [0u8; 8];
    getrandom::fill(&mut random)
        .map_err(|_| CoreError::Internal("no random numbers".to_owned()))?;
    let tmp = path.with_extension(format!("{}.tmp", crate::disk_cache::hex(&random)));
    let written = std::fs::File::create(&tmp)
        .and_then(|mut file| file.write_all(bytes).and_then(|()| file.sync_all()))
        .and_then(|()| std::fs::rename(&tmp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written.map_err(failed)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk_plan::PART_SIZE;
    use crate::core::tests::library;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

    const PASSWORD: &str = "correct horse battery staple";
    const SALT: &str = "c2FsdC1zYWx0LXNhbHQhIQ==";

    /// Telegram's answer to a send: message n, file `f<n>`.
    struct Sends(AtomicU64);
    impl Respond for Sends {
        fn respond(&self, _: &Request) -> ResponseTemplate {
            let n = self.0.fetch_add(1, Ordering::SeqCst) + 1;
            ResponseTemplate::new(200).set_body_json(json!({"ok": true, "result": {
                "message_id": n, "document": {"file_id": format!("f{n}")},
                "photo": [{"file_id": format!("small{n}")}, {"file_id": format!("f{n}")}]}}))
        }
    }

    /// A signed-in core (encryption on or off) whose worker and bot take uploads.
    async fn uploader(encryption: bool, duplicate: bool) -> (MockServer, Core, tempfile::TempDir) {
        let (server, core, dir) = library(json!({}), encryption, vec![], 0).await;
        let check = if duplicate {
            json!({"results": [{"id": "dev-asset-1", "action": "reject", "reason": "duplicate", "assetId": "existing"}]})
        } else {
            json!({"results": [{"id": "dev-asset-1", "action": "accept"}]})
        };
        Mock::given(path("/api/assets/bulk-upload-check"))
            .respond_with(ResponseTemplate::new(200).set_body_json(check))
            .mount(&server)
            .await;
        for route in ["/bot1:A/sendDocument", "/bot1:A/sendPhoto"] {
            Mock::given(path(route))
                .respond_with(Sends(AtomicU64::new(0)))
                .mount(&server)
                .await;
        }
        Mock::given(method("POST"))
            .and(path("/api/assets"))
            .respond_with(
                ResponseTemplate::new(201)
                    .set_body_json(json!({"id": "new-asset", "status": "created"})),
            )
            .mount(&server)
            .await;
        (server, core, dir)
    }

    fn request(file: &Path) -> UploadRequest {
        UploadRequest {
            path: file.to_owned(),
            file_name: "IMG_0001.HEIC".into(),
            mime: "image/heic".into(),
            created_at: "2026-01-02T03:04:05.000Z".into(),
            modified_at: "2026-01-02T03:04:06.000Z".into(),
            device_asset_id: "dev-asset-1".into(),
            device_id: "phone-1".into(),
            width: 4032,
            height: 3024,
            duration: Some("0:00:01.000000".into()),
            favorite: false,
            live_photo_video_id: Some("live-1".into()),
            thumbnail: Some(b"thumb-jpeg".to_vec()),
            preview: Some(b"preview-jpeg".to_vec()),
            thumbhash: Some("hash".into()),
            exif: Some(json!({"make": "Apple", "iso": 50, "latitude": 41.3, "longitude": 69.2})),
        }
    }

    fn file_of(dir: &tempfile::TempDir, len: usize) -> PathBuf {
        let file = dir.path().join("original.heic");
        let bytes: Vec<u8> = (0..len).map(|i| u8::try_from(i % 251).unwrap()).collect();
        std::fs::write(&file, bytes).unwrap();
        file
    }

    /// The requests sent to a path, in order.
    async fn sent(server: &MockServer, route: &str) -> Vec<Request> {
        server
            .received_requests()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|r| r.url.path() == route)
            .collect()
    }

    /// A multipart field: its file name (if any) and its bytes.
    fn field(request: &Request, name: &str) -> Option<(Option<String>, Vec<u8>)> {
        let kind = request.headers.get("content-type")?.to_str().ok()?;
        let boundary = format!("--{}", kind.split("boundary=").nth(1)?.trim_matches('"'));
        let body = &request.body;
        let marker = format!("name=\"{name}\"");
        let at = body
            .windows(marker.len())
            .position(|w| w == marker.as_bytes())?;
        let head_end = at + body[at..].windows(4).position(|w| w == b"\r\n\r\n")?;
        let head = String::from_utf8_lossy(&body[at..head_end]).into_owned();
        let filename = head
            .split("filename=\"")
            .nth(1)
            .and_then(|f| f.split('"').next())
            .map(str::to_owned);
        let start = head_end + 4;
        let end = start
            + body[start..]
                .windows(boundary.len() + 2)
                .position(|w| w == format!("\r\n{boundary}").as_bytes())?;
        Some((filename, body[start..end].to_vec()))
    }

    fn text(request: &Request, name: &str) -> String {
        String::from_utf8(field(request, name).map(|f| f.1).unwrap_or_default()).unwrap()
    }

    /// Telegram's answer for part `index` of `job`, as the platform uploader hands it back.
    fn answer(job: &UploadJob, index: u64, message_id: i64, file_id: &str) -> Vec<u8> {
        let document = json!({"file_id": file_id, "file_name": job.part_name(index), "file_size": job.document_len(index)});
        serde_json::to_vec(
            &json!({"ok": true, "result": {"message_id": message_id, "document": document}}),
        )
        .unwrap()
    }

    fn open(sealed: Vec<u8>) -> Vec<u8> {
        let key = crate::crypto::derive_key(PASSWORD, SALT).unwrap();
        crate::crypto::decrypt_part(&key, sealed).unwrap().to_vec()
    }

    #[test]
    fn the_checksum_is_base64_sha1_of_the_whole_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("f");
        std::fs::write(&file, b"hello").unwrap();
        let (sum, size, _) = checksum(&file).unwrap();
        assert_eq!((sum.as_str(), size), ("qvTGHdzF6KLavt4PO0gs2a6pQ00=", 5));
    }

    #[tokio::test]
    async fn a_file_already_stored_sends_nothing() {
        let (server, core, dir) = uploader(true, true).await;
        let done = core.upload(request(&file_of(&dir, 10))).await.unwrap();
        assert_eq!((done.asset_id.as_str(), done.duplicate), ("existing", true));
        assert!(sent(&server, "/bot1:A/sendDocument").await.is_empty());
        assert!(
            sent(&server, "/api/assets")
                .await
                .iter()
                .all(|r| r.method.as_str() != "POST")
        );
    }

    #[tokio::test]
    async fn a_file_the_website_stored_is_a_duplicate_too() {
        // The website stores hex SHA-1, the Immich app base64 (1.8 Gate 2).
        let (server, core, dir) = uploader(true, false).await;
        let file = file_of(&dir, 10);
        let hex = crate::disk_cache::hex(&Sha1::digest(std::fs::read(&file).unwrap()));
        Mock::given(path("/api/assets/bulk-upload-check"))
            .and(wiremock::matchers::body_string_contains(hex.as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"results": [
                {"id": "dev-asset-1", "action": "accept"},
                {"id": "dev-asset-1", "action": "reject", "assetId": "from-the-website"},
            ]})))
            .with_priority(1)
            .mount(&server)
            .await;
        let done = core.upload(request(&file)).await.unwrap();
        assert_eq!(
            (done.asset_id.as_str(), done.duplicate),
            ("from-the-website", true)
        );
        assert!(sent(&server, "/bot1:A/sendDocument").await.is_empty());
        // Still asked as base64 too: the app's and the worker's own uploads.
        let base64 = base64::engine::general_purpose::STANDARD
            .encode(Sha1::digest(std::fs::read(&file).unwrap()));
        let checks = sent(&server, "/api/assets/bulk-upload-check").await;
        assert!(
            checks
                .iter()
                .all(|r| String::from_utf8_lossy(&r.body).contains(&base64))
        );
        assert!(!checks.is_empty());
    }

    #[tokio::test]
    async fn an_encrypted_upload_sends_every_byte_itself_and_the_worker_only_metadata() {
        let (server, core, dir) = uploader(true, false).await;
        let size = usize::try_from(PART_SIZE).unwrap() + 10;
        let file = file_of(&dir, size);
        let original = std::fs::read(&file).unwrap();
        let done = core.upload(request(&file)).await.unwrap();
        assert_eq!(
            (done.asset_id.as_str(), done.duplicate),
            ("new-asset", false)
        );
        let docs = sent(&server, "/bot1:A/sendDocument").await;
        assert_eq!(docs.len(), 4, "two parts, the thumbnail, the preview");
        let mut stored = vec![];
        for (n, request) in docs.iter().take(2).enumerate() {
            let (name, bytes) = field(request, "document").unwrap();
            let name = name.unwrap();
            assert!(
                name.len() == 24 && name.ends_with(&format!(".part{:03}", n + 1)),
                "{name}"
            );
            assert!(
                name[..16].bytes().all(|b| b.is_ascii_hexdigit()),
                "{name}: random, not the file's name"
            );
            assert_eq!(text(request, "chat_id"), "-1");
            stored.extend(open(bytes));
        }
        assert_eq!(stored, original, "the original, byte for byte");
        let (thumb_name, thumb) = field(&docs[2], "document").unwrap();
        let (preview_name, preview) = field(&docs[3], "document").unwrap();
        assert_eq!(
            (thumb_name.unwrap(), open(thumb)),
            ("thumb.bin".to_owned(), b"thumb-jpeg".to_vec())
        );
        assert_eq!(
            (preview_name.unwrap(), open(preview)),
            ("preview.bin".to_owned(), b"preview-jpeg".to_vec())
        );
        let created = sent(&server, "/api/assets").await;
        let created = created
            .iter()
            .find(|r| r.method.as_str() == "POST")
            .unwrap();
        let chunks: serde_json::Value =
            serde_json::from_str(&text(created, "telegramChunks")).unwrap();
        assert_eq!(
            chunks,
            json!([{"index": 0, "message_id": 1, "file_id": "f1"}, {"index": 1, "message_id": 2, "file_id": "f2"}])
        );
        for (name, value) in [
            ("clientUpload", "true"),
            ("telegramOriginalId", ""),
            ("telegramThumbId", "f3"),
            ("telegramPreviewId", "f4"),
            ("thumbEncrypted", "true"),
            ("encryptionMode", "server"),
            ("fileName", "IMG_0001.HEIC"),
            ("fileSize", &size.to_string()),
            ("mimeType", "image/heic"),
            ("deviceAssetId", "dev-asset-1"),
            ("deviceId", "phone-1"),
            ("fileCreatedAt", "2026-01-02T03:04:05.000Z"),
            ("width", "4032"),
            ("isFavorite", "false"),
            ("thumbhash", "hash"),
            ("height", "3024"),
            ("fileModifiedAt", "2026-01-02T03:04:06.000Z"),
            ("duration", "0:00:01.000000"),
            ("livePhotoVideoId", "live-1"),
            ("latitude", "41.3"),
            ("longitude", "69.2"),
        ] {
            assert_eq!(text(created, name), value, "{name}");
        }
        assert_eq!(text(created, "checksum"), checksum(&file).unwrap().0);
        let exif: serde_json::Value = serde_json::from_str(&text(created, "exif")).unwrap();
        assert_eq!(
            exif,
            json!({"make": "Apple", "iso": 50, "latitude": 41.3, "longitude": 69.2})
        );
        let routes = server.received_requests().await.unwrap_or_default();
        assert!(
            routes.iter().all(|r| !r.url.path().ends_with("/thumbnail")),
            "no worker picture route (D23)"
        );
        let uploads = core.config().data_dir.join("uploads");
        assert!(
            std::fs::read_dir(&uploads).map_or(true, |mut d| d.next().is_none()),
            "nothing left on disk"
        );
    }

    #[tokio::test]
    async fn a_plain_library_keeps_names_and_one_part_is_the_original() {
        let (server, core, dir) = uploader(false, false).await;
        core.upload(request(&file_of(&dir, 10))).await.unwrap();
        let docs = sent(&server, "/bot1:A/sendDocument").await;
        let (name, bytes) = field(&docs[0], "document").unwrap();
        assert_eq!(
            (name.unwrap().as_str(), bytes.len()),
            ("IMG_0001.HEIC", 10),
            "as the website: real name, plain bytes"
        );
        assert_eq!(
            sent(&server, "/bot1:A/sendPhoto").await.len(),
            1,
            "a plain thumbnail is a photo"
        );
        let created = sent(&server, "/api/assets").await;
        let created = created
            .iter()
            .find(|r| r.method.as_str() == "POST")
            .unwrap();
        assert_eq!(text(created, "telegramOriginalId"), "f1");
        assert_eq!(
            (
                text(created, "encryptionMode").as_str(),
                text(created, "thumbEncrypted").as_str()
            ),
            ("off", "false")
        );
    }

    #[tokio::test]
    async fn a_part_handed_out_is_a_whole_request_and_a_resume_sends_nothing_twice() {
        let (server, core, dir) = uploader(true, false).await;
        let file = file_of(&dir, usize::try_from(PART_SIZE).unwrap() + 10);
        let Begun::Job(job) = core.begin_upload(request(&file)).await.unwrap() else {
            panic!("not a new upload")
        };
        assert_eq!(job.pending(), vec![0, 1]);
        let part = core.part(&job, 0).await.unwrap();
        let body = std::fs::read(&part.body_path).unwrap();
        assert!(
            part.content_type
                .starts_with("multipart/form-data; boundary=")
        );
        assert!(part.address().ends_with("/bot1:A/sendDocument"));
        let whole = String::from_utf8_lossy(&body);
        assert!(
            whole.contains("name=\"chat_id\"") && whole.contains("name=\"document\"; filename=\"")
        );
        let answer = answer(&job, 0, 90, "bg0");
        core.part_sent(&job, 0, &answer).await.unwrap();
        core.part_sent(&job, 0, &answer).await.unwrap(); // the OS told us twice
        assert!(!part.body_path.exists(), "a sent part leaves the disk");
        drop(job); // the app was closed
        core.upload(request(&file)).await.unwrap();
        assert_eq!(
            sent(&server, "/bot1:A/sendDocument").await.len(),
            3,
            "part 1, the thumbnail, the preview"
        );
        let created = sent(&server, "/api/assets").await;
        let created = created
            .iter()
            .find(|r| r.method.as_str() == "POST")
            .unwrap();
        let chunks: serde_json::Value =
            serde_json::from_str(&text(created, "telegramChunks")).unwrap();
        assert_eq!(
            chunks[0],
            json!({"index": 0, "message_id": 90, "file_id": "bg0"})
        );
    }

    #[tokio::test]
    async fn a_second_copy_and_a_changed_file_leave_no_strays_in_the_channel() {
        let (server, core, dir) = uploader(true, false).await;
        Mock::given(path("/bot1:A/deleteMessage"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"ok": true, "result": true})),
            )
            .expect(2)
            .mount(&server)
            .await;
        let file = file_of(&dir, 10);
        let Begun::Job(job) = core.begin_upload(request(&file)).await.unwrap() else {
            panic!("not a new upload")
        };
        core.part_sent(&job, 0, &answer(&job, 0, 7, "a"))
            .await
            .unwrap();
        // The OS sent the part twice: the copy goes.
        core.part_sent(&job, 0, &answer(&job, 0, 8, "b"))
            .await
            .unwrap();
        drop(job);
        std::fs::write(&file, b"different, and longer").unwrap(); // edited before the upload finished
        let Begun::Job(job) = core.begin_upload(request(&file)).await.unwrap() else {
            panic!("not a new upload")
        };
        assert_eq!(job.pending(), vec![0], "started over; the old part deleted");
        let deleted: Vec<String> = sent(&server, "/bot1:A/deleteMessage")
            .await
            .iter()
            .map(|r| String::from_utf8_lossy(&r.body).into_owned())
            .collect();
        assert!(
            deleted[0].contains("\"message_id\":8") && deleted[1].contains("\"message_id\":7"),
            "{deleted:?}"
        );
    }

    #[tokio::test]
    async fn encryption_switched_on_but_unfinished_uploads_nothing() {
        let (server, core, dir) = uploader(true, false).await;
        Mock::given(path("/api/server/zke-config"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"enabled": true, "password": "", "salt": ""})),
            )
            .with_priority(1)
            .mount(&server)
            .await;
        let err = core.upload(request(&file_of(&dir, 10))).await.unwrap_err();
        assert!(matches!(err, CoreError::NotProvisioned), "{err}");
        assert!(
            sent(&server, "/bot1:A/sendDocument").await.is_empty(),
            "never a plaintext upload by accident"
        );
    }

    #[tokio::test]
    async fn a_rate_limit_waits_and_a_refusal_stops_with_the_journal_kept() {
        let (server, core, dir) = uploader(true, false).await;
        Mock::given(path("/bot1:A/sendDocument"))
            .respond_with(ResponseTemplate::new(429).set_body_json(
                json!({"ok": false, "error_code": 429, "parameters": {"retry_after": 1}}),
            ))
            .up_to_n_times(1)
            .with_priority(1)
            .mount(&server)
            .await;
        core.upload(request(&file_of(&dir, 10))).await.unwrap();
        let (server, core, dir) = uploader(true, false).await;
        Mock::given(path("/bot1:A/sendDocument"))
            .respond_with(ResponseTemplate::new(403).set_body_json(
                json!({"ok": false, "error_code": 403, "description": "Forbidden: bot was kicked"}),
            ))
            .with_priority(1)
            .mount(&server)
            .await;
        let err = core.upload(request(&file_of(&dir, 10))).await.unwrap_err();
        assert!(matches!(err, CoreError::TelegramRejected(_)), "{err}");
        let uploads = core.config().data_dir.join("uploads");
        assert!(
            std::fs::read_dir(&uploads).unwrap().next().is_some(),
            "kept, to resume"
        );
    }

    #[tokio::test]
    async fn a_failed_creation_is_retried_with_the_same_parts() {
        let (server, core, dir) = uploader(true, false).await;
        Mock::given(method("POST"))
            .and(path("/api/assets"))
            .respond_with(ResponseTemplate::new(500).set_body_json(json!({"message": "busy"})))
            .up_to_n_times(1)
            .with_priority(1)
            .mount(&server)
            .await;
        let file = file_of(&dir, 10);
        assert!(core.upload(request(&file)).await.is_err());
        let done = core.upload(request(&file)).await.unwrap();
        assert_eq!(done.asset_id, "new-asset");
        assert_eq!(
            sent(&server, "/bot1:A/sendDocument").await.len(),
            3,
            "the part, thumbnail and preview sent once"
        );
    }

    #[tokio::test]
    async fn an_upload_stays_with_the_account_that_began_it() {
        let (_server, core, dir) = uploader(true, false).await;
        let Begun::Job(job) = core
            .begin_upload(request(&file_of(&dir, 10)))
            .await
            .unwrap()
        else {
            panic!("not a new upload")
        };
        let session = core.worker().unwrap().session().clone();
        core.restore(crate::session::Session {
            user_id: "u2".into(),
            ..session
        })
        .unwrap();
        let err = core.part(&job, 0).await.err().unwrap();
        assert!(matches!(err, CoreError::SignedOut), "{err}");
        let uploads = core.config().data_dir.join("uploads");
        assert!(
            !uploads.exists(),
            "another account: the uploads folder goes"
        );
    }

    #[tokio::test]
    async fn encryption_switched_on_meanwhile_is_seen_by_the_next_file() {
        let (server, core, dir) = uploader(false, false).await;
        let file = file_of(&dir, 10);
        let Begun::Job(job) = core.begin_upload(request(&file)).await.unwrap() else {
            panic!("not a new upload")
        };
        assert_eq!(job.part_name(0), "IMG_0001.HEIC", "plain: the real name");
        drop(job);
        Mock::given(path("/api/server/zke-config"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"enabled": true, "password": PASSWORD, "salt": SALT})),
            )
            .with_priority(1)
            .mount(&server)
            .await;
        let Begun::Job(job) = core.begin_upload(request(&file)).await.unwrap() else {
            panic!("not a new upload")
        };
        assert!(
            job.part_name(0).ends_with(".part001") && job.key.is_some(),
            "encrypted from now on"
        );
    }

    #[tokio::test]
    async fn an_answer_must_be_for_its_part() {
        let (server, core, dir) = uploader(true, false).await;
        Mock::given(path("/bot1:A/deleteMessage"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&server)
            .await;
        let Begun::Job(job) = core
            .begin_upload(request(&file_of(&dir, 10)))
            .await
            .unwrap()
        else {
            panic!("not a new upload")
        };
        let good: serde_json::Value = serde_json::from_slice(&answer(&job, 0, 5, "x")).unwrap();
        let mut wrong_name = good.clone();
        wrong_name["result"]["document"]["file_name"] = json!("someone-else.part001");
        let mut wrong_size = good.clone();
        wrong_size["result"]["document"]["file_size"] = json!(9);
        for (index, bad) in [(1, &good), (0, &wrong_name), (0, &wrong_size)] {
            assert!(
                core.part_sent(&job, index, &serde_json::to_vec(bad).unwrap())
                    .await
                    .is_err()
            );
        }
        assert_eq!(job.pending(), vec![0], "nothing recorded");
    }

    #[tokio::test]
    async fn a_file_changed_after_its_checksum_is_not_sent() {
        let (_server, core, dir) = uploader(true, false).await;
        let file = file_of(&dir, 10);
        let Begun::Job(job) = core.begin_upload(request(&file)).await.unwrap() else {
            panic!("not a new upload")
        };
        std::fs::write(&file, b"eleven bytes").unwrap();
        assert!(core.part(&job, 0).await.is_err());
    }

    #[tokio::test]
    async fn one_upload_per_file_at_a_time() {
        let (_server, core, dir) = uploader(true, false).await;
        let file = file_of(&dir, 10);
        let Begun::Job(job) = core.begin_upload(request(&file)).await.unwrap() else {
            panic!("not a new upload")
        };
        assert!(
            core.begin_upload(request(&file)).await.is_err(),
            "the same file twice at once"
        );
        drop(job);
        assert!(core.begin_upload(request(&file)).await.is_ok());
    }

    #[tokio::test]
    async fn a_duplicate_takes_what_was_sent_out_of_the_channel() {
        let (server, core, dir) = uploader(true, false).await;
        Mock::given(path("/bot1:A/deleteMessage"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"ok": true, "result": true})),
            )
            .expect(1)
            .mount(&server)
            .await;
        let file = file_of(&dir, 10);
        let Begun::Job(job) = core.begin_upload(request(&file)).await.unwrap() else {
            panic!("not a new upload")
        };
        core.part_sent(&job, 0, &answer(&job, 0, 3, "early"))
            .await
            .unwrap();
        drop(job);
        Mock::given(path("/api/assets/bulk-upload-check"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                json!({"results": [{"id": "dev-asset-1", "action": "reject", "assetId": "existing"}]}),
            ))
            .with_priority(1)
            .mount(&server)
            .await;
        assert!(matches!(
            core.begin_upload(request(&file)).await.unwrap(),
            Begun::Duplicate(_)
        ));
    }

    #[tokio::test]
    async fn no_more_than_two_parts_wait_on_disk() {
        let (_server, core, dir) = uploader(true, false).await;
        let file = file_of(&dir, 2 * usize::try_from(PART_SIZE).unwrap() + 10);
        let Begun::Job(job) = core.begin_upload(request(&file)).await.unwrap() else {
            panic!("not a new upload")
        };
        core.part(&job, 0).await.unwrap();
        core.part(&job, 1).await.unwrap();
        assert!(core.part(&job, 2).await.is_err(), "C7: two wait at most");
        core.part_sent(&job, 0, &answer(&job, 0, 1, "p0"))
            .await
            .unwrap();
        assert!(core.part(&job, 2).await.is_ok());
    }

    #[tokio::test]
    async fn an_asset_that_may_have_been_made_never_loses_its_parts() {
        let (server, core, dir) = uploader(true, false).await;
        Mock::given(path("/bot1:A/deleteMessage"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&server)
            .await;
        // The worker made the asset, but its answer was lost.
        Mock::given(method("POST"))
            .and(path("/api/assets"))
            .respond_with(ResponseTemplate::new(500))
            .up_to_n_times(1)
            .with_priority(1)
            .mount(&server)
            .await;
        let file = file_of(&dir, 10);
        assert!(core.upload(request(&file)).await.is_err());
        Mock::given(path("/api/assets/bulk-upload-check"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                json!({"results": [{"id": "dev-asset-1", "action": "reject", "assetId": "new-asset"}]}),
            ))
            .with_priority(1)
            .mount(&server)
            .await;
        let done = core.upload(request(&file)).await.unwrap();
        assert_eq!(
            (done.asset_id.as_str(), done.duplicate),
            ("new-asset", true)
        );
    }

    #[tokio::test]
    async fn another_key_starts_over_and_takes_the_old_parts_out() {
        let (server, core, dir) = uploader(true, false).await;
        Mock::given(path("/bot1:A/deleteMessage"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"ok": true, "result": true})),
            )
            .expect(1)
            .mount(&server)
            .await;
        let file = file_of(&dir, 10);
        let Begun::Job(job) = core.begin_upload(request(&file)).await.unwrap() else {
            panic!("not a new upload")
        };
        core.part_sent(&job, 0, &answer(&job, 0, 4, "old"))
            .await
            .unwrap();
        drop(job);
        Mock::given(path("/api/server/zke-config"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"enabled": true, "password": "another", "salt": SALT})),
            )
            .with_priority(1)
            .mount(&server)
            .await;
        let Begun::Job(job) = core.begin_upload(request(&file)).await.unwrap() else {
            panic!("not a new upload")
        };
        assert_eq!(job.pending(), vec![0], "nothing of the old key kept");
    }

    #[tokio::test]
    async fn the_journal_is_written_before_a_body_goes() {
        let (_server, core, dir) = uploader(true, false).await;
        let Begun::Job(job) = core
            .begin_upload(request(&file_of(&dir, 10)))
            .await
            .unwrap()
        else {
            panic!("not a new upload")
        };
        let part = core.part(&job, 0).await.unwrap();
        let journal = job.dir.join("journal.json");
        std::fs::remove_file(&journal).unwrap();
        std::fs::create_dir(&journal).unwrap(); // the journal cannot be written now
        assert!(
            core.part_sent(&job, 0, &answer(&job, 0, 1, "x"))
                .await
                .is_err()
        );
        assert!(
            part.body_path.exists(),
            "not recorded: the body stays, to be sent again"
        );
    }

    #[tokio::test]
    async fn sizes_and_names_are_what_telegram_stores() {
        let (_server, core, dir) = uploader(true, false).await;
        let Begun::Job(job) = core
            .begin_upload(request(&file_of(&dir, 10)))
            .await
            .unwrap()
        else {
            panic!("not a new upload")
        };
        assert_eq!(
            job.document_len(0),
            10 + 12 + 16,
            "the part, its IV and its tag"
        );
        drop(job);
        let (_server, core, dir) = uploader(false, false).await;
        let mut quoted = request(&file_of(&dir, 10));
        quoted.file_name = "IMG\"1.HEIC".into();
        let Begun::Job(job) = core.begin_upload(quoted).await.unwrap() else {
            panic!("not a new upload")
        };
        assert_eq!(
            (job.document_len(0), job.part_name(0).as_str()),
            (10, "IMG_1.HEIC")
        );
        core.part(&job, 0).await.unwrap();
        core.part_sent(&job, 0, &answer(&job, 0, 1, "q"))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_thumbnail_waits_out_a_rate_limit_and_network_trouble_is_retried() {
        let (server, core, dir) = uploader(false, false).await;
        Mock::given(path("/bot1:A/sendPhoto"))
            .respond_with(ResponseTemplate::new(429).set_body_json(
                json!({"ok": false, "error_code": 429, "parameters": {"retry_after": 1}}),
            ))
            .up_to_n_times(1)
            .with_priority(1)
            .mount(&server)
            .await;
        Mock::given(path("/bot1:A/sendDocument"))
            .respond_with(ResponseTemplate::new(502))
            .up_to_n_times(2)
            .with_priority(1)
            .mount(&server)
            .await;
        core.upload(request(&file_of(&dir, 10))).await.unwrap();
        assert_eq!(sent(&server, "/bot1:A/sendPhoto").await.len(), 2);
    }
}
