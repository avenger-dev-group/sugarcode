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

The registry shares one rollout repository. Thread, Turn and Item IDs are
canonical lowercase UUIDv7 values and require no shared numeric allocator.
Every public `Thread` carries its required `workspaceId`; start, list, search,
resume, fork, descendants and `thread/started` preserve that binding. Main uses
the returned binding, rather than the foreground selection, to record ownership.
Every other real-time Turn/Item lifecycle notification and both approval request
types carry a required top-level `workspaceId`, so Main routes an event from the
message alone and never infers ownership from Renderer navigation state. A context
with no active Turn, pending approval or current
foreground reference may unload after five idle minutes; its descriptor and
durable state remain, and the next routed request reloads it. Reopening a
canonical root is idempotent. The legacy single-workspace CLI mode internally
injects its binding and retains the same public protocol.

Desktop remembers every opened root in Main. A cold Desktop launch restores the
project and chat navigation registry without selecting a project, chat or
Thread; the conversation column starts on the neutral SugarCode page. After an
explicit user selection, a sidecar or model/MCP restart replays background
`workspace/open` registrations before reopening that in-session foreground
root. Renderer receives project summaries and opaque Desktop project IDs, never
absolute paths.

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
multiple calls, including multiple workspace writes, before the runtime begins
their sequential approval and execution. Main retains every declaration as an
independent activity correlated by call ID; one pending call cannot overwrite or
invalidate another. The minimized Turn's `activities` list is authoritative for
workspace-write lifecycle, while its singular `fileChange` field remains only a
latest-activity compatibility projection for older Renderer consumers.

One workspace edit/apply-diff call may publish multiple ordered `FileChange`
Items with the same call ID. `kind` is `create`, `update` or `delete`, and
`/dev/null` is the absent Diff side. Desktop groups them into one ChangeSet
activity while preserving per-file review and keeps accepting historical
single-update activity/results. A batch ToolResult carries the ordered revision
receipts for all files.

Collaboration coordination calls (`dispatch`, `amend`, `wait` and `interrupt`)
remain public lifecycle Items but are hidden from the ordinary tool transcript.
Desktop validates their exact ToolCall and ToolResult envelopes during live
projection, while durable resume retains unsupported historical tool records as
non-rendered `other` Items. Agent presentation comes from the public task,
amendment and result Items. Unknown collaboration names and malformed live
coordination payloads still fail closed; hidden coordination is never a generic
escape hatch for unsupported lifecycle data.

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
selection notice. The same boundary applies to a live event with a valid
`workspaceId + threadId` route whose payload or Turn/Item ordering cannot be
projected. Main drops that Thread's in-memory Runtime, rejects its waiting
approvals, clears speculative running/unread state and marks it reload-required.
Later events for the quarantined Thread are ignored until an explicit selection
forces `thread/resume`; no timer retries it. JSONL framing, JSON-RPC envelope,
unknown notification, unrecognized Thread, Workspace binding change, approval,
handshake and version errors remain global connection-recovery failures.

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

Conversation state is one `ThreadRuntime` per Thread rather than one mutable
global transcript. One Main-process `ThreadRegistry` is injected into the
connection, conversation and workspace controllers. Each entry owns the
Thread's protocol-confirmed immutable `workspaceId`, title, active membership,
Runtime, unread status and reload-required status. The conversation controller
owns only the foreground `{ workspaceId, threadId | null }` selection,
navigation and short-lived UI transactions. Background lifecycle is applied
directly to the target Runtime; Main never saves the foreground, temporarily
swaps Workspace identity, restores a background projection and swaps back.
Background updates are accepted only for known Threads in their owning
workspace and can never replace a blank foreground projection. Navigation
projects running Thread IDs and unread terminal statuses globally across every
registered project and isolated chat, while the transcript remains scoped to
the foreground workspace. `thread/title/updated` changes only its bound
Registry entry, so a background title cannot create foreground membership.
Successful, failed and interrupted background Turns retain distinct unread
states until their Thread is selected. Selecting a cached Thread never
overwrites another active Turn. Stop and destructive Thread actions always
target an explicit Thread ID; only the target Thread's active Turn blocks its
fork/archive/delete action.
If an isolated-chat Thread cannot be activated, Renderer keeps its permanent
delete action visible. Main sends the same workspace-bound `thread/delete`
lifecycle request without requiring foreground activation; the explicit
Workspace ID lets Main load the owning context even when the Thread was never
restored into runtime memory. Normal deletion uses that single binding. Only an
unresolved legacy session-cache entry may probe other known Workspace bindings
until app-server deletes the Thread or confirms it is absent from all of them.
Main removes the Registry entry only after that durable check completes.

`conversation/controller.ts` is the stable conversation-controller facade.
Its `conversation/controller/` implementation directory separates RPC and
Thread action coordination (`conversation-controller.ts`), snapshot/recovery
projection (`projection.ts`), the shared ownership and Runtime index
(`thread-registry.ts`), per-Thread runtime state (`thread-runtime.ts`), Turn lifecycle routing
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
Minimized command process results preserve their authority receipt shape:
sandboxed direct execution carries both `filesystemReadOnlyV1` and
`networkDeniedV1`, while approved Full Access execution carries neither.
Shared snapshot validation accepts exactly those paired-or-absent forms and
never drops a Full Access result merely because sandbox receipts are absent.

Desktop starts project and isolated chat roots with bounded structured file
writes. Shell workspace write remains a separate explicitly approved policy.
Runtime replacement is Main-owned and cannot let events from the old scope
update the new projection.

Public `Thread` values may carry Core's bounded optional generated title. Main
requests generation after the first accepted Turn and whenever an untitled
Thread is opened, then projects the asynchronous `thread/title/updated`
notification into the owning conversation and workspace registry. Renderer
never substitutes a canonical ID, user-prompt excerpt or an ID-derived “task”
label: an untitled running Thread displays “新会话” and any other untitled
Thread uses a neutral unnamed label.

Command approval has three Desktop modes: ask every time, automatically approve
later requests in the current Thread, or automatically approve later requests
in the current workspace. The mode can be chosen in the composer or atomically
with an approval decision. Main owns and enforces the scope, binds a pre-Thread
selection to the next started Thread, and resets the policy when the workspace
changes. Automatic approval only answers the existing app-server request; it
does not relax the read-only/no-network command sandbox or authorize shell
workspace writes. Normal terminal approval states close without a persistent
completion toast.

Full Access `shell/exec kind=shell` uses a separate Main-process approval scope;
automatic approval learned from sandboxed direct commands can never answer it.
The approval surface displays the complete command, cwd, selected platform
shell and the network/outside-workspace risk. Its one-call/Thread/workspace
authorization is revocable, is never persisted to the Desktop session, and is
cleared on application exit. `item/commandExecution/outputDelta` streams
bounded stdout/stderr by call ID into the matching activity; only the bounded
final process result is durable.

Command and MCP approvals enter one Main-owned FIFO queue across every project
and Thread. Only the head is presented, and its local countdown starts after the
matching approval surface reports ready. Closing the UI or transport safely
rejects pending and queued requests. The view model identifies the source
project and conversation. Renderer opens the modal only while its owning Thread
is selected; a background request instead marks that Thread as requiring
approval in the navigator, and selecting it reveals the existing modal. “View
task” asks Main to activate the owning project or isolated chat before selecting
its Thread. Navigation state priority is actionable approval, opening,
reload-required, running, then unread terminal status. A reload-required row
uses the existing alert semantics and remains clickable because selection is the
explicit durable reload action. Requests behind the actionable FIFO head
remain running until they become the head, so the navigator never claims that a
non-actionable queued request can already be approved. Workspace-scoped automatic
approval is checked against the request's recorded workspace, not the currently
visible project.

Main persists a versioned multi-project session with canonical paths, opaque
workspace bindings, per-project Thread IDs and title maps, isolated-chat
directories, titles and recency. The schema remains `1`; those Thread arrays and
title maps are serialized views of `ThreadRegistry`, not parallel runtime facts.
On cold start they are imported as `sessionCache`. Records without a Workspace
ID remain keyed by their project or chat owner until that owner is opened.
`thread/list` then atomically replaces only that Workspace's active index:
protocol data corrects stale cached ownership and removes cached records absent
from the authoritative list. Project and chat membership is therefore mutually
exclusive without scanning or editing other project arrays.
Its stored active entry
does not opt a cold launch into foreground restoration. Switching projects does
not restart the sidecar, and background Turns continue while the foreground
selection changes. When a user requests another project or a new isolated chat
while the current `turn/start` request is still settling, Main serializes the
workspace switch only until that request is accepted or rejected. It never waits
for `turn/completed`. Before a new Thread ID exists, one pending start transaction
holds the Workspace binding and early lifecycle; the `thread/start` response and
matching `thread/started` bind the Runtime, and early `turn/started` events remain
buffered until the `turn/start` response is accepted. This keeps the newly
started Turn in its owning projection and then opens the requested foreground
workspace. A workspace-loading snapshot publishes an empty foreground index
until the destination list arrives, but retains an explicitly requested target
Thread ID as pending presentation state. Renderer resolves that target's title
from the persistent project/chat navigation projection while its transcript is
loading, so the conversation header does not temporarily fall back to the
new-Thread label. Cross-project task selection uses the same Main-owned focus
transaction so the target ID survives the workspace boundary. Main never learns
Thread ownership or titles from a Renderer snapshot. Transient navigation state
therefore cannot rebind a background Thread to the new foreground workspace.
Project ordering is
import-recency order: a newly imported
project enters at the top, while later activation never changes its position.

Renderer keeps unsent drafts, attachments and next-Turn model selection per
Thread (plus a separate new-Thread slot). Changing the profile on a Thread with
history requires confirmation and affects only the next Turn; the active Turn
remains frozen. A restored Thread's durable Turn model snapshot survives the
Main recovery projection, and Renderer recomputes the selected profile whenever
that history changes; an absent local override therefore resolves to the most
recent durable profile rather than the catalog default. The workbench uses a
resizable 240–380-pixel navigator (286
default), a 52-pixel borderless conversation header and a 380–1200-pixel
inspector (760 default). The navigator and inspector expose persistent collapse
state. The navigator control remains aligned beside the macOS traffic lights in
the active title-bar drag surface so it can restore a closed navigator without
losing pointer input; the inspector control lives at the right edge of the
conversation header. Their open state and widths are
restored from the Renderer-owned layout preference. The inspector preserves a
usable conversation column in desktop split view; responsive breakpoints still
omit side regions when the window cannot fit them. Each top-level column
contributes a draggable title-bar surface, while interactive controls and
selectable title text opt out of window dragging. Both light and dark themes use
the mandated semantic tokens.

The inspector's workspace tab is permanent. Its Agent tab is transient and is
absent until the user selects an orchestration card. Selecting a card activates
that Agent tab and opens a collapsed inspector; closing the tab clears the
selected task and returns to the workspace tab, while selecting another card
opens it again. Task-card buttons explicitly retain pointer hit testing inside
the otherwise non-selectable, non-draggable orchestration canvas. Each card
derives its height from the measured display width of its complete title, and
the DAG layout consumes that same per-card height so short titles stay compact
while longer titles cannot overlap edges or adjacent ranks. The canvas refits
the graph when a collapsed activity becomes visible, when its graph layout
changes or when the available conversation width changes; once the viewport is
stable, manual pan and zoom remain untouched. Each refit derives a fresh
viewport directly from the graph bounds and the conversation's currently visible
rectangle, so repeated inspector resizing or collapsing cannot accumulate an
off-canvas translation. Agent detail owns a dedicated keyboard-focusable
vertical scroll area, so
the frozen prompt, revisions, dependencies and final result remain reachable
without moving the conversation transcript. Thread changes also clear the
transient task selection so Agent detail can never leak across conversations.
Only the inspector's collapse state and width are persisted; transient Agent-tab
state is Renderer-owned session presentation.

The orchestration surface presents a read-only execution console rather than a
workflow editor. Its header summarizes completed, active or failed delegated
tasks, while each graph card exposes role, status, full title, access scope,
dependency count and result duration. A selected card has a persistent visual
inspection state matching the transient Agent tab. Subdued grid points and one
grouped viewport control keep the dependency graph legible without competing
with the conversation or implying that nodes can be edited.

## Composer and transcript

The composer supports file selection, drag-and-drop and pasted images.
Attachment cards are visible before send; image descriptors render thumbnails
where bytes are locally available, while durable transcript cards use the
public descriptor. Import occurs before Turn submission and partial import
failure does not start a Turn.

The transcript correlates every activity by call ID, including parallel or
repeated read tools and multiple declared command calls awaiting sequential
approval. A multi-file ChangeSet is one expandable activity with ordered
create/update/delete Diffs. Live command output remains attached to its command
activity and is capped independently per stream. Interrupted or failed
recovery may retain unmatched command declarations and result-less sibling
workspace calls as non-executed history; only a successfully completed Turn
requires every declared activity to have durable closure. Recovery never
replays or fabricates side effects. File changes remain individually reviewable
inside the ChangeSet. Public validation Items keep the connection alive and
need no empty-path ToolCall special case.

Provisional Agent text is rendered through the same incremental Markdown
projection as completed Agent messages. Because the provider-neutral delta does
not reveal whether text will resolve as commentary or a final answer until round
completion, Desktop presents it as a streaming Agent response first and then
settles it into its durable final role without showing raw Markdown source.
The shared projection uses the Codex Desktop-derived transcript rhythm: 14/22
normal-weight body copy, medium-weight scaled headings and emphasis, an
inset four-pixel quote rule, nested and task-list treatment, horizontally scrollable
separator-led tables, compact code surfaces and a 150-millisecond streaming
fade that is disabled by reduced-motion preferences. Every neutral color
continues to come from the mandated semantic theme tokens, so this presentation
remains identical in structure across light and dark modes. Unsafe HTML stays
omitted, while link and remote-media behavior remains governed by the existing
Desktop boundary rather than by Markdown styling.
Recognized fenced-code languages, including PHP, Go, Java, C#, C and C++, are
highlighted with Renderer-owned light and dark syntax colors. Every code block
exposes a keyboard-accessible copy action with bounded success or failure
feedback; unknown languages and oversized input remain plain text, and
highlighted HTML is generated only from escaped code.
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
Every Turn after the first begins beyond a full-width semantic divider, so a
new user message cannot be visually grouped with the preceding Turn's tool or
terminal state. Interrupted and failed terminal lines serve as that boundary;
normal completion still has no completion label and receives a dedicated
divider instead. The Turn section also exposes its conversation ordinal to
assistive technology.

Project folders are collapsed by default and use focusable disclosure semantics
rather than selection styling. Clicking a folder only expands or collapses its
Thread list; its hover-revealed add action activates that project and creates a
new Thread directly. Transient workspace activation gates competing navigation
actions without replacing section icons, fading navigation content or shifting
the navigator layout; fast project and chat creation therefore remain visually
stable instead of flashing a global loading treatment. An expanded empty
project shows one subdued “没有会话” label. Thread labels use generated titles
when available and neutral untitled placeholders otherwise; internal IDs are
never presentation labels. Thread labels use link semantics, and
only discrete actions such as
creating, forking, archiving or deleting use buttons. The active project folder
remains visually neutral; only the selected conversation row receives a
selection background. Thread rows reserve a non-shrinking action column inside
the navigator boundary; titles truncate within the remaining column and cannot
push fork, archive or delete actions outside the visible/clickable area.
The navigator uses the Codex-derived text hierarchy: dedicated subdued section
labels, normal-weight 85-percent project and inactive Thread titles, and a
medium-weight primary selected Thread title over the lighter semantic surface.
Its column uses a dedicated gray background token (`#F9F9F9` light, `#202020`
dark), so the selected surface keeps restrained contrast in both themes. The
section-label token rises from 35 percent in light mode to 50 percent in dark
mode to retain readable contrast.
Destructive conversation confirmation uses a basic human-facing warning and
never displays the internal Thread ID. The composer exposes the latest
single-request input against the selected model's effective context
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
