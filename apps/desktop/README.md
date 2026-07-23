# SugarCode Desktop

Electron Forge application for SugarCode.

Run commands from the repository root:

```bash
pnpm dev
pnpm check
pnpm desktop:package
```

This package will communicate with the bundled Rust `sugarcode app-server`
process through JSONL over stdio. It must not import or embed the Agent Runtime.
