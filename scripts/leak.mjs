#!/usr/bin/env node
// The leak budget, addon edition — see the python twin for the argument.
// Exit 0 = within budget.

import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = process.env.CONFORMANCE_PACKAGE ?? "../dynamic-config-node/js/index.js";
const { DynamicConfig } = await import(source);

const RELOADS = Number(process.env.LEAK_RELOADS ?? 100000);
const dir = mkdtempSync(join(tmpdir(), "dynamic-config-leak-"));
const file = join(dir, "config.json");
const fds = () => readdirSync("/proc/self/fd").length;

writeFileSync(file, JSON.stringify({ app: { n: 1 } }));

const config = new DynamicConfig({ key: "app" }).file(file);
await config.init();

let seen = 0;
config.onReload(() => { seen += 1; });

const rssBefore = process.memoryUsage().rss;
const fdsBefore = fds();

for (let n = 2; n < RELOADS + 2; n += 1) {
  writeFileSync(file, JSON.stringify({ app: { n } }));
  await config.reload();
}

globalThis.gc?.();
const rssAfter = process.memoryUsage().rss;
const fdsAfter = fds();

console.log(
  `leak: ${RELOADS} reloads | rss ${rssBefore}->${rssAfter} B | fds ${fdsBefore}->${fdsAfter} | hooks fired ${seen}`,
);

let failed = false;

if (rssAfter > rssBefore + 192 * 1024 * 1024) {
  console.error(`LEAK: rss grew ${rssAfter - rssBefore} B`);
  failed = true;
}

if (fdsAfter > fdsBefore + 8) {
  console.error(`LEAK: fds grew ${fdsAfter - fdsBefore}`);
  failed = true;
}

if (seen !== RELOADS) {
  console.error(`LEAK/LOSS: ${seen} hook calls for ${RELOADS} reloads`);
  failed = true;
}

process.exit(failed ? 1 : 0);
