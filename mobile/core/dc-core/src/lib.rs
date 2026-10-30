//! DaemonClient's mobile core: everything below the UI of the Photos and
//! Drive apps. See docs/mobile/SPEC.md §4.

pub mod chunk_plan;
mod core;
pub mod crypto;
mod error;
pub(crate) mod http;
pub mod logging;
mod secret;
pub mod session;
pub mod worker;

pub use crate::core::{Core, CoreConfig, TELEGRAM_API};
pub use crate::error::CoreError;
pub use crate::secret::Secret;

/// This crate's version, shown in the apps so a build can be traced to a commit.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
