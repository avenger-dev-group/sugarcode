# SugarCode Desktop

Electron Forge application for SugarCode.

Run commands from the repository root:

```bash
pnpm dev
pnpm check
pnpm desktop:package
```

This package will communicate with the bundled Rust `sugarcode app-server`
process through JSONL over stdio. It must not import or embed the Agent Runtime.

Electron Main owns the sidecar, native file picker, attachment import,
workspace authority and validated conversation projection. Preload exposes only
fixed typed actions. Renderer supports text, file selection, drag-and-drop and
image paste; attachments are imported through app-server `asset/import` before
`turn/start` references them.

The public contract is generated from Rust in
`crates/app-server-protocol`. Desktop validates every incoming v1 message at
the Main boundary. A protocol mismatch is a connection diagnostic; it is not a
durable Turn storage failure.
