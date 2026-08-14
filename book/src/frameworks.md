# Web Frameworks

One rule covers all of them: **hold the configuration object, read
`current()` where you need a value.** A framework that reads configuration
once at boot is a framework whose configuration has stopped changing, and
`current()` is a property read — reading it per request costs nothing.

## Express

```ts
const app = express()

app.get("/", (request, response) => {
  const { greeting, rateLimit } = config.current()   // here, not at boot

  response.json({ greeting, rateLimit })
})

app.get("/healthz", (_request, response) => {
  const status = config.status()

  response.status(status.consecutiveFailures === 0 ? 200 : 503).json(status)
})
```

Deliberately **not** `app.locals.config = config.current()`: that copies
the document that was in force at boot, and every later reload lands
somewhere nobody reads. `examples/07-express.mjs` runs it.

## Fastify

```ts
app.decorate("config", config)

app.get("/", async (request) => request.server.config.current())
```

The *object* goes on the instance, not its values. A Fastify plugin's
options are read once when the plugin registers, which is exactly the
mistake above wearing a different hat. `examples/08-fastify.mjs`.

## NestJS

```ts
export const databaseConfigProvider = {
  provide: DATABASE_CONFIG,
  useFactory: async (): Promise<DynamicConfig<Database>> => {
    const config = new DynamicConfig<Database>({ key: "db", validate })

    await config.file("config.toml").env("APP_").init()
    config.watch({ debounceMs: 250 })

    return config
  },
}
```

`useFactory` is `async`, which is what `init()` is — so the application
does not start until the configuration has loaded *and validated*, and a
broken file is a startup failure with a message rather than a service that
answers wrongly. Inject the configuration object; injecting
`config.current()` would inject the document from application start and
freeze it there. `examples/10-nestjs/`.

## Next.js, and the browser

**There is no configuration engine in the browser.** No filesystem, no
watcher, no store. What ships to a client is a snapshot the server chose
to send it, and choosing *which fields* is a security question:

```ts
export function publicHalf(config: AppConfig): PublicConfig {
  return { siteName: config.siteName, features: { newCheckout: config.features.newCheckout } }
}
```

An allow-list, written out field by field — not `omit(secrets)`. A
deny-list is a list somebody forgets to add to, and the field they forget
is the one that matters.

One instance per server process, parked on `globalThis` so a development
hot reload does not start a watcher per module evaluation.
`examples/11-nextjs/` and `examples/12-react/`.

**Live updates in the browser** are a different feature, and this package
does not pretend to have it. The shape is: the server subscribes with
`onChange` and pushes the public half down whatever channel you already
have. The engine stays where the files are.
