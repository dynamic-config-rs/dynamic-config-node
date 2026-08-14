# dynamic-config-node

Hot-reloadable configuration for Node.js: **Rust resolves, your schema
validates, JavaScript reads a cached object.**

> The package is `dynamic-config-node`: `dynamic-config` on npm belongs to
> an unrelated package by another author. Same answer as
> `dynamic-config-py` on PyPI, and the import is the package name.

```sh
npm install dynamic-config-node
```

```ts
import { DynamicConfig, zodValidator } from "dynamic-config-node"
import { z } from "zod"

const Database = z.object({ host: z.string(), port: z.number().default(5432) })

const config = new DynamicConfig({ key: "db", validate: zodValidator(Database) })

const db = await config.file("config.toml").env("APP_").initAndCurrent()
//    ^? { host: string; port: number }
```

The engine is the [`dynamic-config`] Rust crate — files, environment
layering, `.env`, profiles, discovery, precedence, a debounced file
watcher, last-known-good recovery and provenance. The schema is whatever
your program already uses: **a validator here is a function**, so Zod's
`parse` is one, an Ajv validator becomes one in four lines, and a plain
function of your own is one too. Nothing is a dependency of this package
except the engine, which is compiled into it.

**Validation runs once per successful resolve, never per read.**
`current()` is a property read on a cached object, so reading configuration
on every request costs nothing.

## What it gives you

```ts
await config.init()                    // load, validate, install
await config.reload()                  // again, on demand
config.watch({ debounceMs: 250 })      // and again on every file change
config.current()                       // the document in force
config.get("pool.maxSize", 8)          // …or one value, by dotted path

config.onReload((document) => …)       // every install
config.onChange("pool.maxSize", …)     // one path, when it moves
for await (const doc of config.changes()) …   // …or as an async iterator

config.setDefaults({ pool: { maxSize: 8 } })  // a whole object as defaults
config.replace(document)                      // install one directly, no sources

config.sourceOf("port")                // which layer wins, and from where
config.isSet("port")
config.explain("port")                 // every layer's answer, as a table
config.check()                         // would it load? any unknown keys?
config.snapshot()                      // the document, and how old it is
config.status()                        // for a health endpoint
```

**A rejected document changes nothing.** A file edited into something the
schema refuses leaves the previous document serving and reports the
failure; that is the property the whole design is for, and it holds for a
watcher-driven reload exactly as it does for an explicit one.

## Errors carry what a program branches on

```ts
try {
  await config.init()
} catch (failure) {
  if (failure instanceof DynamicConfigError) {
    failure.kind        // "io" | "parse" | "missing" | "invalid" | "remote" | …
    failure.path        // the dotted key path
    failure.originKind  // "file" | "env" | "remote" | …
    failure.origin      // the file, the variable, the store
  }
}
```

The same words the Rust `ErrorKind` and the Python exception hierarchy
use, so the same condition is called the same thing in all three.

## Remote stores

A store is a function that answers `{ text, format }`:

```ts
config.setRemote(() => latest, "our config service")
await config.refreshRemote()   // fill the remote layer
await config.reload()          // resolve and validate it
config.remoteStatus()          // reachable, fetches, failures
```

It must be **synchronous** — it is called from a worker thread through the
event loop, and a promise cannot be awaited from there. An async source
keeps its own last answer:

```ts
let latest = { text: "{}", format: "json" as const }
setInterval(async () => { latest = await read() }, 30_000)
config.setRemote(() => latest, "our config service")
```

The eight Rust stores — etcd, Consul, Vault, NATS, Redis, S3, Firestore,
git — are **not in this package**, for the reason they are a second wheel
in Python: a gRPC stack and an AWS SDK in every `npm install` is not a
default. They are a second package:

```sh
npm install dynamic-config-node dynamic-config-node-remote
```

```ts
import { Etcd, useStore } from "dynamic-config-node-remote"

const installed = await useStore(config, new Etcd(["http://etcd:2379"], "myapp/db.json"))
await installed.refresh()   // later: a timer, a signal, a webhook
```

## Two things this binding deliberately does not have

**`initSync`.** Every load is asynchronous, and that is not a style
choice: validation happens *inside* the load, before anything installs,
which means the load runs on a worker thread and calls back into the event
loop. A synchronous `init()` would be the loop waiting for itself — a
deadlock at startup, which is the worst place to put one. Use top-level
`await`, or `await config.init()` in your `main`.

**A configuration engine in the browser.** There is no filesystem, no
watcher and no store there. What ships to a client is a snapshot somebody
chose to send it, which is a serialisation decision rather than a
configuration one.

## Versions

Two numbers, because they move on two schedules: `packageVersion()` is
this package's, and `engineVersion()` is the Rust crate it was built
against.

## The book

[**dynamic-config for Node.js**](https://ctolon.github.io/dynamic-config/node/)
— the API reference, schemas, watching, the frameworks, the remote stores,
what crosses the boundary and what this binding will not do.

The engine's own behaviour — precedence, profiles, discovery, the
last-known-good cache, the document-shape rules — is the
[Rust book](https://ctolon.github.io/dynamic-config/), because it is the
same engine.

## Examples

Twelve, in [`examples/`](https://github.com/ctolon/dynamic-config/tree/main/dynamic-config-node/examples): a quick start, layering, watching,
diagnostics, Express, Fastify, Zod/Ajv/no-schema side by side, a NestJS
provider, Next.js server components, and the React one that draws the
browser boundary rather than pretending there is none. The runnable ones
run in CI on every Node version this package claims; the TypeScript ones
are typechecked there.

## Supported platforms

| | x64 | arm64 |
|---|---|---|
| Linux (glibc) | ✅ | ✅ |
| macOS | ✅ | ✅ |
| Windows | ✅ | — |

One prebuilt binary per platform, installed as an optional dependency — so
`npm install` downloads one, not five, and compiles nothing.

| Node | Status |
|---|---|
| 18 (the floor), 20, 22, 24 | tested in CI, every commit |
| 26 and later | expected to work — Node-API is ABI-stable; a row is added when it ships |
| 16 and older | not supported; `engines.node` refuses |

The matrix exists even though the ABI is stable, because that is a claim
about the *addon*: the JavaScript half is ordinary code that a version can
break. musl (Alpine) is not among the platforms — the addon links glibc.
Raising the floor is treated as a breaking change. The full table is in
[Stability & Production Use](https://ctolon.github.io/dynamic-config/node/stability.html).

[`dynamic-config`]: https://crates.io/crates/dynamic-config
