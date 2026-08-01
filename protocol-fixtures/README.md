# Protocol fixtures

This directory contains stable cross-language fixtures for SugarCode's public
protocol and headless automation output.

## App-server v1

`app-server/v1/*.stdin.jsonl` files are client input transcripts. Matching
`*.stdout.jsonl` files contain the exact server output.

Fixture groups:

- `initialize-*`: handshake success and validation errors;
- `thread-start-*`, `thread-list-*`, `thread-search-*`,
  `thread-resume-*`: Thread creation and discovery;
- `thread-fork-*`, `thread-archive-*`, `thread-unarchive-*`,
  `thread-delete-*`: durable lifecycle operations;
- `turn-start-*`, `turn-provider-error`: text Turn lifecycle and failure;
- `turn-workspace-read`, `turn-workspace-list`,
  `turn-workspace-search`, `turn-workspace-apply-diff`: bounded workspace
  tools and durable Items;
- `turn-shell-approval-*`: bidirectional command approval, durable decision,
  execution-attempt and result ordering;
- `turn-shell-workspace-write-informed`: Linux workspace-write risk
  acknowledgement and audit;
- `workspace-browser-happy`: workspace binding, list and inspection.

Standalone MCP approval request/response JSON fixtures verify the public
server-to-client approval DTO independently of a complete model Turn.

Rust protocol definitions are authoritative. Generated TypeScript, JSON Schema
and affected fixtures must change together.

Turn input uses ordered content parts. Public ToolCall Items keep provider-
neutral raw JSON arguments, and validation failures use the independent
`toolValidationRejected` Item. Fixtures must not recreate the removed empty-
path pseudo ToolCall or private patch dialect.

The minimized rollout 0036 diff that reproduces the historical hunk-count
failure lives with the Core end-to-end regression at
`crates/core/src/runtime/tests/fixtures/rollout_0036_header_count_mismatch.diff`.
The regression proves the structured rejection remains provider-visible, the
next standard unified diff succeeds, and the sidecar reaches a normal terminal.

## Exec v1

`exec-v1/*.jsonl` fixes the machine-readable `sugarcode exec --json` contract:

- `success.jsonl`: successful record ordering and field shape;
- `input-error.jsonl`: deterministic validation error and exit classification.

Exec output is independent of app-server JSON-RPC and contains only
provider-neutral, bounded records.

## Editing rules

- Keep JSONL byte-stable with LF line endings.
- Do not normalize IDs, field ordering or optional fields by hand unless the
  public contract changed.
- Add or update the narrowest fixture that proves the behavior.
- Run generated-artifact drift checks and the owning Rust integration tests.
