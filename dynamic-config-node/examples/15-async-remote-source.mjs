/**
 * A remote store whose client is async — which, in JavaScript, is most.
 *
 *   node examples/15-async-remote-source.mjs
 *
 * The engine calls a store from a worker thread, where a promise cannot be
 * awaited. `setRemote` therefore takes a synchronous function, and the old
 * advice was *keep the last answer in a variable and hand that over*.
 * `setRemoteAsync` is the door that does not need the variable: the fetch
 * is awaited on the event loop, inside `refreshRemote()`, and the engine
 * is handed the document that came back.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

const { DynamicConfig } = createRequire(import.meta.url)("../js/index.js");

const directory = mkdtempSync(join(tmpdir(), "dynamic-config-"));
const file = join(directory, "config.toml");

writeFileSync(file, '[db]\nhost = "db.internal"\npoolSize = 8\n');

const config = new DynamicConfig({ key: "db" }).file(file);

/** What the control plane would answer. A real one is one `fetch` away. */
let poolSize = 24;

config.setRemoteAsync(async () => {
  // In a real one:
  //
  //   const response = await fetch(URL, { signal: AbortSignal.timeout(5000) })
  //   response.ok || throw new Error(`the control plane said ${response.status}`)
  //   return { text: await response.text(), format: "json" }
  //
  // The deadline is yours, as it is for a synchronous store: nothing here
  // can interrupt a fetch that never returns.
  await sleep(20);

  return { text: JSON.stringify({ db: { poolSize } }), format: "json" };
}, "the control plane");

console.log("the file alone");
await config.init();
console.log("  poolSize", config.current().poolSize, "— from the file");

console.log("\nfetch, then load");
await config.refreshRemote();
await config.reload();

console.log("  poolSize", config.current().poolSize, "— from", config.remoteDescription);
console.log("  provenance", config.sourceOf("poolSize"));

console.log("\nthe store changes its mind");
poolSize = 64;
await config.refreshRemote();
await config.reload();
console.log("  poolSize", config.current().poolSize);

console.log("\nand a store having a bad afternoon");
config.setRemoteAsync(async () => {
  throw new Error("the control plane timed out after 5s");
}, "the control plane");

try {
  await config.refreshRemote();
} catch (failure) {
  // Its own error, not a `remote` failure: nothing had entered the engine
  // yet, so there was nothing to categorise it as.
  console.log(" ", failure.constructor.name + ":", failure.message);
}

console.log("  still serving: poolSize", config.current().poolSize);
