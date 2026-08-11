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

The worker's event sequence is process-local and may restart after worker
replacement. Every durable Turn Item identity is therefore scoped by its
`turnId`; worker-local sequence values provide ordering but can never be used
alone as a database-wide identity. A durable state write failure terminates the
affected Turn as `stateUnavailable`. It is not classified or presented as a
model-service failure.

`RuntimeCommand` and `RuntimeEvent` are private discriminated unions. Requests
carry stable request, workspace, Thread, Turn and operation identifiers where
applicable. Events carry a Main-normalized monotonic sequence. SDK objects and
provider-native messages never cross this boundary.

## Ownership

- Renderer owns presentation state only.
- Preload exposes fixed, validated provider-neutral operations.
- Main owns trusted-sender checks, native pickers, workspace navigation,
  approval and user-input response routing, terminal flow control and runtime
  supervision.
- The worker owns ADK sessions, provider adapters, tool dispatch, MCP sessions
  and dynamic child-Agent scheduling. It also freezes the enabled Skills
  inventory at each primary or child Turn boundary.
- Rust owns durable v3 state, Skill discovery/preferences and privileged local
  capabilities.

The process-local `ThreadRegistry` combines the hidden-path Desktop navigation
cache with the authoritative runtime Thread index. Session entries begin as
`sessionCache`; after a workspace opens, its runtime index replaces stale
membership and fixes ownership. A Thread cannot move between runtime-confirmed
workspaces.

Each project workspace is bound to its canonical absolute project directory.
Non-project chats receive a managed capability root at
`Documents/SugarCode/<YYYY-MM-DD>/<conversation-directory>` and reuse that
directory when reopened. Switching the foreground conversation changes only
the active workspace view: Turns already running in another workspace retain
their original `workspaceId` and capability root. Foreground workspace switch
operations are serialized, while background Turns do not hold that switch
lease. Foreground terminal launches
capture `workspaceId`, canonical path and UI generation as one Main-owned
snapshot and reject dispatch if that identity changed. A Git transaction
likewise freezes its starting `workspaceId`, so a later foreground switch
cannot redirect its follow-up status or reconciliation request.
On a cold start with no selected workspace, the empty Composer remains writable.
Its first send activates one managed Chat workspace before starting the Turn, so
the user does not need to select a project or explicitly create a Chat first.
The empty conversation presents concise, user-facing examples of the work
SugarCode can help complete without exposing managed-directory implementation
details.
Existing project and Chat destinations are never redirected by this fallback.
Regardless of workspace kind, an empty Composer renders no conversation heading;
after a Thread exists, the header renders only that conversation's title.
An untitled durable Thread renders the localized `新对话` placeholder in the
header and navigator while the utility runtime performs the independent title
metadata request. A successful generated-title event updates Main's Thread
record, the process-local registry and every Renderer navigation projection
without reloading the transcript.

Main also owns the process-local approval mode and its scope identity. A
conversation grant is paired with one `threadId`; a project grant is paired
with one registered `workspaceId`. Renderer labels and selection state are
derived by resolving the visible conversation against those identities, while
Main independently resolves every incoming command or MCP proposal before it
can bypass presentation. This keeps project grants valid for every conversation
in that project without leaking them to another project. Every resolution also
carries provider-neutral provenance (`user`, `policy` or `system`). The audit
timeline can therefore distinguish an inherited project/conversation grant
from a fresh user interaction instead of presenting both as another prompt.
When no broader scope applies, Main also owns the fixed visible approval
deadline. Expiry submits a provider-neutral `system` approval for command and
MCP proposals, and a recovered replay resends the already committed decision so
the Renderer cannot remain trapped at zero seconds. Electron teardown may make
the utility runtime unavailable before IPC disposal; system cleanup therefore
treats a closed supervisor as an expected terminal state instead of throwing in
the Main process.

## Agent and provider boundary

The primary loop and every child task use ADK `LlmAgent`/`Runner` invocations.
`OpenAiLlm` and `AnthropicLlm` extend ADK's model boundary and call the official
OpenAI and Anthropic TypeScript SDKs. The adapters normalize text, reasoning,
media, tool calls, usage, request IDs, stop reasons and errors into SugarCode
events. Provider types remain inside those adapters.
Because ADK represents thrown model failures as error events, each Runner uses
a private capture plugin to retain the adapter's provider-neutral error before
ADK conversion. The Turn Driver consumes that captured error after the
invocation, preserving its kind and retryability rather than misclassifying a
timeout or transport failure as an invalid model response.

Raw provider reasoning and thinking remain available to the live model loop and
portable completed history but are not projected as user-visible process text.
Explicit assistant commentary is public. A provider-declared reasoning summary
may also be public only after the adapter marks it as `summary`; unclassified or
`internal` reasoning is never promoted. The base Agent instruction keeps public
commentary and the final answer in the original user's language, treats internal
continuations as language-neutral, and discourages repeated process narration
that carries no new decision, result or blocker.

Bounded vertically scrollable regions inside the conversation transcript keep
the browser's default vertical overscroll chaining. Once a nested activity or
file-change list reaches either boundary, continued wheel or trackpad input
scrolls the transcript instead of being trapped by the nested region.

When a tool step has no non-whitespace public commentary, the runtime projects
one bounded provider-neutral progress summary from the verified tool name and
safe arguments. The summary follows the original user's Chinese or English
language and never copies private reasoning. Whitespace-only model messages are
discarded, and identical synthesized summaries are not repeated.

ADK sessions are process-local caches. Before a new Turn, provider-neutral
completed history is rebuilt from Rust SQLite. The original user content from a
terminal `interrupted` or `failed` Turn is also restored as task intent, while
that Turn's model/tool history is excluded. Worker loss therefore never resumes
an incomplete tool call or side effect, but a later short continuation message
still has the original request in context.

Enabled Skills are snapshotted from Rust before each primary or child ADK
invocation. The Agent instruction receives the bounded name/description
inventory. Up to four Skills explicitly named as `$name` in the user content
are included directly, while the read-only `load_skill` tool can load another
applicable Skill from that same frozen snapshot. Explicit and on-demand content
share a 128 KiB per-Turn bound. A Skill can narrow the requested workflow but
cannot expand tools, filesystem authority, approvals or user intent. Changes
made from Settings therefore affect later Turns and never mutate the active
Turn's instruction or tool inventory.
An on-demand `load_skill` call is projected as a durable provider-neutral
`skill` activity for both the live Turn and restored history. The Renderer
presents its normalized name without the `$` invocation marker as one compact
localized Agent-process sentence (`using`, `used`, `failed` or interrupted),
instead of a prominent status card or duplicated synthesized commentary. The
successful sentence includes the Agent's bounded task-specific purpose, while
only the exact Skill name is a blue reference matching file citations; the
following plain-text `Skill` suffix is not part of the link. Activating the name
opens the exact bounded frozen Skill body in the right context rail;
it does not expand inside the transcript. A recovered retry for the same
normalized Skill replaces its transient failed activity rather than leaving
contradictory rows.

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
request. An ordinary tool execution error is different: after two identical
failures the driver injects one concrete recovery continuation, and only a
third unchanged failure without intervening success terminates the Turn as a
protocol stall. Each provider request retains its own deadline; the Desktop
profile defaults that deadline to five minutes, while a Turn has no wall-clock
or tool-count success threshold. Provider adapters never infer tools from
ordinary prose, reasoning, language, or generic markup.

The primary Turn progress surface derives its current stage from the latest
verified live activity instead of treating every quiet interval as model work.
It distinguishes workspace inspection, approval wait, user-input wait,
privileged execution and MCP execution. A Turn with no active operation remains
a calm `thinking` state;
normal provider latency never escalates into a synthetic warning, model-name
diagnosis or elapsed-time counter. The live state uses a subtle motion-safe text
shimmer, while the composer retains the immediate stop action. Active process
activity starts expanded so public commentary and tool progress remain visible
while the Agent works; completed activity collapses by default, while activity
that requires approval or another user decision also auto-expands.

A primary Agent can pause its current structured tool loop for user input.
`turn.userInputRequested` projects a single transcript card that presents one
question at a time, two or three radio choices, and a custom-answer input.
Multiple questions advance with Back/Next controls and submit atomically only
after every answer is non-empty. Main validates the active workspace, Thread,
Turn, request identity and complete question set before sending
`turn.userInputResponse`; `turn.userInputResolved` removes the card before the
same Agent continues. This is a general Turn capability used for materially
blocking choices, including planning, and is not a plan-mode-only UI path.
While it is visible the progress label is `等待你的回答`, the normal Composer
remains unavailable because the existing Turn is still active, and Stop safely
cancels the pending tool result with the Turn.

The same Turn Driver and completion gate run child Agents. A child without a
non-empty final answer fails instead of receiving a fabricated completion
summary. If the parent submits a final candidate before child results are
consumed, the gate waits for bounded results, classifies that candidate as
commentary, injects the results, and requires one new final answer.
The coordinator schedules dependency-ready child tasks concurrently through a
process-wide four-slot semaphore. Independent read-only tasks in one Workspace
may share a wave and run together. Workspace-writing tasks take an exclusive
per-Workspace gate, so they never overlap another reader or writer against the
same mutable tree; parallel write-heavy work requires a future isolated
worktree boundary rather than weakening that invariant. A dependent task stays
queued until its prerequisites reach the required terminal state.
Workspace-writing child waves always end in a dependent read-only audit. The
parent may describe that auditor explicitly; otherwise the collaboration
coordinator creates one bounded runtime auditor before the DAG is persisted and
scheduled, avoiding repeated dispatch failures and repeated large task briefs.
If the most recent tool result failed, the driver likewise demotes the first
final candidate to commentary and grants one bounded recovery continuation.
A `workspace_read` result whose only unsuccessful entries are `notFound` is an
exception: confirmed absence is valid observational evidence, so it does not
trigger recovery or move an otherwise accepted final summary into the process
disclosure. This retry is otherwise structural and provider-neutral; it does
not classify the public answer text, and a successful later tool result permits
normal completion.
Command results count as failed when their nested process outcome is a non-zero
exit code, signal or timeout even though the durable operation status itself is
`completed`. Workspace patch operations have a distinct provider-neutral
`workspacePatch` success outcome carrying the changed-file count and optional
per-file review receipts; Main and the Renderer must not run successful patch
receipts through the Shell-process classifier or label them as failed commands.

## UI compatibility

Conversation, model configuration, attachments, approvals, MCP, Git, workspace,
terminal and orchestration keep their existing Renderer/preload surfaces.
Private Main adapters translate these calls to the utility runtime. The old
app-server public protocol, CLI supervisor and sidecar executable no longer
exist.
Main creates each Desktop window hidden and reveals it only after Electron's
`ready-to-show` signal, so a cold start never presents an unpainted Renderer
frame. On macOS, closing the main window hides it without destroying its
Renderer; activating the app restores and focuses that same window, preserving
ephemeral UI state such as expanded workspace directories. Application quit
still destroys the window and shuts down the supervised runtime normally.
The Skills Settings surface follows the 1.0 inventory/detail hierarchy while
using the 3.0 process boundary: Renderer owns loading and selection state,
preload exposes a fixed validated API, Main owns trusted IPC plus native
directory pickers, and the runtime delegates discovery/import/export to Rust.
It supports refresh, enable/disable, SKILL.md preview, personal or current-
project import and directory export. Current-project import is disabled for a
managed non-project Chat workspace.
The Settings navigation currently rollout-gates MCP: its entry remains visible
as a disabled forthcoming item, and the Renderer does not mount the MCP session
or registry configuration surface while that gate is active.
Runtime readiness is reflected through conversation availability and the
settings diagnostic rather than a persistent window footer. Removing that
duplicate presentation does not remove Main's handshake or supervision.

The composer exposes the approval mode as a descriptive permission panel rather
than an unlabeled compact menu. It names the access boundary, explains each
mode, and shows the effective mode for the visible Thread and workspace. The
approval dialog uses the same three labels and scope rules so choosing a mode
while accepting a pending operation has exactly the same effect as changing it
from the composer. Child tasks delay their `waitingApproval` projection briefly;
an immediately inherited policy decision therefore stays in the running state,
while a real unresolved prompt still becomes visible. Resolved policy activity
is labeled as inherited access in the command audit.
The conversation input grows with the draft to a bounded height and keeps its
attachment, model, permission and send actions in one compact toolbar. Normal
idle readiness, draft byte counters and token-usage summaries are not rendered
there; shared request validation continues to enforce the bounded cross-process
input contract.
The Composer also exposes one keyboard-first suggestion surface for three
explicit user notations. A line-leading `/` filters SugarCode-owned task
commands, `$` filters the enabled Skill inventory, and `@` searches regular
files in the active Workspace. Arrow keys move the active option, Enter or Tab
inserts it, and Escape closes the surface without changing the draft. Task
commands remain provider-neutral user intent, `$name` retains the frozen Skill
selection contract, and file mentions never grant access outside the active
Workspace. Once inserted, all three notations are mirrored in the input using
the existing blue, non-underlined reference treatment while the native textarea
remains the editing and accessibility surface. The mirror never rewrites the
underlying plain-text Turn input, so selection styling cannot change runtime
semantics or persisted drafts. After submission the Renderer derives the plain
message and selected references from that persisted input: the message remains
inside the user bubble while deduplicated command, Skill and file references
appear as compact metadata below it. The runtime independently parses the same
bounded notation, maps commands to explicit task intent, makes an explicit Skill
binding within the plain-text request when its verified snapshot is present,
and directs the Agent to read referenced Workspace files before relevant
substantive work. The model-facing user content likewise separates the selected
metadata from the plain request, while explicit plain-text constraints remain
authoritative. This presentation and prompt enrichment does not grant new
authority or change stored user text.
Workspace-patch approvals are projected as a file operation, never as a shell
or sandbox command. Their bounded presentation lists the proposed create,
update, delete or move path effects and omits the private Agent tool name and
raw patch payload. The live audit carries an explicit `workspacePatch`
operation kind; legacy summaries containing the former internal name are
sanitized at the Renderer boundary, while recovered pending approvals are
revalidated against their stored arguments and republished with the safe
summary.

Conversation snapshots preserve the optimistic first-Turn projection while the
runtime acknowledges startup: `starting` may contain the newly allocated active
Turn and its user message. Preload validation must retain that state so the
Renderer can show the transcript before the first model stream event arrives.
Consecutive commentary deltas are coalesced into one process paragraph during
live projection, and persisted commentary deltas are coalesced again on restore;
provider chunk boundaries must never become visible paragraph spacing.
Commentary uses the same streaming-safe GFM renderer and primary body-text tone
as Agent responses, so headings, lists, emphasis and inline code have one
consistent Markdown interpretation. Public model text uses that primary tone
at full opacity from its first streaming frame, without a per-segment fade;
only tool activity, command state, loading indicators and low-priority metadata
use the process-text tone. A provisional
live text Item begins in the process projection rather than briefly appearing
as a final answer; its authoritative completed phase either keeps it as
commentary or promotes that same Item to the final response without duplicate
text or a process-to-primary color transition.
Provider-neutral `turn.toolCall` and `turn.toolResult` events are projected by
Main into ordered workspace read, list and search activities. Batched reads
become one row per file, repeated delivery is idempotent by call and path, and
the same ordered Items rebuild the activity timeline after a Thread is reopened.
The process disclosure and compact tool copy derive Chinese or English from the
original user message for that Turn; no provider-generated language guess is
required. The repeated-tool-failure summary and recovery guidance use that same
Turn language instead of exposing one fixed English status for Chinese Turns.
Compact tool groups are independently collapsible and have a bounded internal
scroll region. Each command row is a keyboard-operable disclosure of the full
command, retained stdout/stderr and structured result. Successful workspace
patch receipts are not presented as generic command invocations: the process
timeline projects one concise edited-file row per receipt with its
addition/deletion counts. The same receipts also produce one end-of-Turn change
summary with unique file paths and aggregate counts; this summary remains
visible for failed Turns that already changed files, so partial work is never
hidden behind the terminal error. Its compact summary header keeps the file
count and aggregate diff statistics on one line. Each 12px monospaced path
de-emphasizes the directory with the tertiary tone, retains the filename in the
secondary tone, and restores primary emphasis only on row hover. The complete
file row remains the review target and omits duplicate edited-state and
review-action labels. Selecting a receipt row opens its immutable review diff in the context
rail, while selecting a safe relative file reference from workspace reads,
Agent Markdown or the project tree opens a fresh bounded workspace inspection.
Agent Markdown file references use the dedicated link color and file glyph so
they remain distinguishable from ordinary inline code in both themes. Hover or
keyboard focus shows a delayed tooltip with the exact project-relative path, or
the original absolute location for an explicit contained citation. Main converts
that citation to a safe project-relative path before the context rail opens it;
outside-workspace citations remain closed and never fall back to their visible
basename. A Markdown link derives file identity only from its href; its visible
label is flattened to plain link text, so a code-formatted label neither keeps
literal backticks nor adds an inline-code background. Path-shaped labels use
the basename when unique within the rendered message and expand only to the
shortest distinguishing suffix when names collide; intentional semantic labels
remain unchanged. Ordinary code spans are
promoted to file references only when their file-like text uniquely matches a
successful workspace read or non-deleted file change from the same Turn by
exact path, suffix or basename. Member expressions, package and lint-rule names,
unverified paths and ambiguous suffixes remain ordinary inline code. The
Renderer builds one suffix index per Turn projection, so transcript rendering
does not repeatedly scan the workspace or linearly search every known path.
The resulting verified path is already exact even when it names a root-level
file such as `Dockerfile` or `.env`, so its click bypasses basename lookup.
Explicit basename-only href references resolve only when their tooltip actually
opens, through the same bounded unique-match lookup used before opening.
Resolution promises are deduplicated per Workspace generation, and neither
rendering a large transcript nor briefly crossing a reference starts a
filesystem scan or opens the context rail.
Focus, tooltip preparation and click share the same in-flight resolution; a
click waits for that promise and opens the resolved file instead of treating
the intermediate loading state as a completed no-op.
The Renderer never fabricates a diff by rereading mutable workspace content.

When a tool step contains no public model commentary, the runtime's synthesized
workspace-read summary uses basenames for batches of up to three files and only
the file count for larger batches. The durable tool activity retains every full
path. Its expanded read rows apply the same shortest-unique-suffix presentation,
with the exact path available on hover, keyboard focus and the open-file action.
This keeps process prose compact without weakening path identity or audit data.

The context rail owns one persistent project explorer tab plus transient file,
diff and child-Agent detail tabs. The navigator keeps a persistent add action at
the right edge of both the project and chat section headings. Project add opens
the folder picker; chat add starts an independent chat draft. A saved project
group is a local disclosure: selecting its folder row
only expands or collapses the retained Thread list and does not bind a Workspace
or initialize the conversation and context surfaces. Expanding or collapsing a
project performs one layout update; the affected navigator groups interpolate
their previous positions with compositor transforms while the task list uses a
short clipped reveal. The first visible task rows mount with that initial frame;
the disclosure reserves the complete list height and hydrates the remaining
interactive rows after motion settles, avoiding both click latency and a second
layout shift. The collapsed task list unmounts after exit so closed projects do
not retain large hidden DOM trees or rebuild their Thread elements during
unrelated navigator renders. Reduced-motion preferences disable those animations.
Selecting its add action activates that project before creating a Thread, while
selecting a retained Thread focuses its owning Workspace. Switching the
foreground Thread clears transient context tabs rather than carrying file or
review state across workspace identities. Navigator and context-rail open/close
transitions animate their clipped width and opacity while retaining mounted
content. On a fresh installation the navigator starts open and the context rail
starts closed; later launches restore the user's saved open/close choices.
Direct panel resizing disables those transitions so pointer movement remains
exact.
The local-terminal action lives in the conversation header immediately before
the context-rail toggle. Opening it keeps the left navigator visible and limits
the bottom workbench to the remaining conversation and context width. A ready
Workspace automatically requests one shell start when the panel opens, and one
for a new foreground Workspace generation if the panel remains open, without a
Renderer or native confirmation step. Main still revalidates the frozen
Workspace identity immediately before dispatch, and the terminal controller
retains its single-session, approval-pause and bounded-flow safeguards.
The native terminal driver owns its process-containment resource for the whole
PTY session. On Windows this is an `OwnedHandle` for the kill-on-close Job, so
ownership can move safely to the driver thread and the handle is closed exactly
once after that thread terminates.
The composer identifies a project destination with a compact folder control
above the prompt. Selecting that control reopens the folder picker. Before the
first Turn creates a durable Thread, the control reveals a remove action on
hover or keyboard focus; removing the project activates a fresh chat draft.
Existing project Threads continue to show their project folder but never expose
this destination-removal action.
The project explorer itself remains mounted while a resource or Agent tab is
active, so expanded directories and the last selected file or folder survive
tab changes. Every loaded directory is presented with folders first, followed
by regular files, links and special entries; each group uses case-insensitive
natural filename ordering. Opening a resource from a transcript, change receipt
or project tree synchronizes that selected path when the matching tree entry is visible.
Active context tabs and tree rows use the shared link accent as their selection
cue in both themes.

Bounded text-file previews use the same escaped highlight.js projection as Agent
code blocks, selected from the inspected file extension and falling back to
plain text for unknown formats or oversized input. Diff review keeps addition
and deletion row backgrounds as the change signal while rendering the line body
with the original language's syntax colors; only the leading `+` or `-` marker
uses a status foreground color. Turn change summaries retain exact
project-relative paths, use a deliberately subtler neutral border, and do not
add a pressed or selected visual state when a row opens its immutable review.
Saved project and Thread rows expose their destructive navigation action on
hover or keyboard focus without requiring prior selection. Removing a project
forgets only its saved navigation owner and never deletes the project directory
or durable Threads; a project with a running Thread cannot be removed, and
reopening the same directory can bind its retained runtime Thread index again.
Project and Thread selection use native button boundaries beside their sibling
actions, so activating a destructive control cannot fall through to row
selection. The confirmation remains open while the mutation is pending, closes
only after an accepted result, and renders a retryable failure in place instead
of dismissing before an unsuccessful deletion becomes visible. Accepted
navigation mutations without a foreground commit perform one authoritative
Workspace snapshot read as a projection fallback instead of relying only on the
asynchronous change broadcast to remove the row. A saved Thread's delete action
is disabled only while its Turn is running, the Workspace is switching, or
another lifecycle mutation is pending; a global conversation loading or
unavailable status does not independently disable the action, and an actual
backend failure remains visible in the confirmation.
Every saved Thread row exposes a compact Codex-density plain-text rename option
through a keyboard-accessible shadcn context menu opened from the row's native
context-menu gesture. Renaming resolves the Thread's registered Workspace owner
and does not select the Thread or change the foreground Workspace. Hover and
keyboard focus reveal only the destructive delete action; fork and archive are
not Desktop actions. The shadcn Dialog and Input collect one trimmed, bounded
title and keep failure feedback in place. Rename is safe while a Turn is
running because it changes only Thread metadata, while delete retains its
running-Turn guard. Rust SQLite remains authoritative, and a manual rename wins
over any in-flight generated title through the conditional persistence
boundary.
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
During a foreground Thread selection, Renderer-only pending state survives
intermediate navigation snapshots and is cleared by either the matching atomic
foreground commit or an authoritative conversation snapshot that already
selects the pending target. This keeps one continuous selection placeholder
instead of briefly exposing the previous or empty transcript. The navigator
resolves that pending target before the active-Workspace projection, so its
selection color and opening indicator respond to the click immediately while
the transcript loads. A Chat switch whose target snapshot arrives before its
Main response can still complete the selection.
A successful selection keeps the placeholder visible while React prepares the
target transcript concurrently, then restores tail-following and reveals the
content only after its first Markdown layout is anchored. Live updates within
the selected Thread remain synchronous and are not deferred. A failed selection
retains its retry surface without changing the visible transcript position.
Optional navigator fields are omitted when cleared rather than serialized with
`undefined`; every snapshot published by Main must pass the same preload
validation used at the Renderer boundary.
The same rule applies to token usage: required provider counts are finite,
non-negative safe integers, while absent optional reasoning and cache counts
are omitted. Electron structured clone and JSON persistence must therefore
produce the same valid projection shape.
Recovered `runtimeRestart` records are projected as the public `incomplete`
Turn error, and interrupted Turns may retain that classified error so a restored
transcript remains valid and explains why work stopped.

Every `ConversationStateSnapshot` identifies its own workspace. Workspace and
Thread list/load/select requests capture that identity at dispatch time, while
workspace switching uses a monotonically increasing latest-wins generation.
Late results may update only their owning workspace cache and cannot restore an
older foreground selection. Runtime Thread indexes are replaced from the
snapshot's workspace identity rather than a mutable adapter field.

Foreground task selection is one Main-owned transaction. A successful focus
returns a `ForegroundCommit` containing one generation, Workspace projection
and Thread projection. Same-project, cross-project and standalone Chat tasks
use this path. The Renderer marks the target immediately, hides the previous
transcript behind a target-scoped skeleton, and applies only the latest commit.
A failed target remains selected with a local retry surface; it never restores
old transcript content under the target title.

Conversation streaming is Thread-scoped after the initial full projection.
Main retains projections and monotonic revisions per `threadId`; live runtime
events publish a `ConversationThreadProjectionDelta` for only their owning
Thread and changed Turn. Background deltas update the application-level
Renderer cache but cannot replace the selected transcript. Global conversation
snapshots are reserved for navigation or selection changes instead of being
resent for every text, usage, tool or Agent-task event. A revision gap triggers
one Thread-local reload, leaving every other active Thread untouched.

Child-Agent task snapshots include bounded live progress with an explicit stage
(`waitingForModel`, `streaming` or `runningTool`), a public Markdown summary and
an update timestamp. The orchestration workbench projects the validated DAG as
bounded execution-wave rows instead of a freeform canvas: tasks at the same
dependency depth share a responsive grid row, later rows expose dependency
order, and queued cards distinguish dependency waits from bounded
Workspace-access or execution-capacity waits, including the exclusive write
boundary. Task summaries are height-bounded so one verbose child cannot turn a
parallel wave into a narrow vertical tower. While the parent Turn is active, a
compact Agent-task status strip stays directly above the composer with the
highest-priority task, aggregate progress and one thin progress rail. Its
anchored popover is a bounded, divided live-work list rather than a second copy
of the durable wave grid: approval and failed tasks come first, followed by
running and queued tasks, while completed or cancelled tasks stay out of the
live list. Each live-list row exposes only the task title and status; task
briefs, progress summaries, dependency waits and results remain in the selected
task's detail rail. While the parent Turn is active,
the transcript suppresses the durable wave grid so the dock is the only task
status surface; once the Turn reaches a terminal state, the dock disappears and
the transcript exposes the complete orchestration record. This keeps current
progress reachable without duplicating the same tasks or repainting the full
dashboard on every progress event.
Selecting a task opens a detail rail that renders the durable public execution
trace in order: frozen task brief, amendments, latest live progress and terminal
result. Dependency and access metadata remain visible without exposing a
provider log or implying that every ready write can run concurrently. The
terminal task result remains the durable completion contract.
