//! One configuration: the engine, the validate door, and the value the
//! event loop reads.
//!
//! The shape is the Python binding's, with one simplification the two
//! languages do not share. Python holds the *instance* a schema built and
//! hands the same object back on every `current()`; a Node validator hands
//! back a plain object, so what is held here is a `serde_json::Value` and
//! the facade next door caches the JavaScript object it converts to. That
//! is why nothing in this file owns a JavaScript reference: the watcher
//! thread can install a document with the loop asleep, and there is no
//! handle for it to have taken.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};

use dynamic_config::{Aliases, Builder, CacheMode, Dynamic, EnvBindings, Error, Layer, Remote};
use napi::bindgen_prelude::{AsyncTask, Function, Task};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::Env;
use napi_derive::napi;
use serde_json::{json, Value};

use crate::outcome::{self, Json};
use crate::remote::{JsSource, Shim};
use crate::validate::{Callable, Door};

/// The runtime layers, which the engine takes as `&'static`.
///
/// Leaked once per configuration, exactly as the Python binding leaks
/// them and for the same reason: the engine's runtime layers are shaped
/// for the `static`s a `#[dynamic_config]` type generates, and an instance
/// is that same long-lived thing wearing a different hat. A few hundred
/// bytes per configuration, never per reload.
#[derive(Clone, Copy)]
struct Layers {
    defaults: &'static Layer,
    overrides: &'static Layer,
    flags: &'static Layer,
    bindings: &'static EnvBindings,
    aliases: &'static Aliases,
    remote: &'static Remote,
}

impl Layers {
    fn leak() -> Self {
        Self {
            defaults: Box::leak(Box::new(Layer::new())),
            overrides: Box::leak(Box::new(Layer::new())),
            flags: Box::leak(Box::new(Layer::new())),
            bindings: Box::leak(Box::new(EnvBindings::new())),
            aliases: Box::leak(Box::new(Aliases::new())),
            remote: Box::leak(Box::new(Remote::new())),
        }
    }
}

/// A configuration is a builder until something loads through it.
enum Engine {
    Building(Box<Builder<Value>>),
    Ready(Arc<Dynamic<Value>>),
    /// Held for the instant a transition takes; never observed.
    Moving,
}

/// One validated document, waiting to be published.
struct Staged {
    sequence: u64,
    tree: Value,
    model: Value,
}

struct Inner {
    key: String,
    door: Door,
    /// Validations waiting to be claimed, oldest first.
    staged: Mutex<Vec<Staged>>,
    next_sequence: AtomicU64,
    last_committed: AtomicU64,
    engine: Mutex<Engine>,
    /// The published document. The read path, and the only lock the
    /// facade's `current()` ever takes.
    cache: RwLock<Option<Value>>,
    /// The generation of the *validated* document, which is what a reader
    /// waits on. Deliberately not the engine's own: a reload that resolves
    /// and then fails validation moves the engine and must wake nobody.
    generation: AtomicU64,
    /// What to call on the loop after each install. A hook is a
    /// `ThreadsafeFunction`, so the watcher thread can fire it without
    /// touching a JavaScript value.
    hooks: Mutex<Vec<(u64, Callable<Value, ()>)>>,
    next_hook: AtomicU64,
    layers: Layers,
    /// The JavaScript function a remote fetch calls, if one was installed.
    ///
    /// Held here rather than inside the shim the engine owns: that shim
    /// lives in a leaked `&'static Remote`, so anything JavaScript it held
    /// would never be freed.
    source: Arc<JsSource>,
    /// The file watcher, while one is running.
    watching: Mutex<Option<dynamic_config::watch::WatchHandle>>,
}

thread_local! {
    /// Where a *candidate* load's validated document goes.
    ///
    /// `load()` installs nothing, so its validation must not reach the
    /// staging area an install claims from — two loads resolving the same
    /// file produce equal trees, and an install would happily claim the
    /// candidate's entry and publish twice. A thread-local is exact
    /// because a load runs start to finish on one worker thread, and it
    /// costs the shared path nothing.
    static CANDIDATE: std::cell::RefCell<Option<Value>> = const { std::cell::RefCell::new(None) };
}

/// Whether this thread is inside `load()` rather than an install.
fn validating_a_candidate() -> bool {
    CANDIDATE.with(|slot| slot.borrow().is_some())
}

impl Inner {
    /// Validates `tree` and stages what came back. The engine's hook.
    ///
    /// Staged entries are **kept by sequence**, not overwritten. The
    /// engine permits overlapping loads — a `load()` that installs
    /// nothing can validate between a `reload()`'s validation and its
    /// commit — and a single slot let the second one publish the first
    /// one's document, or neither. Each load then claims the entry whose
    /// tree is the one it resolved.
    fn validate(this: &Arc<Self>, tree: &Value) -> Result<(), Error> {
        let model = this.door.validate(tree)?;

        if validating_a_candidate() {
            CANDIDATE.with(|slot| *slot.borrow_mut() = Some(model));

            return Ok(());
        }

        let sequence = this.next_sequence.fetch_add(1, Ordering::SeqCst) + 1;

        let mut staged = this
            .staged
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        staged.push(Staged {
            sequence,
            tree: tree.clone(),
            model,
        });

        // Bounded: a validation that nobody claims — a candidate load, a
        // reload the engine then refused for another reason — would
        // otherwise accumulate one document per load for the life of the
        // process. Four is two overlapping loads' worth.
        while staged.len() > 4 {
            staged.remove(0);
        }

        Ok(())
    }

    /// The document a load's own validation produced, taken out of the
    /// staging area so nothing else can claim it twice.
    fn take_staged(&self, tree: &Value) -> Option<Staged> {
        let mut staged = self
            .staged
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let found = staged.iter().position(|pending| pending.tree == *tree)?;

        Some(staged.remove(found))
    }

    /// Publishes the document that belongs to `tree` — once per install.
    ///
    /// Both commit paths call this: the engine's own reload hook, and the
    /// explicit one after `init`/`reload` returns. Whichever arrives first
    /// publishes; the other finds the sequence already committed and does
    /// nothing, which is what keeps one reload to one generation and one
    /// round of hooks.
    fn commit(&self, tree: &Value) {
        let model = {
            let Some(pending) = self.take_staged(tree) else {
                // Already claimed by the other commit path for this same
                // install — the engine's reload hook and the explicit call
                // after `init`/`reload` both reach here.
                return;
            };

            // Claimed rather than checked-then-claimed: a read followed by
            // a later store would let both paths win — one reload, two
            // generations, every hook twice.
            if self
                .last_committed
                .fetch_max(pending.sequence, Ordering::SeqCst)
                >= pending.sequence
            {
                return;
            }

            pending.model
        };

        *self
            .cache
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(model.clone());
        self.generation.fetch_add(1, Ordering::SeqCst);

        for (_, hook) in self
            .hooks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
        {
            // Non-blocking: a hook that cannot be queued is a loop that has
            // gone away, and a reload is not the place to find that out.
            hook.call(model.clone(), ThreadsafeFunctionCallMode::NonBlocking);
        }
    }

    /// The engine, built on first use.
    fn dynamic(this: &Arc<Self>) -> Arc<Dynamic<Value>> {
        let mut engine = this
            .engine
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        if matches!(*engine, Engine::Building(_)) {
            let Engine::Building(builder) = std::mem::replace(&mut *engine, Engine::Moving) else {
                unreachable!("just checked")
            };

            let dynamic = Dynamic::new(*builder);

            // The watcher installs through the engine, so a watch-driven
            // reload commits through the engine's own hook. Weak, because
            // the hook lives inside the `Dynamic` this `Inner` owns.
            let weak: Weak<Inner> = Arc::downgrade(this);

            dynamic.on_reload(move |_previous, current| {
                if let Some(inner) = weak.upgrade() {
                    inner.commit(current);
                }
            });

            *engine = Engine::Ready(Arc::new(dynamic));
        }

        match &*engine {
            Engine::Ready(dynamic) => Arc::clone(dynamic),
            _ => unreachable!("just built"),
        }
    }

    /// Reads the builder, whichever half of its life it is in.
    ///
    /// The diagnostics are read-only, and building the engine to answer
    /// one would close the source-declaring phase behind a caller's back:
    /// a `check()` before the first load would make the next `file()` a
    /// refusal. So they borrow the builder in place instead.
    fn with_builder_ref<T>(&self, read: impl FnOnce(&Builder<Value>) -> T) -> T {
        let engine = self
            .engine
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        match &*engine {
            Engine::Building(builder) => read(builder),
            Engine::Ready(dynamic) => read(dynamic.builder()),
            Engine::Moving => unreachable!("held only for the instant a transition takes"),
        }
    }

    /// Whatever a source method needs to change, before the engine exists.
    ///
    /// Sources are declared on the builder, so they are refused once
    /// something has loaded — the same rule the Python binding has, and
    /// for the same reason: a source added after the fact would take
    /// effect on the next reload and nowhere in the document that is
    /// serving now.
    fn with_builder(&self, change: impl FnOnce(Builder<Value>) -> Builder<Value>) -> Value {
        let mut engine = self
            .engine
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        match std::mem::replace(&mut *engine, Engine::Moving) {
            Engine::Building(builder) => {
                *engine = Engine::Building(Box::new(change(*builder)));

                outcome::ok(Value::Null)
            }
            ready => {
                *engine = ready;

                outcome::refused(
                    "backend",
                    "sources are declared before the first load; this \
                     configuration has already loaded, and a source added \
                     now would take effect on the next reload and nowhere \
                     in the document that is serving",
                )
            }
        }
    }
}

/// One configuration, as the facade drives it.
#[napi]
pub struct Config {
    inner: Arc<Inner>,
}

/// The work of a load, on a worker thread.
///
/// `pub` because it names an `AsyncTask` in a public signature, and for no
/// other reason: nothing outside this crate can construct or drive one.
///
/// libuv's pool rather than a runtime of our own: a load is blocking work
/// that must not sit on the event loop, and the loop has to stay free
/// because the validate hook calls back into it.
pub struct Load {
    inner: Arc<Inner>,
    what: What,
}

#[derive(Clone, Copy)]
enum What {
    Init,
    Reload,
    /// Loads and validates, installing nothing — what a `--check` flag and
    /// a test both want.
    Candidate,
    Refresh,
}

impl Task for Load {
    type Output = Value;
    type JsValue = Json;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let dynamic = Inner::dynamic(&self.inner);

        let answer = match self.what {
            What::Init => dynamic.init().map(|()| Value::Null),
            What::Reload => dynamic.reload().map(|()| Value::Null),
            What::Candidate => {
                // The flag the validate hook reads: what this load
                // validates is *this* load's answer and nobody else's.
                CANDIDATE.with(|slot| *slot.borrow_mut() = Some(Value::Null));

                let answer = dynamic.load();
                let validated = CANDIDATE.with(|slot| slot.borrow_mut().take());

                match answer {
                    // A configuration with no validator validates nothing,
                    // and the resolved tree is the answer.
                    Ok(tree) => Ok(match validated {
                        Some(Value::Null) | None => tree,
                        Some(model) => model,
                    }),
                    Err(error) => Err(error),
                }
            }
            What::Refresh => self.inner.layers.remote.refresh().map(|()| Value::Null),
        };

        match answer {
            Ok(value) => {
                if matches!(self.what, What::Init | What::Reload) {
                    // Whatever this load installed: the engine has it, and
                    // asking for it is what makes the commit *this* load's
                    // rather than whichever validation ran last.
                    if let Some(installed) = dynamic.current() {
                        self.inner.commit(&installed);
                    }
                }

                Ok(outcome::ok(value))
            }
            Err(error) => Ok(outcome::failed(&error)),
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(Json(output))
    }
}

#[napi]
impl Config {
    /// Builds a configuration for `key`.
    ///
    /// `validate` is whatever turns a resolved object into the value a
    /// program reads: Zod's `parse`, an Ajv validator, a hand-written
    /// function, or nothing at all for a configuration with no schema.
    /// Calling a *method by name* here would have made one schema library
    /// the only one this binding could ever have.
    #[napi(constructor)]
    pub fn new(
        key: String,
        validate: Option<Function<Value, Value>>,
        secrets: Option<Vec<String>>,
        fields: Option<Vec<String>>,
    ) -> napi::Result<Self> {
        let declared: Vec<String> = secrets.clone().unwrap_or_default();
        let door = Door::new(
            match validate {
                Some(function) => Some(
                    function
                        .build_threadsafe_function()
                        // Weak, so a configuration does not keep the process
                        // alive. A validator is called *by* work the program
                        // asked for; holding the loop open for one would mean
                        // a script that loads a configuration and finishes
                        // never exits, which is the first thing anybody would
                        // notice and the last thing they would guess.
                        .weak::<true>()
                        .callee_handled::<false>()
                        .build()?,
                ),
                None => None,
            },
            declared,
        );

        let layers = Layers::leak();
        let mut builder = Builder::<Value>::new(&key);

        // `with_fields` wants names that outlive the load. A schema's field
        // list is fixed when the schema is, so one leak per configuration
        // is the whole cost.
        if let Some(fields) = fields {
            let names: &'static [&'static str] = Box::leak(
                fields
                    .into_iter()
                    .map(|name| &*Box::leak(name.into_boxed_str()))
                    .collect::<Vec<&'static str>>()
                    .into_boxed_slice(),
            );

            builder = builder.with_fields(names);
        }

        // Only when the caller *knows*: a configuration that declared no
        // secrets leaves the list unset, so the engine goes on refusing a
        // redacting cache rather than writing one that claims a redaction
        // it did not perform.
        if let Some(secrets) = &secrets {
            let refs: Vec<&str> = secrets.iter().map(String::as_str).collect();

            builder = builder.with_secrets(&refs);
        }

        let inner = Arc::new(Inner {
            key,
            door,
            staged: Mutex::new(Vec::new()),
            next_sequence: AtomicU64::new(0),
            last_committed: AtomicU64::new(0),
            engine: Mutex::new(Engine::Moving),
            cache: RwLock::new(None),
            generation: AtomicU64::new(0),
            hooks: Mutex::new(Vec::new()),
            next_hook: AtomicU64::new(1),
            layers,
            source: Arc::new(JsSource::default()),
            watching: Mutex::new(None),
        });

        // Weak, like the reload hook twenty lines down and for the same
        // reason: this closure is stored in the `Builder`, which the
        // `Dynamic` owns, which `Inner.engine` holds — so a strong clone
        // here is a cycle `Inner → engine → closure → Inner` that no drop
        // can break. A configuration built per tenant and discarded would
        // keep its watcher thread for the life of the process.
        let validating = Arc::downgrade(&inner);
        let builder = builder
            .with_type_statics(
                layers.defaults,
                layers.overrides,
                layers.flags,
                layers.bindings,
                layers.aliases,
                layers.remote,
                // An instance has no type-level slot to remember it in.
                |_| {},
            )
            .validate(move |tree: &Value| match validating.upgrade() {
                Some(inner) => Inner::validate(&inner, tree),
                // The configuration was dropped while a load was in
                // flight. Refusing is the only honest answer: there is
                // nothing left to install into.
                None => Err(Error::invalid(
                    "this configuration was dropped while it was loading",
                )),
            });

        *inner
            .engine
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Engine::Building(Box::new(builder));

        Ok(Self { inner })
    }

    /// The section key this configuration reads.
    #[napi(getter)]
    pub fn key(&self) -> String {
        self.inner.key.clone()
    }

    // ── Sources ───────────────────────────────────────────────────────

    #[napi]
    pub fn file(&self, path: String) -> Value {
        self.inner.with_builder(|builder| builder.file(path))
    }

    #[napi]
    pub fn discover(&self, name: String, paths: Vec<String>) -> Value {
        self.inner
            .with_builder(move |builder| builder.discover(&name, paths))
    }

    #[napi]
    pub fn env(&self, prefix: String) -> Value {
        self.inner.with_builder(|builder| builder.env(prefix))
    }

    #[napi]
    pub fn nest(&self, separator: String) -> Value {
        self.inner.with_builder(|builder| builder.nest(separator))
    }

    #[napi(js_name = "allowEmptyEnv")]
    pub fn allow_empty_env(&self) -> Value {
        self.inner
            .with_builder(dynamic_config::Builder::allow_empty_env)
    }

    /// Refuse an environment value this crate cannot type rather than
    /// guessing at it — the strict reading of `APP_DB_PORT=eight`.
    #[napi(js_name = "strictEnv")]
    pub fn strict_env(&self) -> Value {
        self.inner.with_builder(dynamic_config::Builder::strict_env)
    }

    #[napi(js_name = "wholeDocument")]
    pub fn whole_document(&self) -> Value {
        self.inner
            .with_builder(dynamic_config::Builder::whole_document)
    }

    #[napi(js_name = "envFile")]
    pub fn env_file(&self, path: String) -> Value {
        self.inner.with_builder(|builder| builder.env_file(path))
    }

    #[napi(js_name = "secretsDir")]
    pub fn secrets_dir(&self, path: String) -> Value {
        self.inner.with_builder(|builder| builder.secrets_dir(path))
    }

    #[napi(js_name = "profileEnv")]
    pub fn profile_env(&self, variable: String) -> Value {
        self.inner
            .with_builder(|builder| builder.profile_env(variable))
    }

    /// `mode` is `full`, `redacted` or `fingerprint` — the three the
    /// engine has, spelled the way a JavaScript caller would.
    #[napi]
    pub fn cache(&self, path: String, mode: String) -> Value {
        let mode = match mode.as_str() {
            "full" => CacheMode::Full,
            "redacted" => CacheMode::Redacted,
            "fingerprint" => CacheMode::Fingerprint,
            other => {
                return outcome::refused(
                    "backend",
                    format!(
                        "`{other}` is not a cache mode; it is one of \"full\", \
                         \"redacted\" or \"fingerprint\""
                    ),
                )
            }
        };

        self.inner
            .with_builder(move |builder| builder.cache(path, mode))
    }

    // ── The runtime layers ────────────────────────────────────────────

    #[napi(js_name = "setDefault")]
    pub fn set_default(&self, path: String, value: Value) -> Value {
        outcome::from_result(
            self.inner
                .layers
                .defaults
                .set(&path, value)
                .map(|()| Value::Null),
        )
    }

    /// A whole object as defaults at once, rather than a path at a time.
    ///
    /// What a hand-written `defaults()` becomes: every leaf of `values`
    /// is a default, and a file that states any of them wins.
    #[napi(js_name = "setDefaults")]
    pub fn set_defaults(&self, values: Value) -> Value {
        outcome::from_result(
            self.inner
                .layers
                .defaults
                .set_struct(&values)
                .map(|()| Value::Null),
        )
    }

    #[napi(js_name = "setOverride")]
    pub fn set_override(&self, path: String, value: Value) -> Value {
        outcome::from_result(
            self.inner
                .layers
                .overrides
                .set(&path, value)
                .map(|()| Value::Null),
        )
    }

    #[napi(js_name = "clearDefaults")]
    pub fn clear_defaults(&self) {
        self.inner.layers.defaults.clear();
    }

    #[napi(js_name = "clearOverrides")]
    pub fn clear_overrides(&self) {
        self.inner.layers.overrides.clear();
    }

    #[napi(js_name = "setAssignments")]
    pub fn set_assignments(&self, assignments: Vec<String>) -> Value {
        let refs: Vec<&str> = assignments.iter().map(String::as_str).collect();

        outcome::from_result(
            self.inner
                .layers
                .flags
                .set_assignments(&refs)
                .map(|()| Value::Null),
        )
    }

    #[napi(js_name = "clearAssignments")]
    pub fn clear_assignments(&self) {
        self.inner.layers.flags.clear();
    }

    #[napi(js_name = "bindEnv")]
    pub fn bind_env(&self, path: String, variable: String) -> Value {
        outcome::from_result(
            self.inner
                .layers
                .bindings
                .bind(&path, &variable)
                .map(|()| Value::Null),
        )
    }

    #[napi]
    pub fn alias(&self, from: String, to: String) -> Value {
        outcome::from_result(
            self.inner
                .layers
                .aliases
                .add(&from, &to)
                .map(|()| Value::Null),
        )
    }

    // ── Lifecycle ─────────────────────────────────────────────────────

    #[napi(ts_return_type = "Promise<Outcome<null>>")]
    pub fn init(&self) -> AsyncTask<Load> {
        AsyncTask::new(Load {
            inner: Arc::clone(&self.inner),
            what: What::Init,
        })
    }

    #[napi(ts_return_type = "Promise<Outcome<null>>")]
    pub fn reload(&self) -> AsyncTask<Load> {
        AsyncTask::new(Load {
            inner: Arc::clone(&self.inner),
            what: What::Reload,
        })
    }

    #[napi(ts_return_type = "Promise<Outcome<unknown>>")]
    pub fn load(&self) -> AsyncTask<Load> {
        AsyncTask::new(Load {
            inner: Arc::clone(&self.inner),
            what: What::Candidate,
        })
    }

    /// The published document, or `null` before the first install.
    #[napi(js_name = "currentValue")]
    pub fn current_value(&self) -> Option<Value> {
        self.inner
            .cache
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Installs `document` directly, without loading anything.
    ///
    /// The testing door, and the one a caller reaches for when the
    /// configuration comes from somewhere this library does not know
    /// about. It bumps the generation and fires the hooks, exactly as a
    /// load does — what it skips is the sources and the validator, because
    /// the caller is asserting they already did that.
    ///
    /// **What it cannot move is the engine's own metadata.** `status()`
    /// and `snapshot().generation` come from the engine, which did not
    /// perform this install and has no way to be told about one; they go
    /// on describing the last real load. `generation` here — the
    /// binding's — counts this one, and `snapshot().document` is what is
    /// serving. That split is reported rather than papered over: a
    /// `status()` that claimed a load had happened would be worse than
    /// one that is a load behind.
    #[napi]
    pub fn replace(&self, document: Value) -> Value {
        *self
            .inner
            .cache
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(document.clone());
        self.inner.generation.fetch_add(1, Ordering::SeqCst);

        for (_, hook) in self
            .inner
            .hooks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
        {
            hook.call(document.clone(), ThreadsafeFunctionCallMode::NonBlocking);
        }

        outcome::ok(Value::Null)
    }

    /// How many times a document has been *installed*, validation
    /// included. The number the facade compares to know its cache is stale.
    #[napi]
    pub fn generation(&self) -> u32 {
        // `u32` because that is what JavaScript's number does exactly, and
        // a configuration reloading a thousand times a second would take
        // fifty days to reach it.
        self.inner.generation.load(Ordering::SeqCst) as u32
    }

    /// Calls `hook` with each installed document, on the event loop.
    #[napi(js_name = "onReload")]
    pub fn on_reload(&self, hook: Function<Value, ()>) -> napi::Result<u32> {
        let token = self.inner.next_hook.fetch_add(1, Ordering::SeqCst);
        let function = hook
            .build_threadsafe_function()
            // Weak, for the reason the validator's is: a reload hook is a
            // subscription, not a reason for the process to stay up.
            .weak::<true>()
            .callee_handled::<false>()
            .build()?;

        self.inner
            .hooks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((token, function));

        Ok(token as u32)
    }

    #[napi(js_name = "removeHook")]
    pub fn remove_hook(&self, token: u32) -> bool {
        let mut hooks = self
            .inner
            .hooks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let before = hooks.len();

        hooks.retain(|(registered, _)| *registered != u64::from(token));

        hooks.len() != before
    }

    // ── Diagnostics ───────────────────────────────────────────────────

    #[napi(js_name = "sourceOf")]
    pub fn source_of(&self, path: String) -> Value {
        self.inner
            .with_builder_ref(|builder| match builder.source_of(&path) {
                Ok(Some(origin)) => {
                    let (kind, detail) = crate::outcome::origin_parts(&origin);

                    outcome::ok(json!({ "kind": kind, "detail": detail }))
                }
                Ok(None) => outcome::ok(Value::Null),
                Err(error) => outcome::failed(&error),
            })
    }

    #[napi(js_name = "isSet")]
    pub fn is_set(&self, path: String) -> Value {
        self.inner.with_builder_ref(|builder| {
            outcome::from_result(builder.is_set(&path).map(Value::Bool))
        })
    }

    #[napi]
    pub fn explain(&self, path: String) -> Value {
        self.inner
            .with_builder_ref(|builder| match builder.explain(&path) {
                Ok(explanation) => outcome::ok(json!({ "rendered": explanation.to_string() })),
                Err(error) => outcome::failed(&error),
            })
    }

    #[napi]
    pub fn check(&self) -> Value {
        self.inner
            .with_builder_ref(|builder| match builder.check() {
                Ok(report) => outcome::ok(json!({
                    "rendered": report.to_string(),
                    "isClean": report.is_clean(),
                    "unknown": report
                        .unknown
                        .iter()
                        .map(|key| json!({ "path": key.path, "suggestion": key.suggestion }))
                        .collect::<Vec<_>>(),
                    "unknownChecked": report.unknown_checked,
                    "failure": report.failure.as_ref().map(ToString::to_string),
                })),
                Err(error) => outcome::failed(&error),
            })
    }

    #[napi]
    pub fn status(&self) -> Value {
        let engine = self
            .inner
            .engine
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        // Nothing has loaded: say so rather than building the engine to
        // ask, which would close the source-declaring phase.
        let Engine::Ready(dynamic) = &*engine else {
            return outcome::ok(json!({
                "key": self.inner.key,
                "generation": 0,
                "consecutiveFailures": 0,
                "lastReason": Value::Null,
                "lastFailure": Value::Null,
            }));
        };

        let status = dynamic.status();

        outcome::ok(json!({
            "key": self.inner.key,
            "generation": status.generation,
            "consecutiveFailures": status.consecutive_failures,
            "lastReason": status.last_reason.map(|reason| format!("{reason:?}")),
            "lastFailure": status.last_failure.as_ref().map(|failure| json!({
                "kind": failure.kind.as_str(),
                "path": failure.path,
            })),
        }))
    }

    // ── Remote stores ─────────────────────────────────────────────────

    /// Installs a store written in JavaScript.
    ///
    /// `fetch` answers `{ text, format }`. It is called on a worker thread
    /// through the loop, so it must be *synchronous*: an `async` source
    /// resolves its own promise and hands over the result, which the
    /// facade's `remoteSource` helper does in four lines.
    #[napi(js_name = "setRemote")]
    pub fn set_remote(&self, fetch: Function<(), Value>, described: String) -> napi::Result<Value> {
        let function = fetch
            .build_threadsafe_function()
            .weak::<true>()
            .callee_handled::<false>()
            .build()?;

        self.inner.source.install(function, described);
        self.inner
            .layers
            .remote
            .set(Shim(Arc::clone(&self.inner.source)));

        Ok(outcome::ok(Value::Null))
    }

    /// Fetches from the installed store, into the remote layer.
    ///
    /// The document is not installed by this: a fetch fills the layer, and
    /// the next `reload()` is what resolves and validates it — the same
    /// two steps `refresh_remote()` and a reload are in Rust.
    #[napi(js_name = "refreshRemote", ts_return_type = "Promise<Outcome<null>>")]
    pub fn refresh_remote(&self) -> AsyncTask<Load> {
        AsyncTask::new(Load {
            inner: Arc::clone(&self.inner),
            what: What::Refresh,
        })
    }

    #[napi(js_name = "clearRemote")]
    pub fn clear_remote(&self) {
        self.inner.layers.remote.clear();
    }

    #[napi(js_name = "remoteDescription")]
    pub fn remote_description(&self) -> Option<String> {
        self.inner.source.describe()
    }

    /// What the store has answered, for an operator asking.
    #[napi(js_name = "remoteStatus")]
    pub fn remote_status(&self) -> Value {
        let status = self.inner.layers.remote.status();

        outcome::ok(json!({
            "reachable": status.reachable(),
            "fetches": status.fetches,
            "consecutiveFailures": status.consecutive_failures,
            "lastFailure": status.last_failure.as_ref().map(|failure| json!({
                "kind": failure.kind.as_str(),
                "path": failure.path,
            })),
        }))
    }

    // ── Watching ──────────────────────────────────────────────────────

    /// Watches every file this configuration reads, reloading on a change.
    ///
    /// The reload happens on the watcher's own thread and reaches the loop
    /// only for validation and for the hooks — which is why a program that
    /// watches does not have to be structured around watching.
    #[napi]
    pub fn watch(&self, debounce_ms: Option<u32>, poll_ms: Option<u32>) -> Value {
        let dynamic = Inner::dynamic(&self.inner);
        let debounce = std::time::Duration::from_millis(u64::from(debounce_ms.unwrap_or(250)));

        // Polling is what a network or overlay filesystem needs — a
        // container bind mount delivers no events — so it is an interval a
        // caller states rather than a boolean this has to guess at.
        let started = match poll_ms {
            Some(interval) => dynamic.watch_with(
                debounce,
                dynamic_config::watch::WatchMode::Poll {
                    interval: std::time::Duration::from_millis(u64::from(interval)),
                },
            ),
            None => dynamic.watch(debounce),
        };

        match started {
            Ok(handle) => {
                *self
                    .inner
                    .watching
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(handle);

                outcome::ok(Value::Null)
            }
            Err(failure) => outcome::refused("io", failure.to_string()),
        }
    }

    /// Stops the watcher, if one is running. Idempotent.
    #[napi(js_name = "stopWatching")]
    pub fn stop_watching(&self) {
        self.inner
            .watching
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
    }

    /// Everything the engine knows about the running document, as data.
    #[napi]
    pub fn snapshot(&self) -> Value {
        let engine = self
            .inner
            .engine
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        let Engine::Ready(dynamic) = &*engine else {
            return outcome::ok(Value::Null);
        };

        match dynamic.meta() {
            Some(meta) => outcome::ok(json!({
                "generation": meta.generation,
                // The document itself, which is what a snapshot is for
                // here: Rust's `Snapshot` is a typed handle, and the
                // typed handle in Node is the value the facade caches.
                "document": self
                    .inner
                    .cache
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clone(),
                "loadedAtAgoMs": meta.loaded_at.elapsed().as_millis() as u64,
            })),
            None => outcome::ok(Value::Null),
        }
    }
}
