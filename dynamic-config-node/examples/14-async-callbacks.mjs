/**
 * Hooks that return promises, and the event stream a log line is built from.
 *
 *   node examples/14-async-callbacks.mjs
 *
 * A hook here already runs on the event loop — there is no watcher thread
 * to move it off. What JavaScript does not do for you is the rest: an
 * `async` hook handed to `onReload` returns a promise nobody awaits, so
 * two installs run their bodies interleaved and a rejection becomes an
 * unhandled one. `onReloadAsync` is that, with a rule.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

const { DynamicConfig } = createRequire(import.meta.url)("../js/index.js");

const directory = mkdtempSync(join(tmpdir(), "dynamic-config-"));
const file = join(directory, "config.toml");
const document = (poolSize) => `[db]\nhost = "db.internal"\npoolSize = ${poolSize}\n`;

writeFileSync(file, document(8));

/** Stands in for a pool whose resize takes real time. */
class Pool {
  constructor(size) {
    this.size = size;
  }

  async resize(size, { signal } = {}) {
    await sleep(150);

    if (signal?.aborted) {
      console.log(`  resize to ${size} was superseded before it finished`);

      return;
    }

    console.log(`  pool resized ${this.size} → ${size}`);
    this.size = size;
  }
}

const config = new DynamicConfig({
  key: "db",
  validate: (value) => {
    if (typeof value.poolSize !== "number") throw new Error("poolSize must be a number");

    return value;
  },
}).file(file);

await config.init();

const pool = new Pool(config.current().poolSize);

// The default policy: latest wins. Resizing a pool to a size nobody is
// asking for any more is work done for nothing.
config.onReloadAsync(async (value, { signal }) => {
  await pool.resize(value.poolSize, { signal });
});

console.log("three deployments, faster than the pool can follow");

for (const size of [24, 32, 48]) {
  writeFileSync(file, document(size));
  await config.reload();
  console.log(`  reload returned with poolSize ${size} installed`);
  await sleep(10);
}

await sleep(600);

console.log("\nthe same hook, keeping every install instead");

const audited = new DynamicConfig({ key: "db" }).file(file);

await audited.init();

const seen = [];

audited.onReloadAsync(
  async (value) => {
    await sleep(40);
    seen.push(value.poolSize);
  },
  { backpressure: "serial" },
);

for (const size of [64, 80, 96]) {
  writeFileSync(file, document(size));
  await audited.reload();
  await sleep(5);
}

await sleep(400);
console.log("  serial dropped nothing:", seen);

console.log("\nand the diagnostic stream, for a log or an alert");

const events = [];
const stream = (async () => {
  // A refusal wakes this stream natively — the engine's failure hook
  // reaches the loop the same way an install's does, so nothing polls.
  for await (const event of config.events()) {
    events.push(event);

    if (event.type === "reloadFailed") {
      console.log(`  ✗ refused: ${event.kind} (${event.consecutive} in a row)`);
    } else {
      console.log(`  ✓ generation ${event.generation} — ${event.changed.join(", ")}`);
    }

    if (events.length === 3) break;
  }
})();

await sleep(20);

writeFileSync(file, document(100));
await config.reload();
await sleep(100);

writeFileSync(file, '[db]\nhost = "db.internal"\npoolSize = "as many as it takes"\n');

try {
  await config.reload();
} catch {
  // The stream reports it; the caller already knows.
}

await sleep(200);

writeFileSync(file, document(120));
await config.reload();
await stream;

console.log("\nwhat is not in any of those events");
console.log("  a value. Paths, kinds, counts and timestamps only — a value");
console.log("  in an event is a secret in a log.");
