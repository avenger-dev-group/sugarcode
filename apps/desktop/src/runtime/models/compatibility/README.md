# Metis reasoning transport

This adapter changes requests, not the meaning of natural-language output.
It applies only to model IDs beginning with `metis` (case-insensitive).

| Wire API | Auto | Explicit None |
| --- | --- | --- |
| Chat Completions | `thinking.type=enabled`, `reasoning_effort=high` | `thinking.type=disabled`, `reasoning_effort=none` |
| Responses | `reasoning.effort=high`, existing summary negotiation | `reasoning.effort=none` |
| Anthropic Messages | `thinking.type=adaptive`, `output_config.effort=high` | `thinking.type=disabled`, no effort field |

Explicit supported effort values override the default. Non-Metis requests
retain their existing thinking policy. In particular, Auto now enables thinking
for Metis rather than relying on the gateway's unspecified default; this can
affect token usage and latency.

## Presentation contract

- Plaintext from explicit `reasoning_content` / `reasoning`, Responses reasoning
  events, or Anthropic thinking blocks is classified as `provider` reasoning.
- Provider reasoning and provider summaries use different turn-scoped IDs and
  activity types. Neither is an answer, even if a text phase says `final`.
- Opaque/encrypted replay data, signatures, and internal thoughts are not
  published. Replay preserves the protocol-native data separately.
- The renderer starts reasoning and summary disclosures closed, preserves manual
  expansion during updates/completion, and resets a new reasoning item to closed.
- Existing stored turns are not reclassified or migrated. Ordinary unmarked text
  is not split using wording, language changes, or guessed answer boundaries.

## Verification

`tests/runtime/metis-reasoning.test.ts` covers all three wire dialects, Auto,
explicit effort, None, non-Metis isolation, streaming, and history round-trips.
Host and projection tests cover separation, identity, and cancellation.

A read-only live probe on 2026-09-03 used synthetic arithmetic prompts against
the configured Metis gateway. Default Chat Completions and Responses requests
produced only ordinary text events. Explicit thinking requests produced separate
reasoning events. After this adapter change, all three SDK paths streamed
separate reasoning and answer parts in Auto, and no reasoning parts in None.
This establishes compatibility with the tested gateway, not every deployment.
No credentials, original conversation text, or live response bodies are fixtures.
