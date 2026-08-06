# Rust crates

Rust is the local capability layer for SugarCode Desktop. It does not own the
Agent loop or model transport and builds no user-facing executable.

```text
crates/
├── desktop-native/  N-API façade used by the TypeScript utility runtime
├── state/           content-addressed assets and MCP authority validation
├── tools/           workspace files, patches, search, Git and commands
├── sandbox/         platform execution isolation
└── terminal/        in-process PTY/ConPTY sessions and containment
```

`desktop-native` is the only Desktop entry point. It exposes bounded JSON or
primitive N-API methods and delegates to the other crates. It never exposes
ADK, OpenAI, Anthropic or Google SDK values.

`desktop-native` owns the v3 SQLite schema and is the durable fact source.
`state` contains only reusable asset storage and MCP authority validation; the
old rollout/config/search repository and its protocol crate have been removed.
`tools`, `sandbox` and `terminal` receive an already-authorized workspace root
and do not choose project authority. Git uses vendored libgit2 and does not
invoke system Git, hooks, credential helpers, remotes or network operations.
