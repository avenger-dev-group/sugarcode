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
this structure; prompts and public text do not decide completion.

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

## Tools

ADK FunctionTools expose provider-neutral schemas. Arguments are validated
before privileged execution. Read-only tools may run concurrently when their
workspace authority allows it; writes, commands, Git mutations and MCP calls
pass through persisted operations and approval where required.

Tool and provider failures are distinct typed Turn outcomes. Cancellation
propagates through the SDK AbortSignal and by `operationId` to active native
processes. A malformed provider event or failed request terminates the affected
Turn without converting it into a durable storage failure.

Tool arguments must parse as a JSON object. Malformed JSON is converted to a
bounded internal error tool that cannot request approval or execute the target
tool, allowing one repair attempt. Repeating the identical malformed arguments
and error twice trips the Turn no-progress guard before another provider call.
Compatible gateways that cannot supply the declared structured tool wire fail
explicitly as `wireMismatch` or `unsupportedToolArguments`; SugarCode does not
parse generic `<tool_call>` text.
