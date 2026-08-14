/**
 * Express: configuration read per request, not copied into `app.locals`.
 *
 *   npm install express && node examples/02-express.mjs
 *
 * The point of the example is the thing it does *not* do. A configuration
 * copied into `app.locals` at boot is a configuration that stops changing;
 * `config.current()` is an object property read, so reading it per request
 * costs nothing and is always the document in force.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DynamicConfig } = require("../js/index.js");

let express;

try {
  express = require("express");
} catch {
  console.log("this example needs express: npm install express");
  process.exit(0);
}

const directory = mkdtempSync(join(tmpdir(), "dynamic-config-"));
const file = join(directory, "config.toml");

writeFileSync(file, '[api]\ngreeting = "hello"\nrateLimit = 100\n');

const config = new DynamicConfig({
  key: "api",
  validate: (document) => ({
    greeting: String(document.greeting ?? "hello"),
    rateLimit: Number(document.rateLimit ?? 60),
  }),
  fields: ["greeting", "rateLimit"],
});

await config.file(file).env("APP_").init();

// The watcher owns the reload; the app owns nothing about it. An edit to
// the file is live on the next request, with no restart and no hook here.
config.watch({ debounceMs: 100 });

const app = express();

app.get("/", (_request, response) => {
  // Read here, not at boot: this is the whole idea.
  const { greeting, rateLimit } = config.current();

  response.json({ greeting, rateLimit, generation: config.generation });
});

// A health endpoint an operator can actually use: what is installed, how
// old it is, and whether the last reload failed.
app.get("/healthz", (_request, response) => {
  const status = config.status();

  response.status(status.consecutiveFailures === 0 ? 200 : 503).json(status);
});

const server = app.listen(0, async () => {
  const { port } = server.address();
  const read = async () => (await fetch(`http://127.0.0.1:${port}/`)).json();

  console.log("first request: ", await read());

  writeFileSync(file, '[api]\ngreeting = "hot-reloaded"\nrateLimit = 250\n');

  // Wait for the watcher, the way a test would.
  for (let attempt = 0; attempt < 100 && config.current().rateLimit !== 250; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  console.log("after the edit:", await read());
  console.log("healthz:       ", await (await fetch(`http://127.0.0.1:${port}/healthz`)).json());

  config.stopWatching();
  server.close();
});
