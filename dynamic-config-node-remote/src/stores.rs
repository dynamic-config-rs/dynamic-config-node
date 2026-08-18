//! The eight stores, one `#[napi]` class each: Consul, Vault, Redis,
//! etcd, NATS, S3, Firestore and git. Constructors translate options,
//! everything else defers to the store crates.

use super::*;

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
