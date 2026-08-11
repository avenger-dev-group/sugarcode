# SugarCode Desktop

Electron Forge application for SugarCode 3.0.

Run from the repository root:

```bash
pnpm dev
pnpm check
pnpm desktop:package
```

Electron Main starts `runtime.mjs` with `utilityProcess`. Main and the worker
exchange private provider-neutral `RuntimeCommand` and `RuntimeEvent` values;
there is no port, JSONL server or CLI child process. Renderer and preload keep
the existing provider-neutral API and never receive SDK types, native handles,
credentials or absolute workspace paths.

The worker uses ADK for the primary and child Agent loops. OpenAI and Anthropic
calls go through their official TypeScript SDKs, while `@google/genai` supplies
the ADK content and schema types only. Gemini, Vertex and ADK Live are not
enabled.

The platform `sugarcode-desktop-native.node` module owns SQLite, attachment
storage, capability-scoped workspace files, patches, Git, command containment
and PTY/ConPTY. Privileged tool and MCP calls are proposed in SQLite before the
existing approval UI is notified. A claimed side effect is never replayed after
a crash.

The app bundle includes `runtime.mjs` and the native module as an extra
resource. It does not include a `sugarcode` executable, app-server, TUI or
PTY sidecar process.
