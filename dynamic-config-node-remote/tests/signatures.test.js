"use strict";

/**
 * Every store's documented call is the call it takes.
 *
 * `#[napi(constructor)]` generates a **positional** constructor, so a store
 * whose summary line has drifted is not a cosmetic problem: a caller
 * following it passes a timeout where the TLS options go. Three had drifted
 * by 0.6.1 — Vault's `format`, Redis's `tls`, Firestore's `accessTokenFn`
 * and `tls` — each an argument that could only be found by reading the Rust,
 * which is not where a JavaScript caller looks.
 *
 * It lives here rather than in a Rust test because the crate is a `cdylib`
 * and has nothing to link an integration test against; the file it reads is
 * three directories up either way.
 *
 * `a | b | c` in a summary stands for the three slots exactly one of which
 * is filled: a key, a list of keys, or a prefix.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

/** `timeout_ms: Option<u32>` → `timeoutMs?`. */
function parameter(line) {
  const [name, type] = line.trim().replace(/,$/, "").split(/:(.*)/);

  if (type === undefined) {
    return null;
  }

  const camel = name.trim().replace(/_(\w)/g, (_, letter) => letter.toUpperCase());

  return type.includes("Option<") ? `${camel}?` : camel;
}

test("a store's summary line is its signature", () => {
  const source = readFileSync(join(__dirname, "..", "src", "lib.rs"), "utf8");
  const lines = source.split("\n");

  const wrong = [];
  let checked = 0;

  for (const [number, line] of lines.entries()) {
    const documented = line.trim().match(/^\/\/\/ `\((.+)\)`$/);

    if (documented === null) {
      continue;
    }

    // The constructor this line is about, and the parameters it takes.
    const opens = lines.indexOf("    pub fn new(", number);

    if (opens === -1) {
      continue;
    }

    const taken = [];

    for (const parameterLine of lines.slice(opens + 1)) {
      if (parameterLine.trim().startsWith(") ->")) {
        break;
      }

      if (parameterLine.trim().startsWith("//")) {
        continue;
      }

      const named = parameter(parameterLine);

      if (named !== null) {
        taken.push(named);
      }
    }

    // `key | keys | prefix` is three optional slots written as the one
    // choice a caller actually makes — so each alternative is optional
    // whether or not the summary bothered to say so.
    const claimed = documented[1].split(",").flatMap((entry) => {
      const alternatives = entry.includes("|");

      return entry.split("|").map((name) => {
        const trimmed = name.trim();

        return alternatives && !trimmed.endsWith("?") ? `${trimmed}?` : trimmed;
      });
    });

    checked += 1;

    if (claimed.join(", ") !== taken.join(", ")) {
      wrong.push(
        `src/lib.rs:${number + 1}: says (${claimed.join(", ")}), and it takes (${taken.join(", ")})`,
      );
    }
  }

  assert.ok(
    checked >= 8,
    `found ${checked} documented constructors; there are eight stores, so this ` +
      "test has stopped finding them and is passing on nothing",
  );
  assert.deepEqual(wrong, [], `a store's summary line is not its signature:\n  ${wrong.join("\n  ")}`);
});
