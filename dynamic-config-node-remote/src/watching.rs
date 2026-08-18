//! `Watching`: the RAII handle a store's watch answers, and the rotating
//! credential callable some stores take.

use super::*;

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
pub(crate) struct Rotating(pub(crate) Option<Arc<Callable<(), String>>>);

impl Rotating {
    /// Builds one from whatever the constructor was handed.
    pub(crate) fn of(token: Option<Function<(), String>>) -> napi::Result<Self> {
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
    pub(crate) fn current(&self) -> Result<Option<String>, Error> {
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
    pub(crate) fn spawn<F>(
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
    pub(crate) fn spawn_async<F, Fut>(
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
pub(crate) fn failed_value(error: &Error) -> Value {
    failed(error)
}

// ── Consul ────────────────────────────────────────────────────────────
