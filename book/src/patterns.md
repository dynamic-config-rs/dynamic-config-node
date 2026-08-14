# Patterns & Style

What using this well looks like from Node, and the mistakes that read
fine. The Rust book's [Patterns & Style](https://ctolon.github.io/dynamic-config/patterns.html)
covers the ones about the engine; these are the ones about an event loop.

## Read `current()` where you use it — never at boot

```ts
app.get("/", (request, response) => {
  const { rateLimit } = config.current()    // here
  ...
})
```

Not `app.locals.config = config.current()`, not a module-level
`const CONFIG = config.current()`. Both copy the document that was in
force at startup, and every later reload lands somewhere nobody reads.
`current()` is a property read on a cached object — cheaper than the
closure you would write to avoid it.

**Per framework**, the same rule wearing three hats: an Express handler
reads it, a Fastify decorator holds the *object*, a Nest provider injects
the *object*. [Web Frameworks](frameworks.md) has each.

## One configuration per subsystem

```ts
const db = new DynamicConfig({ key: "db", validate: zodValidator(Database) })
const flags = new DynamicConfig({ key: "flags" })   // no schema: product keys
```

Three sections in one file are three objects here, and they fail
independently: a flags section somebody broke leaves the database's
document serving.

## `await init()` in `main`, not at module scope

```ts
async function main() {
  await config.file("config.toml").env("APP_").init()

  app.listen(3000)
}

void main()
```

Every load is asynchronous — [why](internals.md#the-thread-rule-and-why-every-load-is-async) —
so a module that wants configuration at import time wants top-level
`await` (ESM) or a factory that returns a promise. A Nest `useFactory` and
a Next.js server component are both already `async`, which is why those
examples read as they do.

## `changes()` for work, `onReload` for a note

```ts
for await (const document of config.changes()) {
  await pool.resize(document.pool.maxSize)      // an await is fine here
}

config.onReload((document) => log.info({ generation: config.generation }))
```

A hook runs when the document installs, and anything slow in it holds the
next reload. `changes()` yields on the loop *after* the install, so an
`await` in the loop costs the caller and nobody else. Break out of the
loop and the subscription is removed for you.

## Validate with what the program already has

Zod if you use Zod, Ajv if you use JSON Schema, a function if you use
neither, nothing at all if the keys are a product decision. The generic
parameter follows whatever the validator returns, so `current()` is your
type with nothing cast. [Schemas](schemas.md).

## Testing

```ts
const answer = await config.overrides({ rateLimit: 1 }, async () => {
  return await somethingThatReads()
})
```

No filesystem, no environment, and it restores what it found. Two more
doors: `load()` resolves and validates a candidate without installing it,
and `replace(document)` hands the configuration over directly — for the
test that does not want a file at all, and for configuration that came
from somewhere this library does not know about.

## Health, and what to do about a failure

```ts
app.get("/healthz", (_request, response) => {
  const status = config.status()

  response.status(status.consecutiveFailures === 0 ? 200 : 503).json(status)
})
```

A failed reload is *recorded*, and recorded means somebody has to look.
Two numbers matter: `consecutiveFailures`, and how old the serving
document is (`snapshot().loadedAtAgoMs`). A store that is briefly
unreachable should not be a startup gate — that is what the last-known-good
cache is for.

## TypeScript

- **Give the generic parameter**: `new DynamicConfig<Database>({...})`, or
  let a validator that returns `Database` infer it. `unknown` at the call
  site means the parameter was lost somewhere.
- **`tryCurrent()` at a boundary** where the configuration may not be
  installed yet: it is `T | undefined`, which is what `strict` wants.
- **`get<V>(path, fallback)`** names the type it expects, so a schemaless
  read is not `any` by accident.

## Shutting down

```ts
config.stopWatching()
```

Not required for a process to exit — nothing here keeps the event loop
alive — but it is what a test wants between cases, and what a long-lived
worker wants when it hands its configuration back.
