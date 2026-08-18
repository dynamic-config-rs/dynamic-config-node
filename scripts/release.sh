#!/usr/bin/env bash
# The three edits a Node release is, made by a script instead of a memory.
#
#   scripts/release.sh patch|minor|<version>    # prepare, commit nothing
#
# Both packages move to one version, the addon's peer range moves WITH
# them — npm's caret pins the patch below 0.1.0, so a range left behind
# makes the matching pair refuse to install together; that shipped once,
# as 0.0.2, and is why `manifests.test.js` exists — and both changelogs
# rotate their [Unreleased] block under the new heading.
#
# What it does not do: push, tag, or publish. The commit is yours to read
# first (`git show --stat HEAD` after committing), promote.sh is the road
# to main, and merging the bump IS the release.
set -euo pipefail
cd "$(dirname "$0")/.."

# A [patch.crates-io] in the workspace means the addon is built against an
# engine that is not published. A release cut in that state ships code
# nobody can rebuild — refuse until the train removes the patch.
if grep -q "^\[patch.crates-io\]" Cargo.toml; then
  echo "✗ Cargo.toml carries [patch.crates-io] — the addon is built against"
  echo "  an unpublished engine. Release the engine first, drop the patch,"
  echo "  and run this again."
  exit 1
fi

base="dynamic-config-node/package.json"

current=$(node -p "require('./$base').version")

case "${1:-}" in
  patch|minor)
    version=$(node -p "
      const [maj, min, pat] = '$current'.split('.').map(Number);
      '$1' === 'minor' ? \`\${maj}.\${min + 1}.0\` : \`\${maj}.\${min}.\${pat + 1}\`;
    ")
    ;;
  [0-9]*.[0-9]*.[0-9]*)
    version="$1"
    ;;
  *)
    echo "usage: scripts/release.sh patch|minor|<version>   (current: $current)"
    exit 1
    ;;
esac

echo "── $current → $version"

# The two manifests and the peer range: the three edits, by machine.
node - "$version" <<'JS'
const fs = require("fs");
const version = process.argv[2];

for (const file of [
  "dynamic-config-node/package.json",
  "dynamic-config-node-remote/package.json",
]) {
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  manifest.version = version;

  if (manifest.peerDependencies?.["dynamic-config-node"]) {
    manifest.peerDependencies["dynamic-config-node"] = `^${version}`;
  }

  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`   ${file}`);
}
JS

# Rotate both changelogs: the [Unreleased] block moves under a dated
# heading and Unreleased opens again, empty.
today=$(date +%F)

for changelog in dynamic-config-node/CHANGELOG.md dynamic-config-node-remote/CHANGELOG.md; do
  if grep -q "^## $version " "$changelog"; then
    echo "   $changelog already names $version — left alone"
    continue
  fi

  awk -v v="$version" -v d="$today" '
    /^## \[Unreleased\]$/ && !done { print; print ""; print "## " v " — " d; done = 1; next }
    { print }
  ' "$changelog" > "$changelog.tmp" && mv "$changelog.tmp" "$changelog"

  echo "   $changelog"
done

# The proof the three edits agree — the test that exists because a hand
# once missed one of them.
(cd dynamic-config-node && node --test tests/manifests.test.js >/dev/null 2>&1) \
  && echo "── manifests agree" \
  || { echo "── manifests.test.js REFUSES this state"; exit 1; }

echo
echo "review, then:"
echo "  git add -A && git commit -m \"release $version\""
echo "  ./scripts/promote.sh"
