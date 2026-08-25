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

## Figma Desktop MCP

SugarCode can connect to Figma Desktop's local MCP server without browser
authorization or OAuth. See the [Figma Desktop MCP setup guide](docs/figma-desktop-mcp.md).

## Trusted project environments

Repositories can declare task setup, exported environment variables, and named
actions in `.sugarcode/project.json`:

```json
{
  "schemaVersion": 1,
  "setup": {
    "default": "pnpm install",
    "windows": "pnpm install"
  },
  "environment": {
    "default": "export APP_ENV=development",
    "windows": "$env:APP_ENV = 'development'"
  },
  "actions": [
    {
      "id": "verify",
      "label": "Verify",
      "command": {
        "default": "pnpm check"
      }
    }
  ]
}
```

Each script supports `default`, `macos`, and `windows`; the platform-specific
entry wins over `default`. SugarCode displays every resolved script before the
first execution and binds trust to the canonical repository path plus the exact
configuration SHA-256. Any content change requires trust again. Only exported
variables are captured; aliases, functions, Shell options, and `cwd` are not
retained. SugarCode never reads `.env` or automatically invokes direnv, Nix, or
devbox.

Tasks use the shared project directory by default. A task can opt into Worktree
mode in General Settings to receive a deterministic `sugarcode/*` branch and an
isolated directory. Agent tools, commands, project setup/actions, Git, and newly
created integrated terminals then use that task root. Existing Worktree files
and branches are intentionally retained when switching back to Local mode so
that user work is never deleted implicitly.

## Packaging

```bash
pnpm desktop:package
pnpm desktop:make
```

Desktop releases automatically include an update manifest containing the
version, platform artifact names, file sizes, and SHA-256 checksums.
Installers also include a minimal FFmpeg 9.0.1 executable built without GPL or
nonfree components. The exact upstream source archive and its SHA-256 checksum
are published beside every SugarCode release under the LGPL 2.1-or-later terms.

## Desktop releases and updates

The desktop application checks GitCode and GitHub together and selects the
highest available stable version, preferring GitCode when both sources publish
the same version. A release is downloaded silently to the user's Downloads
directory and verified against the manifest before the update button appears.
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

4. The local script downloads the three updater installers,
   `update-manifest.json`, and the corresponding FFmpeg source from GitHub,
   verifies their sizes and SHA-256 hashes, and uploads them to GitCode.
   Temporary files are kept under
   `release-assets/v3.0.3` for inspection or retry.
5. Confirm that GitCode Release contains the three installers,
   `update-manifest.json`, and both FFmpeg source files. macOS ZIP files remain
   on GitHub and are not copied because the updater does not use them.

Use `pnpm release:gitcode:local 3.0.3 --download-only` to download and verify
without changing GitCode. GitCode publishing is resumable: already uploaded
files are skipped, and the release is marked latest only after every required
file is present. No GitCode token is stored in GitHub Actions or bundled into
the desktop application.
