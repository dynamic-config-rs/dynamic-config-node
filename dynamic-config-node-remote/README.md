# dynamic-config-node-remote

The eight Rust remote stores for
[`dynamic-config-node`](https://ctolon.github.io/dynamic-config/node/) —
**etcd, Consul, Vault, NATS, Redis, S3, Firestore and git** — as a second
package. The chapter that covers them is
[Remote stores](https://ctolon.github.io/dynamic-config/node/remote-stores.html).

```sh
npm install dynamic-config-node dynamic-config-node-remote
```

```ts
import { DynamicConfig } from "dynamic-config-node"
import { Etcd, useStore } from "dynamic-config-node-remote"

const config = new DynamicConfig({ key: "db", validate })
await config.file("config.toml").init()

const store = new Etcd(["http://etcd:2379"], "myapp/db.json")
const installed = await useStore(config, store)

// Later — on a timer, a signal, a webhook:
await installed.refresh()
```

## Why a second package

A gRPC stack, an AWS SDK and three HTTP clients in every `npm install
dynamic-config` is not a default anybody asked for. The same reason they
are a second wheel in Python: the engine is small, the clients are not,
and a program that reads a file should not pay for eight of them.

## What a store is

One class per store, each with the same two methods:

```ts
await store.fetch()   // { ok: true, value: { text, format } }
store.describe()      // how it names itself in an error
```

That is exactly the shape the base package's `setRemote` takes, so a store
from here is indistinguishable from one somebody wrote in JavaScript — and
`useStore` is the four lines that bridge the two: **`fetch()` is async**
because a network round trip must not sit on the event loop, and the
engine's remote layer is filled from a worker thread and must be handed a
synchronous answer, so the last one is kept.

## The stores

| Store | Constructed with |
|---|---|
| `Consul` | `address`, one of `key`/`keys`/`prefix`, `format?`, `token?`, `timeoutMs?` |
| `Vault` | `address`, `mount`, `path`/`paths`, `token?`, `timeoutMs?` |
| `Redis` | `url` (the credential rides in it), `key`/`keys`/`prefix`, `format?`, `timeoutMs?` |
| `Etcd` | `endpoints[]`, `key`/`keys`/`prefix`, `format?`, `username?`, `password?`, `timeoutMs?` |
| `Nats` | `server`, `bucket`, `key`/`keys`, `format?`, `timeoutMs?` |
| `S3` | `bucket`, `key`/`keys`/`prefix`, `format?`, `timeoutMs?` — credentials from the environment |
| `Firestore` | `project`, `path`/`paths`, `accessToken?`, `timeoutMs?` |
| `Git` | `url`, `path`/`paths`/`prefix`, one of `branch`/`tag`/`commit`, `format?`, `token?`, `timeoutMs?` |

**A description never carries a credential.** A Redis URL with a password
in it, a git URL with a token: both are redacted by the store crates' own
rule, so an error message and a log line are safe to keep.

## Credentials that rotate

A token as a **string** is right for something an operator pasted into a
deployment. It is wrong for every credential that turns over — a projected
service-account token the kubelet rewrites, a Vault token with a lease, a
Google access token that lives an hour — because a store built once holds
what it was given until the process ends.

So a credential may be a **function**, called on the event loop before
each fetch:

```ts
new Vault("https://vault:8200", "secret", "myapp/db", null, null, null,
  () => readFileSync("/var/run/secrets/vault-token", "utf8"))
```

The loop is where your `readFileSync`, your cloud SDK and your own cache
live, so a value read there is the current one by construction.

## TLS

Files *and* bytes, because both are real — a Kubernetes secret is a
mounted file, and a certificate fetched at startup is bytes that never
touch a disk:

```ts
new Consul(address, key, null, null, null, null, null, {
  caCertificateFile: "/etc/ssl/private-ca.pem",
  clientCertificateFile: "/etc/ssl/app.crt",
  clientKeyFile: "/etc/ssl/app.key",
})
```

Saying nothing means the platform's trust store, not *no TLS*.

## Watching

Four of the stores **push**, and those can be watched:

```ts
const handle = store.watch(
  (document) => console.log("the store moved", document),
  (failure) => console.error("the watch ended", failure.error),
)

handle.stop()   // idempotent, and it waits for the loop to notice
```

| Store | How it notices |
|---|---|
| `Consul` | a blocking query — the agent holds the request open |
| `Redis` | keyspace notifications |
| `Etcd` | a watch stream, re-read at the event's own revision |
| `Nats` | a JetStream watch |

The loop runs on a thread of its own and reaches the event loop only to
deliver, so a program that watches is not structured around watching.

**The other four have no `watch`, and that is not a gap.** Vault, S3,
Firestore and git are *polled* by their Rust watch loops too — a version
counter, an ETag, an update time, a commit — so
`setInterval(() => installed.refresh(), 30_000)` is the same thing with
one fewer thread, and it is a line you can read.

A store watch hands you a **document**; `useStore` is what puts one into a
configuration. Keeping those apart is what lets a caller log a change, or
refuse it, without the engine having already acted on it.
