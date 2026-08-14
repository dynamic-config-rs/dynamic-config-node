# Changelog

All notable changes to `dynamic-config-node-remote` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

This package versions **with** `dynamic-config`: it hands documents to the
base package, and a gap between them is a pair nobody built.

## [Unreleased]

## 0.0.1

### Added

- **The eight Rust stores** — etcd, Consul, Vault, NATS, Redis, S3,
  Firestore and git — each a class with an async `fetch()` and a
  `describe()`, which is the shape the base package's `setRemote` takes.
- **`useStore(config, store)`**, the bridge between an async fetch and the
  synchronous source the engine's remote layer is filled from: the last
  answer is kept, and the handle it returns refreshes it.
- Descriptions that never carry a credential, by the store crates' own
  redaction rather than by a second copy of it.
- **Credentials that rotate.** `tokenFn` (and Firestore's
  `accessTokenFn`) is a function called on the event loop before each
  fetch, for the tokens that turn over: a projected service-account token,
  a Vault lease, a Google access token that lives an hour. A store built
  once holds what it was given, which is why the store is built per fetch
  when one is supplied.
- **TLS as files or as bytes** — `caCertificateFile`/`caCertificatePem`
  and the client pair — because a Kubernetes secret is a mounted file and
  a certificate fetched at startup never touches a disk. Saying nothing
  means the platform's trust store, not *no TLS*.
- **`watch(onChange, onError?)` on the four stores that push**: Consul's
  blocking query, Redis' keyspace notifications, etcd's watch stream and
  NATS' JetStream watch. The loop is a thread of its own and reaches the
  event loop only to deliver; the handle's `stop()` is idempotent and
  waits for the loop to notice. Vault, S3, Firestore and git have none,
  and deliberately: their Rust watch loops poll, so `setInterval` around
  `refresh()` is the same thing with one fewer thread.
