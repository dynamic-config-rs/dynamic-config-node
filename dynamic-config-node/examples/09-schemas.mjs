/**
 * Zod, and the two other answers to "what is a schema here".
 *
 *   npm install zod && node examples/03-zod.mjs
 *
 * The binding takes a *function*: something that receives the resolved
 * document and answers the value your program reads, or throws. Zod's
 * `parse` already is one. That is why Zod is not a dependency of this
 * package — a schema library belongs to the program, not to its
 * configuration loader.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DynamicConfig, DynamicConfigError, zodValidator } = require("../js/index.js");

let z;

try {
  ({ z } = require("zod"));
} catch {
  console.log("this example needs zod: npm install zod");
  process.exit(0);
}

const directory = mkdtempSync(join(tmpdir(), "dynamic-config-"));
const file = join(directory, "config.toml");

writeFileSync(file, '[db]\nhost = "db.internal"\nport = 6543\n');

// ── 1. Zod ────────────────────────────────────────────────────────────
const Database = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535).default(5432),
});

const config = new DynamicConfig({
  key: "db",
  validate: zodValidator(Database),
  fields: Object.keys(Database.shape),
});

const db = await config.file(file).initAndCurrent();

console.log("zod:        ", db);

// A document Zod refuses installs nothing, and the message is Zod's own.
writeFileSync(file, "[db]\nhost = 99\nport = 6543\n");

try {
  await config.reload();
} catch (failure) {
  if (!(failure instanceof DynamicConfigError)) throw failure;

  console.log("refused:     kind =", failure.kind);
  // Zod's own report, which is a JSON array of issues — kept whole rather
  // than summarised, because the schema library says *why* better than
  // this binding could.
  console.log("             ", failure.message.replace(/\s+/g, " ").slice(0, 96));
  console.log("still serving:", config.current().host);
}

// ── 2. A plain function ───────────────────────────────────────────────
writeFileSync(file, '[db]\nhost = "plain"\n');

const byHand = await new DynamicConfig({
  key: "db",
  validate: (document) => {
    if (typeof document.host !== "string") throw new Error("host must be a string");

    return { host: document.host, port: document.port ?? 5432 };
  },
})
  .file(file)
  .initAndCurrent();

console.log("by hand:    ", byHand);

// ── 3. No schema at all ───────────────────────────────────────────────
writeFileSync(file, "[db]\nanything = { goes = true }\n");

const schemaless = new DynamicConfig({ key: "db" });

await schemaless.file(file).init();

console.log("no schema:  ", schemaless.get("anything.goes"), "— read by dotted path");
console.log("check():    ", schemaless.check().unknownChecked ? "compared" : "nothing to compare against");
