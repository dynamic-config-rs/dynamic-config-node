/**
 * Hot-reloadable configuration for Node.js: Rust resolves, your schema
 * validates, JavaScript reads a cached object.
 *
 * Hand-written rather than generated, and it is the contract: the compiled
 * half speaks plain objects, so a generated `.d.ts` would say `unknown`
 * where a caller wants their own type. `DynamicConfig<T>` is generic over
 * whatever the validator returns, which means `config.current()` is `T`
 * under `strict: true` with nothing cast.
 */

/** What the engine calls a failure, the same word in all three languages. */
export type ErrorKind =
  | "io"
  | "parse"
  | "missing"
  | "type"
  | "env"
  | "invalid"
  | "remote"
  | "auth"
  | "decrypt"
  | "backend";

/** Where a value came from, or where a failure happened. */
export type OriginKind = "file" | "env" | "inline" | "remote" | "runtime" | "unknown";

/**
 * Every failure this package throws.
 *
 * `kind` is what a program branches on; `origin` is the first question of
 * every configuration bug — *which source set this?* — answered without
 * parsing prose.
 */
export class DynamicConfigError extends Error {
  readonly kind: ErrorKind;
  /** The dotted key path, or `""` when the failure is the load's. */
  readonly path: string;
  readonly originKind: OriginKind;
  /** The file, the variable, the store — whatever `originKind` names. */
  readonly origin: string | null;
}

/** Which layer supplies a path, and from where. */
export interface Source {
  readonly kind: OriginKind;
  readonly detail: string | null;
}

/** A key the sources supply and the schema does not declare. */
export interface UnknownKey {
  readonly path: string;
  /** The field it was probably a typo for, when there is an obvious one. */
  readonly suggestion: string | null;
}

/** Would it load? Any unknown keys? */
export interface Report {
  /** The table the Rust crate prints, rendered. */
  readonly rendered: string;
  readonly isClean: boolean;
  readonly unknown: readonly UnknownKey[];
  /**
   * `false` for a configuration with no field list, where an empty
   * `unknown` would read as an all-clear it never earned.
   */
  readonly unknownChecked: boolean;
  readonly failure: string | null;
}

/** The document in force, and how old it is. */
export interface Snapshot<T> {
  readonly generation: number;
  readonly document: T;
  readonly loadedAtAgoMs: number;
}

/** What has happened to this configuration, for a health endpoint. */
export interface Status {
  readonly key: string;
  readonly generation: number;
  readonly consecutiveFailures: number;
  readonly lastReason: string | null;
  readonly lastFailure: { readonly kind: ErrorKind; readonly path: string } | null;
}

/** What a remote store has answered, for an operator asking. */
export interface RemoteStatus {
  /** `null` before anything has been asked of the store at all. */
  readonly reachable: boolean | null;
  readonly fetches: number;
  readonly consecutiveFailures: number;
  readonly lastFailure: { readonly kind: ErrorKind; readonly path: string } | null;
}

/** What a remote source answers with. */
export interface Document {
  readonly text: string;
  readonly format: "json" | "toml" | "yaml";
}

/** A document installed, as `events()` reports it. */
export interface Reloaded {
  readonly type: "reloaded";
  /** A Unix timestamp, in milliseconds. */
  readonly at: number;
  readonly generation: number;
  /** The dotted paths whose values moved. Empty on the first install. */
  readonly changed: readonly string[];
  /** `initial`, `file changed`, `remote changed`, `manual`, `recovered`. */
  readonly reason: string;
}

/** A document refused, as `events()` reports it. */
export interface ReloadFailed {
  readonly type: "reloadFailed";
  readonly at: number;
  readonly generation: number;
  readonly kind: ErrorKind;
  /** The dotted key the failure is about, or `""` when it is the load's. */
  readonly path: string;
  /** How many refusals in a row: one is a typo, nine is an outage. */
  readonly consecutive: number;
}

/**
 * What `events()` yields. **No event carries a value** — paths, kinds,
 * counts and timestamps only, the same rule every diagnostic here follows.
 */
export type ConfigEvent = Reloaded | ReloadFailed;

/** What to do when installs outrun an async hook. */
export type Backpressure = "latest" | "serial" | "every";

/**
 * The environment's `AbortSignal`, when the environment has one.
 *
 * This file declares no DOM and no `@types/node` dependency — a binding's
 * types should compile under `"types": []`, and the gate checks that. So
 * the signal resolves to the real global in a project that has one, and to
 * the two members this library actually promises in a project that does
 * not.
 */
export type ReloadSignal = typeof globalThis extends {
  AbortSignal: new (...arguments_: never) => infer Signal;
}
  ? Signal
  : { readonly aborted: boolean };

export interface AsyncHookOptions {
  /**
   * `"latest"` (the default) keeps the newest install and drops what it
   * overtook; `"serial"` runs every one in order; `"every"` starts each as
   * it arrives.
   */
  backpressure?: Backpressure;
  /** What to do with a rejection. `console.error` by default. */
  onError?: (error: unknown) => void;
}

export interface RunningOptions extends WatchOptions {
  /** Start a watcher for the length of the block. `true` by default. */
  watch?: boolean;
}

export interface Options<T> {
  /** The section this configuration reads: `[db]` in a TOML file. */
  key: string;
  /**
   * What turns a resolved object into the value the program reads.
   *
   * Zod's `parse`, an Ajv validator, a function of your own. Omit it and
   * the document *is* the value — no schema, read by path.
   *
   * **Synchronous, and returning plain data.** It runs inside the load on
   * a worker thread, so a promise cannot be awaited there; and its answer
   * is serialised on the way into the store, so a class instance comes
   * back with its prototype gone and a `Date` comes back as `{}`.
   */
  validate?: (document: unknown) => T;
  /** Dotted paths whose values must never reach a diagnostic. */
  secrets?: string[];
  /** The keys the schema declares, for the unknown-key report. */
  fields?: string[];
}

export interface WatchOptions {
  /** How long to wait for an editor to finish writing. 250 by default. */
  debounceMs?: number;
  /**
   * Re-stat on an interval instead of subscribing, which is what a network
   * or overlay filesystem needs — a container bind mount delivers no
   * events.
   */
  pollMs?: number;
}

/**
 * One configuration: a schema, where its values live, and the document in
 * force.
 *
 * Every call that touches a source or the network is `async`, because a
 * Node program is an event loop. `current()` is synchronous, because it is
 * a cached object.
 */
export class DynamicConfig<T = unknown> {
  constructor(options: Options<T>);

  readonly key: string;
  readonly generation: number;

  // Sources, in call order.
  file(path: string): this;
  /**
   * Look for `name` in each of `paths`. **Every** directory with a match
   * contributes a file, layered in search order — the last one wins.
   */
  discover(name: string, paths: string[]): this;
  env(prefix: string): this;
  nest(separator: string): this;
  allowEmptyEnv(): this;
  /** Refuse an environment value this crate cannot type, rather than guessing. */
  strictEnv(): this;
  wholeDocument(): this;
  envFile(path: string): this;
  secretsDir(path: string): this;
  profileEnv(variable: string): this;
  cache(path: string, mode: "full" | "redacted" | "fingerprint"): this;

  // The runtime layers.
  setDefault(path: string, value: unknown): this;
  /** A whole object as defaults at once: every leaf of it is one. */
  setDefaults(values: Record<string, unknown>): this;
  setOverride(path: string, value: unknown): this;
  clearDefaults(): this;
  clearOverrides(): this;
  /** `--set` pairs. The key is the path inside this section: `port=1`. */
  setAssignments(assignments: string[]): this;
  clearAssignments(): this;
  bindEnv(path: string, variable: string): this;
  alias(from: string, to: string): this;

  // Lifecycle.
  init(): Promise<this>;
  initAndCurrent(): Promise<T>;
  reload(): Promise<T>;
  /** Load and validate, installing nothing: the candidate. */
  load(): Promise<T>;
  /** The document in force. Throws before the first successful load. */
  current(): T;
  /** The document in force, or `undefined`, for code that would rather ask. */
  tryCurrent(): T | undefined;
  /**
   * One value by dotted path — the read a configuration with no schema
   * wants.
   *
   * Two signatures rather than an optional argument, because they answer
   * differently: with a fallback the result is a `V`, and without one a
   * path nothing supplies is `undefined`, which a `strict: true` caller
   * should be made to handle.
   */
  get<V = unknown>(path: string, fallback: V): V;
  get<V = unknown>(path: string): V | undefined;
  /**
   * Installs `document` directly, without loading: the testing door, and
   * the one for configuration this library did not fetch.
   *
   * It bumps `generation` and fires the hooks. What it cannot move is the
   * engine's own metadata: `status()` and `snapshot().generation` describe
   * the last real *load*, because the engine did not perform this install
   * and has no way to be told about one. `current()` is what was replaced.
   */
  replace(document: T): this;
  /**
   * Every installed document, as an async iterator — the shape a service
   * loop wants, and the one where an `await` costs only the caller.
   */
  changes(): AsyncGenerator<T, void, void>;
  /**
   * Every install *and* every refusal, as typed events: the diagnostic
   * stream a log line, a metric or an alert is built from.
   *
   * `failurePollMs` is what makes `reloadFailed` possible — an install
   * wakes this stream and a refusal cannot, because a load that installed
   * nothing bumps no generation. Omitted, the stream reports installs
   * only and starts no timer.
   */
  events(options?: { failurePollMs?: number }): AsyncGenerator<ConfigEvent, void, void>;
  /**
   * Load, watch, run, stop — the whole lifetime of a service as one call.
   *
   * JavaScript has no `with`, so the block is a function; what it buys is
   * the same thing, a watcher that cannot be left running by an exception
   * on the way out.
   */
  running<R>(body: (document: T) => R | Promise<R>, options?: RunningOptions): Promise<R>;

  // Watching, and hooks.
  watch(options?: WatchOptions): this;
  stopWatching(): this;
  onReload(hook: (document: T) => void): number;
  /**
   * `onReload` for a hook that returns a promise, with a rule for what
   * happens when installs outrun it.
   *
   * A hook already runs on the event loop here; what this adds is the
   * part JavaScript does not do for you — an `async` hook handed to
   * `onReload` returns a promise nobody awaits, so two installs run their
   * bodies interleaved and a rejection becomes an unhandled one.
   *
   * The `signal` is aborted when a newer install supersedes this call
   * under `"latest"`: nothing can cancel a promise, so what a hook doing
   * I/O gets is the signal to stop on its own.
   */
  onReloadAsync(
    hook: (document: T, context: { signal: ReloadSignal }) => Promise<void> | void,
    options?: AsyncHookOptions,
  ): number;
  onChange<V = unknown>(path: string, hook: (now: V, before: V) => void): number;
  removeHook(token: number): boolean;

  // Remote stores.
  /**
   * A store written in JavaScript: anything that can answer with text.
   *
   * `fetch` is called from a worker thread through the event loop, so it
   * must be **synchronous** — an async source keeps its own last answer
   * and hands that over.
   */
  setRemote(fetch: () => Document, described?: string): this;
  /**
   * A store whose client is async — which, in JavaScript, is most of them.
   *
   * `refreshRemote()` awaits the fetch on the event loop and hands the
   * engine the document it already has, so an `await fetch(...)` needs no
   * variable kept up to date by a timer. The deadline is yours
   * (`AbortSignal.timeout`), and a rejection reaches the caller as its own
   * error rather than as a `remote` failure.
   */
  setRemoteAsync(fetch: () => Promise<Document>, described?: string): this;
  refreshRemote(): Promise<this>;
  clearRemote(): this;
  readonly remoteDescription: string | null;
  remoteStatus(): RemoteStatus;

  // Diagnostics.
  sourceOf(path: string): Source | null;
  isSet(path: string): boolean;
  explain(path: string): string;
  check(): Report;
  snapshot(): Snapshot<T> | null;
  status(): Status;

  /** Pins values for the duration of `body`, and puts them back after. */
  overrides<R>(values: Record<string, unknown>, body: () => R | Promise<R>): Promise<R>;
}

/**
 * Several configurations, one lifecycle: init, watch, report and stop them
 * together, and reload them all-or-nothing.
 *
 * The group owns lifecycle, not storage — `database.current()` is still
 * the read, and its type is still the member's own.
 */
export class ConfigGroup {
  // `any` rather than `unknown`, and deliberately: a group is
  // heterogeneous — a database configuration next to a cache one — and
  // `DynamicConfig<T>` is invariant in `T`, so nothing narrower accepts
  // both. It costs nothing, because the group is not the read path: the
  // read is `database.current()`, on the member, which keeps its type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(...configs: DynamicConfig<any>[]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly configs: DynamicConfig<any>[];
  readonly size: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [Symbol.iterator](): Iterator<DynamicConfig<any>>;

  /** Loads every member, concurrently. The first failure throws. */
  init(): Promise<this>;
  /**
   * Reloads every member independently: one refusing leaves the others on
   * their new documents, and the first failure is thrown at the end.
   */
  reload(): Promise<this>;
  /** Every member validates, or no member installs. */
  reloadAtomic(): Promise<this>;
  watch(options?: WatchOptions): this;
  stopWatching(): this;
  /** init, then watch, then stop — the whole lifetime as one call. */
  running<R>(body: (group: ConfigGroup) => R | Promise<R>, options?: RunningOptions): Promise<R>;
  /** Every member's status, by key — one call for a health endpoint. */
  status(): Record<string, Status>;
  /** Every member's generation, by key. */
  generations(): Record<string, number>;
}

/**
 * Which dotted paths differ between two documents. **Paths, never values.**
 *
 * The audit half of a reload: what a log line may carry when the document
 * itself may not.
 */
export function changedPaths(before: unknown, after: unknown): string[];

/** Zod, in the four lines it takes. Zod is not a dependency of this package. */
export function zodValidator<T>(schema: { parse: (document: unknown) => T }): (
  document: unknown,
) => T;

/** The same for Ajv, whose validator answers `false` and keeps the reason. */
export function ajvValidator<T>(validate: {
  (document: unknown): boolean;
  errors?: ReadonlyArray<{ instancePath?: string; message?: string }> | null;
}): (document: unknown) => T;

/** This package's version. */
export function packageVersion(): string;

/** The engine it was built against, which moves on its own schedule. */
export function engineVersion(): string;
