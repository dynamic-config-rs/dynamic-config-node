/**
 * Testing: pinning configuration without touching a filesystem.
 *
 *   node examples/03-testing.mjs
 *
 * A test that writes a temporary file to change one value is a test that
 * is slow, order-dependent and hard to read. Three doors here avoid it —
 * an override block, a candidate load, and defaults — and none of them
 * touches disk or the environment.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const { DynamicConfig, DynamicConfigError } = createRequire(import.meta.url)("../js/index.js");

const directory = mkdtempSync(join(tmpdir(), "dynamic-config-"));
const file = join(directory, "config.toml");

writeFileSync(file, '[api]\nrateLimit = 100\nmode = "live"\n');

function api(document) {
  const rateLimit = Number(document.rateLimit);

  if (!Number.isInteger(rateLimit) || rateLimit < 1) {
    throw new Error(`rateLimit must be a positive integer, not ${JSON.stringify(document.rateLimit)}`);
  }

  return { rateLimit, mode: String(document.mode ?? "live") };
}

const config = new DynamicConfig({ key: "api", validate: api, fields: ["rateLimit", "mode"] });

await config.file(file).init();

console.log("what the file says:", config.current());

// ── 1. An override block ──────────────────────────────────────────────
//
// Pins values for the duration of the block and puts back what it found —
// so a nested block does not drop the outer one's pin on the way out.
const observed = await config.overrides({ rateLimit: 1, mode: "test" }, async () => {
  const { rateLimit, mode } = config.current();

  // Whatever the code under test does, it sees these.
  return `${mode} at ${rateLimit}/s`;
});

console.log("inside the block: ", observed);
console.log("and after it:     ", config.current(), "— put back");

// ── 2. A candidate load ───────────────────────────────────────────────
//
// `load()` resolves and validates and installs *nothing*: what a `--check`
// flag wants, and what a test that only wants to know *whether* a file
// would load wants too.
writeFileSync(file, '[api]\nrateLimit = 250\nmode = "live"\n');

const candidate = await config.load();

console.log("\nthe candidate:    ", candidate);
console.log("still serving:    ", config.current(), "— load() installed nothing");

// ── 3. And what a bad candidate looks like ────────────────────────────
writeFileSync(file, '[api]\nrateLimit = "unlimited"\n');

try {
  await config.load();
} catch (failure) {
  if (!(failure instanceof DynamicConfigError)) throw failure;

  console.log("\na bad candidate:  ", failure.kind, "—", failure.message.split("\n")[0]);
}

// ── 4. Defaults, for the values a test does not care about ────────────
//
// A configuration under test usually needs three fields set and does not
// care about the other twelve. Defaults are the bottom layer, so they fill
// exactly the gaps and lose to anything a test does pin.
const isolated = new DynamicConfig({ key: "api", validate: api });

await isolated.setDefault("rateLimit", 10).setDefault("mode", "test").init();

console.log("\nno file at all:   ", isolated.current());

const pinned = await isolated.overrides({ rateLimit: 1 }, () => isolated.current());

console.log("with one pinned:  ", pinned);
