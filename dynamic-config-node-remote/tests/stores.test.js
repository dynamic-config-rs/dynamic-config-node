"use strict";

/**
 * The eight stores, without a server.
 *
 * What can be asserted with no container is the half that is this
 * package's own: the constructors, the key shapes, the descriptions that
 * must not carry a credential, and the failure a store that is not there
 * produces. The other half — a document actually arriving — is the store
 * crates' container suites, which already run against real servers.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const stores = require("../js/index.js");
const { DynamicConfigError } = require("dynamic-config-node");
const { setTimeout: sleep } = require("node:timers/promises");

/** Every store, constructed the smallest way each one allows. */
function each() {
  return [
    ["Consul", new stores.Consul("http://127.0.0.1:9", "myapp/db.json")],
    ["Vault", new stores.Vault("http://127.0.0.1:9", "secret", "myapp/db")],
    ["Redis", new stores.Redis("redis://127.0.0.1:9", "myapp/db.json")],
    ["Etcd", new stores.Etcd(["http://127.0.0.1:9"], "myapp/db.json")],
    ["Nats", new stores.Nats("nats://127.0.0.1:9", "config", "db.json")],
    ["S3", new stores.S3("myapp-config", "prod/db.json")],
    ["Firestore", new stores.Firestore("myapp", "config/db")],
    ["Git", new stores.Git("https://example.invalid/repo.git", "config/db.json")],
  ];
}

test("every store describes itself", () => {
  for (const [name, store] of each()) {
    const described = store.describe();

    assert.equal(typeof described, "string", name);
    assert.ok(described.length > 0, name);
  }
});

test("a description never carries a credential", () => {
  const redis = new stores.Redis("redis://app:hunter2@127.0.0.1:6379", "myapp/db.json");
  const git = new stores.Git("https://app:hunter2@example.invalid/repo.git", "config/db.json");

  assert.ok(!redis.describe().includes("hunter2"), redis.describe());
  assert.ok(!git.describe().includes("hunter2"), git.describe());
});

test("exactly one of key, keys and prefix", () => {
  assert.throws(
    () => new stores.Consul("http://127.0.0.1:9", "one", ["and", "several"]),
    /exactly one of the three/,
  );
  assert.throws(() => new stores.Consul("http://127.0.0.1:9"), /exactly one of the three/);
});

test("a format that is not one is refused by name", () => {
  assert.throws(
    () => new stores.Consul("http://127.0.0.1:9", "myapp/db.json", null, null, "xml"),
    /is not a format/,
  );
});

test("a git source reads one reference, not two", () => {
  assert.throws(
    () =>
      new stores.Git(
        "https://example.invalid/repo.git",
        "config/db.json",
        null,
        null,
        "main",
        "v1.0",
      ),
    /not two of them/,
  );
});

test("a store that is not there fails as `remote`, and says so", async () => {
  // Port 9 is discard: nothing listens, on any machine. The three async
  // clients get their own runtime per fetch, so this also proves that the
  // runtime is built, used and dropped without leaving the process up.
  for (const [name, store] of each()) {
    if (name === "S3" || name === "Firestore" || name === "Git") {
      // These three reach a real endpoint by name rather than a port, so a
      // failure here would be about DNS or about somebody's credentials
      // file — not about this package.
      continue;
    }

    const outcome = await store.fetch();

    assert.equal(outcome.ok, false, name);
    assert.ok(
      ["remote", "auth", "io", "backend"].includes(outcome.error.kind),
      `${name}: ${outcome.error.kind}`,
    );
    assert.ok(outcome.error.message.length > 0, name);
  }
});

test("fetchFrom throws the base package's error", async () => {
  const store = new stores.Consul("http://127.0.0.1:9", "myapp/db.json");

  await assert.rejects(() => stores.fetchFrom(store), (failure) => {
    assert.ok(failure instanceof DynamicConfigError);
    assert.equal(failure.kind, "remote");

    return true;
  });
});

test("useStore installs a document and keeps it current", async () => {
  const { DynamicConfig } = require("dynamic-config-node");

  // A store of our own with the same two methods the eight have: that is
  // the whole contract, and it is what makes `useStore` testable without a
  // server.
  let served = '{"db":{"host":"first"}}';

  const store = {
    fetch: async () => ({ ok: true, value: { text: served, format: "json" } }),
    describe: () => "a store standing in for one of the eight",
  };

  const config = new DynamicConfig({ key: "db" });
  const handle = await stores.useStore(config, store);

  assert.equal(config.current().host, "first");
  assert.equal(config.remoteDescription, "a store standing in for one of the eight");

  served = '{"db":{"host":"second"}}';
  await handle.refresh();

  assert.equal(config.current().host, "second");
  assert.equal(config.remoteStatus().fetches, 2);
});

test("the four push stores can be watched, and stopping is idempotent", async () => {
  // A watch against a port nothing listens on: what is asserted is the
  // handle, not a delivery — the loop reports its failure through the
  // error callback and `stop()` ends it either way. A document actually
  // arriving is the store crates' container suites.
  const failures = [];
  const watched = [
    new stores.Consul("http://127.0.0.1:9", "myapp/db.json"),
    new stores.Redis("redis://127.0.0.1:9", "myapp/db.json"),
    new stores.Etcd(["http://127.0.0.1:9"], "myapp/db.json"),
    new stores.Nats("nats://127.0.0.1:9", "config", "db.json"),
  ];

  const handles = watched.map((store) =>
    store.watch(
      () => assert.fail("nothing is listening on port 9"),
      (failure) => failures.push(failure),
    ),
  );

  await sleep(300);

  // Asynchronous: joining a thread that is inside a network request would
  // park the event loop, so `stop()` resolves when the loop has actually
  // stopped rather than blocking until then.
  await Promise.all(handles.map((handle) => handle.stop()));
  await Promise.all(handles.map((handle) => handle.stop())); // idempotent

  // Every one of them reported *something*: a connection refused, a
  // subscription that would not open, a stream that never established.
  assert.ok(failures.length > 0, "a watch that cannot start says so");

  for (const failure of failures) {
    assert.equal(failure.ok, false);
    assert.ok(["remote", "auth", "io", "backend"].includes(failure.error.kind), failure.error.kind);
  }
});

test("a credential function is called before each fetch", async () => {
  let minted = 0;

  const store = new stores.Consul(
    "http://127.0.0.1:9",
    "myapp/db.json",
    null,
    null,
    null,
    null,
    () => {
      minted += 1;

      return `token-${minted}`;
    },
  );

  // Two fetches, two mints: a token that rotated is a token the store must
  // not have been holding.
  await store.fetch();
  await store.fetch();

  assert.equal(minted, 2, "the function is called per fetch, not per store");
});

test("half a client certificate is refused rather than ignored", () => {
  // A deployment that meant mTLS and typed one field name would otherwise
  // connect with no identity and be told its *permissions* are wrong.
  assert.throws(
    () =>
      new stores.Consul("https://127.0.0.1:9", "k", null, null, null, null, null, {
        clientCertificateFile: "/etc/ssl/app.crt",
      }),
    /both halves/,
  );

  assert.throws(
    () =>
      new stores.Vault("https://127.0.0.1:9", "secret", "p", null, null, null, null, {
        clientKeyPem: "-----BEGIN PRIVATE KEY-----",
      }),
    /both halves/,
  );
});

test("one-sided etcd credentials are refused", () => {
  assert.throws(
    () => new stores.Etcd(["http://127.0.0.1:9"], "k", null, null, null, "app"),
    /both `username` and `password`/,
  );
  assert.throws(
    () => new stores.Etcd(["http://127.0.0.1:9"], "k", null, null, null, null, "hunter2"),
    /both `username` and `password`/,
  );
});

test("TLS material is accepted as files and as bytes", () => {
  // Neither is used here — nothing listens — but both shapes have to be
  // *constructible*, because a Kubernetes secret is a mounted file and a
  // certificate fetched at startup is bytes that never touch a disk.
  const withFiles = new stores.Consul("https://127.0.0.1:9", "k", null, null, null, null, null, {
    caCertificateFile: "/etc/ssl/ca.pem",
    clientCertificateFile: "/etc/ssl/app.crt",
    clientKeyFile: "/etc/ssl/app.key",
  });

  const withBytes = new stores.Vault("https://127.0.0.1:9", "secret", "p", null, null, null, null, {
    caCertificatePem: "-----BEGIN CERTIFICATE-----\nnot a real one\n-----END CERTIFICATE-----",
  });

  assert.match(withFiles.describe(), /consul/);
  assert.match(withBytes.describe(), /vault/);
});

test("both versions are reported", () => {
  assert.match(stores.packageVersion(), /^\d+\.\d+\.\d+$/);
  assert.match(stores.engineVersion(), /^\d+\.\d+\.\d+$/);
});
