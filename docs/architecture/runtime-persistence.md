# Runtime and persistence boundary

## Runtime topology

All surfaces compose the same provider-neutral Runtime:

```text
Desktop -> app-server -> AgentSurfaceRuntime -> Core
exec -----------------> AgentSurfaceRuntime -> Core
TUI ------------------> AgentSurfaceRuntime -> Core
```

Core owns Thread, Turn and Item lifecycle, tool continuation, compaction and
durable-first ordering. `agent-runtime` owns process-local composition,
configuration resolution, tools, provider construction and shutdown.
App-server, exec and TUI are presentation/transport surfaces, not alternate
state machines.

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

Restart converts unfinished Turns and unfinished compaction checkpoints to
Interrupted. It never retries an external call, reapplies a file change or
fabricates a ToolResult. Fork copies completed history with fresh globally
unique IDs and no shared future state.

## Model history

Durable ToolCall stores `callId`, SugarCode tool name and the original JSON
arguments. This removes empty-path pseudo calls and preserves line edits,
collaboration envelopes and shell descriptions across restart. Provider result
history preserves call ordering and parallel batch relationships.

Runtime maintains two histories during an active Turn. Wire replay history
retains native provider continuation in its exact block, signature and tool
order; portable history retains only visible messages, tool calls, tool results
and checkpoints. Compaction always reads portable history, so opaque provider
continuation is neither summarized nor persisted. Private checkpoint text is
rollout-only; the public `contextCompaction` Item contains byte counts, hashes
and outcome. Tool receipts retain argument/result hashes rather than raw
content when compacted.

Failed and interrupted Turns remain conversation context at Item granularity.
Their completed user input and balanced ToolCall/ToolResult pairs are portable
to the next Turn, including after a wire switch or sidecar restart. Partial
assistant text, incomplete commentary, orphaned calls, provider-private context
and unfinished compaction checkpoints are excluded. This lets a later
“continue” retain verified work without replaying an uncertain side effect.

Within a Responses Turn, exact wire replay is selected only when an opaque
reasoning Item is present. A text/tool-only response continues from normalized
portable ToolCalls and ToolResults, avoiding response-only fields that some
compatible gateways reject with a server error. This selection happens before
the next request. Opening or consuming a provider stream may be retried once for
transport, disconnect, timeout, 429 or 5xx failure only while no semantic
output exists. Compatible Chat performs that one retry as a non-streaming JSON
completion against the same endpoint, model and wire; other providers retain
their declared transport. Failures after any delta and all request/protocol
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

The same discard boundary applies when a provisional preview reaches its local
rendering budget. Core stops retaining further deltas for that output reference
but continues parsing the provider stream; only the authoritative final text,
tool arguments or tool result may produce an output-size Turn failure.

The active Agent loop compacts from `estimated_context_tokens()`, never from
cumulative Turn usage or continuation ciphertext bytes. The latest provider
`input_tokens` is authoritative for observed requests; when usage is absent,
visible messages, tool definitions and tool results use a conservative
estimator, while private replay uses its recorded response output-token cost.

Tool correction has both category-specific consecutive limits and one Turn-wide
non-progress budget. Argument rejection, execution validation failure and
approval denial share that budget even when successful reads occur between
them, so alternating failure categories cannot keep a Turn alive indefinitely.
In addition to the normal output allowance, the loop preserves a separate
recovery reserve so that a tool-producing response and its results cannot leave
the following compaction request without context space. Provider requests that
generate checkpoints remain within the normal input budget.

An active-Turn checkpoint combines a bounded semantic execution summary with a
separately derived, bounded verbatim anchor of the active user's original input.
The anchor is retained independently of summary quality, while the semantic
section records verified progress, remaining work and the next action. A final
continuation directive requires the loop to resume the same task rather than
answer generically or claim premature completion. The combined private
checkpoint remains capped at 32 KiB; its recorded byte count and hash cover the
exact combined content that will be replayed.

The checkpoint keeps the original task anchor and two recent complete tool
batches. If the model-generated summary cannot be obtained, Runtime creates a
deterministic extractive checkpoint from portable history and continues the
same Turn. Provider `context_length_exceeded` triggers the same recovery path;
the compacted request must be both smaller than the rejected request and below
the recovery target. A non-shrinking or still-oversized result fails the current
Turn as a recoverable context-window error without another compaction loop.

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

Tool validation is recoverable for at most three consecutive invalid rounds,
counted across changing argument payloads and fingerprints. It emits
`toolValidationRejected` plus a bounded model result and keeps the sidecar
alive. Shell argument rejection identifies the violated safe shape with a
bounded expected summary and suggested action, without retaining the rejected
command or arguments; the absolute-executable, JSON-only `argvJson` and
fixed-cwd requirements remain unchanged. A valid batch resets the counter. Provider
transport/protocol errors, tool errors, Desktop protocol errors and
durable-state failures remain distinct; each model failure terminates only its
Turn and does not terminate the app-server process or another Thread.

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

Model-limit failures are also distinct: `contextWindowExceeded` is limited to
one request that cannot fit after recovery, `providerRequestTooLarge` is an HTTP
or gateway request-body limit, `providerResponseTooLarge` protects the 64/128
MiB private-response resource boundary, and `outputTooLarge` is limited to
visible or locally retained output. Existing durable `outputTooLarge` records
retain their original meaning when replayed.

Thread search indexes completed user/final assistant text only. Attachments,
commentary, tool payloads, provider context, compaction bodies and diagnostics
are excluded.

Thread list, search, resume and fork responses expose an optional display title
derived deterministically from durable user content. The first task-bearing
prompt wins, generic greetings are skipped when later content exists, and an
attachment-only prompt uses its original file name. Titles are bounded to 48
Unicode characters and remain a rollout-derived projection: they require no
model call and introduce no second persistence authority.
