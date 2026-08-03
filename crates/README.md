# Rust crates

This directory owns SugarCode's native Rust implementation.

Workspace package boundaries:

```text
crates/
├── cli/                  sugarcode executable and command routing
├── core/                 agent runtime and turn state machine
├── protocol/             internal Core submissions and events
├── tui/                  interactive terminal interface
├── exec/                 headless execution
├── agent-runtime/        shared in-process application/session composition
├── app-server/           local Desktop/IDE JSON-RPC mapping server
├── app-server-protocol/  public JSON-RPC types
├── model-provider/       normalized model interface
├── state/                durable threads and configuration
├── tools/                coding tools
├── sandbox/              platform execution isolation
├── terminal/             shared native PTY/ConPTY bridge
└── mcp/                  bounded MCP transport, inventory and calls
```

Each Cargo package uses the `sugarcode-` name prefix. The `cli` package builds
the user-facing `sugarcode` binary.

The CLI also owns the `contractVersion:1` model configuration control plane
used by packaged Desktop: inspect, validate and revision-guarded atomic set
operations. `state` remains authoritative for config validation and atomic TOML
persistence of the connection/profile catalog, including optional per-
connection API keys. Inspect receipts expose only per-connection API-key
status. Discovery reads provider model metadata without mutating configuration.
`sugarcode config model delete-api-key` is connection- and revision-bound and
preserves the catalog and MCP configuration. The former OS credential-store
crate and CLI commands are not part of the runtime.

`tools` also owns the bounded workspace Git engine used by Desktop. It opens
only the exact already-authorized workspace root, uses vendored `libgit2` and
exposes status, one-path diff, exact-path stage/unstage and ordinary
current-branch commit to `app-server`. It never invokes system Git, hooks,
external filters, signing, credential helpers, remotes or network operations.
`app-server-protocol` remains the source of truth for those provider-neutral
DTOs and their generated TypeScript/JSON Schema.

`model-provider` owns three wire adapters grouped into two provider families:
OpenAI Responses, OpenAI Chat Completions and Anthropic Messages
`generateContent`. Core selects only by wire API. Provider continuations,
signatures and reasoning envelopes never enter the public Desktop protocol.

`state` owns the content-addressed `content/v1` asset store in addition to v1
configuration and rollout. Rollout persists attachment descriptors, not Base64
or absolute paths. `tools` exposes `workspace/edit` for revision-bound line
splices and `workspace/apply-diff` for one-file standard unified diff; both
share one review, commit-barrier and atomic-replacement pipeline.

`agent-runtime` is the surface-neutral in-process composition and session
boundary. `app-server` owns only JSON-RPC mapping on top of it. `exec` owns the
separately versioned headless output/exit contract and always-denied
non-interactive approvals; it invokes Core directly and never starts
app-server. `tui` owns the interactive terminal presentation model and uses the
same runtime directly.
