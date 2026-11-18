//! What the apps can call. Deliberately thin: the logic lives in dc-core.

use std::sync::OnceLock;

static CORE: OnceLock<dc_core::Core> = OnceLock::new();

/// The core's version, shown in the apps so a build can be traced to a commit.
#[flutter_rust_bridge::frb(sync)]
pub fn core_version() -> String {
    dc_core::version().to_owned()
}

/// Number of 19 MiB Telegram parts a file of `file_size` bytes is split into.
#[flutter_rust_bridge::frb(sync)]
pub fn part_count(file_size: u64) -> u64 {
    dc_core::chunk_plan::part_count(file_size)
}

/// Starts the core once per app process; later calls do nothing.
pub fn start_core(data_dir: String, cache_dir: String) -> anyhow::Result<()> {
    if CORE.get().is_none() {
        let core =
            dc_core::Core::start(dc_core::CoreConfig::new(data_dir.into(), cache_dir.into()))?;
        // If another call won the race, its core stays and this one is dropped.
        let _ = CORE.set(core);
    }
    Ok(())
}

fn core() -> anyhow::Result<&'static dc_core::Core> {
    CORE.get()
        .ok_or_else(|| anyhow::anyhow!("the core is not started"))
}

/// One HTTPS request from the device to Telegram; the HTTP status.
pub async fn check_telegram() -> anyhow::Result<u16> {
    Ok(core()?.check_telegram().await?)
}

/// What a sign-in gives the app. Immich's own client needs the worker's
/// address and the session token (it sends it as its auth cookie); the
/// storage credentials stay in the core (SPEC D21).
pub struct SignedIn {
    pub worker_url: String,
    pub token: String,
    pub user_id: String,
    pub email: String,
    pub name: String,
}

/// Signs in with the one form (SPEC D8): the hosted address, however typed,
/// is the hosted service; any other address is a self-hosted server. Errors
/// carry the core's own words ("wrong email or password", …).
pub async fn sign_in(address: String, email: String, password: String) -> anyhow::Result<SignedIn> {
    let deployment = dc_core::session::deployment_of(&address)?;
    let session = core()?
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

/// Resumes a session kept in the phone's secure storage, without the password.
#[flutter_rust_bridge::frb(sync)]
pub fn restore(session: SignedIn) -> anyhow::Result<()> {
    core()?.restore(dc_core::session::Session {
        worker_url: session.worker_url,
        token: dc_core::Secret::new(session.token),
        user_id: session.user_id,
        email: session.email,
        name: session.name,
    })?;
    Ok(())
}

/// Forgets the session and empties what the core kept for it (pictures,
/// uploads under way).
#[flutter_rust_bridge::frb(sync)]
pub fn sign_out() -> anyhow::Result<()> {
    core()?.sign_out()?;
    Ok(())
}

/// Runs once when Dart calls `RustLib.init()`. Deliberately empty: FRB's
/// `setup_default_user_utils()` would turn on Trace-level logging to the
/// device log (see the test below). `start_core` installs the core's own logger.
#[flutter_rust_bridge::frb(init)]
pub fn init_app() {}

#[cfg(test)]
mod tests {
    use super::*;

    /// SPEC §4.8: logs must never carry tokens or Telegram URLs. FRB's default
    /// init turns on Trace-level logging to logcat / os_log (`%{public}s`), where
    /// any dependency's debug line (an HTTP client logging a request URL with
    /// the bot token) would land. Starting the app must leave logging off; the
    /// core installs its own redacting logger in P1.
    #[test]
    fn starting_the_app_turns_on_no_logging() {
        init_app();
        assert_eq!(log::max_level(), log::LevelFilter::Off);
    }
}
