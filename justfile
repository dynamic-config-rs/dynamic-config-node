# Everything CI runs, in the order that fails fastest.
#
# Two packages in one repository, and the second needs the first: the
# stores package hands documents to the base one, so `node-remote` links it
# the way npm would install it rather than testing against nothing.

# What cargo names a cdylib here. Node loads the addon under one name on
# every platform, so this is the only place the difference is spelled —
# and a contributor on macOS gets a build rather than a `cp` that cannot
# find a `.so`.
lib_prefix := if os() == "windows" { "" } else { "lib" }
lib_suffix := if os() == "macos" { ".dylib" } else if os() == "windows" { ".dll" } else { ".so" }

default: check

# The whole gate, locally. No npm install needed: the type check and the
# framework examples say so and skip rather than failing.
check: fmt lint node node-remote

# Formatting, as CI checks it.
fmt:
    cargo fmt --all -- --check

# Clippy with warnings denied. `--lib` on purpose: `#[napi]` expands into
# the crate's own lib target, and there is no test or bench target here
# for `--all-targets` to reach.
lint:
    cargo clippy --workspace --lib --all-features -- -D warnings

# The base package: the addon, its suite, the types a caller sees, and
# every runnable example.
node:
    cargo build -p dynamic-config-node
    cp target/debug/{{ lib_prefix }}dynamic_config_node{{ lib_suffix }} dynamic-config-node/index.node
    cd dynamic-config-node && node --test tests/*.test.js
    # Skipped with a word rather than failing when TypeScript is not
    # installed, because `npm install -D typescript` is a choice this
    # recipe should not make for a contributor who is fixing Rust.
    cd dynamic-config-node && if [ -x node_modules/.bin/tsc ]; then \
        node_modules/.bin/tsc -p tests/typing/tsconfig.json && \
        node_modules/.bin/tsc -p examples/tsconfig.json; \
      else \
        echo "skipping the type check: npm install -D typescript"; \
      fi
    # Three examples want a framework and say so rather than failing when
    # it is absent, so this needs no `npm install` — what it proves
    # without one is that they still start and exit.
    cd dynamic-config-node && for example in examples/*.mjs; do \
        echo "→ $example"; node "$example" > /dev/null || exit 1; \
      done

# The eight stores, as a second package. The suite constructs every store,
# checks that no description carries a credential, and drives the failure a
# store that is not there produces. A document actually arriving is the
# store crates' own container suites, in dynamic-config-remote.
node-remote:
    cargo build -p dynamic-config-node-remote
    cp target/debug/{{ lib_prefix }}dynamic_config_node_remote{{ lib_suffix }} dynamic-config-node-remote/index.node
    # The base package, linked the way npm would install it.
    mkdir -p dynamic-config-node-remote/node_modules
    ln -sfn ../../dynamic-config-node dynamic-config-node-remote/node_modules/dynamic-config-node
    cd dynamic-config-node-remote && node --test tests/*.test.js

# The book, the way the docs site builds it before publishing. Needs mdbook
# (`cargo install mdbook`).
book:
    mdbook build book
    test -f book/book/index.html
