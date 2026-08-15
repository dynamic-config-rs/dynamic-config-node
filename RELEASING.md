# Releasing

Two packages, one version, published together — `dynamic-config-node` and
`dynamic-config-node-remote`. Nothing here goes to crates.io.

**Twelve packages, not two.** Each wrapper publishes five per-platform
packages — linux x64/arm64 (glibc), macOS x64/arm64, Windows x64 — and
names them as `optionalDependencies`, so an install downloads one binary
rather than five. `scripts/pack-platforms.mjs` writes them at publish time
from the artefacts the build matrix produced, and rewrites the wrapper's
optional dependencies to name exactly what was built.

**Five native runners, not cross-compilation.** The addon links against the
platform's own C runtime, and a cross build that "works" is one nobody has
loaded on the machine it targets. Each runner builds both addons, runs both
suites *against the artefact that will ship*, and uploads it.

## The branch model

Work lands on `dev`. `main` is production: it accepts no direct pushes —
not even from admins — only pull requests whose gates ("CI is green",
"Security is green") have passed, merged with a linear history.

**Merging a version bump into `main` is the release.** `release.yml` runs
on every push to `main`, checks whether the version in
`dynamic-config-node/package.json` is new, and — only then — builds the
addons, publishes, and mints the tag and the GitHub release at the merge
commit.

## The lifecycle, step by step

1. **Land the work on `dev`** through pull requests, entries accumulating
   under `## [Unreleased]` in the package's changelog.
2. **Pre-flight.** `just check` on `dev`. It needs Node 18+ and nothing
   else; install TypeScript if you want the type gate to run rather than
   skip.
3. **Bump both `package.json` files to the same version**, move each
   changelog's `## [Unreleased]` block under a dated heading, and commit.
   There is no `cargo release` here: these crates are excluded from
   crates.io entirely, and two files are two files.
4. **Read the commit.** Both versions equal, both changelogs rotated,
   `Unreleased` empty again.
5. **`./scripts/promote.sh`.** Pushes `dev`, opens or updates the pull
   request, arms auto-merge and waits; when both gates pass, the
   squash-merge lands — **that merge is the release**.
6. **`./scripts/watch-release.sh`.** Follows the run: five runners, then
   the ten platform packages, then the two wrappers, then the tag.

The platform packages publish **first**: a wrapper on the registry whose
optional dependencies are not there yet is an install that fails.

## What an operator has to have ready

`NPM_TOKEN` as a repository secret — a **granular access token** with
*read and write* on all packages and **bypass 2FA** enabled. Classic
tokens no longer exist, and a token without the 2FA bypass answers
`403 Two-factor authentication or granular access token with bypass 2fa
enabled is required` on the first publish. Write tokens expire after 90
days at most, so this is a recurring errand rather than a one-off.

Nothing else: the packages are unscoped, so no organisation is involved,
and `--provenance` needs only the `id-token: write` the job already
declares.

## When a publish fails halfway

It has, twice, on the first release:

- **`npm publish <name>`** is a *package spec*, not a directory. Publishing
  a wrapper needs `./` in front, or npm goes to the registry looking for a
  package by that name and 404s on the one release where it cannot exist.
- **`429 rate limited exceeded`** is npm's answer to a burst, and twelve
  packages is a burst. The job asks the registry before each attempt and
  publishes only on a 404, so a rerun skips what already landed and
  retries what did not — the one thing that cannot be undone is publishing
  the same version twice.

A platform whose build failed is a platform the release does not ship: the
packing script warns and leaves it out of `optionalDependencies` rather
than publishing a wrapper that points at a package nobody uploaded. That is
a partial release, and the fix is a rerun — npm versions are as permanent
as PyPI's.

## Afterwards

```sh
npm view dynamic-config-node version
npm view dynamic-config-node optionalDependencies    # all five platforms?
cd $(mktemp -d) && npm init -y >/dev/null && npm install dynamic-config-node \
  && node -e "console.log(require('dynamic-config-node').packageVersion())"
```

## Version policy

- **Pre-1.0, a breaking change bumps the minor version** and everything
  else the patch.
- Dropping a Node version, or a platform, is breaking. The supported
  runtimes are in the README and each has a CI row.
- MSRV changes are breaking for anybody building from source.
- The engine is a dependency here, named with a caret. A breaking engine
  release is not automatically a breaking release of these packages — what
  matters is whether the *JavaScript* surface moved.
