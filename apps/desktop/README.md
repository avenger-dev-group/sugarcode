# SugarCode Desktop

Electron Forge application for SugarCode.

Run commands from the repository root:

```bash
pnpm dev
pnpm check
pnpm desktop:package
```

During the 3.0 migration this package runs both the bundled Rust `sugarcode
app-server` process and an internal TypeScript ADK utility process. Renderer and
preload remain provider-neutral: Electron Main routes model configuration,
attachment import, conversation/thread, approval-backed patch, Git and bounded
command requests to the utility runtime without exposing ADK or provider SDK
types.

Electron Main owns both process lifecycles, the native file picker, workspace
authority and validated projections. Preload exposes only fixed typed actions.
Renderer supports text, file selection, drag-and-drop and image paste. The
utility runtime imports those attachments into the v3 content-addressed store
before `turn.start` references their descriptors. Workspace/connection state
and terminal/PTY remain on app-server until their utility-runtime replacements
reach parity. ADK command tools execute through the native module: sandboxed
direct commands are read-only/network-denied, while Full Access shell commands
require a persisted approval and both modes support Turn cancellation.

The public app-server contract is generated from Rust in
`crates/app-server-protocol`. Desktop validates every incoming v1 message at
the Main boundary. The utility-process command/event protocol is private to
Electron and independently provider-neutral. A protocol mismatch is a
connection diagnostic; it is not a durable Turn storage failure.
