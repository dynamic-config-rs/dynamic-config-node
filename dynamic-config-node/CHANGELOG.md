# Changelog

All notable changes to the `dynamic-config-node` npm package are documented
here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

This package versions independently of the Rust crates: it *embeds* the
engine rather than depending on a published version of it, so a Rust-only
release has nothing in it for a Node user.

<!-- Add entries under `Unreleased` as you go, and move the whole block
     under a new version heading at release time. -->

## [Unreleased]

## 0.0.3 — 2026-08-18

### Added

- **`ConfigGroup`: several configurations under one lifecycle.**
  `new ConfigGroup(db, cache, queue)` initialises, watches, reports and
  stops its members together — `await group.running(async () => …)` is
  load, watch, run, stop — and `status()` / `generations()` answer per key
  for a health endpoint. The group owns lifecycle, not storage:
  `db.current()` is still the read path, with the member's own type.

- **`group.reloadAtomic()`: every member validates, or none installs.**
  The engine's prepare-then-commit — `ReloadGroup`, which Rust callers
  have had since 0.4 — driven from JavaScript. A refusal leaves every
  document exactly as it was, generation included, instead of leaving a
  deployment half-applied across two configurations.

- **`events()`: installs and refusals as typed events.** An async iterator
  of `{ type: "reloaded", generation, at, changed, reason }` and
  `{ type: "reloadFailed", generation, at, kind, path, consecutive }` — a
  discriminated union a `switch` narrows. **No event carries a value**,
  the same rule `explain()` and `check()` follow. `failurePollMs` opts
  into checking for refusals, which nothing can wake a stream for: a load
  that installed nothing bumps no generation.

- **`onReloadAsync(hook, { backpressure, onError })`.** An `async` hook
  handed to `onReload` leaves a promise nobody awaits — two installs run
  their bodies interleaved, and a rejection becomes an unhandled one.
  This awaits it, keeps only the newest install by default (`"latest"`,
  next to `"serial"` and `"every"`), reports a rejection instead of
  dropping it, and hands the hook an `AbortSignal` that is aborted when a
  newer install supersedes the call.

- **`setRemoteAsync(fetch, described?)`: a store whose client is async.**
  `refreshRemote()` awaits the fetch on the calling loop and hands the
  engine the document that came back, so an `await fetch(...)` needs no
  variable kept up to date by a timer. The deadline stays yours
  (`AbortSignal.timeout`), and a rejection reaches the caller as its own
  error rather than as a `remote` failure, because nothing has entered
  the engine yet.

- **`config.running(body, options?)`.** Load, watch, run, stop as one
  call. JavaScript has no `with`, so the block is a function; what it buys
  is the same thing — a watcher that cannot be left running by an
  exception on the way out.

- **`changedPaths(before, after)`.** Which dotted paths differ between two
  documents — paths, never values. What `events()` reports, exported for
  the code that wants to make the comparison itself.

### Changed

- **A Telemetry & Health chapter**, where `status()`, `remoteStatus()` and
  the liveness/readiness split had been scattered through *Patterns & Style*
  and *Stability*. The book also has parts now: *Guide*, *Use Cases*,
  *Advanced* and *Reference*.

## 0.0.2 — 2026-08-16

### Changed

- **The packages moved to their own repository**,
  [dynamic-config-rs/dynamic-config-node](https://github.com/dynamic-config-rs/dynamic-config-node),
  and release on their own schedule from there. The package names and the
  API are unchanged; the book is now at
  [dynamic-config-rs.github.io/node/](https://dynamic-config-rs.github.io/node/),
  and `repository`, `homepage`, `bugs` and `author` in `package.json` name
  the new home.

- **More keywords**, because npm search reads them: the formats
  (`toml`, `yaml`, `dotenv`), what this is for (`live-reload`,
  `twelve-factor`, `file-watcher`), and what it is written in
  (`typescript`, `napi-rs`, `rust`).

### Fixed

- **The stores package's own documentation showed a constructor that does
  not exist.** `new Etcd({ endpoints, key })` was in the crate page and in
  the `useStore` example, and every store's summary line read as an
  options object — but `#[napi(constructor)]` generates *positional*
  arguments, which is what the book, the README, the `.d.ts` and the tests
  had all along. Three summaries were also missing arguments they take
  (Vault's `format`, Redis's `tls`, Firestore's `accessTokenFn` and
  `tls`), which on a positional call is the difference between a timeout
  and a TLS object. A test now compares each summary to the constructor it
  sits above.

## 0.0.1

The first release: the engine, the schema door, the watcher and the whole
diagnostic surface, through Node-API.

The package is **`dynamic-config-node`**, not `dynamic-config`: that name
belongs to an unrelated package by another author. The qualified name is
the same answer `dynamic-config-py` is on PyPI, and the import is the
package name.

### Added

- **`DynamicConfig<T>`**, generic over whatever the validator returns —
  files, discovery, environment, `.env`, a secrets directory, profiles,
  the runtime layers, and the last-known-good cache.
- **A validator is a function.** Zod's `parse`, an Ajv validator through
  `ajvValidator`, a function of your own, or nothing at all for a
  configuration read by dotted path. No schema library is a dependency of
  this package.
- **A file watcher**, with the property the whole design is for: a
  document the schema refuses installs nothing and leaves the previous one
  serving, from the watcher thread exactly as from an explicit reload.
- **Remote stores written in JavaScript**: `setRemote(fetch, described)`,
  `refreshRemote()` and `remoteStatus()`. The eight Rust stores are a
  second package, for the reason they are a second wheel in Python.
- **The diagnostics**: `sourceOf`, `isSet`, `explain`, `check`,
  `snapshot`, `status`, and `DynamicConfigError` with `kind`, `path`,
  `originKind` and `origin` on it.
- Hand-written TypeScript definitions, so `current()` is `T` under
  `strict: true` with nothing cast.

- **Twelve examples**, seven of them run in CI on every Node version this
  package claims and two typechecked there: a quick start, layering,
  watching, diagnostics, Express, Fastify, Zod/Ajv/no-schema side by side,
  a NestJS provider, Next.js server components, and the React one that
  draws the browser boundary rather than pretending there is none.
- **A book of its own**, at `/dynamic-config/node/`, beside the Rust and
  Python ones.
- **`tests/typing/usage.ts`**, compiled under `strict`,
  `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` — the same
  gate the Python binding has as `mypy --strict`.
- Prebuilt binaries for linux x64/arm64 (glibc), macOS x64/arm64 and
  Windows x64, published as optional dependencies with npm provenance, so
  an install downloads one binary and compiles nothing.

- **`changes()`**, an async iterator of every installed document — the
  shape a service loop wants, and the one where an `await` costs the
  caller rather than the reload. Breaking out of the loop removes the
  subscription.
- **`replace(document)`**: installs a document directly, without sources
  and without the validator, for a test and for configuration that came
  from somewhere this library did not fetch.
- **`setDefaults(values)`** — a whole object at once — and **`strictEnv()`**,
  which refuses `off`/`yes`/`none` instead of handing over the string.
  Both are what the Python binding has, and this is the parity pass.

### Notes

- **There is no `initSync`.** Validation happens inside the load, so the
  load runs on a worker thread and calls back into the event loop; a
  synchronous `init()` would be the loop waiting for itself. The README
  says so rather than leaving somebody to find it at startup.
