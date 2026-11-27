//! The log callback, in its own test binary: the core's logger installs once
//! per process.

use std::sync::{Arc, Mutex};

use dc_ffi::{LogSink, set_log_sink};

#[derive(Default)]
struct Lines(Mutex<Vec<String>>);

impl LogSink for Lines {
    fn line(&self, line: String) {
        if let Ok(mut lines) = self.0.lock() {
            lines.push(line);
        }
    }
}

#[test]
fn the_app_gets_the_cores_log_lines_with_bot_tokens_scrubbed() {
    let lines = Arc::new(Lines::default());
    assert!(set_log_sink(lines.clone()));
    log::warn!("sent with 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw");
    let got = lines.0.lock().unwrap().clone();
    assert_eq!(got.len(), 1, "{got:?}");
    assert!(got[0].starts_with("WARN "), "{got:?}");
    assert!(
        !got[0].contains("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"),
        "{got:?}"
    );
    // A second sink is refused: the first keeps the lines.
    assert!(!set_log_sink(Arc::new(Lines::default())));
}
