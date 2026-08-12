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

It then creates one `update-manifest.json` and publishes all files to GitHub
Release. GitCode is published separately from a local computer, following the
SugarCode 1.0 release flow:

1. Open GitHub Actions, select **Build SugarCode Desktop**, choose the `main`
   branch, click **Run workflow**, and enter a SemVer version without `v`, such
   as `3.0.3`.
2. The workflow synchronizes the source version, creates `v3.0.3`, builds and
   verifies all three installers, and publishes the GitHub Release.
3. On a local computer, make sure GitHub CLI is installed and authenticated
   with `gh auth login`, then export a GitCode token that can manage releases in
   `Simoonf/SugarCode`:

   ```bash
   export GITCODE_TOKEN="your-token"
   pnpm release:gitcode:local 3.0.3
   ```

4. The local script downloads the three updater installers and
   `update-manifest.json` from GitHub, verifies their sizes and SHA-256 hashes,
   and uploads them to GitCode. Temporary files are kept under
   `release-assets/v3.0.3` for inspection or retry.
5. Confirm that GitCode Release contains the three installers and
   `update-manifest.json`. macOS ZIP files remain on GitHub and are not copied
   because the updater does not use them.

Use `pnpm release:gitcode:local 3.0.3 --download-only` to download and verify
without changing GitCode. GitCode publishing is resumable: already uploaded
files are skipped, and the release is marked latest only after every required
file is present. No GitCode token is stored in GitHub Actions or bundled into
the desktop application.
