# Node.js Bindings

`dynamic-config-node` on npm pairs this engine with the schema you already
write: **Rust resolves, your schema validates, JavaScript reads a cached
object.**

```sh
npm install dynamic-config-node
```

```ts
import { DynamicConfig, zodValidator } from "dynamic-config-node"
import { z } from "zod"

const Database = z.object({ host: z.string(), port: z.number().default(5432) })

const db = await new DynamicConfig({ key: "db", validate: zodValidator(Database) })
  .file("config.toml")
  .env("APP_")
  .initAndCurrent()
//    ^? { host: string; port: number }
```

One prebuilt binary per platform, through Node-API — which is ABI-stable,
so the same binary serves Node 18, 20, 22 and whatever comes next. Nothing
compiles at install time and nothing but the engine is a dependency.

## What a schema is here

A **function**. It takes the resolved document and answers the value your
program reads, or throws. That is the whole contract, and it is why no
schema library is a dependency of this package:

| You use | You write |
|---|---|
| [Zod](https://zod.dev) | `validate: zodValidator(Schema)` |
| [Ajv](https://ajv.js.org) / TypeBox | `validate: ajvValidator(compiled)` |
| Neither | `validate: (document) => { … }` — a function of your own |
| Nothing | omit `validate`; the document *is* the value, read by dotted path |

[Schemas](schemas.md) has each of them, and what changes between them.

## What the engine does

Everything the Rust crate does with sources, unchanged: files merge in
call order, the environment beats them, `.env` sits just below the real
environment, a secrets directory beats a remote store, profiles select,
discovery searches a path, and two runtime layers bracket the rest.
[Sources & Precedence](https://ctolon.github.io/dynamic-config/sources-and-precedence.html)
is the chapter; the order is the same in all three languages.

```ts
await config
  .setDefault("pool.maxSize", 8)     // a fallback the program computes
  .discover("app", ["/etc/app", "."])
  .file("config.toml")
  .file("secrets.toml")              // merges over the first, key by key
  .secretsDir("/run/secrets")        // a Docker or Kubernetes mount
  .envFile(".env")
  .env("APP_")
  .init()
```

## Reading is a property read

`current()` returns a cached object. Validation runs once per successful
resolve, never per read, so reading configuration on every request costs
what reading a field costs — which is what makes *read it per request*
the advice rather than *copy it at boot*.

```ts
app.get("/", (request, response) => {
  const { rateLimit } = config.current()   // always the document in force
  …
})
```

## The property the design is for

**A document the schema refuses installs nothing.** A file edited into
something invalid leaves the previous document serving and reports the
failure — from the watcher exactly as from an explicit `reload()`. That is
what makes it safe to leave a watcher running in production, and it is the
first thing [Watching & Hooks](watching.md) demonstrates.

## Where the parts live

| | |
|---|---|
| Every method, every argument | [API Reference](reference.md) |
| Zod, Ajv, plain functions, no schema | [Schemas](schemas.md) |
| The watcher, `onReload`, `onChange` | [Watching & Hooks](watching.md) |
| Express, Fastify, NestJS, Next.js, React | [Web Frameworks](frameworks.md) |
| A store written in JavaScript, and the eight Rust ones | [Remote Stores](remote-stores.md) |
| What crosses the boundary, and how often | [Implementation Details](internals.md) |
| What it will not do, and why | [Limitations](limitations.md) |

The engine's own behaviour — precedence, profiles, discovery, the
last-known-good cache, encryption, the document shape rules — is the
[Rust book](https://ctolon.github.io/dynamic-config/), because it is the
same engine and describing it twice is how two descriptions drift.
