//! A remote store written in JavaScript.
//!
//! The same door the Python binding opens: anything that can answer with a
//! document is a source here, so a store this repository does not ship —
//! an internal HTTP service, a database table, a feature-flag vendor — is
//! a function rather than a fork.
//!
//! ```js
//! config.setRemote(
//!   () => ({ text: JSON.stringify(await fetchFromWherever()), format: "json" }),
//!   "our config service",
//! )
//! ```
//!
//! The fetch runs where the refresh runs — a worker thread — and reaches
//! JavaScript the way validation does: through a `ThreadsafeFunction`,
//! blocking until the loop answers. What crosses is text and a format
//! name, never a JavaScript object with a lifetime.

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dynamic_config::{Error, Fetched, Format, RemoteSource};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;

use crate::validate::Callable;
use serde_json::Value;

/// As long as a validation may take, for the same reason.
const PATIENCE: Duration = Duration::from_secs(30);

/// What a JavaScript source is, from the engine's side.
///
/// Kept behind a lock rather than moved into the engine, because
/// `setRemote` may replace it and the engine's slot is `&'static`.
#[derive(Default)]
pub(crate) struct JsSource {
    fetch: Mutex<Option<Arc<Callable<(), Value>>>>,
    described: Mutex<Option<String>>,
}

impl JsSource {
    pub(crate) fn install(&self, fetch: Callable<(), Value>, described: String) {
        // An `Arc` because a `ThreadsafeFunction` is not `Clone`, and the
        // lock has to be let go before the call: a fetch waits on the event
        // loop, and holding a lock across that would stop `setRemote` from
        // replacing a source that has stopped answering.
        *self
            .fetch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Arc::new(fetch));
        *self
            .described
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(described);
    }

    pub(crate) fn describe(&self) -> Option<String> {
        self.described
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

/// The engine's view of it. One per configuration, held in an `Arc` so the
/// `&'static` slot the engine keeps never owns anything JavaScript.
pub(crate) struct Shim(pub(crate) Arc<JsSource>);

impl RemoteSource for Shim {
    fn fetch(&self) -> Result<Fetched, Error> {
        let held = self
            .0
            .fetch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        let Some(fetch) = held.as_ref().map(Arc::clone) else {
            return Err(Error::remote(
                "no remote source is installed; call `setRemote` first",
            ));
        };

        drop(held);

        let (answer, wait) = mpsc::channel();

        let status = fetch.call_with_return_value(
            (),
            ThreadsafeFunctionCallMode::Blocking,
            move |outcome, _env| {
                let _ = answer.send(match outcome {
                    Ok(value) => Ok(value),
                    Err(failure) => Err(failure.reason.clone()),
                });

                Ok(())
            },
        );

        if status != napi::Status::Ok {
            return Err(Error::remote(format!(
                "the remote source could not be reached ({status}); the \
                 event loop this configuration was created on has gone away"
            )));
        }

        let answered = match wait.recv_timeout(PATIENCE) {
            Ok(Ok(value)) => value,
            Ok(Err(message)) => return Err(Error::remote(message)),
            Err(_) => {
                return Err(Error::remote(
                    "the remote source did not answer within 30 seconds",
                ))
            }
        };

        // A source answers `{ text, format }` — the same two things
        // `Fetched` is, and the same two the Python binding asks for. A
        // Promise cannot be awaited from here, so an async source resolves
        // it on the JavaScript side; the facade says so in one sentence.
        let text = answered
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                Error::remote(
                    "a remote source answers `{ text, format }`; this one \
                     gave no `text` string. An `async` source has to be \
                     resolved before it answers — see `setRemote`",
                )
            })?
            .to_owned();

        let format = match answered.get("format").and_then(Value::as_str) {
            Some("json") => Format::Json,
            Some("toml") => Format::Toml,
            Some("yaml") => Format::Yaml,
            Some(other) => {
                return Err(Error::remote(format!(
                    "`{other}` is not a format; it is \"json\", \"toml\" or \"yaml\""
                )))
            }
            None => {
                return Err(Error::remote(
                    "a remote source answers `{ text, format }`; this one gave no `format`",
                ))
            }
        };

        Ok(Fetched::new(text, format))
    }

    fn describe(&self) -> String {
        self.0
            .describe()
            .unwrap_or_else(|| "a remote source written in JavaScript".to_owned())
    }
}
