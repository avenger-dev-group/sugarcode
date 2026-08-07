# Runtime and persistence

## Durable fact source

SugarCode 3.0 stores new state in
`~/.sugarcode/v3/sugarcode-v3.sqlite3`. It never reads, migrates or deletes
earlier configuration, rollout or search data. SQLite uses foreign keys, WAL,
a bounded busy timeout and owner-only Unix permissions.

The Rust rollout-v1 repository, its discovery/search projections and the old
internal protocol crate are not part of the 3.0 workspace. Only the v3 SQLite
store and content-addressed asset implementation are compiled into Desktop.

The schema records provider-neutral workspaces, Threads, Turns, ordered items,
model and MCP configuration, content-addressed asset metadata, operations,
approvals and Agent tasks. Provider SDK responses and serialized ADK events are
not persistence formats.

Agent-task payloads may carry a bounded provider-neutral progress snapshot: its
stage, public Markdown summary and last-update time. Progress replaces the
previous snapshot and is diagnostic/UI state, while status plus the bounded
terminal result remain the completion fact used by the parent Agent.

IDs and `(turn_id, sequence)` positions are unique. Repeating an identical
write is idempotent; reusing an identity for different content is a conflict.
Rust SQLite is authoritative. The ADK session and enabled MCP transports are
temporary process state rebuilt from durable records.

Runtime protocol v2 text streaming separates transient rendering from durable
Items. `turn.textStarted` and `turn.textDelta` are never written per token.
`turn.textCompleted` carries the authoritative full text and is idempotently
stored by its stable Item identity. Commentary and the gate-approved final
answer therefore survive duplicate delivery without content-level text
deduplication.

## Recovery

On open, unfinished Turns and active Agent tasks become `interrupted`.
Operations already claimed as `executing` become failed and are never replayed.
Pending approvals retain their identity and presentation; after validation the
worker may present them again, but execution still requires a fresh explicit
decision.

Rust records recovery as `runtimeRestart`; Main normalizes that private storage
reason to the public provider-neutral `incomplete` error while retaining the
interrupted Turn in the restored transcript.

Approval resolution and the transition from `proposed` to `executing` occur in
one immediate transaction. Completion is then persisted with the same
`operationId`. This is the idempotency boundary for patches, Git mutations,
commands and MCP calls.

Completed provider-neutral user, assistant, reasoning, media, tool-call and
tool-result items are used to rebuild model history. Incomplete Turns, orphaned
calls and uncertain results are excluded. OpenAI Responses continuation data
needed inside a live Turn remains exact and process-local; it is never flattened
into misleading text or treated as portable history.

Completed reasoning may therefore exist inside `turn.modelHistory` without a
corresponding public `turn.textCompleted` Item. Public text lifecycle Items are
reserved for explicit commentary, bounded tool-lifecycle progress summaries and
final answer content; restoring a Thread never promotes private reasoning into
the visible process timeline. Synthesized progress has a stable Turn-and-call
identity, is persisted as commentary for restore, and is not added to model
history.

Restore prefers v2 `turn.textCompleted` Items. For databases created by the v3
schema before protocol v2, a Turn with no completed text Items still coalesces
legacy `turn.textDelta` records. No schema migration is required. Incomplete or
interrupted provisional streams are not promoted or persisted as final text.

## Assets and terminals

Attachment bytes live in the v3 content-addressed store; SQLite holds verified
descriptors. Assets are reopened and hash-checked before provider use.

PTY/ConPTY sessions and live command output are intentionally process-local.
The native module owns process containment and bounded output queues. A worker
crash terminates or fails those sessions rather than reconstructing them.
