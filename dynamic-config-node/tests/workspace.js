"use strict";

/**
 * A scratch directory for a test, under the package rather than the
 * system's temporary one.
 *
 * The engine's own watcher tests do this, and the config server's, for the
 * same reason: on macOS `/var` is a symlink to `/private/var`, so FSEvents
 * reports the resolved path and it never matches a watch registered on the
 * link; on Windows the runner's `TEMP` is an 8.3 short name and the events
 * carry the long one. Neither is this package's bug, and neither is worth
 * a canonicalisation dance in a test — a directory with no symlink over it
 * has neither problem.
 *
 * Not a `*.test.js`, so `node --test tests/*.test.js` does not run it.
 */

const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");

/** `dynamic-config-node/tests/scratch`, created on first use. */
const root = join(__dirname, "scratch");

/** What this process made, removed when it exits. */
const made = [];

process.on("exit", () => {
  for (const directory of made) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A directory of this test's own, and — when `document` is given — a file
 * in it.
 *
 * `mkdtemp` rather than a name of the caller's, because `node --test` runs
 * files in parallel and two tests writing `config.toml` in one directory
 * is a race nobody would enjoy debugging.
 */
function workspace(document, name = "config.toml") {
  mkdirSync(root, { recursive: true });

  const directory = mkdtempSync(join(root, "dc-"));

  // Cleared when this file's tests are done, rather than at the start of
  // the next run: `node --test` runs each test file in its own process, in
  // parallel, so a sweep of the whole scratch directory would be one file
  // deleting another's fixtures mid-test.
  made.push(directory);
  const path = join(directory, name);

  if (document !== undefined) {
    writeFileSync(path, document);
  }

  return {
    directory,
    path,
    write: (text) => writeFileSync(path, text),
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}

module.exports = { workspace, scratchRoot: root };
