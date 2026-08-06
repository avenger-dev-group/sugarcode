# Tools and workspace authority

## Authority

Electron Main validates and canonicalizes a selected project or isolated-chat
root. The utility runtime registers that root with the native module under a
deterministic workspace ID. Rust capabilities resolve every relative path
beneath that root and reject traversal, symlink escape and cross-workspace IDs.
Renderer and model output never choose a capability root.

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

Writes, Git mutations, Full Access commands and MCP calls first create a durable
operation and approval proposal. Approval atomically claims the operation
before native dispatch. A crash after the claim records failure and never
replays the effect. Pending proposals may be re-presented after their stored
arguments and approval metadata are validated.

## MCP and collaboration

MCP uses ADK `MCPToolset`. Configuration is durable, but enabled selections,
inventories and transports are process-local. Tool names are namespaced by
server; every call records the frozen inventory receipt and passes through the
same approval/audit boundary as local privileged tools. HTTP servers are limited
to explicitly configured loopback endpoints.

Dynamic child Agents run as separate ADK invocations over a bounded persisted
task DAG. The coordinator enforces dependency, concurrency, interruption and
workspace read/write scheduling. Child sessions are temporary; task status and
bounded results are durable. Restart marks active tasks interrupted instead of
replaying their work.
