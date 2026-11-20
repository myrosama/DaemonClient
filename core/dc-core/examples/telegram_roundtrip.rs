//! P1 task 1.3, Gate 2: send a small random document to the TEST account's
//! channel, read it back, compare, delete it. Password from the macOS
//! Keychain item `daemonclient-test` (see examples/sign_in.rs).
//! Prints sizes and timings only.
use dc_core::session::{Deployment, HOSTED_API};
use dc_core::{Core, CoreConfig};
use std::time::Instant;

fn security(args: &[&str]) -> Result<String, Box<dyn std::error::Error>> {
    let out = std::process::Command::new("security").args(args).output()?;
    if !out.status.success() {
        return Err("no Keychain item `daemonclient-test` — see examples/sign_in.rs".into());
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
    let dir = std::env::temp_dir().join("dc-telegram-check");
    let core = Core::start(CoreConfig::new(dir.join("data"), dir.join("cache")))?;
    core.sign_in(HOSTED_API, Deployment::Hosted, &email, &password)
        .await?;
    let telegram = core.telegram().await?;

    let mut bytes = vec![0u8; 64 * 1024];
    getrandom::fill(&mut bytes)?;
    let mut name = [0u8; 8];
    getrandom::fill(&mut name)?;
    let name = format!("{}.part001", hex::encode(name));

    let t = telegram.clone();
    let (sent_bytes, started) = (bytes.clone(), Instant::now());
    let sent = core
        .run(async move { t.send_document(&name, sent_bytes).await })
        .await??;
    println!(
        "sent {} KiB in {} ms",
        bytes.len() / 1024,
        started.elapsed().as_millis()
    );

    // Read back, then always delete the test message before reporting.
    let (t, file_id, started) = (telegram.clone(), sent.file_id.clone(), Instant::now());
    let back = core.run(async move { t.download(&file_id).await }).await;
    let read_ms = started.elapsed().as_millis();
    let (t, file_id, started) = (telegram.clone(), sent.file_id.clone(), Instant::now());
    let again = core.run(async move { t.download(&file_id).await }).await;
    let again_ms = started.elapsed().as_millis();
    let t = telegram.clone();
    core.run(async move { t.delete_message(sent.message_id).await })
        .await??;
    println!("deleted the test message");
    let back = back??;
    again??;
    println!(
        "read back {} KiB in {read_ms} ms — identical: {}",
        back.len() / 1024,
        back == bytes
    );
    println!("read again (path cached) in {again_ms} ms");
    if back != bytes {
        return Err("the bytes read back differ".into());
    }
    Ok(())
}
