//! DaemonClient's mobile core: everything below the UI of the Photos and
//! Drive apps. See docs/mobile/SPEC.md §4.

pub mod chunk_plan;

/// This crate's version, shown in the apps so a build can be traced to a commit.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
