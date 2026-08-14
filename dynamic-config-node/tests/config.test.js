"use strict";

/**
 * The binding, from the outside.
 *
 * `node --test`, no framework: the suite a caller could read as
 * documentation, and one that adds nothing to `npm install`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { writeFileSync, readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");

const { DynamicConfig, DynamicConfigError, engineVersion, packageVersion } = require("../js/index.js");

const { workspace } = require("./workspace.js");

/** A schema, written as the plain function this binding actually takes. */
function database(document) {
  if (typeof document.host !== "string") {
    throw new Error("host must be a string");
  }

  return { host: document.host, port: document.port ?? 5432 };
}

test("a file loads, validates and installs", async () => {
  const { path } = workspace('[db]\nhost = "db.internal"\nport = 6543\n');

  const config = await new DynamicConfig({ key: "db", validate: database, fields: ["host", "port"] })
    .file(path)
    .init();

  assert.deepEqual(config.current(), { host: "db.internal", port: 6543 });
  assert.equal(config.key, "db");
  assert.equal(config.generation, 1);
});

test("the validated value is what installs, not the document", async () => {
  const { path } = workspace('[db]\nhost = "db.internal"\n');

  const config = await new DynamicConfig({
    key: "db",
    validate: (document) => ({ ...document, host: document.host.toUpperCase() }),
  })
    .file(path)
    .init();

  assert.equal(config.current().host, "DB.INTERNAL");
});

test("no schema at all: the document is the value, read by path", async () => {
  const { path } = workspace('[plugins]\ncache = { ttl = 60 }\n');

  const config = await new DynamicConfig({ key: "plugins" }).file(path).init();

  assert.equal(config.get("cache.ttl"), 60);
  assert.equal(config.get("cache.missing", "fallback"), "fallback");
});

test("the environment beats the file, and a variable is typed", async () => {
  const { path } = workspace('[db]\nhost = "from-file"\nport = 1\n');

  process.env.DCNTEST_DB_PORT = "9999";

  try {
    const config = await new DynamicConfig({ key: "db", validate: database })
      .file(path)
      .env("DCNTEST_")
      .init();

    assert.equal(config.current().port, 9999, "the env layer types its values");
    assert.equal(config.current().host, "from-file");
  } finally {
    delete process.env.DCNTEST_DB_PORT;
  }
});

test("a refused document changes nothing, and says why", async () => {
  const { path, write } = workspace('[db]\nhost = "first"\n');

  const config = await new DynamicConfig({ key: "db", validate: database }).file(path).init();

  write("[db]\nhost = 99\n");

  await assert.rejects(() => config.reload(), (error) => {
    assert.ok(error instanceof DynamicConfigError);
    assert.equal(error.kind, "invalid");
    assert.match(error.message, /host must be a string/);

    return true;
  });

  assert.equal(config.current().host, "first", "the last good document is still serving");
});

test("an error carries the kind, the path and the origin", async () => {
  const { path } = workspace("this is not toml at all {{{\n");
  const config = new DynamicConfig({ key: "db", validate: database }).file(path);

  await assert.rejects(() => config.init(), (error) => {
    assert.ok(error instanceof DynamicConfigError);
    assert.equal(error.kind, "parse");
    assert.equal(error.originKind, "file");
    assert.equal(error.origin, path, "the origin names the file, not the section");

    return true;
  });
});

test("a file that is not there is not an error, which is the engine's rule", async () => {
  const { path } = workspace('[db]\nhost = "present"\n');

  // Two files, one of them absent: a listed file that does not exist is a
  // deployment that did not need it, and the load carries on. What refuses
  // is a document that then has no `host` — a validation failure, not I/O.
  const config = await new DynamicConfig({ key: "db", validate: database })
    .file(path)
    .file("/nonexistent/config.toml")
    .init();

  assert.equal(config.current().host, "present");
});

test("a watcher reloads, and a rejected edit still changes nothing", async () => {
  const { path, write } = workspace('[db]\nhost = "first"\n');
  const seen = [];

  const config = await new DynamicConfig({ key: "db", validate: database }).file(path).init();

  config.onReload((document) => seen.push(document.host));
  config.watch({ debounceMs: 50 });

  try {
    write('[db]\nhost = "second"\n');

    for (let attempt = 0; attempt < 100 && config.current().host !== "second"; attempt += 1) {
      await sleep(50);
    }

    assert.equal(config.current().host, "second");
    assert.deepEqual(seen, ["second"], "the hook fires on the loop, once per install");

    write("[db]\nhost = 99\n");
    await sleep(400);

    assert.equal(config.current().host, "second", "a rejected edit is not installed");
    assert.deepEqual(seen, ["second"], "and fires no hook");
  } finally {
    config.stopWatching();
  }
});

test("onChange fires for its own path and no other", async () => {
  const { path, write } = workspace('[db]\nhost = "first"\nport = 1\n');
  const hosts = [];

  const config = await new DynamicConfig({ key: "db", validate: database }).file(path).init();

  config.onChange("host", (now, before) => hosts.push([before, now]));

  write('[db]\nhost = "first"\nport = 2\n');
  await config.reload();

  assert.deepEqual(hosts, [], "the port moved, and this hook is about the host");

  write('[db]\nhost = "second"\nport = 2\n');
  await config.reload();

  assert.deepEqual(hosts, [["first", "second"]]);
});

test("a remote store written in JavaScript layers above the files", async () => {
  const { path } = workspace('[db]\nhost = "from-file"\n');

  const config = await new DynamicConfig({ key: "db", validate: database }).file(path).init();

  assert.equal(config.current().host, "from-file");

  config.setRemote(() => ({ text: '{"db":{"host":"from-the-store"}}', format: "json" }), "our config service");

  assert.equal(config.remoteDescription, "our config service");

  await config.refreshRemote();
  await config.reload();

  assert.equal(config.current().host, "from-the-store", "a store beats a file");

  const status = config.remoteStatus();

  assert.equal(status.reachable, true);
  assert.equal(status.fetches, 1);
});

test("a store that refuses is reported, and the last document keeps serving", async () => {
  const { path } = workspace('[db]\nhost = "from-file"\n');

  const config = await new DynamicConfig({ key: "db", validate: database }).file(path).init();

  config.setRemote(() => {
    throw new Error("the store is down");
  }, "a store that is down");

  await assert.rejects(() => config.refreshRemote(), (error) => {
    assert.equal(error.kind, "remote");
    assert.match(error.message, /the store is down/);

    return true;
  });

  assert.equal(config.current().host, "from-file");
  assert.equal(config.remoteStatus().reachable, false);
});

test("the diagnostics answer the questions they answer in Rust", async () => {
  const { path } = workspace('[db]\nhost = "db.internal"\nstray = 1\n');

  const config = await new DynamicConfig({
    key: "db",
    validate: (document) => ({ host: document.host }),
    fields: ["host"],
  })
    .file(path)
    .init();

  assert.equal(config.isSet("host"), true);
  assert.equal(config.isSet("nothing"), false);
  assert.deepEqual(config.sourceOf("host"), { kind: "file", detail: path });
  assert.match(config.explain("host"), /db\.internal/);

  const report = config.check();

  assert.equal(report.isClean, false);
  assert.deepEqual(report.unknown, [{ path: "stray", suggestion: null }]);
  assert.match(report.rendered, /stray/);

  const snapshot = config.snapshot();

  assert.equal(snapshot.generation, 1);
  assert.deepEqual(snapshot.document, { host: "db.internal" });

  const status = config.status();

  assert.equal(status.generation, 1);
  assert.equal(status.consecutiveFailures, 0);
});

test("overrides pin a value for a block and put it back after", async () => {
  const { path } = workspace('[db]\nhost = "real"\n');

  const config = await new DynamicConfig({ key: "db", validate: database }).file(path).init();

  const inside = await config.overrides({ host: "pinned" }, () => config.current().host);

  assert.equal(inside, "pinned");
  assert.equal(config.current().host, "real", "and it is put back");
});

test("the last known good cache carries a broken start", async () => {
  const { directory, path, write } = workspace('[db]\nhost = "good"\n');
  const cache = join(directory, "last.json");

  const first = await new DynamicConfig({ key: "db", validate: database })
    .file(path)
    .cache(cache, "full")
    .init();

  assert.equal(first.current().host, "good");
  assert.ok(existsSync(cache), "the cache was written");
  assert.match(readFileSync(cache, "utf8"), /good/);

  write("this is not toml at all {{{");

  const second = await new DynamicConfig({ key: "db", validate: database })
    .file(path)
    .cache(cache, "full")
    .init();

  assert.equal(second.current().host, "good", "a broken file at startup is survivable");
});

test("a redacting cache is refused when nothing said what is secret", async () => {
  const { directory, path } = workspace('[db]\nhost = "h"\n');

  const config = new DynamicConfig({ key: "db", validate: database })
    .file(path)
    .cache(join(directory, "last.json"), "redacted");

  await assert.rejects(() => config.init(), (error) => {
    assert.equal(error.kind, "backend");
    assert.match(error.message, /secret/);

    return true;
  });
});

test("sources are declared before the first load, and say so after it", async () => {
  const { path } = workspace('[db]\nhost = "h"\n');

  const config = await new DynamicConfig({ key: "db", validate: database }).file(path).init();

  assert.throws(() => config.file("/another.toml"), (error) => {
    assert.equal(error.kind, "backend");
    assert.match(error.message, /before the first load/);

    return true;
  });
});

test("current() before init says what to do about it", () => {
  const config = new DynamicConfig({ key: "db", validate: database });

  assert.equal(config.tryCurrent(), undefined);
  assert.throws(() => config.current(), /await init/);
});

test("setDefaults takes a whole object, and a file still beats it", async () => {
  const { path } = workspace('[db]\nhost = "from-file"\n');

  const config = await new DynamicConfig({ key: "db" })
    .setDefaults({ host: "default", port: 5432, pool: { maxSize: 8 } })
    .file(path)
    .init();

  assert.deepEqual(config.current(), {
    host: "from-file",
    port: 5432,
    pool: { maxSize: 8 },
  });
});

test("strictEnv refuses an ambiguous spelling rather than guessing at it", async () => {
  // `off` reads like a boolean and arrives as the string "off": silently
  // correct in a string field and silently wrong everywhere else. Strict
  // mode makes the yes/no/on/off family an error naming the variable.
  process.env.DCNTEST_DB_TLS = "off";

  try {
    const loose = await new DynamicConfig({ key: "db" }).env("DCNTEST_").init();

    assert.equal(loose.get("tls"), "off", "loose is the default, and it guesses nothing");

    const strict = new DynamicConfig({ key: "db" }).env("DCNTEST_").strictEnv();

    await assert.rejects(() => strict.init(), (error) => {
      assert.equal(error.kind, "env");
      assert.match(error.message, /DCNTEST_DB_TLS/);

      return true;
    });
  } finally {
    delete process.env.DCNTEST_DB_TLS;
  }
});

test("a validator's answer is data, and only data", async () => {
  // The documented limitation, asserted rather than promised: what a
  // validator returns crosses back into Rust to be stored, so it is
  // serialised. A caller reaching for a class here should find out from
  // this suite, not from `instanceof` in production.
  class Database {
    constructor(host) {
      this.host = host;
      this.when = new Date(0);
    }

    get shouty() {
      return this.host.toUpperCase();
    }
  }

  const { path } = workspace('[db]\nhost = "db.internal"\n');
  const config = await new DynamicConfig({
    key: "db",
    validate: (document) => new Database(document.host),
  })
    .file(path)
    .init();

  const now = config.current();

  assert.equal(now.host, "db.internal", "the data survives");
  assert.equal(now instanceof Database, false, "the prototype does not");
  assert.equal(now.shouty, undefined, "and neither does a getter");
  assert.deepEqual(now.when, {}, "a Date has no fields, so it arrives with none");
});

test("replace installs a document without loading anything", async () => {
  const { path } = workspace('[db]\nhost = "from-file"\n');
  const seen = [];

  const config = await new DynamicConfig({ key: "db", validate: database }).file(path).init();

  config.onReload((document) => seen.push(document.host));
  config.replace({ host: "handed-over", port: 1 });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(config.current().host, "handed-over");
  assert.equal(config.generation, 2, "it counts as an install");
  assert.deepEqual(seen, ["handed-over"], "and fires the hooks");
});

test("changes() yields every installed document, and stops when the loop does", async () => {
  const { path, write } = workspace('[db]\nhost = "first"\n');
  const config = await new DynamicConfig({ key: "db", validate: database }).file(path).init();

  const seen = [];
  const consumer = (async () => {
    for await (const document of config.changes()) {
      seen.push(document.host);

      if (seen.length === 2) {
        break;
      }
    }
  })();

  await new Promise((resolve) => setImmediate(resolve));

  write('[db]\nhost = "second"\n');
  await config.reload();
  write('[db]\nhost = "third"\n');
  await config.reload();

  await consumer;

  assert.deepEqual(seen, ["second", "third"]);
  assert.equal(config.generation, 3, "and the loop leaving did not stop the reloads");
});

test("both versions are reported, because they move on two schedules", () => {
  assert.match(packageVersion(), /^\d+\.\d+\.\d+$/);
  assert.match(engineVersion(), /^\d+\.\d+\.\d+$/);
});

test("a candidate load cannot strand the installed document", async () => {
  // The race the review found: one staging slot meant a `load()` landing
  // between a reload's validation and its commit published nobody's
  // document — the reload resolved, the engine installed, and `current()`
  // kept handing back the previous one.
  const { path, write } = workspace('[db]\nhost = "first"\n');
  const config = await new DynamicConfig({ key: "db", validate: database }).file(path).init();

  for (let round = 0; round < 12; round += 1) {
    write(`[db]\nhost = "round-${round}"\n`);

    // A candidate and an install, overlapping deliberately.
    const [, candidate] = await Promise.all([config.reload(), config.load()]);

    assert.equal(config.current().host, `round-${round}`, "the install is what serves");
    assert.equal(candidate.host, `round-${round}`, "and the candidate is the validated value");
    assert.equal(config.generation, round + 2, "one install, one generation");
  }
});

test("overrides restore what they found, so blocks nest", async () => {
  const { path } = workspace('[db]\nhost = "from-file"\n');
  const config = await new DynamicConfig({ key: "db", validate: database }).file(path).init();

  config.setOverride("host", "outer");
  await config.reload();

  const inner = await config.overrides({ host: "inner" }, async () =>
    config.overrides({ host: "innermost" }, () => config.current().host),
  );

  assert.equal(inner, "innermost");
  assert.equal(config.current().host, "outer", "the outer pin survived both blocks");

  config.clearOverrides();
  await config.reload();

  assert.equal(config.current().host, "from-file");
});
