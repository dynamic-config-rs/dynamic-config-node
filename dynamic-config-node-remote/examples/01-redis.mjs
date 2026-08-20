// Redis: fetch, refresh, and the push loop.
//
// A server to point it at:
//
//     docker run --rm -d -p 6379:6379 redis:7-alpine
//     redis-cli set myapp/db.json '{"db": {"host": "redis-db", "port": 6001}}'
//
// Then `node examples/01-redis.mjs`. With nothing listening it says so
// and carries on — the point is the shapes, not the server.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DynamicConfig, DynamicConfigError } = require("dynamic-config-node");
const { Redis, useStore } = require("../js/index.js");

const URL = process.env.REDIS ?? "redis://127.0.0.1:6379";

// ── One key, fetched once ────────────────────────────────────────────────
//
// `useStore` is the bridge: the fetch is asynchronous, the engine's
// source is synchronous, and the handle keeps the last answer between
// the two.

const config = new DynamicConfig({ key: "db" });
const store = new Redis(URL, "myapp/db.json");

console.log("store:", store.describe()); // never carries a credential

try {
  const handle = await useStore(config, store);

  console.log("fetched:", config.current());

  // ── Refresh, on whatever schedule the program owns ───────────────────
  await handle.refresh();
  console.log("refreshed: generation", config.generation);

  // ── Or pushed: Redis is one of the four watchable stores ─────────────
  //
  // The watch rides keyspace notifications, which are off by default —
  // `redis-cli config set notify-keyspace-events KEA` turns them on, and
  // a server without them reports exactly that through the error
  // callback rather than silently never delivering. `stop()` is
  // asynchronous because joining a thread inside a network request
  // would park the event loop.
  const watching = store.watch(
    () => console.log("pushed: generation", config.generation),
    (failure) => console.log("watch failure:", failure.error.kind),
  );

  await new Promise((resolve) => setTimeout(resolve, 500));
  await watching.stop();
} catch (failure) {
  if (failure instanceof DynamicConfigError && ["remote", "io"].includes(failure.kind)) {
    console.log(`nothing listening at ${URL} — start the container above to see it live`);
  } else {
    throw failure;
  }
}
