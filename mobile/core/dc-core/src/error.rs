//! What can go wrong, in words a user can act on (SPEC §4.8). An error never
//! holds a URL, a token or a key: errors end up in logs and on screen.
//! Later tasks add variants as they need them.

#[derive(Debug, Clone, thiserror::Error)]
pub enum CoreError {
    /// The network failed or a server could not be reached.
    #[error("network problem: {0}")]
    Network(String),
    /// A bug or an impossible state.
    #[error("internal error: {0}")]
    Internal(String),
    /// The worker no longer accepts the saved session.
    #[error("signed out — please sign in again")]
    SignedOut,
    #[error("wrong email or password")]
    WrongCredentials,
    /// Signed in, but the account's storage is not set up yet.
    #[error("this account's storage is not set up yet — finish setup at accounts.daemonclient.uz")]
    NotProvisioned,
    /// An address the core will not use: not https, credentials in it, ...
    #[error("not a usable server address")]
    BadAddress,
    #[error("not found")]
    NotFound,
    /// The server refused the request or answered nonsense; its own words, scrubbed.
    #[error("the server said: {0}")]
    Server(String),
    // User-facing text says "storage", never "Telegram" (SPEC D21).
    #[error("the storage asked to wait {retry_after} s")]
    RateLimited { retry_after: u64 },
    /// The storage refused for good (bad token, bot removed from the channel, ...).
    #[error("the storage refused: {0} — check your storage setup at accounts.daemonclient.uz")]
    TelegramRejected(String),
}

/// A remote party's message made safe to show and log: tokens scrubbed first
/// (a cut token is no longer recognisable), control and bidi characters
/// dropped, at most 200 characters.
pub(crate) fn clean(text: &str) -> String {
    crate::logging::scrub(text)
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .take(200)
        .collect()
}

impl From<reqwest::Error> for CoreError {
    fn from(err: reqwest::Error) -> Self {
        // A request that could not even be built (a malformed address) is a
        // set-up problem, not the network's.
        let builder = err.is_builder();
        let decode = err.is_decode();
        // `without_url` drops the request URL — for Telegram it contains the
        // bot token. The cause chain is kept for diagnosis and scrubbed.
        let err = err.without_url();
        let mut text = err.to_string();
        let mut source = std::error::Error::source(&err);
        while let Some(cause) = source {
            text.push_str(": ");
            text.push_str(&cause.to_string());
            source = cause.source();
        }
        let text = crate::logging::scrub(&text);
        if builder {
            CoreError::Internal(text)
        } else if decode {
            // serde's message can quote a field's value (a password, a token): keep none of it.
            CoreError::Server("unexpected reply from the server".to_owned())
        } else {
            CoreError::Network(text)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn network_errors_never_carry_the_url_or_the_token() {
        // A port that was free a moment ago: the connection is refused.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let url = format!(
            "http://127.0.0.1:{port}/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/getMe"
        );
        let err: CoreError = crate::http::client()
            .unwrap()
            .get(&url)
            .send()
            .await
            .unwrap_err()
            .into();
        let text = err.to_string();
        assert!(text.starts_with("network problem"), "{text}");
        assert!(
            !text.contains("AAHdq") && !text.contains("/bot") && !text.contains(&port.to_string()),
            "{text}"
        );
    }

    #[tokio::test]
    async fn a_malformed_address_is_an_internal_error_not_a_network_one() {
        let err: CoreError = crate::http::client()
            .unwrap()
            .get("not a url")
            .send()
            .await
            .unwrap_err()
            .into();
        assert!(matches!(err, CoreError::Internal(_)), "{err}");
    }
}
