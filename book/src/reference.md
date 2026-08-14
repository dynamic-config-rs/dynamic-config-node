# API Reference

Every method, every argument, every default. The TypeScript definitions
ship with the package, so an editor has all of this too — this page is
what a reader wants when the editor is not the question.

## `new DynamicConfig<T>(options)`

| Option | Default | Meaning |
|---|---|---|
| `key` | required | the section this configuration reads (`[db]` in a TOML file). It also names the environment prefix — `env("APP_")` reads `APP_DB_*` — and every diagnostic. `""` is a configuration with nothing to call itself, which goes with `wholeDocument()` |
| `validate` | none | what turns a resolved object into the value the program reads. Omitted, the document *is* the value — see [Schemas](schemas.md) |
| `secrets` | none | dotted paths whose values must never reach a diagnostic. A `redacted` or `fingerprint` cache is refused without them |
| `fields` | none | the keys the schema declares, for the unknown-key report. Without it `check()` says it compared nothing |

The generic parameter is whatever `validate` returns, so `current()` is
`T` with nothing cast.

## Sources

Each returns the configuration, so they chain. All of them are refused
after the first load — a source added later would take effect on the next
reload and nowhere in the document that is serving.

| Call | What it adds |
|---|---|
| `file(path)` | a file. Files merge left to right, key by key |
| `discover(name, paths)` | look for `name` in each of `paths`, in order |
| `env(prefix)` | `PREFIX_KEY_*` from the environment |
| `nest(separator)` | what spells nesting in a variable name; `__` by default |
| `allowEmptyEnv()` | treat an empty variable as a value rather than as absent |
| `strictEnv()` | refuse an ambiguous spelling — `off`, `yes`, `none` — instead of guessing |
| `wholeDocument()` | the file has no section header: its whole document is this section |
| `envFile(path)` | a `.env`, which sits just below the real environment |
| `secretsDir(path)` | one file per key, as Docker and Kubernetes mount |
| `profileEnv(variable)` | which variable names the profile to select |
| `cache(path, mode)` | the last-known-good cache: `"full"`, `"redacted"` or `"fingerprint"` |

## The runtime layers

| Call | Where it sits |
|---|---|
| `setDefault(path, value)` | the bottom: a fallback the program computes |
| `setDefaults(values)` | a whole object at once: every leaf of it is a default |
| `setOverride(path, value)` | the top: wins over everything |
| `setAssignments(["db.port=1"])` | `--set` pairs, above the environment |
| `bindEnv(path, variable)` | one path to one variable, whatever the prefix rule says |
| `alias(from, to)` | accept `from` as another spelling of `to` |
| `clearDefaults()` / `clearOverrides()` / `clearAssignments()` | empty one layer |

All four take effect on the next load.

## Lifecycle

| Call | Answers |
|---|---|
| `await init()` | the configuration, loaded, validated and installed |
| `await initAndCurrent()` | …and the document, for code that wants the values |
| `await reload()` | the new document. A failure installs nothing |
| `await load()` | a candidate: loads and validates, installing nothing |
| `current()` | the document in force. Throws before the first install |
| `tryCurrent()` | that, or `undefined` |
| `get(path, fallback?)` | one value by dotted path |
| `replace(document)` | installs a document directly, without loading: the testing door. `status()` and `snapshot()` still describe the last real load |
| `changes()` | an async iterator of every installed document |
| `generation` | how many documents have been installed |

## Watching and hooks

| Call | |
|---|---|
| `watch({ debounceMs, pollMs })` | reload on a change; `pollMs` re-stats instead of subscribing |
| `stopWatching()` | idempotent |
| `onReload(hook)` | every install, on the loop. Returns a token |
| `onChange(path, hook)` | one path, when it moves, with both values |
| `removeHook(token)` | `true` if it was there |

## Remote stores

| Call | |
|---|---|
| `setRemote(fetch, described?)` | a store: a **synchronous** function answering `{ text, format }` |
| `await refreshRemote()` | fetch into the remote layer |
| `clearRemote()` | drop what it gave |
| `remoteDescription` | what the store calls itself |
| `remoteStatus()` | `{ reachable, fetches, consecutiveFailures, lastFailure }` |

## Diagnostics

| Call | Answers |
|---|---|
| `sourceOf(path)` | `{ kind, detail }` — which layer wins the next load, and from where |
| `isSet(path)` | whether anything supplies it |
| `explain(path)` | every layer's answer for one path, as a table |
| `check()` | `{ rendered, isClean, unknown, unknownChecked, failure }` |
| `snapshot()` | `{ generation, document, loadedAtAgoMs }` |
| `status()` | `{ key, generation, consecutiveFailures, lastReason, lastFailure }` |

## Testing

```ts
const answer = await config.overrides({ host: "pinned" }, async () => {
  return await somethingThatReads()
})
```

Pins values for the duration of the block and puts back what it found —
so a nested block does not drop the outer one's pin on the way out. No
filesystem and no environment involved.

## `DynamicConfigError`

Thrown by every call that can fail.

| Field | |
|---|---|
| `kind` | `"io"`, `"parse"`, `"missing"`, `"type"`, `"env"`, `"invalid"`, `"remote"`, `"auth"`, `"decrypt"`, `"backend"` |
| `path` | the dotted key path, or `""` when the failure is the load's |
| `originKind` | `"file"`, `"env"`, `"inline"`, `"remote"`, `"runtime"`, `"unknown"` |
| `origin` | the file, the variable, the store — whatever `originKind` names |

The same words the Rust `ErrorKind` and the Python exception hierarchy
use, so the same condition is called the same thing in all three.

## Module functions

| | |
|---|---|
| `zodValidator(schema)` | `(document) => schema.parse(document)` |
| `ajvValidator(compiled)` | the same for a validator that answers `false` |
| `packageVersion()` | this package's version |
| `engineVersion()` | the Rust crate it was built against |
