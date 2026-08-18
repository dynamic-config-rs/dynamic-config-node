//! The eight Rust stores, for the Node binding.
//!
//! A second package for the reason they are a second wheel in Python: a
//! gRPC stack, an AWS SDK and three HTTP clients in every `npm install
//! dynamic-config` is not a default anybody asked for. `npm install
//! dynamic-config-node-remote` is the opt-in.
//!
//! # What a store is here
//!
//! One class per store, each with the same two methods: an **async**
//! `fetch()` that answers `{ text, format }`, and `describe()`. That is
//! exactly the shape the base package's `setRemote` takes, so the two
//! packages meet through a documented surface rather than through each
//! other's internals — and a store from here is indistinguishable from one
//! somebody wrote in JavaScript.
//!
//! ```js
//! import { DynamicConfig } from "dynamic-config-node"
//! import { Etcd, useStore } from "dynamic-config-node-remote"
//!
//! const config = new DynamicConfig({ key: "db" })
//! const store = new Etcd(["http://127.0.0.1:2379"], "myapp/db.json")
//!
//! // Fetches, installs, and hands back the handle a later refresh needs.
//! const handle = await useStore(config, store)
//!
//! await handle.refresh()   // later, on a timer or a signal
//! ```
//!
//! `useStore` is a free function rather than a method because the base
//! package does not know this one exists — the two meet at `setRemote`,
//! and nowhere else.
//!
//! `fetch()` is async because a network round trip must not sit on the
//! event loop; `useStore` is what turns that into the synchronous answer
//! `setRemote` needs, by keeping the last one.
//!
//! # What is here, and what is not
//!
//! Every store's **address, keys, format and timeout**; the credential
//! each one takes, as a string or as a function called per fetch when it
//! rotates; TLS material as file paths or as bytes; and, for the four
//! stores whose protocol can push, a `watch()` that calls you when the key
//! moves.
//!
//! What is deliberately not here: a watch for the four stores that cannot
//! push (S3, Git, Firestore, Vault). Polling them is a `setInterval`
//! around `handle.refresh()`, and a loop this package hid inside a thread
//! would be the same loop with its period out of the caller's reach.

#![deny(missing_docs)]
#![deny(unsafe_op_in_unsafe_fn)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use dynamic_config::{AsyncRemoteSource, Error, Fetched, Format, RemoteSource};
use dynamic_config_store_core::tls::TlsConfig;
use napi::bindgen_prelude::{AsyncTask, Function, Task};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Env;
use napi_derive::napi;
use serde_json::{json, Value};

/// A JavaScript function the store may call from any thread, named for the
/// same reason the base package names its own: six type parameters.
type Callable<T, R> = ThreadsafeFunction<T, R, T, napi::Status, false, true>;

/// A JSON document, as a value Node-API can name — the same newtype the
/// base package needs, for the same reason.
pub struct Json(Value);

impl napi::bindgen_prelude::TypeName for Json {
    fn type_name() -> &'static str {
        "unknown"
    }

    fn value_type() -> napi::ValueType {
        napi::ValueType::Object
    }
}

impl napi::bindgen_prelude::ToNapiValue for Json {
    unsafe fn to_napi_value(
        env: napi::sys::napi_env,
        value: Self,
    ) -> napi::Result<napi::sys::napi_value> {
        unsafe { Value::to_napi_value(env, value.0) }
    }
}

/// The union every call answers with, exactly as the base package's does.
fn ok(value: Value) -> Value {
    json!({ "ok": true, "value": value })
}

fn failed(error: &Error) -> Value {
    json!({
        "ok": false,
        "error": {
            "kind": error.kind().as_str(),
            "path": error.path(),
            "originKind": "remote",
            "origin": Value::Null,
            "message": error.to_string(),
        }
    })
}

/// A document, as the base package's `setRemote` reads it.
fn document(fetched: &Fetched) -> Value {
    json!({
        "text": fetched.text,
        // `Format::feature()` names any variant — the wildcard the 0.7
        // migration guide prescribes, so the next format is not a break
        // here either.
        "format": fetched.format.feature(),
    })
}

/// A format name, or a refusal naming what it was.
fn format_of(name: &str) -> Result<Format, Error> {
    match name {
        "json" => Ok(Format::Json),
        "toml" => Ok(Format::Toml),
        "yaml" | "yml" => Ok(Format::Yaml),
        "ini" => Ok(Format::Ini),
        "properties" => Ok(Format::Properties),
        other => Err(Error::remote(format!(
            "`{other}` is not a format; it is \"json\", \"toml\", \"yaml\", \
             \"ini\" or \"properties\""
        ))),
    }
}

fn seconds(timeout: Option<u32>) -> Option<Duration> {
    timeout.map(|milliseconds| Duration::from_millis(u64::from(milliseconds)))
}

mod stores;
mod task;
mod tls;
mod watching;

pub use stores::*;
pub(crate) use task::*;
pub use tls::*;
pub use watching::*;

/// The package's own version.
#[napi(js_name = "packageVersion")]
pub fn package_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

/// The engine this package was built against.
#[napi(js_name = "engineVersion")]
pub fn engine_version() -> String {
    dynamic_config::VERSION.to_owned()
}
