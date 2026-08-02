# Model protocol boundary

## Ownership

`crates/model-provider` is the only layer allowed to know provider wire shapes.
Core exchanges ordered `ModelMessage` content parts, tool definitions,
provider-neutral events and terminal metadata. App-server, rollout, exec and
Desktop never expose provider SDK types.

The supported wires are OpenAI Responses, OpenAI Chat Completions, Anthropic
Messages and Gemini native `generateContent`. Adapter selection is made from
the frozen `wireApi`, not the UI provider family.

The native multi-wire adapter keeps `native.rs` as its transport façade.
Provider request serialization is isolated in `native/requests.rs`, streaming
state assembly in `native/streaming.rs`, and module-owned unit coverage under
`native/tests/`. Flat Chat Completions tests remain under `src/tests/` and are
linked explicitly from their production module.

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
original position, a payload handle, SHA-256, byte count and the provider-
reported replay-token cost. Payloads through 256 KiB remain in memory; larger
payloads use an anonymous temporary file whose last handle closes with the
active Turn and whose operating-system lifetime cannot survive application
restart. There is no pathname to serialize or log. Debug output reports only
metadata, byte count and a bounded hash prefix; app-server, rollout and logs
never output the payload, encrypted reasoning or storage details.

Opaque byte size is a transport resource measurement, not a token estimate.
Private replay uses the originating response's `output_tokens` when available;
only absence of provider usage permits the conservative text estimator. A
single continuation response is capped at 64 MiB and the provider-context
handles in one request are capped at 128 MiB. Crossing either boundary is
`providerResponseTooLarge`, never a claim that the model context is full. SSE
records use the same 64 MiB safety boundary; visible text, tool arguments and
locally retained tool output keep their separate `outputTooLarge` boundary.

An envelope can be replayed only by the same wire API. When the selected wire
changes between Turns, Core retains portable text and tool history and drops
non-portable envelopes.

Wire-specific continuation rules are:

- OpenAI Responses defaults to `localReplay`: it sends `store:false`, requests
  encrypted reasoning content and manually replays complete output/reasoning
  items. An explicit `providerManaged` connection uses `store:true` and
  `previous_response_id`; an endpoint that rejects managed continuation is
  retried once with local replay and emits a non-blocking warning;
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

Generation requests do not impose response-header or stream-idle deadlines.
Once connected, an adapter waits for provider output or a real transport/server
terminal while Core retains explicit interruption authority. Connection setup
remains bounded, and an HTTP 408 returned by the provider remains a typed,
retryable provider timeout.

Terminal metadata normalizes:

- finish reason;
- usage;
- provider request ID;
- continuation state.

Provider HTTP failures retain only redacted status, provider code, request ID
and retry-after. Response bodies are bounded and never forwarded verbatim.
An HTTP 413 without an explicit provider context/token diagnostic maps to
`providerRequestTooLarge`; only a provider diagnostic that identifies the
model window maps to `contextWindowExceeded`.

OpenAI Responses streaming assembles authoritative output from ordered
`response.output_item.done` events. `response.completed` is the authoritative
lifecycle and usage boundary; its embedded output snapshot is used only when a
compatible endpoint did not emit completed output-item events. Text deltas are
provisional rendering hints and are not required to be byte-identical to the
completed item. Known terminal events are handled explicitly; optional future
`response.*` progress events may be ignored until completion so switching to a
model with a larger event vocabulary cannot become `unsupportedOutput`. The
assembled output remains strict: only portable messages, visible refusals,
function calls and opaque reasoning are accepted, and a Chat Completions chunk
on a Responses connection is still rejected as a wire mismatch. Because the
outer `response.completed` event is already terminal evidence, a compatible
gateway may omit its redundant inner `response.status`; an explicit unknown
inner status remains unsupported.

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
