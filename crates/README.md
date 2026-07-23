# Rust crates

This directory owns SugarCode's native Rust implementation.

Planned workspace packages:

```text
crates/
├── cli/                  sugarcode executable and command routing
├── core/                 agent runtime and turn state machine
├── protocol/             internal Core submissions and events
├── tui/                  interactive terminal interface
├── exec/                 headless execution
├── app-server/           local Desktop and IDE server
├── app-server-protocol/  public JSON-RPC types
├── model-provider/       normalized model interface
├── state/                durable threads and configuration
├── tools/                coding tools
├── sandbox/              platform execution isolation
└── mcp/                  MCP client and tool integration
```

Each Cargo package will use the `sugarcode-` name prefix. The `cli` package will
build the user-facing `sugarcode` binary.
