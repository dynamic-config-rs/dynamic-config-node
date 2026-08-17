/**
 * Several configurations, one lifecycle — and a reload that is all or none.
 *
 *   node examples/13-config-group.mjs
 *
 * `02-many-configs.mjs` is three configurations kept apart on purpose.
 * This is the other half: they are separate documents, but one deployment
 * moves them together, and the orchestration of that — init each, watch
 * each, stop each — is not application logic.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const { ConfigGroup, DynamicConfig, DynamicConfigError } = createRequire(import.meta.url)(
  "../js/index.js",
);

const directory = mkdtempSync(join(tmpdir(), "dynamic-config-"));
const file = join(directory, "config.toml");

const document = (poolSize, ttl) => `[db]
host = "db.internal"
poolSize = ${poolSize}

[cache]
url = "redis://cache.internal"
ttlSeconds = ${ttl}
`;

writeFileSync(file, document(16, 60));

const db = new DynamicConfig({
  key: "db",
  validate: (value) => {
    if (typeof value.poolSize !== "number") throw new Error("poolSize must be a number");

    return value;
  },
});

const cache = new DynamicConfig({
  key: "cache",
  validate: (value) => {
    if (typeof value.ttlSeconds !== "number") throw new Error("ttlSeconds must be a number");

    return value;
  },
});

// One object for the lifecycle. The read path is unchanged: `db.current()`
// is still the read, and the group never sits between the two.
const group = new ConfigGroup(db.file(file), cache.file(file));

await group.running(
  async () => {
    console.log("as deployed");
    console.log("  db   ", db.current());
    console.log("  cache", cache.current());
    console.log("  in the group:", group.size, "configurations");

    console.log("\none call for a health endpoint");

    for (const [key, status] of Object.entries(group.status())) {
      console.log(`  ${key.padEnd(6)} generation ${status.generation}, ` +
        `${status.consecutiveFailures} failures since the last install`);
    }

    console.log("\na deployment that breaks one of the two");
    writeFileSync(file, document(32, '"forever"'));

    try {
      await group.reloadAtomic();
    } catch (failure) {
      if (failure instanceof DynamicConfigError) {
        console.log(`  refused: ${failure.kind} at ${failure.path || "the load"}`);
      }
    }

    console.log("  and nothing installed — not even the half that parsed:");
    console.log("  generations", group.generations());
    console.log("  db.poolSize", db.current().poolSize);

    console.log("\nfor comparison, the per-member reload");

    try {
      await group.reload();
    } catch {
      // Reported below by what it left behind.
    }

    console.log("  db moved and cache did not, which is the mixed state");
    console.log("  reloadAtomic() exists to prevent:");
    console.log("  generations", group.generations());

    console.log("\nthe deployment is fixed");
    writeFileSync(file, document(48, 90));
    await group.reloadAtomic();

    console.log("  generations", group.generations());
    console.log("  db.poolSize", db.current().poolSize, "cache.ttlSeconds", cache.current().ttlSeconds);
  },
  // `watch: false` here so the numbers below are this example's reloads
  // and not a watcher's as well. A service says nothing and gets both.
  { watch: false },
);

console.log("\nthe block ended — and with a watcher it would have stopped that too");
