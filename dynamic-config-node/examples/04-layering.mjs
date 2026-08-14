/**
 * Every layer, in precedence order, with `explain` proving it.
 *
 *   node examples/04-layering.mjs
 *
 * The order is the engine's, and it is the same one in Rust and Python:
 *
 *   setDefault < discovered < config.toml < secrets.json < remote
 *             < secretsDir < APP_DB_* < bindEnv < --set < setOverride
 */

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const { DynamicConfig } = createRequire(import.meta.url)("../js/index.js");

const directory = mkdtempSync(join(tmpdir(), "dynamic-config-"));
const base = join(directory, "config.toml");
const secrets = join(directory, "secrets.toml");
const mounted = join(directory, "run-secrets");

writeFileSync(base, '[db]\nhost = "from-config"\nport = 5432\nuser = "app"\n');
writeFileSync(secrets, '[db]\nport = 6543\n');
mkdirSync(mounted);
writeFileSync(join(mounted, "user"), "from-the-mount");

process.env.APP_DB_HOST = "from-the-environment";

const config = new DynamicConfig({ key: "db" });

await config
  // Bottom: a fallback the program computes, that no file need state.
  .setDefault("pool.maxSize", 8)
  // Files merge left to right: a small second file overrides two fields
  // of a large first one without restating the rest.
  .file(base)
  .file(secrets)
  // A mounted secret is a fact about *this* deployment, so it beats a file
  // — and loses to a variable exported for this one run.
  .secretsDir(mounted)
  .env("APP_")
  .init();

console.log("the document:", config.current(), "\n");

for (const path of ["pool.maxSize", "host", "port", "user"]) {
  console.log(config.explain(path).replace(/^/gm, "  "));
}

// Overrides win over everything, which is what makes them useful in a test
// and behind a `--set key=value` flag.
console.log("with --set db.port=1:");
config.setAssignments(["db.port=1"]);
await config.reload();
console.log("  port is now", config.current().port);

config.setOverride("port", 2);
await config.reload();
console.log("  and an override beats even that:", config.current().port);

delete process.env.APP_DB_HOST;
