//! The core's logger (SPEC §4.8, P1 decision C9). Warn in release builds,
//! Info in debug builds. Every line goes through `scrub`, is kept in a small
//! ring buffer the app can show (P2), and goes to an optional sink (`dc-cli`
//! prints it). It never writes to the device log by itself.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

pub type Sink = Box<dyn Fn(&str) + Send + Sync>;

const RECENT_LINES: usize = 500;

pub fn default_level() -> log::LevelFilter {
    if cfg!(debug_assertions) {
        log::LevelFilter::Info
    } else {
        log::LevelFilter::Warn
    }
}

/// Replaces anything shaped like a Telegram bot token (`<6+ digits>:<30+ of
/// A-Z a-z 0-9 _ ->`, the `:` possibly percent-encoded as `%3A`) with
/// `[redacted]`. A second line of defence — code must not put a token into a
/// message in the first place.
pub fn scrub(line: &str) -> String {
    let bytes = line.as_bytes();
    let is_token_char = |b: &u8| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-';
    let mut out = String::with_capacity(line.len());
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        let separator = if bytes.get(i) == Some(&b':') {
            1
        } else if bytes
            .get(i..i + 3)
            .is_some_and(|s| s.eq_ignore_ascii_case(b"%3a"))
        {
            3
        } else {
            0
        };
        if separator > 0 {
            let digits = bytes
                .get(..i)
                .unwrap_or_default()
                .iter()
                .rev()
                .take_while(|b| b.is_ascii_digit())
                .count();
            let tail = bytes
                .get(i + separator..)
                .unwrap_or_default()
                .iter()
                .take_while(|b| is_token_char(b))
                .count();
            if digits >= 6 && tail >= 30 {
                // Every index here sits next to an ASCII byte, so on a char boundary.
                out.push_str(line.get(copied..i - digits).unwrap_or_default());
                out.push_str("[redacted]");
                i += separator + tail;
                copied = i;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(line.get(copied..).unwrap_or_default());
    out
}

pub struct CoreLogger {
    level: log::LevelFilter,
    capacity: usize,
    recent: Mutex<VecDeque<String>>,
    sink: Option<Sink>,
}

impl CoreLogger {
    pub fn new(level: log::LevelFilter, capacity: usize, sink: Option<Sink>) -> Self {
        Self {
            level,
            capacity,
            recent: Mutex::new(VecDeque::with_capacity(capacity)),
            sink,
        }
    }

    pub fn recent(&self) -> Vec<String> {
        self.recent
            .lock()
            .map(|r| r.iter().cloned().collect())
            .unwrap_or_default()
    }
}

impl log::Log for CoreLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= self.level
    }

    fn log(&self, record: &log::Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = scrub(&format!(
            "{} {}: {}",
            record.level(),
            record.target(),
            record.args()
        ));
        if let Some(sink) = &self.sink {
            sink(&line);
        }
        if self.capacity == 0 {
            return;
        }
        if let Ok(mut recent) = self.recent.lock() {
            if recent.len() >= self.capacity {
                recent.pop_front();
            }
            recent.push_back(line);
        }
    }

    fn flush(&self) {}
}

static LOGGER: OnceLock<&'static CoreLogger> = OnceLock::new();

/// Installs the core's logger for the whole process, once. Returns `false`
/// when it was already installed, or when another logger got there first.
pub fn install(sink: Option<Sink>) -> bool {
    let mut installed = false;
    LOGGER.get_or_init(|| {
        let logger: &'static CoreLogger = Box::leak(Box::new(CoreLogger::new(
            default_level(),
            RECENT_LINES,
            sink,
        )));
        if log::set_logger(logger).is_ok() {
            log::set_max_level(default_level());
            installed = true;
        }
        logger
    });
    installed
}

/// The most recent log lines, oldest first (for the app's log screen).
pub fn recent_logs() -> Vec<String> {
    LOGGER.get().map(|l| l.recent()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

    #[test]
    fn scrubs_bot_tokens_wherever_they_appear() {
        let url = format!("GET https://api.telegram.org/bot{TOKEN}/getFile?file_id=x");
        assert_eq!(
            scrub(&url),
            "GET https://api.telegram.org/bot[redacted]/getFile?file_id=x"
        );
        assert_eq!(scrub(TOKEN), "[redacted]");
        assert_eq!(
            scrub(&format!("{TOKEN} and {TOKEN}")),
            "[redacted] and [redacted]"
        );
        assert_eq!(
            scrub(&format!("ошибка {TOKEN} конец")),
            "ошибка [redacted] конец"
        );
        let encoded = TOKEN.replace(':', "%3A");
        assert_eq!(
            scrub(&format!("?token={encoded}&x=1")),
            "?token=[redacted]&x=1"
        );
        assert_eq!(scrub(&TOKEN.replace(':', "%3a")), "[redacted]");
    }

    #[test]
    fn leaves_ordinary_colons_alone() {
        for line in [
            "12:30:45",
            "http://localhost:8080/x",
            "error 404: not found",
            "123456789:short",
            "",
        ] {
            assert_eq!(scrub(line), line);
        }
    }

    fn record_into(logger: &CoreLogger, level: log::Level, text: &str) {
        log::Log::log(
            logger,
            &log::Record::builder()
                .level(level)
                .target("t")
                .args(format_args!("{text}"))
                .build(),
        );
    }

    #[test]
    fn keeps_recent_lines_scrubbed_and_drops_the_oldest() {
        let logger = CoreLogger::new(log::LevelFilter::Info, 2, None);
        record_into(&logger, log::Level::Info, "one");
        record_into(&logger, log::Level::Info, &format!("two {TOKEN}"));
        record_into(&logger, log::Level::Warn, "three");
        assert_eq!(
            logger.recent(),
            vec![
                "INFO t: two [redacted]".to_owned(),
                "WARN t: three".to_owned()
            ]
        );
    }

    #[test]
    fn ignores_levels_below_its_own() {
        let logger = CoreLogger::new(log::LevelFilter::Warn, 10, None);
        record_into(&logger, log::Level::Info, "quiet");
        assert!(logger.recent().is_empty());
    }

    #[test]
    fn hands_each_line_to_the_sink() {
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let into = std::sync::Arc::clone(&seen);
        let logger = CoreLogger::new(
            log::LevelFilter::Info,
            10,
            Some(Box::new(move |line: &str| {
                into.lock().unwrap().push(line.to_owned());
            })),
        );
        record_into(&logger, log::Level::Info, TOKEN);
        assert_eq!(*seen.lock().unwrap(), vec!["INFO t: [redacted]".to_owned()]);
    }

    #[test]
    fn installs_once_at_the_build_level() {
        let _ = install(None);
        assert!(!install(None));
        assert_eq!(log::max_level(), default_level());
        #[cfg(debug_assertions)]
        assert_eq!(default_level(), log::LevelFilter::Info);
        log::warn!(target: "probe", "x {TOKEN}");
        assert!(recent_logs().contains(&"WARN probe: x [redacted]".to_owned()));
    }
}
