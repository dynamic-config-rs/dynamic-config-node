// etcd: several keys, one document — and authentication as arguments.
//
// A server to point it at:
//
//     docker run --rm -d -p 2379:2379 quay.io/coreos/etcd:v3.6.5 \
//       etcd --advertise-client-urls http://0.0.0.0:2379 \
//            --listen-client-urls http://0.0.0.0:2379
//     etcdctl put myapp/db.json    '{"db": {"host": "etcd-db"}}'
//     etcdctl put myapp/cache.json '{"cache": {"ttl": 60}}'
//
// Then `node examples/02-etcd.mjs`.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DynamicConfig, DynamicConfigError } = require("dynamic-config-node");
const { Etcd, useStore } = require("../js/index.js");

const ENDPOINTS = [process.env.ETCD ?? "http://127.0.0.1:2379"];

const config = new DynamicConfig({ key: "db" });

// `keys` (plural): the documents deep-merge in order, later keys
// winning where they overlap — the same rule the engine's layers use.
// `username`/`password` are constructor arguments, not URL fragments,
// because a rotated credential is a new argument rather than a
// substring nobody can change. (etcd's TLS client-certificate mode is
// the `tls` argument; both are first-class in the Kubernetes agent
// too.)
const store = new Etcd(
  ENDPOINTS,
  null,
  ["myapp/db.json", "myapp/cache.json"],
  null,
  "json",
  process.env.ETCD_USER ?? null,
  process.env.ETCD_PASSWORD ?? null,
);

console.log("store:", store.describe());

try {
  const handle = await useStore(config, store);

  console.log("merged:", config.current());

  // etcd is watchable: its watch API pushes revisions, and the loop
  // re-fetches the whole set so the merge stays whole.
  const watching = store.watch(
    () => console.log("pushed: generation", config.generation),
    (failure) => console.log("watch failure:", failure.error.kind),
  );

  await handle.refresh();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await watching.stop();
} catch (failure) {
  if (failure instanceof DynamicConfigError && ["remote", "io"].includes(failure.kind)) {
    console.log(`nothing listening at ${ENDPOINTS[0]} — start the container above`);
  } else {
    throw failure;
  }
}
