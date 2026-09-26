//! Shared core for scratchpad: the draft model, storage, titles, search, and
//! the daemon's wire protocol. The daemon uses it today; the iOS app will
//! embed it later. See docs/design.md.

pub mod draft;
pub mod paths;
pub mod protocol;
pub mod render;
pub mod search;
pub mod store;
pub mod title;
