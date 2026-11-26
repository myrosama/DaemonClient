//! What the native apps call (Swift on iOS, Kotlin on Android), made with
//! UniFFI. Deliberately thin: the logic lives in dc-core (SPEC D26).

use std::sync::Arc;

uniffi::setup_scaffolding!();

/// An error the app can show. The kind lets the app say it in the user's
/// language; `Failed` carries the core's own words (never a token or a URL).
#[derive(Debug, uniffi::Error)]
#[uniffi(flat_error)]
pub enum CoreError {
    WrongCredentials,
    NotProvisioned,
    BadAddress,
    Network,
    SignedOut,
    Failed(String),
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let words = match self {
            Self::WrongCredentials => dc_core::CoreError::WrongCredentials.to_string(),
            Self::NotProvisioned => dc_core::CoreError::NotProvisioned.to_string(),
            Self::BadAddress => dc_core::CoreError::BadAddress.to_string(),
            Self::Network => "network problem".to_owned(),
            Self::SignedOut => dc_core::CoreError::SignedOut.to_string(),
            Self::Failed(message) => message.clone(),
        };
        f.write_str(&words)
    }
}

impl From<dc_core::CoreError> for CoreError {
    fn from(e: dc_core::CoreError) -> Self {
        match e {
            dc_core::CoreError::WrongCredentials => Self::WrongCredentials,
            dc_core::CoreError::NotProvisioned => Self::NotProvisioned,
            dc_core::CoreError::BadAddress => Self::BadAddress,
            dc_core::CoreError::Network(_) => Self::Network,
            dc_core::CoreError::SignedOut => Self::SignedOut,
            other => Self::Failed(other.to_string()),
        }
    }
}

/// What a sign-in gives the app. HomeRoll's own client needs the worker's
/// address and the session token until the core serves everything (I5–I8);
/// the storage credentials stay in the core (SPEC D21).
#[derive(uniffi::Record)]
pub struct SignedIn {
    pub worker_url: String,
    pub token: String,
    pub user_id: String,
    pub email: String,
    pub name: String,
}

/// The core's local media server: where the app reads every picture and
/// video, `http://127.0.0.1:<port>/<secret>` — the grid's thumbnails on one
/// listener, what the user opened on the other (SPEC D17).
#[derive(uniffi::Record)]
pub struct MediaAddresses {
    pub grid_base: String,
    pub viewer_base: String,
}

/// Receives the core's log lines (bot tokens scrubbed; the core logs no URL
/// or secret of its own).
#[uniffi::export(with_foreign)]
pub trait LogSink: Send + Sync {
    fn line(&self, line: String);
}

/// The core's version, shown in the app so a build can be traced.
#[uniffi::export]
pub fn core_version() -> String {
    dc_core::version().to_owned()
}

/// Sends the core's log lines to `sink`. Call once, before the first `Core`.
/// False when a logger was already installed in this process.
#[uniffi::export]
pub fn set_log_sink(sink: Arc<dyn LogSink>) -> bool {
    dc_core::logging::install(Some(Box::new(move |line: &str| sink.line(line.to_owned()))))
}

/// One per app process.
#[derive(uniffi::Object)]
pub struct Core {
    inner: Arc<dc_core::Core>,
}

#[uniffi::export]
impl Core {
    /// Starts the core with its folders: `data_dir` for what must survive
    /// (the upload journal), `cache_dir` for what may go (pictures).
    #[uniffi::constructor]
    pub fn new(data_dir: String, cache_dir: String) -> Result<Arc<Self>, CoreError> {
        let config = dc_core::CoreConfig::new(data_dir.into(), cache_dir.into());
        Ok(Arc::new(Self {
            inner: Arc::new(dc_core::Core::start(config)?),
        }))
    }

    /// Signs in with the one form (SPEC D8): the hosted address, however
    /// typed, is the hosted service; any other address a self-hosted server.
    pub async fn sign_in(
        &self,
        address: String,
        email: String,
        password: String,
    ) -> Result<SignedIn, CoreError> {
        let deployment = dc_core::session::deployment_of(&address)?;
        let session = self
            .inner
            .sign_in(&address, deployment, &email, &password)
            .await?;
        Ok(SignedIn {
            worker_url: session.worker_url,
            token: session.token.expose().clone(),
            user_id: session.user_id,
            email: session.email,
            name: session.name,
        })
    }

    /// Resumes a session the app kept in the Keychain, without the password.
    pub fn restore(&self, session: SignedIn) -> Result<(), CoreError> {
        self.inner.restore(dc_core::session::Session {
            worker_url: session.worker_url,
            token: dc_core::Secret::new(session.token),
            user_id: session.user_id,
            email: session.email,
            name: session.name,
        })?;
        Ok(())
    }

    /// Forgets the session and empties what the core kept for it.
    pub fn sign_out(&self) -> Result<(), CoreError> {
        self.inner.sign_out()?;
        Ok(())
    }

    /// The local media server's addresses. Call at start and on every
    /// resume: a listener the phone closed opens again on a new port. May
    /// take ~2 s per listener — never on the main thread.
    pub fn media_server(&self) -> Result<MediaAddresses, CoreError> {
        let server = self.inner.media_server()?;
        Ok(MediaAddresses {
            grid_base: server.grid_base,
            viewer_base: server.viewer_base,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn core() -> (Arc<Core>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data").to_string_lossy().into_owned();
        let cache = dir.path().join("cache").to_string_lossy().into_owned();
        (Core::new(data, cache).unwrap(), dir)
    }

    #[test]
    fn the_version_is_the_cores() {
        assert_eq!(core_version(), dc_core::version());
    }

    #[test]
    fn errors_carry_their_kind_and_the_cores_words() {
        let e: CoreError = dc_core::CoreError::WrongCredentials.into();
        assert!(matches!(e, CoreError::WrongCredentials));
        assert_eq!(e.to_string(), "wrong email or password");
        let e: CoreError = dc_core::CoreError::Network("the server answered 502".into()).into();
        assert!(matches!(e, CoreError::Network));
        let e: CoreError = dc_core::CoreError::NotFound.into();
        assert_eq!(e.to_string(), "not found");
    }

    #[test]
    fn a_stored_session_with_a_bad_address_is_refused() {
        let (core, _dir) = core();
        let refused = core.restore(SignedIn {
            worker_url: "not a url".into(),
            token: "t".into(),
            user_id: "u".into(),
            email: "e".into(),
            name: "n".into(),
        });
        assert!(refused.is_err());
    }

    #[test]
    fn the_media_server_answers_and_sign_out_without_a_session_is_fine() {
        let (core, _dir) = core();
        let media = core.media_server().unwrap();
        assert!(media.grid_base.starts_with("http://127.0.0.1:"));
        assert_ne!(media.grid_base, media.viewer_base);
        assert!(core.sign_out().is_ok());
    }
}
