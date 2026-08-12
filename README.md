# SugarCode

SugarCode is an Electron coding workbench with a TypeScript Agent runtime and
a Rust native capability layer.

## Structure

```text
apps/desktop/  Electron application and Agent runtime
crates/        Rust persistence, tools, sandbox, Git and terminal support
scripts/       Native-module build and packaging utilities
```

## Requirements

- Node.js 22.23.1
- pnpm 10.30.2
- Rust 1.96+

## Setup

```bash
pnpm install
pnpm dev
```

## Checks

```bash
pnpm check
```

## Packaging

```bash
pnpm desktop:package
pnpm desktop:make
```

Desktop releases automatically include an update manifest containing the
version, platform artifact names, file sizes, and SHA-256 checksums. No
additional release credentials are required beyond the GitHub Actions token.
