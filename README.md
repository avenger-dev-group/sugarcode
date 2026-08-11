# SugarCode

SugarCode 3.0 is an Electron coding workbench backed by a private TypeScript
Agent runtime and a Rust native module. It does not ship a standalone CLI,
TUI, headless exec surface or app-server.

## Repository layout

```text
apps/desktop/       Electron UI, Main adapters and TypeScript ADK runtime
crates/             Rust persistence, tools, sandbox, Git and PTY capabilities
docs/architecture/  Current runtime and packaging contracts
scripts/            Native-module build automation
```

## Development

Node.js 22+, pnpm 10+ and Rust 1.96 are required.

```bash
pnpm install
pnpm dev
pnpm check
```

Create an unpacked application or platform installer with:

```bash
pnpm desktop:package
pnpm desktop:make
```

The packaged application contains the bundled TypeScript utility runtime and
the platform `sugarcode-desktop-native.node` module. It contains no SugarCode
executable or local network service.

Architecture contracts:

- [Desktop runtime](docs/architecture/desktop-runtime.md)
- [Desktop packaging](docs/architecture/desktop-packaging.md)
- [Runtime persistence](docs/architecture/runtime-persistence.md)
- [Model protocol](docs/architecture/model-protocol.md)
- [Model catalog](docs/architecture/model-catalog.md)
- [Tools and workspace authority](docs/architecture/tools-workspace.md)

SugarCode 3.0 uses a new store under `~/.sugarcode/v3`; it does not read,
migrate or delete data from earlier versions.
