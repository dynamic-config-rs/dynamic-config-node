#!/usr/bin/env node
// The conformance suite's Node runner — ~50 lines of glue, on purpose.
//
// Reads the engine repository's conformance/cases (CONFORMANCE_DIR, or the
// sibling checkout), builds each case through the public API, compares the
// resolved document to expected.json. A disagreement names the case and is
// a FINDING — fix the engine or the binding, never this runner.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
// Local runs use the checkout's addon; CI installs the published package
// and points CONFORMANCE_PACKAGE at it — the runner then validates what
// users actually download against the pinned cases.
const source = process.env.CONFORMANCE_PACKAGE ?? "../dynamic-config-node/js/index.js";
const { DynamicConfig } = await import(source);

const root =
  process.env.CONFORMANCE_DIR ?? "../dynamic-config/conformance/cases";

function* flatten(tree, prefix = "") {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length) {
      yield* flatten(value, path);
    } else {
      yield [path, value];
    }
  }
}

async function runCase(dir) {
  const read = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
  const args = read("args.json");
  const env = read("env.json");
  const expected = read("expected.json");

  for (const [key, value] of Object.entries(env)) process.env[key] = value;

  try {
    let config = new DynamicConfig({ key: args.key }).file(join(dir, "config.toml"));

    if (args.env_prefix) config = config.env(args.env_prefix);
    if (args.profile_env) config = config.profileEnv(args.profile_env);
    if (args.secrets_dir) config = config.secretsDir(join(dir, args.secrets_dir));
    for (const name of args.env_files ?? []) config = config.envFile(join(dir, name));
    if (args.whole_document) config = config.wholeDocument();
    if (args.extra_missing_file) config = config.file(join(dir, args.extra_missing_file));

    if (args.defaults) config.setDefaults(args.defaults);
    for (const [path, value] of flatten(args.set ?? {}))
      config.setAssignments([`${path}=${value}`]);
    for (const [path, value] of flatten(args.overrides ?? {}))
      config.setOverride(path, value);
    for (const [from, to] of Object.entries(args.aliases ?? {}))
      config.alias(from, to);

    await config.init();

    return { resolved: config.current() };
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
  }
}

const failures = [];
const cases = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (!cases.length || !existsSync(root)) {
  console.error(`no cases at ${root}; set CONFORMANCE_DIR`);
  process.exit(2);
}

for (const name of cases) {
  const { resolved } = await runCase(join(root, name));
  const expected = JSON.parse(readFileSync(join(root, name, "expected.json"), "utf8"));
  const a = JSON.stringify(sort(resolved));
  const b = JSON.stringify(sort(expected));

  if (a !== b) failures.push(`${name}: resolved ${a} but expected ${b}`);
}

function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sort(value[k])]));
  return value;
}

if (failures.length) {
  console.log("conformance disagreements:");
  for (const failure of failures) console.log(`  ${failure}`);
  process.exit(1);
}

console.log(`${cases.length} cases agree`);
