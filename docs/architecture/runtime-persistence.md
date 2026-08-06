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

IDs and `(turn_id, sequence)` positions are unique. Repeating an identical
write is idempotent; reusing an identity for different content is a conflict.
Rust SQLite is authoritative. The ADK session and enabled MCP transports are
temporary process state rebuilt from durable records.

## Recovery

On open, unfinished Turns and active Agent tasks become `interrupted`.
Operations already claimed as `executing` become failed and are never replayed.
Pending approvals retain their identity and presentation; after validation the
worker may present them again, but execution still requires a fresh explicit
decision.

Approval resolution and the transition from `proposed` to `executing` occur in
one immediate transaction. Completion is then persisted with the same
`operationId`. This is the idempotency boundary for patches, Git mutations,
commands and MCP calls.

Completed provider-neutral user, assistant, reasoning, media, tool-call and
tool-result items are used to rebuild model history. Incomplete Turns, orphaned
calls and uncertain results are excluded. OpenAI Responses continuation data
needed inside a live Turn remains exact and process-local; it is never flattened
into misleading text or treated as portable history.

## Assets and terminals

Attachment bytes live in the v3 content-addressed store; SQLite holds verified
descriptors. Assets are reopened and hash-checked before provider use.

PTY/ConPTY sessions and live command output are intentionally process-local.
The native module owns process containment and bounded output queues. A worker
crash terminates or fails those sessions rather than reconstructing them.
