"use strict";

/**
 * Every source, and what each one does to the document.
 *
 * `config.test.js` is the lifecycle and the promises this binding makes;
 * this is the layer stack underneath it — one test per source, in
 * precedence order, so the file reads as the order itself.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const { DynamicConfig } = require("../js/index.js");
const { workspace: scratch } = require("./workspace.js");

/** This file only wants the directory; the file it writes is its own. */
function workspace() {
  return scratch().directory;
}

/** The whole document, whatever it is: no schema, so nothing is dropped. */
function whole() {
  return new DynamicConfig({ key: "db" });
}

test("defaults are the bottom layer, and a file beats one", async () => {
  const directory = workspace();
  const file = join(directory, "config.toml");

  writeFileSync(file, "[db]\nport = 6543\n");

  const config = await whole()
    .setDefault("port", 1)
    .setDefault("pool.maxSize", 8)
    .file(file)
    .init();

  assert.equal(config.get("port"), 6543, "the file wins");
  assert.equal(config.get("pool.maxSize"), 8, "and the default fills what no file states");
});

test("files merge left to right, key by key", async () => {
  const directory = workspace();
  const base = join(directory, "config.toml");
  const secrets = join(directory, "secrets.toml");

  writeFileSync(base, '[db]\nhost = "from-base"\nport = 5432\nuser = "app"\n');
  writeFileSync(secrets, "[db]\nport = 6543\n");

  const config = await whole().file(base).file(secrets).init();

  assert.deepEqual(config.current(), { host: "from-base", port: 6543, user: "app" });
});

test("discovery layers every directory that has a match, in search order", async () => {
  const directory = workspace();
  const machine = join(directory, "etc");
  const user = join(directory, "home");

  mkdirSync(machine);
  mkdirSync(user);
  writeFileSync(join(machine, "app.toml"), '[db]\nhost = "machine-wide"\nport = 5432\n');
  writeFileSync(join(user, "app.toml"), '[db]\nhost = "the-user-overrode-this"\n');

  const config = await whole().discover("app", [machine, user]).init();

  // Not "the first hit wins": stopping there would make naming two
  // directories pointless, because a machine-wide default could never be
  // partially overridden by a user's file.
  assert.equal(config.get("host"), "the-user-overrode-this");
  assert.equal(config.get("port"), 5432, "and the machine-wide file still supplies the rest");
});

test("a mounted secrets directory beats a file and loses to the environment", async () => {
  const directory = workspace();
  const file = join(directory, "config.toml");
  const mounted = join(directory, "run-secrets");

  writeFileSync(file, '[db]\nuser = "from-file"\npassword = "from-file"\n');
  mkdirSync(mounted);
  writeFileSync(join(mounted, "user"), "from-the-mount");
  writeFileSync(join(mounted, "password"), "from-the-mount");

  process.env.DCNTEST_DB_USER = "from-the-environment";

  try {
    const config = await whole().file(file).secretsDir(mounted).env("DCNTEST_").init();

    assert.equal(config.get("password"), "from-the-mount", "the mount beats the file");
    assert.equal(config.get("user"), "from-the-environment", "and loses to the environment");
  } finally {
    delete process.env.DCNTEST_DB_USER;
  }
});

test("a .env file is the environment layer sourced from disk", async () => {
  const directory = workspace();
  const file = join(directory, "config.toml");
  const dotenv = join(directory, ".env");

  writeFileSync(file, "[db]\nport = 1\ntimeout = 1\n");
  writeFileSync(dotenv, "DCNTEST_DB_PORT=2\nDCNTEST_DB_TIMEOUT=2\n");

  process.env.DCNTEST_DB_PORT = "3";

  try {
    const config = await whole().file(file).envFile(dotenv).env("DCNTEST_").init();

    assert.equal(config.get("timeout"), 2, "the .env beats the file");
    assert.equal(config.get("port"), 3, "and a real variable beats the .env");
  } finally {
    delete process.env.DCNTEST_DB_PORT;
  }
});

test("nesting in a variable name is spelled with the separator", async () => {
  process.env.DCNTEST_DB_POOL__MAX_SIZE = "64";

  try {
    const config = await whole().env("DCNTEST_").init();

    assert.equal(config.get("pool.max_size"), 64);
  } finally {
    delete process.env.DCNTEST_DB_POOL__MAX_SIZE;
  }
});

test("bindEnv names one variable, whatever the prefix rule says", async () => {
  process.env.DATABASE_URL = "postgres://elsewhere";

  try {
    const config = await whole().bindEnv("url", "DATABASE_URL").init();

    assert.equal(config.get("url"), "postgres://elsewhere");
  } finally {
    delete process.env.DATABASE_URL;
  }
});

test("an alias accepts another spelling of the same field", async () => {
  const directory = workspace();
  const file = join(directory, "config.toml");

  writeFileSync(file, '[db]\nhostname = "spelled-the-other-way"\n');

  const config = await whole().alias("hostname", "host").file(file).init();

  assert.equal(config.get("host"), "spelled-the-other-way");
});

test("assignments are what a command line hands over, and an override beats them", async () => {
  const config = await whole().setDefault("port", 1).init();

  // The path is the one inside this configuration's section, the same one
  // `setDefault` and `explain` take — not `db.port`. A `--set` flag names
  // a field, and which section it belongs to is the configuration's own
  // business.
  config.setAssignments(["port=2"]);
  await config.reload();

  assert.equal(config.get("port"), 2);

  config.setOverride("port", 3);
  await config.reload();

  assert.equal(config.get("port"), 3, "an override wins over everything");

  config.clearOverrides();
  config.clearAssignments();
  await config.reload();

  assert.equal(config.get("port"), 1, "and both layers empty again");
});

test("a profile selects a file *variant*, which layers over the base", async () => {
  const directory = workspace();
  const file = join(directory, "config.toml");

  writeFileSync(file, '[db]\nhost = "base"\nport = 5432\n');
  // The variant is a sibling named for the profile — not a section inside
  // the file. That is what lets a deployment ship one extra file rather
  // than editing the one everybody shares.
  writeFileSync(join(directory, "config.prod.toml"), '[db]\nhost = "prod.internal"\n');

  process.env.DCNTEST_PROFILE = "prod";

  try {
    const config = await whole().file(file).profileEnv("DCNTEST_PROFILE").init();

    assert.equal(config.get("host"), "prod.internal", "the variant wins");
    assert.equal(config.get("port"), 5432, "and the base fills the rest");
  } finally {
    delete process.env.DCNTEST_PROFILE;
  }
});

test("wholeDocument reads a file that has no section header", async () => {
  const directory = workspace();
  const file = join(directory, "config.toml");

  writeFileSync(file, 'host = "no-header-here"\nport = 6543\n');

  const config = await new DynamicConfig({ key: "db" }).file(file).wholeDocument().init();

  assert.deepEqual(config.current(), { host: "no-header-here", port: 6543 });
});

test("two files can hold half a document each", async () => {
  const directory = workspace();
  const first = join(directory, "one.toml");
  const second = join(directory, "two.toml");

  writeFileSync(first, '[db]\nhost = "from-one"\n');
  writeFileSync(second, "[db]\nport = 6543\n");

  const config = await whole().file(first).file(second).init();

  assert.deepEqual(config.current(), { host: "from-one", port: 6543 });
});

test("yaml and json are read the same way toml is", async () => {
  const directory = workspace();
  const json = join(directory, "config.json");
  const yaml = join(directory, "config.yaml");

  writeFileSync(json, '{"db": {"host": "from-json"}}');
  writeFileSync(yaml, "db:\n  port: 6543\n");

  const config = await whole().file(json).file(yaml).init();

  assert.deepEqual(config.current(), { host: "from-json", port: 6543 });
});

test("the environment types its values rather than handing over strings", async () => {
  process.env.DCNTEST_DB_PORT = "6543";
  process.env.DCNTEST_DB_TLS = "true";
  process.env.DCNTEST_DB_RATIO = "1.5";
  process.env.DCNTEST_DB_HOSTS = "[\"a\", \"b\"]";

  try {
    const config = await whole().env("DCNTEST_").init();
    const document = config.current();

    assert.equal(document.port, 6543);
    assert.equal(document.tls, true);
    assert.equal(document.ratio, 1.5);
    assert.deepEqual(document.hosts, ["a", "b"]);
  } finally {
    for (const name of ["PORT", "TLS", "RATIO", "HOSTS"]) {
      delete process.env[`DCNTEST_DB_${name}`];
    }
  }
});
