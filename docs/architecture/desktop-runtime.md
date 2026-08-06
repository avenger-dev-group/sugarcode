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

`RuntimeCommand` and `RuntimeEvent` are private discriminated unions. Requests
carry stable request, workspace, Thread, Turn and operation identifiers where
applicable. Events carry a Main-normalized monotonic sequence. SDK objects and
provider-native messages never cross this boundary.

## Ownership

- Renderer owns presentation state only.
- Preload exposes fixed, validated provider-neutral operations.
- Main owns trusted-sender checks, native pickers, workspace navigation,
  approval presentation, terminal flow control and runtime supervision.
- The worker owns ADK sessions, provider adapters, tool dispatch, MCP sessions
  and dynamic child-Agent scheduling.
- Rust owns durable v3 state and privileged local capabilities.

The process-local `ThreadRegistry` combines the hidden-path Desktop navigation
cache with the authoritative runtime Thread index. Session entries begin as
`sessionCache`; after a workspace opens, its runtime index replaces stale
membership and fixes ownership. A Thread cannot move between runtime-confirmed
workspaces.

## Agent and provider boundary

The primary loop and every child task use ADK `LlmAgent`/`Runner` invocations.
`OpenAiLlm` and `AnthropicLlm` extend ADK's model boundary and call the official
OpenAI and Anthropic TypeScript SDKs. The adapters normalize text, reasoning,
media, tool calls, usage, request IDs, stop reasons and errors into SugarCode
events. Provider types remain inside those adapters.

ADK sessions are process-local caches. Before a new Turn, provider-neutral
completed history is rebuilt from Rust SQLite. Worker loss interrupts active
Turns and child tasks; it never resumes an incomplete tool call or side effect.

## UI compatibility

Conversation, model configuration, attachments, approvals, MCP, Git, workspace,
terminal and orchestration keep their existing Renderer/preload surfaces.
Private Main adapters translate these calls to the utility runtime. The old
app-server public protocol, CLI supervisor and sidecar executable no longer
exist.
