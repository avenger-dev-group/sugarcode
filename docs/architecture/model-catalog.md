# Model catalog and Turn selection

## Boundary

SugarCode separates reusable provider connections from model profiles.
Connections contain endpoint and credential authority; profiles contain model
identity and capability overrides. Provider wire/SDK types are confined to
`crates/model-provider`. Core, rollout, app-server, exec, and Desktop exchange
only provider-neutral request/event/response and model-selection values.

Configuration, config-control contract, app-server protocol, and rollout all
remain version 1. Because SugarCode is unreleased, the former `[model]` shape is
not read or migrated. It is repairable from Settings and is overwritten on the
first catalog save while a valid MCP section is retained.

## Configuration

`[models]` has one `default_profile_id`, up to 16 connections, and up to 128
profiles. Built-in provider/wire mappings are fixed:

| Provider | Wire API |
| --- | --- |
| OpenAI | Responses |
| Anthropic | Messages |
| Gemini | GenerateContent |
| MetaLLM | OpenAI Chat Completions |
| OpenAI compatible | Responses or Chat Completions |

Every profile references an existing connection. The default profile must use
an enabled connection. A referenced connection cannot be deleted and the
default profile must be changed before it can be deleted.

`context_window_tokens` is optional and bounded from 4,096 through 2,097,152.
Missing means 131,072 at runtime and remains omitted when saved. API keys stay
inside the permission-restricted `config.toml`; inspection returns only a
per-connection credential status. A full-catalog SHA-256 revision and atomic
replacement guard every save, with exactly one `preserve`, `set`, or `delete`
credential action per connection.

## Discovery

Discovery is an explicit read-only operation:

- OpenAI, Anthropic, and Gemini use their Models APIs;
- MetaLLM and compatible endpoints use `/models`;
- candidates never modify configuration;
- reliable bounded context metadata may prefill the editor;
- only a user-saved context value affects runtime;
- failure leaves the connection usable for manual model ID entry.

A new or edited connection must first be saved so discovery uses the saved
endpoint and credential. Saving performs local validation only and never sends
a prompt or incurs inference cost.

## Turn resolution and freezing

Selection priority is:

1. explicit `TurnStartParams.modelProfileId`;
2. the current Thread's latest durable Turn profile;
3. the catalog default profile.

Resolution happens before `turnStarted` persistence. A successful resolution
freezes the connection, wire API, provider adapter, credential, model ID, and
capabilities for every provider round in that Turn. Settings edits affect only
later Turns. Active compaction and descendant/audit Agents inherit the root
Turn's frozen model. A missing, deleted, disabled, or invalid explicit/sticky
profile blocks the send; there is no silent fallback to another provider.

The public and durable snapshot contains only:

```text
profileId
providerKind
modelId
displayName
contextWindowTokens
```

The context value is effective, so an omitted profile setting is recorded as
131,072. Endpoints and credentials never enter rollout or public DTOs.

## Context capability

```text
effectiveContextWindow =
  profile.contextWindowTokens.unwrap_or(131072)

outputReserve =
  min(16384, max(4096, effectiveContextWindow / 4))

inputCompactionTarget =
  effectiveContextWindow - outputReserve
```

Core uses a conservative three-byte-per-token estimate and independently caps
one provider context at 4 MiB. Explicit provider context-length errors use the
existing same-Turn compaction recovery. Discovery metadata has no runtime
effect until saved into a profile.

OpenAI and Anthropic automatically enable strict schemas where supported.
OpenAI, Anthropic, and Gemini automatically enable parallel tool calls.
MetaLLM and unknown compatible endpoints default to local validation with
strict and parallel modes disabled unless explicitly overridden.

All four wire adapters consume SSE and normalize text deltas, completed output,
tool calls, and usage into `ModelEvent`/`ModelResponse`. OpenAI Responses and
Anthropic opt into their stream mode; Gemini uses
`streamGenerateContent?alt=sse`; OpenAI Chat Completions retains its bounded
stream parser. SSE records and accumulated semantic output are independently
bounded, and dropping the Core stream closes the provider task.

When a provider returns explanatory text and tool calls in the same response,
the adapter merges the text fragments into one `Commentary` output before the
tool-call batch. Only a response without tool calls is classified as `Final`.
This avoids treating the common “brief preamble, then inspect the workspace”
shape as unsupported output.

## Tool-name and argument compatibility

Adapters convert internal names such as `workspace/read` to provider-safe
function names. A collision receives the first eight hexadecimal SHA-256
characters, and request-local maps preserve tool call/result pairing across
historical replay and provider changes.

Invalid tool arguments, unknown tools, and schema mismatches produce bounded
model-visible error results. Public state records the category only; feedback
adds argument byte count and SHA-256 but never the raw invalid payload. Any
validation error rejects the entire call batch. Three consecutive identical
error fingerprints terminate with `unsupportedToolArguments`; otherwise the
model may regenerate the call in the same Turn.
