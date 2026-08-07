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

Raw provider reasoning and thinking remain available to the live model loop and
portable completed history but are not projected as user-visible process text.
Only explicit assistant commentary is public. The base Agent instruction keeps
that commentary and the final answer in the original user's language, treats
internal continuations as language-neutral, and discourages repeated process
narration that carries no new decision, result or blocker.

When a tool step has no non-whitespace public commentary, the runtime projects
one bounded provider-neutral progress summary from the verified tool name and
safe arguments. The summary follows the original user's Chinese or English
language and never copies private reasoning. Whitespace-only model messages are
discarded, and identical synthesized summaries are not repeated.

ADK sessions are process-local caches. Before a new Turn, provider-neutral
completed history is rebuilt from Rust SQLite. Worker loss interrupts active
Turns and child tasks; it never resumes an incomplete tool call or side effect.

The primary `LlmAgent` follows ADK's structured tool loop. SugarCode Turn
Driver outside ADK consumes the provider-normalized `ModelStepOutcome`
(`toolCalls`, `final`, structured continuation, or failure) and may start
another ADK invocation in the same Turn. A Turn completes only when its last
outcome is a non-empty `final`, no tool, operation, approval or child task
remains pending, all child results have been consumed, and the Turn was not
cancelled. Commentary-only, `pause_turn`, and output truncation inject an
internal continuation that is never projected as a user message.

Commentary or reasoning alone can never produce a successful Turn. Three
consecutive commentary-only responses fail as a protocol stall; two output
truncations without a final fail as `outputTooLarge`; and the same malformed
tool arguments producing the same error twice fail before a third model
request. Each provider request retains its own deadline, but a Turn has no
wall-clock or tool-count success threshold. Provider adapters never infer tools
from ordinary prose, reasoning, language, or generic markup.

The same Turn Driver and completion gate run child Agents. A child without a
non-empty final answer fails instead of receiving a fabricated completion
summary. If the parent submits a final candidate before child results are
consumed, the gate waits for bounded results, classifies that candidate as
commentary, injects the results, and requires one new final answer.

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
The private worker protocol is v2 and projects model text as
`turn.textStarted`, `turn.textDelta`, and `turn.textCompleted`. Started and
delta events are transient. A completed event carries the authoritative text,
a stable provider Item ID (or one request-stable synthetic ID), and a resolved
`commentary` or `final` phase. Main updates the Item by
`workspaceId + threadId + turnId + itemId`; a final candidate is not promoted
to the unique Agent answer until the completion gate accepts it.
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

Every `ConversationStateSnapshot` identifies its own workspace. Workspace and
Thread list/load/select requests capture that identity at dispatch time, while
workspace switching uses a monotonically increasing latest-wins generation.
Late results may update only their owning workspace cache and cannot restore an
older foreground selection. Runtime Thread indexes are replaced from the
snapshot's workspace identity rather than a mutable adapter field.

Child-Agent task snapshots include bounded live progress with an explicit stage
(`waitingForModel`, `streaming` or `runningTool`), a public Markdown summary and
an update timestamp. The graph shows a compact latest update and the Agent
detail rail renders the live Markdown stream; the terminal task result remains
the durable completion contract.
