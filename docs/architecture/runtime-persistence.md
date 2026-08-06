# Runtime and persistence boundary

## Runtime topology

All surfaces compose the same provider-neutral Runtime:

```text
Desktop -> app-server -> AgentSurfaceRuntime -> Core
exec -----------------> AgentSurfaceRuntime -> Core
TUI ------------------> AgentSurfaceRuntime -> Core
```

Core owns Thread, Turn and Item lifecycle, tool continuation and durable-first
ordering. `agent-runtime` owns process-local composition,
configuration resolution, tools, provider construction and shutdown.
App-server, exec and TUI are presentation/transport surfaces, not alternate
state machines.

Desktop's multi-workspace app-server keeps one global control session and
creates one lazy runtime context per registered canonical root. Those contexts
share the same rollout repository but retain separate workspace capabilities,
instruction scopes and active-Turn ownership. Thread, Turn and Item identity is
a canonical lowercase UUIDv7 generated at creation; no process-wide numeric
allocator or replay-time maximum-ID scan exists.
Thread-to-workspace routing is restored from durable descriptors when an idle
context is reloaded; a context unload never deletes rollout or search state.

Desktop has one process-local `ThreadRegistry`. Every Thread has one record with
its binding source, immutable protocol-confirmed Workspace ID, owner, title,
active membership, Runtime, unread status and reload-required status. The
Runtime owns live phase, active Turn, Turn/Item projection, notice, attachment
previews and the bounded `turn/start` lifecycle buffer. The visible transcript
is only a foreground projection of one Registry entry; selecting another
Workspace or an empty chat changes that pointer and does not transfer or stop
background execution. Before `thread/start` returns, one pending start
transaction retains the request Workspace and buffers the matching early
lifecycle. After binding, only acceptance or rejection of `turn/start` is a
navigation barrier. Turn completion is not a barrier.

An accepted Turn has no wall-clock execution deadline. It remains active until
the model reaches a terminal result, the user interrupts it, the consumer
closes, shutdown begins or a typed provider/transport/durable-state failure is
observed. Long-running model and tool activity must not be converted into a
synthetic timeout merely because the Turn crossed a fixed duration.

Provider configuration is resolved when a Turn starts. Initialization,
workspace binding, settings and Thread history therefore remain available when
model configuration or authentication is broken.

## Durable ordering

Rollout JSONL is the authoritative source. SQLite discovery and search are
rebuildable projections. A public lifecycle never precedes its durable record:

```text
turnStarted
  -> item started/completed records in order
  -> exactly one terminal Turn record
  -> public terminal notification
```

Config `schema_version`, rollout `schemaVersion`, app-server
`protocolVersion` and Desktop `contractVersion` all remain `1`. Current v1
shapes are intentionally incompatible with earlier development data. There is
no dual reader or migration and repository code never deletes `~/.sugarcode`.

Desktop's local window/session registry is a separate presentation cache. Its
schema version remains `1`; existing project Thread arrays/title maps and chat
records hydrate `ThreadRegistry` as non-authoritative `sessionCache` entries.
Missing Workspace IDs remain bound to an owner key until that project or chat is
opened. A protocol result may correct a cached binding once; a later change to a
protocol-confirmed binding is a protocol failure. `thread/list` atomically
replaces one Workspace index without disturbing other Workspaces, and the next
normal save derives the same v1 disk shape from Registry views. Background title
notifications update only their Registry entry without promoting the Thread
into the foreground Workspace index.
Permanent deletion of an unavailable isolated chat remains durable-first: Main
issues workspace-bound `thread/delete` by canonical Workspace and Thread IDs,
using the one protocol-confirmed Registry binding during normal operation and
trying other known bindings only for an unresolved legacy cache entry. It then
removes the Registry record and atomically saves the derived Desktop session. A
Thread absent from every legacy candidate Workspace is treated as a completed
permanent deletion; if no Workspace deletes it and any app-server attempt fails,
the local entry remains intact.

Restart converts unfinished Turns to Interrupted. It never retries an external
call, reapplies a file change or fabricates a ToolResult. Fork copies completed
history with fresh globally unique IDs and no shared future state.

Rollout files remain `rollouts/v1/<thread-uuid>.jsonl`, and their internal
`sequence` remains the append order inside one rollout rather than an identity
source. Discovery and search remain schema-1 databases under `projections/v1`.
Their Thread cursor is the canonical UUIDv7 string ordered by SQLite binary
collation descending. Search documents use a SQLite-generated integer
`document_id` only as the FTS rowid; the UUIDv7 Item ID stays a unique value and
is never converted into an integer.

The stdio JSONL stream preserves in-process message order, and every live
lifecycle or approval route contains its authoritative Workspace binding. No
additional public event sequence exists. Rollout `sequence` is durable append
order inside one Thread only and must never be treated as a live transport
sequence. After disconnect, Desktop rebuilds a selected or quarantined Thread
through durable `thread/resume` rather than attempting to splice missed live
events into an in-memory projection. A background Runtime that was active when
the transport ended is marked reload-required and loses its speculative running
projection; selecting it after reconnect resumes the durable interrupted or
completed state.

## Model history

Durable ToolCall stores `callId`, SugarCode tool name and the original
provider-neutral argument value. Function tools retain their JSON object;
freeform tools retain their raw string. This removes empty-path pseudo calls and
preserves patch text, line edits, collaboration envelopes and shell descriptions
across restart. Provider result history preserves call ordering and parallel
batch relationships.

Runtime maintains two histories during an active Turn. Wire replay history
retains native provider continuation in its exact block, signature and tool
order; portable history retains visible messages, tool calls and tool results.
Opaque provider continuation is neither interpreted nor persisted as portable
history.

Failed and interrupted Turns remain conversation context at Item granularity.
Their completed user input and balanced ToolCall/ToolResult pairs are portable
to the next Turn, including after a wire switch or sidecar restart. Partial
assistant text, incomplete commentary, orphaned calls and provider-private
context are excluded. This lets a later
“continue” retain verified work without replaying an uncertain side effect.

Within a Responses Turn, exact wire replay is selected only when an opaque
reasoning Item is present. A text/tool-only response continues from normalized
portable ToolCalls and ToolResults, avoiding response-only fields that some
compatible gateways reject with a server error. This selection happens before
the next request. Opening or consuming a provider stream may be retried up to
two times for transport, disconnect, timeout, 429, 5xx or empty incomplete
failure only while no semantic output exists. Native Chat performs those
recoveries as non-streaming JSON completions against the same endpoint, model
and wire. A compatible Responses provider may instead use the same gateway's
streaming Chat delivery with the existing HTTP client when no opaque Responses
continuation is present. Failures after any delta and all request/protocol
failures remain terminal for the current Turn.

The Turn boundary is also the model-switch boundary. The next Turn reconstructs
portable history from durable provider-neutral Items and may add one model-
switch instruction; it never imports a preceding Turn's response ID, encrypted
reasoning, thought signature or other native continuation. Unsupported
historical image/PDF assets become bounded metadata-only text descriptors for
that request, while unsupported assets submitted in the current Turn remain a
pre-I/O error.

Streaming text deltas are ephemeral presentation hints. The completed typed
model item is authoritative for classification and durable storage, so a
provider or compatible gateway may normalize the final text without requiring
byte equality with the preview. Output identity and ordering must still match;
unmatched or duplicate output references remain protocol failures. A preview
that is absent from a ToolCall-only completed snapshot is explicitly discarded
and never becomes a durable Item; this lifecycle close happens before the next
model request starts.

Runtime does not classify final prose with language-specific keywords. A
provider-normalized final text item is persisted and completes the Turn; tool
calls continue it. This matches the structural event boundary used by the model
protocol and avoids heuristic completion or blocker dictionaries.

The same discard boundary applies when a provisional preview reaches its local
rendering budget. Core stops retaining further deltas for that output reference
but continues parsing the provider stream; only the authoritative final text,
tool arguments or tool result may produce an output-size Turn failure.

The active Agent loop sends the complete available history on every locally
replayed request. Provider-managed continuation may send only the new tail over
the wire, but its opaque provider state represents the preceding response chain.
Runtime neither estimates a local context-window admission limit nor replaces
history with a summary. A provider may still reject a request according to its
own hard context or transport limits; that error is mapped without local
compaction or truncation.

Tool correction has both category-specific consecutive limits and one Turn-wide
non-progress budget. Argument rejection, execution validation failure and
approval denial share that budget even when successful reads occur between
them, so alternating failure categories cannot keep a Turn alive indefinitely.
An applied workspace mutation is concrete progress and resets the Turn-wide
budget; a later independent correction therefore receives its normal retry
allowance instead of inheriting stale failures from before successful writes.

Turn usage preserves billing semantics separately from context admission. It
stores the last request, cumulative Turn total, maximum request input and
request count plus the frozen model window and whether values are provider-
reported or estimated. Cumulative input may exceed the model window because it
is the sum of several independent requests; that condition never triggers
compaction or a context error.

## Content store

`SugarCodeHome/content/v1` is a content-addressed asset store. Import verifies
content, writes a temporary file, fsyncs, atomically replaces and deduplicates
by SHA-256. Rollout stores only asset ID, hash, MIME, original name, size and
kind. It never stores Base64 or an absolute source path.

Before a provider request, Runtime reopens the asset, verifies its hash and
checks the frozen model capability. Missing, corrupt or unsupported assets fail
deterministically before provider I/O.

Accepted Turn limits are ten attachments and 20 MiB total raw input. Per-file
limits are 8 MiB for PNG/JPEG/WebP/non-animated GIF, 20 MiB and 100 pages for
PDF, and 1 MiB for UTF-8 text. Server validation uses magic bytes, UTF-8, GIF
animation inspection and PDF page counting rather than extension or client
MIME.

## Terminal and error boundary

`stateUnavailable` is reserved for rollout append/fsync/read/replay failures or
an invariant that makes durable continuation unsafe. User interruption,
consumer closure and shutdown finish as `interrupted`. A Desktop protocol
mismatch is a connection diagnostic and does not claim storage corruption.

Tool validation emits `toolValidationRejected` plus a bounded structured JSON
model result and keeps the sidecar alive. Consecutive retry exhaustion is
calculated per structural signature (tool, error kind, field path, reason and
expected shape), not across unrelated invalid payloads; the existing total
non-progress budget still bounds alternating failures. Workspace rejection
identifies the field path, stable reason, expected shape, value-free actual JSON
type and suggested action. Shell rejection identifies the violated safe shape
with a bounded expected summary and suggested action. Neither path retains the
rejected command or argument values. On macOS and Windows the model-facing
shape is one complete command with optional cwd and timeout; runtime defaults
omitted cwd to the capability-owned root before approval. The exact-executable
`argvJson` direct form remains an internal authority and is not advertised
beside Full Access. A bounded ASCII-decimal string timeout is normalized as
compatible shell syntax while the durable ToolCall retains its original
arguments. Rollout execution-attempt validation infers the authority from the
argument shape: sandbox receipts are mandatory for direct and forbidden for
approved Full Access shell. A valid batch resets the consecutive signature
counter. After an `invalidArguments` result, ordinary final text is discarded
until the next model round produces a valid advertised tool call; one repeated
final attempt then fails as typed `unsupportedToolArguments`. Any valid tool
batch clears that immediate correction obligation because the model may
deliberately continue through a different tool, and a stale rejected tool name
must not invalidate a later final response after successful work. Three
consecutive structurally invalid apply-patch calls no longer terminate a Turn
when Full Access shell is available: Runtime suppresses apply-patch for the
remainder of that Turn, leaves shell advertised and requires the model to
continue through a valid alternative. Without that alternative, the normal
typed exhaustion remains. Provider transport/protocol errors, tool errors,
Desktop protocol errors and durable-state failures remain distinct; each model
failure terminates only its Turn and does not terminate the app-server process
or another Thread.

Model capability flags constrain outbound requests but do not constrain what a
compatible gateway may return. A provider-emitted multi-call batch is therefore
durable input even when parallel calls were not requested. Core validates the
batch and schedules only safe read-only members concurrently; approvals,
writes and other non-parallel tools remain sequential. An interrupted Turn may
end after several command calls were declared but before all received approval
or execution Items. Recovery preserves the completed lifecycle prefix, drops
unmatched calls from portable future context and never re-executes them.

Shell execution errors are model-visible structured results. In particular,
`commandNotFound` identifies the active `hostInheritedV1` policy and directs
the Agent to inspect project configuration and try safe installed alternatives
before reporting the exact missing dependency. The result does not claim that
the sandbox lacks a runtime merely because an earlier minimal environment
removed `PATH`.

A protocol error may persist `{ stage, code, eventType?, shapeSha256 }` in the
existing rollout v1 Turn error. The field is optional, so earlier rollout
records decode without migration. The shape hash is computed from JSON keys and
types only; raw provider values, response bodies, reasoning, tool arguments,
credentials and local paths are excluded. Public app-server mapping preserves
the same provider-neutral diagnostic and never exposes an SDK type.

A Desktop projection error with a valid, unchanged Workspace/Thread route is
contained to that Thread. Desktop discards the untrusted in-memory Runtime,
clears its speculative running/unread state, safely denies its outstanding
approvals and requires an explicit `thread/resume` on the next selection. It
does not interrupt another Turn or restart app-server. Framing, JSON-RPC,
unknown-route, Workspace-binding, approval, handshake and version failures stay
outside this containment boundary and trigger the global sidecar recovery path.

Model-limit failures are also distinct: `contextWindowExceeded` is limited to
one request that cannot fit after recovery, `providerRequestTooLarge` is an HTTP
or gateway request-body limit, `providerResponseTooLarge` protects the 64/128
MiB private-response resource boundary, and `outputTooLarge` is limited to
visible or locally retained output. Existing durable `outputTooLarge` records
retain their original meaning when replayed.

Completed final text and commentary paired with tool calls have no
phase-specific byte ceiling. An oversized provisional preview may be discarded
at the rendering budget, while the authoritative completed text remains
eligible for durable persistence and replay under the shared rollout and
provider resource boundaries.

Thread search indexes completed user/final assistant text only. Attachments,
commentary, tool payloads, provider context, compaction bodies and diagnostics
are excluded.

Thread list, search, resume and fork responses expose an optional display title.
After the first accepted task-bearing Turn, Core starts a separate bounded,
tool-free model request that treats the durable user content as untrusted source
material and asks for a concise title in the same language. A valid result is
bounded to 48 Unicode characters, appended once as a `threadTitleUpdated`
rollout record and then projected by every read path; title generation failure
never fails the owning Turn, and a later accepted Turn may retry while the
Thread remains untitled. A Thread without an explicit title projects no display
title; durable user text is never reused as a title fallback.

## SugarCode 3.0 SQLite checkpoint

The 3.0 utility runtime has an independent SQLite store at
`~/.sugarcode/v3/sugarcode-v3.sqlite3`. It never reads or migrates rollout v1.
Schema v1 records provider-neutral workspaces, Threads, Turns, ordered Turn
items, operations, approvals and Agent tasks. Schema v2 adds model profiles and
separately stored credentials; schema v3 adds Thread archive and fork lineage;
schema v4 adds content-addressed asset metadata.
The connection enables foreign keys, WAL mode and a bounded busy timeout, and
the database file is restricted to the owning user on Unix.

Item IDs and `(turn_id, sequence)` are unique. Repeating an identical item,
operation proposal, approval decision, terminal Turn result or operation result
is a no-op; reusing the same ID for different content is a conflict. Operation
proposal and approval creation are one immediate transaction. On process open,
running Turns become retryable `interrupted`, running/waiting Agent tasks become
`interrupted`, and executing operations become retryable failures. Pending
approvals remain pending and no operation is automatically executed.

Renderer model configuration, attachment import and conversation reads/writes
now use the 3.0 utility runtime behind the existing preload API. Approval
proposals, atomic workspace patches and Git operations also persist or execute
through that runtime and the native module. Attachment bytes live only in the
v3 content-addressed store; SQLite retains their verified descriptors.

Bounded `shell_exec` calls use the same operation ledger. Approval moves an
operation from `proposed` to `approved`; the host must durably claim it as
`executing` before native dispatch and records the terminal result as
`completed` or `failed`. Duplicate `operationId` claims do not execute the side
effect again. Sandboxed direct commands reuse the capability-bound,
read-only/network-denied supervisor in the native module, while Full Access
commands use the bounded shell path. Active native process trees are indexed by
`operationId`, allowing Turn cancellation or worker shutdown to terminate them.
Full Access remains an explicit per-operation decision and cannot consume a
Thread or Workspace automatic-approval mode.

Live Full Access stdout/stderr is process-local and bounded. The native module
queues chunks by `operationId`; the TypeScript host drains them into private
`operation.output` events, and Main projects them into the existing command
activity. Only the bounded terminal process result is persisted. The output
queue is removed after final drain and never reconstructed after restart.

Interactive terminal sessions are intentionally not SQLite state. Main assigns
a UUID session and workspace generation, the utility runtime owns its polling
and flow state, and the Rust native module owns the PTY/ConPTY handle plus its
process containment. Input and output are UTF-8 byte bounded. Private native
input-accepted receipts keep Main's pending-input queue bounded. Renderer output
acknowledgement drives Main's high/low-water pause, while native queues impose a
hard overload boundary. Workspace replacement requests graceful termination;
explicit close, owner loss, overload or runtime shutdown terminate the process
tree. A utility-process crash is projected as the existing terminal failure
rather than recreating or replaying a shell session.

The TypeScript ADK session remains an in-process cache. Before the first new
Turn on a Thread, Runtime rebuilds completed user/model events from SQLite into
ADK, reopening and hash-verifying every referenced asset before provider I/O.
Incomplete Turns are deliberately excluded so an interrupted tool call is never
resumed as completed history. SQLite stores SugarCode's own discriminated text,
reasoning, media, tool-call and tool-result parts; serialized ADK `Event` objects
and provider SDK response objects are not persistence formats.

Pending-approval replay, MCP and dynamic multi-Agent state remain migration
gates. Workspace selection and app connection state therefore continue to use
app-server during coexistence; neither app-server nor the CLI sidecar may be
removed at this checkpoint.
