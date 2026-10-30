//! P1 task 1.2, Gate 2: sign in to the TEST account and read its configuration.
//!
//! The password comes from the macOS Keychain (P1 decision C8). Once, in Terminal:
//!   security add-generic-password -s daemonclient-test -a <test account email> -w
//! (it asks for the password). Then: cargo run -q -p dc-core --example sign_in
//!
//! Prints no token, password or key.
use dc_core::session::{Deployment, HOSTED_API};
use dc_core::{Core, CoreConfig};

fn security(args: &[&str]) -> Result<String, Box<dyn std::error::Error>> {
    let out = std::process::Command::new("security").args(args).output()?;
    if !out.status.success() {
        return Err(
            "no Keychain item `daemonclient-test` — see the comment at the top of this file".into(),
        );
    }
    // Never `?` the decode error: its Debug output would print the raw bytes.
    let text = String::from_utf8(out.stdout).map_err(|_| "the Keychain value is not UTF-8")?;
    Ok(text.trim().to_owned())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let password = security(&["find-generic-password", "-s", "daemonclient-test", "-w"])?;
    let attributes = security(&["find-generic-password", "-s", "daemonclient-test"])?;
    let email = attributes
        .lines()
        .find_map(|l| {
            l.trim()
                .strip_prefix("\"acct\"<blob>=\"")?
                .strip_suffix('"')
        })
        .ok_or("the Keychain item has no account (email)")?
        .to_owned();

    let dir = std::env::temp_dir().join("dc-sign-in-check");
    let core = Core::start(CoreConfig::new(dir.join("data"), dir.join("cache")))?;
    let session = core
        .sign_in(HOSTED_API, Deployment::Hosted, &email, &password)
        .await?;
    let host = session.worker_url.split("://").nth(1).unwrap_or_default();
    println!("signed in — worker: {host}");

    let worker = core.worker()?;
    let w = worker.clone();
    let telegram = core.run(async move { w.telegram_config().await }).await??;
    let present = |empty: bool| if empty { "MISSING" } else { "present" };
    println!(
        "telegram — bot token: {}, channel: {}",
        present(telegram.bot_token.expose().is_empty()),
        present(telegram.channel_id.is_empty())
    );

    let w = worker.clone();
    let zke = core.run(async move { w.zke_config().await }).await??;
    let started = std::time::Instant::now();
    let w = worker.clone();
    let key = core.run(async move { w.photos_key().await }).await??;
    println!(
        "photos encryption — mode: {}, key: {} (derived in {} ms)",
        zke.mode.as_deref().unwrap_or("none"),
        if key.is_some() {
            "derived"
        } else {
            "none (encryption off)"
        },
        started.elapsed().as_millis()
    );
    Ok(())
}
