# Changelog

All notable changes to `dynamic-config-node-remote` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

This package versions **with** `dynamic-config`: it hands documents to the
base package, and a gap between them is a pair nobody built.

## [Unreleased]

## 0.0.5 — 2026-08-20

## 0.0.4 — 2026-08-18

### Changed

- **Built on the 0.8 store crates and engine 0.8** — the same
  build-time bump as the base package, with the JavaScript surface
  unchanged. The development-only `[patch.crates-io]` block is gone.

### Changed

- **The single 1,651-line module is five.** `lib.rs` keeps the front
  door; the off-loop task machinery, the TLS options object, the watch
  handle and the eight store classes each have a file. Nothing public
  moved — the `.d.ts` is unchanged and the suite runs against the same
  surface — and the constructors' signature drift-test now reads
  `stores.rs`, where the constructors live.

## 0.0.3 — 2026-08-18

### Fixed

- **The peer range names the version this addon ships with.** It had been
  left at `^0.0.1` while both packages moved to 0.0.2, and npm's caret pins
  the patch below 0.1.0 — `^0.0.1` matches 0.0.1 and nothing else — so
  installing the matching pair failed to resolve. A test now compares the
  two manifests, since the range has to move with every release and there
  is no script here that would move it.

### Changed

- **Moved with the base package**, as it always does — the two are built
  from one commit and version together. Nothing in this package changed;
  the eight compiled stores are the same, with the same API.

  What the base package added is theirs like any other store: an `Etcd`
  or `Vault` source can be a member of a `ConfigGroup`, and `events()`
  reports its installs and refusals. `setRemoteAsync` is for a store
  written in JavaScript — these are compiled, and their fetch stays
  synchronous, driven by the tokio runtime this package owns.

## 0.0.2 — 2026-08-16

### Changed

- **Moved with the base package** to
  [dynamic-config-rs/dynamic-config-node](https://github.com/dynamic-config-rs/dynamic-config-node).
  The two still version together, and `useStore` still bridges them.

- **The README points somewhere.** It opened with a relative link to a
  sibling directory, which on npm's own package page resolves to nothing;
  it now names the base package's book and the remote-stores chapter.

- **Keywords name the stores**, so a search for `etcd`, `vault` or
  `consul` on npm finds this package.

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
