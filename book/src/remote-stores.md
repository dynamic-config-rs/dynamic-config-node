# Remote Stores

A store is a **function that answers `{ text, format }`**:

```ts
config.setRemote(() => ({ text: latestJson, format: "json" }), "our config service")

await config.refreshRemote()   // fill the remote layer
await config.reload()          // resolve and validate it
```

Two steps rather than one, and deliberately: a fetch fills a layer, and a
reload is what resolves every layer and validates the result. The same
split `refresh_remote()` and a reload are in Rust, for the same reason —
a store answering is not the same event as a configuration installing.

## Where it sits

Above the files, below the environment: what a central store distributes
should beat what a package shipped, and lose to a variable exported for
this one run. A mounted secret (`secretsDir`) beats it too, for the same
argument — it is a fact about *this* deployment.

## The fetch must be synchronous

It is called from a worker thread through the event loop, and a promise
cannot be awaited from there. An async source keeps its own last answer
and hands that over:

```ts
let latest = { text: "{}", format: "json" as const }

setInterval(async () => {
  latest = { text: await readFromService(), format: "json" }
}, 30_000)

config.setRemote(() => latest, "our config service")
```

That is not a limitation being worked around: a configuration read should
not block on a network call it did not schedule, which is why the Rust
crate makes `refresh_remote()` explicit as well.

## What the status says

```ts
config.remoteStatus()
// { reachable: true, fetches: 3, consecutiveFailures: 0, lastFailure: null }
```

`reachable` is three-valued, and the third is the point: `null` before
anything has been asked of the store at all. A source that has been
installed and never fetched is not *down* — reporting it as down is how a
scrape at startup pages somebody.

A fetch that fails leaves the last good document serving and moves
`consecutiveFailures`; nothing is torn down.

## The eight Rust stores

etcd, Consul, Vault, NATS, Redis, S3, Firestore and git are **not in this
package** — a gRPC stack, an AWS SDK and three HTTP clients in every
`npm install dynamic-config-node` is not a default anybody asked for. They are
a second one:

```sh
npm install dynamic-config-node-remote
```

```ts
import { Etcd, useStore } from "dynamic-config-node-remote"

const store = new Etcd(["http://etcd:2379"], "myapp/db.json")
const installed = await useStore(config, store)

await installed.refresh()   // later: a timer, a signal, a webhook
```

Each store is a class with the same two methods this chapter started with
— an async `fetch()` answering `{ text, format }`, and `describe()` — so a
store from that package is indistinguishable from one you wrote. What
`useStore` adds is the bridge: **`fetch()` is async** because a round trip
must not sit on the loop, and the engine's remote layer is filled from a
worker thread and must be handed a synchronous answer, so the last one is
kept.

| Store | Constructed with |
|---|---|
| `Consul` | `address`, one of `key`/`keys`/`prefix`, `format?`, `token?`, `timeoutMs?` |
| `Vault` | `address`, `mount`, `path`/`paths`, `token?`, `timeoutMs?` |
| `Redis` | `url` (the credential rides in it), `key`/`keys`/`prefix`, `format?` |
| `Etcd` | `endpoints[]`, `key`/`keys`/`prefix`, `format?`, `username?`, `password?` |
| `Nats` | `server`, `bucket`, `key`/`keys`, `format?` |
| `S3` | `bucket`, `key`/`keys`/`prefix`, `format?` — credentials from the environment |
| `Firestore` | `project`, `path`/`paths`, `accessToken?` |
| `Git` | `url`, `path`/`paths`/`prefix`, one of `branch`/`tag`/`commit`, `format?`, `token?` |

**A description never carries a credential**: a Redis URL with a password
in it and a git URL with a token are both redacted by the store crates'
own rule, so an error message is safe to log.

### A credential may be a function

A string is right for a token an operator pasted into a deployment, and
wrong for one that rotates — a projected service-account token, a Vault
lease, a Google access token that lives an hour. So `tokenFn` (and
Firestore's `accessTokenFn`) is called **on the event loop before each
fetch**, which is where your `readFileSync`, your cloud SDK and your own
cache live:

```ts
new Vault("https://vault:8200", "secret", "myapp/db", null, null, null,
  () => readFileSync("/var/run/secrets/vault-token", "utf8"))
```

### TLS, as files or as bytes

```ts
new Consul(address, key, null, null, null, null, null, {
  caCertificateFile: "/etc/ssl/private-ca.pem",
  clientCertificateFile: "/etc/ssl/app.crt",
  clientKeyFile: "/etc/ssl/app.key",
})
```

Both shapes, because both are real: a Kubernetes secret is a mounted file
and a certificate fetched at startup is bytes. Saying nothing means the
platform's trust store, not *no TLS*.

### Watching a store

Four of them push, and those can be watched:

```ts
const handle = store.watch(
  (document) => console.log("the store moved", document),
  (failure) => console.error("the watch ended", failure.error),
)

handle.stop()
```

| Store | How it notices |
|---|---|
| `Consul` | a blocking query — the agent holds the request open |
| `Redis` | keyspace notifications |
| `Etcd` | a watch stream, re-read at the event's own revision |
| `Nats` | a JetStream watch |

The loop is a thread of its own and reaches the event loop only to
deliver, exactly as the file watcher does.

**Vault, S3, Firestore and git have no `watch`, and that is not a gap**:
their Rust watch loops *poll* — a version counter, an ETag, an update
time, a commit — so `setInterval(() => installed.refresh(), 30_000)` is
the same thing with one fewer thread, and it is a line you can read.

A store watch hands you a **document**; `useStore` is what installs one.
Keeping those apart is what lets a caller log a change, or refuse it,
before the engine has acted on it.
