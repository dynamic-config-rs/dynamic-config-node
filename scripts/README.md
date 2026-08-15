# Scripts

The `justfile` runs *checks*; these run *flows* — the git/gh choreography
around the checks. Each one is safe to re-run and says what it did.

| Script | What it does |
|---|---|
| `ci-local.sh` | The whole CI gate locally, in the order that fails fastest. |
| `claude-review-pr.sh` | Reviews a pull request with Claude locally — title, body, diff, and read-only access to the checkout. `--post` comments the review on the PR; without it, nothing leaves the terminal. |
| `dismiss-alert.sh` | Dismisses a Dependabot alert with the reason recorded *on the alert* — GitHub's UI leaves that nowhere a reviewer finds later. `--list` shows what is open. |
| `promote.sh` | `dev` → `main`: pushes, opens the pull request if it is not already open (titled "release X.Y.Z" when the push carries a version bump), arms auto-merge, waits for the gates, merges (squash), and re-syncs `dev` onto the new `main`. |
| `promotion-title.sh` | Sourced by the two scripts above — the one copy of the rule that titles a promotion. Not run by hand. |
| `propose.sh` | The first half of `promote.sh`: pushes `dev` and opens the pull request, then stops — for when something should read the PR before anything merges. |
| `security-status.sh` | The whole security surface, read-only: open Dependabot alerts, open code-scanning findings, and cargo-deny's local view. Exits with the open-alert count. |
| `watch-ci.sh` | Watches the newest CI run for the current branch; on failure, prints the failed jobs' logs. |
| `watch-release.sh` | Watches the Release run the latest merge to `main` set off, and says how to recover from a rate limit. |

The release is a pull request too: bump both `package.json` files, rotate
both changelogs, land it with `./scripts/promote.sh`, and the merge to
`main` publishes twelve packages — ten platform binaries and two wrappers.
Nothing here talks to npm.
