//! Node.js bindings for `dynamic-config`.
//!
//! The compiled half of the `dynamic-config` npm package: the engine, the
//! one place JavaScript is entered on a load, and the diagnostics. The
//! ergonomic half — the generic `DynamicConfig<T>`, the schema adapters,
//! the dotted-path reader — is TypeScript next door, because generics,
//! promises and `.d.ts` all belong there and none of them are on the fast
//! path.
//!
//! Everything crosses as a plain object. A validated document lives here
//! as `serde_json::Value` and nothing in this crate holds a JavaScript
//! reference, which is what lets the file watcher install a document with
//! the event loop asleep.

// Not `#![forbid(unsafe_code)]`, and the reason is the same one the Python
// extension gives: `#[napi]` expands to `unsafe impl` and `unsafe fn` for
// the Node-API conversions, which is the binding machinery rather than this
// repository's code. What *is* checkable is that the hand-written half has
// none, and `security.yml` checks exactly that — `grep unsafe` over `src/`,
// with the one conversion below named as the exception it is.
#![deny(unsafe_op_in_unsafe_fn)]
#![deny(missing_docs)]

use napi_derive::napi;

mod config;
mod outcome;
mod remote;
mod validate;

/// The package's own version.
#[napi(js_name = "packageVersion")]
pub fn package_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

/// The engine this binding was built against, which moves on its own
/// schedule — the same two numbers the Python binding reports.
#[napi(js_name = "engineVersion")]
pub fn engine_version() -> String {
    dynamic_config::VERSION.to_owned()
}
