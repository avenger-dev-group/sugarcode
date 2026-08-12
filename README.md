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
version, platform artifact names, file sizes, and SHA-256 checksums.

## Desktop releases and updates

The desktop application checks GitCode first and GitHub second. A release is
downloaded silently to the user's Downloads directory and verified against the
manifest before the update button appears. If GitCode is unavailable or its
release is incomplete, the application automatically retries against GitHub.
After repeated failures, the same button opens the GitCode releases page.

The release workflow builds these installers from one source revision:

- macOS Apple Silicon DMG
- macOS Intel DMG
- Windows x64 Setup executable

It then creates one `update-manifest.json`, publishes the same files to GitHub
Release, and mirrors the update files to GitCode Release. To publish a release:

1. Create a GitCode personal access token that can manage releases in
   `Simoonf/SugarCode` and save it as the GitHub repository Actions secret
   `GITCODE_TOKEN`. This is the only extra one-time configuration; no update
   signing key is used.
2. Open GitHub Actions, select **Build SugarCode Desktop**, choose the `main`
   branch, click **Run workflow**, and enter a SemVer version without `v`, such
   as `3.0.3`.
3. The workflow synchronizes the source version, creates `v3.0.3`, builds and
   verifies all three installers, and publishes both release platforms.
4. Confirm that both release pages contain the three installers and
   `update-manifest.json`. macOS ZIP files may additionally appear on GitHub,
   but they are not used by the updater.

The GitCode upload is resumable and safe to retry. If a run fails after the
GitHub Release is created, rerun the same workflow with the same version; files
already present in the GitCode prerelease are skipped before it is marked as
the latest release.
