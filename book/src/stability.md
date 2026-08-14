# Stability & Production Use

**Beta, and the surface is finished for 0.x.**

`dynamic-config-node` and `dynamic-config-node-remote` are Beta, like
every crate and package in this repository. Between here and 1.0, **only
security fixes and hotfixes land**: no new sources, no new schema doors,
no new methods on the settled types. What still ships is a defect that
produces a wrong answer, a security advisory, and documentation — each as
a patch.

That is a change of intent rather than of policy, and it is worth saying
plainly because the two look identical from outside: a project that
publishes weekly because it is growing and one that publishes rarely
because it is finished are both quiet. This is the second.

## What that means for your program

**Pin the minor version and take patches automatically.**

```json
{ "dependencies": { "dynamic-config-node": "~0.0.1" } }
```

A patch will not break you. Pre-1.0 a break bumps the minor, is called out
in [the changelog](https://github.com/ctolon/dynamic-config/blob/main/dynamic-config-node/CHANGELOG.md),
and comes with what to change on your side.

**The two packages version together.** `dynamic-config-node-remote`
declares the base package as a peer dependency and hands documents to it;
a gap between them is a combination nobody has tested.

**The engine's version is a separate number.** `packageVersion()` is this
package's; `engineVersion()` is the Rust crate it was built against.

## Node versions

| Line | Status | Tested in CI | Notes |
|---|---|---|---|
| 18 | **supported** — the floor | ✅ every commit | `engines.node` is `>= 18` |
| 20 | supported | ✅ every commit | |
| 22 | supported | ✅ every commit | |
| 24 | supported | ✅ every commit | |
| 26 and later | expected to work | — | Node-API is ABI-stable; a line is added to the matrix when it is released |
| 16 and older | **not supported** | — | End of life; `engines.node` refuses |

The addon is compiled against **Node-API**, which is ABI-stable — the same
prebuilt binary serves every line above and the ones after them, the way
an abi3 wheel serves CPython 3.9 upwards. Nothing compiles at install
time.

The matrix exists anyway, because "ABI-stable" is a claim about the
*addon*: the JavaScript half is ordinary code that a version can break,
and `node --test`, `AsyncGenerator` and `setImmediate` ordering are all
things a release has changed before.

**Raising the floor is a breaking change**, treated exactly as an API
break. It will not happen before 1.0.

| Platform | x64 | arm64 |
|---|---|---|
| Linux (glibc) | ✅ | ✅ |
| macOS | ✅ | ✅ |
| Windows | ✅ | — |

One prebuilt binary per row, installed as an optional dependency — so an
install downloads one, not five. musl (Alpine) is **not** among them: the
addon links glibc, and an Alpine image needs `gcompat` or a glibc-based
base. Saying so beats an install that resolves and then crashes on first
import.

**TypeScript**: the definitions are hand-written and checked under
`strict`, `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
TypeScript 5.0 and later; nothing in them needs a newer feature.

## What is tested, and where you can see it

| | |
|---|---|
| The suite | 41 tests across both packages, on four Node versions |
| The types | `tsc --strict`, with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`, over a file written the way a caller writes one |
| Every example | the runnable ones run in CI; the TypeScript ones are typechecked there |
| The artefact | each platform's suite runs against **the binary that will ship**, not a debug build of the same source |
| The engine underneath | the Rust crate's own suite, property tests, `loom` and `shuttle` models for the reload path, and instruction-count gates |
| The stores | each against a real server in a container, and three unplugged mid-watch by a proxy |

## What running this in production actually asks of you

**Decide what a failed reload should do.** The default is right for most
services — the previous document keeps serving and the failure is recorded
— but *recorded* means somebody has to look. `status()` in a health
endpoint is two lines:

```ts
app.get("/healthz", (_request, response) => {
  const status = config.status()

  response.status(status.consecutiveFailures === 0 ? 200 : 503).json(status)
})
```

**Give the last-known-good cache a path that survives a restart**, so a
broken source at startup is a warning rather than an outage. A `redacted`
cache refuses to write at all unless the configuration has said what is
secret.

**Watch the watcher.** A container bind mount and some network
filesystems deliver no change events; `pollMs` is the answer there rather
than a mystery.

**Read `current()` where you need a value, not at boot.** It is a property
read on a cached object. A configuration copied into `app.locals` at
startup is a configuration that has stopped reloading — the one mistake
this library cannot stop you making.

**Nothing here needs a sidecar, an agent or a server.** The engine is in
your process; the only thing that leaves is what a store you configured
goes to fetch.
