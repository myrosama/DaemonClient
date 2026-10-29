//! The hand-written bindings. `frb_generated.rs` needs `unsafe` and its
//! decoder unwraps, so the crate cannot take the workspace lints; this module
//! — everything we write by hand — holds itself to them instead.
#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

pub mod core;
