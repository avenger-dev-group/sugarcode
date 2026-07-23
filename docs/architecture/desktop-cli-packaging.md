# Bundling the Rust CLI with Desktop

SugarCode Desktop will ship the exact `sugarcode` executable built from the
same repository revision as the Electron application.

The intended release pipeline is:

1. Electron Forge receives the target platform and architecture.
2. A Forge build hook builds `crates/cli` in release mode for that target.
3. The build verifies that the binary reports the expected product and
   app-server protocol versions.
4. Electron Packager copies the binary as an extra resource outside `app.asar`.
5. The platform package signs the Electron application and its bundled binary.
6. An end-to-end smoke test launches the packaged binary with
   `app-server --stdio` and performs the initialization handshake.

At runtime Electron Main resolves the bundled executable from
`process.resourcesPath`, starts it with `child_process.spawn`, and communicates
through JSONL on stdin/stdout. The renderer never receives direct process,
filesystem or shell access.

The Electron scaffold does not perform this build yet because `crates/cli` has
not been implemented. The packaging hook must be added together with the first
real CLI binary so a Desktop package can never silently omit or reuse a stale
sidecar.
