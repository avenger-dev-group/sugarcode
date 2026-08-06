# Model protocol boundary

## Ownership

`crates/model-provider` is the only layer allowed to know provider wire shapes.
Core exchanges ordered `ModelMessage` content parts, tool definitions,
provider-neutral events and terminal metadata. App-server, rollout, exec and
Desktop never expose provider SDK types.

The supported wires are OpenAI Responses, OpenAI Chat Completions and Anthropic
Messages. Adapter selection is made from the frozen `wireApi`, not the UI
provider family. The three top-level providers are
`OpenAiResponsesProvider`, `OpenAiChatCompletionsProvider` and
`AnthropicMessagesProvider`; there is no generic native-protocol dispatcher.

Each provider owns its endpoint, authentication, request/history conversion,
tool representation, stream assembly and wire-specific error classification.
`transport.rs` owns the shared HTTP client policy, SSE framing and idle bound,
response-size enforcement and bounded provider-error extraction.

## Ordered content

Messages preserve original part order. Supported parts are:

- final or commentary text;
- image assets;
- PDF documents;
- tool calls with provider-neutral argument values: JSON objects for function
  tools or one raw string for a freeform tool;
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
Completed final text and commentary that accompanies tool calls have no
phase-specific byte limit. Their provisional preview may stop rendering at the
shared preview budget, but Core still classifies the authoritative completed
text instead of failing the Turn solely because that final answer or commentary
is long.

Core does not infer completion from prose keywords. A provider-normalized final
text item is final; a tool-call item continues the Agent loop. This keeps the
runtime provider-neutral and avoids language-specific promise, completion or
blocker dictionaries. Task-completion quality remains an instruction and model
responsibility unless a future provider exposes an explicit typed continuation
signal.

Argument correction has a separate deterministic gate. When Core returns an
`invalidArguments` ToolResult, it requires the immediately following model
round to continue with a valid advertised tool call instead of accepting final
text in place of a correction. Such text is closed with
`agentOutputDiscarded`; any valid tool batch clears the pending correction
after validation, including a deliberate switch to another tool that can
continue the task. One further final-only response fails as typed
`unsupportedToolArguments`, so this recovery cannot loop indefinitely or
remain attached to an abandoned tool choice. This rule is structural and does
not depend on recognizing promise wording in the model's prose. When
`workspace/apply-patch` reaches the consecutive structural-error limit and the
same round advertises `shell/exec`, Core removes only apply-patch from later
rounds in that Turn and continues instead of terminating. The valid shell
fallback then clears the immediate correction obligation; other tools and
future Turns are unaffected.

Thread-title generation is a separate provider-neutral Core request with the
`sugarCodeThreadTitleV1` instruction source. It reuses the Thread's currently
resolved model profile but exposes no tools, does not join the Agent Turn or its
usage projection, and accepts only one bounded final-text output. Durable user
content is quoted as untrusted source material; instructions inside that source
cannot change the metadata task. A malformed, empty or failed title response is
discarded without changing the owning Turn.

Generation requests have no total Turn deadline. Connection setup remains
bounded, and every wire has a 120-second SSE-record idle boundary so a gateway
that accepts a request but never emits or closes cannot strand the Agent loop.
Any valid SSE record resets that boundary, including private reasoning/progress
records that are not rendered. A stall becomes a typed retryable timeout; an
HTTP 408 returned by the provider maps to the same failure family.

An unqualified Responses `response.incomplete` event received before any
semantic output is a retryable empty continuation. An explicit
`max_output_tokens` or compatible Chat `length` finish is retryable only when it
also contains no semantic output; filtering and safety reasons remain terminal.
Core permits at most two no-output recoveries without re-executing preceding
tools, so repeated empty gateway completions cannot create an unbounded loop.
For a non-OpenAI compatible Responses base URL, that no-output retry uses the
same gateway's streaming Chat Completions endpoint when the portable request
contains no provider-private continuation. It reuses the Responses provider's
HTTP client and connection pool, so recovery does not require an unrelated new
transport session after an idle Responses stream. Streaming preserves gateway
progress records while retaining complete visible history and tool results.
Official `api.openai.com` and opaque Responses continuation remain on the
selected Responses wire.

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
Responses custom-tool calls normalize `input` into the same ToolCall argument
slot as a raw string. Their history uses `custom_tool_call` paired with
`custom_tool_call_output`; function history continues to use the corresponding
function pair. A compatible gateway may answer a custom-tool definition with a
JSON `function_call`; its object arguments preserve that fallback shape during
local replay, so argument-correction results remain `function_call_output`
instead of being rewritten as native custom-tool history. Opaque Responses
continuation is scanned for custom call IDs so the following output always uses
the matching wire item type.

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
durable final answer. If a streaming Chat request disconnects, times out or
finishes incomplete before any semantic output, up to two bounded recovery
attempts use the same endpoint, model, wire and request as non-streaming Chat
completions. JSON completions pass through the same output, reasoning,
tool-call, usage and size normalization; this delivery fallback is not a model
fallback.

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

Core may retry the same frozen model up to two times when opening or consuming
the stream fails with transport, disconnect, timeout, 429, 5xx or empty
incomplete semantics and no semantic output has been observed. The provider
selects the compatible delivery for those recoveries: Chat uses a non-streaming
completion, while a compatible Responses endpoint may use its streaming Chat
delivery. Providers without a distinct delivery mode repeat their declared
transport. There is no retry after a delta, no retry for 4xx request/protocol
failures and no cross-model fallback.

Responses local replay uses exact provider output only when the response
contains an opaque reasoning Item that cannot be represented portably. Plain
messages and function calls are rebuilt as minimal provider-neutral Responses
input before ToolResults are appended. This avoids replaying response-only
status/identity fields to compatible gateways that accept initial Responses
tool calls but reject a full response snapshot on the continuation request.

## Native mapping

| Input | Responses | Chat Completions | Anthropic |
| --- | --- | --- | --- |
| Image | `input_image` | image content | image block |
| PDF | `input_file` | rejected before request | document block |
| Text document | normalized text | normalized text | normalized text |
| Freeform tool | native `custom` tool with grammar | JSON function fallback | JSON function fallback |

Provider authentication is wire-specific: bearer for OpenAI wires and
`x-api-key` plus Anthropic version for Messages. Custom Base URLs use the same
selected wire behavior.

## Tools

Tool definitions retain a provider-neutral JSON fallback schema and may also
carry a raw-text grammar. Responses encodes the latter as a native `custom`
tool with a Lark grammar; Chat Completions and Anthropic expose the fallback as
an ordinary function/input schema. Apply-patch uses the request-local wire name
`apply_patch`, which maps back to provider-neutral `workspace/apply-patch` in
output and history. Its grammar is a single shallow envelope terminal; local
bounded parsing, not a complex provider CFG, owns hunk semantics. The local
parser intentionally follows Codex's non-strict whitespace, heredoc, move and
context-matching behavior while retaining capability-relative path and resource
limits. Strictness is decided per JSON tool, and the
request fails before network I/O when forced strict mode cannot represent a
schema. Provider-safe tool names are request-local aliases; history and public
state keep SugarCode names.

The profile's effective capabilities control request construction; they are not
trusted as constraints on provider output. OpenAI Responses explicitly sends
`parallel_tool_calls` whenever tools are present, including `false` for the
sequential baseline. Compatible Chat keeps omitting the optional flag for broad
gateway compatibility. If any provider still returns multiple calls while the
profile says sequential, the adapter normalizes the complete batch instead of
classifying it as a wire failure.

Parallel tool calls are validated as a complete batch before any member
executes. Runtime scheduling, rather than the model capability flag, owns actual
concurrency: all-read-only batches may execute concurrently, while approval,
write and other non-parallel tools pass through the sequential execution path.
Durable calls and results remain in model order.

Tool definitions, validation and dispatch use provider-neutral SugarCode names.
An unknown name, incompatible arguments or a handler-level user error is an
untrusted model outcome. Core records bounded `toolValidationRejected` or tool
result feedback and allows a bounded correction round. Invalid workspace
arguments receive structured JSON containing field path, stable reason,
expected shape, value-free actual type, suggested action, byte count and
argument hash; raw values are not reflected. Core does not terminate the
app-server process. Only an internal runtime invariant that prevents safe
Turn closure is process-fatal. This distinction mirrors the provider adapters:
they may normalize unambiguous syntax and naming differences, but never invent
a tool, change its authority or execute malformed arguments.

Core validation and Desktop live/durable projection accept the exact lowercase
strings `"true"` and `"false"` for `workspace/list.recursive` and the
`workspace/search` fields `regex` / `caseSensitive` as a narrow
compatible-gateway normalization. The model-facing schemas remain boolean, and
other strings, numbers and null still fail validation before the read-only
batch executes.

`shell/exec` exposes one provider-neutral shape per platform. On macOS and
Windows the flat shape requires only a complete `command`, with optional cwd
and timeout; direct argv fields and authority discriminators are absent. Other
platforms advertise only the exact-executable `argvJson` shape. Core may
normalize a timeout emitted as a bounded, digits-only decimal string; it does
not accept units, signs, fractions, whitespace, zero or an out-of-range value.

Structured final output is intentionally absent until a production consumer
requires it. Audio, video, image generation, hosted file upload and file search
are outside this contract.

## TypeScript provider-adapter checkpoint

The 3.0 utility runtime directly declares `@google/adk@1.6.0`,
`@google/genai@2.9.0`, `openai@7.4.0` and
`@anthropic-ai/sdk@0.115.0`. `@google/genai` supplies ADK content and schema
types only; Gemini, Vertex and ADK Live are not enabled.

`OpenAiLlm` and `AnthropicLlm` extend ADK `BaseLlm`. Provider SDK objects stay
inside those adapter modules; utility commands, utility events, N-API and the
Renderer remain provider-neutral. Both SDKs run with automatic retry disabled.
SugarCode retries only a classified retryable failure that occurs before the
first semantic stream event. OpenAI supports Responses and Chat Completions;
Anthropic supports Messages. Both accept custom Base URLs and headers and map
text, thought/reasoning, media, tools, usage, terminal reasons and provider
errors into ADK responses.

Streaming adapters emit partial deltas followed by one complete, non-partial
ADK snapshot. This is required for ADK session persistence and tool-loop
continuation; the host publishes only the partial text to the UI, while it uses
the complete snapshot for usage and tool calls and stores it as internal model
history in the provider-neutral SQLite Turn item envelope. A fresh utility
process reconstructs completed ADK events from those snapshots before the next
request. Local mock HTTP/SSE tests exercise all three declared wires without
online provider calls.

Dynamic collaboration uses provider-neutral ADK FunctionTools above these
adapters. Each scheduled child has its own `LlmAgent`/Runner invocation and
temporary session, while task identity, dependencies, access class, status,
amendments and bounded summaries cross the private utility protocol. No
provider response object or SDK type is exposed to Electron Main, preload or
Renderer.
