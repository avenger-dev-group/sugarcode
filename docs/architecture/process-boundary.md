# Desktop and CLI process boundary

SugarCode is one source repository with two independently testable products:

- `apps/desktop`: Electron main, preload and renderer processes.
- `crates/cli`: the Rust package that builds the `sugarcode` executable.
- `crates/core`, `crates/tui`, `crates/exec` and `crates/app-server`: reusable
  Rust packages behind the terminal, headless and Desktop surfaces.

Desktop will launch the exact CLI binary bundled in its application resources:

```text
Electron renderer
  -> constrained preload API
  -> Electron main
  -> child_process.spawn("sugarcode", ["app-server", "--stdio"])
  -> Rust Agent Core
```

The app-server transport will be bidirectional JSONL over stdin/stdout. Stdout
is protocol-only and stderr is diagnostic-only. The Electron renderer will not
receive direct filesystem, shell or arbitrary RPC access.

Rust protocol types will be the source of truth. A repository build will
generate a TypeScript protocol package for Desktop, then run an end-to-end test
against the same CLI artifact that is placed in the Desktop package. Desktop
and its bundled CLI therefore move atomically even if the standalone CLI later
uses an independent release version.
