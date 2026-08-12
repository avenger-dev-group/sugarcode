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

## Update signing

Desktop releases include an Ed25519-signed update manifest. Configure the
matching key pair in the GitHub repository before dispatching a release:

- Repository variable `SUGARCODE_UPDATE_PUBLIC_KEY_B64`: base64-encoded SPKI
  PEM public key embedded into packaged applications.
- Repository secret `SUGARCODE_UPDATE_PRIVATE_KEY_B64`: base64-encoded PKCS#8
  PEM private key used only by the release job.

Keep the private key outside the repository. The release workflow rejects a
missing, invalid, or mismatched key pair.
