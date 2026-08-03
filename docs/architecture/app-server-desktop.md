# App-server and Desktop boundary

## Transport

Desktop Main starts the bundled matching executable as:

```text
sugarcode app-server --stdio --multi-workspace
```

Transport is bidirectional JSONL. Stdout is protocol-only; stderr is bounded
diagnostics. Initialization verifies product version, protocol version,
platform and capabilities before ready-state methods are admitted.

Rust definitions in `crates/app-server-protocol` are the source of truth.
Generated TypeScript, JSON Schema and affected fixtures change together. Public
types are provider-neutral and protocol version remains 1.

## Multi-workspace routing

One Desktop session owns one persistent app-server process. After initialize,
Main registers every canonical project or isolated-chat root with
`workspace/open`. The response returns an opaque deterministic `workspaceId`;
all Thread discovery/lifecycle and workspace/Git requests carry that ID. A
global control session handles initialize, workspace registration and global
configuration, while lazily loaded workspace contexts own Core execution.

The registry shares one rollout repository and one process-wide ID allocator,
so Thread, Turn and Item IDs remain unique across workspaces. It also records
Thread-to-workspace ownership and routes lifecycle events back to the correct
Desktop projection. A context with no active Turn, pending approval or current
foreground reference may unload after five idle minutes; its descriptor and
durable state remain, and the next routed request reloads it. Reopening a
canonical root is idempotent. The legacy single-workspace CLI mode internally
injects its binding and retains the same public protocol.

Desktop remembers every opened root in Main and replays background
`workspace/open` registrations before reopening the foreground root after a
sidecar or model/MCP restart. Renderer receives project summaries and opaque
Desktop project IDs, never absolute paths.

## Public v1 lifecycle

`turn/start` accepts ordered content parts and may omit text when attachments
exist. `asset/import` accepts bounded Base64, validates through the state content
store and returns a descriptor for later Turn input. Imported payloads are
flushed before publication on every platform; directory metadata is additionally
synchronized on Unix, where directory handles support that durability boundary.

ToolCall contains call ID, SugarCode tool name and JSON arguments. Validation
failure is its own `toolValidationRejected` Item. `FileChange`, approvals,
execution attempts and results remain independent durable Items. Unknown fields
or broken lifecycle correlation fail closed. A model response may declare
multiple command calls before the runtime begins their sequential approval and
execution. Main retains those declarations by call ID; one pending call cannot
overwrite or invalidate another.

Provider errors expose only retryability plus optional HTTP status, provider
code, request ID and retry-after. A consumer disconnect interrupts the Turn.
An app-server/Desktop contract mismatch transitions the connection to a
diagnostic state; it is not mapped to `stateUnavailable`.
One protocol-invalid event while Ready triggers one Main-owned sidecar restart
and restores the selected Thread. Another protocol-invalid event inside the
60-second recovery window pauses the connection instead of starting a restart
loop. Provider 4xx, protocol output, incomplete response and context failures
are normal typed Turn failures and never enter this connection-recovery path.
Likewise, a structurally valid `thread/resume` response whose Item lifecycle
cannot be projected is isolated to that Thread: Desktop clears the unsafe
selection, keeps the sidecar and other Threads available, and presents a
selection notice. Connection restart is reserved for framing, handshake or
cross-process contract failures, not one historical conversation.

`Turn` and `TurnSnapshot` may expose provider-neutral token usage. During an
active Turn, `thread/tokenUsage/updated` carries `lastRequest`, cumulative
`turnTotal`, `requestCount`, `contextWindowTokens` and a `provider` or
`estimated` source. `turn/warning` is non-terminal; it currently reports that
an OpenAI Responses endpoint rejected provider-managed continuation and that
the same request continued through private local replay. Neither notification
contains native provider objects or opaque continuation data.

## Desktop ownership

Electron Main owns:

- sidecar process and JSON-RPC correlation;
- validated conversation and Thread projections;
- model configuration commands;
- workspace and native file pickers;
- attachment reads and `asset/import`;
- MCP session replacement and approvals;
- command-approval policy and its current Thread/workspace scope;
- Git, preview window and PTY/ConPTY terminal.

Conversation state is one projection per Thread rather than one mutable global
transcript. Background lifecycle updates stay in their owning projection,
running and unread Thread sets are aggregated for navigation, and selecting a
cached Thread never overwrites another active Turn. Stop and destructive Thread
actions always target an explicit Thread ID; only the target Thread's active
Turn blocks its fork/archive/delete action.

`conversation/controller.ts` is the stable conversation-controller facade.
Its `conversation/controller/` implementation directory separates RPC and
Thread action coordination (`conversation-controller.ts`), snapshot/recovery
projection (`projection.ts`), Turn lifecycle routing
(`lifecycle-controller.ts`), mutable state and correlation guards
(`mutable-state.ts` and `item-lifecycle-base.ts`), and the started/completed
Item reducers with their semantic comparisons (`item-started.ts`,
`item-completed.ts`, and `lifecycle-comparison.ts`).

Main passes its host process environment to the trusted local sidecar so the
Agent command runtime sees the same installed toolchain locations as Desktop.
This is distinct from exposing environment values to Renderer or model tools:
the command supervisor constructs a bounded `hostInheritedV1` environment and
removes credential-like variables before spawning a sandboxed command.

Preload exposes fixed validated operations and minimized snapshots. Renderer
owns presentation state only and receives no executable path, environment,
absolute workspace path or raw native capability.

Desktop starts project and isolated chat roots with bounded structured file
writes. Shell workspace write remains a separate explicitly approved policy.
Runtime replacement is Main-owned and cannot let events from the old scope
update the new projection.

Public `Thread` values may carry a bounded optional title derived by Core from
durable user content. Main validates and projects that title; Renderer uses the
canonical ID fallback only until a content title exists.

Command approval has three Desktop modes: ask every time, automatically approve
later requests in the current Thread, or automatically approve later requests
in the current workspace. The mode can be chosen in the composer or atomically
with an approval decision. Main owns and enforces the scope, binds a pre-Thread
selection to the next started Thread, and resets the policy when the workspace
changes. Automatic approval only answers the existing app-server request; it
does not relax the read-only/no-network command sandbox or authorize shell
workspace writes. Normal terminal approval states close without a persistent
completion toast.

Command and MCP approvals enter one Main-owned FIFO queue across every project
and Thread. Only the head is presented, and its local countdown starts after the
matching approval surface reports ready. Closing the UI or transport safely
rejects pending and queued requests. The view model identifies the source
project and conversation; “View task” asks Main to activate the owning project
or isolated chat before selecting its Thread. Workspace-scoped automatic
approval is checked against the request's recorded workspace, not the currently
visible project.

Main persists a versioned multi-project session registry with canonical paths,
opaque workspace bindings, per-project Thread IDs, isolated-chat directories,
titles and recency. The schema-v2 reader migrates the prior single-project
schema once and discards roots that no longer validate. Switching projects does
not restart the sidecar, and background Turns continue while the foreground
selection changes.

Renderer keeps unsent drafts, attachments and next-Turn model selection per
Thread (plus a separate new-Thread slot). Changing the profile on a Thread with
history requires confirmation and affects only the next Turn; the active Turn
remains frozen. The workbench uses a 44-pixel activity rail, a resizable
240–380-pixel navigator (286 default), a 52-pixel conversation header and a
380–1200-pixel inspector (760 default). The inspector preserves a usable
conversation column in desktop split view; responsive breakpoints omit side
regions when the window cannot fit them rather than exposing persistent
collapse controls in the conversation header. Each top-level column contributes
a draggable title-bar surface, while its interactive descendants opt out of
window dragging. Both light and dark themes use the mandated semantic tokens.

## Composer and transcript

The composer supports file selection, drag-and-drop and pasted images.
Attachment cards are visible before send; image descriptors render thumbnails
where bytes are locally available, while durable transcript cards use the
public descriptor. Import occurs before Turn submission and partial import
failure does not start a Turn.

The transcript correlates every activity by call ID, including parallel or
repeated read tools and multiple declared command calls awaiting sequential
approval. Interrupted recovery may retain unmatched command declarations as
non-executed history; it never replays or fabricates their side effects. File
changes remain individually reviewable. Public validation Items keep the
connection alive and need no empty-path ToolCall special case.

Provisional Agent text is rendered through the same incremental Markdown
projection as completed Agent messages. Because the provider-neutral delta does
not reveal whether text will resolve as commentary or a final answer until round
completion, Desktop presents it as a streaming Agent response first and then
settles it into its durable final role without showing raw Markdown source.
The stream preview is not a persistence or protocol invariant: when the
provider's completed item differs because of gateway normalization or
model-specific event assembly, the durable completed text replaces the preview
instead of turning a successful model response into a Desktop protocol error.
When a round streams provisional text but its authoritative snapshot contains
only ToolCalls, Core closes that exact preview with
`turn/agentOutput/discarded` before the next model round begins. Desktop removes
the preview without creating a durable transcript Item; a later response
ordinal therefore cannot be mistaken for a concurrent unresolved output.
Core uses the same lifecycle event when a malformed compatible stream inflates
only its provisional rendering. Desktop removes the bounded preview and waits
for the authoritative final Item instead of showing a model-output failure.
Transcript progress remains visible from local submission through Turn start,
the first model delta and later model/tool gaps.

Renderer measures the quiet interval since the latest public lifecycle update
for the active Turn. After 15 seconds without visible progress it changes the
generic working indicator into an explicit wait for the frozen model, shows the
elapsed quiet time and provides a transcript-local stop action. This clock is
presentation-only, resets on every lifecycle update and never interrupts or
times out the provider request. If the transport becomes unavailable while a
Turn is active, the indicator becomes state-uncertain instead of continuing to
claim that the Agent is processing. A failed Turn renders one subdued, centered
summary in the transcript; recovery guidance, model and wire details, and
protocol metadata remain outside the primary conversation surface. When a
public Turn error includes a protocol diagnostic, the summary uses its specific
stable reason instead of the generic wire message. It never renders provider
response content or tool arguments. `historicalContextDowngraded` is a
non-blocking Turn notice explaining that unsupported historical media was
represented as bounded text metadata; it is not displayed as a model failure.

Project and Thread navigation labels use focusable link semantics rather than
button styling; only discrete actions such as creating, forking, archiving or
deleting use buttons. Thread rows reserve a non-shrinking action column inside
the navigator boundary; titles truncate within the remaining column and cannot
push fork, archive or delete actions outside the visible/clickable area. The
composer exposes the
latest single-request input against the selected model's effective context
window, then shows cumulative Turn usage and request count as secondary data.
The cumulative value is explicitly allowed to exceed the window. Missing
provider usage is prefixed as estimated. Compaction activity explains the
output and recovery reserves and labels its fallback byte-derived token counts
as conservative estimates rather than provider usage; continuation ciphertext
never contributes to that estimate. The composer reads usage only from the
latest Turn; when a newly started or failed Turn has no usage yet, it falls back
to the selected model's context budget instead of displaying an earlier
model's stale request and cumulative totals.

SugarCode starts without a configured model and never inserts a model ID. A new
OpenAI-compatible connection selects **Compatible Chat (default)**; the user may
explicitly select **Responses (advanced)**. Existing saved connections are
shown and retained unchanged. Capability controls explain that `auto` is the
conservative text/sequential-tool baseline rather than a model-name probe.

The model settings page exposes `continuationMode` only for OpenAI Responses.
`localReplay` is the privacy-first default (`store:false`) and uses more local
bandwidth; `providerManaged` opts into `store:true + previous_response_id` and
may reduce replay bandwidth at the cost of provider-side retention and endpoint
compatibility. Chat Completions and Anthropic always use local native history
replay.

## Desktop validation and CI

Main validates every app-server message before projection. Rust schema is the
single structural source; Desktop adds semantic bounds needed by its view
model. Node tests cover these boundary validators and run under
`pnpm check` with lint and TypeScript checking.

Native package smoke runs on macOS and Windows and uses the copied sidecar.
Ubuntu/Linux is not currently a supported CI or packaging acceptance target.
The smoke verifies version pairing, handshake and isolated local capabilities
without contacting a provider. See `desktop-cli-packaging.md` for package and
release boundaries.
