//! `Core`: one per app process. It owns a small tokio runtime of its own
//! (the app's Dart side never blocks, and the core does not depend on the
//! bridge's executor) and the shared HTTP client.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};
use std::time::{Duration, Instant};

use bytes::Bytes;
use tokio::sync::OnceCell;

use crate::chunk_plan::PartSlices;
use crate::disk_cache::DiskCache;
use crate::media_server::{Listeners, MediaServer};
use crate::reader::{self, Image, Layout, PartCache, RangeReader, Rendition, Stored};
use crate::sched::{Class, Fetch, Limits, Scheduler};
use crate::session::{Deployment, Session};
use crate::telegram::Telegram;
use crate::worker::{AssetManifest, Worker};
use crate::{CoreError, Secret};

pub const TELEGRAM_API: &str = "https://api.telegram.org";
/// Decrypted thumbnails and previews kept on disk (P1 decision C5).
const MEDIA_CACHE: u64 = 500 * 1024 * 1024;
/// Recently read parts kept in memory per account: a video's first part, its
/// last (the index) and the one playing (Task 1.6, Gate 2).
const PART_CACHE: u64 = 3 * crate::chunk_plan::PART_SIZE;
/// The largest image kept there (previews measured 1–2.2 MB on the test account).
const MAX_KEPT: usize = 4 * 1024 * 1024;
const MANIFEST_TTL: Duration = Duration::from_secs(10 * 60);
const MANIFESTS_MAX: usize = 4096;

#[derive(Debug, Clone)]
pub struct CoreConfig {
    /// Private storage that persists (upload journals).
    pub data_dir: PathBuf,
    /// Private storage the OS may clear (thumbnails).
    pub cache_dir: PathBuf,
    /// Telegram's address: a setting, so tests can use a fake and a fallback
    /// can be added later (P1 decision C11).
    pub telegram_api: String,
}

impl CoreConfig {
    pub fn new(data_dir: PathBuf, cache_dir: PathBuf) -> Self {
        Self {
            data_dir,
            cache_dir,
            telegram_api: TELEGRAM_API.to_owned(),
        }
    }
}

pub struct Core {
    runtime: Option<tokio::runtime::Runtime>,
    handle: tokio::runtime::Handle,
    http: reqwest::Client,
    config: CoreConfig,
    /// The signed-in account; `None` when signed out.
    account: RwLock<Option<Account>>,
    media: Arc<DiskCache>,
    server: Mutex<Listeners>,
}

/// One signed-in session and what is made for it on first use. All of it
/// goes together, so one account's bot, key or files can never outlive it
/// or reach another.
struct Account {
    worker: Arc<Worker>,
    telegram: Arc<OnceCell<Arc<Telegram>>>,
    /// Every download; its fetch holds this account's bot and Photos key.
    scheduler: Arc<OnceCell<Arc<Scheduler>>>,
    manifests: Arc<Mutex<Manifests>>,
    parts: Arc<Mutex<PartCache>>,
}

/// Asset id → manifest and when it was fetched.
type Manifests = HashMap<String, (Arc<AssetManifest>, Instant)>;

impl Core {
    pub fn start(config: CoreConfig) -> Result<Self, CoreError> {
        crate::logging::install(None);
        for dir in [&config.data_dir, &config.cache_dir] {
            std::fs::create_dir_all(dir).map_err(|e| {
                CoreError::Internal(format!("cannot create the core's folders: {e}"))
            })?;
        }
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("dc-core")
            .enable_all()
            .build()
            .map_err(|e| CoreError::Internal(format!("cannot start the core's runtime: {e}")))?;
        let handle = runtime.handle().clone();
        let http = crate::http::client()?;
        let media = Arc::new(DiskCache::open(
            config.cache_dir.join("media"),
            MEDIA_CACHE,
        )?);
        log::info!("core {} started", crate::version());
        Ok(Self {
            runtime: Some(runtime),
            handle,
            http,
            config,
            account: RwLock::new(None),
            media,
            server: Mutex::default(),
        })
    }

    pub fn config(&self) -> &CoreConfig {
        &self.config
    }

    /// Runs `future` on the core's runtime and waits for it.
    pub async fn run<F>(&self, future: F) -> Result<F::Output, CoreError>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        self.handle.spawn(future).await.map_err(|e| {
            // A panic's message can hold anything, a URL with the token
            // included, and errors reach logs and Dart: never pass it on.
            if e.is_panic() {
                CoreError::Internal("a core task panicked".to_owned())
            } else {
                CoreError::Internal(format!("a core task stopped: {e}"))
            }
        })
    }

    /// Signs in and keeps the session; the app stores the returned session in
    /// secure storage and hands it back to `restore` on the next start.
    pub async fn sign_in(
        &self,
        server: &str,
        deployment: Deployment,
        email: &str,
        password: &str,
    ) -> Result<Session, CoreError> {
        let http = self.http.clone();
        let (server, email, password) = (
            server.to_owned(),
            email.to_owned(),
            Secret::new(password.to_owned()),
        );
        let session = self
            .run(async move {
                crate::session::sign_in(&http, &server, deployment, &email, password.expose()).await
            })
            .await??;
        self.restore(session.clone())?;
        Ok(session)
    }

    pub fn restore(&self, session: Session) -> Result<(), CoreError> {
        // A stored session gets the same address check as a fresh sign-in.
        let session = Session {
            worker_url: crate::session::normalize_server(&session.worker_url)?,
            ..session
        };
        let mut account = self.account.write().map_err(|_| poisoned())?;
        // Another account on this phone without a sign-out: its pictures go.
        // Not on the app's next launch (no account yet): the cache stays.
        if let Some(current) = account.as_ref().map(|a| a.worker.session())
            && (current.user_id != session.user_id || current.worker_url != session.worker_url)
        {
            self.media.clear();
        }
        *account = Some(Account {
            worker: Arc::new(Worker::new(self.http.clone(), session)),
            telegram: Arc::default(),
            scheduler: Arc::default(),
            manifests: Arc::default(),
            parts: Arc::new(Mutex::new(PartCache::new(
                usize::try_from(PART_CACHE).unwrap_or(usize::MAX),
            ))),
        });
        Ok(())
    }

    pub fn sign_out(&self) -> Result<(), CoreError> {
        // Drop the token even if the lock was poisoned.
        *self
            .account
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        self.media.clear();
        Ok(())
    }

    /// The signed-in account's worker, or `SignedOut`.
    pub fn worker(&self) -> Result<Arc<Worker>, CoreError> {
        let account = self.account.read().map_err(|_| poisoned())?;
        account
            .as_ref()
            .map(|a| a.worker.clone())
            .ok_or(CoreError::SignedOut)
    }

    /// The signed-in account's bot, its config fetched once per session even
    /// when several callers ask at the same moment.
    pub async fn telegram(&self) -> Result<Arc<Telegram>, CoreError> {
        let (worker, cell) = {
            let account = self.account.read().map_err(|_| poisoned())?;
            let account = account.as_ref().ok_or(CoreError::SignedOut)?;
            (account.worker.clone(), account.telegram.clone())
        };
        let telegram = cell
            .get_or_try_init(|| async {
                let config = self
                    .run(async move { worker.telegram_config().await })
                    .await??;
                Ok::<_, CoreError>(Arc::new(Telegram::new(
                    self.http.clone(),
                    self.config.telegram_api.clone(),
                    config.bot_token,
                    config.channel_id,
                )))
            })
            .await?
            .clone();
        self.still_signed_in(|a| Arc::ptr_eq(&a.telegram, &cell))?;
        Ok(telegram)
    }

    /// The session may have changed while something was being made for it:
    /// hand it out only if its account is still the signed-in one.
    fn still_signed_in(&self, owns: impl Fn(&Account) -> bool) -> Result<(), CoreError> {
        let account = self.account.read().map_err(|_| poisoned())?;
        match account.as_ref() {
            Some(account) if owns(account) => Ok(()),
            _ => Err(CoreError::SignedOut),
        }
    }

    /// The account's download scheduler, made on first read.
    async fn scheduler(&self) -> Result<Arc<Scheduler>, CoreError> {
        let (worker, cell) = {
            let account = self.account.read().map_err(|_| poisoned())?;
            let account = account.as_ref().ok_or(CoreError::SignedOut)?;
            (account.worker.clone(), account.scheduler.clone())
        };
        let scheduler = cell
            .get_or_try_init(|| async {
                let telegram = self.telegram().await?;
                let key = self
                    .run(async move { worker.photos_key().await })
                    .await??
                    .map(Arc::new);
                let fetch: Fetch = Arc::new(move |job: String| {
                    let (telegram, key) = (telegram.clone(), key.clone());
                    Box::pin(async move {
                        let (file_id, how) = reader::parse_job_key(&job)
                            .ok_or_else(|| CoreError::Internal("a malformed read".to_owned()))?;
                        let key = match (how, key) {
                            (Stored::Plain, _) => None,
                            (_, Some(key)) => Some(key),
                            (_, None) => return Err(CoreError::NotProvisioned),
                        };
                        let stored = telegram.download(file_id).await?;
                        let Some(key) = key else {
                            return Ok(Bytes::from(stored));
                        };
                        // Decryption works in place: a picture keeps its bytes to fall back
                        // on — only when they are one, so no other read is copied.
                        let raw = (how == Stored::Picture && reader::is_picture(&stored))
                            .then(|| stored.clone());
                        // A part is 19 MiB of AES-GCM: off the async threads.
                        let decrypted = tokio::task::spawn_blocking(move || {
                            crate::crypto::decrypt_part(&key, stored)
                        })
                        .await
                        .map_err(|_| CoreError::Internal("decryption stopped".to_owned()))?;
                        match (decrypted, raw) {
                            (Ok(bytes), _) => Ok(bytes),
                            (Err(_), Some(raw)) => Ok(Bytes::from(raw)),
                            (Err(e), _) => Err(CoreError::from(e)),
                        }
                    })
                });
                let _runtime = self.handle.enter();
                Ok::<_, CoreError>(Arc::new(Scheduler::start(Limits::default(), fetch)))
            })
            .await?
            .clone();
        self.still_signed_in(|a| Arc::ptr_eq(&a.scheduler, &cell))?;
        Ok(scheduler)
    }

    async fn manifest(&self, asset_id: &str) -> Result<Arc<AssetManifest>, CoreError> {
        let (worker, manifests) = {
            let account = self.account.read().map_err(|_| poisoned())?;
            let account = account.as_ref().ok_or(CoreError::SignedOut)?;
            (account.worker.clone(), account.manifests.clone())
        };
        if let Some((manifest, at)) = lock(&manifests).get(asset_id)
            && at.elapsed() < MANIFEST_TTL
        {
            return Ok(manifest.clone());
        }
        let id = asset_id.to_owned();
        let manifest = Arc::new(
            self.run(async move { worker.manifest(&id).await })
                .await??,
        );
        let mut cached = lock(&manifests);
        if cached.len() >= MANIFESTS_MAX {
            cached.clear();
        }
        cached.insert(asset_id.to_owned(), (manifest.clone(), Instant::now()));
        Ok(manifest)
    }

    /// A thumbnail or preview (or the one-file original standing in for it):
    /// from the disk cache, else downloaded, decrypted and kept. Never a
    /// video: a video with no preview gets its grid thumbnail.
    pub async fn image(
        &self,
        asset_id: &str,
        rendition: Rendition,
        class: Class,
    ) -> Result<Image, CoreError> {
        // Taken first: a sign-out or another account from here on drops the write.
        let generation = self.media.generation();
        let manifest = self.manifest(asset_id).await?;
        let picture = |s: &reader::Selection| s.mime.starts_with("image/");
        let selection = match reader::select(&manifest, rendition)? {
            s if picture(&s) => s,
            _ => reader::select(&manifest, Rendition::Thumbnail)?,
        };
        if !picture(&selection) {
            return Err(CoreError::NotFound);
        }
        let [file_id] = selection.file_ids.as_slice() else {
            return Err(CoreError::Internal(
                "an image is one stored file".to_owned(),
            ));
        };
        // Real thumbnails and previews only; originals are never kept (SPEC §4.7).
        let keep = *file_id == manifest.thumb_id || *file_id == manifest.preview_id;
        let stored = match Stored::of(&manifest) {
            Stored::Encrypted if keep => Stored::Picture,
            other => other,
        };
        let name = cache_name(self.worker()?.session(), file_id, stored);
        if keep {
            let (media, name) = (self.media.clone(), name.clone());
            if let Ok(Some(bytes)) = self.handle.spawn_blocking(move || media.get(&name)).await {
                return Ok(Image {
                    bytes,
                    mime: selection.mime,
                });
            }
        }
        let scheduler = Arc::downgrade(&self.scheduler().await?);
        let bytes = reader::read_file(&scheduler, &selection, stored, 0, class).await?;
        // A worker may name anything its thumbnail: nothing over 4 MiB is kept.
        if keep && bytes.len() <= MAX_KEPT {
            let (media, kept) = (self.media.clone(), bytes.clone());
            let _ = self
                .handle
                .spawn_blocking(move || media.put(&name, &kept, generation))
                .await;
        }
        Ok(Image {
            bytes,
            mime: selection.mime,
        })
    }

    /// The size, part count and type of an original or of a video's playback.
    pub async fn layout(&self, asset_id: &str, rendition: Rendition) -> Result<Layout, CoreError> {
        let manifest = self.manifest(asset_id).await?;
        let selection = reader::select(&manifest, rendition)?;
        let mut size = selection.size;
        if size == 0 {
            // An older upload whose size was never stored: one file, measured.
            let scheduler = Arc::downgrade(&self.scheduler().await?);
            size = reader::read_file(
                &scheduler,
                &selection,
                Stored::of(&manifest),
                0,
                Class::Opened,
            )
            .await?
            .len() as u64;
        }
        Ok(Layout {
            size,
            parts: selection.file_ids.len(),
            mime: selection.mime,
        })
    }

    /// Reads `slices` (planned with `chunk_plan` on `layout`'s `size`) of an
    /// original or a video's playback, a part at a time.
    pub async fn range(
        &self,
        asset_id: &str,
        rendition: Rendition,
        size: u64,
        slices: PartSlices,
        class: Class,
    ) -> Result<RangeReader, CoreError> {
        let manifest = self.manifest(asset_id).await?;
        let selection = reader::select(&manifest, rendition)?;
        // `slices` were planned on `size`: a manifest renewed since (a
        // rendition added, say) must not have its bytes sent under them.
        if selection.size != 0 && selection.size != size {
            return Err(CoreError::Corrupt(
                "the file changed while it was being read".to_owned(),
            ));
        }
        let scheduler = Arc::downgrade(&self.scheduler().await?);
        let parts = {
            let account = self.account.read().map_err(|_| poisoned())?;
            Arc::downgrade(&account.as_ref().ok_or(CoreError::SignedOut)?.parts)
        };
        Ok(RangeReader {
            scheduler,
            selection,
            stored: Stored::of(&manifest),
            slices,
            class,
            ahead: None,
            parts,
        })
    }

    /// The local media server's addresses (design §5.7, `ensure_running`):
    /// both listeners open on first use; one that no longer answers as ours —
    /// iOS closes a suspended app's sockets, another app may take the port,
    /// or it is too busy to answer — opens again on a new port with a new
    /// secret, and its old connections end. The app must use the addresses
    /// returned and reload what failed. Blocks up to ~2 s per listener: call
    /// it off the core's async threads and off the UI thread.
    pub fn media_server(self: &Arc<Self>) -> Result<MediaServer, CoreError> {
        crate::media_server::ensure_running(self, &mut lock(&self.server))
    }

    #[cfg(test)]
    pub(crate) fn close_listeners_for_test(&self) {
        lock(&self.server).close(&self.handle);
    }

    pub(crate) fn handle(&self) -> &tokio::runtime::Handle {
        &self.handle
    }

    /// One HTTPS request to Telegram; its HTTP status. The device check of
    /// task 1.0, later a diagnostics screen.
    pub async fn check_telegram(&self) -> Result<u16, CoreError> {
        let http = self.http.clone();
        let url = format!("{}/", self.config.telegram_api.trim_end_matches('/'));
        self.run(async move { Ok(http.get(url).send().await?.status().as_u16()) })
            .await?
    }
}

/// A cached picture's name: whose it is, and whether it was decrypted —
/// so no other account, and no other reading of the same file, can get it.
fn cache_name(session: &Session, file_id: &str, stored: Stored) -> String {
    format!(
        "{}\n{}\n{}",
        session.user_id,
        session.worker_url,
        reader::job_key(file_id, stored)
    )
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn poisoned() -> CoreError {
    CoreError::Internal("the session lock was poisoned".to_owned())
}

impl Drop for Core {
    fn drop(&mut self) {
        // A plain drop of a runtime panics inside async code (Dart's bridge
        // may drop us there); shutting down in the background does not.
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::chunk_plan::{PART_SIZE, RangePlan, plan_range};
    use crate::reader::Rendition;
    use crate::sched::Class;

    fn config_in(dir: &tempfile::TempDir) -> CoreConfig {
        CoreConfig::new(dir.path().join("data"), dir.path().join("cache"))
    }

    #[tokio::test]
    async fn starts_makes_its_folders_runs_work_and_drops_inside_async_code() {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::start(config_in(&dir)).unwrap();
        assert!(dir.path().join("data").is_dir() && dir.path().join("cache").is_dir());
        assert_eq!(core.run(async { 2 + 2 }).await.unwrap(), 4);
        drop(core); // inside an async test: must not panic
    }

    #[tokio::test]
    async fn checks_telegram_without_following_redirects() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::path("/"))
            .respond_with(
                wiremock::ResponseTemplate::new(302)
                    .insert_header("location", format!("{}/moved", server.uri())),
            )
            .expect(1)
            .mount(&server)
            .await;
        // Following the redirect would hit this; no internet needed to notice.
        wiremock::Mock::given(wiremock::matchers::path("/moved"))
            .respond_with(wiremock::ResponseTemplate::new(200))
            .expect(0)
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let mut config = config_in(&dir);
        config.telegram_api = server.uri();
        let core = Core::start(config).unwrap();
        assert_eq!(core.check_telegram().await.unwrap(), 302);
    }

    #[tokio::test]
    async fn signing_in_keeps_the_session_and_signing_out_drops_it() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::path("/api/auth/login"))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "accessToken": "tok", "userId": "u1", "workerUrl": null
                })),
            )
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let core = Core::start(config_in(&dir)).unwrap();
        assert!(matches!(core.worker(), Err(CoreError::SignedOut)));
        let session = core
            .sign_in(&server.uri(), Deployment::SelfHosted, "a@b.uz", "pw")
            .await
            .unwrap();
        assert_eq!(core.worker().unwrap().session().worker_url, server.uri());
        core.sign_out().unwrap();
        assert!(matches!(core.worker(), Err(CoreError::SignedOut)));
        core.restore(session.clone()).unwrap();
        assert!(core.worker().is_ok());
        let mut tampered = session;
        tampered.worker_url = "http://example.com".to_owned();
        assert!(matches!(core.restore(tampered), Err(CoreError::BadAddress)));
    }

    async fn bot_server(
        delay_ms: u64,
        expected_config_fetches: impl Into<wiremock::Times>,
    ) -> wiremock::MockServer {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::path("/api/auth/login"))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "accessToken": "tok", "userId": "u1", "workerUrl": null
                })),
            )
            .mount(&server)
            .await;
        wiremock::Mock::given(wiremock::matchers::path("/api/server/telegram-config"))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"botToken": "1:A", "channelId": "-1"}))
                    .set_delay(std::time::Duration::from_millis(delay_ms)),
            )
            .expect(expected_config_fetches)
            .mount(&server)
            .await;
        server
    }

    #[tokio::test]
    async fn the_bot_is_fetched_once_per_session() {
        let server = bot_server(0, 1).await;
        let dir = tempfile::tempdir().unwrap();
        let core = Core::start(config_in(&dir)).unwrap();
        core.sign_in(&server.uri(), Deployment::SelfHosted, "a@b.uz", "pw")
            .await
            .unwrap();
        let (a, b) = tokio::join!(core.telegram(), core.telegram());
        assert!(Arc::ptr_eq(&a.unwrap(), &b.unwrap()));
    }

    #[tokio::test]
    async fn signing_out_during_a_bot_fetch_keeps_nothing() {
        let server = bot_server(500, 1).await;
        let dir = tempfile::tempdir().unwrap();
        let core = Core::start(config_in(&dir)).unwrap();
        core.sign_in(&server.uri(), Deployment::SelfHosted, "a@b.uz", "pw")
            .await
            .unwrap();
        let (fetched, ()) = tokio::join!(core.telegram(), async {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            core.sign_out().unwrap();
        });
        assert!(matches!(fetched, Err(CoreError::SignedOut)));
        assert!(matches!(core.telegram().await, Err(CoreError::SignedOut)));
    }

    const PASSWORD: &str = "correct horse battery staple";
    const SALT: &str = "c2FsdC1zYWx0LXNhbHQhIQ==";

    pub(crate) fn sealed(plain: &[u8]) -> Vec<u8> {
        crate::crypto::encrypt_part(&crate::crypto::derive_key(PASSWORD, SALT).unwrap(), plain)
            .unwrap()
    }

    /// A signed-in core whose worker serves asset `a1` with `manifest`, whose
    /// bot serves `files` (file_id, stored bytes, downloads expected).
    pub(crate) async fn library(
        manifest: serde_json::Value,
        encryption: bool,
        files: Vec<(&str, Vec<u8>, u64)>,
        manifest_fetches: u64,
    ) -> (wiremock::MockServer, Core, tempfile::TempDir) {
        use wiremock::matchers::path;
        use wiremock::{Mock, ResponseTemplate};
        let server = bot_server(0, 0..=1).await; // HEAD needs no bot
        let zke = serde_json::json!({"enabled": encryption, "password": PASSWORD, "salt": SALT});
        Mock::given(path("/api/server/zke-config"))
            .respond_with(ResponseTemplate::new(200).set_body_json(zke))
            .expect(0..=1) // the Photos key: derived at most once per session
            .mount(&server)
            .await;
        Mock::given(path("/api/assets/a1/dc-manifest"))
            .respond_with(ResponseTemplate::new(200).set_body_json(manifest))
            .expect(manifest_fetches)
            .mount(&server)
            .await;
        for (id, bytes, downloads) in files {
            mount_file(&server, id, bytes, downloads, std::time::Duration::ZERO).await;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut config = config_in(&dir);
        config.telegram_api = server.uri();
        let core = Core::start(config).unwrap();
        core.sign_in(&server.uri(), Deployment::SelfHosted, "a@b.uz", "pw")
            .await
            .unwrap();
        (server, core, dir)
    }

    /// The bot serves `id` (getFile, then the file after `delay`), downloaded `downloads` times.
    pub(crate) async fn mount_file(
        server: &wiremock::MockServer,
        id: &str,
        bytes: Vec<u8>,
        downloads: u64,
        delay: std::time::Duration,
    ) {
        use wiremock::matchers::{path, query_param};
        use wiremock::{Mock, ResponseTemplate};
        Mock::given(path("/bot1:A/getFile"))
            .and(query_param("file_id", id))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"ok": true, "result": {"file_path": format!("p/{id}")}}),
            ))
            .mount(server)
            .await;
        Mock::given(path(format!("/file/bot1:A/p/{id}")))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_bytes(bytes)
                    .set_delay(delay),
            )
            .expect(downloads)
            .mount(server)
            .await;
    }

    pub(crate) fn photo(fields: serde_json::Value) -> serde_json::Value {
        let mut m = serde_json::json!({"encryptionMode": "server", "mimeType": "image/heic", "fileSize": 10});
        if let (Some(m), Some(f)) = (m.as_object_mut(), fields.as_object()) {
            m.extend(f.clone());
        }
        m
    }

    async fn read_all(reader: &mut crate::reader::RangeReader) -> Result<Vec<u8>, CoreError> {
        let mut all = vec![];
        while let Some(bytes) = reader.next().await {
            all.extend_from_slice(&bytes?);
        }
        Ok(all)
    }

    #[tokio::test]
    async fn a_thumbnail_is_downloaded_once_then_read_from_disk() {
        let thumb = photo(serde_json::json!({"thumbId": "t"}));
        let (_server, core, _dir) = library(thumb, true, vec![("t", sealed(b"jpeg"), 1)], 1).await;
        for _ in 0..2 {
            let bytes = core
                .image("a1", Rendition::Thumbnail, Class::Visible)
                .await
                .unwrap();
            assert_eq!(&bytes.bytes[..], b"jpeg");
        }
    }

    #[tokio::test]
    async fn a_range_is_read_across_parts() {
        let size = PART_SIZE + 10;
        let manifest = photo(serde_json::json!({"fileSize": size,
            "chunks": [{"index": 0, "file_id": "c0"}, {"index": 1, "file_id": "c1"}]}));
        let first = vec![7u8; usize::try_from(PART_SIZE).unwrap()];
        let files = vec![("c0", sealed(&first), 1), ("c1", sealed(b"0123456789"), 1)];
        let (_server, core, _dir) = library(manifest, true, files, 1).await;
        let layout = core.layout("a1", Rendition::Original).await.unwrap();
        assert_eq!(
            (layout.size, layout.parts, layout.mime.as_str()),
            (size, 2, "image/heic")
        );
        let RangePlan::Partial(slices) = plan_range(size, PART_SIZE - 3, PART_SIZE + 2) else {
            panic!("no range")
        };
        let mut reader = core
            .range("a1", Rendition::Original, size, slices, Class::Opened)
            .await
            .unwrap();
        assert_eq!(read_all(&mut reader).await.unwrap(), b"\x07\x07\x07012");
    }

    #[tokio::test]
    async fn a_part_of_the_wrong_length_or_key_is_damaged() {
        let one = photo(serde_json::json!({"originalId": "o"}));
        let (_server, core, _dir) =
            library(one.clone(), true, vec![("o", sealed(b"eleven byte"), 1)], 1).await;
        let RangePlan::Partial(slices) = plan_range(10, 0, 9) else {
            panic!("no range")
        };
        let mut reader = core
            .range("a1", Rendition::Original, 10, slices, Class::Opened)
            .await
            .unwrap();
        assert!(matches!(
            read_all(&mut reader).await,
            Err(CoreError::Corrupt(_))
        ));
        let (_server, core, _dir) =
            library(one.clone(), true, vec![("o", sealed(b"nine byte"), 1)], 1).await;
        let RangePlan::Partial(slices) = plan_range(10, 0, 9) else {
            panic!("no range")
        };
        let mut reader = core
            .range("a1", Rendition::Original, 10, slices, Class::Opened)
            .await
            .unwrap();
        assert!(
            matches!(read_all(&mut reader).await, Err(CoreError::Corrupt(_))),
            "short"
        );
        let wrong_key = crate::crypto::encrypt_part(
            &crate::crypto::derive_key("other", SALT).unwrap(),
            b"0123456789",
        )
        .unwrap();
        let (_server, core, _dir) = library(one, true, vec![("o", wrong_key, 1)], 1).await;
        let err = core
            .image("a1", Rendition::Preview, Class::Opened)
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::Corrupt(_)), "{err}");
    }

    #[tokio::test]
    async fn plain_assets_are_read_as_stored_and_encrypted_ones_need_the_key() {
        for mode in ["off", ""] {
            let m = photo(serde_json::json!({"thumbId": "t", "encryptionMode": mode}));
            let (_server, core, _dir) =
                library(m, true, vec![("t", b"plain".to_vec(), 1)], 1).await;
            assert_eq!(
                &core
                    .image("a1", Rendition::Thumbnail, Class::Visible)
                    .await
                    .unwrap()
                    .bytes[..],
                b"plain"
            );
        }
        let m = photo(serde_json::json!({"thumbId": "t"}));
        let (_server, core, _dir) = library(m, false, vec![("t", sealed(b"jpeg"), 0)], 1).await;
        let err = core
            .image("a1", Rendition::Thumbnail, Class::Visible)
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::NotProvisioned), "{err}");
    }

    #[tokio::test]
    async fn a_restart_keeps_the_cache_and_another_account_clears_it() {
        let thumb = photo(serde_json::json!({"thumbId": "t"}));
        let (server, core, dir) = library(thumb, true, vec![("t", sealed(b"jpeg"), 1)], 2).await;
        core.image("a1", Rendition::Thumbnail, Class::Visible)
            .await
            .unwrap();
        let session = core.worker().unwrap().session().clone();
        drop(core);
        let mut config = config_in(&dir);
        config.telegram_api = server.uri();
        let core = Core::start(config).unwrap();
        core.restore(session.clone()).unwrap(); // the app's next launch
        let bytes = core
            .image("a1", Rendition::Thumbnail, Class::Visible)
            .await
            .unwrap();
        assert_eq!(
            &bytes.bytes[..],
            b"jpeg",
            "from disk: the file was downloaded once"
        );
        core.restore(session.clone()).unwrap();
        let media = dir.path().join("cache").join("media");
        assert!(
            std::fs::read_dir(&media).unwrap().next().is_some(),
            "same account: kept"
        );
        core.restore(Session {
            user_id: "u2".into(),
            ..session
        })
        .unwrap();
        assert!(
            std::fs::read_dir(&media).unwrap().next().is_none(),
            "another account: emptied"
        );
    }

    #[test]
    fn cached_files_are_named_per_account_and_encryption() {
        let session = |user: &str, url: &str| Session {
            worker_url: url.into(),
            token: Secret::new("tok".to_owned()),
            user_id: user.into(),
            email: "a@b.uz".into(),
            name: "A".into(),
        };
        let a = session("u1", "https://a.example");
        let names = [
            cache_name(&a, "t", Stored::Picture),
            cache_name(&a, "t", Stored::Plain),
            cache_name(&session("u2", "https://a.example"), "t", Stored::Picture),
            cache_name(&session("u1", "https://b.example"), "t", Stored::Picture),
        ];
        let distinct: std::collections::HashSet<_> = names.iter().collect();
        assert_eq!(distinct.len(), 4);
    }

    #[tokio::test]
    async fn a_thumbnail_over_four_mebibytes_is_not_kept() {
        let big = vec![1u8; 5 << 20];
        let thumb = photo(serde_json::json!({"thumbId": "t"}));
        let (_server, core, _dir) = library(thumb, true, vec![("t", sealed(&big), 2)], 1).await;
        for _ in 0..2 {
            assert_eq!(
                core.image("a1", Rendition::Thumbnail, Class::Visible)
                    .await
                    .unwrap()
                    .bytes
                    .len(),
                5 << 20
            );
        }
    }

    #[tokio::test]
    async fn an_older_plain_thumbnail_in_an_encrypted_library_is_shown_as_the_worker_does() {
        let jpeg = b"\xff\xd8\xff\xe0 a plain old thumbnail".to_vec();
        let m = photo(serde_json::json!({"thumbId": "t", "previewId": "p", "originalId": "o"}));
        let files = vec![
            ("t", jpeg.clone(), 1),
            ("p", b"not a picture".to_vec(), 1),
            ("o", b"0123456789".to_vec(), 1),
        ];
        let (_server, core, _dir) = library(m, true, files, 1).await;
        for _ in 0..2 {
            let bytes = core
                .image("a1", Rendition::Thumbnail, Class::Visible)
                .await
                .unwrap();
            assert_eq!(bytes.bytes.to_vec(), jpeg, "served raw, then from disk");
        }
        let err = core
            .image("a1", Rendition::Preview, Class::Opened)
            .await
            .unwrap_err();
        assert!(
            matches!(err, CoreError::Corrupt(_)),
            "not a picture: refused ({err})"
        );
        let RangePlan::Partial(slices) = plan_range(10, 0, 9) else {
            panic!("no range")
        };
        let mut reader = core
            .range("a1", Rendition::Original, 10, slices, Class::Opened)
            .await
            .unwrap();
        assert!(
            matches!(read_all(&mut reader).await, Err(CoreError::Corrupt(_))),
            "parts never fall back"
        );
    }

    #[tokio::test]
    async fn a_part_read_again_comes_from_memory() {
        let one = photo(serde_json::json!({"originalId": "o"}));
        let (_server, core, _dir) =
            library(one, true, vec![("o", sealed(b"0123456789"), 1)], 1).await;
        for (first, last, want) in [(0, 1, &b"01"[..]), (2, 9, &b"23456789"[..])] {
            let RangePlan::Partial(slices) = plan_range(10, first, last) else {
                panic!("no range")
            };
            let mut reader = core
                .range("a1", Rendition::Original, 10, slices, Class::Opened)
                .await
                .unwrap();
            assert_eq!(read_all(&mut reader).await.unwrap(), want);
        }
    }

    #[tokio::test]
    async fn an_image_is_never_a_video() {
        let m = photo(serde_json::json!({"originalId": "o", "mimeType": "video/mp4"}));
        let (_server, core, _dir) =
            library(m, true, vec![("o", sealed(b"0123456789"), 0)], 1).await;
        let err = core
            .image("a1", Rendition::Thumbnail, Class::Visible)
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::NotFound), "{err}");
    }

    #[tokio::test]
    async fn a_range_planned_on_another_size_is_refused() {
        let one = photo(serde_json::json!({"originalId": "o"}));
        let (_server, core, _dir) =
            library(one, true, vec![("o", sealed(b"0123456789"), 0)], 1).await;
        let RangePlan::Partial(slices) = plan_range(11, 0, 10) else {
            panic!("no range")
        };
        let err = core
            .range("a1", Rendition::Original, 11, slices, Class::Opened)
            .await
            .err()
            .unwrap();
        assert!(
            matches!(err, CoreError::Corrupt(_)),
            "the file changed since its layout: {err}"
        );
    }

    #[tokio::test]
    async fn an_older_upload_without_a_size_is_measured() {
        let m = photo(serde_json::json!({"originalId": "o", "fileSize": 0}));
        let (_server, core, _dir) =
            library(m, true, vec![("o", sealed(b"0123456789"), 2)], 1).await;
        let layout = core.layout("a1", Rendition::Original).await.unwrap();
        assert_eq!((layout.size, layout.parts), (10, 1));
        let RangePlan::Partial(slices) = plan_range(layout.size, 2, 4) else {
            panic!("no range")
        };
        let mut reader = core
            .range("a1", Rendition::Original, 10, slices, Class::Opened)
            .await
            .unwrap();
        assert_eq!(read_all(&mut reader).await.unwrap(), b"234");
    }

    #[test]
    fn reads_go_on_after_the_callers_runtime_is_gone() {
        // The bridge calls from its own executor: the scheduler must live on
        // the core's runtime, not on whichever one first asked for a picture.
        let first = tokio::runtime::Runtime::new().unwrap();
        let m = photo(serde_json::json!({"thumbId": "t", "previewId": "p"}));
        let files = vec![("t", sealed(b"jpeg"), 1), ("p", sealed(b"preview"), 1)];
        let (_server, core, _dir) = first.block_on(library(m, true, files, 1));
        first
            .block_on(core.image("a1", Rendition::Thumbnail, Class::Visible))
            .unwrap();
        let second = tokio::runtime::Runtime::new().unwrap();
        drop(first);
        let bytes = second
            .block_on(core.image("a1", Rendition::Preview, Class::Opened))
            .unwrap();
        assert_eq!(&bytes.bytes[..], b"preview");
    }

    #[tokio::test]
    async fn signing_out_stops_reads_and_empties_the_media_cache() {
        let m = photo(serde_json::json!({"thumbId": "t", "originalId": "o"}));
        let files = vec![("t", sealed(b"jpeg"), 1), ("o", sealed(b"0123456789"), 0)];
        let (_server, core, dir) = library(m, true, files, 1).await;
        core.image("a1", Rendition::Thumbnail, Class::Visible)
            .await
            .unwrap();
        let RangePlan::Partial(slices) = plan_range(10, 0, 9) else {
            panic!("no range")
        };
        let mut reader = core
            .range("a1", Rendition::Original, 10, slices, Class::Opened)
            .await
            .unwrap();
        core.sign_out().unwrap();
        assert!(matches!(
            read_all(&mut reader).await,
            Err(CoreError::SignedOut)
        ));
        let err = core
            .image("a1", Rendition::Thumbnail, Class::Visible)
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::SignedOut), "{err}");
        let media = dir.path().join("cache").join("media");
        assert!(std::fs::read_dir(media).map_or(true, |mut d| d.next().is_none()));
    }

    #[tokio::test]
    async fn a_panicking_task_never_reports_its_message() {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::start(config_in(&dir)).unwrap();
        let err = core
            .run(async { panic!("reply from https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/x") })
            .await
            .unwrap_err()
            .to_string();
        assert!(!err.contains("AAHdq") && !err.contains("telegram"), "{err}");
    }
}
