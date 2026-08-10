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
Durable Turn Item IDs include their owning Turn identity. The utility worker's
monotonic event sequence is ordering metadata within one worker lifetime and
may restart from zero after worker replacement; it is never sufficient as a
cross-Turn durable identity by itself.

Runtime protocol v2 text streaming separates transient rendering from durable
Items. `turn.textStarted` and `turn.textDelta` are never written per token.
`turn.textCompleted` carries the authoritative full text and is idempotently
stored by its stable Item identity. Commentary and the gate-approved final
answer therefore survive duplicate delivery without content-level text
deduplication.

Structured user-input request and resolution events are stored as ordered,
provider-neutral Turn Items for audit ordering, but an unanswered prompt is not
recoverable execution state. The live promise and its answer capability remain
process-local. If the worker exits while waiting, normal unfinished-Turn
recovery marks that Turn interrupted and never recreates or auto-answers the
prompt. A completed response is carried into the same live model loop as a
normal tool result; only completed tool history is eligible for later portable
model-history reconstruction.

Desktop Thread projections and their monotonic live revisions are process-local
delivery state, not a persistence format. SQLite continues to store the same
provider-neutral Threads, Turns and ordered Items. A Renderer revision gap is
recovered by rebuilding only that Thread projection from the current Main cache
or its durable snapshot; no schema migration or global foreground reload is
required.

New Threads are created without deriving a title from the opening words of the
first user message. Their absent durable title projects as the localized
`新对话` placeholder until metadata generation succeeds. The utility runtime
persists an automatically generated title only while the SQLite title remains
unset. An explicit user rename is an unconditional bounded metadata update, so
a late automatic result can never overwrite the user's chosen title. Title
generation or persistence failure does not change the owning Turn outcome.
Manual rename resolves the durable Workspace binding from the global Thread
registry and can update a background Thread without selecting it or switching
the foreground Workspace; the updated title is then persisted back into the
navigation session projection.
The current Desktop exposes delete and rename as its only explicit Thread
metadata or lifecycle mutations. Historical `archived_at` and
`parent_thread_id` columns remain readable for schema compatibility, and active
Thread listings continue to omit rows archived by an earlier build, but no
private runtime or native mutation API can create a fork or change archive
state.

## Recovery

On open, unfinished Turns and active Agent tasks become `interrupted`.
Operations already claimed as `executing` become failed and are never replayed.
Pending approvals retain their identity and presentation; after validation the
worker may present them again, but execution still requires a fresh explicit
decision.

Resolved approval records remain durable audit facts, but the current
`ask`/Thread/project automatic-approval mode is intentionally process-local and
is not restored after application restart. Its Thread or workspace scope is
held by Main only; a restart therefore returns to `ask` and cannot silently
recreate broad file or network authority from historical approval rows. New
live approval-resolution events identify whether the decision came from the
user, the active scoped policy or a runtime safety path. That presentation
provenance is not authority and is optional when Main rebuilds historical
activity from older durable records.

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

Durable `turn.toolCall` and `turn.toolResult` Items also rebuild the visible
provider-neutral process timeline. Main pairs them by `callId`, preserves Item
sequence relative to completed commentary and expands every retained
`workspace_read.paths` entry into a per-file activity. Tool result content is
not copied into the conversation snapshot by default; only bounded presentation
receipts such as byte, entry and match counts or an error kind cross to the
Renderer. A successful `load_skill` receipt is the narrow exception: its frozen
description, digest and at-most-32-KiB Skill body may cross so the user can
inspect the exact instructions applied by that historical Turn.

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
