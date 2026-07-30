# SugarCode project instructions

Before planning or modifying this repository:

1. Read [`docs/PLAN.md`](docs/PLAN.md).
2. Read the architecture documents relevant to the current phase.
3. Inspect the current Git status and preserve unrelated or user-authored work.
4. Work on one reviewable vertical slice at a time and update the plan when its
   recorded status or decisions change.
5. Treat synchronized documentation as part of every implementation slice. At
   the end of the task, update [`docs/PLAN.md`](docs/PLAN.md) and every affected
   architecture document when verified status, decisions, invariants,
   risks or the next-phase entry point changed.
6. Modified or newly added source code and other non-Markdown implementation
   artifacts may be staged, committed and pushed when those actions are within
   the user-authorized task. A restriction to not stage, commit or push applies
   only to Markdown files unless the user explicitly extends it to the whole
   worktree. Markdown files may only be modified or added by the agent; leave
   every Markdown file unstaged. The user alone decides and manually performs
   Markdown staging, commits and pushes. Report changed Markdown paths and do
   not repeatedly ask whether to stage or commit them. Authorization to
   implement does not by itself authorize pushing non-Markdown commits.
7. Choose production module boundaries before choosing a test layout. Keep a
   coherent implementation as `src/<module>.rs`. Create `src/<module>/` only
   when it contains real production submodules with distinct, stable
   responsibilities; retain `src/<module>.rs` as the façade instead of moving
   it to `mod.rs` merely for directory symmetry. Split by responsibility,
   ownership or platform boundary, not by line count alone. Logic shared by
   sibling tools belongs in an explicitly named shared module, never under one
   arbitrary consumer. Do not create empty, placeholder or test-only production
   module directories. Tests follow the production boundary and must not force
   one.
8. Keep test code under a deliberate `tests/` tree without creating a directory
   solely to mirror a flat production module. In a flat crate whose production
   modules are `src/<module>.rs`, place their private unit tests at
   `src/tests/<module>.rs` and connect them with an explicit `#[path]`. When the
   production module is itself a directory with multiple implementation files,
   a module-owned `src/<module>/tests/` tree is appropriate. Public integration
   tests remain under the crate-level `tests/` directory. Do not keep large
   inline test modules at the end of production files.

Before creating or modifying SugarCode Desktop UI, also read and follow
[`apps/desktop/AGENT.md`](apps/desktop/AGENT.md). Its theme tokens, typography
rules, prohibited patterns and light/dark review checklist are mandatory.

The public Desktop/app-server protocol must never expose model-provider SDK
types. Rust protocol definitions are the source of truth; generated TypeScript
artifacts and protocol fixtures must change in the same commit.
