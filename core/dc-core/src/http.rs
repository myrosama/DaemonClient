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

pub fn client() -> Result<reqwest::Client, CoreError> {
    builder()?
        .read_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| CoreError::Internal(format!("HTTP client set-up failed: {e}")))
}

/// For sending files. Without `client`'s 30 s limit: reqwest counts it from
/// the start of the request until the answer begins, so a 19 MiB part on a
/// slow uplink — minutes — would always fail (Task 1.7, Gate 2). Each send
/// gets `upload_timeout` instead; keepalive notices a dead connection.
pub fn upload_client() -> Result<reqwest::Client, CoreError> {
    builder()?
        .tcp_keepalive(Duration::from_secs(30))
        .build()
        .map_err(|e| CoreError::Internal(format!("HTTP client set-up failed: {e}")))
}

/// Time allowed to send `bytes`: a minute, and as long as 20 KB/s needs.
pub(crate) fn upload_timeout(bytes: usize) -> Duration {
    Duration::from_secs(60 + u64::try_from(bytes / 20_000).unwrap_or(u64::MAX / 2))
}

fn builder() -> Result<reqwest::ClientBuilder, CoreError> {
    let tls = tls_config().map_err(|e| CoreError::Internal(format!("TLS set-up failed: {e}")))?;
    Ok(reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .connect_timeout(Duration::from_secs(10))
        .user_agent(concat!("DaemonClient-core/", env!("CARGO_PKG_VERSION")))
        // The worker and Telegram never redirect API calls; following one
        // could carry the bot token to another host.
        .redirect(reqwest::redirect::Policy::none()))
}

/// The most JSON the core reads from a worker or the Bot API.
pub(crate) const JSON_CAP: usize = 4 * 1024 * 1024;

/// A reply's body, refused when over `cap` bytes — by its declared length or
/// as it streams in.
pub(crate) async fn body(reply: &mut reqwest::Response, cap: usize) -> Result<Vec<u8>, CoreError> {
    let too_large = || CoreError::Server(format!("a reply is over {} MiB", cap >> 20));
    let declared = reply.content_length().unwrap_or(0);
    if declared > cap as u64 {
        return Err(too_large());
    }
    // Bounded by the check above; avoids growing a 19 MiB part to 32 MiB.
    let mut bytes = Vec::with_capacity(usize::try_from(declared).unwrap_or(0));
    while let Some(chunk) = reply.chunk().await? {
        if bytes.len() + chunk.len() > cap {
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
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
