# SugarCode project instructions

Before planning or modifying this repository:

1. Read [`docs/PLAN.md`](docs/PLAN.md).
2. Read the relevant documents under [`docs/architecture/`](docs/architecture/).
3. Inspect the current Git status and preserve unrelated or user-authored work.
4. Work on one reviewable vertical slice at a time and update the plan when its
   recorded status or decisions change.

Before creating or modifying SugarCode Desktop UI, also read and follow
[`apps/desktop/AGENT.md`](apps/desktop/AGENT.md). Its theme tokens, typography
rules, prohibited patterns and light/dark review checklist are mandatory.

The public Desktop/app-server protocol must never expose model-provider SDK
types. Rust protocol definitions are the source of truth; generated TypeScript
artifacts and protocol fixtures must change in the same commit.
