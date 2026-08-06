# Model catalog and Turn selection

## Contract

SugarCode exposes two provider families and three wire APIs:

| Provider family | Wire API |
| --- | --- |
| `openai` | `openaiResponses` or `openaiChatCompletions` |
| `anthropic` | `anthropicMessages` |

LiteLLM, MetaLLM and other gateways use the compatible family and wire API
with a custom Base URL. They have no provider enum, SDK or Runtime branch.
`providerFamily` groups Settings and supplies defaults; endpoint construction,
authentication, discovery, serialization and parsing route only by `wireApi`.
SugarCode ships with no configured model, model ID allowlist or vendor-name
capability rule. The empty Settings draft is not an enabled catalog. When a
user creates a new OpenAI-compatible connection, its default wire is Compatible
Chat (`openaiChatCompletions`); Responses remains an explicit advanced choice.
Already saved connections retain their selected wire until the user edits them.

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

Desktop presents this catalog as a flat list of model configurations. Each
entry selects a profile and edits the connection referenced by that profile;
new Desktop entries create one connection/profile pair, while catalogs created
through the CLI may still share one connection across several profiles. The
default profile remains an explicit catalog choice.

The everyday Desktop form does not expose the five raw capability modes.
New entries use the compatibility baseline for tools, strictness, parallelism,
images and PDFs. Vision is the one user-facing capability switch and maps to an
explicitly enabled image declaration; turning it off returns image input to
`auto`. Existing capability declarations remain intact unless that Vision
switch is changed; selecting Compatible Chat also returns an explicitly enabled
PDF declaration to `auto` because that wire cannot represent PDF input.
Advanced capability values remain available through the versioned CLI
configuration contract. Desktop does not expose a context-window or automatic
compaction control because Runtime does not use catalog context metadata to
truncate, summarize or reject conversation history.

## Discovery

Discovery is read-only and routes by wire API:

- OpenAI Responses and Chat use the compatible Models endpoint;
- Anthropic uses its native Models endpoint and authentication;

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

All three wire APIs have a hard representation ceiling for tools and images. PDF
is representable by OpenAI Responses and Anthropic Messages;
Chat Completions rejects an explicitly enabled PDF before provider I/O. A hard
ceiling says only that the protocol can represent a feature; it is not evidence
that a particular compatible gateway implements it.

`auto` is therefore the compatibility baseline: text streaming and sequential
tool calls are enabled, while strict tools, parallel tools, image input and PDF
input remain disabled. Only an explicit `enabled` declaration activates those
optional request shapes, and it still cannot exceed the wire ceiling.
`strictTools = enabled` rejects before I/O and names an incompatible tool and
schema reason. An adapter omits optional strict/parallel/media fields when they
are not explicitly active. No capability is inferred from a model ID.

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

When the frozen selection differs from the preceding Turn by profile ID,
provider family, wire API or model ID, Runtime injects one provider-neutral
model-switch instruction into that Turn. Comparing the full selection means an
edit to one existing profile cannot disguise a model or wire change. The
instruction tells the new model to continue from portable history, not to reuse
provider-private continuation identifiers/signatures and not to repeat already
completed tools. It is absent only when those selection identity fields are
unchanged. Across Turns only user/assistant text, commentary, provider-neutral
ToolCalls and ToolResults are portable; response IDs, encrypted reasoning and
native signatures remain inside the original Turn and wire.

Runtime may append one other provider-neutral instruction within the frozen
selection: `sugarCodeCompletionRecoveryV1`. It appears only after tool use when
Core discards a short final response that promises more work and ends in an
unfulfilled heading. The instruction asks the same model to continue the active
task and is bounded to one recovery request; it does not change the profile,
wire, capabilities or cross-Turn history rules.

Historical image or PDF content that the newly frozen model cannot accept is
replaced with a bounded text descriptor containing kind, original name, media
type, byte size and SHA-256. Runtime emits at most one
`historicalContextDowngraded` warning for the affected Turn. A newly submitted
attachment that the current profile cannot accept still fails before provider
I/O and is never silently downgraded.

Catalog context metadata remains available for provider output sizing and usage
display, but it is not an input-admission boundary. Core sends complete history
and does not locally compact or reject a request based on that metadata.

## Tool schema and validation

Adapters map internal tool names to request-local provider-safe names and keep
the reverse map for replay and results. ToolCall history stores the original
provider-neutral arguments, so apply-patch, collaboration and shell calls
survive restart without reconstruction through provider-specific fields.

The built-in local tool namespace has five provider-neutral names:
`workspace/read`, `workspace/list`, `workspace/search`,
`workspace/apply-patch` and `shell/exec`. List recursion, path/content search,
multi-file create/update/delete and direct/full-shell execution remain inside
those names rather than becoming extra tools. Apply-patch is native freeform on
supported OpenAI Responses gateways, is exposed there with the model-familiar
request-local name `apply_patch`, and uses the exact `{patch: string}` fallback
elsewhere. Its provider grammar constrains only the patch envelope while the
local bounded parser owns semantic validation and follows Codex's non-strict
whitespace, heredoc, move and context matching. OpenAI Responses, Chat
Completions and Anthropic receive the same logical tool through request-local
safe-name mapping, and ordered multi-`FileChange` history retains the original
call ID.

When native command execution is present, `shell/exec` is the one dynamic local
schema: its description includes the capability-owned authoritative absolute
workspace root. On macOS and Windows its flat model schema requires only a
complete `command`; cwd and timeout are optional, and direct argv fields are not
advertised. Platforms without Full Access shell support instead advertise the
single exact-executable `argvJson` shape. Runtime-only direct compatibility does
not add another model branch. The base Agent instruction tells the model to
follow the one advertised shape and forbids mixing fields from another command
protocol or guessing the root.

Invalid tool arguments and schema mismatches produce bounded model-visible
feedback and a public `toolValidationRejected` Item. The Item carries kind,
argument byte count and SHA-256, optional edit/hunk/line diagnostics, redacted
expected/actual summaries and a suggested action. It never carries the raw
invalid payload. Three consecutive invalid tool rounds terminate as
`unsupportedToolArguments`, even when the model changes the invalid payload or
diagnostic fingerprint on each attempt. A valid tool batch resets the sequence.
