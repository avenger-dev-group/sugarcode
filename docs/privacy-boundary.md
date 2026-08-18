# Local knowledge and Skill privacy boundary

SugarCode treats knowledge document contents, knowledge queries, retrieved passages, Skill contents, and model embeddings as local-only data.

- These values may cross the Electron renderer/main/private-runtime boundary only through the bounded local IPC protocol required to execute the user's request.
- They must not be included in analytics, telemetry, crash-report metadata, update checks, or diagnostic console output.
- The application currently contains no telemetry or analytics SDK.
- Network access used for application updates, pinned curated Skill installation, and semantic model downloads must not attach knowledge, query, conversation, or Skill content.

`scripts/tests/privacy-boundary.test.mjs` enforces the absence of common telemetry SDKs and rejects diagnostic calls that include sensitive knowledge/query/Skill content. Any future telemetry feature must update this policy explicitly and add payload-level negative tests before release.
