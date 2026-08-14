/**
 * A watcher, a hook, and a rejected edit changing nothing.
 *
 *   node examples/05-watching.mjs
 *
 * The last one is the point. Anything can re-read a file; what makes hot
 * reload safe to leave running in production is that a file edited into
 * something the schema refuses leaves the previous document serving and
 * says so, rather than taking the process down or installing nonsense.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

const { DynamicConfig } = createRequire(import.meta.url)("../js/index.js");

const directory = mkdtempSync(join(tmpdir(), "dynamic-config-"));
const file = join(directory, "config.toml");

writeFileSync(file, "[server]\nworkers = 4\n");

const config = new DynamicConfig({
  key: "server",
  validate: (document) => {
    const workers = document.workers;

    if (typeof workers !== "number" || workers < 1 || workers > 64) {
      throw new Error(`workers must be a number between 1 and 64, not ${JSON.stringify(workers)}`);
    }

    return { workers };
  },
  fields: ["workers"],
});

await config.file(file).init();

// Every install, on the event loop. The reload itself happened on the
// watcher's own thread — this program is not structured around watching.
config.onReload((document) => console.log("  installed:", document));

// One path, when it moves, with both values.
config.onChange("workers", (now, before) => console.log(`  workers: ${before} → ${now}`));

config.watch({ debounceMs: 50 });

console.log("serving", config.current(), "\n");

console.log("a good edit:");
writeFileSync(file, "[server]\nworkers = 16\n");
for (let attempt = 0; attempt < 100 && config.current().workers !== 16; attempt += 1) {
  await sleep(50);
}

console.log("\na bad one:");
writeFileSync(file, "[server]\nworkers = 999\n");
await sleep(500);
console.log("  still serving:", config.current(), "— and the hooks did not fire");
console.log("  status:", config.status().consecutiveFailures, "consecutive failures");

console.log("\nand a good one again:");
writeFileSync(file, "[server]\nworkers = 32\n");
for (let attempt = 0; attempt < 100 && config.current().workers !== 32; attempt += 1) {
  await sleep(50);
}

config.stopWatching();
