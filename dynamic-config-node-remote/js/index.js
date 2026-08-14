"use strict";

/**
 * The eight Rust stores, for the Node binding.
 *
 * The compiled half is one class per store; this is the two things that
 * make them pleasant: the same `DynamicConfigError` the base package
 * throws, and `useStore`, which is the four lines every caller would
 * otherwise write to bridge an async fetch to a synchronous source.
 */

const { createRequire } = require("node:module");

const load = createRequire(__filename);

function addon() {
  const platform = `dynamic-config-node-remote-${process.platform}-${process.arch}${
    process.platform === "linux" ? "-glibc" : ""
  }`;

  for (const candidate of [platform, "../index.node"]) {
    try {
      return load(candidate);
    } catch (failure) {
      if (failure.code !== "MODULE_NOT_FOUND") {
        throw failure;
      }
    }
  }

  throw new Error(
    `dynamic-config-node-remote has no binary for ${process.platform} ${process.arch}. ` +
      `Neither the platform package (${platform}) nor a local build is here.`,
  );
}

const native = addon();

/** The base package's error, so a caller catches one type and not two. */
const { DynamicConfigError } = require("dynamic-config-node");

function unwrap(outcome) {
  if (outcome.ok) {
    return outcome.value;
  }

  throw new DynamicConfigError(outcome.error);
}

/**
 * A store from this package, as the base package's `setRemote` wants it.
 *
 * The bridge is one fact: a fetch is a network round trip and must not sit
 * on the event loop, so `fetch()` here is async — and the engine's remote
 * layer is filled from a worker thread, so what it calls must be
 * synchronous. `useStore` reconciles the two by keeping the last answer:
 * every `refreshRemote()` fetches asynchronously first, then hands the
 * result over synchronously.
 *
 * ```js
 * const store = new Etcd(["http://etcd:2379"], "myapp/db.json")
 *
 * const handle = await useStore(config, store) // fetch, install, and it is live
 *
 * await handle.refresh()                       // later, on a timer or a signal
 * ```
 *
 * The refresh lives on the returned handle rather than in a second free
 * function because it needs the same `latest` slot the install created —
 * a bare `refreshStore(config, store)` would have nowhere to put the
 * answer.
 */
async function useStore(config, store) {
  const latest = { current: await fetchFrom(store) };

  config.setRemote(() => latest.current, store.describe());
  await config.refreshRemote();
  await config.reload();

  // The handle a later refresh needs: the store, and where its answer goes.
  return {
    async refresh() {
      latest.current = await fetchFrom(store);

      await config.refreshRemote();

      return config.reload();
    },
  };
}

/** One fetch, unwrapped into a document or a `DynamicConfigError`. */
async function fetchFrom(store) {
  return unwrap(await store.fetch());
}

module.exports = {
  Consul: native.Consul,
  Etcd: native.Etcd,
  Firestore: native.Firestore,
  Git: native.Git,
  Nats: native.Nats,
  Redis: native.Redis,
  S3: native.S3,
  Vault: native.Vault,
  useStore,
  fetchFrom,
  packageVersion: native.packageVersion,
  engineVersion: native.engineVersion,
};
