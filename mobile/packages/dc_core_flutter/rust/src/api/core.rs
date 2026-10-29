//! What the apps can call. Deliberately thin: the logic lives in dc-core.

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

/// Runs once when Dart calls `RustLib.init()`. Deliberately empty: FRB's
/// `setup_default_user_utils()` would turn on Trace-level logging to the
/// device log (see the test below). The core sets up its own logging in P1.
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
