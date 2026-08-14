# Examples

Twelve of them, each showing one idea. Run from this directory:

```sh
node examples/01-quick-start.mjs
```

| Example | Needs | Shows |
|---|---|---|
| [`01-quick-start`](01-quick-start.mjs) | — | A file, a schema, `init`, and where each value came from |
| [`02-many-configs`](02-many-configs.mjs) | — | One process, three configurations: three sections, three schemas, three reloads that do not touch each other |
| [`03-testing`](03-testing.mjs) | — | Pinning configuration with no filesystem: an override block, a candidate `load()`, and defaults |
| [`04-layering`](04-layering.mjs) | — | Every layer in precedence order, with `explain` proving it |
| [`05-watching`](05-watching.mjs) | — | A watcher, two kinds of hook, and a rejected edit changing nothing |
| [`06-diagnostics`](06-diagnostics.mjs) | — | `sourceOf`, `isSet`, `explain`, `check`, `snapshot`, `status` |
| [`07-express`](07-express.mjs) | `express` | Read per request, not copied into `app.locals`; a health endpoint an operator can use |
| [`08-fastify`](08-fastify.mjs) | `fastify` | A decorator carrying the configuration *object*, and why it is not a plugin option |
| [`09-schemas`](09-schemas.mjs) | `zod` | Zod, a plain function, and no schema at all, side by side |
| [`10-nestjs`](10-nestjs/config.module.ts) | typechecked | A provider with `useFactory`, injected where a `ConfigService` would be |
| [`11-nextjs`](11-nextjs/) | typechecked | Server components read `current()`; the client gets what the server chose to send |
| [`12-react`](12-react/README.md) | prose | The honest one: there is no configuration engine in the browser |

**The `.mjs` ones run in CI**, on every Node version this package claims —
an example that only compiles is not an example. The two TypeScript ones
are typechecked there instead (`tsc --strict`): a Nest application needs a
compile step and a Next one needs a whole framework, and an example that
installs those to print one line would be a test of npm rather than of
this binding.

**12-react has no code to run at all**, and that is the point it makes: a
browser has no filesystem, no watcher and no store, so what reaches it is
a snapshot the server chose to send. The example draws that boundary
rather than hiding it behind a bundler shim.
