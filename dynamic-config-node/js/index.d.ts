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

  // Watching, and hooks.
  watch(options?: WatchOptions): this;
  stopWatching(): this;
  onReload(hook: (document: T) => void): number;
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
