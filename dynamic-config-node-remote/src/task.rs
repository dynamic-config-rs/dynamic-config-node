//! Off-loop execution: every store call leaves the event loop.
//!
//! Split from `lib.rs` when it passed sixteen hundred lines; the code is
//! unchanged. `Blocking` wraps a synchronous store, `Deferred` a closure
//! built per call, `Asynchronous` one that drives its own future — and
//! `drive` is the one place a future is block_on'd, on the libuv thread
//! pool rather than the loop.

use super::*;

/// One blocking store's fetch, on a worker thread.
///
/// `pub` because it names an `AsyncTask` in a public signature, and for no
/// other reason: nothing outside this crate can construct or drive one.
pub struct Blocking(pub(crate) Box<dyn RemoteSource>);

/// A store that is *built* on the worker thread and then read.
///
/// The difference matters exactly once, and it is the whole reason
/// `tokenFn` works: building is where a rotating credential is minted, and
/// minting reaches the event loop. A store built on the JavaScript thread
/// and read later would carry the token it had when it was made.
pub struct Deferred(pub(crate) Box<dyn Fn() -> Result<Fetched, Error> + Send>);

impl Task for Deferred {
    type Output = Value;
    type JsValue = Json;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(match (self.0)() {
            Ok(fetched) => ok(document(&fetched)),
            Err(error) => failed(&error),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(Json(output))
    }
}

impl Task for Blocking {
    type Output = Value;
    type JsValue = Json;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(match self.0.fetch() {
            Ok(fetched) => ok(document(&fetched)),
            Err(error) => failed(&error),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(Json(output))
    }
}

/// The same for a store whose client is async. `pub` as above.
///
/// A runtime per fetch rather than a shared one: a fetch is seconds apart
/// at most and the runtime is threads, not connections — and a shared one
/// would have to outlive an addon that Node may unload.
pub struct Asynchronous(pub(crate) Box<dyn Fn() -> Result<Fetched, Error> + Send>);

impl Task for Asynchronous {
    type Output = Value;
    type JsValue = Json;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(match (self.0)() {
            Ok(fetched) => ok(document(&fetched)),
            Err(error) => failed(&error),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(Json(output))
    }
}

/// Drives an async store's fetch to completion, on the worker thread that
/// is already blocked for it.
pub(crate) fn drive<F>(future: F) -> Result<Fetched, Error>
where
    F: std::future::Future<Output = Result<Fetched, Error>>,
{
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .map_err(|failure| Error::remote(format!("no runtime for the fetch: {failure}")))?
        .block_on(future)
}

/// How a store was told which keys to read.
pub(crate) enum Shape {
    One(String),
    Several(Vec<String>),
    Prefix(String),
}

impl Shape {
    /// `key`, `keys` or `prefix` — exactly one of the three.
    pub(crate) fn of(
        key: Option<String>,
        keys: Option<Vec<String>>,
        prefix: Option<String>,
    ) -> Result<Self, Error> {
        match (key, keys, prefix) {
            (Some(one), None, None) => Ok(Self::One(one)),
            (None, Some(several), None) => Ok(Self::Several(several)),
            (None, None, Some(under)) => Ok(Self::Prefix(under)),
            _ => Err(Error::remote(
                "a store reads one `key`, a list of `keys`, or everything \
                 under a `prefix` — exactly one of the three",
            )),
        }
    }
}

// ── TLS, and credentials that rotate ──────────────────────────────────
