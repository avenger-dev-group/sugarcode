# SugarCode

SugarCode is a monorepo for the Electron desktop application and the Rust
coding-agent runtime that will power both Desktop and the standalone CLI.

## Repository layout

```text
apps/
  desktop/          Electron Forge application
crates/             Rust CLI, Agent Core and app-server packages
packages/           Generated/shared TypeScript packages
protocol-fixtures/  Cross-language app-server fixtures
docs/architecture/  Architecture decisions
scripts/            Repository and release automation
```

The Rust implementation is not started yet. The current repository establishes
the workspace boundaries and preserves the existing Electron scaffold.

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
planned Desktop/CLI boundary.

## Implementation plan

Read [`docs/PLAN.md`](docs/PLAN.md) before starting a new planning or
implementation session. It records accepted decisions, current baseline,
phase-by-phase acceptance criteria and a reusable Plan-mode prompt.
