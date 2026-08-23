"use strict";

// `fingerprint()`, and the two properties that make it printable.
//
// The Rust suite pins these on that side. Asked again here because the
// binding is where a fleet actually reads it: a process prints a string,
// another process prints a string, and either they match or one of them is
// running a configuration nobody meant to ship.

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { DynamicConfig } = require("../js/index.js");

const SECRET = "hunter2-planted-secret";

const scratch = mkdtempSync(join(tmpdir(), "dynamic-config-fingerprint-"));

function written(name, body) {
  const path = join(scratch, name);
  writeFileSync(path, body, "utf8");

  return path;
}

async function built(path) {
  return await new DynamicConfig({ key: "svc", secrets: ["password"] })
    .file(path)
    .init();
}

test("the same configuration fingerprints the same in any format", async () => {
  // A digest that disagreed here would report drift between two hosts that
  // are configured identically and merely chose different formats.
  const asJson = written(
    "config.json",
    JSON.stringify({ svc: { host: "db.internal", port: 5432, password: SECRET } }),
  );
  const asToml = written(
    "config.toml",
    `[svc]\nport = 5432\npassword = "${SECRET}"\nhost = "db.internal"\n`,
  );

  assert.equal(
    (await built(asJson)).fingerprint(),
    (await built(asToml)).fingerprint(),
  );
});

test("rotating a secret does not move it", async () => {
  // The property that makes it printable: a digest that changed when a
  // password changed would let anyone holding a candidate confirm it
  // against a logged fingerprint.
  const before = written(
    "before.json",
    JSON.stringify({ svc: { host: "db.internal", password: SECRET } }),
  );
  const after = written(
    "after.json",
    JSON.stringify({ svc: { host: "db.internal", password: "correct-horse" } }),
  );

  assert.equal(
    (await built(before)).fingerprint(),
    (await built(after)).fingerprint(),
  );
});

test("changing anything else moves it", async () => {
  const before = written(
    "port-before.json",
    JSON.stringify({ svc: { host: "db.internal", port: 5432, password: SECRET } }),
  );
  const after = written(
    "port-after.json",
    JSON.stringify({ svc: { host: "db.internal", port: 6432, password: SECRET } }),
  );

  assert.notEqual(
    (await built(before)).fingerprint(),
    (await built(after)).fingerprint(),
  );
});

test("it names its algorithm and carries no value", async () => {
  const path = written(
    "named.json",
    JSON.stringify({ svc: { host: "db.internal", password: SECRET } }),
  );

  const fingerprint = (await built(path)).fingerprint();

  assert.ok(fingerprint.startsWith("sha256:"), fingerprint);
  assert.equal(fingerprint.slice("sha256:".length).length, 64);
  assert.ok(!fingerprint.includes(SECRET));
});

test("there is no fingerprint before the first load", async () => {
  // `null` rather than the digest of an empty document, which would compare
  // equal across every process that had not started yet.
  const path = written(
    "unloaded.json",
    JSON.stringify({ svc: { host: "db.internal" } }),
  );

  const config = new DynamicConfig({ key: "svc", secrets: ["password"] }).file(path);

  assert.equal(config.fingerprint(), null);

  await config.init();

  assert.ok(config.fingerprint().startsWith("sha256:"));
});
