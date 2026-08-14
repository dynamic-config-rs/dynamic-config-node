//! How a failure crosses the boundary: as a value, not as a throw.
//!
//! The engine's errors carry a kind, a key path and an origin, and a Node
//! program branches on those exactly as a Python one branches on an
//! exception class. Node-API gives no way to attach fields to a rejection
//! from a worker thread — the `Env` a rich error object needs does not
//! exist there — so nothing here throws: every fallible call answers with
//! `{ ok: true, value }` or `{ ok: false, error: { kind, path, … } }`, and
//! the TypeScript facade turns the second into a `DynamicConfigError` with
//! those fields on it.
//!
//! The union never reaches a caller. It is the wire between two halves of
//! one package, and the alternative — a bare `Error` whose message is the
//! only structured thing about it — is what a Node library usually ships
//! and what this one is trying not to.

use dynamic_config::{Error, Origin};
use serde_json::{json, Value};

/// The kind, as the name a program compares against.
///
/// The same strings the Python binding's exception classes are named for,
/// minus the `Error` suffix a JS `code` does not want: `io`, `parse`,
/// `missing`, `type`, `env`, `invalid`, `remote`, `auth`, `decrypt`,
/// `backend`.
fn kind_of(error: &Error) -> &'static str {
    error.kind().as_str()
}

/// An origin as a pair, so a caller can ask *where* without parsing prose.
pub(crate) fn origin_parts(origin: &Origin) -> (&'static str, Option<String>) {
    match origin {
        Origin::File(path) => ("file", Some(path.display().to_string())),
        Origin::Env(name) => ("env", Some(name.clone())),
        Origin::Inline => ("inline", None),
        Origin::Remote(store) => ("remote", Some(store.clone())),
        Origin::Runtime(layer) => ("runtime", Some((*layer).to_owned())),
        Origin::Unknown => ("unknown", None),
        // `Origin` is `#[non_exhaustive]`: one this binding predates reads
        // as unknown, which is what it is from here.
        _ => ("unknown", None),
    }
}

/// A value that arrived.
pub(crate) fn ok(value: Value) -> Value {
    json!({ "ok": true, "value": value })
}

/// Nothing arrived, and why.
pub(crate) fn failed(error: &Error) -> Value {
    let (origin_kind, origin) = origin_parts(error.origin());

    json!({
        "ok": false,
        "error": {
            "kind": kind_of(error),
            "path": error.path(),
            "originKind": origin_kind,
            "origin": origin,
            "message": error.to_string(),
        }
    })
}

/// A refusal this binding makes rather than the engine: a validator that
/// threw, a lock that was poisoned, a call made before `init`.
pub(crate) fn refused(kind: &str, message: impl Into<String>) -> Value {
    json!({
        "ok": false,
        "error": {
            "kind": kind,
            "path": "",
            "originKind": "unknown",
            "origin": Value::Null,
            "message": message.into(),
        }
    })
}

/// `Result` → the union, for the calls that have one.
pub(crate) fn from_result<T: Into<Value>>(outcome: Result<T, Error>) -> Value {
    match outcome {
        Ok(value) => ok(value.into()),
        Err(error) => failed(&error),
    }
}

/// A JSON document, as a value Node-API can name.
///
/// `serde_json::Value` already converts in both directions — that is what
/// the `serde-json` feature buys — but an async task's answer must also
/// *name* its type for the generated `.d.ts`, and a foreign type cannot.
/// One newtype, and the whole boundary stays plain objects rather than
/// strings somebody has to parse.
pub struct Json(pub(crate) Value);

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
