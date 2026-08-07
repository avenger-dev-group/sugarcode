# Model protocol boundary

## Ownership

The TypeScript utility runtime is the only model client. ADK owns Agent
orchestration; `OpenAiLlm` and `AnthropicLlm` own provider-specific mapping and
use `openai@7.4.0` and `@anthropic-ai/sdk@0.115.0`. `@google/genai@2.9.0`
provides ADK content/schema types only. Gemini, Vertex and ADK Live are disabled.

Provider SDK values remain inside `apps/desktop/src/runtime/models`. All other
layers use SugarCode text, reasoning, media, tool-call, tool-result, usage and
error unions.

Each terminal model step is normalized to `ModelStepOutcome`: structured tool
calls, a final candidate, a continuation reason (`commentaryOnly`, `pauseTurn`,
or `maxOutputTokens`), or a typed failure. Lifecycle decisions consume only
this structure; prompts and public text do not decide completion. When the most
recent tool result failed, the shared Turn Driver rejects the first subsequent
final candidate once and requests concrete recovery or an explicit blocker.

## Requests and streaming

OpenAI supports Responses, Chat Completions, the official endpoint and bounded
compatible base URLs/custom headers. Anthropic supports Messages and bounded
custom base URLs/headers. Adapters preserve role ordering, images, reasoning or
thinking, parallel tool calls, usage and request IDs.

The SDKs construct requests, parse streams and classify provider errors.
SugarCode owns timeout, cancellation, retry admission and UI error categories.
SDK automatic retries are disabled. A retry is allowed only before the first
semantic stream event; after any text, reasoning or tool-call output, failure is
terminal for that request. Compatible gateways pass through a normalization
layer for usage, reasoning, tool IDs and terminal event differences.
ADK may convert a thrown model error into an ordinary error event; a private
Runner plugin captures the adapter's provider-neutral classification before
that conversion so timeout, transport, authentication and retryability survive
unchanged at the Turn boundary instead of falling back to a protocol failure.

OpenAI Responses reasoning and tool-call continuation items remain intact
inside the live Turn. Portable cross-Turn history contains only verified
provider-neutral content. Anthropic thinking/tool-use/tool-result blocks follow
the same separation.

OpenAI Responses preserves `ResponseOutputMessage.phase` and provider Item IDs.
`commentary` and `final_answer` map directly; a missing phase remains
provisional while streaming and resolves to commentary when the same response
has tools or final when it does not. Stored assistant message history resends
the resolved phase. Chat Completions and Anthropic use one request-stable
synthetic message ID where the provider has no Item ID and classify
`finish_reason`/`stop_reason`; `tool_use`, `pause_turn`, token limits, incomplete
responses, filters and refusals are never ordinary success.
Agent instructions also forbid a future-action promise from serving as the
final answer: the model must issue the concrete tool call in the same response,
or report a specific blocker and the work that remains incomplete.

Compatible Responses gateways may report different message IDs for
`output_item.added`, `output_text.delta` and the terminal response. The adapter
uses `output_index` to choose one request-stable canonical text Item identity;
later aliases update that Item instead of creating duplicate commentary, final
text or model history. If a gateway omits the added event or drifts its output
indexes, one unique exact match between accumulated stream text and terminal
text repairs the alias at this provider boundary. Ambiguous equal outputs remain
separate rather than being guessed or deduplicated in the UI.

Reasoning parts carry a provider-neutral visibility classification at the model
adapter boundary. OpenAI Responses `reasoning_summary_text` is classified as a
public `summary` and may be projected as commentary; `reasoning_text`,
OpenAI-compatible Chat reasoning fields and Anthropic thinking are classified
as `internal`. Internal or unclassified reasoning may be retained for same-Turn
continuity and completed portable history, but the runtime never publishes it
to the Renderer. This classification is independent from the provider's SDK
types and does not treat arbitrary model prose as a summary.

The visible process timeline itself is provider-independent: every adapter
normalizes structured tool calls/results into the same ADK parts and runtime
events. OpenAI Responses, OpenAI-compatible Chat endpoints and Anthropic
Messages therefore share tool activity projection. Gemini and Vertex remain
disabled providers; adding either requires an adapter that supplies the same
normalized lifecycle and explicitly classifies any safe summary surface.

## Tools

ADK FunctionTools expose provider-neutral schemas. Arguments are validated
before privileged execution. Read-only tools may run concurrently when their
workspace authority allows it; writes, commands, Git mutations and MCP calls
pass through persisted operations and approval where required.

Tool and provider failures are distinct typed Turn outcomes. Cancellation
propagates through the SDK AbortSignal and by `operationId` to active native
processes. A malformed provider event or failed request terminates the affected
Turn without converting it into a durable storage failure.
Provider-neutral tool failure classification also inspects nested command
outcomes: an outer `status: completed` records operation settlement, while only
an inner `exitCode: 0` records process success. Non-zero exit codes, signals and
timeouts therefore activate the same failed-tool completion guard as direct
`ok: false` results.

Tool arguments must parse as a JSON object. Malformed JSON is converted to a
bounded internal error tool that cannot request approval or execute the target
tool, allowing one repair attempt. Repeating the identical malformed arguments
and error twice trips the Turn no-progress guard before another provider call
and is classified as `unsupportedToolArguments`. One narrow compatibility
repair is allowed for `workspace_read`: a bounded sequence of 2 through 8
concatenated objects containing only one string `path` each is normalized to
the declared `paths` batch argument. The same shared adapter boundary also
repairs one JSON-string-encoded `paths` array when it contains 1 through 8
non-empty strings; this covers compatible providers that double-encode an
otherwise unambiguous array. Oversized, mixed, unrelated or ambiguous arguments
are never truncated or guessed. OpenAI and Anthropic adapters use this same
normalizer before ADK schema validation.
Patch arguments receive a separate deterministic preflight: every
`*** Update File:` section must contain at least one `-` or `+` change line
unless it is a move-only operation. An unprefixed whole-file body is rejected
with the exact hunk spelling before approval; SugarCode does not infer a
destructive whole-file replacement.
Compatible gateways that cannot supply the declared structured tool wire fail
explicitly as `wireMismatch` or `unsupportedToolArguments`; SugarCode does not
parse generic `<tool_call>` text.
