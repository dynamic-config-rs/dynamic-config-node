/**
 * Every question an operator asks, and the call that answers it.
 *
 *   node examples/06-diagnostics.mjs
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const { DynamicConfig } = createRequire(import.meta.url)("../js/index.js");

const directory = mkdtempSync(join(tmpdir(), "dynamic-config-"));
const file = join(directory, "config.toml");

writeFileSync(file, '[db]\nhost = "db.internal"\nport = 6543\nhsot = "typo"\n');

process.env.APP_DB_PORT = "7000";

const config = new DynamicConfig({
  key: "db",
  validate: (document) => ({ host: document.host, port: document.port }),
  fields: ["host", "port"],
});

await config.file(file).env("APP_").init();

console.log("sourceOf('port')  ", config.sourceOf("port"), "\n");
console.log("isSet('host')     ", config.isSet("host"));
console.log("isSet('nothing')  ", config.isSet("nothing"), "\n");

console.log("explain('port')");
console.log(config.explain("port").replace(/^/gm, "  "));

console.log("check()");
console.log(config.check().rendered.replace(/^/gm, "  "));
console.log("  unknown keys:", config.check().unknown);

console.log("\nsnapshot()", config.snapshot());
console.log("status()  ", config.status());

delete process.env.APP_DB_PORT;
