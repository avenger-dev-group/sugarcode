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

A completed command operation means its process outcome was durably observed,
not that the command succeeded. Only `exitCode: 0` is successful; a non-zero
exit code, signal or timeout remains a failed tool result for Turn recovery and
completion gating.

Writes, Git mutations, Full Access commands and MCP calls first create a durable
operation and approval proposal. Approval atomically claims the operation
before native dispatch. A crash after the claim records failure and never
replays the effect. Pending proposals may be re-presented after their stored
arguments and approval metadata are validated.

Workspace patches use the SugarCode `*** Begin Patch` / operation-marker /
`*** End Patch` grammar. The runtime rejects malformed or GNU unified-diff
documents before creating an operation or asking for approval. Native parser
failures remain execution failures after an approved operation and are returned
to the Agent with actionable format guidance; they must never be presented as
approval denial. An `*** Update File:` body is a patch hunk, not whole-file
replacement text: removed lines use `-`, added lines use `+`, and unchanged
context may follow `@@`. A marker-correct update with no changed-line prefix is
rejected before approval with a concrete example so a compatible model can
repair it without asking the user to approve an operation that cannot run.

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
same approval/audit boundary as local privileged tools. HTTP servers are limited
to explicitly configured loopback endpoints.

Dynamic child Agents run as separate ADK invocations over a bounded persisted
task DAG. The coordinator enforces dependency, concurrency, interruption and
workspace read/write scheduling. Child sessions are temporary; task status and
bounded results are durable. While a task is active, the coordinator also
publishes bounded provider-neutral progress for initial model wait, streamed
public text and current tool execution; provider event objects and tool
arguments are never exposed as progress. Restart marks active tasks interrupted
instead of replaying their work.
