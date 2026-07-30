# Desktop and CLI process boundary

This document describes the current ownership, transport and authority
boundaries shared by SugarCode Desktop, app-server, headless exec and TUI.

## 1. Runtime topology

SugarCode exposes three surfaces over one Rust runtime:

```text
Electron Renderer
  -> constrained preload
  -> Electron Main
  -> bundled sugarcode app-server --stdio
  -> AgentSurfaceRuntime
  -> Core

sugarcode exec
  -> AgentSurfaceRuntime
  -> Core

sugarcode
  -> Ratatui TUI
  -> AgentSurfaceRuntime
  -> Core
```

`crates/agent-runtime` owns surface-neutral composition:

- configuration and credential resolution;
- provider construction;
- workspace, tool, sandbox and MCP composition;
- durable repository and Core startup;
- one in-process session over provider-neutral Core events and approvals;
- interruption and shutdown.

`crates/app-server` maps that session to public JSON-RPC. It does not become the
application boundary for exec or TUI.

## 2. Ownership

| Component | Owns | Must not expose |
|---|---|---|
| Core | Thread/Turn/Item lifecycle, durable-first ordering, Agent loop | Provider SDK or Desktop types |
| Agent runtime | Process-local composition and session lifecycle | Public JSON-RPC policy |
| App-server | Initialization, request routing, public DTO mapping, correlation | Core-internal or provider types |
| Electron Main | CLI process, Desktop projection, native capabilities and IPC admission | Raw authority to Renderer |
| Preload | Fixed validated snapshots and actions | Node, process, filesystem or raw RPC |
| Renderer | Presentation and local view state | Native capability ownership |
| Exec | Stable human/JSONL automation output and exit codes | App-server transport as an internal dependency |
| TUI | Terminal presentation, input, approvals and restoration | App-server transport as an internal dependency |

## 3. App-server transport

Desktop starts:

```text
sugarcode app-server --stdio
```

The transport is bidirectional JSONL over stdin/stdout:

- stdout contains protocol envelopes only;
- stderr contains bounded diagnostics only;
- one bounded writer queue and one writer task serialize and flush stdout;
- requests are correlated by JSON-RPC ID;
- a writer stalled for 30 seconds fails the transport;
- stdin EOF initiates interruption, Core-event draining, writer closure and
  stdout flush before exit.

Initialization is:

```text
Desktop -> initialize
Desktop <- initialize result
Desktop -> initialized
```

The result verifies product version, protocol version, server identity,
platform and negotiated capabilities. Ready-state methods are rejected before
the acknowledgement.

## 4. Durable lifecycle ordering

Rollout records are authoritative. Public responses and notifications never
precede the durable transition they describe.

For a normal Turn:

```text
persist turnStarted
  -> return turn/start response
  -> item lifecycle notifications
  -> persist exactly one terminal state
  -> terminal notifications
```

`turn/interrupt` remains pending until the active task has stopped and persisted
its terminal state. Terminal notifications are written before the empty
interrupt response.

Each Item follows:

```text
item/started
  -> optional item-specific deltas
  -> item/completed
```

On restart, unfinished Turns recover as Interrupted. Recovery never fabricates
a ToolResult, replays a filesystem change or retries an external call.

## 5. Thread and projection boundary

- Rollout JSONL is the only durable Thread/Turn/Item source.
- SQLite discovery and FTS search are rebuildable projections.
- List and search expose active Threads only.
- Archive/unarchive/delete are append-only lifecycle transitions.
- Delete is terminal.
- Fork copies completed history with new IDs and no shared future state.
- Desktop rebuilds its transcript from a validated public Thread snapshot.
- Search indexes only completed AgentMessage text.

Desktop Main owns list, search, resume, fork, archive, unarchive and delete
transactions. Renderer may submit only bounded queries or IDs already present
in its validated snapshot. Main rejects navigation or mutation when it would
race an active Turn, approval, reconnect or another lifecycle operation.

## 6. Workspace authority

Workspace authority originates in one explicit absolute directory selected by
the user or CLI caller. Rust opens it through capability handles and derives an
optional relative active scope.

The same authority feeds:

- root-to-scope `AGENTS.md` instructions;
- local Skill discovery;
- workspace read/list/search/apply-patch;
- command cwd;
- MCP local-process discovery;
- exact-root Git operations;
- Desktop explorer and inspector.

Absolute roots do not cross preload. Desktop stores a permission-restricted
session binding and exposes only minimized identity, generation and basename.
Workspace replacement is a Main-owned transaction: stop incompatible work,
close dependent surfaces, start the replacement sidecar, validate its binding
and resume only a matching Thread.

## 7. Workspace tools

Structured tools use workspace-relative UTF-8 paths and explicit budgets:

- `workspace/read`: one stable regular file;
- `workspace/list`: one non-recursive directory level;
- `workspace/search`: bounded literal UTF-8 content search;
- `workspace/apply-patch`: one existing UTF-8 regular-file update.

They reject traversal, symlinks, Windows reparse points, unsupported file types
and observed identity changes. Search does not invoke host `rg` or consume Git,
shell or ignore configuration.

Apply-patch persists a bounded `FileChange` before the filesystem commit
barrier. A matched success ToolResult is the application receipt. Missing
result after the proposal is outcome-unknown; restart never retries or rolls
back.

Desktop inspector content is disposable Renderer state. It does not enter
conversation state, rollout, diagnostics, search or a cross-file cache.

## 8. Command approval and sandbox

`shell/exec` accepts:

- an absolute executable path;
- an exact bounded argv vector;
- cwd fixed to the active workspace scope;
- a minimal environment;
- no shell string, interpolation, globbing, `PATH` lookup or interactive stdin.

Approval uses a server-to-client JSON-RPC request:

```text
durable ToolCall
  -> durable approval request Item
  -> requestApproval
  <- approved | denied
  -> durable decision Item
  -> durable execution-attempt Item
  -> optional supervised process
  -> durable ToolResult
  -> final provider round
```

Every request is once-only, expires after 120 seconds and creates no persistent
policy. Missing capability, malformed response, Renderer loss, disconnect or
expiry fails closed.

The supervisor owns process-tree cancellation, concurrent bounded stdout/stderr
drain and timeout. Production execution requires:

- Linux: `filesystemReadOnlyV1 + networkDeniedV1`;
- macOS: `filesystemReadOnlyV1 + networkDeniedV1`;
- Windows: tool omitted because the composite network-deny contract is
  unavailable.

Linux may explicitly add `commandWorkspaceWriteV1`. It keeps network denial,
limits filesystem writes to the opened workspace and requires an informed
non-transactional risk acknowledgement. Attempt-without-result means writes may
have occurred.

## 9. MCP boundary

MCP starts disabled in Desktop. Configuration alone does not grant tool-call
authority.

Supported selections are:

- at most two explicitly configured local stdio servers; or
- one literal-loopback Streamable HTTP server.

Startup freezes and hashes each bounded inventory. Each approved call reconnects
or revalidates against that inventory before `tools/call`. The Agent loop allows
one call per provider round and at most four sequential calls per Turn.

Desktop Main owns enablement, restart, approval correlation and rollback of a
failed session transition. Renderer sees server ID, transport, callable
identity, canonical bounded arguments and minimized result receipts; it never
sees executable paths, cwd, environment, endpoint credentials or raw result
content.

Historical MCP Items remain audit only. Restart never relaunches or re-approves
them.

## 10. Desktop workbench boundary

Main owns all native or process authority:

- app-server process and conversation projection;
- model configuration and OS credential commands;
- MCP registry and session replacement;
- workspace picker and replacement;
- Git status/diff/stage/unstage/commit;
- loopback preview window;
- PTY/ConPTY terminal.

Preload exposes fixed operations and validates both arguments and snapshots.
Renderer repeats presentation-level validation but is never the security
boundary.

The local Git engine:

- opens only an exact-root ordinary repository;
- uses vendored `libgit2`;
- rejects parent discovery, linked worktrees and unsafe repository states;
- uses opaque revisions for status, diff and mutation;
- never invokes system Git, hooks, filters, signing, credential helpers,
  remotes or network operations.

The preview window:

- accepts only explicit `http://127.0.0.1:<port>` or
  `http://[::1]:<port>` origins;
- requires native user confirmation;
- uses an isolated non-persistent partition;
- disables JavaScript, Node, preload, DevTools, permissions, downloads, popups
  and cross-origin requests;
- does not start or own the server.

The Desktop terminal:

- requires native user confirmation;
- runs the user's normal shell in the selected workspace;
- has the ambient authority of the Desktop process;
- is not an Agent tool or sandbox;
- cannot be created, confirmed or driven by model output;
- is terminated on workspace replacement, Renderer loss or app shutdown.

## 11. Headless exec

`sugarcode exec` starts or explicitly resumes one durable Thread and runs one
Turn through the in-process runtime.

- Human output and JSON Lines v1 are separate renderers.
- Diagnostics stay on stderr.
- Machine output omits credentials, environment, user text, raw command/MCP
  arguments and provider values.
- Command and MCP approvals are actively consumed and always denied.
- SIGINT enters durable interruption.
- Broken output interrupts and shuts down instead of retrying.
- Exit codes distinguish input, configuration, Turn failure, interruption,
  output failure and internal failure.

## 12. TUI

`sugarcode` without a subcommand starts Ratatui only when stdin and stdout are
terminals. Non-TTY automation must use `sugarcode exec`.

The TUI lists, creates, selects and resumes durable workspace-bound Threads. It
presents streaming text, tool activity, approvals, FileChange review and
terminal outcomes from provider-neutral Core events.

Command and MCP approvals default to deny. Terminal ownership restores raw mode,
alternate screen, bracketed paste and cursor state on normal exit, error,
Ctrl+Q and termination signals.

## 13. Non-negotiable invariants

- Provider SDK types remain private to provider adapters.
- Public protocol mapping remains in app-server.
- Renderer receives no raw native authority.
- Durable transitions precede corresponding public lifecycle.
- External operations are never replayed after uncertain recovery.
- Secrets never enter configuration, rollout, public protocol or diagnostics.
- Workspace, command, Git, MCP, preview and terminal authorities remain
  distinct.
