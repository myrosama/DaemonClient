//! DaemonClient's mobile core: everything below the UI of the Photos and
//! Drive apps. See docs/mobile/SPEC.md §4.

pub mod chunk_plan;
mod core;
pub mod crypto;
mod disk_cache;
mod error;
pub mod http;
pub mod logging;
pub mod media_server;
pub mod reader;
pub mod sched;
mod secret;
pub mod session;
pub mod telegram;
pub mod worker;

pub use crate::core::{Core, CoreConfig, TELEGRAM_API};
pub use crate::error::CoreError;
pub use crate::secret::Secret;

/// This crate's version, shown in the apps so a build can be traced to a commit.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
