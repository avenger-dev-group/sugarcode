# Model catalog and Turn selection

## Contract

SugarCode exposes three provider families and four wire APIs:

| Provider family | Wire API |
| --- | --- |
| `openai` | `openaiResponses` or `openaiChatCompletions` |
| `anthropic` | `anthropicMessages` |
| `gemini` | `geminiGenerateContent` |

LiteLLM, MetaLLM and other gateways use the compatible family and wire API
with a custom Base URL. They have no provider enum, SDK or Runtime branch.
`providerFamily` groups Settings and supplies defaults; endpoint construction,
authentication, discovery, serialization and parsing route only by `wireApi`.

Configuration, config control, rollout and app-server remain version 1. Their
current v1 shape replaces earlier development shapes directly. There is no
legacy decoder, migration or automatic removal of local SugarCode data.

## Connections and profiles

`[models]` owns one default profile, up to 16 connections and up to 128
profiles. A connection contains provider family, wire API, display name, Base
URL, enabled state and an optional API key. Keys remain in permission-restricted
local configuration, are zeroized in memory and are represented to Desktop only
as credential status. They never enter rollout, public protocol or diagnostics.

A profile references one connection and contains model ID, display name,
optional context window and five `auto | enabled | disabled` declarations:

- `tool_calls`;
- `strict_tools`;
- `parallel_tools`;
- `image_input`;
- `pdf_input`.

Every profile must reference an existing connection. The default profile must
use an enabled connection. OpenAI Chat Completions cannot save
`pdf_input = enabled`, because the wire ceiling forbids PDF input.

Catalog updates are revision-guarded atomic replacements. Exactly one
`preserve`, `set` or `delete` credential action accompanies each connection.
An empty key field preserves the stored key; deletion is explicit.

## Discovery

Discovery is read-only and routes by wire API:

- OpenAI Responses and Chat use the compatible Models endpoint;
- Anthropic uses its native Models endpoint and authentication;
- Gemini uses its native Models endpoint and authentication.

Discovery candidates never mutate configuration. Failure leaves manual model
ID entry available. Context metadata is only a suggestion; only a saved profile
value affects Runtime.

## Capability resolution

Effective capability is the intersection of:

```text
wire ceiling
  ∩ profile declaration
  ∩ per-tool schema convertibility
  ∩ current Runtime capability
```

All four wire APIs support tools and image input. PDF is supported by OpenAI
Responses, Anthropic Messages and Gemini native; Chat Completions rejects PDF
before a provider request. `enabled` cannot exceed a hard wire ceiling.

`strictTools = auto` enables strict mode independently for every convertible
tool. `strictTools = enabled` rejects the provider request before I/O and names
the incompatible tool and schema reason. Parallel mode is emitted in each
wire's native request form and the returned batch is checked by Core. Gemini's
parallel setting is therefore behavioral, not presentation metadata.

The frozen public and durable model snapshot contains:

```text
profileId
providerFamily
wireApi
modelId
displayName
contextWindowTokens
effectiveCapabilities
```

Endpoints and credentials are intentionally absent.

## Turn resolution

Selection priority is:

1. explicit `turn/start.modelProfileId`;
2. the current Thread's most recent durable profile;
3. the catalog default profile.

Resolution happens before `turnStarted` persistence. A successful resolution
freezes connection, wire API, model ID, credential and effective capabilities
for every provider round in the Turn. Settings edits affect later Turns only.
Missing, disabled or invalid sticky selection blocks send; SugarCode never
silently changes provider.

The default context window is 131,072 tokens. Core reserves at most 16,384
tokens for output, estimates input conservatively at three UTF-8 bytes per
token and separately caps one provider context at 4 MiB. Provider context
rejection may trigger same-Turn compaction and retry.

## Tool schema and validation

Adapters map internal tool names to request-local provider-safe names and keep
the reverse map for replay and results. ToolCall history stores the original
provider-neutral JSON arguments, so `workspace/edit`, collaboration and shell
calls survive restart without reconstruction through obsolete special fields.

Invalid tool arguments and schema mismatches produce bounded model-visible
feedback and a public `toolValidationRejected` Item. The Item carries kind,
argument byte count and SHA-256, optional edit/hunk/line diagnostics, redacted
expected/actual summaries and a suggested action. It never carries the raw
invalid payload. Three consecutive failures with the same diagnostic
fingerprint terminate as `unsupportedToolArguments`; a successful or different
failure resets the sequence.
