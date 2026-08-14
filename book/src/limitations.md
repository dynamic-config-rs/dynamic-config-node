# Limitations

What this binding does not do, and why each one is a decision rather than
a gap.

## No `initSync`

Validation happens inside the load, so the load runs on a worker thread
and calls back into the event loop. A synchronous `init()` would be the
loop waiting for itself.

Use top-level `await` in an ESM module, or `await config.init()` in your
`main`. A configuration that must exist before anything else — a Nest
provider, a Next.js module — has an `async` door already:
`useFactory` is `async`, and a server component is.

## No configuration engine in the browser

No filesystem, no watcher, no store, and a bundler cannot polyfill any of
them. What ships to a client is a snapshot the server chose to send.
[Web Frameworks](frameworks.md) draws the line and
`examples/12-react/README.md` writes it out.

## The eight Rust stores are a second package

etcd, Consul, Vault, NATS, Redis, S3, Firestore and git each carry a
client — gRPC, an AWS SDK, three HTTP stacks — and putting them in every
`npm install dynamic-config-node` is not a default anybody asked for. Same
reasoning as the second wheel in Python.

A store this package does not ship is still a function away:
[Remote Stores](remote-stores.md).

## A remote fetch is synchronous

`setRemote` takes a function that answers `{ text, format }`, not a
promise. It is called from a worker thread through the loop, and awaiting
from there is not possible. An async source keeps its own last answer;
the pattern is three lines and it is in the chapter.

## Encrypted files are not exposed

Decryption needs a `Decryptor`, which is a Rust trait. Decrypt with the
[CLI](https://ctolon.github.io/dynamic-config/cli.html) and point this at
the result. The Python binding draws the same line for the same reason.

## `save` and JSON Schema export are not exposed

The Rust crate can write a configuration back and export a JSON Schema
from a type. Neither has an obvious Node shape — a schema here is a
*function*, so there is nothing to export from — and both are one CLI
invocation away.

## What a validator may not be

**Asynchronous.** A validator is called inside the load, on a worker
thread, and a promise cannot be awaited there. Every schema library's
synchronous door — Zod's `parse`, Ajv's compiled validator — is what this
takes. If a check genuinely needs I/O, it is not validation: do it after
`init()` and refuse to start.

**A class instance, or anything else JSON cannot carry.** What a validator
returns crosses back into Rust to be stored, so it is serialised: the
document `current()` hands back is a plain object with the same *data* and
none of the identity. A class loses its prototype — `instanceof` is
`false`, methods and getters are gone. A `Date` is worse than a string: it
serialises to `{}`, because it has no fields.

```ts
class Database { constructor(host) { this.host = host } get shouty() { … } }

validate: (document) => new Database(document.host)

config.current() instanceof Database   // false
config.current().shouty                // undefined
```

Return plain data — objects, arrays, strings, numbers, booleans, `null` —
and keep the behaviour outside the configuration, where a reload does not
have to rebuild it. Zod is fine as long as the schema is: `z.date()` and
`z.map()` produce values with the same problem, and `z.coerce.string()` or
an ISO string in the document is the shape that survives. A wrapper the
program wants is one line at the read: `new Database(config.current())`.
