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
types. The unchanged MCP settings, session and approval APIs are also backed by
the utility runtime and ADK `MCPToolset`; enabling MCP no longer restarts the
CLI sidecar. Dynamic Agent tasks use the same existing orchestration UI while a
private provider-neutral tool surface drives persisted DAG scheduling, separate
child ADK invocations, amendments, waits and interruption in the utility
runtime.

Electron Main owns both process lifecycles, the native file picker, workspace
authority and validated projections. Preload exposes only fixed typed actions.
Renderer supports text, file selection, drag-and-drop and image paste. The
utility runtime imports those attachments into the v3 content-addressed store
before `turn.start` references their descriptors. Workspace/connection state
remains on app-server during coexistence. ADK command tools execute through the
native module: sandboxed direct commands are read-only/network-denied, while
Full Access shell commands require a persisted approval, stream bounded output
and support Turn cancellation. The unchanged terminal preload API now routes
through the utility runtime to an in-process Rust PTY/ConPTY implementation;
it no longer launches the CLI terminal bridge.
MCP configuration is revisioned in the v3 SQLite store. MCP starts disabled,
uses an explicitly selected compatible server set, hashes the discovered tool
inventory and persists every call proposal before showing the existing
approval UI.
Pending local-tool and MCP approvals survive a utility-worker or application
restart in SQLite. Runtime revalidates and re-presents the same approval ID; an
explicit approval atomically claims the operation before execution, while a
previously claimed side effect is failed and never replayed.

The public app-server contract is generated from Rust in
`crates/app-server-protocol`. Desktop validates every incoming v1 message at
the Main boundary. The utility-process command/event protocol is private to
Electron and independently provider-neutral. A protocol mismatch is a
connection diagnostic; it is not a durable Turn storage failure.
