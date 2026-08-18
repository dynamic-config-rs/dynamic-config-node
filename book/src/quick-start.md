# Quick Start

```sh
npm install dynamic-config-node
```

```js
const { DynamicConfig, zodValidator } = require("dynamic-config-node");
const { z } = require("zod");

const Database = z.object({
  host: z.string().default("localhost"),
  port: z.number().int().default(5432),
});

async function main() {
  const config = await new DynamicConfig({
    key: "db",
    validate: zodValidator(Database),
  })
    .file("config.toml")     // later sources win
    .env("APP_")             // APP_DB_PORT=5433 overrides the file
    .init();                 // load once, fail fast on a bad document

  config.watch({ debounceMs: 250 });   // reload on file changes

  setInterval(() => {
    const db = config.current();       // one read, no I/O, never blocks the loop
    console.log(`${db.host}:${db.port}`);
  }, 2000);
}

main();
```

Five things happened, and they are the whole model:

1. **Your schema validates.** Zod here; Ajv and plain functions work the
   same seam — [Schemas](schemas.md) is the chapter.
2. **Sources layer, later wins** — the same precedence chain as every
   other `dynamic-config` binding.
3. **`init()` fails fast**: a broken document stops startup, not the
   first request an hour later.
4. **The watcher never blocks the loop.** File watching and parsing are
   Rust threads; only the installed document crosses into JavaScript.
5. **`current()` is the read.** Synchronous, cheap, no I/O — call it
   where you use the value, and reloads reach you for free.

Edit `config.toml` while it runs and watch the line move. A bad edit
changes nothing: the engine keeps the last good document, and
`setLogger` routes its diagnostics wherever you want them.

From here: [Watching](watching.md) for the reload lifecycle,
[Frameworks](frameworks.md) for Express and Fastify, and
[Telemetry & Health](telemetry.md) for `/readyz` and metrics.
