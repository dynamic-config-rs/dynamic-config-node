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
        "format": match fetched.format {
            Format::Json => "json",
            Format::Toml => "toml",
            Format::Yaml => "yaml",
        },
    })
}

/// `"json"` | `"toml"` | `"yaml"`, or a refusal naming what it was.
fn format_of(name: &str) -> Result<Format, Error> {
    match name {
        "json" => Ok(Format::Json),
        "toml" => Ok(Format::Toml),
        "yaml" | "yml" => Ok(Format::Yaml),
        other => Err(Error::remote(format!(
            "`{other}` is not a format; it is \"json\", \"toml\" or \"yaml\""
        ))),
    }
}

fn seconds(timeout: Option<u32>) -> Option<Duration> {
    timeout.map(|milliseconds| Duration::from_millis(u64::from(milliseconds)))
}

/// One blocking store's fetch, on a worker thread.
///
/// `pub` because it names an `AsyncTask` in a public signature, and for no
/// other reason: nothing outside this crate can construct or drive one.
pub struct Blocking(Box<dyn RemoteSource>);

/// A store that is *built* on the worker thread and then read.
///
/// The difference matters exactly once, and it is the whole reason
/// `tokenFn` works: building is where a rotating credential is minted, and
/// minting reaches the event loop. A store built on the JavaScript thread
/// and read later would carry the token it had when it was made.
pub struct Deferred(Box<dyn Fn() -> Result<Fetched, Error> + Send>);

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
pub struct Asynchronous(Box<dyn Fn() -> Result<Fetched, Error> + Send>);

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
fn drive<F>(future: F) -> Result<Fetched, Error>
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
enum Shape {
    One(String),
    Several(Vec<String>),
    Prefix(String),
}

impl Shape {
    /// `key`, `keys` or `prefix` — exactly one of the three.
    fn of(
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

/// TLS material, as a caller hands it over.
///
/// Files *and* bytes, because both are real: a Kubernetes secret is a
/// mounted file, and a certificate fetched from a vault at startup is
/// bytes that never touch a disk. The store crates take either, and this
/// is the same choice one argument list further out.
#[napi(object)]
#[derive(Default)]
pub struct Tls {
    /// A private certificate authority, as a path.
    pub ca_certificate_file: Option<String>,
    /// The same, as PEM bytes.
    pub ca_certificate_pem: Option<String>,
    /// A client certificate and its key, as paths.
    pub client_certificate_file: Option<String>,
    /// The key that goes with it.
    pub client_key_file: Option<String>,
    /// The same pair, as PEM bytes.
    pub client_certificate_pem: Option<String>,
    /// The key that goes with it.
    pub client_key_pem: Option<String>,
}

impl Tls {
    /// The store crates' own configuration, or `None` when nothing was
    /// said — which means *the platform's trust store*, not *no TLS*.
    ///
    /// Half a client identity is refused rather than ignored: a
    /// deployment that meant mTLS and typed one of the two field names
    /// would otherwise connect with no certificate at all and be told by
    /// the server that its *permissions* are wrong.
    fn resolved(&self) -> Result<Option<TlsConfig>, Error> {
        for (certificate, key, kind) in [
            (
                self.client_certificate_file.is_some(),
                self.client_key_file.is_some(),
                "clientCertificateFile/clientKeyFile",
            ),
            (
                self.client_certificate_pem.is_some(),
                self.client_key_pem.is_some(),
                "clientCertificatePem/clientKeyPem",
            ),
        ] {
            if certificate != key {
                return Err(Error::auth(format!(
                    "a client certificate needs both halves: `{kind}` were \
                     given one at a time, and a store that connected \
                     without an identity would be refused by the server as \
                     a permissions problem instead"
                )));
            }
        }

        let mut config = TlsConfig::new();
        let mut said = false;

        if let Some(path) = &self.ca_certificate_file {
            config = config.with_ca_certificate_file(path.clone());
            said = true;
        }
        if let Some(pem) = &self.ca_certificate_pem {
            config = config.with_ca_certificate_pem(pem.clone().into_bytes());
            said = true;
        }
        if let (Some(certificate), Some(key)) =
            (&self.client_certificate_file, &self.client_key_file)
        {
            config = config.with_client_certificate_files(certificate.clone(), key.clone());
            said = true;
        }
        if let (Some(certificate), Some(key)) = (&self.client_certificate_pem, &self.client_key_pem)
        {
            config = config.with_client_certificate_pem(
                certificate.clone().into_bytes(),
                key.clone().into_bytes(),
            );
            said = true;
        }

        Ok(said.then_some(config))
    }
}

/// A credential that is a *function* rather than a string.
///
/// The string form is right for a token an operator pasted into a
/// deployment. It is wrong for every credential that rotates — a
/// projected service-account token the kubelet rewrites, an OIDC id token
/// a daemon refreshes, a Vault token with a two-hour lease — because a
/// store built once holds the value it was given until the process ends.
///
/// So a credential may be a function, and it is called **on the event
/// loop before each fetch**: the loop is where a caller's `readFileSync`,
/// their AWS SDK or their own cache lives, and a value read there is the
/// current one by construction.
#[derive(Clone)]
struct Rotating(Option<Arc<Callable<(), String>>>);

impl Rotating {
    /// Builds one from whatever the constructor was handed.
    fn of(token: Option<Function<(), String>>) -> napi::Result<Self> {
        Ok(Self(match token {
            Some(function) => Some(Arc::new(
                function
                    .build_threadsafe_function()
                    .weak::<true>()
                    .callee_handled::<false>()
                    .build()?,
            )),
            None => None,
        }))
    }

    /// The current value, or `None` when no function was given.
    ///
    /// Blocks the worker thread on the loop, the way the base package's
    /// validator does and for the same reason: the answer is needed
    /// *before* the request that carries it.
    fn current(&self) -> Result<Option<String>, Error> {
        let Some(mint) = &self.0 else {
            return Ok(None);
        };

        let (answer, wait) = std::sync::mpsc::channel();

        let status = mint.call_with_return_value(
            (),
            ThreadsafeFunctionCallMode::Blocking,
            move |outcome, _env| {
                let _ = answer.send(match outcome {
                    Ok(token) => Ok(token),
                    Err(failure) => Err(failure.reason.clone()),
                });

                Ok(())
            },
        );

        if status != napi::Status::Ok {
            return Err(Error::auth(format!(
                "the credential function could not be reached ({status}); the \
                 event loop this store was created on has gone away"
            )));
        }

        match wait.recv_timeout(PATIENCE) {
            Ok(Ok(token)) => Ok(Some(token)),
            Ok(Err(message)) => Err(Error::auth(message)),
            Err(_) => Err(Error::auth(
                "the credential function did not answer within 30 seconds",
            )),
        }
    }
}

/// As long as a fetch may wait on the loop for a credential.
const PATIENCE: std::time::Duration = std::time::Duration::from_secs(30);

// ── Watching ──────────────────────────────────────────────────────────

/// A running watch, and the handle that ends it.
///
/// The loop runs on a thread of its own — a blocking query, a
/// subscription, a gRPC stream — and reaches the event loop only to
/// deliver, through a `ThreadsafeFunction`. That is the base package's
/// arrangement for the file watcher, and this is the same one for a store:
/// a program that watches does not have to be structured around watching.
///
/// **What this is not** is the engine installing the document. A store
/// watch here hands you a document; `useStore` in the JavaScript half is
/// what puts it into a configuration. Keeping those apart is what lets a
/// caller log a change, or refuse one, without the engine having already
/// acted on it.
#[napi]
pub struct Watching {
    stop: Arc<dynamic_config::RemoteWatch>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

#[napi]
impl Watching {
    /// Starts `run` on a thread, delivering through the loop.
    fn spawn<F>(
        on_change: Function<Value, ()>,
        on_error: Option<Function<Value, ()>>,
        run: F,
    ) -> napi::Result<Self>
    where
        F: FnOnce(
                &dynamic_config::Watching,
                &mut dyn FnMut(Fetched) -> Result<(), Error>,
            ) -> Result<(), Error>
            + Send
            + 'static,
    {
        let deliver: Callable<Value, ()> = on_change
            .build_threadsafe_function()
            .weak::<true>()
            .callee_handled::<false>()
            .build()?;

        let failed: Option<Callable<Value, ()>> = match on_error {
            Some(function) => Some(
                function
                    .build_threadsafe_function()
                    .weak::<true>()
                    .callee_handled::<false>()
                    .build()?,
            ),
            None => None,
        };

        let watch = Arc::new(dynamic_config::RemoteWatch::new());
        let watching = watch.watching();

        let thread = std::thread::spawn(move || {
            let mut hand_over = move |fetched: Fetched| -> Result<(), Error> {
                // Non-blocking: a delivery the loop cannot take is a loop
                // that has gone away, and a watch loop is not the place to
                // find that out.
                deliver.call(document(&fetched), ThreadsafeFunctionCallMode::NonBlocking);

                Ok(())
            };

            if let Err(error) = run(&watching, &mut hand_over) {
                // A watch that ended is a configuration that has stopped
                // updating, so it is reported rather than swallowed — with
                // the same shape every other failure crosses in.
                if let Some(failed) = &failed {
                    failed.call(
                        failed_value(&error),
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                }
            }
        });

        Ok(Self {
            stop: watch,
            thread: Mutex::new(Some(thread)),
        })
    }

    /// Starts an **async** store's watch on a thread with a runtime.
    ///
    /// etcd and NATS are streaming clients: their watch is a future rather
    /// than a loop with a stop flag in it, so stopping is dropping the
    /// future — which is what the select below does when the handle says
    /// so. The flag is polled rather than awaited because `Watching` is
    /// the blocking stores' shape and one type of handle is better than
    /// two.
    fn spawn_async<F, Fut>(
        on_change: Function<Value, ()>,
        on_error: Option<Function<Value, ()>>,
        run: F,
    ) -> napi::Result<Self>
    where
        F: FnOnce(Box<dyn FnMut(Fetched) -> Result<(), Error> + Send>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<(), Error>>,
    {
        let deliver: Callable<Value, ()> = on_change
            .build_threadsafe_function()
            .weak::<true>()
            .callee_handled::<false>()
            .build()?;

        let failed: Option<Callable<Value, ()>> = match on_error {
            Some(function) => Some(
                function
                    .build_threadsafe_function()
                    .weak::<true>()
                    .callee_handled::<false>()
                    .build()?,
            ),
            None => None,
        };

        let watch = Arc::new(dynamic_config::RemoteWatch::new());
        let watching = watch.watching();

        let thread = std::thread::spawn(move || {
            let hand_over = move |fetched: Fetched| -> Result<(), Error> {
                deliver.call(document(&fetched), ThreadsafeFunctionCallMode::NonBlocking);

                Ok(())
            };

            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .worker_threads(1)
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(failure) => {
                    if let Some(failed) = &failed {
                        failed.call(
                            failed_value(&Error::remote(format!(
                                "no runtime for the watch: {failure}"
                            ))),
                            ThreadsafeFunctionCallMode::NonBlocking,
                        );
                    }

                    return;
                }
            };

            let outcome = runtime.block_on(async move {
                tokio::select! {
                    ended = run(Box::new(hand_over)) => ended,
                    () = async {
                        while watching.keep_going() {
                            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        }
                    } => Ok(()),
                }
            });

            if let Err(error) = outcome {
                if let Some(failed) = &failed {
                    failed.call(
                        failed_value(&error),
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                }
            }
        });

        Ok(Self {
            stop: watch,
            thread: Mutex::new(Some(thread)),
        })
    }

    /// Ends the watch, and resolves when the loop has actually stopped.
    ///
    /// **Asynchronous, and that is the whole design.** A watch loop is
    /// inside a network request for most of its life — Consul holds a
    /// blocking query open for the wait it was given — so joining its
    /// thread from a synchronous method would park the event loop for as
    /// long as that request takes. Waiting matters, though: a stopped
    /// watch whose thread is still in a request is a watch that can
    /// deliver *after* `stop()` returned. So the join happens on a worker
    /// thread and the promise is how a caller waits for it.
    ///
    /// Idempotent: stopping twice is one stop and a resolved promise.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn stop(&self) -> AsyncTask<Stopping> {
        self.stop.stop();

        AsyncTask::new(Stopping(
            self.thread
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take(),
        ))
    }
}

/// Waiting for a stopped watch's thread, off the event loop.
pub struct Stopping(Option<std::thread::JoinHandle<()>>);

impl Task for Stopping {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        if let Some(thread) = self.0.take() {
            let _ = thread.join();
        }

        Ok(())
    }

    fn resolve(&mut self, _env: Env, (): Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

/// The failure union, for the error callback.
fn failed_value(error: &Error) -> Value {
    failed(error)
}

// ── Consul ────────────────────────────────────────────────────────────

/// Consul's key/value store.
#[napi]
pub struct Consul {
    address: String,
    shape: Option<Shape>,
    format: Option<Format>,
    token: Option<String>,
    rotating: Rotating,
    tls: Option<TlsConfig>,
    timeout: Option<Duration>,
    described: String,
}

#[napi]
impl Consul {
    /// `(address, key | keys | prefix, format?, token?, tokenFn?, tls?, timeoutMs?)`
    ///
    /// `token` is a string somebody pasted into a deployment; `tokenFn` is
    /// a function called on the event loop before each fetch, for a
    /// credential that rotates. Give one or the other.
    #[napi(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        address: String,
        key: Option<String>,
        keys: Option<Vec<String>>,
        prefix: Option<String>,
        format: Option<String>,
        token: Option<String>,
        token_fn: Option<Function<(), String>>,
        tls: Option<Tls>,
        timeout_ms: Option<u32>,
    ) -> napi::Result<Self> {
        let shape = Shape::of(key, keys, prefix)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let format = match format {
            Some(name) => Some(
                format_of(&name).map_err(|error| napi::Error::from_reason(error.to_string()))?,
            ),
            None => None,
        };

        Ok(Self {
            described: format!("consul {address}"),
            address,
            shape: Some(shape),
            format,
            token,
            rotating: Rotating::of(token_fn)?,
            tls: tls
                .unwrap_or_default()
                .resolved()
                .map_err(|error| napi::Error::from_reason(error.to_string()))?,
            timeout: seconds(timeout_ms),
        })
    }

    /// Reads the document. A network round trip, on a worker thread.
    #[napi(ts_return_type = "Promise<Outcome<Document>>")]
    pub fn fetch(&self) -> AsyncTask<Deferred> {
        let address = self.address.clone();
        let shape = self.shape_parts();
        let format = self.format;
        let token = self.token.clone();
        let rotating = self.rotating.clone();
        let tls = self.tls.clone();
        let timeout = self.timeout;

        AsyncTask::new(Deferred(Box::new(move || {
            let mut source =
                dynamic_config_consul::Consul::new(address.clone(), consul_keys(&shape));

            if let Some(format) = format {
                source = source.with_format(format);
            }
            if let Some(token) = rotating.current()?.or_else(|| token.clone()) {
                source = source.with_token(token);
            }
            if let Some(tls) = &tls {
                source = source.with_tls(tls.clone());
            }
            if let Some(timeout) = timeout {
                source = source.with_timeout(timeout);
            }

            source.fetch()
        })))
    }

    /// Follows the key with a **blocking query**: Consul holds the request
    /// open until the value moves, so this is change-driven rather than a
    /// poll.
    ///
    /// `onChange` is called on the event loop with each document. The
    /// returned handle's `stop()` ends the loop; it is idempotent, and a
    /// program that never calls it keeps the watch for its own lifetime.
    #[napi]
    pub fn watch(
        &self,
        on_change: Function<Value, ()>,
        on_error: Option<Function<Value, ()>>,
    ) -> napi::Result<Watching> {
        let address = self.address.clone();
        let shape = self.shape_parts();
        let format = self.format;
        let token = self.token.clone();
        let rotating = self.rotating.clone();
        let tls = self.tls.clone();
        let timeout = self.timeout;

        Watching::spawn(on_change, on_error, move |watching, deliver| {
            let mut source = dynamic_config_consul::Consul::new(address, consul_keys(&shape));

            if let Some(format) = format {
                source = source.with_format(format);
            }
            if let Some(token) = rotating.current()?.or_else(|| token.clone()) {
                source = source.with_token(token);
            }
            if let Some(tls) = &tls {
                source = source.with_tls(tls.clone());
            }
            if let Some(timeout) = timeout {
                source = source.with_timeout(timeout);
            }

            source.watch(watching, deliver)
        })
    }

    /// The key shape, as three plain values a thread can own.
    fn shape_parts(&self) -> (u8, String, Vec<String>) {
        match self.shape.as_ref() {
            Some(Shape::One(key)) => (0, key.clone(), Vec::new()),
            Some(Shape::Several(keys)) => (1, String::new(), keys.clone()),
            Some(Shape::Prefix(prefix)) => (2, prefix.clone(), Vec::new()),
            None => (0, String::new(), Vec::new()),
        }
    }

    /// How this store names itself in an error or a report.
    #[napi]
    pub fn describe(&self) -> String {
        self.described.clone()
    }
}

/// Consul's own `Keys`, from the three plain values above.
fn consul_keys(shape: &(u8, String, Vec<String>)) -> dynamic_config_consul::Keys {
    match shape.0 {
        1 => dynamic_config_consul::Keys::several(shape.2.clone()),
        2 => dynamic_config_consul::Keys::prefix(shape.1.clone()),
        _ => dynamic_config_consul::Keys::one(shape.1.clone()),
    }
}

// ── Vault ─────────────────────────────────────────────────────────────

/// HashiCorp Vault's KV v2 store.
#[napi]
pub struct Vault {
    address: String,
    mount: String,
    shape: Option<Shape>,
    /// Accepted and ignored: a KV v2 secret is a JSON object by
    /// construction, so there is nothing to choose. Kept as a field so a
    /// caller writing every store from one table does not have to
    /// remember the exception.
    #[allow(dead_code)]
    format: Option<Format>,
    token: Option<String>,
    rotating: Rotating,
    tls: Option<TlsConfig>,
    timeout: Option<Duration>,
    described: String,
}

#[napi]
impl Vault {
    /// `(address, mount, path | paths, format?, token?, tokenFn?, tls?, timeoutMs?)`
    ///
    /// `tokenFn` is where Vault differs from the others in practice: its
    /// tokens have leases, and a process that runs longer than one needs a
    /// credential that is *read* rather than *held*.
    #[napi(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        address: String,
        mount: String,
        path: Option<String>,
        paths: Option<Vec<String>>,
        format: Option<String>,
        token: Option<String>,
        token_fn: Option<Function<(), String>>,
        tls: Option<Tls>,
        timeout_ms: Option<u32>,
    ) -> napi::Result<Self> {
        let shape = Shape::of(path, paths, None)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let format = match format {
            Some(name) => Some(
                format_of(&name).map_err(|error| napi::Error::from_reason(error.to_string()))?,
            ),
            None => None,
        };

        Ok(Self {
            described: format!("vault {address} mount {mount}"),
            address,
            mount,
            shape: Some(shape),
            format,
            token,
            rotating: Rotating::of(token_fn)?,
            tls: tls
                .unwrap_or_default()
                .resolved()
                .map_err(|error| napi::Error::from_reason(error.to_string()))?,
            timeout: seconds(timeout_ms),
        })
    }

    /// Reads the secret. A network round trip, on a worker thread.
    #[napi(ts_return_type = "Promise<Outcome<Document>>")]
    pub fn fetch(&self) -> AsyncTask<Deferred> {
        let address = self.address.clone();
        let mount = self.mount.clone();
        let several = matches!(self.shape.as_ref(), Some(Shape::Several(_)));
        let paths = match self.shape.as_ref() {
            Some(Shape::Several(paths)) => paths.clone(),
            Some(Shape::One(path)) => vec![path.clone()],
            _ => vec![String::new()],
        };
        let token = self.token.clone();
        let rotating = self.rotating.clone();
        let tls = self.tls.clone();
        let timeout = self.timeout;

        AsyncTask::new(Deferred(Box::new(move || {
            let keys = if several {
                dynamic_config_vault::Keys::several(paths.clone())
            } else {
                dynamic_config_vault::Keys::one(paths[0].clone())
            };

            let mut source = dynamic_config_vault::Vault::new(address.clone(), mount.clone(), keys);

            // No `with_format`: a KV v2 secret is a JSON object by
            // construction, so there is nothing to choose. `format` is
            // accepted and ignored rather than refused, because every
            // other store here takes one and a caller writing them from
            // one table should not meet an exception.
            if let Some(token) = rotating.current()?.or_else(|| token.clone()) {
                source = source.with_token(token);
            }
            if let Some(tls) = &tls {
                source = source.with_tls(tls.clone());
            }
            if let Some(timeout) = timeout {
                source = source.with_timeout(timeout);
            }

            source.fetch()
        })))
    }

    /// How this store names itself in an error or a report.
    #[napi]
    pub fn describe(&self) -> String {
        self.described.clone()
    }
}

// ── Redis ─────────────────────────────────────────────────────────────

/// A Redis key, or a named list of them.
#[napi]
pub struct Redis {
    url: String,
    shape: Option<Shape>,
    format: Option<Format>,
    tls: Option<TlsConfig>,
    timeout: Option<Duration>,
    described: String,
}

#[napi]
impl Redis {
    /// `(url, key | keys | prefix, format?, tls?, timeoutMs?)`
    ///
    /// The credential rides in the URL — `redis://user:password@host` —
    /// which is where Redis puts it and where every Redis client reads it.
    #[napi(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        url: String,
        key: Option<String>,
        keys: Option<Vec<String>>,
        prefix: Option<String>,
        format: Option<String>,
        tls: Option<Tls>,
        timeout_ms: Option<u32>,
    ) -> napi::Result<Self> {
        let shape = Shape::of(key, keys, prefix)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let format = match format {
            Some(name) => Some(
                format_of(&name).map_err(|error| napi::Error::from_reason(error.to_string()))?,
            ),
            None => None,
        };

        Ok(Self {
            // The URL is *not* the description: it carries a password, and
            // a description ends up in an error message. The store crate's
            // own `describe` redacts it; this names the host and stops.
            // The URL is *not* the description: it carries a password,
            // and a description ends up in an error message. This is the
            // store crates' own redaction, so the rule is one rule.
            described: format!(
                "redis {}",
                dynamic_config_store_core::redacted(
                    &url,
                    dynamic_config_store_core::LoneAuthority::Username,
                )
            ),
            url,
            shape: Some(shape),
            format,
            tls: tls
                .unwrap_or_default()
                .resolved()
                .map_err(|error| napi::Error::from_reason(error.to_string()))?,
            timeout: seconds(timeout_ms),
        })
    }

    /// The key shape, as three plain values a thread can own.
    fn shape_parts(&self) -> (u8, String, Vec<String>) {
        match self.shape.as_ref() {
            Some(Shape::One(key)) => (0, key.clone(), Vec::new()),
            Some(Shape::Several(keys)) => (1, String::new(), keys.clone()),
            Some(Shape::Prefix(prefix)) => (2, prefix.clone(), Vec::new()),
            None => (0, String::new(), Vec::new()),
        }
    }

    /// Reads the key. A network round trip, on a worker thread.
    #[napi(ts_return_type = "Promise<Outcome<Document>>")]
    pub fn fetch(&self) -> AsyncTask<Deferred> {
        let url = self.url.clone();
        let shape = self.shape_parts();
        let format = self.format;
        let tls = self.tls.clone();
        let timeout = self.timeout;

        AsyncTask::new(Deferred(Box::new(move || {
            let mut source = redis_source(&url, &shape, &tls)?;

            if let Some(format) = format {
                source = source.with_format(format);
            }
            if let Some(timeout) = timeout {
                source = source.with_timeout(timeout);
            }

            source.fetch()
        })))
    }

    /// Follows the key with a **keyspace-notification subscription**:
    /// Redis publishes when the key moves, so this is change-driven.
    ///
    /// The server has to be publishing them — `notify-keyspace-events` —
    /// and the watch refuses at the door when it is not, which is the one
    /// failure a caller can fix from their side.
    #[napi]
    pub fn watch(
        &self,
        on_change: Function<Value, ()>,
        on_error: Option<Function<Value, ()>>,
    ) -> napi::Result<Watching> {
        let url = self.url.clone();
        let shape = self.shape_parts();
        let format = self.format;
        let tls = self.tls.clone();
        let timeout = self.timeout;

        Watching::spawn(on_change, on_error, move |watching, deliver| {
            let mut source = redis_source(&url, &shape, &tls)?;

            if let Some(format) = format {
                source = source.with_format(format);
            }
            if let Some(timeout) = timeout {
                source = source.with_timeout(timeout);
            }

            source.watch(watching, deliver)
        })
    }

    /// How this store names itself in an error or a report.
    #[napi]
    pub fn describe(&self) -> String {
        self.described.clone()
    }
}

/// A Redis source from the three plain values a thread can own.
fn redis_source(
    url: &str,
    shape: &(u8, String, Vec<String>),
    tls: &Option<TlsConfig>,
) -> Result<dynamic_config_redis::Redis, Error> {
    let keys = match shape.0 {
        1 => dynamic_config_redis::Keys::several(shape.2.clone()),
        2 => dynamic_config_redis::Keys::prefix(shape.1.clone()),
        _ => dynamic_config_redis::Keys::one(shape.1.clone()),
    };

    match tls {
        Some(tls) => dynamic_config_redis::Redis::with_tls(url, keys, tls),
        None => dynamic_config_redis::Redis::new(url, keys),
    }
}

// ── etcd ──────────────────────────────────────────────────────────────

/// An etcd v3 key/value store.
#[napi]
pub struct Etcd {
    endpoints: Vec<String>,
    shape: Option<Shape>,
    format: Option<Format>,
    username: Option<String>,
    password: Option<String>,
    timeout: Option<Duration>,
    described: String,
}

#[napi]
impl Etcd {
    /// `(endpoints, key | keys | prefix, format?, username?, password?, timeoutMs?)`
    #[napi(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        endpoints: Vec<String>,
        key: Option<String>,
        keys: Option<Vec<String>>,
        prefix: Option<String>,
        format: Option<String>,
        username: Option<String>,
        password: Option<String>,
        timeout_ms: Option<u32>,
    ) -> napi::Result<Self> {
        let shape = Shape::of(key, keys, prefix)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let format = match format {
            Some(name) => Some(
                format_of(&name).map_err(|error| napi::Error::from_reason(error.to_string()))?,
            ),
            None => None,
        };

        if username.is_some() != password.is_some() {
            return Err(napi::Error::from_reason(
                "etcd authentication needs both `username` and `password`; \
                 with one of them the connection would be anonymous and \
                 etcd would answer with a permissions error rather than an \
                 authentication one",
            ));
        }

        Ok(Self {
            described: format!("etcd {}", endpoints.join(", ")),
            endpoints,
            shape: Some(shape),
            format,
            username,
            password,
            timeout: seconds(timeout_ms),
        })
    }

    /// Reads the document. gRPC, so the fetch drives a runtime of its own.
    #[napi(ts_return_type = "Promise<Outcome<Document>>")]
    pub fn fetch(&self) -> AsyncTask<Asynchronous> {
        let endpoints = self.endpoints.clone();
        let keys = match self.shape.as_ref() {
            Some(Shape::One(key)) => dynamic_config_etcd::Keys::one(key.clone()),
            Some(Shape::Several(keys)) => dynamic_config_etcd::Keys::several(keys.clone()),
            Some(Shape::Prefix(prefix)) => dynamic_config_etcd::Keys::prefix(prefix.clone()),
            None => dynamic_config_etcd::Keys::one(String::new()),
        };
        let format = self.format;
        let credential = self.username.clone().zip(self.password.clone());
        let timeout = self.timeout;

        AsyncTask::new(Asynchronous(Box::new(move || {
            let endpoints = endpoints.clone();
            let keys = keys.clone();
            let credential = credential.clone();

            drive(async move {
                let options = match credential {
                    Some((user, password)) => etcd_options_with_user(&user, &password),
                    None => dynamic_config_etcd::ConnectOptions::new(),
                };

                let mut source =
                    dynamic_config_etcd::Etcd::with_options(endpoints, keys, options).await?;

                if let Some(format) = format {
                    source = source.with_format(format);
                }
                if let Some(timeout) = timeout {
                    source = source.with_timeout(timeout);
                }

                source.fetch().await
            })
        })))
    }

    /// Follows the key with etcd's **watch stream**: the cluster pushes,
    /// so this is change-driven and costs one connection.
    ///
    /// A prefix watch answers with *the set moved* and re-reads the range
    /// at the event's own revision, so what arrives is the state the event
    /// announced rather than whatever has landed since.
    #[napi]
    pub fn watch(
        &self,
        on_change: Function<Value, ()>,
        on_error: Option<Function<Value, ()>>,
    ) -> napi::Result<Watching> {
        let endpoints = self.endpoints.clone();
        let keys = self.etcd_keys();
        let format = self.format;
        let credential = self.username.clone().zip(self.password.clone());
        let timeout = self.timeout;

        Watching::spawn_async(on_change, on_error, move |mut deliver| async move {
            let options = match credential {
                Some((user, password)) => etcd_options_with_user(&user, &password),
                None => dynamic_config_etcd::ConnectOptions::new(),
            };

            let mut source =
                dynamic_config_etcd::Etcd::with_options(endpoints, keys, options).await?;

            if let Some(format) = format {
                source = source.with_format(format);
            }
            if let Some(timeout) = timeout {
                source = source.with_timeout(timeout);
            }

            source.watch(&mut deliver).await
        })
    }

    /// etcd's own `Keys`, from whichever shape was given.
    fn etcd_keys(&self) -> dynamic_config_etcd::Keys {
        match self.shape.as_ref() {
            Some(Shape::One(key)) => dynamic_config_etcd::Keys::one(key.clone()),
            Some(Shape::Several(keys)) => dynamic_config_etcd::Keys::several(keys.clone()),
            Some(Shape::Prefix(prefix)) => dynamic_config_etcd::Keys::prefix(prefix.clone()),
            None => dynamic_config_etcd::Keys::one(String::new()),
        }
    }

    /// How this store names itself in an error or a report.
    #[napi]
    pub fn describe(&self) -> String {
        self.described.clone()
    }
}

/// etcd's own options, with a name and password on them.
fn etcd_options_with_user(user: &str, password: &str) -> dynamic_config_etcd::ConnectOptions {
    dynamic_config_etcd::ConnectOptions::new().with_user(user.to_owned(), password.to_owned())
}

// ── NATS ──────────────────────────────────────────────────────────────

/// A NATS JetStream key/value bucket.
#[napi]
pub struct Nats {
    server: String,
    bucket: String,
    shape: Option<Shape>,
    format: Option<Format>,
    timeout: Option<Duration>,
    described: String,
}

#[napi]
impl Nats {
    /// `(server, bucket, key | keys, format?, timeoutMs?)`
    #[napi(constructor)]
    pub fn new(
        server: String,
        bucket: String,
        key: Option<String>,
        keys: Option<Vec<String>>,
        format: Option<String>,
        timeout_ms: Option<u32>,
    ) -> napi::Result<Self> {
        let shape = Shape::of(key, keys, None)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let format = match format {
            Some(name) => Some(
                format_of(&name).map_err(|error| napi::Error::from_reason(error.to_string()))?,
            ),
            None => None,
        };

        Ok(Self {
            described: format!("nats {server} bucket {bucket}"),
            server,
            bucket,
            shape: Some(shape),
            format,
            timeout: seconds(timeout_ms),
        })
    }

    /// Reads the document. A streaming client, so the fetch drives a
    /// runtime of its own.
    #[napi(ts_return_type = "Promise<Outcome<Document>>")]
    pub fn fetch(&self) -> AsyncTask<Asynchronous> {
        let server = self.server.clone();
        let bucket = self.bucket.clone();
        let keys = match self.shape.as_ref() {
            Some(Shape::Several(keys)) => dynamic_config_nats::Keys::several(keys.clone()),
            Some(Shape::One(key)) => dynamic_config_nats::Keys::one(key.clone()),
            _ => dynamic_config_nats::Keys::one(String::new()),
        };
        let format = self.format;
        let timeout = self.timeout;

        AsyncTask::new(Asynchronous(Box::new(move || {
            let server = server.clone();
            let bucket = bucket.clone();
            let keys = keys.clone();

            drive(async move {
                let mut source = dynamic_config_nats::Nats::new(server, bucket, keys).await?;

                if let Some(format) = format {
                    source = source.with_format(format);
                }
                if let Some(timeout) = timeout {
                    source = source.with_timeout(timeout);
                }

                source.fetch().await
            })
        })))
    }

    /// Follows the key with JetStream's **watch**: the server pushes, and
    /// `async-nats` reconnects on its own — so what reaches the error
    /// callback is a stream that could not be re-established.
    #[napi]
    pub fn watch(
        &self,
        on_change: Function<Value, ()>,
        on_error: Option<Function<Value, ()>>,
    ) -> napi::Result<Watching> {
        let server = self.server.clone();
        let bucket = self.bucket.clone();
        let keys = match self.shape.as_ref() {
            Some(Shape::Several(keys)) => dynamic_config_nats::Keys::several(keys.clone()),
            Some(Shape::One(key)) => dynamic_config_nats::Keys::one(key.clone()),
            _ => dynamic_config_nats::Keys::one(String::new()),
        };
        let format = self.format;
        let timeout = self.timeout;

        Watching::spawn_async(on_change, on_error, move |mut deliver| async move {
            let mut source = dynamic_config_nats::Nats::new(server, bucket, keys).await?;

            if let Some(format) = format {
                source = source.with_format(format);
            }
            if let Some(timeout) = timeout {
                source = source.with_timeout(timeout);
            }

            source.watch(&mut deliver).await
        })
    }

    /// How this store names itself in an error or a report.
    #[napi]
    pub fn describe(&self) -> String {
        self.described.clone()
    }
}

// ── S3 ────────────────────────────────────────────────────────────────

/// An object in S3, or in anything that speaks its API.
#[napi]
pub struct S3 {
    bucket: String,
    shape: Option<Shape>,
    format: Option<Format>,
    timeout: Option<Duration>,
    described: String,
}

#[napi]
impl S3 {
    /// `(bucket, key | keys | prefix, format?, timeoutMs?)`
    ///
    /// Credentials, region and endpoint come from **the environment**, the
    /// way every AWS SDK reads them: `AWS_ACCESS_KEY_ID`, `AWS_REGION`,
    /// `AWS_ENDPOINT_URL` and the rest, plus the instance and container
    /// roles. A binding that took them as arguments would be a second,
    /// worse copy of a resolution chain the SDK already has and every
    /// other AWS tool on the machine already agrees with.
    #[napi(constructor)]
    pub fn new(
        bucket: String,
        key: Option<String>,
        keys: Option<Vec<String>>,
        prefix: Option<String>,
        format: Option<String>,
        timeout_ms: Option<u32>,
    ) -> napi::Result<Self> {
        let shape = Shape::of(key, keys, prefix)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let format = match format {
            Some(name) => Some(
                format_of(&name).map_err(|error| napi::Error::from_reason(error.to_string()))?,
            ),
            None => None,
        };

        Ok(Self {
            described: format!("s3 bucket {bucket}"),
            bucket,
            shape: Some(shape),
            format,
            timeout: seconds(timeout_ms),
        })
    }

    /// Reads the object. The SDK is async, so the fetch drives a runtime.
    #[napi(ts_return_type = "Promise<Outcome<Document>>")]
    pub fn fetch(&self) -> AsyncTask<Asynchronous> {
        let bucket = self.bucket.clone();
        let keys = match self.shape.as_ref() {
            Some(Shape::One(key)) => dynamic_config_s3::Keys::one(key.clone()),
            Some(Shape::Several(keys)) => dynamic_config_s3::Keys::several(keys.clone()),
            Some(Shape::Prefix(prefix)) => dynamic_config_s3::Keys::prefix(prefix.clone()),
            None => dynamic_config_s3::Keys::one(String::new()),
        };
        let format = self.format;
        let timeout = self.timeout;

        AsyncTask::new(Asynchronous(Box::new(move || {
            let bucket = bucket.clone();
            let keys = keys.clone();

            drive(async move {
                let mut source = dynamic_config_s3::S3::new(bucket, keys).await?;

                if let Some(format) = format {
                    source = source.with_format(format);
                }
                if let Some(timeout) = timeout {
                    source = source.with_timeout(timeout);
                }

                source.fetch().await
            })
        })))
    }

    /// How this store names itself in an error or a report.
    #[napi]
    pub fn describe(&self) -> String {
        self.described.clone()
    }
}

// ── Firestore ─────────────────────────────────────────────────────────

/// A Google Cloud Firestore document.
#[napi]
pub struct Firestore {
    project: String,
    shape: Option<Shape>,
    access_token: Option<String>,
    rotating: Rotating,
    tls: Option<TlsConfig>,
    timeout: Option<Duration>,
    described: String,
}

#[napi]
impl Firestore {
    /// `(project, path | paths, accessToken?, accessTokenFn?, tls?, timeoutMs?)`
    ///
    /// A Firestore document is a typed map rather than a text file, so
    /// there is no format to choose. `accessToken` is a token minted
    /// outside the process — workload identity is the other half and needs
    /// no argument at all.
    #[napi(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        project: String,
        path: Option<String>,
        paths: Option<Vec<String>>,
        access_token: Option<String>,
        access_token_fn: Option<Function<(), String>>,
        tls: Option<Tls>,
        timeout_ms: Option<u32>,
    ) -> napi::Result<Self> {
        let shape = Shape::of(path, paths, None)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;

        Ok(Self {
            described: format!("firestore project {project}"),
            project,
            shape: Some(shape),
            access_token,
            rotating: Rotating::of(access_token_fn)?,
            tls: tls
                .unwrap_or_default()
                .resolved()
                .map_err(|error| napi::Error::from_reason(error.to_string()))?,
            timeout: seconds(timeout_ms),
        })
    }

    /// Reads the document. A network round trip, on a worker thread.
    ///
    /// An access token is minted before the request when `accessTokenFn`
    /// was given: a Google access token lives an hour, and a process that
    /// runs longer would otherwise hold an expired one.
    #[napi(ts_return_type = "Promise<Outcome<Document>>")]
    pub fn fetch(&self) -> AsyncTask<Deferred> {
        let project = self.project.clone();
        let several = matches!(self.shape.as_ref(), Some(Shape::Several(_)));
        let paths = match self.shape.as_ref() {
            Some(Shape::Several(paths)) => paths.clone(),
            Some(Shape::One(path)) => vec![path.clone()],
            _ => vec![String::new()],
        };
        let token = self.access_token.clone();
        let rotating = self.rotating.clone();
        let tls = self.tls.clone();
        let timeout = self.timeout;

        AsyncTask::new(Deferred(Box::new(move || {
            let keys = if several {
                dynamic_config_firestore::Keys::several(paths.clone())
            } else {
                dynamic_config_firestore::Keys::one(paths[0].clone())
            };

            let mut source = dynamic_config_firestore::Firestore::new(project.clone(), keys);

            if let Some(token) = rotating.current()?.or_else(|| token.clone()) {
                source = source.with_auth(dynamic_config_firestore::Auth::access_token(token));
            }
            if let Some(tls) = &tls {
                source = source.with_tls(tls.clone());
            }
            if let Some(timeout) = timeout {
                source = source.with_timeout(timeout);
            }

            source.fetch()
        })))
    }

    /// How this store names itself in an error or a report.
    #[napi]
    pub fn describe(&self) -> String {
        self.described.clone()
    }
}

// ── git ───────────────────────────────────────────────────────────────

/// A file in a git repository, at a branch, a tag or a commit.
#[napi]
pub struct Git {
    url: String,
    shape: Option<Shape>,
    reference: Option<(String, String)>,
    format: Option<Format>,
    token: Option<String>,
    timeout: Option<Duration>,
    described: String,
}

#[napi]
impl Git {
    /// `(url, path | paths | prefix, branch? | tag? | commit?, format?, token?, timeoutMs?)`
    #[napi(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        url: String,
        path: Option<String>,
        paths: Option<Vec<String>>,
        prefix: Option<String>,
        branch: Option<String>,
        tag: Option<String>,
        commit: Option<String>,
        format: Option<String>,
        token: Option<String>,
        timeout_ms: Option<u32>,
    ) -> napi::Result<Self> {
        let shape = Shape::of(path, paths, prefix)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let format = match format {
            Some(name) => Some(
                format_of(&name).map_err(|error| napi::Error::from_reason(error.to_string()))?,
            ),
            None => None,
        };

        let reference = match (branch, tag, commit) {
            (Some(branch), None, None) => Some(("branch".to_owned(), branch)),
            (None, Some(tag), None) => Some(("tag".to_owned(), tag)),
            (None, None, Some(commit)) => Some(("commit".to_owned(), commit)),
            (None, None, None) => None,
            _ => {
                return Err(napi::Error::from_reason(
                    "a git source reads one `branch`, one `tag` or one \
                     `commit` — not two of them",
                ))
            }
        };

        Ok(Self {
            described: format!(
                "git {}",
                dynamic_config_store_core::redacted(
                    &url,
                    dynamic_config_store_core::LoneAuthority::Username,
                )
            ),
            url,
            shape: Some(shape),
            reference,
            format,
            token,
            timeout: seconds(timeout_ms),
        })
    }

    /// Fetches the repository shallowly and reads the file(s).
    #[napi(ts_return_type = "Promise<Outcome<Document>>")]
    pub fn fetch(&self) -> napi::Result<AsyncTask<Blocking>> {
        let mut builder = dynamic_config_git::GitSource::builder(self.url.clone()).path(match self
            .shape
            .as_ref()
        {
            Some(Shape::One(path)) => dynamic_config_git::Keys::one(path.clone()),
            Some(Shape::Several(paths)) => dynamic_config_git::Keys::several(paths.clone()),
            Some(Shape::Prefix(prefix)) => dynamic_config_git::Keys::prefix(prefix.clone()),
            None => dynamic_config_git::Keys::one(String::new()),
        });

        if let Some((kind, name)) = &self.reference {
            builder = match kind.as_str() {
                "branch" => builder.branch(name.clone()),
                "tag" => builder.tag(name.clone()),
                _ => builder.commit(name.clone()),
            };
        }
        if let Some(format) = self.format {
            builder = builder.format(format);
        }
        if let Some(token) = &self.token {
            builder = builder.credential(dynamic_config_git::Credential::token(token.clone()));
        }
        if let Some(timeout) = self.timeout {
            builder = builder.with_timeout(timeout);
        }

        let source = builder
            .build()
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;

        Ok(AsyncTask::new(Blocking(Box::new(source))))
    }

    /// How this store names itself in an error or a report.
    #[napi]
    pub fn describe(&self) -> String {
        self.described.clone()
    }
}

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
