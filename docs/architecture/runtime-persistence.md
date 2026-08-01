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

Context compaction uses the frozen Turn model. Private checkpoint text is
rollout-only; the public `contextCompaction` Item contains byte counts, hashes
and outcome. Tool receipts retain argument/result hashes rather than raw
content when compacted.

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

Tool validation is recoverable until the same diagnostic fingerprint occurs
three consecutive times. It emits `toolValidationRejected` plus a bounded model
result and keeps the sidecar alive. Provider transport/protocol errors, tool
errors, Desktop protocol errors and durable-state failures remain distinct.

Thread search indexes completed user/final assistant text only. Attachments,
commentary, tool payloads, provider context, compaction bodies and diagnostics
are excluded.
