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

/// One HTTPS request from the device to Telegram; the HTTP status.
pub async fn check_telegram() -> anyhow::Result<u16> {
    let core = CORE
        .get()
        .ok_or_else(|| anyhow::anyhow!("the core is not started"))?;
    Ok(core.check_telegram().await?)
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
