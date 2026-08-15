#!/usr/bin/env bash
# Sourced by propose.sh and promote.sh — the one copy of the rule that
# titles a promotion. A push that carries a version bump is a release, and
# its pull request (and the squash commit main gets) should say which one.
#
# The version lives in package.json here, not in a Cargo manifest: these
# two crates never go to crates.io, and what they publish is a pair of npm
# packages that version together.
#
# Sets: $title
promotion_title() {
  git fetch -q origin main

  local version released
  version=$(node -p "require('./dynamic-config-node/package.json').version")
  released=$(git show origin/main:dynamic-config-node/package.json | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version")

  if [ "$version" != "$released" ]; then
    title="release $version"
  else
    title="promote dev to main"
  fi
}
