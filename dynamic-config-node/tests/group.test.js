"use strict";

/**
 * Several configurations under one lifecycle, and the atomic reload.
 *
 * `node --test`, no framework, like the rest of the suite.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout: sleep } = require("node:timers/promises");

const { ConfigGroup, DynamicConfig, changedPaths } = require("../js/index.js");

const { workspace } = require("./workspace.js");

/** The two schemas the fixtures below are written against. */
function database(document) {
  if (typeof document.port !== "number") {
    throw new Error("port must be a number");
  }

  return document;
}

function cache(document) {
  if (typeof document.ttl !== "number") {
    throw new Error("ttl must be a number");
  }

  return document;
}

/** One file, two sections — the shape a deployment moves as one. */
function documentWith(port, ttl) {
  return `[db]\nhost = "h"\nport = ${port}\n\n[cache]\nttl = ${ttl}\n`;
}

function pair(path) {
  return [
    new DynamicConfig({ key: "db", validate: database }).file(path),
    new DynamicConfig({ key: "cache", validate: cache }).file(path),
  ];
}

test("a group needs configurations, and distinct keys", () => {
  const { path } = workspace(documentWith(1, 60));
  const [first] = pair(path);

  assert.throws(() => new ConfigGroup(), { name: "TypeError" });
  assert.throws(() => new ConfigGroup(first, first), /share a key/);
});

test("a group initialises every member", async () => {
  const { path } = workspace(documentWith(1, 60));
  const [db, redis] = pair(path);
  const group = new ConfigGroup(db, redis);

  await group.init();

  assert.equal(db.current().port, 1);
  assert.equal(redis.current().ttl, 60);
  assert.deepEqual(group.generations(), { db: 1, cache: 1 });
  assert.deepEqual(Object.keys(group.status()), ["db", "cache"]);
  assert.equal(group.size, 2);
  assert.deepEqual([...group].map((config) => config.key), ["db", "cache"]);
});

test("an atomic reload installs all of them or none", async () => {
  const { path, write } = workspace(documentWith(1, 60));
  const [db, redis] = pair(path);
  const group = new ConfigGroup(db, redis);

  await group.init();

  write(documentWith(2, '"forever"'));

  await assert.rejects(() => group.reloadAtomic(), { kind: "invalid" });

  assert.equal(db.current().port, 1, "the member that parsed still did not install");
  assert.equal(redis.current().ttl, 60);
  assert.deepEqual(
    group.generations(),
    { db: 1, cache: 1 },
    "and not even the generation moved",
  );

  write(documentWith(3, 90));
  await group.reloadAtomic();

  assert.equal(db.current().port, 3);
  assert.equal(redis.current().ttl, 90);
  assert.deepEqual(group.generations(), { db: 2, cache: 2 });
});

test("a plain group reload is per member, and every member has its turn", async () => {
  const { path, write } = workspace(documentWith(1, 60));
  // The refusing one first, so what is under test is what happens after it.
  const [db, redis] = pair(path);
  const group = new ConfigGroup(redis, db);

  await group.init();

  write(documentWith(2, '"forever"'));

  await assert.rejects(() => group.reload(), { kind: "invalid" });

  assert.equal(redis.current().ttl, 60, "refused, and still serving what it had");
  assert.equal(db.current().port, 2, "and the other member still reloaded");
});

test("watching starts and stops every member", async () => {
  const { path, write } = workspace(documentWith(1, 60));
  const [db, redis] = pair(path);
  const group = new ConfigGroup(db, redis);

  await group.running(
    async () => {
      const loaded = db.generation;

      write(documentWith(2, 90));

      for (let attempt = 0; attempt < 100 && db.generation === loaded; attempt += 1) {
        await sleep(50);
      }

      assert.equal(db.current().port, 2, "the block watches, as it says it does");
    },
    { debounceMs: 50 },
  );

  // Stopped on the way out: a second stop is a no-op rather than a throw.
  group.stopWatching();
});

test("running without a watcher only loads", async () => {
  const { path, write } = workspace(documentWith(1, 60));
  const [db, redis] = pair(path);

  await new ConfigGroup(db, redis).running(
    async () => {
      write(documentWith(2, 60));
      await sleep(200);

      assert.equal(db.current().port, 1, "nothing is watching, so nothing reloads");
    },
    { watch: false },
  );
});

test("the block's own answer is what running returns", async () => {
  const { path } = workspace(documentWith(7, 60));
  const [db, redis] = pair(path);

  const answer = await new ConfigGroup(db, redis).running(() => db.current().port, {
    watch: false,
  });

  assert.equal(answer, 7);
});

test("changedPaths reports paths and never values", () => {
  const moved = changedPaths(
    { db: { host: "a", password: "hunter2" }, cache: { ttl: 60 } },
    { db: { host: "b", password: "hunter3" }, queue: { url: "x" } },
  );

  assert.deepEqual(moved.sort(), ["cache", "db.host", "db.password", "queue"]);
  assert.equal(JSON.stringify(moved).includes("hunter"), false);
});
