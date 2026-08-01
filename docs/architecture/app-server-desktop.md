# App-server and Desktop boundary

## Transport

Desktop Main starts the bundled matching executable as:

```text
sugarcode app-server --stdio
```

Transport is bidirectional JSONL. Stdout is protocol-only; stderr is bounded
diagnostics. Initialization verifies product version, protocol version,
platform and capabilities before ready-state methods are admitted.

Rust definitions in `crates/app-server-protocol` are the source of truth.
Generated TypeScript, JSON Schema and affected fixtures change together. Public
types are provider-neutral and protocol version remains 1.

## Public v1 lifecycle

`turn/start` accepts ordered content parts and may omit text when attachments
exist. `asset/import` accepts bounded Base64, validates through the state content
store and returns a descriptor for later Turn input.

ToolCall contains call ID, SugarCode tool name and JSON arguments. Validation
failure is its own `toolValidationRejected` Item. `FileChange`, approvals,
execution attempts and results remain independent durable Items. Unknown fields
or broken lifecycle correlation fail closed.

Provider errors expose only retryability plus optional HTTP status, provider
code, request ID and retry-after. A consumer disconnect interrupts the Turn.
An app-server/Desktop contract mismatch transitions the connection to a
diagnostic state; it is not mapped to `stateUnavailable`.

## Desktop ownership

Electron Main owns:

- sidecar process and JSON-RPC correlation;
- validated conversation and Thread projections;
- model configuration commands;
- workspace and native file pickers;
- attachment reads and `asset/import`;
- MCP session replacement and approvals;
- Git, preview window and PTY/ConPTY terminal.

Preload exposes fixed validated operations and minimized snapshots. Renderer
owns presentation state only and receives no executable path, environment,
absolute workspace path or raw native capability.

Desktop starts project and isolated chat roots with bounded structured file
writes. Shell workspace write remains a separate explicitly approved policy.
Runtime replacement is Main-owned and cannot let events from the old scope
update the new projection.

## Composer and transcript

The composer supports file selection, drag-and-drop and pasted images.
Attachment cards are visible before send; image descriptors render thumbnails
where bytes are locally available, while durable transcript cards use the
public descriptor. Import occurs before Turn submission and partial import
failure does not start a Turn.

The transcript correlates every activity by call ID, including parallel or
repeated read tools. File changes remain individually reviewable. Public
validation Items keep the connection alive and need no empty-path ToolCall
special case.

## Desktop validation and CI

Main validates every app-server message before projection. Rust schema is the
single structural source; Desktop adds semantic bounds needed by its view
model. Node tests cover these boundary validators and run under
`pnpm check` with lint and TypeScript checking.

Native package smoke runs on macOS, Linux and Windows and uses the copied
sidecar. It verifies version pairing, handshake and isolated local capabilities
without contacting a provider. See `desktop-cli-packaging.md` for package and
release boundaries.
