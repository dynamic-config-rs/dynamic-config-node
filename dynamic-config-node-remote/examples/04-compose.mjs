// Compose: a file for the shape, a store for what moves — the layout
// real services converge on.
//
// The file carries defaults and structure and lives with the code; the
// store carries the two values operations actually turns; the store
// outranks the file where they overlap and the file answers where the
// store is silent. Bring any one of the servers from examples 01-03 to
// see the override arrive; with nothing listening, the file alone
// serves — which is the availability story, not a failure of it.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DynamicConfig } = require("dynamic-config-node");
const { Redis, useStore } = require("../js/index.js");

const directory = mkdtempSync(join(tmpdir(), "dynamic-config-"));
const file = join(directory, "config.json");

writeFileSync(
  file,
  JSON.stringify({
    db: { host: "localhost", port: 5432, poolSize: 8 },
  }),
);

const config = new DynamicConfig({ key: "db" }).file(file);

// The remote layer sits above files in the precedence order — the
// engine's rule, not this package's; `explain()` will say so.
const store = new Redis(process.env.REDIS ?? "redis://127.0.0.1:6379", "myapp/db.json");

try {
  await useStore(config, store);
  console.log("file + store, store winning where both speak:");
} catch {
  await config.init();
  console.log(`no store at ${store.describe()} — the file serves alone:`);
}

console.log("  current:", config.current());
console.log("  why:", config.explain("host").trim().split("\n")[0]);

// Either way, from here the config reloads as one document: watch the
// file, refresh the store, and readers never see half of each.
