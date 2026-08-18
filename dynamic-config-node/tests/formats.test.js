"use strict";

/**
 * The two flat formats, read through the addon. Dialect tests live in
 * the engine; this is the seam — an `.ini` or `.properties` path behaves
 * like any other format.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { DynamicConfig } = require("../js/index.js");

test("an ini file loads and reloads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dynamic-config-ini-"));
  const file = join(dir, "config.ini");
  writeFileSync(file, "[db]\nhost = db.internal\nport = 5432\n");

  const config = await new DynamicConfig({ key: "db" }).file(file).init();

  assert.deepEqual(config.current(), { host: "db.internal", port: 5432 });

  writeFileSync(file, "[db]\nhost = moved\nport = 5433\n");
  await config.reload();

  assert.equal(config.current().host, "moved");
});

test("a properties file nests its dotted keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dynamic-config-props-"));
  const file = join(dir, "config.properties");
  writeFileSync(file, "db.host = db.internal\ndb.port = 5432\n");

  const config = await new DynamicConfig({ key: "db" }).file(file).init();

  assert.deepEqual(config.current(), { host: "db.internal", port: 5432 });
});

test("a flat-format error names the line and no content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dynamic-config-bad-"));
  const file = join(dir, "config.ini");
  writeFileSync(file, "[db]\npassword hunter2 with no equals\n");

  await assert.rejects(
    () => new DynamicConfig({ key: "db" }).file(file).init(),
    (error) => {
      assert.equal(error.kind, "parse");
      assert.match(error.message, /line 2/);
      assert.doesNotMatch(error.message, /hunter2/);
      return true;
    },
  );
});
