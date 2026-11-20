//! Sign-in and the rules for server addresses (P1 design §5.3).

use std::net::IpAddr;

use crate::{CoreError, Secret};

/// The hosted service's sign-in address (filled in on the sign-in form, D8).
pub const HOSTED_API: &str = "https://api.daemonclient.uz";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Deployment {
    Hosted,
    SelfHosted,
}

/// What the app keeps in secure storage to resume without the password.
#[derive(Debug, Clone)]
pub struct Session {
    pub worker_url: String,
    pub token: Secret<String>,
    pub user_id: String,
    pub email: String,
    pub name: String,
}

/// A server address as the core will use it: trimmed, `https://` added when
/// no scheme is given, without a trailing `/` or `/api`. Refused: anything
/// but https — except http to a loopback or private-network address, for
/// self-hosters at home — and credentials, a query or a fragment.
pub fn normalize_server(input: &str) -> Result<String, CoreError> {
    let input = input.trim();
    let with_scheme = if input.contains("://") {
        input.to_owned()
    } else {
        format!("https://{input}")
    };
    let url = reqwest::Url::parse(&with_scheme).map_err(|_| CoreError::BadAddress)?;
    let scheme_ok = match url.scheme() {
        "https" => true,
        "http" => is_local(&url),
        _ => false,
    };
    if !scheme_ok
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(CoreError::BadAddress);
    }
    let trimmed = url.as_str().trim_end_matches('/');
    Ok(trimmed.strip_suffix("/api").unwrap_or(trimmed).to_owned())
}

/// Which kind of server an address typed on the sign-in form is (D8: one
/// form for everyone): the hosted address, however typed, is the hosted
/// service; any other address is a self-hosted server.
pub fn deployment_of(address: &str) -> Result<Deployment, CoreError> {
    // `Url` lowercases the scheme and host, so case does not matter.
    Ok(match normalize_server(address)? == HOSTED_API {
        true => Deployment::Hosted,
        false => Deployment::SelfHosted,
    })
}

/// A server reached over https must not send the session to a plain-http
/// worker (the token would cross the network in the clear).
fn downgrades(server: &str, worker: &str) -> bool {
    server.starts_with("https://") && !worker.starts_with("https://")
}

fn is_local(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    match host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
    {
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Ok(IpAddr::V6(ip)) => ip.is_loopback() || ip.is_unique_local(),
        Err(_) => host == "localhost" || host.ends_with(".local"),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginReply {
    #[serde(deserialize_with = "crate::secret::deserialize")]
    access_token: Secret<String>,
    user_id: String,
    #[serde(default)]
    user_email: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    worker_url: Option<String>,
}

/// `POST {server}/api/auth/login`. Every later call goes to the returned
/// session's `worker_url`, which passes the same address rules first.
pub async fn sign_in(
    http: &reqwest::Client,
    server: &str,
    deployment: Deployment,
    email: &str,
    password: &str,
) -> Result<Session, CoreError> {
    let base = normalize_server(server)?;
    let email = email.trim();
    let reply = http
        .post(format!("{base}/api/auth/login"))
        .json(&serde_json::json!({ "email": email, "password": password }))
        .send()
        .await?;
    let mut reply = reply;
    let status = reply.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(CoreError::WrongCredentials);
    }
    // Nothing signs in there, whatever the page says (a mistyped address).
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(CoreError::BadAddress);
    }
    if status.is_server_error() {
        // A DaemonClient server in trouble, or its host: worth trying again.
        return Err(CoreError::Network(format!(
            "the server answered {}",
            status.as_u16()
        )));
    }
    if !status.is_success() {
        // A DaemonClient server explains a refusal; anything else answering
        // there is not one (a web page, a mistyped address).
        let body = crate::http::body(&mut reply, crate::http::JSON_CAP)
            .await
            .ok();
        let message = body
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .and_then(|v| v.get("message")?.as_str().map(str::to_owned))
            .filter(|m| !m.is_empty());
        // Cleaned like any server's words: no tokens, no bidi tricks, 200 at most.
        let message = message
            .map(|m| crate::error::clean(&m))
            .filter(|m| !m.is_empty());
        return Err(message.map_or(CoreError::BadAddress, CoreError::Server));
    }
    // A success that is not a sign-in answer is not a DaemonClient server.
    let login: LoginReply = crate::worker::read_json(reply, crate::http::JSON_CAP)
        .await
        .map_err(|e| match e {
            CoreError::Server(_) => CoreError::BadAddress,
            other => other,
        })?;
    let worker_url = match (login.worker_url.filter(|u| !u.is_empty()), deployment) {
        // Hosted workers are always https; local-network http is for self-hosters only.
        (Some(url), Deployment::Hosted) => Some(normalize_server(&url)?)
            .filter(|u| u.starts_with("https://"))
            .ok_or(CoreError::BadAddress)?,
        (Some(url), Deployment::SelfHosted) => Some(normalize_server(&url)?)
            .filter(|u| !downgrades(&base, u))
            .ok_or(CoreError::BadAddress)?,
        (None, Deployment::SelfHosted) => base,
        (None, Deployment::Hosted) => return Err(CoreError::NotProvisioned),
    };
    Ok(Session {
        worker_url,
        token: login.access_token,
        user_id: login.user_id,
        email: login.user_email.unwrap_or_else(|| email.to_owned()),
        name: login.name.unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn http() -> reqwest::Client {
        crate::http::client().unwrap()
    }

    #[test]
    fn the_hosted_address_however_typed_is_hosted() {
        for typed in [
            "https://api.daemonclient.uz",
            "api.daemonclient.uz",
            " https://api.daemonclient.uz/ ",
            "https://api.daemonclient.uz/api",
            "HTTPS://API.DaemonClient.UZ",
        ] {
            assert_eq!(deployment_of(typed).unwrap(), Deployment::Hosted, "{typed}");
        }
        for typed in [
            "https://photos.example.com",
            "http://192.168.1.20:2283",
            "https://api.daemonclient.uz.evil.example",
            "https://dc-x.workers.dev",
        ] {
            assert_eq!(
                deployment_of(typed).unwrap(),
                Deployment::SelfHosted,
                "{typed}"
            );
        }
        for junk in [
            "",
            "not a url ::",
            "ftp://api.daemonclient.uz",
            "http://api.daemonclient.uz",
        ] {
            assert!(deployment_of(junk).is_err(), "{junk:?}");
        }
    }

    #[test]
    fn normalizes_server_addresses() {
        assert_eq!(
            normalize_server("x.workers.dev").unwrap(),
            "https://x.workers.dev"
        );
        assert_eq!(
            normalize_server(" https://x.dev/api/ ").unwrap(),
            "https://x.dev"
        );
        assert_eq!(
            normalize_server("http://192.168.1.5:2283").unwrap(),
            "http://192.168.1.5:2283"
        );
        assert_eq!(
            normalize_server("http://localhost:8080/api").unwrap(),
            "http://localhost:8080"
        );
        for bad in [
            "http://example.com",
            "ftp://x",
            "https://u:p@x.dev",
            "https://x.dev/?a=1",
            "https://x.dev/#f",
            "",
        ] {
            assert!(
                matches!(normalize_server(bad), Err(CoreError::BadAddress)),
                "{bad}"
            );
        }
    }

    async fn login_server(reply: ResponseTemplate) -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/auth/login"))
            .and(body_json(
                serde_json::json!({"email": "a@b.uz", "password": "pw"}),
            ))
            .respond_with(reply)
            .expect(1)
            .mount(&server)
            .await;
        server
    }

    fn login_reply(worker_url: serde_json::Value) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "accessToken": "tok", "userId": "u1", "userEmail": "a@b.uz", "name": "A",
            "workerUrl": worker_url, "isAdmin": true
        }))
    }

    #[tokio::test]
    async fn a_server_that_is_not_daemonclient_is_a_bad_address() {
        // Seen on the emulator (2.2): example.com answered 405 — "the server
        // said: 405" told the user nothing.
        for reply in [
            ResponseTemplate::new(405).set_body_string("<html>Method Not Allowed</html>"),
            ResponseTemplate::new(403).set_body_string("Forbidden"),
            ResponseTemplate::new(200).set_body_string("<html>welcome</html>"),
            ResponseTemplate::new(200).set_body_json(serde_json::json!({"hello": "world"})),
        ] {
            let server = login_server(reply).await;
            let result = sign_in(
                &http(),
                &server.uri(),
                Deployment::SelfHosted,
                "a@b.uz",
                "pw",
            )
            .await;
            assert!(matches!(result, Err(CoreError::BadAddress)), "{result:?}");
        }
    }

    #[tokio::test]
    async fn nothing_answering_sign_in_is_a_bad_address_whatever_it_says() {
        // A 404 means nothing signs in there — even when a framework explains
        // it ("Cannot POST /api/auth/login").
        let server = login_server(
            ResponseTemplate::new(404)
                .set_body_json(serde_json::json!({"message": "Cannot POST /api/auth/login"})),
        )
        .await;
        let result = sign_in(
            &http(),
            &server.uri(),
            Deployment::SelfHosted,
            "a@b.uz",
            "pw",
        )
        .await;
        assert!(matches!(result, Err(CoreError::BadAddress)), "{result:?}");
    }

    #[tokio::test]
    async fn a_server_in_trouble_is_worth_trying_again_and_its_words_are_kept() {
        let server =
            login_server(ResponseTemplate::new(503).set_body_string("Service Unavailable")).await;
        let result = sign_in(&http(), &server.uri(), Deployment::Hosted, "a@b.uz", "pw").await;
        assert!(matches!(result, Err(CoreError::Network(_))), "{result:?}");
        let server = login_server(
            ResponseTemplate::new(400)
                .set_body_json(serde_json::json!({"message": "This account is disabled"})),
        )
        .await;
        let result = sign_in(&http(), &server.uri(), Deployment::Hosted, "a@b.uz", "pw").await;
        assert!(
            matches!(&result, Err(CoreError::Server(m)) if m == "This account is disabled"),
            "{result:?}"
        );
        // Its words are cleaned like any server's: no bidi tricks, 200 at most.
        let spoof = format!("Locked \u{202e}moc.live{}", "x".repeat(300));
        let server = login_server(
            ResponseTemplate::new(400).set_body_json(serde_json::json!({"message": spoof})),
        )
        .await;
        let result = sign_in(
            &http(),
            &server.uri(),
            Deployment::SelfHosted,
            "a@b.uz",
            "pw",
        )
        .await;
        assert!(
            matches!(&result, Err(CoreError::Server(m)) if !m.contains('\u{202e}') && m.chars().count() <= 200),
            "{result:?}"
        );
    }

    #[tokio::test]
    async fn an_https_server_cannot_hand_the_token_to_a_plain_http_worker() {
        // (A fake server here is plain http, so the rule is tested on its own.)
        assert!(downgrades(
            "https://photos.example",
            "http://192.168.1.20:2283"
        ));
        assert!(!downgrades("https://photos.example", "https://nas.example"));
        assert!(
            !downgrades("http://192.168.1.5", "http://192.168.1.20:2283"),
            "http to http is the user's own choice"
        );
    }

    #[tokio::test]
    async fn hosted_sign_in_returns_the_session_for_the_users_worker() {
        let server =
            login_server(login_reply(serde_json::json!("https://dc-x.workers.dev/"))).await;
        let s = sign_in(&http(), &server.uri(), Deployment::Hosted, " a@b.uz ", "pw")
            .await
            .unwrap();
        assert_eq!(s.worker_url, "https://dc-x.workers.dev");
        assert_eq!(s.token.expose(), "tok");
        assert_eq!(
            (s.user_id.as_str(), s.email.as_str(), s.name.as_str()),
            ("u1", "a@b.uz", "A")
        );
    }

    #[tokio::test]
    async fn without_a_worker_hosted_is_not_provisioned_and_self_hosted_uses_the_server() {
        let server = login_server(login_reply(serde_json::Value::Null)).await;
        let hosted = sign_in(&http(), &server.uri(), Deployment::Hosted, "a@b.uz", "pw").await;
        assert!(matches!(hosted, Err(CoreError::NotProvisioned)));
        let server = login_server(login_reply(serde_json::Value::Null)).await;
        let s = sign_in(
            &http(),
            &server.uri(),
            Deployment::SelfHosted,
            "a@b.uz",
            "pw",
        )
        .await
        .unwrap();
        assert_eq!(s.worker_url, server.uri());
    }

    #[tokio::test]
    async fn hosted_never_accepts_a_plain_http_worker_even_on_a_local_network() {
        let server = login_server(login_reply(serde_json::json!("http://192.168.1.5"))).await;
        let s = sign_in(&http(), &server.uri(), Deployment::Hosted, "a@b.uz", "pw").await;
        assert!(matches!(s, Err(CoreError::BadAddress)));
    }

    #[tokio::test]
    async fn never_sends_the_token_to_a_plain_http_worker() {
        let server = login_server(login_reply(serde_json::json!("http://evil.example"))).await;
        let s = sign_in(&http(), &server.uri(), Deployment::Hosted, "a@b.uz", "pw").await;
        assert!(matches!(s, Err(CoreError::BadAddress)));
    }

    #[tokio::test]
    async fn a_server_without_a_login_route_is_not_a_usable_address() {
        let server = login_server(ResponseTemplate::new(404)).await;
        let s = sign_in(
            &http(),
            &server.uri(),
            Deployment::SelfHosted,
            "a@b.uz",
            "pw",
        )
        .await;
        assert!(matches!(s, Err(CoreError::BadAddress)));
    }

    #[tokio::test]
    async fn reports_wrong_credentials_and_the_servers_own_messages() {
        let server = login_server(
            ResponseTemplate::new(401)
                .set_body_json(serde_json::json!({"message": "Invalid email or password"})),
        )
        .await;
        let s = sign_in(&http(), &server.uri(), Deployment::Hosted, "a@b.uz", "pw").await;
        assert!(matches!(s, Err(CoreError::WrongCredentials)));
        let server = login_server(ResponseTemplate::new(429).set_body_json(
            serde_json::json!({"message": "Too many sign-in attempts. Wait a minute and try again."}),
        ))
        .await;
        let err = sign_in(&http(), &server.uri(), Deployment::Hosted, "a@b.uz", "pw")
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::Server(m) if m.contains("Too many")),
            "{err}"
        );
    }
}
