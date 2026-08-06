# Bundling the Rust CLI with Desktop

SugarCode Desktop ships the exact `sugarcode` executable built from the same
repository revision as the Electron application.

## 1. Resolution contract

Development and packaged resolution are intentionally separate.

Development:

- `pnpm desktop:start` first runs the locked development CLI build;
- Main resolves only the expected repository artifact;
- Main never searches ambient `PATH`.

Packaged:

- Main resolves only
  `process.resourcesPath/sugarcode-sidecar/bin/sugarcode[.exe]`;
- there is no repository, development-target, environment-variable or `PATH`
  fallback;
- missing, duplicate, stale, wrong-platform or invalid resources fail startup.

Renderer and preload never receive the executable path.

## 2. Forge pipeline

`apps/desktop/forge.config.ts` delegates sidecar work to
`apps/desktop/forge/packaged-sidecar.ts`.

The native package flow is:

```text
Forge prePackage
  -> require host platform/architecture match
  -> cargo build --release --locked -p sugarcode-cli
  -> verify sugarcode version output
  -> stage sidecar, manifest and notices outside app.asar

Electron Packager
  -> build app.asar
  -> copy staged sidecar resources
  -> apply Electron fuses

Forge postPackage
  -> inspect actual package output
  -> verify resource layout and uniqueness
  -> verify SHA-256 and manifest
  -> launch the copied CLI
  -> run native package smoke
```

The build uses an isolated target and staging directory. It never reuses a
floating external CLI.

## 3. Resource layout

The package contains one sidecar directory outside `app.asar`:

```text
resources/
├── app.asar
└── sugarcode-sidecar/
    ├── bin/
    │   └── sugarcode[.exe]
    ├── manifest.json
    └── THIRD_PARTY_NOTICES.txt
```

The schema-v1 manifest records:

- product version;
- app-server protocol version;
- platform and architecture;
- Rust target triple;
- executable relative path;
- SHA-256.

`postPackage` requires one executable and rejects unexpected resource layout.
On non-Windows hosts it also verifies executable permissions.

## 4. Version and protocol pairing

The CLI `version` output must match the generated protocol package constants:

```text
sugarcode <product-version>
app-server-protocol <protocol-version>
```

Runtime initialization repeats the compatibility check through public
app-server fields. A packaged Desktop therefore cannot silently start a CLI
with a different product or protocol version.

## 5. Runtime launch

Electron Main owns the child process:

```text
child_process.spawn(
  packagedCli,
  ["app-server", "--stdio", ...authorizedArguments],
  { shell: false, env: allowlistedEnvironment }
)
```

Main owns stdin, stdout, stderr, exit observation and shutdown. Stdout is
protocol-only JSONL. Stderr is bounded diagnostic input and is never forwarded
verbatim to Renderer.

Authorized optional arguments are assembled from validated Main-owned state,
including:

- SugarCode home;
- selected workspace and active scope;
- explicitly enabled MCP server IDs;
- bounded tool-policy flags.

Renderer cannot provide an arbitrary executable, argv, cwd or environment.

## 6. Environment

The sidecar receives an allowlisted environment sufficient for platform runtime
and temporary storage.

- `SUGARCODE_HOME` may point to the resolved SugarCode state directory.
- Windows receives required system and temporary-directory variables.
- macOS receives required home, locale and temporary-directory variables.

Provider tokens are never forwarded through environment variables, command
arguments, package resources or the sidecar manifest. New model API keys are
read from the permission-restricted local SugarCode configuration.

The sidecar resolves model configuration only when a Turn starts. Model
configuration and provider authentication failures therefore do not prevent
the packaged CLI from completing its protocol handshake or binding a selected
workspace. Model settings remain available for repair without replacing the
sidecar process.

## 7. Workspace and capability launch

Packaged Main starts workspace-free until the user selects a directory. Without
an explicit workspace:

- workspace tools are unavailable;
- command cwd authority is unavailable;
- Git and workspace-browser capabilities are absent;
- workspace instructions and local Skills are not discovered.

Workspace replacement starts a new sidecar with the exact canonical root,
validates the returned opaque binding and resumes only a matching durable
Thread.

MCP also starts disabled. Main may restart the sidecar with an explicit bounded
selection only after user action and capability validation.

## 8. Package smoke

The copied executable, not the build artifact, is used for smoke checks.
Current smoke covers:

- exact version output;
- app-server initialize/initialized handshake;
- deterministic headless exec routing and configuration error contract;
- non-TTY TUI routing;
- workspace browser and exact-root Git behavior in an isolated repository;
- Desktop terminal bridge and copied TUI launch in a real PTY/ConPTY.

The smoke uses isolated SugarCode home and workspace directories. It does not
contact an external model provider.

## 9. Native delivery

macOS and Windows CI run the relevant Rust, Desktop, Electron and Forge checks
on native hosts. Ubuntu/Linux is not currently a supported CI or packaging
acceptance target. Packaging acceptance must not be replaced by
cross-compilation alone because executable format, sandboxing, PTY/ConPTY and
Electron resource layout are platform-specific.

CI executes Desktop lint, type checks and boundary-focused Node tests through
`pnpm check`. Rust workspace tests, generated-protocol consistency and native
Forge package smoke remain acceptance gates.

## 10. Release work still deferred

Release engineering still owns:

- production signing identities and nested executable signing;
- notarization where required;
- installer/maker release validation;
- update metadata and atomic Desktop/CLI replacement;
- release-channel publishing and rollback;
- final crash-report redaction policy.

These concerns must preserve the existing invariant: Desktop and CLI are
verified and replaced as one compatible release unit.

## 11. 3.0 utility-runtime migration state

Branch `3.0` now builds a second Electron Main target, `runtime.js`, and starts
it with `utilityProcess`. Main sends an internal provider-neutral initialize
command over the utility-process parent port; the worker loads the platform
`sugarcode-desktop-native.node`, opens `~/.sugarcode/v3`, and reports a versioned
ready event. Main owns restart backoff, converts active Turns to retryable
interrupted events on a worker crash, and renumbers worker events onto one
monotonic process-lifetime sequence.

The native addon is built from `crates/desktop-native` before Desktop start or
package and is copied as a Forge extra resource. The four model/Agent packages
remain external to the worker bundle so their Node-targeted exports retain
their own module semantics inside the packaged application.

This is a coexistence checkpoint, not the final packaging contract. Model
configuration, conversation/thread projection, approval-backed atomic patches
and Git operations now reach the utility runtime through the existing Renderer
API. The CLI sidecar and app-server still own workspace/connection state,
attachment import and terminal/PTY behavior, while sandboxed commands, MCP and
dynamic multi-Agent parity remain incomplete. The sidecar, app-server and CLI
build hooks may be removed only after those remaining paths migrate and pass
native package smoke.
