# Tools and workspace boundary

## Authority

Workspace authority begins at one explicit, canonical absolute root selected
by the user or CLI caller. Rust opens that root as a capability boundary.
Model-facing workspace read/list/search/apply-patch tools receive only
workspace-relative UTF-8 paths. When Full Access shell is available, its
per-request model schema additionally carries the exact authoritative absolute
workspace root so the model never has to infer a host path.

The same root supplies root-to-scope `AGENTS.md`, local Skills, read/list/search,
file editing, command cwd, Git, Desktop explorer and optional local MCP
discovery. Tools reject traversal, symlinks, Windows reparse points,
unsupported file types and observed identity changes.

## Read tools

- `workspace/read` reads one stable bounded regular UTF-8 file and returns a
  JSON object containing `content`, `bytes` and the exact content `sha256`.
- `workspace/list` lists one directory level by default. `recursive: true`
  returns sorted relative `path`, `name` and entry `kind` values plus `scanned`
  and `truncated`; recursion never follows symlinks or reparse points. The
  recursive walker reports but does not descend into VCS metadata or standard
  generated dependency/build roots such as `.git`, `node_modules`, `dist` and
  `target`, preventing repository internals from consuming the bounded result.
  The preferred schema uses a JSON boolean. Runtime and Desktop live/durable
  projection compatibility also accept the exact lowercase strings `"true"`
  and `"false"`; other strings, numbers and null remain invalid.
- `workspace/search` owns both search modes. The default remains bounded,
  case-sensitive literal UTF-8 `content` search. Explicit `mode: "content"`
  additionally supports `regex`, `caseSensitive` and `filePattern`, returning
  a line number and at most 300 characters of excerpt. `mode: "path"` performs
  a default case-insensitive substring search over relative paths. Neither mode
  invokes shell, Git, host `rg` or ignore-file authority. The preferred schema
  uses JSON booleans; runtime and Desktop also accept exact lowercase
  `"true"` / `"false"` for the two boolean fields because compatible Responses
  gateways may stringify them.

Read-only batches validate completely, run with bounded concurrency and return
durable results in model order.

## Freeform patch editing

`workspace/apply-patch` is the only model-facing workspace write tool. It
accepts the bounded Codex-style envelope from `*** Begin Patch` through
`*** End Patch`, with up to 64 unique affected paths across `Add File`,
`Update File`, `Delete File` and optional `Move to` markers. Update chunks use
optional `@@` context and lines prefixed by space, `+` or `-`. A move is
compiled to an atomic destination create plus source delete in the same
ChangeSet, so destination conflicts or any later failure leave the source
untouched.

OpenAI Responses receives this through the native custom-tool wire name
`apply_patch` and returns raw patch text without JSON escaping; internal and
public state continue to use `workspace/apply-patch`. Its runtime-owned Lark
grammar is intentionally one shallow terminal that constrains only the
Begin/End envelope. It does not split arbitrary filenames and source lines
across greedy terminals; the bounded local parser remains the semantic
authority. Chat Completions and Anthropic receive the same internal tool through
the exact fallback schema `{patch: string}`. Core accepts either representation
and follows Codex's non-strict parse behavior: it trims harmless surrounding
whitespace; accepts CRLF and the standard `<<EOF`, `<<'EOF'` and `<<"EOF"`
wrappers; permits an omitted initial `@@`, unprefixed blank or non-empty
unchanged context lines, trailing blank lines after `*** End of File`, empty
added files and adjacent repeated updates for one path. Context lookup tries
exact, trailing-whitespace, full-whitespace and Unicode-punctuation-normalized
matching, with an end-of-file preference when requested. Once matched,
unchanged context in the replacement is taken from the observed file rather
than the normalized patch spelling, preventing fuzzy matching from changing
indentation or typography. Unsafe paths, conflicting duplicate paths, unknown
markers, oversized input and ambiguous or missing context still fail closed.

Argument-recovery feedback classifies the local parser result as an empty,
oversized, boundary, hunk, file-count or duplicate-path failure and tells the
model the corresponding correction action. Hunk feedback includes a complete
minimal update example and states that an update needs at least one `-` or `+`
line, avoiding repeated context-only retries. Raw rejected patch text remains
absent from durable state; only its bounded byte count, hash and redacted
failure class are retained. If the model still produces the same structural
patch failure three consecutive times while `shell/exec` is available, Core
withdraws apply-patch for the rest of that Turn and continues with shell as the
write fallback. A later Turn advertises apply-patch normally again.

File and move markers are the authoritative requested paths for this tool.
Every path still passes the normal capability-relative traversal, symlink,
reparse-point and identity checks. Updates and deletes are read through the
opened workspace capability to bind them to the observed revision; matched
context is compiled against the actual observed lines into revision-guarded
line edits. Adds, updates, moves and deletes then enter the existing atomic
ChangeSet prepare, write-ahead-log and commit path. A stale or ambiguous context
is a structured `expectedMismatch` and performs no mutation.

## Internal write pipeline

The patch parser compiles every accepted envelope to one internal ChangeSet.
Revision-bound line edits and unified-diff parsing remain internal executor
mechanics; they are not separately advertised tool protocols. This keeps one
write grammar in the model context and one correction target after validation
failure.

The complete change set is validated before mutation, rejects duplicate paths
and stages data on the same filesystem. A persisted write-ahead log precedes
the first create, atomic replacement or delete. Any recognized failure rolls
the whole batch back; workspace open completes or rolls back an interrupted log
before admitting another write. One call ID owns ordered create/update/delete
`FileChange` records and the matching ToolResult contains all revision receipts.
The absent side uses the SHA-256 of empty content and zero bytes.

Validation errors are structured:

- `headerCountMismatch`;
- `rangeOutOfBounds`;
- `expectedMismatch`;
- `baseRevisionMismatch`;
- `unsupportedDiffFeature`.

Diagnostics contain edit/hunk index, line, redacted expected/actual summaries
and a suggested action. The model-facing tool result carries the same bounded
diagnostic plus argument byte count and SHA-256 so a retry can be correlated;
raw rejected arguments are not public.

Schema rejection uses the same JSON result envelope before any execution. For
workspace tools it adds a JSONPath-like `fieldPath`, stable `reason`, bounded
`expected`, value-free actual JSON type and `suggestedAction`. The result also
states that completion is not allowed until the next valid advertised tool call
continues the task. The rejected argument values remain private; durable audit
retains only the safe diagnosis, argument byte count and SHA-256.

## Workspace concurrency and shell

Core owns one fair read/write permit shared by root and child Agents. Readers
may coexist; a writer holds the exclusive permit. This coordinates SugarCode
activity only and does not claim isolation from the user or another process.

In multi-workspace app-server mode, every scope derived from the same canonical
root also shares one workspace write gate. Apply-patch commits, Git
stage/unstage/commit and workspace-write shell execution acquire that gate for
their commit or process lifetime. Different canonical roots use independent
gates and may write concurrently. Read-only operations remain concurrent, and
the gate still makes no claim about external processes or user edits.

`shell/exec` exposes exactly one model-facing argument shape per platform. On
macOS and Windows that shape requires only one bounded complete `command`.
Optional `cwd` defaults to the capability-owned workspace root and optional
`timeoutMs` defaults to 300 seconds. It does not expose a discriminated union,
`kind`, description metadata or argv fields, avoiding provider-generated
hybrids that cannot be assigned a safe authority. The runtime still recognizes
the exact-executable `argvJson` representation as an internal sandboxed-direct
form, but it is not part of the model tool schema on these platforms.

Any supplied cwd must be the authoritative absolute root or a validated
workspace-relative subdirectory; another absolute path is rejected before
approval or execution. The process already starts in cwd, so the schema directs
the model not to invent a host path or prepend `cd` merely to re-enter the
workspace. The account login shell (`-lc`) or `%COMSPEC% /C` gives pipes,
redirections, conditionals, variables and globs their platform meaning.
The default timeout is 300 seconds and the maximum is 600 seconds.
The preferred schema keeps `timeoutMs` as an integer. Runtime compatibility
also normalizes a bounded non-empty decimal string containing ASCII digits only;
signs, units, whitespace, fractions, zero and values above the maximum remain
invalid. This unambiguous normalization does not change shell authority.
The complete-command shape is Full Access: it is not sandboxed, may use network
and may read or write outside the workspace. It is denied by default and
requires an explicit one-call, current-Thread or current-workspace Desktop
authorization which is kept only in Main-process memory and cannot be inherited
from direct sandbox auto-approval. Cancellation and timeout terminate the
process tree. Output is streamed by call ID and the durable final stdout plus
stderr is bounded to 64 KiB.

Both execution authorities use a filtered `hostInheritedV1` environment. It
preserves non-sensitive host variables such as `PATH`, `HOME`, locale/temp
locations and language-toolchain roots, while credential-like names are
excluded. The trusted Desktop sidecar inherits the Desktop process environment;
the command supervisor applies the credential filter again and bounds the map.
Desktop may remember each mode's approval scope for the current Thread or
workspace. Direct approval does not expand filesystem, network, executable or
workspace-write authority. Attempt-without-result means writes may have
occurred.

On platforms without Full Access shell support, the single advertised schema
instead requires an absolute executable and encodes operands as one JSON string
array in `argvJson`. Runtime also accepts the earlier array forms internally.
A rejected call receives bounded field-specific guidance; durable diagnostics
retain only that safe guidance plus argument byte count and SHA-256. SugarCode
never repairs a bare direct command through `PATH`. An explicitly invoked
absolute program may use inherited `PATH` internally. Full shell mode delegates
parsing to the selected platform shell only after Full Access approval.
Rollout validation distinguishes the two audit shapes: direct requires its
sandbox and network-denial receipts, while Full Access requires `sandboxed:
false`, empty argv and absent sandbox/network/workspace-write policies.

## Other native capabilities

The only model-visible built-in local tools are `workspace/read`,
`workspace/list`, `workspace/search`, `workspace/apply-patch` and `shell/exec`.
There is no parallel `read_file`, `search_code`, `workspace/find`,
`workspace/change-set` or `shell/run` namespace.

The Git engine opens only the exact root, uses vendored libgit2 and never runs
system Git, hooks, filters, signing, credential helpers, remotes or network.
MCP begins disabled and requires an explicit bounded selection plus inventory
hashing and per-call approval. Desktop preview and terminal are user-owned
capabilities, never Agent tools.

## 3.0 native-tool checkpoint

The 3.0 N-API addon reuses `WorkspaceTool` rather than reimplementing file
authority in TypeScript. Opening a workspace creates the same exact-root,
no-follow capability. The initial ADK tool set exposes provider-neutral
`workspace_read`, `workspace_list` and `workspace_search`; TypeScript owns only
their ADK schemas and JSON result mapping, while Rust owns validation, resource
limits and filesystem access.

The 3.0 host now exposes write, Git and bounded command tools through the native
addon, and routes the existing terminal UI to Rust PTY/ConPTY sessions. MCP
tools are discovered through ADK `MCPToolset` after explicit session enablement.
Every write, execution or MCP call persists an operation proposal and pending
approval before notifying the UI, then uses the stable operation ID for
commit/result idempotency. MCP tools add a stable server prefix and bind the
approval to the SHA-256 hash of both canonical arguments and the discovered
inventory. Rust remains the authority for workspace, Git, command and PTY
effects; MCP transport and tool invocation stay inside TypeScript ADK runtime.

SQLite v7 also stores a bounded provider-neutral approval presentation. Pending
requests are hash-validated and re-presented with the same IDs after restart;
they never execute before a new explicit decision. Approval and the transition
from `proposed` to `executing` are atomic. Recovery converts any claimed or
executing operation to `failed`, so a patch, command or MCP effect cannot be
replayed after an ambiguous crash. Recovered MCP execution additionally checks
the active tool inventory hash before transport dispatch.

Dynamic child Agents receive an explicit `readOnly` or `workspaceWrite` access
class. Read-only children are given only read/list/search workspace tools;
write children may additionally request patch, Git and command tools through
the same persisted approval path. A utility-runtime fair gate allows concurrent
read-only children and only one workspace-write child at a time. Any dispatched
writer must have a read-only auditor that depends on every writer, so the audit
runs after all declared write dependencies reach a terminal state.
