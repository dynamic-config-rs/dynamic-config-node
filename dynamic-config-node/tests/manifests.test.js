"use strict";

/**
 * The two manifests, against each other.
 *
 * `dynamic-config-node` and `dynamic-config-node-remote` ship as a pair on
 * one version — the addon is compiled against the base package's ABI, and
 * a release that moved one without the other would be a combination
 * nobody has run.
 *
 * The peer range is the part that goes stale quietly. npm's caret pins the
 * patch below 0.1.0: `^0.0.1` matches 0.0.1 and nothing else. A range left
 * behind at a previous release therefore makes the *matching* pair refuse
 * to install together, which is a resolution error in a user's terminal
 * rather than anything a test here would otherwise see.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const base = require("../package.json");
const remote = require("../../dynamic-config-node-remote/package.json");

test("the two packages carry one version", () => {
  assert.equal(
    remote.version,
    base.version,
    `${remote.name} is ${remote.version} and ${base.name} is ${base.version}`,
  );
});

test("the addon peers on exactly the version it ships with", () => {
  const range = remote.peerDependencies[base.name];

  assert.equal(
    range,
    `^${base.version}`,
    `${remote.name} peers on ${range}, which does not name ${base.version}`,
  );
});
