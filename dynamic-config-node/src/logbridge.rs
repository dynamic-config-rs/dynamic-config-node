//! The engine's stderr lines, offered to a JavaScript logger.
//!
//! Same shape as the Python bridge, same hazard driving it: the engine's
//! log sink runs on watcher threads, so it does no JavaScript at all —
//! it fires a threadsafe function whose queue is unbounded, and the
//! callback runs on the event loop whenever the loop gets there. Without
//! `setLogger` nothing changes: the engine keeps writing its
//! `[dynamic-config]` lines to stderr, which is a legitimate default in
//! Node, where no one logging module is the host's.

use std::sync::Mutex;

use napi::bindgen_prelude::Function;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

use dynamic_config::LogLevel;

type Logger = ThreadsafeFunction<(String, String), (), (String, String), napi::Status, false, true>;

static LOGGER: Mutex<Option<Logger>> = Mutex::new(None);

/// Routes the engine's diagnostics to `handler(level, line)` instead of
/// stderr. `level` is `"info"` or `"warn"`.
#[napi(js_name = "_setLogSink")]
pub fn set_log_sink(handler: Function<(String, String), ()>) -> napi::Result<()> {
    let function = handler
        .build_threadsafe_function()
        // Weak: a logger is a subscription, not a reason for the process
        // to stay up — the same rule every hook here follows.
        .weak::<true>()
        .callee_handled::<false>()
        .build()?;

    *LOGGER
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(function);

    dynamic_config::set_log_sink(|level, line| {
        let guard = LOGGER
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        if let Some(logger) = guard.as_ref() {
            let name = match level {
                LogLevel::Warn => "warn",
                _ => "info",
            };

            // Unbounded queue: `NonBlocking` sheds only when the loop
            // itself has gone away, exactly as reload hooks do.
            logger.call(
                (name.to_string(), line.to_string()),
                ThreadsafeFunctionCallMode::NonBlocking,
            );
        }
    });

    Ok(())
}

/// Back to stderr, and lets a process that only logged stay exitable.
#[napi(js_name = "_clearLogSink")]
pub fn clear_log_sink() {
    dynamic_config::clear_log_sink();

    LOGGER
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
}

/// The engine-side volume: `"off"`, `"warn"` or `"info"`.
#[napi(js_name = "_setLogLevel")]
pub fn set_log_level(level: String) -> napi::Result<()> {
    let mapped = match level.as_str() {
        "off" => LogLevel::Off,
        "warn" => LogLevel::Warn,
        "info" => LogLevel::Info,
        other => {
            return Err(napi::Error::from_reason(format!(
                "unknown log level {other:?}: one of \"off\", \"warn\", \"info\""
            )))
        }
    };

    dynamic_config::set_log_level(mapped);

    Ok(())
}
