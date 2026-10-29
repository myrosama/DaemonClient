//! The one HTTP client for the worker and Telegram (P1 decision C1): rustls
//! with the `ring` provider and Mozilla's roots compiled in (`webpki-roots`).
//! No platform verifier, so no CMake and no Android-specific set-up; the
//! cost is that certificates a user installed on the phone are not trusted.

use std::sync::Arc;
use std::time::Duration;

use crate::CoreError;

pub(crate) fn tls_config() -> Result<rustls::ClientConfig, rustls::Error> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let mut config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_root_certificates(roots)
    .with_no_client_auth();
    // reqwest uses a preconfigured TLS config as it is, so offer HTTP/2 here.
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(config)
}

pub(crate) fn client() -> Result<reqwest::Client, CoreError> {
    let tls = tls_config().map_err(|e| CoreError::Internal(format!("TLS set-up failed: {e}")))?;
    reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        .user_agent(concat!("DaemonClient-core/", env!("CARGO_PKG_VERSION")))
        // The worker and Telegram never redirect API calls; following one
        // could carry the bot token to another host.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| CoreError::Internal(format!("HTTP client set-up failed: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offers_http2_then_http1() {
        assert_eq!(
            tls_config().unwrap().alpn_protocols,
            vec![b"h2".to_vec(), b"http/1.1".to_vec()]
        );
    }
}
