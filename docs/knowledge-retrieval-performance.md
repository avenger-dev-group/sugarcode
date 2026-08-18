# Knowledge retrieval performance baseline

This document records the reproducible local baseline for the knowledge retrieval implementation. The benchmark source is `crates/desktop-native/src/tests/performance.rs` and can be run with:

```sh
pnpm test:performance
```

## 2026-08-18 baseline

Environment: macOS ARM64, debug Rust test build, SQLite/FTS5 local temporary database.

| Scenario | Dataset | Result |
| --- | --- | --- |
| Cold `Store::open` | Empty version 16 database | 29 ms |
| FTS fixture build | 50,000 chunks | 1,595 ms |
| Full-text retrieval | 50,000 chunks, 30 measured queries | p50 0.367 ms, p95 0.475 ms |
| Hybrid retrieval | 4 knowledge bases, 10,000 chunks, 32-dimensional fixture vectors | p50 29.213 ms, p95 29.700 ms |
| Desktop cold start to completed E2E flow | Electron development build | 2,554 ms |
| Main process private memory | After completed E2E flow | 44.3 MB |
| Renderer working set | After completed E2E flow | 250.9 MB |
| BGE small zh model RSS delta | One passage, isolated first load | 77.8 MB |
| Multilingual E5 small model RSS delta | One passage, after BGE unload | 579.1 MB |
| Snowflake Arctic XS model RSS delta | One passage, after E5 unload | 13.8 MB additional |

The benchmark gates are intentionally conservative (FTS p95 below 250 ms and hybrid p95 below 750 ms) so that CI detects severe regressions without treating normal virtual-machine variance as a release failure.

## Vector storage evaluation

Current production storage remains little-endian FP32. A deterministic 1,000-vector, 384-dimensional per-vector INT8 experiment measured:

- FP32 payload: 1,536 bytes per vector.
- INT8 payload plus scale: 388 bytes per vector (74.7% smaller).
- Maximum dot-product error: 0.000717.
- Recall@10: 10/10 for the evaluation query.

INT8 is promising, but the production format is not changed in version 16. Changing it requires a versioned vector encoding field, migration/rebuild behavior, benchmarks against real multilingual retrieval corpora, and compatibility tests across model versions. Keeping FP32 avoids silently changing existing index interpretation.

## Live semantic model verification

Run `pnpm test:semantic-models:live` to download each production model into a temporary directory, verify every SHA-256, load ONNX Runtime, create a passage embedding with the declared dimension, report process RSS before and after load, and remove the model. The test is ignored by default because it downloads approximately 180 MB.

`pnpm test:e2e` launches the actual Electron main, preload, private runtime, native module, and renderer against an isolated temporary data directory. It creates and indexes a managed Markdown document, exercises global search navigation and accessibility, verifies that document bodies are excluded from global search, opens an installed Skill exactly, records startup/RSS data, and removes the temporary profile.

The model RSS values above are process measurements rather than model-file sizes. ONNX Runtime and the macOS allocator retain part of the multilingual model's released pages for later reuse, so the following Snowflake measurement starts from a 457.2 MB process baseline. SugarCode still drops the inactive `Session` immediately on model switch/removal and after the idle timeout; the operating system may reclaim retained pages under memory pressure rather than showing an immediate RSS return to the initial baseline.
