"use strict";

/**
 * The ergonomic half of the binding.
 *
 * The compiled half is the engine and one door into JavaScript; everything
 * here is what makes it pleasant to use from a program: the generic class,
 * the error type with fields on it, the cached read path, and the four
 * lines each schema library needs.
 *
 * Written in JavaScript with a hand-written `.d.ts` beside it rather than
 * in TypeScript with a build step. A binding whose install already has to
 * fetch a per-platform binary should not also make `npm install` run a
 * compiler, and the types a caller sees are the same either way.
 */

const { createRequire } = require("node:module");

const load = createRequire(__filename);

/**
 * The addon: the platform package npm installed, or a local build.
 *
 * A published install has exactly one of the five per-platform packages —
 * npm skips the rest by `os`/`cpu` — and a checkout of this repository has
 * `index.node` beside this file instead, from `just node`. Both are tried,
 * in that order, and a failure names both places rather than leaving
 * somebody with `MODULE_NOT_FOUND` and a path they have never seen.
 */
function addon() {
  const platform = `dynamic-config-node-${process.platform}-${process.arch}${
    process.platform === "linux" ? "-glibc" : ""
  }`;

  for (const candidate of [platform, "../index.node"]) {
    try {
      return load(candidate);
    } catch (failure) {
      if (failure.code !== "MODULE_NOT_FOUND") {
        throw failure;
      }
    }
  }

  throw new Error(
    `dynamic-config-node has no binary for ${process.platform} ${process.arch}. ` +
      `Neither the platform package (${platform}) nor a local build ` +
      "(index.node, from `just node`) is here. The published platforms are " +
      "linux x64/arm64 (glibc), darwin x64/arm64 and win32 x64.",
  );
}

const native = addon();

/**
 * What every failure is: the engine's message, plus the three things a
 * program branches on.
 *
 * `kind` is the same word the Rust `ErrorKind` and the Python exception
 * hierarchy use — `io`, `parse`, `missing`, `type`, `env`, `invalid`,
 * `remote`, `auth`, `decrypt`, `backend` — so the same condition is called
 * the same thing in all three languages.
 */
class DynamicConfigError extends Error {
  constructor({ kind, path, originKind, origin, message }) {
    super(message);

    this.name = "DynamicConfigError";
    /** @type {string} */
    this.kind = kind;
    /** @type {string} */
    this.path = path;
    /** @type {string} */
    this.originKind = originKind;
    /** @type {string | null} */
    this.origin = origin;
  }
}

/**
 * The union the native half answers with, turned into a value or a throw.
 *
 * Nothing in the compiled half throws: Node-API cannot attach fields to a
 * rejection raised on a worker thread, and an error whose only structured
 * part is its message is what this library exists not to ship. So the
 * boundary answers `{ ok }` and the throwing happens here, where an `Error`
 * subclass with `kind`, `path` and `origin` on it is one line.
 */
function unwrap(outcome) {
  if (outcome.ok) {
    return outcome.value;
  }

  throw new DynamicConfigError(outcome.error);
}

/**
 * The compiled half of each configuration, reachable inside this module.
 *
 * `#native` is private to `DynamicConfig`, and `ConfigGroup` needs the
 * two-phase reload that lives on it. A `WeakMap` keyed by the facade is
 * the door: nothing outside this file can reach it, and a configuration
 * that goes away takes its entry with it.
 */
const compiled = new WeakMap();

/**
 * Which dotted paths differ between two documents. **Paths, never values.**
 *
 * The audit half of a reload, and the same rule every diagnostic in this
 * library follows: a value in a log line is a secret in a log line. A
 * table that appears or disappears is reported as the table's own path
 * rather than as every leaf under it.
 */
function changedPaths(before, after) {
  const moved = [];

  const walk = (left, right, prefix) => {
    const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

    if (!object(left) || !object(right)) {
      if (JSON.stringify(left) !== JSON.stringify(right)) {
        moved.push(prefix);
      }

      return;
    }

    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const path = prefix === "" ? key : `${prefix}.${key}`;

      if (!(key in left) || !(key in right)) {
        moved.push(path);
        continue;
      }

      walk(left[key], right[key], path);
    }
  };

  walk(before ?? {}, after ?? {}, "");

  return moved.filter((path) => path !== "");
}

/** A `Values`-shaped read: `values.get("cache.ttl")`, one segment at a time. */
function at(document, path) {
  let current = document;

  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

/**
 * One configuration: a schema, where its values live, and the document in
 * force.
 *
 * Every call that touches a source or the network is `async`, because a
 * Node program is an event loop and blocking it is the one thing a
 * configuration library must not do. `current()` is synchronous, because
 * it is a cached object — the same split the Python binding makes, for the
 * same reason.
 */
class DynamicConfig {
  #native;
  #cached = undefined;
  #generation = 0;
  /**
   * A mirror of the override layer, in the order it was pinned.
   *
   * The engine owns the layer and has no way to read it back, and
   * `overrides()` has to *restore* what it found rather than empty it —
   * otherwise a nested block drops the outer one's pin on the way out.
   * The Python binding keeps the same mirror for the same reason.
   */
  #overrides = new Map();
  /**
   * The async store, when one is installed: the fetch, and the document
   * `refreshRemote` has awaited for the engine to collect.
   */
  #awaited = null;

  /**
   * @param {object} options
   * @param {string} options.key the section this configuration reads
   * @param {(document: unknown) => unknown} [options.validate] what turns a
   *   resolved object into the value a program reads — Zod's `parse`, an Ajv
   *   validator, a function of your own. Omitted, the document *is* the
   *   value: no schema, read by path. Synchronous, and returning plain
   *   data: its answer is serialised into the store, so a class instance
   *   comes back without its prototype and a `Date` comes back as `{}`.
   * @param {string[]} [options.secrets] dotted paths whose values must never
   *   reach a diagnostic. A redacting cache is refused without them.
   * @param {string[]} [options.fields] the keys the schema declares, for the
   *   unknown-key report. `check()` says it compared nothing without them.
   */
  constructor({ key, validate, secrets, fields } = {}) {
    if (typeof key !== "string") {
      throw new TypeError("a configuration needs a `key`: the section it reads");
    }

    this.#native = new native.Config(key, validate ?? null, secrets ?? null, fields ?? null);

    // The read path, and the reason it is cheap: the engine publishes each
    // installed document through this hook, so `current()` never crosses
    // back into Rust. A configuration is read on every request; a boundary
    // crossing per read would be the whole cost of this library.
    this.#native.onReload((document) => {
      this.#cached = document;
      this.#generation = this.#native.generation();
    });

    // For `ConfigGroup`, which drives the two-phase reload and is the only
    // thing outside this class that has any business with it.
    compiled.set(this, this.#native);
  }

  /** The section key this configuration reads. */
  get key() {
    return this.#native.key;
  }

  // ── Sources, in call order ────────────────────────────────────────────

  /** A file to read. Files merge left to right. */
  file(path) {
    unwrap(this.#native.file(path));

    return this;
  }

  /**
   * Look for `name.{toml,json,yaml}` in each of `paths`.
   *
   * **Every** directory with a match contributes a file, layered in search
   * order — so `/etc` defaults, `~/.config` overrides and a local file
   * wins. Stopping at the first hit would make naming two directories
   * pointless.
   */
  discover(name, paths) {
    unwrap(this.#native.discover(name, paths));

    return this;
  }

  /** Read `PREFIX_KEY_*` from the environment. */
  env(prefix) {
    unwrap(this.#native.env(prefix));

    return this;
  }

  /** The separator that spells nesting in a variable name. `__` by default. */
  nest(separator) {
    unwrap(this.#native.nest(separator));

    return this;
  }

  /** Treat an empty variable as a value rather than as absent. */
  allowEmptyEnv() {
    unwrap(this.#native.allowEmptyEnv());

    return this;
  }

  /**
   * Refuse an environment value this crate cannot type rather than
   * guessing: `APP_DB_PORT=eight` becomes a load failure instead of a
   * string where a number was declared.
   */
  strictEnv() {
    unwrap(this.#native.strictEnv());

    return this;
  }

  /** The file has no section header: its whole document is this section. */
  wholeDocument() {
    unwrap(this.#native.wholeDocument());

    return this;
  }

  /** A `.env` file, which sits just below the real environment. */
  envFile(path) {
    unwrap(this.#native.envFile(path));

    return this;
  }

  /** A directory of one-file-per-key secrets, as Docker and Kubernetes mount. */
  secretsDir(path) {
    unwrap(this.#native.secretsDir(path));

    return this;
  }

  /** Which variable names the profile to select. */
  profileEnv(variable) {
    unwrap(this.#native.profileEnv(variable));

    return this;
  }

  /**
   * Write the last good document here, so a broken source at startup is
   * survivable.
   *
   * @param {string} path
   * @param {"full" | "redacted" | "fingerprint"} mode
   */
  cache(path, mode) {
    unwrap(this.#native.cache(path, mode));

    return this;
  }

  // ── The runtime layers ────────────────────────────────────────────────

  /** A fallback the program computes; the bottom layer. */
  setDefault(path, value) {
    unwrap(this.#native.setDefault(path, value));

    return this;
  }

  /**
   * A whole object as defaults at once, rather than a path at a time.
   *
   * What a hand-written `defaults()` becomes: every leaf is a default, and
   * a file that states any of them wins.
   */
  setDefaults(values) {
    unwrap(this.#native.setDefaults(values));

    return this;
  }

  /** Wins over everything, which is what makes it useful in a test. */
  setOverride(path, value) {
    unwrap(this.#native.setOverride(path, value));
    this.#overrides.set(path, value);

    return this;
  }

  clearDefaults() {
    this.#native.clearDefaults();

    return this;
  }

  clearOverrides() {
    this.#native.clearOverrides();
    this.#overrides.clear();

    return this;
  }

  /**
   * `--set key=value` pairs, as a command line hands them over.
   *
   * The key is the path *inside this configuration's section* — `port=1`,
   * not `db.port=1` — the same path `setDefault` and `explain` take.
   */
  setAssignments(assignments) {
    unwrap(this.#native.setAssignments(assignments));

    return this;
  }

  clearAssignments() {
    this.#native.clearAssignments();

    return this;
  }

  /** Bind one path to one variable name, whatever the prefix rule says. */
  bindEnv(path, variable) {
    unwrap(this.#native.bindEnv(path, variable));

    return this;
  }

  /** Accept `from` as another spelling of `to`. */
  alias(from, to) {
    unwrap(this.#native.alias(from, to));

    return this;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /** Load, validate, install. */
  async init() {
    unwrap(await this.#native.init());
    await this.#settle();

    return this;
  }

  /** …and hand back the document, for the code that wants the values. */
  async initAndCurrent() {
    await this.init();

    return this.current();
  }

  /** Again, on demand. A failure installs nothing and keeps the last good. */
  async reload() {
    unwrap(await this.#native.reload());
    await this.#settle();

    return this.current();
  }

  /**
   * Waits for the hooks this install queued.
   *
   * A document is installed on a worker thread, and the hooks are
   * `ThreadsafeFunction` calls it queues for the loop. Returning before
   * they run would make `await reload()` mean *the document is installed*
   * but not *your hook has seen it* — two things a caller has every right
   * to think are one. One turn of the loop is the whole cost, and only on
   * the explicit paths: a watcher-driven reload has no `await` to hang it
   * on and fires its hooks whenever the loop next breathes, which is what
   * a watcher is.
   */
  async #settle() {
    this.#pull();

    await new Promise((resolve) => setImmediate(resolve));
  }

  /**
   * Load and validate, installing nothing.
   *
   * What a `--check` flag and a test both want: the candidate, without
   * touching what is serving.
   */
  async load() {
    return unwrap(await this.#native.load());
  }

  /** The document in force. Throws before the first successful load. */
  current() {
    const document = this.tryCurrent();

    if (document === undefined) {
      throw new DynamicConfigError({
        kind: "backend",
        path: "",
        originKind: "unknown",
        origin: null,
        message:
          `${this.key} has no document installed; await init() before ` +
          "reading it. tryCurrent() answers undefined instead of throwing.",
      });
    }

    return document;
  }

  /** The document in force, or `undefined`. For code that would rather ask. */
  tryCurrent() {
    // The hook keeps `#cached` current; this covers the one case it cannot
    // — a document installed before the hook was registered, which is what
    // a `load()` from another configuration object on the same file does.
    if (this.#generation !== this.#native.generation()) {
      this.#pull();
    }

    return this.#cached;
  }

  /** One value, by dotted path, from the document in force. */
  get(path, fallback = undefined) {
    const found = at(this.tryCurrent(), path);

    return found === undefined ? fallback : found;
  }

  #pull() {
    const document = this.#native.currentValue();

    this.#cached = document === null ? undefined : document;
    this.#generation = this.#native.generation();
  }

  /**
   * Installs `document` directly, without loading anything.
   *
   * The testing door, and the one for configuration that comes from
   * somewhere this library does not know about. It bumps the generation
   * and fires the hooks exactly as a load does; what it skips is the
   * sources and the validator, because the caller is asserting they
   * already did that.
   *
   * It skips the engine too, which is why `status()` and
   * `snapshot().generation` go on describing the last real load: the
   * engine did not perform this install, and reporting one it never saw
   * would be worse than being a load behind. `current()` and
   * `generation` here are the replaced document's.
   */
  replace(document) {
    unwrap(this.#native.replace(document));
    this.#pull();

    return this;
  }

  /**
   * Every installed document, as an async iterator.
   *
   * The shape a service loop wants — and the reason it exists rather than
   * `onReload` alone: a hook runs *inside* the reload, and anything slow
   * in one holds the next. This yields on the loop, after the install,
   * where an `await` costs the caller and nobody else.
   *
   * ```js
   * for await (const document of config.changes()) {
   *   await pool.resize(document.pool.maxSize)
   * }
   * ```
   *
   * A consumer that falls behind is handed the document **in force**, not
   * the ones it missed: there is one slot, and each install overwrites it.
   * That is the right trade for a configuration reader — resizing a pool
   * to a size nobody is asking for any more is work done for nothing —
   * and the wrong one for an audit log, which wants `onReload`, where
   * every install arrives.
   *
   * @param {object} [options]
   * @param {AbortSignal} [options.signal] ends the iteration when it
   *   aborts — a `return`, not an error, exactly as a `break` in the
   *   caller's loop would end it. What lets a stream share the lifetime
   *   of a request or a server instead of needing its own.
   */
  async *changes({ signal } = {}) {
    let pending;
    let wake;

    const token = this.onReload((document) => {
      // The newest wins: a consumer that fell behind wants the document
      // in force, not the three it missed on the way here.
      pending = document;
      wake?.();
    });
    const onAbort = () => wake?.();

    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      for (;;) {
        if (signal?.aborted) {
          return;
        }

        if (pending === undefined) {
          await new Promise((resolve) => {
            wake = resolve;
          });
        }

        if (signal?.aborted) {
          return;
        }

        const document = pending;

        pending = undefined;
        wake = undefined;

        yield document;
      }
    } finally {
      // A `break` or a `return` in the caller's loop lands here.
      this.removeHook(token);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Every install *and* every refusal, as typed events.
   *
   * `changes()` is the document stream a service loop wants; this is the
   * diagnostic one — what a log line, a metric or an alert is built from:
   *
   * ```js
   * for await (const event of config.events()) {
   *   if (event.type === "reloadFailed" && event.consecutive > 3) {
   *     alert(`configuration refused at ${event.path}: ${event.kind}`)
   *   }
   * }
   * ```
   *
   * **No event carries a value.** Paths, kinds, counts and timestamps
   * only — the same rule `explain()` and `check()` follow, and for the
   * same reason.
   *
   * A refusal wakes this stream natively: the engine's failure hook
   * reaches the loop the same way an install's does, so `reloadFailed`
   * arrives when the refusal happens — no timer, no polling, nothing to
   * keep the process up. Delivery is latest-wins, like `changes()`:
   * refusals with nothing awake in between arrive as one event carrying
   * the current `consecutive` count, and a refusal followed by an
   * install arrives as both events, refusal first, because that is the
   * order they occurred in.
   *
   * @param {object} [options]
   * @param {AbortSignal} [options.signal] ends the iteration when it
   *   aborts — a `return`, not an error, as a `break` would.
   * @param {number} [options.failurePollMs] **deprecated, ignored** —
   *   the interval refusals used to be polled at, before they could wake
   *   anything. They can now; passing it changes nothing and warns once.
   */
  async *events({ signal, failurePollMs } = {}) {
    if (failurePollMs !== undefined) {
      process.emitWarning(
        "failurePollMs is ignored: a refused reload wakes events() natively now, and nothing is polled",
        { type: "DeprecationWarning", code: "DYNAMIC_CONFIG_FAILURE_POLL" },
      );
    }

    let failures = this.status().consecutiveFailures;
    let previous = this.tryCurrent();
    let pending;
    let refused = false;
    let wake;

    const token = this.onReload((document) => {
      pending = document;
      wake?.();
    });
    const failureToken = this.onReloadFailed(() => {
      refused = true;
      wake?.();
    });
    const onAbort = () => wake?.();

    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      for (;;) {
        if (signal?.aborted) {
          return;
        }

        if (pending === undefined && !refused) {
          await new Promise((resolve) => {
            wake = resolve;
          });

          wake = undefined;
        }

        if (signal?.aborted) {
          return;
        }

        const document = pending;

        pending = undefined;
        refused = false;

        const status = this.status();
        const at = Date.now();

        if (status.consecutiveFailures > failures) {
          failures = status.consecutiveFailures;

          yield {
            type: "reloadFailed",
            at,
            generation: status.generation,
            kind: status.lastFailure?.kind ?? "backend",
            path: status.lastFailure?.path ?? "",
            consecutive: status.consecutiveFailures,
          };
        } else {
          failures = status.consecutiveFailures;
        }

        if (document !== undefined) {
          const before = previous;

          previous = document;

          yield {
            type: "reloaded",
            at,
            generation: this.generation,
            changed: before === undefined ? [] : changedPaths(before, document),
            reason: status.lastReason ?? "manual",
          };
        }
      }
    } finally {
      this.removeHook(token);
      this.removeFailureHook(failureToken);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Load, watch, run, stop — the whole lifetime of a service, as one call.
   *
   * ```js
   * await config.running(async (database) => {
   *   await serve(database)
   * })
   * ```
   *
   * JavaScript has no `with`, so the block is a function. What it buys is
   * the same thing: the watcher cannot be left running by an exception on
   * the way out, and there is no handle to forget.
   *
   * @param {(document: unknown) => unknown} body what to run while it is loaded
   * @param {object} [options]
   * @param {boolean} [options.watch] start a watcher too. `true` by default.
   * @param {number} [options.debounceMs]
   * @param {number} [options.pollMs]
   */
  async running(body, { watch = true, debounceMs, pollMs } = {}) {
    const document = await this.initAndCurrent();

    if (!watch) {
      return await body(document);
    }

    this.watch({ debounceMs, pollMs });

    try {
      return await body(document);
    } finally {
      this.stopWatching();
    }
  }

  /** How many documents have been installed. */
  get generation() {
    return this.#native.generation();
  }

  // ── Watching, and hooks ───────────────────────────────────────────────

  /**
   * Reload whenever a file this configuration reads changes.
   *
   * @param {object} [options]
   * @param {number} [options.debounceMs] how long to wait for an editor to
   *   finish writing. 250 by default.
   * @param {number} [options.pollMs] re-stat instead of subscribing, which
   *   is what a network or overlay filesystem needs — a container bind
   *   mount delivers no events.
   * @param {AbortSignal} [options.signal] stops the watcher when it
   *   aborts — the idiom the rest of Node uses for "until this says
   *   stop", so a watcher can share the lifetime of a server or a test
   *   without a matching `stopWatching()` call to forget.
   */
  watch({ debounceMs, pollMs, signal } = {}) {
    unwrap(this.#native.watch(debounceMs ?? null, pollMs ?? null));

    if (signal !== undefined) {
      if (signal.aborted) {
        this.stopWatching();
      } else {
        signal.addEventListener("abort", () => this.stopWatching(), { once: true });
      }
    }

    return this;
  }

  stopWatching() {
    this.#native.stopWatching();

    return this;
  }

  /**
   * Called with each installed document, on the event loop.
   *
   * Returns the token that removes it again.
   */
  onReload(hook) {
    return this.#native.onReload(hook);
  }

  removeHook(token) {
    return this.#native.removeHook(token);
  }

  /**
   * The failure twin of `onReload`: called on the event loop after every
   * reload that installs nothing, with no argument — what happened is
   * `status()`'s to tell, and reading it there keeps values and error
   * text out of the hook path.
   *
   * ```js
   * config.onReloadFailed(() => {
   *   const { consecutiveFailures, lastFailure } = config.status()
   *   metrics.increment("config_reload_failed", { kind: lastFailure?.kind })
   * })
   * ```
   *
   * Returns the token `removeFailureHook` takes.
   */
  onReloadFailed(hook) {
    return this.#native.onReloadFailed(hook);
  }

  removeFailureHook(token) {
    return this.#native.removeFailureHook(token);
  }

  /**
   * `onReload` for a hook that returns a promise, with a rule for what
   * happens when installs outrun it.
   *
   * ```js
   * config.onReloadAsync(async (document) => {
   *   await pool.resize(document.pool.maxSize)
   * })
   * ```
   *
   * A hook already runs on the event loop here — there is no watcher
   * thread to move it off, the way the Python binding has to. What this
   * adds is the part JavaScript does not do for you: an `async` hook
   * handed to `onReload` returns a promise nobody awaits, so two installs
   * in quick succession run their bodies interleaved, and a rejection
   * becomes an unhandled one.
   *
   * @param {(document: unknown, context: { signal: AbortSignal }) => Promise<void>} hook
   * @param {object} [options]
   * @param {"latest" | "serial" | "every"} [options.backpressure] what to
   *   do when an install lands while the hook is still running.
   *   `"latest"` — the default — keeps the newest and drops what it
   *   overtook, which is what configuration usually means: resizing a
   *   pool to a size nobody is asking for any more is work done for
   *   nothing. `"serial"` runs every one in order, for a hook that is an
   *   audit trail rather than a reconciliation. `"every"` starts each as
   *   it arrives, which is `onReload` with the promise still unawaited.
   * @param {(error: unknown) => void} [options.onError] what to do with a
   *   rejection. Reported to `console.error` by default, because a
   *   configuration hook is not the place to end a process.
   * @returns the token that removes it again
   */
  onReloadAsync(hook, { backpressure = "latest", onError } = {}) {
    if (!["latest", "serial", "every"].includes(backpressure)) {
      throw new TypeError(
        `\`${backpressure}\` is not a backpressure policy: use "latest", ` +
          '"serial" or "every"',
      );
    }

    const report =
      onError ??
      ((error) => {
        console.error("a dynamic-config reload hook rejected:", error);
      });

    let running = false;
    let queued = [];
    let controller;

    const start = async (document) => {
      running = true;
      controller = new AbortController();

      try {
        await hook(document, { signal: controller.signal });
      } catch (failure) {
        report(failure);
      }

      const next = queued.shift();

      running = false;

      if (next !== undefined) {
        void start(next);
      }
    };

    return this.onReload((document) => {
      if (backpressure === "every" || !running) {
        void start(document);

        return;
      }

      // One slot for `latest`, a queue for `serial`: the difference
      // between "what is true now" and "everything that was true".
      queued = backpressure === "latest" ? [document] : [...queued, document];

      if (backpressure === "latest") {
        // The call still running is about to be superseded. Nothing can
        // cancel a promise, so what it gets is the signal to stop on its
        // own — which a hook doing I/O can pass to `fetch` or to a query.
        controller?.abort();
      }
    });
  }

  /**
   * Called when the value at `path` changes, and not otherwise.
   *
   * Paths, not values, is what the engine reports elsewhere; here the
   * value is what a caller wants, and it is theirs already.
   */
  onChange(path, hook) {
    let last = at(this.tryCurrent(), path);

    return this.onReload((document) => {
      const now = at(document, path);

      if (JSON.stringify(now) !== JSON.stringify(last)) {
        const previous = last;

        last = now;
        hook(now, previous);
      }
    });
  }

  // ── Remote stores ─────────────────────────────────────────────────────

  /**
   * A store written in JavaScript: anything that can answer with text.
   *
   * `fetch` must be **synchronous** — it is called from a worker thread
   * through the event loop, and a promise cannot be awaited from there.
   * An async source keeps its own last answer and hands that over:
   *
   * ```js
   * let latest = { text: "{}", format: "json" }
   * setInterval(async () => { latest = await read() }, 30_000)
   * config.setRemote(() => latest, "our config service")
   * ```
   */
  setRemote(fetch, described = "a remote source written in JavaScript") {
    this.#awaited = null;
    unwrap(this.#native.setRemote(fetch, described));

    return this;
  }

  /**
   * A store whose client is async — which, in JavaScript, is most of them.
   *
   * ```js
   * config.setRemoteAsync(async () => {
   *   const response = await fetch(URL, { signal: AbortSignal.timeout(5000) })
   *
   *   return { text: await response.text(), format: "json" }
   * }, "our control plane")
   *
   * await config.refreshRemote()
   * ```
   *
   * The engine calls a store from a worker thread, where a promise cannot
   * be awaited — which is why `setRemote` needs a synchronous function and
   * why the advice used to be *keep the last answer in a variable and hand
   * that over*. This awaits the fetch on the event loop first, inside
   * `refreshRemote()`, and hands the engine the document it already has.
   *
   * Two things follow from that ordering: the deadline is yours, as it
   * always was — `AbortSignal.timeout` rather than a 30-second wall — and
   * a rejection reaches the caller as its own error rather than as a
   * `remote` failure, because nothing has entered the engine yet.
   */
  setRemoteAsync(fetch, described = "an async remote source written in JavaScript") {
    this.#awaited = { fetch, handed: undefined };

    // The courier. The engine calls this on the loop through a
    // threadsafe function; by then `refreshRemote` has already awaited
    // the real one and left the answer here.
    unwrap(
      this.#native.setRemote(() => {
        const handed = this.#awaited?.handed;

        if (this.#awaited === null || handed === undefined) {
          throw new Error(
            "this store is asynchronous: its document is awaited by " +
              "refreshRemote() before the engine is called, and there is " +
              "none waiting here",
          );
        }

        this.#awaited.handed = undefined;

        return handed;
      }, described),
    );

    return this;
  }

  /**
   * Fetch from the store into the remote layer.
   *
   * The document is not installed by this: a fetch fills the layer, and
   * `reload()` is what resolves and validates it — the same two steps the
   * Rust and Python bindings make explicit.
   */
  async refreshRemote() {
    if (this.#awaited !== null) {
      // Awaited here, on the loop, and before anything enters the engine:
      // a rejection is the caller's own error, and an `AbortSignal` the
      // fetch is given still means what it means.
      this.#awaited.handed = await this.#awaited.fetch();
    }

    unwrap(await this.#native.refreshRemote());

    return this;
  }

  clearRemote() {
    this.#awaited = null;
    this.#native.clearRemote();

    return this;
  }

  get remoteDescription() {
    return this.#native.remoteDescription();
  }

  /** What the store has answered, for an operator asking. */
  remoteStatus() {
    return unwrap(this.#native.remoteStatus());
  }

  // ── Diagnostics ───────────────────────────────────────────────────────

  /** Which layer supplies `path` on the next load, and from where. */
  sourceOf(path) {
    return unwrap(this.#native.sourceOf(path));
  }

  /** Whether anything supplies `path` at all. */
  isSet(path) {
    return unwrap(this.#native.isSet(path));
  }

  /** Every layer's answer for one path, and which one wins. */
  explain(path) {
    return unwrap(this.#native.explain(path)).rendered;
  }

  /** Would it load? Any unknown keys? */
  check() {
    return unwrap(this.#native.check());
  }

  /** The document, the generation, and how old it is. */
  snapshot() {
    return unwrap(this.#native.snapshot());
  }

  /** Reloads, failures and the last one, for a health endpoint. */
  status() {
    return unwrap(this.#native.status());
  }

  /**
   * Pins values for the duration of `body`, and puts them back after.
   *
   * The testing door: no filesystem, no environment, and it restores what
   * it found rather than emptying the layer — so a nested block does not
   * drop the outer one's pin on the way out.
   */
  async overrides(values, body) {
    const before = new Map(this.#overrides);

    for (const [path, value] of Object.entries(values)) {
      this.setOverride(path, value);
    }

    try {
      await this.reload();

      return await body();
    } finally {
      this.clearOverrides();

      for (const [path, value] of before) {
        this.setOverride(path, value);
      }

      // The reload that puts things back must not decide what the caller
      // sees: a failing assertion inside the block is the interesting
      // failure, and a broken file discovered while cleaning up after it
      // would replace that with itself.
      try {
        await this.reload();
      } catch {
        // Deliberately swallowed. The configuration is back where it was
        // either way, and the next `reload()` a caller makes will report
        // whatever is wrong with it.
      }
    }
  }
}


/**
 * Several configurations, one lifecycle.
 *
 * A service with five configurations writes the orchestration itself:
 * init each, watch each, remember every handle, stop them in the right
 * order on the way out. None of that is application logic, and all of it
 * is the same in every service.
 *
 * ```js
 * const group = new ConfigGroup(database, cache, queue)
 *
 * await group.running(async () => {
 *   await serve()
 * })
 * ```
 *
 * The group owns *lifecycle*, not storage: `database.current()` is still
 * the read, and nothing here sits between a program and its values.
 */
class ConfigGroup {
  #configs;

  /** @param {...DynamicConfig} configs the members, in start order */
  constructor(...configs) {
    if (configs.length === 0) {
      throw new TypeError("a group of no configurations has nothing to do");
    }

    const keys = configs.map((config) => config.key);
    const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);

    if (duplicates.length > 0) {
      throw new TypeError(
        "two configurations in one group share a key, and a group reports " +
          `per key: ${[...new Set(duplicates)].join(", ")}`,
      );
    }

    this.#configs = configs;
  }

  /** The members, in the order they were given. */
  get configs() {
    return [...this.#configs];
  }

  get size() {
    return this.#configs.length;
  }

  [Symbol.iterator]() {
    return this.#configs[Symbol.iterator]();
  }

  /**
   * Loads every member, concurrently.
   *
   * `Promise.all` rather than a loop: three files are three loads on
   * libuv's pool, and queueing them behind each other buys nothing. The
   * first failure is what throws; members that had already loaded keep
   * what they loaded, which is what makes this *not* `reloadAtomic`.
   */
  async init() {
    await Promise.all(this.#configs.map((config) => config.init()));

    return this;
  }

  /**
   * Reloads every member, independently.
   *
   * A member that refuses keeps its previous document — the engine's
   * rule, unchanged — and every other member still reloads, so all of
   * them have their turn and the first failure is thrown at the end
   * rather than in the middle.
   */
  async reload() {
    const outcomes = await Promise.allSettled(
      this.#configs.map((config) => config.reload()),
    );

    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        throw outcome.reason;
      }
    }

    return this;
  }

  /**
   * Every member validates, or no member installs.
   *
   * The mixed state this exists to prevent: a deployment moves three
   * files, two parse and one does not, and the process runs on two new
   * documents and one old one — with nothing in any of them saying so.
   *
   * ```js
   * await group.reloadAtomic()
   * ```
   *
   * Every member loads and validates first; only when all of them have
   * does any of them install. A refusal leaves every document exactly as
   * it was, generation included. It is the engine's own `ReloadGroup` —
   * prepare, then commit — driven from JavaScript.
   */
  async reloadAtomic() {
    const prepared = [];

    try {
      // Prepared concurrently: the fallible half is I/O, and the whole
      // point is that none of it installs until all of it has succeeded.
      const tokens = await Promise.all(
        this.#configs.map(async (config) => {
          const native = compiled.get(config);

          return [native, unwrap(await native.prepare())];
        }),
      );

      prepared.push(...tokens);
    } catch (failure) {
      for (const [native, token] of prepared) {
        native.discard(token);
      }

      throw failure;
    }

    // And committed in order, with nothing fallible in between: a commit
    // is a swap and the hooks that follow it.
    while (prepared.length > 0) {
      const [native, token] = prepared.shift();

      try {
        unwrap(native.commit(token));
      } catch (failure) {
        for (const [other, remaining] of prepared) {
          other.discard(remaining);
        }

        throw failure;
      }
    }

    return this;
  }

  /** Starts a watcher for every member. */
  watch(options) {
    for (const config of this.#configs) {
      config.watch(options);
    }

    return this;
  }

  /** Stops every watcher this group started. Idempotent. */
  stopWatching() {
    for (const config of this.#configs) {
      config.stopWatching();
    }

    return this;
  }

  /**
   * init, then watch, then stop — the whole lifetime as one call.
   *
   * ```js
   * await group.running(async () => {
   *   await serve()
   * })
   * ```
   */
  async running(body, { watch = true, debounceMs, pollMs } = {}) {
    await this.init();

    if (!watch) {
      return await body(this);
    }

    this.watch({ debounceMs, pollMs });

    try {
      return await body(this);
    } finally {
      this.stopWatching();
    }
  }

  /** Every member's status, by key — one call for a health endpoint. */
  status() {
    return Object.fromEntries(
      this.#configs.map((config) => [config.key, config.status()]),
    );
  }

  /**
   * Every member's generation, by key.
   *
   * Equal numbers promise nothing on their own: members reload
   * independently unless `reloadAtomic` installed them.
   */
  generations() {
    return Object.fromEntries(
      this.#configs.map((config) => [config.key, config.generation]),
    );
  }
}

/**
 * Zod, in the four lines it takes.
 *
 * Deliberately not a dependency: a schema library belongs to the program,
 * not to its configuration loader, and this is the whole adapter.
 */
function zodValidator(schema) {
  return (document) => schema.parse(document);
}

/**
 * The same for Ajv, whose validator answers `false` and keeps the reason
 * on itself.
 */
function ajvValidator(validate) {
  return (document) => {
    if (!validate(document)) {
      throw new Error(
        (validate.errors ?? [])
          .map((error) => `${error.instancePath || "(root)"} ${error.message}`)
          .join("; ") || "the document did not validate",
      );
    }

    return document;
  };
}

/**
 * Routes the engine's own diagnostics — one line per reload, a warning
 * per failed one — to a handler of yours instead of stderr.
 *
 *     setLogger({ handler: (level, line) => log[level](line) });
 *     setLogger({ level: "warn" });          // quieter, still stderr
 *     setLogger(null);                        // back to the default
 *
 * `level` is `"off"`, `"warn"` or `"info"` (the default); it gates the
 * engine's emission wherever the lines are going. `handler` receives
 * `("info" | "warn", line)` on the event loop — never on the watcher
 * thread — and holding one registered does not keep the process alive.
 * Without a handler the engine keeps writing `[dynamic-config]` lines to
 * stderr, unchanged since 0.0.1: Node has no one logging module to bridge
 * to by default, so the default stays put and the seam is yours.
 */
function setLogger(options) {
  if (options === null) {
    native._clearLogSink();
    native._setLogLevel("info");
    return;
  }

  const { level, handler } = options ?? {};

  if (handler !== undefined) {
    if (handler === null) {
      native._clearLogSink();
    } else {
      // The native side hands the pair across as one array argument.
      native._setLogSink(([name, line]) => handler(name, line));
    }
  }

  if (level !== undefined) {
    native._setLogLevel(level);
  }
}

module.exports = {
  ConfigGroup,
  DynamicConfig,
  DynamicConfigError,
  changedPaths,
  setLogger,
  zodValidator,
  ajvValidator,
  packageVersion: native.packageVersion,
  engineVersion: native.engineVersion,
};
