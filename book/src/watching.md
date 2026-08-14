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

## Two kinds of hook

```ts
const token = config.onReload((document) => …)   // every install
config.onChange("pool.maxSize", (now, before) => …)  // one path, when it moves
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

## Polling, for filesystems that do not notify

```ts
config.watch({ debounceMs: 250, pollMs: 1_000 })
```

A container bind mount, an NFS share and a few overlay filesystems deliver
no change events. `pollMs` re-stats on an interval instead, at the cost of
that interval's latency — the same choice `WatchMode::Poll` is in Rust.

## Debounce, and why there is one

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
