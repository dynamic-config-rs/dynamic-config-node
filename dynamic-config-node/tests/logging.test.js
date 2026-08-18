"use strict";

/**
 * `setLogger` — the engine's diagnostics offered to JavaScript.
 *
 * The default is unchanged stderr; these tests cover the opt-in: a
 * handler receives the reload lines on the event loop, the level gates
 * them, and `setLogger(null)` restores the world.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { DynamicConfig, setLogger } = require("../js/index.js");

function workspace(n) {
  const dir = mkdtempSync(join(tmpdir(), "dynamic-config-log-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ app: { n } }));
  return file;
}

async function drain(check, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a handler receives the reload line, on the loop", async () => {
  const file = workspace(1);
  const lines = [];

  setLogger({ handler: (level, line) => lines.push([level, line]) });

  try {
    const config = await new DynamicConfig({ key: "app" }).file(file).init();

    writeFileSync(file, JSON.stringify({ app: { n: 2 } }));
    await config.reload();

    config.watch({ debounceMs: 20 });
    try {
      // Keep writing until a line lands: macOS's FSEvents stream arms
      // asynchronously, so a single write racing `watch()` can precede
      // the stream and never produce an event. Repeated writes assert
      // what this test is about — delivery — rather than arming latency.
      let n = 3;
      const deadline = Date.now() + 5000;
      while (!lines.some(([, l]) => l.includes("reloaded")) && Date.now() < deadline) {
        writeFileSync(file, JSON.stringify({ app: { n: n++ } }));
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      config.stopWatching();
    }

    assert.ok(
      lines.some(([level, line]) => level === "info" && line.includes("reloaded")),
      `no reload line arrived: ${JSON.stringify(lines)}`,
    );
    assert.ok(
      lines.every(([, line]) => !line.startsWith("[dynamic-config]")),
      "the stderr prefix does not belong in a handler",
    );
  } finally {
    setLogger(null);
  }
});

test("the level gates what the handler sees", async () => {
  const file = workspace(1);
  const lines = [];

  setLogger({ level: "warn", handler: (level, line) => lines.push(level) });

  try {
    const config = await new DynamicConfig({ key: "app" }).file(file).init();

    config.watch({ debounceMs: 20 });
    try {
      // Driven writes, as above: the absence assertion below is only
      // meaningful once a reload demonstrably happened.
      let n = 2;
      const deadline = Date.now() + 5000;
      while (config.generation < 2 && Date.now() < deadline) {
        writeFileSync(file, JSON.stringify({ app: { n: n++ } }));
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(config.generation >= 2, "no reload happened; nothing was gated");
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 300));
      config.stopWatching();
    }

    assert.ok(!lines.includes("info"), `an info line passed "warn": ${lines}`);
  } finally {
    setLogger(null);
  }
});
