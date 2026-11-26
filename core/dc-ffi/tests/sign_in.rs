//! Sign-in, restore and sign-out through the bridge, against a stand-in
//! self-hosted server (a local address may use plain http).
#![allow(clippy::unwrap_used)] // a test binary: a panic is a failing test

use dc_ffi::{Core, CoreError};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn core(dir: &tempfile::TempDir) -> std::sync::Arc<Core> {
    let path = |p: &str| dir.path().join(p).to_string_lossy().into_owned();
    Core::new(path("data"), path("cache")).unwrap()
}

async fn server(reply: ResponseTemplate) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/auth/login"))
        .respond_with(reply)
        .mount(&server)
        .await;
    server
}

#[tokio::test]
async fn a_sign_in_gives_the_session_and_it_restores_and_signs_out() {
    let server = server(ResponseTemplate::new(201).set_body_json(serde_json::json!({
        "accessToken": "tok", "userId": "u1", "userEmail": "a@b.uz", "name": "A"
    })))
    .await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(&dir);
    let s = core
        .sign_in(server.uri(), " a@b.uz ".into(), "pw".into())
        .await
        .unwrap();
    // A self-hosted server with no worker address of its own is the worker.
    assert_eq!(s.worker_url, server.uri());
    assert_eq!(
        (
            s.token.as_str(),
            s.user_id.as_str(),
            s.email.as_str(),
            s.name.as_str()
        ),
        ("tok", "u1", "a@b.uz", "A")
    );
    core.restore(s).unwrap();
    core.sign_out().unwrap();
}

#[tokio::test]
async fn a_wrong_password_is_its_own_kind() {
    let server = server(ResponseTemplate::new(401)).await;
    let dir = tempfile::tempdir().unwrap();
    let e = core(&dir)
        .sign_in(server.uri(), "a@b.uz".into(), "nope".into())
        .await;
    // `SignedIn` has no `Debug` on purpose (it holds the token): no `unwrap_err`.
    let Err(e) = e else { panic!("signed in") };
    assert!(matches!(e, CoreError::WrongCredentials), "{e:?}");
}

#[tokio::test]
async fn an_unreachable_server_is_a_network_problem() {
    let dir = tempfile::tempdir().unwrap();
    // Port 9 (discard) on loopback: nothing listens there.
    let e = core(&dir)
        .sign_in("http://127.0.0.1:9".into(), "a@b.uz".into(), "pw".into())
        .await;
    let Err(e) = e else { panic!("signed in") };
    assert!(matches!(e, CoreError::Network), "{e:?}");
}
