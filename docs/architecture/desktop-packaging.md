# Desktop packaging

## Artifacts

Electron Forge builds three JavaScript targets: Main, preload and the ESM
utility runtime `runtime.mjs`. The runtime bundle includes ADK, the official
provider SDKs and MCP dependencies so it does not depend on workspace-linked
`node_modules` after packaging.

Before development start or packaging, `scripts/build-desktop-native.mjs`
builds `crates/desktop-native` for the host platform and places
`sugarcode-desktop-native.node` under `apps/desktop/native`. Forge copies that
module as an extra resource outside `app.asar`.

The final application must contain:

- the Electron application and `app.asar`;
- the application icon resources;
- exactly the host-platform `sugarcode-desktop-native.node` capability module.

It must not contain a `sugarcode` executable, CLI manifest, app-server,
terminal-bridge executable or `sugarcode-sidecar` directory.

## Platform contract

Native modules are built and packaged on the target operating system. macOS and
Windows CI run Rust formatting/checks/tests, the Desktop TypeScript suite and a
Forge package build. Packaging does not contact a model provider.

Renderer cannot select a native path, executable, argv, environment or utility
entry point. Main resolves all packaged resources from trusted application
paths; the worker loads only the packaged native module.
