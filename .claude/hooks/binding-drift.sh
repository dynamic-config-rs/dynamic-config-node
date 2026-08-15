#!/usr/bin/env bash
# Names the files a change has to travel to, the moment it is made.
#
# Advisory by design: it exits 0 and never blocks a tool call.
set -euo pipefail

input=$(cat)
path=$(printf '%s' "$input" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input", {}).get("file_path", ""))' 2>/dev/null || true)

[ -z "$path" ] && exit 0

case "$path" in
  */dynamic-config-node/src/config.rs)
    cat <<'NOTE'
The compiled surface moved. A method added or changed there has to reach:
  · js/index.js          the facade, which is what throws
  · js/index.d.ts        the contract a TypeScript caller reads
  · book/src/reference.md
  · tests/               the behaviour, not the call
  · CHANGELOG.md         under Unreleased
NOTE
    ;;
  */dynamic-config-node-remote/src/lib.rs)
    cat <<'NOTE'
A store's constructor is positional, and three places describe it:
  · the `(a, b, c?)` summary above `pub fn new` — doc_surface compares it
  · js/index.d.ts        the same signature, for the caller
  · book/src/remote-stores.md
NOTE
    ;;
  */package.json)
    cat <<'NOTE'
Both packages version together, and the wrapper's optionalDependencies are
rewritten at publish time by scripts/pack-platforms.mjs. A version bump
here is a release: see RELEASING.md.
NOTE
    ;;
esac

exit 0
