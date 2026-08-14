# Implementation Details

What crosses the boundary, how often, and the three decisions that shaped
it. None of this is needed to use the binding; it is here because the
answers are unusual enough to be worth writing down.

## The thread rule, and why every load is async

Node's rule is that only the event loop may touch a JavaScript value. The
engine's rule is that validation happens *inside* the load, before
anything installs — which is what makes a rejected edit change nothing.

The two meet like this: **the load runs on a worker thread** (libuv's
pool, or the file watcher's own), and when it reaches the validate hook it
hands the resolved document to the loop through a `ThreadsafeFunction` and
blocks until the answer comes back.

Blocking a worker on the loop is safe in exactly one direction. It is why
there is **no `initSync`**: a synchronous `init()` would be the loop
thread waiting for itself, which is a deadlock at startup — the worst
place to put one.

## Nothing is thrown across the boundary

Node-API cannot attach fields to a rejection raised on a worker thread:
the `Env` a rich error object needs does not exist there. So the compiled
half never throws. Every fallible call answers

```
{ ok: true, value }   |   { ok: false, error: { kind, path, originKind, origin, message } }
```

and the JavaScript facade turns the second into a `DynamicConfigError`
with those fields on it. The union never reaches a caller — it is the wire
between two halves of one package, and the alternative is the bare `Error`
whose only structured part is its message that Node libraries usually
ship.

## No JavaScript reference is held by Rust

A Python validator returns an *instance*, and the Python binding holds it.
A JavaScript validator returns a plain object, so what is held here is a
`serde_json::Value` — and nothing in the compiled half owns a JavaScript
reference past a call.

That is what lets the watcher thread install a document while the loop is
asleep: there is no handle for it to have taken. The **facade** caches the
converted object, so `current()` is a property read rather than a
conversion.

## What a read costs

| Call | Cost |
|---|---|
| `current()` | a property read on a cached object |
| `get("a.b")` | that, plus one walk of the path |
| `generation` | one call into the addon, one atomic load |
| `init` / `reload` / `refreshRemote` | a worker thread, and one call into the loop per validation |

A configuration is read on every request and reloaded rarely, which is
why the split falls where it does.

## The two versions

```ts
packageVersion()   // this npm package
engineVersion()    // the Rust crate it was built against
```

They move on two schedules: the package embeds the engine rather than
depending on a published version of it, so a Rust-only release has nothing
in it for a Node user.

## Node-API, not a per-version build

The addon is compiled against Node-API, which is ABI-stable: one prebuilt
binary per platform serves Node 18, 20, 22 and whatever comes next — the
way an abi3 wheel serves CPython 3.9 upwards. Nothing compiles at install
time. CI still runs the suite on every version the package claims, because
"ABI-stable" is a claim about the addon and the JavaScript half is
ordinary code that a version can break.
