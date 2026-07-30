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

See [the process architecture](docs/architecture/process-boundary.md) for the
Desktop/CLI boundary.

## Implementation plan

Read [`docs/PLAN.md`](docs/PLAN.md) before starting a new planning or
implementation session. It records accepted decisions, current baseline,
phase status, verification commands and the deferred release entry point.
