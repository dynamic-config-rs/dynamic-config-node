/**
 * A file, a schema, and where each value came from.
 *
 *   node examples/01-quick-start.mjs
 *
 * Everything here is the whole library: a configuration is a key, some
 * sources and a validator, and what you get back is your own object.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const { DynamicConfig } = createRequire(import.meta.url)("../js/index.js");

const directory = mkdtempSync(join(tmpdir(), "dynamic-config-"));
const file = join(directory, "config.toml");

writeFileSync(
  file,
  `[db]
host = "db.internal"
port = 6543
pool = { maxSize = 32 }
`,
);

/**
 * The schema is a function. Zod's `parse` is one, an Ajv validator becomes
 * one in four lines, and so is this — which is the point: the binding does
 * not have an opinion about your schema library.
 */
function database(document) {
  if (typeof document.host !== "string") {
    throw new Error("host must be a string");
  }

  return {
    host: document.host,
    port: document.port ?? 5432,
    pool: { maxSize: document.pool?.maxSize ?? 8 },
  };
}

const config = new DynamicConfig({
  key: "db",
  validate: database,
  fields: ["host", "port", "pool"],
});

const db = await config.file(file).env("APP_").initAndCurrent();

console.log(`\n${db.host}:${db.port}  pool ${db.pool.maxSize}`);

console.log("\nwhere each value came from");
console.log("──────────────────────────");
for (const path of ["host", "port", "pool.maxSize"]) {
  const source = config.sourceOf(path);

  console.log(`  ${path.padEnd(14)} ${source.kind} ${source.detail ?? ""}`);
}

console.log("\nand the whole story for one of them");
console.log("───────────────────────────────────");
console.log(config.explain("port").replace(/^/gm, "  "));

console.log("would it load?", config.check().isClean ? "yes" : "no");
