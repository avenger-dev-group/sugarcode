# Tools and workspace boundary

## Authority

Workspace authority begins at one explicit, canonical absolute root selected
by the user or CLI caller. Rust opens that root as a capability boundary.
Model-facing tools receive only workspace-relative UTF-8 paths.

The same root supplies root-to-scope `AGENTS.md`, local Skills, read/list/search,
file editing, command cwd, Git, Desktop explorer and optional local MCP
discovery. Tools reject traversal, symlinks, Windows reparse points,
unsupported file types and observed identity changes.

## Read tools

- `workspace/read` reads one stable bounded regular UTF-8 file and returns a
  JSON object containing `content`, `bytes` and the exact content `sha256`.
- `workspace/list` lists one directory level.
- `workspace/search` performs bounded literal UTF-8 content search without
  shell, Git, host `rg` or ignore-file authority.

Read-only batches validate completely, run with bounded concurrency and return
durable results in model order.

## Structured line editing

`workspace/edit` is the preferred write tool. Arguments contain:

```text
path
baseSha256
edits[]:
  startLine          1-based in the original revision
  deleteLineCount
  expected           exact deleted text
  replacement
```

All edits target the same original revision, are strictly ascending and do not
overlap. EOF insertion uses `lineCount + 1` with zero deletion. The base SHA and
exact expected text prevent stale or ambiguous writes. LF, CRLF and missing
final newline are preserved intentionally.

The model must pass the `sha256` returned by `workspace/read` directly as
`baseSha256`. It must not invoke a platform utility or synthesize a placeholder
hash. A revision mismatch still fails closed and requires a fresh read/rebase.

## Unified diff compatibility

`workspace/apply-diff` accepts one standard unified diff for the separately
supplied `path`. Diff headers never grant path authority. Counts may be omitted,
function context and LF/CRLF are accepted, and one-file no-final-newline cases
are supported. Multi-file changes, rename metadata, binary patches and Git
extended headers are rejected.

Both edit forms compile to one internal change set and share base revision
checks, review receipt, commit barrier, fsync and atomic replacement. A bounded
`FileChange` is durable before the filesystem commit. A matching success result
is the commit receipt; restart never retries an outcome-unknown write.

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

## Workspace concurrency and shell

Core owns one fair read/write permit shared by root and child Agents. Readers
may coexist; a writer holds the exclusive permit. This coordinates SugarCode
activity only and does not claim isolation from the user or another process.

`shell/exec` is a separate authority. It requires an absolute executable,
bounded argv, fixed workspace-relative cwd, minimal environment, no shell
string or `PATH` lookup, an app-server approval decision and platform sandbox
support. Desktop may remember the user's approval mode for the current Thread
or workspace and answer later approval requests automatically; this does not
expand filesystem, network, executable or workspace-write authority.
Attempt-without-result means writes may have occurred. Shell executable rules
are not weakened by model-relative file paths.

## Other native capabilities

The Git engine opens only the exact root, uses vendored libgit2 and never runs
system Git, hooks, filters, signing, credential helpers, remotes or network.
MCP begins disabled and requires an explicit bounded selection plus inventory
hashing and per-call approval. Desktop preview and terminal are user-owned
capabilities, never Agent tools.
