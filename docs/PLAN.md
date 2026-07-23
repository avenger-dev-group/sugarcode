# SugarCode rewrite plan

Last updated: 2026-07-23

This document is the durable implementation plan for the SugarCode rewrite. It
is intended to be read at the beginning of every new planning or implementation
session and updated whenever an architectural decision, phase status or
acceptance criterion changes.

## 1. Product goal

Replace the former Tauri Client + remote SugarCode Service architecture with a
single Monorepo containing:

- an Electron Desktop application;
- a native Rust coding-agent runtime and CLI;
- a local, versioned app-server protocol between them.

Every Desktop release must build, test and bundle the matching `sugarcode`
binary. Desktop must not depend on a separately deployed Sugar Service API.

The final binary exposes three primary surfaces:

```text
sugarcode                 interactive terminal TUI
sugarcode exec            non-interactive/headless execution
sugarcode app-server      local server for Desktop and IDE clients
```

## 2. Confirmed architectural decisions

These decisions are accepted unless this plan is explicitly amended:

1. The repository is named `sugarcode` and uses a polyglot Monorepo.
2. Electron code lives under `apps/desktop`.
3. Rust packages live under `crates`.
4. Generated/shared TypeScript packages live under `packages`.
5. SugarCode CLI and Agent Runtime are implemented in Rust.
6. Google ADK is a design reference, not a runtime dependency.
7. SugarCode owns its Agent loop, Thread/Turn/Item model, tools, permissions,
   context management, persistence and public protocol.
8. Provider HTTP/TLS/SSE and storage primitives use mature Rust libraries; they
   are not reimplemented from scratch.
9. Desktop starts the bundled CLI with `child_process.spawn`; no Rust FFI or
   Node native addon is required.
10. Desktop communicates with `sugarcode app-server --stdio` using
    bidirectional JSONL.
11. `stdout` is protocol-only and `stderr` is diagnostic-only.
12. Rust app-server protocol types are the single source of truth and generate
    the TypeScript protocol package used by Desktop.
13. Provider SDK response types may not cross into Core persistence, the public
    app-server protocol or Desktop state.
14. TUI and headless exec call Rust Core in-process. They do not start an
    app-server subprocess.
15. Desktop bundles an exact, tested CLI version from the same repository
    revision. It never resolves a floating “latest CLI” during release.

## 3. Target repository layout

```text
sugarcode/
├── apps/
│   └── desktop/
├── crates/
│   ├── cli/
│   ├── core/
│   ├── protocol/
│   ├── tui/
│   ├── exec/
│   ├── app-server/
│   ├── app-server-protocol/
│   ├── model-provider/
│   ├── state/
│   ├── tools/
│   ├── sandbox/
│   └── mcp/
├── packages/
│   └── app-server-protocol/
├── protocol-fixtures/
├── docs/
├── scripts/
├── Cargo.toml
├── Cargo.lock
├── package.json
├── pnpm-workspace.yaml
└── pnpm-lock.yaml
```

Crates should be introduced only when their boundary is exercised by the
current vertical slice. Do not create all planned crates as empty placeholders.

## 4. Dependency direction

```text
crates/cli
├── crates/tui
├── crates/exec
└── crates/app-server

crates/tui ──────────────┐
crates/exec ─────────────┼──> crates/core
crates/app-server ───────┘

crates/app-server
└── crates/app-server-protocol

crates/core
├── crates/protocol
├── crates/model-provider
├── crates/tools
├── crates/state
├── crates/sandbox
└── crates/mcp
```

`app-server-protocol` must not depend on `core`. Mapping from internal
`CoreEvent` values to stable public DTOs belongs in `app-server`.

## 5. Current baseline

Status: **Phase 0 structure complete; implementation not started.**

Present and verified:

- Electron Forge + Vite scaffold is located at `apps/desktop`.
- Root pnpm workspace and lockfile are valid.
- Root Cargo workspace targets `crates/*`.
- Desktop lint and TypeScript checks pass.
- Electron Forge production packaging has succeeded on macOS arm64.
- Architecture documents describe the process and packaging boundaries.
- No legacy Service API is wired into the new Desktop.

Intentionally absent:

- No Rust crate or `sugarcode` executable exists yet.
- No Agent Core or ReAct/tool loop exists yet.
- No app-server protocol exists yet.
- No generated TypeScript protocol package exists yet.
- Desktop does not yet spawn or bundle a CLI.
- No model provider, tools, persistence, MCP, Skills or sandbox exists.
- The Electron renderer is still the default scaffold, not the SugarCode UI.

Known non-blocking warning:

- pnpm currently reports ignored build scripts for `electron-winstaller` and
  `unrs-resolver`. This does not block the validated macOS package. Resolve it
  deliberately before Windows release rather than broadly approving scripts.

## 6. Protocol invariants

The public app-server protocol uses stable primitives:

- **Thread**: durable conversation and effective runtime settings.
- **Turn**: one user interaction and all work caused by it.
- **Item**: one persisted/renderable unit such as user message, agent message,
  reasoning, command execution, tool call or file change.

Every item follows:

```text
item/started
  -> zero or more item-specific deltas
  -> item/completed
```

Initial connection flow:

```text
Desktop spawns CLI
  -> initialize request
  <- initialize response with versions/capabilities
  -> initialized notification
  -> thread/start or thread/resume
  -> turn/start
  <- turn/item notifications and server approval requests
```

Compatibility rules:

- breaking changes require a protocol major version;
- additive fields are optional;
- clients ignore unknown object fields and notification methods;
- server-to-client approvals use request/response correlation, not a separate
  HTTP endpoint;
- generated TypeScript and JSON Schema artifacts change with Rust types;
- golden JSONL fixtures cover every stable lifecycle;
- Desktop release tests the exact CLI binary it bundles.

## 7. Implementation phases

### Phase 0 — Monorepo baseline

Status: **complete**

Deliverables:

- `apps`, `crates`, `packages`, fixtures, docs and scripts boundaries;
- Electron scaffold preserved and buildable;
- Cargo and pnpm workspace roots;
- process and packaging architecture decisions;
- durable plan and UI conventions.

Acceptance:

- `pnpm check` passes;
- Cargo workspace metadata loads;
- Electron production package succeeds on the current host;
- no fake CLI implementation is introduced.

### Phase 1 — Rust Core and fake app-server vertical slice

Status: **next**

Create only:

- `crates/cli`;
- `crates/core`;
- `crates/protocol`;
- `crates/app-server`;
- `crates/app-server-protocol`.

Minimum commands:

```text
sugarcode version
sugarcode app-server --stdio
sugarcode app-server generate-ts
sugarcode app-server generate-json-schema
```

Minimum lifecycle:

```text
initialize
initialized
thread/start
turn/start
turn/interrupt
thread/started
turn/started
item/started
item/agentMessage/delta
item/completed
turn/completed
```

Use a deterministic fake runtime. Do not call a real model in this phase.

Acceptance:

- malformed JSON and invalid methods return structured errors;
- requests before initialization are rejected;
- one thread and turn stream a deterministic item lifecycle;
- interruption reaches a terminal state;
- Rust types generate compiling TypeScript;
- JSONL golden traces pass on macOS, Windows and Linux CI;
- `stdout` contains no logs.

### Phase 2 — Desktop sidecar integration and packaging

Status: pending

Deliverables:

- Electron Main CLI process supervisor;
- typed JSON-RPC client with request correlation and cancellation;
- constrained preload API;
- development CLI resolution;
- Forge build hook for the current platform/architecture;
- packaged sidecar under `process.resourcesPath`;
- packaged initialization smoke test.

Build contract:

```text
Forge target platform/arch
  -> cargo build --release --locked -p sugarcode-cli --target ...
  -> verify binary and protocol versions
  -> copy as extraResource outside app.asar
  -> sign package
  -> launch packaged app-server and initialize
```

Acceptance:

- `pnpm dev` starts a matching development CLI;
- `pnpm desktop:package` builds rather than reuses the CLI;
- missing, stale or wrong-architecture CLI fails the build;
- packaged Desktop performs a real initialization handshake;
- app shutdown terminates the owned CLI process;
- CLI crash is surfaced without crashing the renderer.

### Phase 3 — State, configuration and identity

Status: pending

Deliverables:

- SugarCode home-directory resolution;
- non-secret configuration;
- OS credential-store abstraction;
- append-only rollout records;
- SQLite thread index/search projection;
- thread start/list/read/resume/fork/archive/delete;
- schema migrations and corruption diagnostics.

Acceptance:

- CLI restart resumes a stored Thread;
- Desktop and terminal surfaces see the same history;
- secrets never appear in rollout files or protocol logs;
- failed migrations preserve recoverable source data.

### Phase 4 — Model gateway and text-only Agent loop

Status: pending

Deliverables:

- normalized `ModelRequest`, `ModelEvent`, `ModelUsage` and errors;
- one real streaming provider;
- text-only turn loop;
- retry classification, cancellation and token accounting;
- recorded provider stream fixtures.

Do not add tools yet.

Decision checkpoint before implementation:

- choose first provider: Gemini, OpenAI Responses or OpenAI-compatible;
- choose whether provider clients use direct `reqwest` adapters or an audited
  Rust SDK.

Acceptance:

- provider raw types remain private to its adapter;
- streaming text persists and renders;
- cancellation stops the upstream request;
- retryable and terminal failures are distinguishable;
- recorded fixtures run without network access.

### Phase 5 — Tools, approvals and sandbox

Status: pending

Implement incrementally:

1. workspace file listing/search/read;
2. one structured read-only tool call loop;
3. shell command with approval and cancellation;
4. apply-patch/file-change items and diff review;
5. platform sandbox adapters.

Acceptance:

- model tool arguments are schema validated;
- traversal and symlink escapes are rejected;
- mutating actions respect the active permission profile;
- approval pauses and resumes the same Turn;
- cancellation terminates complete process groups;
- file changes have conflict detection and reviewable diffs.

### Phase 6 — Context, Skills and MCP

Status: pending

Deliverables:

- bounded context fragments and token budgets;
- deterministic compaction;
- `AGENTS.md` and Skill discovery;
- MCP stdio/HTTP clients;
- MCP tool discovery, approval and output truncation.

Acceptance:

- every context fragment has a hard size limit;
- compaction is persisted and resumable;
- MCP failures cannot corrupt the Turn;
- tool results too large for context are truncated or stored by reference.

### Phase 7 — SugarCode Desktop workbench

Status: pending

Deliverables:

- React renderer and application state model;
- workspace/session navigation;
- Thread and Turn rendering;
- reasoning/commentary and tool activity;
- approval UI;
- file inspector, Monaco diff, terminal and preview;
- model, Skills and MCP configuration;
- light/dark themes following `apps/desktop/AGENT.md`.

The former `sugarcode-client` is a requirements and migration reference, not a
source-code dependency.

Acceptance:

- renderer uses only the constrained preload API;
- all stable protocol items survive reload/replay;
- UI passes light/dark contrast, truncation and overflow review;
- a packaged app completes the core coding-agent vertical slice.

### Phase 8 — Terminal TUI and headless exec

Status: pending

Deliverables:

- Ratatui TUI launched by `sugarcode`;
- `sugarcode exec`;
- shared Thread selection/resume;
- terminal approvals and diff review;
- human-readable and structured automation output.

Acceptance:

- TUI and exec call Core directly without an app-server subprocess;
- TUI/Desktop produce equivalent persisted Thread histories;
- headless mode has deterministic exit codes and machine-readable errors.

### Phase 9 — Migration, hardening and release

Status: pending

Deliverables:

- one-time importer for legacy Tauri SQLite data;
- macOS, Windows and Linux release matrix;
- nested executable signing and verification;
- updater and atomic Desktop/CLI pairing;
- crash diagnostics and redaction;
- removal of Sugar Service dependency.

Acceptance:

- every released Desktop contains the tested CLI checksum;
- package smoke tests run on each target platform;
- updater cannot leave Desktop and CLI at incompatible versions;
- legacy import is optional, repeatable and covered by fixtures.

## 8. Work rules for each implementation session

1. Read this plan and the relevant architecture documents.
2. Inspect Git status before planning.
3. Identify the first incomplete phase and the smallest end-to-end slice.
4. Confirm assumptions that affect public protocol or persistent data.
5. Keep provider types, Core events and public protocol DTOs separate.
6. Add integration/golden tests with behavior changes.
7. Run the narrow checks first, then repository-level checks.
8. Update this plan only when status, decisions or acceptance criteria changed.
9. Do not mark a phase complete while required acceptance criteria remain.
10. Do not start the next phase merely to add placeholders.

Preferred change size:

- under roughly 500 changed lines for new complex logic;
- under roughly 800 lines for a coherent mechanical/scaffolding change;
- split larger work into separately verifiable commits.

## 9. Baseline verification commands

Current baseline:

```bash
pnpm install --frozen-lockfile
pnpm check
cargo metadata --no-deps --format-version 1
pnpm desktop:package
```

After the first Rust crate exists:

```bash
cargo fmt --all -- --check
cargo check --workspace
cargo test --workspace
```

Protocol work additionally requires generated-artifact drift and golden fixture
checks. Packaging work additionally requires launching the packaged sidecar.

## 10. Open decisions

Do not decide these implicitly inside an unrelated implementation:

- first production model provider;
- rollout JSONL + SQLite library choices;
- exact public JSON-RPC dialect and version-negotiation fields;
- macOS/Linux/Windows sandbox implementation sequence;
- whether standalone CLI and Desktop initially share one product version;
- final package signing and update infrastructure;

Record each accepted decision in an ADR under `docs/architecture/` and update
this section.

## 11. Prompt for the next Plan-mode session

Use this prompt from the repository root:

```text
请进入计划模式。先完整读取 AGENTS.md、docs/PLAN.md 和
docs/architecture/ 下与当前阶段相关的文件，然后检查 Git 状态和现有代码。

从 docs/PLAN.md 中找到第一个未完成阶段，只规划其中最小的可验收垂直切片。
计划必须列出：
1. 要新增或修改的 crate/package；
2. 内部类型与公开协议边界；
3. 测试和 golden fixture；
4. 验收命令；
5. 明确不在本次实现的内容。

在我确认计划前不要修改代码。完成实现后，仅在实际状态发生变化时更新
docs/PLAN.md。
```
