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
   */
  async *changes() {
    let pending;
    let wake;

    const token = this.onReload((document) => {
      // The newest wins: a consumer that fell behind wants the document
      // in force, not the three it missed on the way here.
      pending = document;
      wake?.();
    });

    try {
      for (;;) {
        if (pending === undefined) {
          await new Promise((resolve) => {
            wake = resolve;
          });
        }

        const document = pending;

        pending = undefined;
        wake = undefined;

        yield document;
      }
    } finally {
      // A `break` or a `return` in the caller's loop lands here.
      this.removeHook(token);
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
   */
  watch({ debounceMs, pollMs } = {}) {
    unwrap(this.#native.watch(debounceMs ?? null, pollMs ?? null));

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
    unwrap(this.#native.setRemote(fetch, described));

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
    unwrap(await this.#native.refreshRemote());

    return this;
  }

  clearRemote() {
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

module.exports = {
  DynamicConfig,
  DynamicConfigError,
  zodValidator,
  ajvValidator,
  packageVersion: native.packageVersion,
  engineVersion: native.engineVersion,
};
