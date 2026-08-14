/**
 * One process, several configurations — one per section, one per subsystem.
 *
 *   node examples/02-many-configs.mjs
 *
 * A large program has a database, a cache and a feature-flag table, and
 * they change on different schedules and belong to different owners. One
 * configuration object per section is what keeps them apart: each
 * validates its own shape, each reloads on its own, and a broken flags
 * file does not take the database's document down with it.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

const { DynamicConfig, DynamicConfigError } = createRequire(import.meta.url)("../js/index.js");

const directory = mkdtempSync(join(tmpdir(), "dynamic-config-"));
const file = join(directory, "config.toml");

writeFileSync(
  file,
  `[db]
host = "db.internal"
port = 6543

[cache]
url = "redis://cache.internal"
ttlSeconds = 60

[flags]
newCheckout = false
`,
);

// Three configurations over one file. They share nothing: three keys,
// three schemas, three documents.
const db = new DynamicConfig({
  key: "db",
  validate: (document) => {
    if (typeof document.host !== "string") throw new Error("host must be a string");

    return { host: document.host, port: Number(document.port ?? 5432) };
  },
  fields: ["host", "port"],
});

const cache = new DynamicConfig({
  key: "cache",
  validate: (document) => ({
    url: String(document.url),
    ttlSeconds: Number(document.ttlSeconds ?? 60),
  }),
  fields: ["url", "ttlSeconds"],
});

// The flag table has no schema at all: the keys are a product decision,
// and a program that had to declare each one would be edited every time
// somebody added a flag.
const flags = new DynamicConfig({ key: "flags" });

await Promise.all([db.file(file).init(), cache.file(file).init(), flags.file(file).init()]);

console.log("db:    ", db.current());
console.log("cache: ", cache.current());
console.log("flags: ", flags.current(), "→ newCheckout is", flags.get("newCheckout"));

for (const config of [db, cache, flags]) {
  config.watch({ debounceMs: 50 });
}

console.log("\nnow a change that only the flags care about:");
writeFileSync(
  file,
  `[db]
host = "db.internal"
port = 6543

[cache]
url = "redis://cache.internal"
ttlSeconds = 60

[flags]
newCheckout = true
rolloutPercent = 25
`,
);

for (let attempt = 0; attempt < 100 && flags.get("newCheckout") !== true; attempt += 1) {
  await sleep(50);
}

console.log("  flags:", flags.current());
console.log("  db generation is still", db.generation, "— nothing about it changed");

console.log("\nand one that breaks only the cache:");
writeFileSync(
  file,
  `[db]
host = "db.internal"

[cache]
url = 12345

[flags]
newCheckout = true
`,
);

await sleep(400);

console.log("  cache is still serving:", cache.current(), "and reports the failure:");
console.log("   ", cache.status().consecutiveFailures, "consecutive failures");
console.log("  db meanwhile:", db.current());

for (const config of [db, cache, flags]) {
  config.stopWatching();
}

// The error a caller would see if they reloaded the cache by hand.
try {
  await cache.reload();
} catch (failure) {
  if (failure instanceof DynamicConfigError) {
    console.log("\n  cache.reload() →", failure.kind, "—", failure.message.split("\n")[0]);
  }
}
