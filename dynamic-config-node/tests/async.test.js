"use strict";

/**
 * The async surface: the event stream, hooks that return promises, and a
 * store whose client is async.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout: sleep } = require("node:timers/promises");

const { DynamicConfig } = require("../js/index.js");

const { workspace } = require("./workspace.js");

function database(document) {
  if (typeof document.port !== "number") {
    throw new Error("port must be a number");
  }

  return document;
}

const document = (port) => `[db]\nhost = "h"\nport = ${port}\n`;

// ── events() ───────────────────────────────────────────────────────────

test("events reports every install, with the paths that moved", async () => {
  const { path, write } = workspace(document(1));
  const config = await new DynamicConfig({ key: "db", validate: database })
    .file(path)
    .init();

  const seen = [];
  const stream = (async () => {
    for await (const event of config.events()) {
      seen.push(event);

      if (seen.length === 2) {
        break;
      }
    }
  })();

  await sleep(20);

  write(document(2));
  await config.reload();
  write(document(3));
  await config.reload();

  await stream;

  assert.deepEqual(
    seen.map((event) => event.type),
    ["reloaded", "reloaded"],
  );
  assert.deepEqual(seen[0].changed, ["port"], "paths, and only the one that moved");
  assert.equal(seen[0].generation, 2);
  assert.ok(seen[0].at > 0);
});

test("events reports a refusal natively, with no poll interval", async () => {
  const { path, write } = workspace(document(1));
  const config = await new DynamicConfig({ key: "db", validate: database })
    .file(path)
    .init();

  const seen = [];
  const stream = (async () => {
    for await (const event of config.events()) {
      seen.push(event);

      if (seen.length === 3) {
        break;
      }
    }
  })();

  await sleep(20);

  write(document(2));
  await config.reload();
  await sleep(50);

  write('[db]\nhost = "h"\nport = "nope"\n');
  await assert.rejects(() => config.reload(), { kind: "invalid" });
  await sleep(100);

  write(document(3));
  await config.reload();

  await stream;

  assert.deepEqual(
    seen.map((event) => event.type),
    ["reloaded", "reloadFailed", "reloaded"],
  );
  assert.equal(seen[1].kind, "invalid");
  assert.equal(seen[1].consecutive, 1);
});

test("failurePollMs is accepted, ignored, and warns once", async () => {
  const { path, write } = workspace(document(1));
  const config = await new DynamicConfig({ key: "db", validate: database })
    .file(path)
    .init();

  const warnings = [];
  const onWarning = (warning) => warnings.push(warning);
  process.on("warning", onWarning);

  try {
    const seen = [];
    const stream = (async () => {
      for await (const event of config.events({ failurePollMs: 1000 })) {
        seen.push(event);
        break;
      }
    })();

    await sleep(20);

    write(document(2));
    await config.reload();
    await stream;

    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, "reloaded");

    // `process.emitWarning` delivers on a later tick.
    await sleep(20);
    assert.ok(
      warnings.some((warning) => warning.code === "DYNAMIC_CONFIG_FAILURE_POLL"),
      "the deprecation surfaced",
    );
  } finally {
    process.off("warning", onWarning);
  }
});

test("an aborted signal ends changes() as a break would", async () => {
  const { path, write } = workspace(document(1));
  const config = await new DynamicConfig({ key: "db", validate: database })
    .file(path)
    .init();

  const controller = new AbortController();
  const seen = [];
  const stream = (async () => {
    for await (const doc of config.changes({ signal: controller.signal })) {
      seen.push(doc);
    }

    return "ended";
  })();

  await sleep(20);

  write(document(2));
  await config.reload();
  await sleep(20);

  controller.abort();

  assert.equal(await stream, "ended", "a return, not an error");
  assert.equal(seen.length, 1);
});

test("an already-aborted signal yields nothing from events()", async () => {
  const { path } = workspace(document(1));
  const config = await new DynamicConfig({ key: "db", validate: database })
    .file(path)
    .init();

  const seen = [];

  for await (const event of config.events({ signal: AbortSignal.abort() })) {
    seen.push(event);
  }

  assert.equal(seen.length, 0);
});

test("no event carries a value", async () => {
  const { path, write } = workspace('[db]\nhost = "h"\nport = 1\n');
  const config = await new DynamicConfig({ key: "db" }).file(path).init();

  const seen = [];
  const stream = (async () => {
    for await (const event of config.events()) {
      seen.push(event);
      break;
    }
  })();

  await sleep(20);

  write('[db]\nhost = "hunter2-do-not-log"\nport = 1\n');
  await config.reload();
  await stream;

  assert.equal(JSON.stringify(seen).includes("hunter2"), false);
  assert.deepEqual(seen[0].changed, ["host"]);
});

// ── onReloadAsync() ────────────────────────────────────────────────────

test("latest keeps the newest install and drops what it overtook", async () => {
  const { path, write } = workspace(document(1));
  const config = await new DynamicConfig({ key: "db", validate: database })
    .file(path)
    .init();

  const seen = [];

  config.onReloadAsync(async (value) => {
    await sleep(120);
    seen.push(value.port);
  });

  for (const port of [2, 3, 4]) {
    write(document(port));
    await config.reload();
    await sleep(5);
  }

  await sleep(500);

  assert.deepEqual(seen, [2, 4], "the first ran, the last was kept, the middle dropped");
});

test("serial drops nothing", async () => {
  const { path, write } = workspace(document(1));
  const config = await new DynamicConfig({ key: "db", validate: database })
    .file(path)
    .init();

  const seen = [];

  config.onReloadAsync(
    async (value) => {
      await sleep(40);
      seen.push(value.port);
    },
    { backpressure: "serial" },
  );

  for (const port of [2, 3, 4]) {
    write(document(port));
    await config.reload();
    await sleep(5);
  }

  await sleep(500);

  assert.deepEqual(seen, [2, 3, 4]);
});

test("a superseded call is told to stop, and a rejection is reported", async () => {
  const { path, write } = workspace(document(1));
  const config = await new DynamicConfig({ key: "db", validate: database })
    .file(path)
    .init();

  const aborted = [];
  const failures = [];

  config.onReloadAsync(
    async (value, { signal }) => {
      await sleep(120);

      if (signal.aborted) {
        aborted.push(value.port);
      }

      if (value.port === 3) {
        throw new Error("the hook did not like this one");
      }
    },
    { onError: (error) => failures.push(error) },
  );

  write(document(2));
  await config.reload();
  await sleep(5);
  write(document(3));
  await config.reload();

  await sleep(500);

  assert.deepEqual(aborted, [2], "the call the newer install superseded");
  assert.equal(failures.length, 1, "and a rejection is reported, not unhandled");
});

test("an unknown backpressure policy is refused where it is written", async () => {
  const { path } = workspace(document(1));
  const config = await new DynamicConfig({ key: "db" }).file(path).init();

  assert.throws(() => config.onReloadAsync(async () => {}, { backpressure: "newest" }), {
    name: "TypeError",
  });
});

// ── setRemoteAsync() ───────────────────────────────────────────────────

test("an async store is awaited on the loop and merged like any other", async () => {
  const { path } = workspace(document(1));
  const config = new DynamicConfig({ key: "db", validate: database }).file(path);

  let fetches = 0;

  config.setRemoteAsync(async () => {
    fetches += 1;

    await sleep(5);

    return {
      text: JSON.stringify({ db: { host: "remote", port: 99 } }),
      format: "json",
    };
  }, "the control plane");

  assert.equal(config.remoteDescription, "the control plane");

  await config.refreshRemote();
  await config.init();

  assert.equal(config.current().port, 99);
  assert.equal(fetches, 1);
  assert.deepEqual(config.sourceOf("port"), {
    kind: "remote",
    detail: "the control plane",
  });
});

test("a rejecting async fetch reaches the caller as its own error", async () => {
  const { path } = workspace(document(1));
  const config = new DynamicConfig({ key: "db", validate: database }).file(path);

  config.setRemoteAsync(async () => {
    throw new Error("the store timed out");
  });

  await assert.rejects(() => config.refreshRemote(), /the store timed out/);
});

test("swapping back to a synchronous store forgets the async one", async () => {
  const { path } = workspace(document(1));
  const config = new DynamicConfig({ key: "db", validate: database }).file(path);

  config.setRemoteAsync(async () => ({
    text: JSON.stringify({ db: { host: "remote", port: 99 } }),
    format: "json",
  }));

  await config.refreshRemote();

  config.setRemote(() => ({
    text: JSON.stringify({ db: { host: "sync", port: 7 } }),
    format: "json",
  }));

  await config.refreshRemote();
  await config.init();

  assert.equal(config.current().port, 7);
});

// ── running() ──────────────────────────────────────────────────────────

test("running loads, watches and stops, and answers what the block did", async () => {
  const { path, write } = workspace(document(1));
  const config = new DynamicConfig({ key: "db", validate: database }).file(path);

  const answer = await config.running(
    async (loaded) => {
      assert.equal(loaded.port, 1);

      const before = config.generation;

      write(document(2));

      for (let attempt = 0; attempt < 100 && config.generation === before; attempt += 1) {
        await sleep(50);
      }

      assert.equal(config.current().port, 2, "the block watches");

      return "done";
    },
    { debounceMs: 50 },
  );

  assert.equal(answer, "done");

  // The watcher is stopped, so a later edit changes nothing.
  write(document(3));
  await sleep(200);

  assert.equal(config.current().port, 2);
});
