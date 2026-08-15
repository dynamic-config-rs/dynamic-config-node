# AGENTS.md

Two npm packages: `dynamic-config-node`, and `dynamic-config-node-remote`
for the eight Rust stores. Both are Node-API addons around
[the engine](https://github.com/dynamic-config-rs/dynamic-config), which is
a crates.io dependency here, not a sibling.

## Orientation

```text
dynamic-config-node/
  src/                the compiled surface: napi-rs, one module per concern
  js/index.js         the facade — what a caller imports, and what throws
  js/index.d.ts       hand-written, and it is the contract
  tests/              node --test, no framework
  examples/           twelve, runnable; CI runs the nine that need no framework
  scripts/pack-platforms.mjs   writes the per-platform packages at publish time
dynamic-config-node-remote/
  src/lib.rs          the eight stores, wrapped
  js/index.js         `useStore`, and the bridge to the base package
```

**Both packages version together**, and neither goes to crates.io: a
`cdylib` addon has no Rust consumers. What ships is one prebuilt binary per
platform, as optional dependencies of a wrapper.

## Commands

```sh
just check        # fmt, clippy, both suites, the types, every example
just node         # the base package: 39 tests, tsc, nine examples
just node-remote  # the stores package: 15 tests, including the signature gate
just book         # this repository's book
```

Node 18+ and nothing else. TypeScript is optional: the type check says so
and skips rather than failing, because `npm install -D typescript` is not a
choice this gate should make for somebody fixing Rust.

Skills in `.claude/skills/`: [triaging the security
tab](.claude/skills/triage-security/SKILL.md), [reviewing before a
release](.claude/skills/review-for-release/SKILL.md).

## Rules that are not negotiable

**Validation runs inside the load, on a worker thread, and reaches the
event loop through a threadsafe function.** That is what keeps the property
this design exists for: a document the schema refuses installs nothing and
leaves the previous one serving — from the watcher exactly as from an
explicit reload. It is also why there is no `initSync`: a synchronous load
would be the loop waiting for itself.

**Nothing throws across the boundary.** The native half answers
`{ ok: true, value }` or `{ ok: false, error: { kind, path, originKind,
origin, message } }`, and the facade in `js/index.js` is what turns a
refusal into a `DynamicConfigError`. A `napi::Error` crossing back is a bug
even when it looks like the same thing.

**A validator returns plain data.** Its answer is serialised into the
store, so a class instance comes back without its prototype and a `Date`
comes back as `{}`. This is documented in `book/src/limitations.md` and
asserted in the suite; do not promise otherwise in a doc comment.

**Secrets are paths and types, never values** — including a message the
caller's own validator threw. The refused document's secret values are
scrubbed out of it before it becomes a `DynamicConfigError`.

**Store constructors are positional.** `#[napi(constructor)]` generates
positional arguments, so the `(a, b, c?)` summary above `pub fn new` is a
signature, not a sketch — `dynamic-config-node-remote/tests/signatures.test.js`
compares the two and fails when they disagree. Three had drifted by 0.6.1.

## Mistakes this repository has actually seen

**A doc example for an API that never existed.** The crate page showed
`new Etcd({ endpoints, key })` and `config.useStore(store)`; neither is
real. The hook prints the files a change has to travel to, and the
signature gate catches the constructors.

**A test that read a hook's record too early.** The snapshot is swapped in
before the hooks are dispatched, so seeing the new value does not mean the
hook has run. Poll for what a hook recorded; do not read it once.

**Watched fixtures in the system temporary directory.** macOS reports the
resolved `/private/var` path and Windows the long form of an 8.3 name, so a
watcher registered on one never matches events for the other. Tests write
under `tests/scratch/`.

**`npm publish <name>` is a package spec, not a directory.** It goes to the
registry looking for a package by that name — a 404 on the one release
where it cannot exist. `./` in front, always.

## What a change must carry

The facade, the `.d.ts`, the chapter in `book/src/`, a test, and an entry
under `## [Unreleased]` in the package's own `CHANGELOG.md`.

## Releasing

Do not publish. A version bump in `package.json` is the release; merging it
into `main` is what publishes. See [RELEASING.md](RELEASING.md), and never
run `npm publish` directly.
