# Telemetry & Health

Two questions an operator asks about configuration, and neither is
answerable from a log line that says "reloaded": *is this process serving
the configuration I deployed*, and *how long has it been serving something
else*.

`status()` answers both without touching a file.

```ts
const status = config.status()
// { key, generation, consecutiveFailures, lastReason, lastFailure }
```

| Field | What it says |
|---|---|
| `generation` | how many documents have installed. `0` means nothing ever loaded |
| `consecutiveFailures` | reloads refused since the last success. `0` is healthy |
| `lastReason` | what caused the last install — a manual reload, a file change, a recovery |
| `lastFailure` | `{ kind, path }` of the last refusal, or `null`. A path and a kind, never a value |

`snapshot()` adds `loadedAtAgoMs`: how long the serving document has been
serving.

## Liveness is not readiness

They are different questions and want different endpoints.

```ts
// Liveness: is the process alive? Configuration has no say.
app.get("/healthz", (_request, response) => response.sendStatus(200))

// Readiness: is it serving something, and are the reloads working?
app.get("/readyz", (_request, response) => {
  const status = config.status()
  const ok = status.generation > 0 && status.consecutiveFailures === 0

  response.status(ok ? 200 : 503).json({
    generation: status.generation,
    consecutiveFailures: status.consecutiveFailures,
  })
})
```

A process whose reloads are failing is serving its last good document
perfectly well. Restarting it would only make it read the same broken file
again — so liveness must not fail on configuration, or a bad edit becomes a
crash loop. Readiness is where it belongs: take the instance out of the load
balancer, leave it running, and let somebody look.

## Staleness is a third thing

A configuration nobody has edited for a month is not a problem. A
configuration that *should* be refreshed and is not — a remote store that
has stopped answering — looks identical from `consecutiveFailures`, because
a fetch that never happens fails nothing.

`loadedAtAgoMs` is what separates them:

```ts
const stale = config.snapshot().loadedAtAgoMs > 3_600_000
```

Only apply it where something is expected to refresh. On a file-backed
configuration it would page somebody about a file that is simply correct.

## A remote store answers separately

```ts
const remote = config.remoteStatus()
// { reachable, fetches, consecutiveFailures, lastFailure }
```

*Did the store answer* and *did a document install* are two events, and a
service watching only the second cannot tell a store that went away from a
configuration nobody has changed.

## What never appears

No field on either object carries a configured value. `lastFailure` names
the **path** and the **kind** — `{ kind: "invalid", path: "db.port" }` —
which is what a metric label and an alert body can safely hold.

That constraint is why these endpoints can be unauthenticated. A route that
renders values is a different route with a different answer about who may
call it.

## Prometheus

The binding ships no exporter and registers nothing with a metrics client,
because choosing one for the process that imports this would be choosing for
the whole process. The numbers are here; the exporter is yours:

```ts
register.gauge({
  name: "dynamic_config_generation",
  labelNames: ["config"],
}).set({ config: "db" }, config.status().generation)
```

Label with the configuration's **key**, never with a path or a value —
cardinality is the reason, and a value in a label is a value in a metrics
store.
