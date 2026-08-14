# Schemas

A schema here is a **function**: it takes the resolved document and
answers the value your program reads, or throws. Everything below is that
one sentence, applied.

## Zod

```ts
import { DynamicConfig, zodValidator } from "dynamic-config-node"
import { z } from "zod"

const Database = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535).default(5432),
})

const config = new DynamicConfig({
  key: "db",
  validate: zodValidator(Database),
  fields: Object.keys(Database.shape),
})
```

`zodValidator` is four lines in this package — `(document) => schema.parse(document)`
— and Zod is not a dependency. A document Zod refuses installs nothing,
and the message the failure carries is **Zod's own**: a schema library
says *why* better than a configuration loader could.

`fields` is worth passing. It is what `check()` compares a file's keys
against, so `hsot = "..."` is reported as an unknown key rather than
silently ignored.

## Ajv, TypeBox and JSON Schema

```ts
import { DynamicConfig, ajvValidator } from "dynamic-config-node"
import Ajv from "ajv"

const validate = new Ajv().compile({
  type: "object",
  properties: { host: { type: "string" }, port: { type: "integer" } },
  required: ["host"],
})

const config = new DynamicConfig({ key: "db", validate: ajvValidator(validate) })
```

Ajv's validator answers `false` and keeps the reason on itself, which is a
different shape from throwing — `ajvValidator` is the adapter for that,
and it renders every issue into the message.

## A function of your own

```ts
const config = new DynamicConfig<Database>({
  key: "db",
  validate: (document): Database => {
    const record = document as Record<string, unknown>

    if (typeof record.host !== "string") {
      throw new Error("host must be a string")
    }

    return { host: record.host, port: Number(record.port ?? 5432) }
  },
})
```

The generic parameter is what makes `current()` worth having: it is
`Database`, not `unknown`, with nothing cast at the call site.

**Whatever the validator returns is what installs.** It may coerce, fill
defaults and rename — the engine stores what it answered, and every later
`current()` hands back that.

What it may not do is return something JSON cannot carry. The answer
crosses back into Rust to be stored, so a class instance arrives as a
plain object with its prototype gone and a `Date` arrives as `{}`. See
[what a validator may not be](limitations.md#what-a-validator-may-not-be);
the short version is to return plain data and construct whatever the
program wants at the read.

## No schema at all

Omit `validate` and the document *is* the value, read by dotted path —
the shape a plugin host, a feature-flag table or a tool reading somebody
else's file wants:

```ts
const flags = new DynamicConfig({ key: "flags" })

await flags.file("flags.toml").init()

flags.get("checkout.newFlow")        // by path
flags.get("checkout.ttl", 60)        // …with a fallback
flags.current()                      // or the whole object
```

Two answers change, and both are reported rather than assumed:

| | A declared schema | No schema |
|---|---|---|
| `check()` unknown keys | compared against `fields` | nothing to compare — `unknownChecked` is `false` |
| Secrets | `secrets: [...]` says which paths | the same, and there is no other way to say it |

A `redacted` or `fingerprint` cache is **refused** for a configuration
that never said what is secret, rather than writing a file that claims a
redaction it did not perform.

## What a schema does *not* do here

It does not choose the sources, and it does not run per read. Validation
happens inside the load — before anything installs — which is what makes
a refusal leave the previous document serving. That ordering is the whole
reason the binding is built the way [Implementation Details](internals.md)
describes.
