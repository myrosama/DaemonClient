//! `Core`: one per app process. It owns a small tokio runtime of its own
//! (the app's Dart side never blocks, and the core does not depend on the
//! bridge's executor) and the shared HTTP client.

use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use crate::session::{Deployment, Session};
use crate::telegram::Telegram;
use crate::worker::Worker;
use crate::{CoreError, Secret};

pub const TELEGRAM_API: &str = "https://api.telegram.org";

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
}

/// One signed-in session: its worker, and its bot made once on first use.
/// Both go together, so one account's bot can never outlive it or reach another.
struct Account {
    worker: Arc<Worker>,
    telegram: Arc<tokio::sync::OnceCell<Arc<Telegram>>>,
}

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
        log::info!("core {} started", crate::version());
        Ok(Self {
            runtime: Some(runtime),
            handle,
            http,
            config,
            account: RwLock::new(None),
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
        *self.account.write().map_err(|_| poisoned())? = Some(Account {
            worker: Arc::new(Worker::new(self.http.clone(), session)),
            telegram: Arc::default(),
        });
        Ok(())
    }

    pub fn sign_out(&self) -> Result<(), CoreError> {
        // Drop the token even if the lock was poisoned.
        *self
            .account
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
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
        // The session may have changed while the config was fetched: hand the
        // bot out only if its account is still the signed-in one.
        let account = self.account.read().map_err(|_| poisoned())?;
        if account
            .as_ref()
            .is_some_and(|a| Arc::ptr_eq(&a.telegram, &cell))
        {
            Ok(telegram)
        } else {
            Err(CoreError::SignedOut)
        }
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
mod tests {
    use super::*;

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

    async fn bot_server(delay_ms: u64, expected_config_fetches: u64) -> wiremock::MockServer {
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
