# Contributing

New here? [docs/CONTRIBUTOR-ONBOARDING.md](https://github.com/dynamic-config-rs/dynamic-config/blob/main/docs/CONTRIBUTOR-ONBOARDING.md) is a
tour of every crate and module — what each does, why it is shaped that way, and
where you would touch it. This file is the short version.

## Branches

Pull requests target **`dev`**. `main` is the default branch — the one
visitors land on — and it is production: nothing lands there except `dev`
promotions that passed every gate (squash-merged, one commit per
promotion), and releases are tags on it.

## Before code

For anything larger than a fix, open an issue first. Not for permission — to
find out whether the thing has already been decided against, and why.
[Not planned](https://dynamic-config-rs.github.io/limitations.html#not-planned) records what was refused and why, and
[ROADMAP.md](https://github.com/dynamic-config-rs/dynamic-config/blob/main/ROADMAP.md) what might still be built. Both are shorter than a
list of what exists, and more useful.

## Running everything

```sh
just check              # both packages: the suites, the types, every example
```

Node 18 or newer, and nothing else. TypeScript is optional — the type gate
says so and skips rather than failing, because `npm install -D typescript`
is not a choice this gate should make for somebody fixing Rust.

`scripts/` holds the flows around the checks; see
[scripts/README.md](scripts/README.md).

**`just node` before `just node-remote`.** The stores package hands
documents to the base one, and the recipe links it the way npm would
install it rather than testing against nothing.

The suites are `node --test`, no framework: what a caller could read as
documentation, and nothing added to `npm install`.

## The Node.js bindings

```sh
just node           # build the addon, run the suite, run every example
```

Node 18 or newer, and nothing else: the suite is `node --test` and the
facade is JavaScript with a hand-written `.d.ts`, so there is no build
step and no `npm install` in the loop. Three examples want a framework —
they say so and exit cleanly without one.

The type check is the exception, and it is skipped with a word rather than
failing when TypeScript is absent:

```sh
cd dynamic-config-node && npm install -D typescript && npm run typecheck
```

It is not optional in CI. A regression in the `.d.ts` is invisible to a
test suite — `config.current().host` runs perfectly well while the checker
calls it `unknown` — which is why `tests/typing/usage.ts` exists and is
compiled under `strict`, `exactOptionalPropertyTypes` and
`noUncheckedIndexedAccess`.

**What to know before changing the compiled half**: validation runs inside
the load, on a worker thread, and reaches the event loop through a
`ThreadsafeFunction`. That ordering is what makes a rejected document
change nothing, and it is why nothing here is synchronous.
`book/src/internals.md` is the whole argument.

## What a change should carry

**A test that would fail without it.** Not a test that exercises the new code —
one that catches the bug coming back.

**The reasoning, where it is not obvious.** Comments here explain *why*, not
what: the code says what. If you chose between two reasonable designs, the
rejected one belongs in a comment or in the roadmap.

**Documentation, if a user would notice.** A new macro argument goes in the
README's attribute table with a section of its own; a new feature goes in the
feature table and, if it moves the floor, the MSRV table.

**A changelog entry**, under `Unreleased`.

## Things that are load-bearing

Changing any of these is fine — arguing for it is the price:

- **Reading is lock-free.** `current()` is an atomic load and nothing more.
- **`figment` is the loader and does not appear in a signature.** A figment
  major bump should not be a breaking change here.
- **Secrets are paths, never values.** Every diagnostic reports which key moved,
  not what it moved to.
- **The core crate's MSRV is 1.71**, and every feature that raises it says so in
  the README table. Features that raise it are verified against real toolchains
  in CI, not trusted from a manifest — `age` declares 1.74 and needs 1.85.
- **No mandatory dependency** beyond `serde`, `arc-swap` and the engine's
  default resolution backend.

## Style

`rustfmt` decides layout; `clippy` with `-D warnings` decides the rest. Beyond
that: name things after what they mean to a caller, and let comments carry the
decisions rather than the mechanics.
