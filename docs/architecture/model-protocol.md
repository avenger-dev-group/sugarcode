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
- Anthropic coalesces adjacent messages with the same role without changing
  block order, keeping commentary plus parallel `tool_use` blocks in one
  assistant message and their `tool_result` blocks in the immediately following
  user message for strict compatible gateways;
- Gemini preserves thought signatures and puts parallel function responses in
  one user content.

Unknown output items, terminal states, finish reasons and safety states are
errors. They are never silently discarded.

## Requests and terminal metadata

Every adapter normalizes provider records into bounded provisional text, final
output, ToolCall, usage and typed error events. Provisional text is
presentation-only; the completed typed output is the persistence boundary.
Core resolves a preview to a durable text Item when it survives classification,
or explicitly discards its provider-neutral output reference when the completed
round contains only ToolCalls. Every preview therefore has a terminal lifecycle
before a later provider request can emit another output reference.
Duplicate completion or semantic events after completion are protocol errors.
SSE record size and accumulated semantic output have independent limits.

Generation requests have no total Turn deadline. Connection setup remains
bounded, and every wire has a 120-second SSE-record idle boundary so a gateway
that accepts a request but never emits or closes cannot strand the Agent loop.
Any valid SSE record resets that boundary, including private reasoning/progress
records that are not rendered. A stall becomes a typed retryable timeout; an
HTTP 408 returned by the provider maps to the same failure family.

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

OpenAI Responses streaming treats a non-empty
`response.completed.response.output` snapshot as the authoritative semantic
output. Completed Item events are only a recovery source when that snapshot is
empty; stable duplicate Items are deduplicated and a reused stable ID or call ID
with conflicting semantic content remains a protocol error. Provider
`output_index` is only an association hint. Sparse, regenerated or preview-only
indices never fail the Turn, and the connector assigns contiguous provider-
neutral indices to both provisional previews and authoritative output before
Core correlation.
Compatible function calls may use their stable Item `id` when `call_id` is
absent and may provide arguments as a JSON object instead of encoded JSON text;
both normalize into the same provider-neutral ToolCall. Gateways that wrap the
function name/arguments under a nested `function` object are normalized too.
Missing arguments become an empty object for normal schema validation; malformed
encoded argument text is retained as a non-object so Core emits bounded tool
schema correction feedback and never executes it.

Text deltas are provisional rendering hints and are not required to be
byte-identical to the completed item. Known terminal events are handled
explicitly; optional future `response.*` progress events may be ignored until
completion so switching to a model with a larger event vocabulary cannot become
`unsupportedOutput`. The assembled output remains strict: only portable
messages, visible refusals, function calls and opaque reasoning are accepted,
and a Chat Completions chunk on a Responses connection is still rejected as a
wire mismatch. Because the outer `response.completed` event is already terminal
evidence, a compatible gateway may omit its redundant inner `response.status`;
an explicit unknown inner status remains unsupported.

Compatible Responses gateways that send the full text-so-far in successive
`response.output_text.delta` events are normalized to provider-neutral suffix
deltas per output index. If provisional rendering still reaches the local
preview budget, Core explicitly discards that preview and continues to the
authoritative completed snapshot. The connector also bounds the prefix retained
for cumulative-delta detection; crossing that connector-local preview bound
stops further preview emission for the output index without terminating stream
assembly. A presentation-only preview limit never fails an otherwise bounded
final response.

Compatible Chat merges ordered Runtime instructions into one `system` message
and omits
`stream_options`, strict tool flags and parallel-tool flags in its baseline
request. It accepts `finish_reason`, `[DONE]` or a clean EOF after semantic
output as terminal evidence; usage is optional. Fragmented tool arguments,
sparse tool indices and missing call IDs are normalized, while invalid argument
JSON is retained for Core's recoverable schema feedback. Recognized
`reasoning_content`, `reasoning`, `reasoning_details` and leading legacy
`<think>` content remain private continuation context and do not become the
durable final answer. If a streaming Chat request disconnects or times out
before any semantic output, the single bounded retry uses the same endpoint,
model, wire and request as a non-streaming Chat completion. The JSON completion
passes through the same output, reasoning, tool-call, usage and size
normalization; this delivery fallback is not a wire or model fallback.

Gemini streamed text chunks are normalized into one contiguous canonical text
item. Both ordinary incremental chunks and compatible gateways that repeat the
full text-so-far produce only the unseen suffix as provisional output, and a
clean SSE EOF after bounded semantic output is valid terminal evidence when the
last chunk omits `finishReason`.

Protocol failures carry an optional provider-neutral diagnostic. Its stage is
one of `streamEvent`, `responseAssembly`, `outputNormalization` or
`runtimeClassification`; its stable code is `wireMismatch`,
`invalidEventShape`, `ambiguousOutputReconciliation`, `malformedToolCall`,
`terminalLifecycleViolation`, `continuationOutputMismatch` or
`outputIndexMismatch`. The diagnostic records only a bounded event type and the
SHA-256 of a canonical JSON key/type skeleton. Field values, response text,
reasoning, tool arguments, credentials and paths never enter the fingerprint or
the public/durable diagnostic. A failure without this optional v1 field remains
readable for rollout and client compatibility.

Adapters do not switch wire APIs or automatically retry a protocol failure. A
real Chat/Responses mismatch therefore fails before SugarCode can duplicate
provider charges or tool side effects; normalization is limited to differences
that are unambiguous inside the profile's declared wire.

Core may retry the same frozen model once when opening or consuming the stream
fails with transport, disconnect, timeout, 429 or 5xx semantics and no semantic
output has been observed. The provider selects the compatible delivery for that
one retry: Chat uses a non-streaming completion, while providers without a
distinct delivery mode repeat their declared transport. There is no retry after
a delta, no retry for 4xx request/protocol failures and no cross-wire or
cross-model fallback.

Responses local replay uses exact provider output only when the response
contains an opaque reasoning Item that cannot be represented portably. Plain
messages and function calls are rebuilt as minimal provider-neutral Responses
input before ToolResults are appended. This avoids replaying response-only
status/identity fields to compatible gateways that accept initial Responses
tool calls but reject a full response snapshot on the continuation request.

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
