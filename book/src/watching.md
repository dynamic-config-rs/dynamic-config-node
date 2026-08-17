# Watching & Hooks

```ts
config.watch({ debounceMs: 250 })
```

Every file this configuration reads is watched. An edit reloads it — on
the watcher's own thread, so the program is not structured around
watching — and the new document is installed only if the schema accepts
it.

## A rejected edit changes nothing

This is the property the whole design is for, and it holds identically for
a watcher-driven reload and an explicit one:

```ts
config.onReload((document) => console.log("installed", document))

// A file edited into something the schema refuses:
//   - installs nothing
//   - fires no hook
//   - leaves `current()` answering the last good document
//   - moves `status().consecutiveFailures`
```

Anything can re-read a file. What makes hot reload safe to leave running
in production is that a bad edit is a *failed attempt* rather than a
half-configured process.

## Three kinds of hook

```ts
const token = config.onReload((document) => …)       // every install
config.onChange("pool.maxSize", (now, before) => …)  // one path, when it moves
config.onReloadAsync(async (document) => …)          // and one that awaits
config.removeHook(token)
```

`onReload` fires once per install, on the event loop — the reload happened
on another thread, and the hook is queued to the loop the way any Node
callback is. `onChange` is the same subscription with a comparison in
front of it: it fires when the value at that path differs, and hands over
both values.

**After `await config.reload()`, your hooks have run.** The install
happens on a worker thread and the hooks are queued for the loop, so the
explicit paths wait one turn of the loop before returning — otherwise
`await reload()` would mean *the document is installed* but not *your hook
has seen it*, which are two things a caller has every right to think are
one.

A watcher-driven reload has no `await` to hang that on: its hooks fire
whenever the loop next breathes, which is what a watcher is.

## A hook that awaits

`onReload` takes a function and ignores what it returns, so an `async` one
handed to it leaves a promise nobody awaits: two installs in quick
succession run their bodies interleaved, and a rejection becomes an
unhandled one. `onReloadAsync` is the same subscription with those two
things handled:

```ts
config.onReloadAsync(async (document, { signal }) => {
  await pool.resize(document.pool.maxSize, { signal })
})
```

| `backpressure` | When an install lands while the hook is still running |
|---|---|
| `"latest"` | Keep the newest and drop what it overtook. The default. |
| `"serial"` | Queue every one and run them in order, dropping nothing. |
| `"every"` | Start each as it arrives — `onReload`, with the rejection still caught. |

`"latest"` is the default because it is what configuration usually means:
resizing a pool to a size nobody is asking for any more is work done for
nothing. `"serial"` is for a hook that is an audit trail rather than a
reconciliation, where a gap is a broken audit trail.

Nothing can cancel a promise in JavaScript, so what a superseded call gets
under `"latest"` is the `signal` — aborted the moment a newer install
takes its place, and passable straight to `fetch` or to a query that knows
what to do with one.

A rejection is reported rather than thrown: `console.error` by default, or
`onError` if a program has somewhere better to put it. A configuration
hook is not the place to end a process.

## The diagnostic stream

`changes()` is the document stream a service loop wants; `events()` is the
one a log line, a metric or an alert is built from:

```ts
for await (const event of config.events({ failurePollMs: 1_000 })) {
  if (event.type === "reloadFailed" && event.consecutive > 3) {
    alert(`configuration refused at ${event.path}: ${event.kind}`)
  } else if (event.type === "reloaded") {
    log.info("config %d: %s", event.generation, event.changed.join(", "))
  }
}
```

**No event carries a value.** Paths, kinds, counts and timestamps only —
the same rule `explain()` and `check()` follow, and for the same reason: a
value in an event is a secret in a log. `changedPaths(before, after)` is
the same comparison, exported for the code that wants to make it itself.

`failurePollMs` is what makes `reloadFailed` possible. An install wakes
the stream; a refusal cannot, because a load that installed nothing bumps
no generation and there is nothing to be notified of. So a stream that
wants refusals asks for them and pays one `status()` read at the interval
it names — and starts no timer at all when it is omitted.

## Polling, for filesystems that do not notify

```ts
config.watch({ debounceMs: 250, pollMs: 1_000 })
```

A container bind mount, an NFS share and a few overlay filesystems deliver
no change events. `pollMs` re-stats on an interval instead, at the cost of
that interval's latency — the same choice `WatchMode::Poll` is in Rust.

## Debounce

An editor writing a file is several syscalls, and a naive watcher reloads
in the middle of one. The debounce is how long to wait for the writes to
stop; 250 ms is the default and is generous enough for every editor and
every `kubectl apply` this has been pointed at.

## Stopping

```ts
config.stopWatching()
```

Idempotent, and not required for a process to exit: the watcher holds no
reference that keeps the event loop alive. A script that loads a
configuration, starts a watcher and finishes still exits — which is the
first thing anybody would notice and the last thing they would guess.

### The whole lifetime, as one call

```ts
await config.running(async (document) => {
  await serve(document)
})
```

Load, watch, run, stop. JavaScript has no `with`, so the block is a
function; what it buys is the same thing a `with` would — the watcher
cannot be left running by an exception on the way out, and there is no
handle to forget. `{ watch: false }` for the load-and-serve half alone.

## Several configurations at once

```ts
const group = new ConfigGroup(database, cache, queue)

await group.running(async () => {
  await serve()
})

await group.reloadAtomic()   // every member validates, or none installs
```

A group is lifecycle, not storage: `database.current()` is still the read,
and it still has the member's own type. `status()` and `generations()`
answer per key, which is one call for a health endpoint.

`reloadAtomic()` is the one that is not just a loop. The mixed state it
prevents: a deployment moves three files, two parse and one does not, and
the process runs on two new documents and one old one — with nothing in
any of them saying so. Every member loads and validates first, and only
when all of them have does any of them install; a refusal leaves every
document exactly as it was, generation included. It is the engine's own
`ReloadGroup` — prepare, then commit — driven from JavaScript.

`group.reload()` is the other half of the contract, and does *not* do
this: each member reloads independently, one refusing leaves the
others on their new documents, and the first failure is thrown after every
member has had its turn.
