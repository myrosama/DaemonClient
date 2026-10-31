//! Smart loading (P1 design §5.5): a Rust port of Nuke's image-pipeline
//! scheduling (MIT, kean/Nuke — see NOTICE) plus the rules SPEC §4.9 adds.

use std::time::Duration;

pub mod bucket;
pub mod shell;
pub mod state;

pub use shell::{Fetch, Permit, Scheduler, Ticket};

/// Who is waiting, highest last (D17: what the user opened goes first).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Class {
    /// Upload parts, prefetch, cache warming.
    Background,
    /// Thumbnails on screen — newest request first.
    Visible,
    /// The next video part; the photos either side of the opened one.
    Next,
    /// The tapped photo, the video part at the playhead.
    Opened,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A Telegram download: shared between requests, rate limited.
    Read,
    /// One upload part: never shared; paced by the Telegram client itself.
    Send,
}

/// Starting values (SPEC §4.9), measured in Task 1.8. Set in code, not by
/// users: `reads_per_sec` > 0, `read_burst` ≥ 1, `max_running` > `reserved_high`.
#[derive(Debug, Clone)]
pub struct Limits {
    pub max_running: usize,
    /// Slots only the opened item may take (SPEC §4.9: it never waits for one).
    pub reserved_high: usize,
    pub max_next: usize,
    pub max_background: usize,
    pub max_sending: usize,
    pub reads_per_sec: f64,
    pub read_burst: f64,
    /// A job that takes longer fails (a slow trickle keeps resetting read timeouts).
    pub job_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_running: 6,
            reserved_high: 1,
            max_next: 2,
            max_background: 2,
            max_sending: 1,
            reads_per_sec: 20.0,
            read_burst: 10.0,
            job_timeout: Duration::from_secs(300),
        }
    }
}
