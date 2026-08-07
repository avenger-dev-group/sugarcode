# Tools and workspace authority

## Authority

Electron Main validates and canonicalizes a selected project or isolated-chat
root. The utility runtime registers that root with the native module under a
deterministic workspace ID. Rust capabilities resolve every relative path
beneath that root and reject traversal, symlink escape and cross-workspace IDs.
Renderer and model output never choose a capability root.

Multiple registered workspaces may execute Turns concurrently. Every runtime
command, event, approval and operation retains its workspace identity; changing
the visible project changes presentation only and does not revoke or replace a
background Turn's capability root.

## Local tools

Rust provides bounded file listing/inspection/search, content-addressed asset
import, atomic multi-file patches, Git status/diff/stage/unstage/commit,
sandboxed commands and PTY/ConPTY. Git uses libgit2 and does not invoke system
Git, hooks, filters, signing, remotes, credentials or network access.

Sandboxed direct commands run against the capability root with the platform
read-only and network-denied boundary. Full Access shell commands require an
explicit persisted approval and use a separate bounded executor. Active process
trees are keyed by `operationId`, so Turn cancellation and worker shutdown can
terminate them.

The sandboxed command wire accepts exactly one absolute executable path plus a
separate string argument array; its working directory is always the workspace
root. Pipes, redirects, command chaining and other shell expressions belong to
Full Access mode. The runtime validates these mode-specific arguments before it
creates an operation or requests approval and returns actionable repair guidance
to the Agent. Native validation repeats the absolute-path and bounded-argument
checks as a defense-in-depth boundary. Full Access also starts at the selected
workspace root unless its `cwd` names a real workspace-relative subdirectory;
the Agent must not invent an absolute project path or prepend a redundant `cd`.
The runtime rejects a Full Access command beginning with an absolute-path `cd`
before it creates an operation or requests approval, and directs the Agent to
omit it or use the workspace-relative `cwd` field.

A completed command operation means its process outcome was durably observed,
not that the command succeeded. Only `exitCode: 0` is successful; a non-zero
exit code, signal or timeout remains a failed tool result for Turn recovery and
completion gating.

Writes, Git mutations, Full Access commands and MCP calls first create a durable
operation and approval proposal. Approval atomically claims the operation
before native dispatch. A crash after the claim records failure and never
replays the effect. Pending proposals may be re-presented after their stored
arguments and approval metadata are validated.

The Main-owned approval policy has three process-local modes. `ask` presents
every privileged operation; `thread` automatically approves later privileged
operations only when the request carries the granted Thread ID; and `workspace`
automatically approves requests from every Thread carrying the granted
workspace ID. Full Access commands and MCP calls use the same scope resolver,
so selecting either automatic mode does not leave a second approval path that
continues prompting. Switching back to `ask` clears the active scoped grant.
The Renderer may show another workspace or Thread, but that presentation change
does not broaden a grant because Main matches the immutable request identities.
Automatic resolutions retain the same durable approval audit boundary, while
their live resolution event carries `policy` provenance. The Renderer labels
them as inherited access and does not imply that the user answered a new
prompt. A child task publishes a waiting-for-approval state only
when the proposal remains unresolved beyond a short presentation delay, so an
immediate scoped decision does not flash as a blocked child.

Workspace patches use the SugarCode `*** Begin Patch` / operation-marker /
`*** End Patch` grammar. The runtime rejects malformed or GNU unified-diff
documents before creating an operation or asking for approval. Native parser
failures remain execution failures after an approved operation and are returned
to the Agent with actionable format guidance; they must never be presented as
approval denial. An `*** Update File:` body is a patch hunk, not whole-file
replacement text: removed lines use `-`, added lines use `+`, and unchanged
context may appear around `@@`. A new file accepts either the canonical form
where every body line starts with `+`, or one complete unprefixed body; the
parser decides once for the whole section so a literal leading plus is not
silently removed. Compatible unchanged prelude before a first hunk marker is
retained as matching context rather than rejected as a context-only hunk. A
marker-correct update with no changed-line prefix is
rejected before approval with a concrete example so a compatible model can
repair it without asking the user to approve an operation that cannot run.
Preflight unwraps a bounded heredoc and collapses repeated unprefixed
Begin/End envelope markers into one document before approval; malformed
content markers and hunks remain rejected. A hunk that removes and re-adds
identical text is also rejected. These structural no-ops never become durable
operations or approval requests. If native matching finds stale context, the
result identifies the affected path and line, confirms that the atomic patch
changed no files, and directs the Agent to re-read and retry a small patch for
that file. Matching tolerates a compatible provider doubling backslashes
immediately before quotes, but does not normalize regular expression, path or
other unrelated backslashes. A successful native receipt retains the bounded
review diff, newline metadata and revision hashes for every changed file so the
Desktop can disclose the exact change after execution without rereading a
mutable workspace.

`workspace_read` declares either one `path` or a bounded `paths` batch of 1
through 8 files. Batch reads execute through the same read-only workspace
capability and return each result with its requested path. This gives compatible
models a declared parallel-read shape without expanding authority or rewriting
ambiguous tool intent. Before schema validation, the provider-neutral argument
normalizer may unwrap a JSON-string-encoded `paths` array only when it contains
1 through 8 non-empty strings. It never truncates an oversized batch or repairs
other tools by analogy. As a bounded fallback for non-strict providers, a
direct, unambiguous array of 9 through 16 paths is preserved and executed in
waves of at most 8 native reads. Larger batches are rejected with instructions
to split the request; the UI projects the actual requested path count rather
than silently presenting only the first 8.

## MCP and collaboration

MCP uses ADK `MCPToolset`. Configuration is durable, but enabled selections,
inventories and transports are process-local. Tool names are namespaced by
server; every call records the frozen inventory receipt and passes through the
same approval/audit boundary and scoped automatic-approval policy as local
privileged tools. HTTP servers are limited to explicitly configured loopback
endpoints.

Dynamic child Agents run as separate ADK invocations over a bounded persisted
task DAG. The coordinator enforces dependency, concurrency, interruption and
workspace read/write scheduling. Child sessions are temporary; task status and
bounded results are durable. While a task is active, the coordinator also
publishes bounded provider-neutral progress for initial model wait, streamed
public text and current tool execution; provider event objects and tool
arguments are never exposed as progress. Restart marks active tasks interrupted
instead of replaying their work. A workspace-writing dispatch may provide a
tailored read-only auditor depending on every writer. When it does not, the
coordinator adds a bounded runtime auditor with those dependencies before it
validates, persists or schedules the wave, so a missing auditor cannot force the
model to resend every writer brief.
