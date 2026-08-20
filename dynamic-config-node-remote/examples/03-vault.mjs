// Vault: the token is a function, because tokens expire.
//
// A server to point it at:
//
//     docker run --rm -d -p 8200:8200 \
//       -e VAULT_DEV_ROOT_TOKEN_ID=root hashicorp/vault:1.20
//     VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=root \
//       vault kv put secret/myapp/db db='{"host": "vault-db", "port": 6003}'
//
// Then `node examples/03-vault.mjs`.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DynamicConfig, DynamicConfigError } = require("dynamic-config-node");
const { Vault, useStore } = require("../js/index.js");

const ADDRESS = process.env.VAULT_ADDR ?? "http://127.0.0.1:8200";

const config = new DynamicConfig({ key: "db" });

// `tokenFn` over `token`: Vault leases tokens, an agent renews them,
// and a *function* is read on every fetch — so the store follows a
// rotation without being rebuilt. A literal `token` is for the dev
// server and nothing else.
const store = new Vault(
  ADDRESS,
  "secret",
  "myapp/db",
  null,
  "json",
  null,
  () => process.env.VAULT_TOKEN ?? "root",
);

console.log("store:", store.describe()); // the token is not in it

try {
  const handle = await useStore(config, store);

  console.log("fetched:", config.current());

  // Vault has no push API — refresh on the program's schedule. In
  // Kubernetes, the agent does this with `refreshSeconds`; here it is
  // one line on a timer the program already owns.
  await handle.refresh();
  console.log("refreshed: generation", config.generation);
} catch (failure) {
  if (failure instanceof DynamicConfigError && ["remote", "io", "auth"].includes(failure.kind)) {
    console.log(`no Vault at ${ADDRESS} (${failure.kind}) — start the container above`);
  } else {
    throw failure;
  }
}
