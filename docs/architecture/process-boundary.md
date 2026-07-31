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

### Built-in Agent instructions

`builtInSugarCodeAgentInstructionsV1` is fixed English product behavior compiled
into Core and shared by app-server, headless exec and TUI. Every model-backed
Turn places it first in the provider-neutral instruction list and reuses the
same content on every provider round. The OpenAI-compatible Chat Completions
adapter emits it as the first `developer` message.

The built-in instruction owns SugarCode identity, truthful capability use,
approval and safety boundaries, engineering workflow and final reporting. It
also states the current runtime facts: a provider round contains final assistant
text or an ordered tool-call batch, a tool-call batch may have one bounded
process-text preamble, and recoverable tool errors return to the model. One Turn
may continuously alternate the actual workspace, shell, MCP and collaboration
tools until final text or a terminal boundary. MCP retains a separate maximum
of four calls per Turn.

Root-to-scope `AGENTS.md`, Skill inventory and selected Skill bodies follow the
built-in instruction. They may customize repository and task behavior but
cannot redefine product identity, actual tool availability, approval
requirements, security boundaries or permissions. Compaction, completed
history and current input follow all developer instructions.

The exact built-in prompt bytes participate in the 3 MiB compaction target and
4 MiB provider hard limit. The prompt is neither configurable nor durable: it
does not enter rollout, projections, public DTOs, protocol fixtures or Desktop
state.

Before every provider round, Core counts instructions, effective messages and
the currently exposed tools. Above 3 MiB it sends an internal no-tools request
using fixed `SUGARCODE_ACTIVE_TURN_COMPACTION_PROMPT_V1`. The same model
produces a bounded semantic checkpoint, recent complete ToolCall/ToolResult
pairs remain verbatim where possible, usage accumulates into the original Turn
and execution continues in-process. A request above 4 MiB, a summary above
32 KiB or a result that cannot return below 3 MiB fails with `outputTooLarge`.

The checkpoint summary is private rollout state. Public `contextCompaction`
Items contain only strategy, ordinal, byte counts, SHA-256 values and outcome.
Logs, Debug output, search, Desktop state and generated protocol artifacts never
contain the summary body. Later Turns rebuild effective history from the latest
checkpoint plus retained and subsequent Items. Restart marks an unfinished
checkpoint Interrupted and never calls the model to reconstruct it.

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
  -> persist turnItemStarted
  -> item/started notification
  -> persist turnItemCompleted
  -> item/completed notification
  -> repeat for every Item
  -> persist exactly one metadata-only terminal state
  -> terminal notifications
```

`turnStarted` contains Turn metadata but no duplicated Item array.
`turnCompleted` contains status, error and usage but no duplicated Item array.
Replay reconstructs the Turn from the incremental Item records. Fork writes the
same lifecycle shape atomically with remapped IDs. Development-era rollout v1
files using the former terminal-snapshot shape are intentionally incompatible.

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

One provider round may durably contain an ordered `ToolCallBatch`. The
OpenAI-compatible adapter assembles interleaved streaming fragments
independently by `tool_call.index`, rejects malformed, duplicate or
non-contiguous indices, and reconstructs completed calls as one assistant
tool-call message on later rounds and restart. Core validates every call before
executing any member. An all-read-only batch runs with a maximum concurrency of
four; mixed, shell, approval, write or unknown-effect batches execute in model
order. Results always return in model order, while one independent read failure
does not cancel its siblings.

On tool-capable rounds the adapter temporarily buffers no more than 512 bytes
of initial assistant text for one total window of no more than 250 ms; arriving
text fragments do not renew that deadline. When a tool call follows within that
boundary, Core persists the text as an `AgentCommentary` Item immediately
before the call and Desktop renders it as process text. Historical replay
reconstructs commentary and its consecutive calls as one provider assistant
message with `content` plus `tool_calls`. Commentary is included in provider
context and compaction input, but excluded from Thread search. When no tool
follows within the byte or time boundary, the buffer begins streaming as
ordinary assistant text. Once text has been committed as an answer, a later
tool call remains unsupported rather than being reclassified.

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
Opening or restoring a workspace populates the active Thread index but leaves
the transcript unselected. Historical content is resumed only after an explicit
user selection. A runtime restart within the same Desktop session may resume
the currently selected Thread so process recovery does not discard active UI
context.

Subagent Threads carry optional durable origin metadata naming the parent
Thread, parent Turn, orchestration, task and role. They are excluded from
ordinary list/search navigation and their lifecycle events are not projected as
independent conversations. `thread/descendants/list` is the only public
discovery path for restoring a parent's hidden execution graph. Existing
rollout v1 Threads without origin remain root Threads and require no migration.

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
Conversation projections from the retiring runtime remain unavailable audit
state and cannot update the target scope's remembered Thread index. A target
without an explicitly preferred Thread clears the prior scope's selected
transcript before the replacement becomes ready.

Desktop exposes project work and chats as separate navigation scopes. Project
runtime replacement uses the user-selected root and its exact workspace
binding. A chat remains durably workspace-unbound, but Desktop may start that
chat with one isolated file root under
`Documents/SugarCode/YYYY-MM-DD/<chat>`. The hidden CLI launch mode exposes
that root to bounded workspace capabilities while explicitly selecting an
unbound rollout repository; it does not turn the chat directory into a project
binding. Each chat has its own directory, and switching chats restarts the
runtime with the selected chat directory before resuming its Thread.

Electron Main owns the remembered project root, chat-to-directory mapping and
active scope. Preload and Renderer receive only the active kind, minimized
names and bounded Thread identities; absolute project and chat paths never
cross preload. The rollout repository still admits only Threads whose optional
workspace binding exactly equals the selected repository binding: project
runtimes cannot see unbound or foreign-project Threads, while chat runtimes
list and resume only unbound root Threads.

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

## 7.1. Workspace concurrency

Core owns one fair workspace read/write permit shared by root and child Agent
tools:

- any number of admitted `readOnly` child tasks may run together, subject to
  the four-task scheduler limit;
- a `workspaceWrite` child holds the exclusive permit for its complete Turn;
- root workspace and shell calls acquire the same permit for the duration of
  their operation;
- queued cancellation is checked again after scheduler admission, so an
  interrupted task cannot start later.

The permit coordinates SugarCode runtime activity; it does not claim isolation
from the user, another process or ambient Desktop terminal authority.

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
  -> next provider round
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
one call per provider round and at most four sequential calls per Turn. At the
four-call boundary Core removes MCP definitions only; workspace and shell tools
may continue.

Desktop Main owns enablement, restart, approval correlation and rollback of a
failed session transition. Renderer sees server ID, transport, callable
identity, canonical bounded arguments and minimized result receipts; it never
sees executable paths, cwd, environment, endpoint credentials or raw result
content.

Historical MCP Items remain audit only. Restart never relaunches or re-approves
them.

## 9.1. Conditional multi-Agent orchestration

Collaboration tools are model-visible on root Turns:

- `collaboration/dispatch` validates and atomically admits a task DAG wave;
- `collaboration/amend` appends an immutable bounded Markdown revision;
- `collaboration/wait` waits for selected tasks or the complete DAG and returns
  bounded public status/results;
- `collaboration/interrupt` cancels selected tasks.

The root Agent chooses whether to dispatch. A parent Turn owns at most one
orchestration, may extend it with later waves, permits at most 12 tasks and four
concurrent executions, and cannot complete while accepted tasks remain
non-terminal. Child Threads cannot call collaboration tools, so grandchildren
are impossible.

Every task envelope has a client key, title, role, access class, dependencies
and a frozen Markdown task containing `Objective`, `Context`, `Scope`,
`Constraints`, `Deliverables`, `Acceptance criteria` and `Report format`.
Children receive fresh model context: the fixed SugarCode instruction,
workspace instructions/Skills, this task, bounded dependency results and
amendments delivered at the next model-round boundary. They do not inherit the
parent conversation or private reasoning.

Ordinary nodes start only after all dependencies succeed. Auditors start after
all dependencies terminate so they can inspect a partially failed workspace.
Any dispatch wave containing a writer must include a read-only Auditor
depending on all writers in that wave or the whole wave is rejected. The
Auditor uses a fresh context and fixed Markdown report headings. A root Turn
may run the initial audit and one repair re-audit; a second failed audit is
reported rather than automatically looping again.

Parent interruption cascades to descendants. Approval requests identify the
origin task and role. Restart marks unfinished parent and child Turns
Interrupted and never replays, resumes or retries their operations.

## 10. Desktop workbench boundary

OpenAI-compatible model endpoints accept explicit HTTP or HTTPS URLs ending in
`/chat/completions`. Desktop shows an inline plaintext-transport warning for
HTTP but does not override the selected scheme. It exposes one optional API-key
input, uses the internal `model-api-token` reference for newly entered keys and
never reveals a stored key. An empty input preserves an existing key or selects
an unauthenticated endpoint when no key is configured. The streaming adapter
accepts usage events with either an empty `choices` array or one index-zero
choice whose delta and finish reason are empty; any content in that post-finish
choice remains a protocol error.

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

Renderer subscribes to Workspace state once and orders snapshots by their
Main-owned revision in a Zustand vanilla projection. Navigation, explorer,
preview and terminal domain hooks consume selectors over that projection rather
than opening independent IPC subscriptions. The projection is disposable
presentation state: it does not persist workspace authority, Thread history or
native capability state. Workspace-local explorer state resets only when the
Main-owned generation changes.

Desktop composes one responsive three-pane shell: durable Thread navigation on
the left, the independently scrolling conversation and in-flow composer in the
center, and a `Workspace | Agent` Context Rail on the right. The composer
participates in layout instead of overlaying the transcript. Appearance, model,
workspace Skill guidance and MCP controls share one Renderer-owned settings
dialog; moving these controls does not change Main or preload authority.
Workspace Skills remain file-backed and read-only in Desktop.

On wide viewports both pane boundaries are draggable and keyboard adjustable
within bounded widths, and both side panes are independently collapsible. Pane
widths and visibility are best-effort Renderer presentation state only. The
left navigator starts an unpersisted new-Thread draft explicitly, shows
`Projects` and `Chats` as peer sections, keeps their remembered indexes stable
while Main replaces a runtime, and exposes no Thread-search control. Project
and Thread navigation rows use non-button presentation elements while explicit
new, fork, archive and delete operations remain buttons. A selected Thread
retains its ordinary task/chat title and uses background alone for visible
selection. While a Thread resume is pending, that background follows the target
Thread so completion does not cause a second visible selection change. Renderer
does not synthesize a selected row outside the remembered index. Entering Chat
preserves the user's Project Thread expansion choice. The Project disclosure
control only expands or collapses that remembered list and never changes runtime scope;
activating the Project name resumes the remembered project scope. Chat rows
activate their own isolated directory and resume an unbound Thread. The
Workspace rail renders the active project's or chat's bounded file tree
directly; Git, preview and terminal remain separate explicit capabilities.

An intentional sidecar replacement moves conversation actions into an
unavailable phase without presenting it as a connection-loss failure. If that
replacement fails or the transport closes unexpectedly, the ordinary
connection-loss notice is still published. The compact CLI/JSONL connection
state lives in one global bottom status bar, not at the bottom of the Context
Rail. The main BrowserWindow hides native title-bar content while retaining
platform window controls and a bounded draggable strip.

Only a parent Turn containing durable Agent task Items renders an inline
orchestration graph. React Flow and Dagre project the stable app-server DTOs
through a Desktop-owned view model into layered Main Agent, Explorer, Worker
and Auditor nodes. Active paths animate, `prefers-reduced-motion` disables all
movement, and completed history stays static and keyboard-selectable. Selecting
a node opens the Agent rail with only public role, access, status, frozen task,
chronological amendments, public activity, duration, result and audit
findings. Private reasoning, hidden prompts and raw provider output never enter
the view model.

Selecting a Thread positions its independent conversation viewport at the
latest durable content. Subsequent streaming continues to follow the tail only
while the reader remains near the bottom; manually scrolling upward preserves
the reader's position until a new user message or Thread selection resumes
following.

Desktop projects every read-only call in an ordered parallel batch as an
independent in-flow activity, including repeated calls to the same workspace
tool. Live notification correlation and durable recovery match results by call
ID rather than assuming one current read, list or search activity. Renderer
groups consecutive workspace reads, lists, searches, file changes, non-pending
commands and MCP calls into a compact collapsible process log without changing
their independent durable identities or chronology. File diffs remain
individually expandable. Renderer places commentary and those nested tool
groups inside one Turn-level process disclosure; both disclosure levels default
collapsed and use compact expanded spacing. A pending command or MCP approval
opens the Turn-level disclosure automatically so the action stays visible.

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
terminal outcomes from provider-neutral Core events. Active semantic compaction
appears as `Compacting context…` followed by completed, failed or interrupted
status without revealing checkpoint text.

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
