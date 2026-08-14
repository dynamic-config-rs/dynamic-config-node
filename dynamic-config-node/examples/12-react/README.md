# React, and the honest version of this example

There is **no configuration engine in the browser**. This package is a
Node addon: it reads files, watches them, talks to stores and validates on
a worker thread. A browser has none of those things, and a bundler cannot
polyfill a filesystem.

So the React example is not "how to use dynamic-config in React". It is
how the two halves meet:

1. **The server** owns the configuration — `11-nextjs/config.ts` is that
   half, and it is a Next.js route, an Express handler or a tRPC procedure
   depending on your stack.
2. **The server decides what the browser may see**, field by field, and
   the type of what crosses says so (`publicHalf` in the same file).
3. **The browser holds a snapshot**, which is a value in a context — not a
   configuration object, and not something that reloads by itself.

```tsx
// app/providers.tsx — the client half, and all of it.
"use client"

import { createContext, useContext } from "react"
import type { PublicConfig } from "./config"

const ConfigContext = createContext<PublicConfig | null>(null)

export function ConfigProvider({ config, children }: { config: PublicConfig; children: React.ReactNode }) {
  return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>
}

export function useConfig(): PublicConfig {
  const config = useContext(ConfigContext)

  if (config === null) {
    throw new Error("useConfig must be used inside a ConfigProvider")
  }

  return config
}
```

**Live updates in the browser are a different feature**, and this package
does not pretend to have it. If you need one, the shape is: the server
subscribes with `onChange`, and pushes the public half down whatever
channel you already have — Server-Sent Events, a websocket, or a
revalidation. The configuration engine stays where the files are.

```ts
// The server side of that, in four lines.
config.onChange("features", (features) => {
  broadcast({ type: "config", features })   // your channel, not ours
})
```
