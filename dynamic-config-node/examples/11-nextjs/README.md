# Next.js

Two files, and the line between them is the whole example.

`config.ts` is typechecked in this repository's CI. The component below is
not: JSX needs `@types/react`, and what this example is *about* is the
boundary rather than the markup.

## The rule

**There is no configuration engine in the browser.** No filesystem, no
watcher, no store. What ships to a client is a snapshot somebody decided
to send, and deciding *which fields* is a security question rather than a
plumbing one — so it is written out field by field in `publicHalf`, as an
allow-list. A deny-list is a list somebody forgets to add to, and the
field they forget is the one that matters.

## The server component

```tsx
/**
 * A server component. `current()` is a property read, so this costs
 * nothing per render — and it is always the document in force, because the
 * watcher installs into the same object.
 */
export default async function Page(): Promise<JSX.Element> {
  const config = await appConfig();
  const app = config.current();

  // `publicHalf` is what crosses to the client. The full document —
  // `databaseUrl`, `stripeSecret` — stays on this side of the boundary,
  // and the type of what crosses says so.
  const forTheBrowser: PublicConfig = publicHalf(app);

  return (
    <main>
      <h1>{app.siteName}</h1>
      <Checkout config={forTheBrowser} />
    </main>
  );
}

/**
 * The client half. It takes `PublicConfig` and could not take the whole
 * document if it wanted to: a secret does not travel to a browser by
 * accident here, it travels because somebody widened this type.
 */
function Checkout({ config }: { config: PublicConfig }): JSX.Element {
  return <p>{config.features.newCheckout ? "the new checkout" : "the old one"}</p>;
}
```

See `../12-react/README.md` for the client half, and for what "live
updates in the browser" would actually mean.
