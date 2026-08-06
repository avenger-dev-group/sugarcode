# Desktop runtime boundary

## Process topology

```text
Renderer -> Preload -> Electron Main -> utilityProcess(runtime.mjs)
                                      -> Rust N-API native module
```

Main starts one local TypeScript worker with Electron `utilityProcess`. The
worker communicates only over Electron's parent port: it does not bind a local
port, expose JSON-RPC or start an external service. Main supervises startup,
bounded logs, monotonic event sequencing, crash backoff and active-workspace
restoration.

`RuntimeCommand` and `RuntimeEvent` are private discriminated unions. Requests
carry stable request, workspace, Thread, Turn and operation identifiers where
applicable. Events carry a Main-normalized monotonic sequence. SDK objects and
provider-native messages never cross this boundary.

## Ownership

- Renderer owns presentation state only.
- Preload exposes fixed, validated provider-neutral operations.
- Main owns trusted-sender checks, native pickers, workspace navigation,
  approval presentation, terminal flow control and runtime supervision.
- The worker owns ADK sessions, provider adapters, tool dispatch, MCP sessions
  and dynamic child-Agent scheduling.
- Rust owns durable v3 state and privileged local capabilities.

The process-local `ThreadRegistry` combines the hidden-path Desktop navigation
cache with the authoritative runtime Thread index. Session entries begin as
`sessionCache`; after a workspace opens, its runtime index replaces stale
membership and fixes ownership. A Thread cannot move between runtime-confirmed
workspaces.

## Agent and provider boundary

The primary loop and every child task use ADK `LlmAgent`/`Runner` invocations.
`OpenAiLlm` and `AnthropicLlm` extend ADK's model boundary and call the official
OpenAI and Anthropic TypeScript SDKs. The adapters normalize text, reasoning,
media, tool calls, usage, request IDs, stop reasons and errors into SugarCode
events. Provider types remain inside those adapters.

ADK sessions are process-local caches. Before a new Turn, provider-neutral
completed history is rebuilt from Rust SQLite. Worker loss interrupts active
Turns and child tasks; it never resumes an incomplete tool call or side effect.

The primary `LlmAgent` follows ADK's structured tool loop. Function-call Items
continue the same Turn through execution and a subsequent model request; a
terminal model response completes the Turn once. Public text is never parsed to
infer lifecycle state, and the runtime does not repeat terminal responses while
waiting for a provider-specific completion marker. Each individual provider
request has a bounded output budget and wall-clock deadline so a continuously
streaming model cannot keep a Turn alive indefinitely.

## UI compatibility

Conversation, model configuration, attachments, approvals, MCP, Git, workspace,
terminal and orchestration keep their existing Renderer/preload surfaces.
Private Main adapters translate these calls to the utility runtime. The old
app-server public protocol, CLI supervisor and sidecar executable no longer
exist.

Conversation snapshots preserve the optimistic first-Turn projection while the
runtime acknowledges startup: `starting` may contain the newly allocated active
Turn and its user message. Preload validation must retain that state so the
Renderer can show the transcript before the first model stream event arrives.
Consecutive commentary deltas are coalesced into one process paragraph during
live projection, and persisted commentary deltas are coalesced again on restore;
provider chunk boundaries must never become visible paragraph spacing.
Commentary uses the same streaming-safe GFM renderer as Agent responses, with
the process-text tone, so headings, lists, emphasis and inline code have one
consistent Markdown interpretation.
Reselecting the foreground Thread is idempotent even while its Turn is active
and republishes its current snapshot. Main tracks active Turns by workspace and
Thread rather than as one global foreground Turn. Selecting another Thread,
opening a new Thread or switching projects leaves every background Turn
running, while the foreground snapshot derives its phase and `activeTurnId`
from the selected Thread. Navigator `activeThreadIds` remains scoped to the
visible workspace, while `runningThreadIds` and `unreadThreadStatuses` cover all
open workspaces so a project switch cannot hide active or newly completed work.
The short attachment/import and Thread-creation startup window is isolated per
workspace and captures its original workspace authority, so another project may
start independently even if the first startup has not returned. A background
completion is retained until that Thread is selected, so navigation can replace
its running marker with the terminal outcome.
Optional navigator fields are omitted when cleared rather than serialized with
`undefined`; every snapshot published by Main must pass the same preload
validation used at the Renderer boundary.
Recovered `runtimeRestart` records are projected as the public `incomplete`
Turn error, and interrupted Turns may retain that classified error so a restored
transcript remains valid and explains why work stopped.

Child-Agent task snapshots include bounded live progress with an explicit stage
(`waitingForModel`, `streaming` or `runningTool`), a public Markdown summary and
an update timestamp. The graph shows a compact latest update and the Agent
detail rail renders the live Markdown stream; the terminal task result remains
the durable completion contract.
