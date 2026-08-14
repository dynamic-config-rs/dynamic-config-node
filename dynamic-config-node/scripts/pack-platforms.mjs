/**
 * The per-platform packages, built from the artefacts CI collected.
 *
 *   node scripts/pack-platforms.mjs
 *
 * npm's answer for a native addon is one package per platform plus a
 * wrapper that names them as **optional** dependencies: npm installs only
 * the one whose `os`/`cpu` match, and the other four are skipped rather
 * than downloaded and thrown away. That is why an install fetches one
 * binary and not five.
 *
 * This writes those packages from `artefacts/<target>.node`, which is what
 * the release workflow's matrix uploads. It is deliberately a script in
 * this repository rather than `napi create-npm-dirs`: the layout is four
 * fields of JSON per platform, and a generator that has to be installed to
 * produce them is a dependency in the release path.
 */

import { mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Which package to pack: this one by default, or the one named as an
 * argument. Two packages ship native binaries and their layout is
 * identical, so one script serves both rather than two that drift.
 */
const root = process.argv[2] ? join(here, "..", "..", process.argv[2]) : join(here, "..");
const wrapper = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** Every target the package claims, and what npm calls that platform. */
const TARGETS = [
  { target: "x86_64-unknown-linux-gnu", os: "linux", cpu: "x64", libc: "glibc" },
  { target: "aarch64-unknown-linux-gnu", os: "linux", cpu: "arm64", libc: "glibc" },
  { target: "x86_64-apple-darwin", os: "darwin", cpu: "x64" },
  { target: "aarch64-apple-darwin", os: "darwin", cpu: "arm64" },
  { target: "x86_64-pc-windows-msvc", os: "win32", cpu: "x64" },
];

const optional = {};
let written = 0;

for (const { target, os, cpu, libc } of TARGETS) {
  const artefact = join(root, "artefacts", `${target}.node`);

  if (!existsSync(artefact)) {
    // A platform whose build failed is a platform this release does not
    // ship, and saying so beats publishing a wrapper that points at a
    // package nobody uploaded.
    console.warn(`::warning::no artefact for ${target}; it will not be published`);
    continue;
  }

  const name = `${wrapper.name}-${os}-${cpu}${libc ? `-${libc}` : ""}`;
  const directory = join(root, "npm", name);

  mkdirSync(directory, { recursive: true });
  copyFileSync(artefact, join(directory, "index.node"));

  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name,
        version: wrapper.version,
        description: `${wrapper.description} — the ${os} ${cpu} binary`,
        license: wrapper.license,
        repository: wrapper.repository,
        engines: wrapper.engines,
        os: [os],
        cpu: [cpu],
        ...(libc ? { libc: [libc] } : {}),
        main: "index.node",
        files: ["index.node"],
      },
      null,
      2,
    )}\n`,
  );

  optional[name] = wrapper.version;
  written += 1;
}

if (written === 0) {
  console.error("no artefacts at all; nothing to publish");
  process.exit(1);
}

// The wrapper depends on what was actually built, exactly. Not a range: a
// wrapper that resolved a *newer* binary than itself would be a version
// pair nobody tested.
wrapper.optionalDependencies = optional;

writeFileSync(join(root, "package.json"), `${JSON.stringify(wrapper, null, 2)}\n`);

console.log(`${written} platform package(s):`, Object.keys(optional).join(", "));
