---
name: review-for-release
description: Use before cutting a release, or when asked to review the whole repository — the checks that have actually caught things here, in the order that finds problems fastest.
---

# Reviewing before a release

Run `just check` first. Everything below is what that does not catch.

## The checks that have caught real bugs here

**Run the suite twice: parallel, then `--test-threads=1`.** The macro takes
literal paths, and layers, aliases and bindings live in `static`s — two tests
sharing a config type, a fixture path or an environment variable race in
parallel and pass alone. Both orders have found bugs.

**Grep for `Instant::now() +` and `Duration::from_*` on anything a server
sent.** A lease duration from a compromised or buggy server panics the process
on the arithmetic. `checked_add`, always.

**Check every error path that removes a file.** `save_new` deleted the file it
had just refused to overwrite. Ask: is this call what created the thing being
cleaned up?

**Read every `.expect(` and `panic!` outside tests.** The crate's stance is that
a poisoned lock recovers rather than propagating: none of the data behind those
locks has an invariant a panic could break, and one panicking caller must not
take out every later load.

**Look for values in diagnostics.** Diffs, `check()` reports, unknown-key
suggestions and *error messages* report paths and types, never values.
`tests/security.rs` enforces it; a new message that interpolates a value is a
security regression that no test names.

**Verify MSRV against real toolchains.** `age` declares 1.74 and needs 1.85.
A manifest is a claim, not a measurement. `just msrv` runs every floor.

**Check CI parity.** The Node matrix in ci.yml, the five targets in
`package.json`'s `napi.targets`, the five rows of release.yml's addon
matrix and `scripts/pack-platforms.mjs`'s platform table all name the
same set. A platform in one and not the others is a wrapper pointing at a
package nobody built.

**Audit the stacked `#[cfg]`s.** Two `#[cfg]` attributes on one item AND
together — `#[cfg(unix)] #[cfg(not(unix))]` compiles to nothing, silently.
Three tests here never ran for months because of one. Grep for consecutive
cfg lines and read each pair.

**Check the counts.** Two packages, five platforms, seven ci.yml jobs,
eleven examples, and the Node versions in three places: `package.json`'s
`engines`, the CI matrix and the README's table.

**`cargo clippy -- -W clippy::pedantic`** for the substantive lints only:
`unnecessary_wraps`, `needless_pass_by_value` on public API, `redundant_clone`,
`must_use_candidate`. Ignore the style noise.

## Documentation

- Every anchor and relative link resolves. A dead `#anchor` in a README is
  small, easy to ship, and the first thing a reader hits.
- Counts anywhere in the documentation — tests, examples, features, crates —
  match reality. Run the suite and count rather than trusting the last number.
- The book's example output matches what the examples print. Run them.
- `node --test` in both packages — including
  `dynamic-config-node-remote/tests/signatures.test.js`, which compares each
  store's documented call to the constructor it actually takes.
- `js/index.d.ts` and the facade agree with the compiled surface. Nothing
  else checks that.
- Each crate's README is *its own*, not the repository's.

## Release mechanics

- Both `package.json` files carry the same version, and both changelogs
  have a section for it.
- `npm pack --dry-run` in each package: `js/`, README and LICENSE, and
  nothing else — no `index.node`, no tests.
- Never run `npm publish`. Merging into `main` publishes twelve packages.
