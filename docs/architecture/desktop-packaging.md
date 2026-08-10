# Desktop packaging

## Artifacts

Electron Forge builds three JavaScript targets: Main, preload and the ESM
utility runtime `runtime.mjs`. The runtime bundle includes ADK, the official
provider SDKs and MCP dependencies so it does not depend on workspace-linked
`node_modules` after packaging.

Before development start or packaging, `scripts/build-desktop-native.mjs`
builds `crates/desktop-native` for the host platform and places
`sugarcode-desktop-native.node` under `apps/desktop/native`. Forge copies that
module as an extra resource outside `app.asar`. The Forge `prePackage` hook is
the authoritative release build entry, so `package`, `make` and `publish` do
not depend on a previously generated ignored native artifact.

The TypeScript runtime intentionally bundles the official `@google/adk` root
entry with its runtime dependencies. This favors upstream-compatible behavior
over a smaller packaging-only deep-import surface.

The final application must contain:

- the Electron application and `app.asar`;
- the application icon resources;
- the host-platform `sugarcode-desktop-native.node` capability module;
- `THIRD_PARTY_NOTICES.txt` for bundled native and model SDK dependencies.

macOS uses the stable `com.simonf.sugarcode` bundle identifier and currently
produces both DMG and ZIP artifacts. Development releases use a complete
ad-hoc signature so local integrity verification succeeds, but they are not
notarized and must not be represented as Developer ID signed releases.

It must not contain a `sugarcode` executable, CLI manifest, app-server,
PTY sidecar executable or `sugarcode-sidecar` directory. The native terminal
crate exposes only the embedded PTY API used by the N-API module; it has no
stdio/JSONL entry point.

## Platform contract

Native modules are built and packaged on the target operating system. macOS and
Windows CI run Rust formatting/checks/tests, the Desktop TypeScript suite and a
Forge package build. Packaging does not contact a model provider.

Renderer cannot select a native path, executable, argv, environment or utility
entry point. Main resolves all packaged resources from trusted application
paths; the worker loads only the packaged native module.
