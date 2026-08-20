<div align="center">

# dynamic-config-node

**Hot-reloadable configuration for Node.js: Rust resolves, your schema validates.**

[![CI](https://github.com/dynamic-config-rs/dynamic-config-node/actions/workflows/ci.yml/badge.svg?event=pull_request)](https://github.com/dynamic-config-rs/dynamic-config-node/actions/workflows/ci.yml)
[![Security](https://github.com/dynamic-config-rs/dynamic-config-node/actions/workflows/security.yml/badge.svg?event=pull_request)](https://github.com/dynamic-config-rs/dynamic-config-node/actions/workflows/security.yml)
[![npm](https://img.shields.io/npm/v/dynamic-config-node.svg)](https://www.npmjs.com/package/dynamic-config-node)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[**The Book**](https://dynamic-config-rs.github.io/node/) · [The engine](https://github.com/dynamic-config-rs/dynamic-config) · [npm](https://www.npmjs.com/package/dynamic-config-node)

</div>

---

```sh
npm install dynamic-config-node                 # the engine, prebuilt per platform
npm install dynamic-config-node-remote          # + the eight Rust stores
```

```ts
import { DynamicConfig, zodValidator } from "dynamic-config-node"
import { z } from "zod"

const Database = z.object({ host: z.string(), port: z.number() })

const db = await new DynamicConfig({ key: "db", validate: zodValidator(Database) })
  .file("config.toml")
  .env("APP_")
  .init()

db.current().host        // typed, cached, no lock
```

**A validator is a function**, so Zod, Ajv or one you wrote yourself all
work and none of them is a dependency of this package.
`DynamicConfig<T>` is generic over whatever the validator returns, so
`current()` is `T` under `strict: true` with nothing cast.

**The load runs on a worker thread** and reaches the event loop only to
validate and to fire hooks. That is what keeps the property this design is
for: a document the schema refuses installs nothing and leaves the
previous one serving — from the watcher exactly as from an explicit
reload. It is also why there is no `initSync`.

## Two packages, one version

| Package | What | Where |
|---|---|---|
| [`dynamic-config-node`](dynamic-config-node) | the engine, through Node-API | [npm](https://www.npmjs.com/package/dynamic-config-node) |
| [`dynamic-config-node-remote`](dynamic-config-node-remote) | etcd, Consul, Vault, NATS, Redis, S3, Firestore, git | [npm](https://www.npmjs.com/package/dynamic-config-node-remote) |

**The name on npm is `dynamic-config-node`**, because `dynamic-config`
belongs to an unrelated package by another author.

**Five platforms, prebuilt.** Each package publishes one binary per
platform as an optional dependency — linux x64/arm64 (glibc), macOS
x64/arm64, Windows x64 — so an install downloads one addon rather than
compiling anything. A platform whose build failed is a platform the
release does not ship, rather than a wrapper pointing at a package nobody
uploaded.

## The engine is a dependency, not a sibling

These crates name it with a caret (`dynamic-config = "0.7"`), so an engine
patch release reaches them with no release here. The packages version on
their own schedule.

## Supported runtimes

| | |
|---|---|
| Node.js | 18, 20, 22, 24 — tested on each |
| ABI | Node-API 6; the addon is not rebuilt per Node release |
| MSRV (to build from source) | 1.88, both packages |

Raising either floor is a breaking change.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md). `just check` needs Node 18+ and
nothing else; TypeScript is optional and the gate says so when it is
absent.

What you may build on and find unchanged tomorrow is written down: the [Compatibility Contract](https://dynamic-config-rs.github.io/compatibility.html).

## License

[MIT](LICENSE).
