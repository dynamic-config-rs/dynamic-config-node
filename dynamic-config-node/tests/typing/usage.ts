/**
 * What a TypeScript user writes, checked the way their CI checks it.
 *
 * `tsc --strict` runs over this file in the gate. It is not a test that
 * executes: nothing here runs, and its whole job is to fail the build when
 * the *types* a caller sees regress — which is invisible to a test suite,
 * because `config.current().host` runs perfectly well while the checker
 * calls it `unknown` and the editor offers no completion.
 *
 * The Python binding has the same file for the same reason. There it is
 * `mypy --strict`; here it is this.
 */

import {
  DynamicConfig,
  DynamicConfigError,
  ajvValidator,
  engineVersion,
  packageVersion,
  zodValidator,
  type Document,
  type ErrorKind,
  type Report,
  type Snapshot,
  type Source,
  type Status,
} from "../../js/index.js";

interface Database {
  host: string;
  port: number;
  pool: { maxSize: number };
}

// ── The generic parameter is what makes `current()` worth having ───────

const config = new DynamicConfig<Database>({
  key: "db",
  validate: (document): Database => {
    const record = document as Record<string, unknown>;

    if (typeof record.host !== "string") {
      throw new Error("host must be a string");
    }

    return {
      host: record.host,
      port: typeof record.port === "number" ? record.port : 5432,
      pool: { maxSize: 8 },
    };
  },
  secrets: ["password"],
  fields: ["host", "port", "pool"],
});

// Fluent, and each one answers `this` — so a chain keeps the type.
const chained: DynamicConfig<Database> = config
  .file("config.toml")
  .discover("app", ["/etc/app", "."])
  .env("APP_")
  .nest("__")
  .allowEmptyEnv()
  .envFile(".env")
  .secretsDir("/run/secrets")
  .profileEnv("APP_PROFILE")
  .cache("last.json", "redacted")
  .setDefault("pool.maxSize", 32)
  .bindEnv("host", "DATABASE_HOST")
  .alias("hostname", "host");

async function main(): Promise<void> {
  await chained.init();

  const db: Database = config.current();
  const host: string = db.host;
  const maybe: Database | undefined = config.tryCurrent();
  const reloaded: Database = await config.reload();
  const candidate: Database = await config.load();
  const started: Database = await config.initAndCurrent();

  // A configuration with no schema reads by path, and the caller names the
  // type they expect rather than being handed `any`.
  const ttl: number = config.get<number>("pool.maxSize", 8);

  // Without a fallback the answer may not be there, and the checker says
  // so — a `const missing: number = config.get<number>("nope")` is the
  // error it should be.
  const missing: number | undefined = config.get<number>("nope");

  void host;
  void maybe;
  void reloaded;
  void candidate;
  void started;
  void ttl;
  void missing;

  // ── Diagnostics, each with a shape ──────────────────────────────────
  const source: Source | null = config.sourceOf("port");
  const set: boolean = config.isSet("port");
  const explained: string = config.explain("port");
  const report: Report = config.check();
  const snapshot: Snapshot<Database> | null = config.snapshot();
  const status: Status = config.status();

  void source;
  void set;
  void explained;
  void report.isClean;
  void report.unknown[0]?.path;
  void snapshot?.document.host;
  void status.consecutiveFailures;

  // ── Hooks, with the document typed ──────────────────────────────────
  const token: number = config.onReload((document: Database) => {
    void document.pool.maxSize;
  });

  config.onChange<number>("pool.maxSize", (now: number, before: number) => {
    void (now - before);
  });

  config.removeHook(token);
  config.watch({ debounceMs: 250, pollMs: 1_000 }).stopWatching();

  // ── A remote store written in JavaScript ────────────────────────────
  const answer: Document = { text: "{}", format: "json" };

  config.setRemote((): Document => answer, "our config service");
  await config.refreshRemote();

  const reachable: boolean | null = config.remoteStatus().reachable;

  void reachable;
  void config.remoteDescription;
  config.clearRemote();

  // ── The testing door, with the block's own return type ──────────────
  const pinned: string = await config.overrides({ host: "pinned" }, () => config.current().host);

  void pinned;

  // ── The error, and what a program branches on ───────────────────────
  try {
    await config.reload();
  } catch (failure) {
    if (failure instanceof DynamicConfigError) {
      const kind: ErrorKind = failure.kind;
      const origin: string | null = failure.origin;

      void kind;
      void origin;
    }
  }
}

void main;

// ── The schema adapters, against the shapes they promise ──────────────

const zodLike = { parse: (document: unknown): Database => document as Database };
const fromZod: (document: unknown) => Database = zodValidator(zodLike);

const ajvLike = Object.assign((_document: unknown): boolean => true, {
  errors: null as ReadonlyArray<{ instancePath?: string; message?: string }> | null,
});
const fromAjv: (document: unknown) => Database = ajvValidator<Database>(ajvLike);

void fromZod;
void fromAjv;
void packageVersion();
void engineVersion();
