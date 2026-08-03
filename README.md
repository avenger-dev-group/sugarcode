# SugarCode

SugarCode is a monorepo for an Electron coding workbench and a native Rust
coding-agent runtime shared by Desktop and the standalone CLI.

## Repository layout

```text
apps/
  desktop/          Electron Forge application
crates/             Rust CLI, Agent Core and app-server packages
packages/           Generated/shared TypeScript packages
protocol-fixtures/  Cross-language app-server fixtures
docs/architecture/  Current process and packaging contracts
scripts/            Repository and release automation
```

The native binary exposes:

```text
sugarcode                 interactive terminal TUI
sugarcode exec            headless execution
sugarcode app-server      local JSONL server for Desktop and IDE clients
```

Desktop builds and bundles the matching CLI from the same repository revision.

## Desktop development

Requires Node.js 22+ and pnpm 10+.

```bash
pnpm install
pnpm dev
```

Quality checks:

```bash
pnpm check
```

Create an unpacked application or platform installer:

```bash
pnpm desktop:package
pnpm desktop:make
```

Optional live-provider smoke accepts one or more saved profile IDs. Run it
separately for OpenAI, Anthropic and a compatible gateway before a
release:

```bash
pnpm smoke:provider -- PROFILE_ID [PROFILE_ID ...]
```

Architecture contracts are split by stable boundary:

- [model protocol](docs/architecture/model-protocol.md);
- [Runtime and persistence](docs/architecture/runtime-persistence.md);
- [tools and workspace authority](docs/architecture/tools-workspace.md);
- [app-server and Desktop](docs/architecture/app-server-desktop.md);
- [model catalog](docs/architecture/model-catalog.md);
- [Desktop CLI packaging](docs/architecture/desktop-cli-packaging.md).

SugarCode is still under development. All config, rollout, app-server and
Desktop contracts remain version 1, but their v1 shapes may be replaced in
place. No compatibility reader or automatic deletion of local SugarCode data
is provided.
