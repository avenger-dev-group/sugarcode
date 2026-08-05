# Tools and workspace boundary

## Authority

Workspace authority begins at one explicit, canonical absolute root selected
by the user or CLI caller. Rust opens that root as a capability boundary.
Model-facing workspace read/list/search/edit/apply-diff tools receive only
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
  preferred schema uses a JSON boolean. Runtime and Desktop live/durable
  projection compatibility also accept the exact lowercase strings `"true"`
  and `"false"`; other strings, numbers and null remain invalid.
- `workspace/search` owns both search modes. The default remains bounded,
  case-sensitive literal UTF-8 `content` search. Explicit `mode: "content"`
  additionally supports `regex`, `caseSensitive` and `filePattern`, returning
  a line number and at most 300 characters of excerpt. `mode: "path"` performs
  a default case-insensitive substring search over relative paths. Neither mode
  invokes shell, Git, host `rg` or ignore-file authority.

Read-only batches validate completely, run with bounded concurrency and return
durable results in model order.

## Structured line editing

`workspace/edit` is the preferred write tool. Its model schema contains one
bounded `operations[]` change set with at most 64 entries:

```text
create: path, content, expectedAbsent=true
update: path, baseSha256, edits[]
delete: path, baseSha256
```

The advertised schema describes the exact fields for each operation, the
read-derived SHA requirement, original-revision line coordinates and newline
conventions. These constraints live beside the tool definition so every model
wire receives the same preventive guidance before its first call.

Update edits target the same original revision, are strictly ascending and do
not overlap. EOF insertion uses `lineCount + 1` with zero deletion. The base
SHA and exact expected text prevent stale or ambiguous writes. LF, CRLF and
missing final newline are preserved intentionally. Create fails if anything
already occupies the path; delete is revision-bound. The former single-file
`{path, baseSha256, edits}` shape remains accepted only for rollout and runtime
compatibility and is no longer emitted in the model schema.

The model must pass the `sha256` returned by `workspace/read` directly as
`baseSha256`. It must not invoke a platform utility or synthesize a placeholder
hash. A revision mismatch still fails closed and requires a fresh read/rebase.

## Unified diff compatibility

`workspace/apply-diff` accepts a bounded `files[]` batch of standard unified
diffs. Every entry supplies its authoritative `path`; Diff headers never grant
path authority. `/dev/null` represents the absent side of create or delete.
Counts may be omitted, function context and LF/CRLF are accepted, and
no-final-newline cases are supported. Rename metadata, binary patches and Git
extended headers are rejected. The former single-file `{path, diff}` shape is
retained only for rollout and runtime compatibility.

Both representations compile to one internal ChangeSet. The complete batch is
validated before mutation, rejects duplicate paths and stages data on the same
filesystem. A persisted write-ahead log precedes the first create, atomic
replacement or delete. Any recognized failure rolls the whole batch back;
workspace open completes or rolls back an interrupted log before admitting
another write. One call ID owns ordered create/update/delete `FileChange`
records and the matching ToolResult contains all revision receipts. The absent
side uses the SHA-256 of empty content and zero bytes.

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
states that completion is not allowed until corrected arguments for that same
tool name validate. The rejected argument values remain private; durable audit
retains only the safe diagnosis, argument byte count and SHA-256.

## Workspace concurrency and shell

Core owns one fair read/write permit shared by root and child Agents. Readers
may coexist; a writer holds the exclusive permit. This coordinates SugarCode
activity only and does not claim isolation from the user or another process.

In multi-workspace app-server mode, every scope derived from the same canonical
root also shares one workspace write gate. Structured edit/apply-diff commits,
Git stage/unstage/commit and workspace-write shell execution acquire that gate
for their commit or process lifetime. Different canonical roots use independent
gates and may write concurrently. Read-only operations remain concurrent, and
the gate still makes no claim about external processes or user edits.

`shell/exec` is one tool with two distinct authorities. `kind: "direct"`
requires an absolute executable, bounded JSON argv, the exact authoritative
absolute workspace root as model-facing cwd, an app-server approval decision
and platform sandbox support. The executor resolves that advertised path back
to its capability-owned root rather than reopening arbitrary ambient paths. It
retains the read-only/no-network default and never tokenizes a shell string. A
single-dot cwd and calls without `kind` that contain `argvJson` remain
runtime/replay compatibility only.

On macOS and Windows, `kind: "shell"` accepts one bounded complete command. Its
preferred model-facing cwd is the same exact authoritative absolute root. The
model-facing JSON Schema is a discriminated `oneOf`: the direct branch requires
`argvJson` and does not advertise `timeoutMs`, while the Full Access shell branch
may advertise `timeoutMs` and cannot contain `argvJson`. Runtime compatibility
for historical direct argument arrays remains outside that preferred schema.
This keeps provider-generated arguments aligned with the authority-specific
runtime validator instead of exposing fields that the selected branch rejects.
The runtime also accepts a single dot and validated workspace-relative
subdirectories for compatibility, but any other absolute cwd is rejected
before approval or execution. The process already starts in cwd, so the schema
directs the model not to invent a host path or prepend `cd` merely to re-enter
the workspace. The account login shell (`-lc`) or `%COMSPEC% /C` then gives
pipes, redirections, conditionals, variables and globs their platform meaning.
The default timeout is 300 seconds and the maximum is 600 seconds.
The preferred schema keeps `timeoutMs` as an integer. Runtime compatibility
also normalizes a bounded non-empty decimal string containing ASCII digits only;
signs, units, whitespace, fractions, zero and values above the maximum remain
invalid. This unambiguous normalization does not change shell authority.
This mode is Full Access: it is not sandboxed, may use network and may read or
write outside the workspace. It is denied by default and requires an explicit
one-call, current-Thread or current-workspace Desktop authorization which is
kept only in Main-process memory and cannot be inherited from direct sandbox
auto-approval. Cancellation and timeout terminate the process tree. Output is
streamed by call ID and the durable final stdout plus stderr is bounded to
64 KiB.

Both modes use a filtered `hostInheritedV1` environment. It preserves
non-sensitive host variables such as `PATH`, `HOME`, locale/temp locations and
language-toolchain roots, while credential-like names are excluded. The
trusted Desktop sidecar inherits the Desktop process environment; the command
supervisor applies the credential filter again and bounds the resulting map.
Desktop may remember each mode's approval scope for the current Thread or
workspace. Direct approval does not expand filesystem, network, executable or
workspace-write authority. Attempt-without-result means writes may have
occurred.

The direct schema encodes flags and operands as one JSON string array in
`argvJson`. Runtime also accepts the earlier array forms when replaying history.
A rejected call receives bounded field-specific guidance; durable diagnostics
retain only that safe guidance plus argument byte count and SHA-256. SugarCode
never repairs a bare direct command through `PATH`. An explicitly invoked
absolute program may use inherited `PATH` internally. Full shell mode delegates
parsing to the selected platform shell only after Full Access approval.
Rollout validation distinguishes the two audit shapes: direct requires its
sandbox and network-denial receipts, while Full Access requires `sandboxed:
false`, empty argv and absent sandbox/network/workspace-write policies.

## Other native capabilities

The only model-visible local tools are `workspace/read`, `workspace/list`,
`workspace/search`, `workspace/edit`, `workspace/apply-diff` and `shell/exec`.
There is no parallel `read_file`, `search_code`, `workspace/find`,
`workspace/change-set` or `shell/run` namespace.

The Git engine opens only the exact root, uses vendored libgit2 and never runs
system Git, hooks, filters, signing, credential helpers, remotes or network.
MCP begins disabled and requires an explicit bounded selection plus inventory
hashing and per-call approval. Desktop preview and terminal are user-owned
capabilities, never Agent tools.
