"use strict";

/**
 * Reload hooks under load.
 *
 * The threadsafe queue behind `onReload` is unbounded, so `NonBlocking`
 * never sheds a call for being busy — a storm of reloads reaches every
 * hook exactly once each, in order. This test is the contract's proof;
 * if the queue ever gains a bound, it fails loudly instead of the drops
 * being silent in production.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { DynamicConfig } = require("../js/index.js");

test("a reload storm reaches every hook exactly once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dynamic-config-storm-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ app: { n: 0 } }));

  const config = await new DynamicConfig({ key: "app" }).file(file).init();

  let calls = 0;
  const generations = [];

  config.onReload((document) => {
    calls += 1;
    generations.push(document.n);
  });

  const STORM = 200;

  for (let n = 1; n <= STORM; n += 1) {
    writeFileSync(file, JSON.stringify({ app: { n } }));
    await config.reload();
  }

  // The hooks arrive through the event loop; give it turns until the
  // last one lands rather than guessing a duration.
  const deadline = Date.now() + 5000;
  while (calls < STORM && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(calls, STORM, "a hook call was shed under load");

  // And in order: the queue is a queue, not a bag.
  const sorted = [...generations].sort((a, b) => a - b);
  assert.deepEqual(generations, sorted, "hook calls arrived out of order");

  config.stop?.();
});
