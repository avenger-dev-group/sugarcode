# Model protocol boundary

## Ownership

`crates/model-provider` is the only layer allowed to know provider wire shapes.
Core exchanges ordered `ModelMessage` content parts, tool definitions,
provider-neutral events and terminal metadata. App-server, rollout, exec and
Desktop never expose provider SDK types.

The supported wires are OpenAI Responses, OpenAI Chat Completions, Anthropic
Messages and Gemini native `generateContent`. Adapter selection is made from
the frozen `wireApi`, not the UI provider family.

## Ordered content

Messages preserve original part order. Supported parts are:

- final or commentary text;
- image assets;
- PDF documents;
- tool calls with JSON arguments;
- JSON, text or error tool results;
- private provider continuation context.

User UTF-8 documents are normalized into text before provider serialization.
Tool results from one parallel batch remain grouped and ordered. A provider
round can finish with final text, or with commentary followed by a tool-call
batch; Core never infers phase from fragment timing.

## Continuation context

`ProviderContextEnvelope` retains continuation material that cannot be reduced
to portable text or tool history. It records wire API, response ownership,
original position and bounded opaque bytes. Debug output reports metadata and
byte counts only. App-server and logs never output the payload.

An envelope can be replayed only by the same wire API. When the selected wire
changes between Turns, Core retains portable text and tool history and drops
non-portable envelopes.

Wire-specific continuation rules are:

- OpenAI Responses sends `store:false`, requests encrypted reasoning content
  and manually replays complete output/reasoning items;
- OpenAI Chat preserves recognized reasoning extensions for compatible gateway
  continuation;
- Anthropic preserves thinking, signatures, redacted thinking and block order;
- Gemini preserves thought signatures and puts parallel function responses in
  one user content.

Unknown output items, terminal states, finish reasons and safety states are
errors. They are never silently discarded.

## Requests and terminal metadata

Every adapter emits a stream of bounded provisional events followed by exactly
one typed completion. EOF before completion, duplicate completion or semantic
events after completion are protocol errors. SSE record size and accumulated
semantic output have independent limits.

Terminal metadata normalizes:

- finish reason;
- usage;
- provider request ID;
- continuation state.

Provider HTTP failures retain only redacted status, provider code, request ID
and retry-after. Response bodies are bounded and never forwarded verbatim.

## Native mapping

| Input | Responses | Chat Completions | Anthropic | Gemini |
| --- | --- | --- | --- | --- |
| Image | `input_image` | image content | image block | `inlineData` |
| PDF | `input_file` | rejected before request | document block | `inlineData` |
| Text document | normalized text | normalized text | normalized text | normalized text |

Provider authentication is wire-specific: bearer for OpenAI wires, `x-api-key`
plus Anthropic version for Messages, and `x-goog-api-key` for Gemini. Custom
Base URLs use the same selected wire behavior.

## Tools

Tool schemas are converted per wire. Strictness is decided per tool, and the
request fails before network I/O when forced strict mode cannot represent a
schema. Provider-safe tool names are request-local aliases; history and public
state keep SugarCode names.

Parallel tool calls are validated as a complete batch before any member
executes. All-read-only batches may execute concurrently, but durable calls and
results remain in model order. Gemini function responses from one batch are
serialized together.

Structured final output is intentionally absent until a production consumer
requires it. Audio, video, image generation, hosted file upload and file search
are outside this contract.
