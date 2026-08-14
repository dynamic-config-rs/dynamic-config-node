/**
 * The eight Rust remote stores, for the Node binding.
 *
 * Each store is a class with the same two methods — an async `fetch()` and
 * a `describe()` — which is exactly the shape the base package's
 * `setRemote` takes. `useStore` is the bridge between the two: a fetch is
 * a network round trip and must not sit on the event loop, and the remote
 * layer is filled from a worker thread and must be handed a synchronous
 * answer.
 */

import type { DynamicConfig, Document } from "dynamic-config-node";

/** What every call answers: a value, or the failure with its kind. */
export interface Outcome<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: {
    readonly kind: string;
    readonly path: string;
    readonly originKind: string;
    readonly origin: string | null;
    readonly message: string;
  };
}

/** TLS material: files, bytes, or nothing at all (the platform's trust store). */
export interface Tls {
  caCertificateFile?: string;
  caCertificatePem?: string;
  clientCertificateFile?: string;
  clientKeyFile?: string;
  clientCertificatePem?: string;
  clientKeyPem?: string;
}

/** A running watch, and the handle that ends it. */
export interface Watching {
  /**
   * Ends the watch and resolves when its loop has stopped.
   *
   * Asynchronous because a watch loop is inside a network request for
   * most of its life, and joining it from a synchronous method would park
   * the event loop for as long as that request takes. Idempotent.
   */
  stop(): Promise<void>;
}

/** What every store here answers. */
export interface Store {
  fetch(): Promise<Outcome<Document>>;
  describe(): string;
}

/**
 * A store whose protocol pushes, so it can be watched rather than polled.
 *
 * Consul (a blocking query), Redis (keyspace notifications), etcd (a watch
 * stream) and NATS (a JetStream watch). The other four are polled by their
 * Rust watch loops too, so `setInterval(() => installed.refresh(), ms)` in
 * JavaScript is the same thing with one fewer thread — which is why they
 * do not have this method.
 */
export interface Watchable extends Store {
  watch(
    onChange: (document: Document) => void,
    onError?: (failure: Outcome<never>) => void,
  ): Watching;
}

/** Consul's key/value store. */
export class Consul implements Watchable {
  constructor(
    address: string,
    key?: string | null,
    keys?: string[] | null,
    prefix?: string | null,
    format?: "json" | "toml" | "yaml" | null,
    token?: string | null,
    /** Called on the event loop before each fetch, for a token that rotates. */
    tokenFn?: (() => string) | null,
    tls?: Tls | null,
    timeoutMs?: number | null,
  );
  fetch(): Promise<Outcome<Document>>;
  watch(
    onChange: (document: Document) => void,
    onError?: (failure: Outcome<never>) => void,
  ): Watching;
  describe(): string;
}

/** HashiCorp Vault's KV v2 store. A secret is JSON, so there is no format. */
export class Vault implements Store {
  constructor(
    address: string,
    mount: string,
    path?: string | null,
    paths?: string[] | null,
    format?: "json" | "toml" | "yaml" | null,
    token?: string | null,
    /** Vault's tokens have leases; this is how a long process keeps one. */
    tokenFn?: (() => string) | null,
    tls?: Tls | null,
    timeoutMs?: number | null,
  );
  fetch(): Promise<Outcome<Document>>;
  describe(): string;
}

/** A Redis key, or a named list of them. The credential rides in the URL. */
export class Redis implements Watchable {
  constructor(
    url: string,
    key?: string | null,
    keys?: string[] | null,
    prefix?: string | null,
    format?: "json" | "toml" | "yaml" | null,
    tls?: Tls | null,
    timeoutMs?: number | null,
  );
  fetch(): Promise<Outcome<Document>>;
  watch(
    onChange: (document: Document) => void,
    onError?: (failure: Outcome<never>) => void,
  ): Watching;
  describe(): string;
}

/** An etcd v3 key/value store. */
export class Etcd implements Watchable {
  constructor(
    endpoints: string[],
    key?: string | null,
    keys?: string[] | null,
    prefix?: string | null,
    format?: "json" | "toml" | "yaml" | null,
    username?: string | null,
    password?: string | null,
    timeoutMs?: number | null,
  );
  fetch(): Promise<Outcome<Document>>;
  watch(
    onChange: (document: Document) => void,
    onError?: (failure: Outcome<never>) => void,
  ): Watching;
  describe(): string;
}

/** A NATS JetStream key/value bucket. */
export class Nats implements Watchable {
  constructor(
    server: string,
    bucket: string,
    key?: string | null,
    keys?: string[] | null,
    format?: "json" | "toml" | "yaml" | null,
    timeoutMs?: number | null,
  );
  fetch(): Promise<Outcome<Document>>;
  watch(
    onChange: (document: Document) => void,
    onError?: (failure: Outcome<never>) => void,
  ): Watching;
  describe(): string;
}

/** An object in S3, or in anything that speaks its API. */
export class S3 implements Store {
  constructor(
    bucket: string,
    key?: string | null,
    keys?: string[] | null,
    prefix?: string | null,
    format?: "json" | "toml" | "yaml" | null,
    timeoutMs?: number | null,
  );
  fetch(): Promise<Outcome<Document>>;
  describe(): string;
}

/** A Google Cloud Firestore document. */
export class Firestore implements Store {
  constructor(
    project: string,
    path?: string | null,
    paths?: string[] | null,
    accessToken?: string | null,
    /** A Google access token lives an hour; this is how to keep one fresh. */
    accessTokenFn?: (() => string) | null,
    tls?: Tls | null,
    timeoutMs?: number | null,
  );
  fetch(): Promise<Outcome<Document>>;
  describe(): string;
}

/** A file in a git repository, at a branch, a tag or a commit. */
export class Git implements Store {
  constructor(
    url: string,
    path?: string | null,
    paths?: string[] | null,
    prefix?: string | null,
    branch?: string | null,
    tag?: string | null,
    commit?: string | null,
    format?: "json" | "toml" | "yaml" | null,
    token?: string | null,
    timeoutMs?: number | null,
  );
  fetch(): Promise<Outcome<Document>>;
  describe(): string;
}

/** What a later refresh needs. */
export interface Installed {
  /** Fetch again, fill the remote layer, and reload. */
  refresh(): Promise<unknown>;
}

/**
 * Installs `store` into `config`, fetches once, and reloads.
 *
 * The bridge between an async fetch and the synchronous source the engine's
 * remote layer is filled from: the last answer is kept, and every refresh
 * replaces it before the layer is filled.
 */
export function useStore<T>(config: DynamicConfig<T>, store: Store): Promise<Installed>;

/** One fetch, unwrapped into a document or a `DynamicConfigError`. */
export function fetchFrom(store: Store): Promise<Document>;

export function packageVersion(): string;
export function engineVersion(): string;
