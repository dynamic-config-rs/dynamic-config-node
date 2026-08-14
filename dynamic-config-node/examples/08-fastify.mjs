/**
 * Fastify: a decorator, and why it is not a plugin option.
 *
 *   npm install fastify && node examples/08-fastify.mjs
 *
 * A Fastify plugin's options are read once, when the plugin registers.
 * Configuration that is read once is configuration that has stopped
 * changing — so what goes on the instance is the *configuration object*,
 * and each handler reads `current()` from it. That is one property read
 * per request and always the document in force.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DynamicConfig } = require("../js/index.js");

let Fastify;

try {
  Fastify = require("fastify");
} catch {
  console.log("this example needs fastify: npm install fastify");
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
config.watch({ debounceMs: 100 });

const app = Fastify({ logger: false });

// The object, not its values: `app.config.current()` in a handler is the
// document in force, and `app.config` is decided once at boot.
app.decorate("config", config);

app.get("/", async (request) => {
  const { greeting, rateLimit } = request.server.config.current();

  return { greeting, rateLimit, generation: request.server.config.generation };
});

app.get("/healthz", async (request, reply) => {
  const status = request.server.config.status();

  return reply.code(status.consecutiveFailures === 0 ? 200 : 503).send(status);
});

await app.listen({ port: 0, host: "127.0.0.1" });

const { port } = app.server.address();
const read = async () => (await fetch(`http://127.0.0.1:${port}/`)).json();

console.log("first request: ", await read());

writeFileSync(file, '[api]\ngreeting = "hot-reloaded"\nrateLimit = 250\n');

for (let attempt = 0; attempt < 100 && config.current().rateLimit !== 250; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

console.log("after the edit:", await read());
console.log("healthz:       ", await (await fetch(`http://127.0.0.1:${port}/healthz`)).json());

config.stopWatching();
await app.close();
