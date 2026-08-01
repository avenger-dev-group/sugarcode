use crate::BoxModelFuture;
use crate::ModelError;
use crate::ModelErrorKind;
use crate::ModelEvent;
use crate::ModelMessage;
use crate::ModelOutputItem;
use crate::ModelOutputItemKind;
use crate::ModelProvider;
use crate::ModelRequest;
use crate::ModelResponse;
use crate::ModelRole;
use crate::ModelTextPhase;
use crate::ModelToolCall;
use crate::ModelUsage;
use eventsource_stream::EventStreamError;
use eventsource_stream::Eventsource;
use futures_util::FutureExt;
use futures_util::StreamExt;
use reqwest::StatusCode;
use reqwest::header::AUTHORIZATION;
use reqwest::header::CONTENT_TYPE;
use reqwest::header::HeaderName;
use reqwest::header::HeaderValue;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::fmt;
use std::io;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use url::Url;
use zeroize::Zeroizing;

const MODEL_STREAM_CAPACITY: usize = 16;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const RESPONSE_HEADER_TIMEOUT: Duration = Duration::from_secs(30);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_SSE_EVENT_BYTES: usize = 256 * 1024;
const MAX_SEMANTIC_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_ERROR_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeProtocol {
    OpenAiResponses,
    AnthropicMessages,
    GeminiGenerateContent,
}

pub struct NativeModelProvider {
    client: reqwest::Client,
    base_url: Url,
    token: Option<Zeroizing<String>>,
    protocol: NativeProtocol,
    strict_tools: bool,
    parallel_tools: bool,
    max_output_tokens: u32,
}

impl NativeModelProvider {
    pub fn openai_responses(
        base_url: Url,
        token: Option<Zeroizing<String>>,
        strict_tools: bool,
        parallel_tools: bool,
        max_output_tokens: u32,
    ) -> Result<Self, ModelError> {
        Self::new(
            base_url,
            token,
            NativeProtocol::OpenAiResponses,
            strict_tools,
            parallel_tools,
            max_output_tokens,
        )
    }

    pub fn anthropic_messages(
        base_url: Url,
        token: Option<Zeroizing<String>>,
        strict_tools: bool,
        parallel_tools: bool,
        max_output_tokens: u32,
    ) -> Result<Self, ModelError> {
        Self::new(
            base_url,
            token,
            NativeProtocol::AnthropicMessages,
            strict_tools,
            parallel_tools,
            max_output_tokens,
        )
    }

    pub fn gemini_generate_content(
        base_url: Url,
        token: Option<Zeroizing<String>>,
        strict_tools: bool,
        parallel_tools: bool,
        max_output_tokens: u32,
    ) -> Result<Self, ModelError> {
        Self::new(
            base_url,
            token,
            NativeProtocol::GeminiGenerateContent,
            strict_tools,
            parallel_tools,
            max_output_tokens,
        )
    }

    fn new(
        base_url: Url,
        token: Option<Zeroizing<String>>,
        protocol: NativeProtocol,
        strict_tools: bool,
        parallel_tools: bool,
        max_output_tokens: u32,
    ) -> Result<Self, ModelError> {
        if !valid_base_url(&base_url) {
            return Err(ModelError::new(ModelErrorKind::InvalidRequest, false));
        }
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| ModelError::new(ModelErrorKind::Transport, true))?;
        Ok(Self {
            client,
            base_url,
            token: token.filter(|token| !token.is_empty()),
            protocol,
            strict_tools,
            parallel_tools,
            max_output_tokens,
        })
    }
}

impl fmt::Debug for NativeModelProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeModelProvider")
            .field("protocol", &self.protocol)
            .field("base_url", &"<redacted>")
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .field("strict_tools", &self.strict_tools)
            .field("parallel_tools", &self.parallel_tools)
            .field("max_output_tokens", &self.max_output_tokens)
            .finish()
    }
}

impl ModelProvider for NativeModelProvider {
    fn stream(&self, request: ModelRequest) -> BoxModelFuture<'_> {
        async move {
            let normalized = crate::tool_names::normalize_request(request);
            let request = &normalized.request;
            let (endpoint, body) = match self.protocol {
                NativeProtocol::OpenAiResponses => (
                    append_path(&self.base_url, "responses")?,
                    openai_request(
                        request,
                        self.strict_tools,
                        self.parallel_tools,
                        self.max_output_tokens,
                    ),
                ),
                NativeProtocol::AnthropicMessages => (
                    append_path(&self.base_url, "messages")?,
                    anthropic_request(request, self.strict_tools, self.max_output_tokens),
                ),
                NativeProtocol::GeminiGenerateContent => (
                    gemini_stream_endpoint(&self.base_url, &request.model)?,
                    gemini_request(request, self.max_output_tokens),
                ),
            };
            let mut builder = self.client.post(endpoint).json(&body);
            match self.protocol {
                NativeProtocol::OpenAiResponses => {
                    if let Some(token) = &self.token {
                        builder = builder.header(AUTHORIZATION, bearer_header(token)?);
                    }
                }
                NativeProtocol::AnthropicMessages => {
                    if let Some(token) = &self.token {
                        builder = builder.header(
                            HeaderName::from_static("x-api-key"),
                            sensitive_header(token)?,
                        );
                    }
                    builder = builder.header(
                        HeaderName::from_static("anthropic-version"),
                        HeaderValue::from_static("2023-06-01"),
                    );
                }
                NativeProtocol::GeminiGenerateContent => {
                    if let Some(token) = &self.token {
                        builder = builder.header(
                            HeaderName::from_static("x-goog-api-key"),
                            sensitive_header(token)?,
                        );
                    }
                }
            }
            let response = tokio::time::timeout(RESPONSE_HEADER_TIMEOUT, builder.send())
                .await
                .map_err(|_| ModelError::new(ModelErrorKind::Timeout, true))?
                .map_err(map_reqwest_error)?;
            let status = response.status();
            if !status.is_success() {
                let bytes = response.bytes().await.map_err(map_reqwest_error)?;
                return Err(map_error(
                    status,
                    &bytes[..bytes.len().min(MAX_ERROR_BYTES)],
                ));
            }
            let is_event_stream = response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| {
                    value
                        .split(';')
                        .next()
                        .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("text/event-stream"))
                });
            if !is_event_stream {
                return Err(ModelError::new(ModelErrorKind::Protocol, false));
            }
            let (_, tool_names) = normalized.into_parts();
            let (sender, receiver) = mpsc::channel(MODEL_STREAM_CAPACITY);
            tokio::spawn(process_native_stream(
                response,
                sender,
                self.protocol,
                tool_names,
            ));
            Ok(ReceiverStream::new(receiver).boxed())
        }
        .boxed()
    }
}

async fn process_native_stream(
    response: reqwest::Response,
    sender: mpsc::Sender<Result<ModelEvent, ModelError>>,
    protocol: NativeProtocol,
    tool_names: BTreeMap<String, String>,
) {
    let mut event_bytes = 0usize;
    let mut suffix = [0u8; 4];
    let bounded_bytes = response.bytes_stream().map(move |chunk| {
        let chunk = chunk.map_err(io::Error::other)?;
        for byte in chunk.iter().copied() {
            event_bytes = event_bytes.saturating_add(1);
            suffix.rotate_left(1);
            suffix[3] = byte;
            if suffix[2..] == *b"\n\n" || suffix[2..] == *b"\r\r" || suffix == *b"\r\n\r\n" {
                event_bytes = 0;
            } else if event_bytes > MAX_SSE_EVENT_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "SSE event exceeds the size limit",
                ));
            }
        }
        Ok(chunk)
    });
    let mut stream = bounded_bytes.eventsource();
    let mut state = NativeStreamState::new(protocol);
    loop {
        let next = tokio::select! {
            _ = sender.closed() => return,
            next = tokio::time::timeout(IDLE_TIMEOUT, stream.next()) => next,
        };
        let event = match next {
            Err(_) => {
                send_stream_error(&sender, ModelError::new(ModelErrorKind::Timeout, true)).await;
                return;
            }
            Ok(None) => {
                if protocol == NativeProtocol::GeminiGenerateContent {
                    match state.finish(&tool_names) {
                        Ok(response) => {
                            let _ = sender
                                .send(Ok(ModelEvent::ResponseCompleted(response)))
                                .await;
                        }
                        Err(error) => send_stream_error(&sender, error).await,
                    }
                } else {
                    send_stream_error(&sender, ModelError::new(ModelErrorKind::Disconnected, true))
                        .await;
                }
                return;
            }
            Ok(Some(Err(error))) => {
                let error = match error {
                    EventStreamError::Transport(error)
                        if error.kind() != io::ErrorKind::InvalidData =>
                    {
                        ModelError::new(ModelErrorKind::Disconnected, true)
                    }
                    EventStreamError::Transport(_)
                    | EventStreamError::Utf8(_)
                    | EventStreamError::Parser(_) => {
                        ModelError::new(ModelErrorKind::Protocol, false)
                    }
                };
                send_stream_error(&sender, error).await;
                return;
            }
            Ok(Some(Ok(event))) => event,
        };
        if event.data.is_empty() || event.data == "[DONE]" {
            if event.data == "[DONE]" {
                match state.finish(&tool_names) {
                    Ok(response) => {
                        let _ = sender
                            .send(Ok(ModelEvent::ResponseCompleted(response)))
                            .await;
                    }
                    Err(error) => send_stream_error(&sender, error).await,
                }
                return;
            }
            continue;
        }
        let value: Value = match serde_json::from_str(&event.data) {
            Ok(value) => value,
            Err(_) => {
                send_stream_error(&sender, protocol_error()).await;
                return;
            }
        };
        match state
            .consume(&event.event, value, &sender, &tool_names)
            .await
        {
            Ok(StreamProgress::Continue) => {}
            Ok(StreamProgress::Complete(response)) => {
                let _ = sender
                    .send(Ok(ModelEvent::ResponseCompleted(response)))
                    .await;
                return;
            }
            Err(error) => {
                send_stream_error(&sender, error).await;
                return;
            }
        }
    }
}

enum StreamProgress {
    Continue,
    Complete(ModelResponse),
}

enum NativeStreamState {
    OpenAi,
    Anthropic(AnthropicStreamState),
    Gemini(GeminiStreamState),
}

impl NativeStreamState {
    fn new(protocol: NativeProtocol) -> Self {
        match protocol {
            NativeProtocol::OpenAiResponses => Self::OpenAi,
            NativeProtocol::AnthropicMessages => Self::Anthropic(AnthropicStreamState::default()),
            NativeProtocol::GeminiGenerateContent => Self::Gemini(GeminiStreamState::default()),
        }
    }

    async fn consume(
        &mut self,
        event_name: &str,
        value: Value,
        sender: &mpsc::Sender<Result<ModelEvent, ModelError>>,
        tool_names: &BTreeMap<String, String>,
    ) -> Result<StreamProgress, ModelError> {
        match self {
            Self::OpenAi => consume_openai_event(event_name, value, sender, tool_names).await,
            Self::Anthropic(state) => {
                state.consume(event_name, value, sender).await?;
                if event_name == "message_stop" {
                    Ok(StreamProgress::Complete(state.response(tool_names)?))
                } else {
                    Ok(StreamProgress::Continue)
                }
            }
            Self::Gemini(state) => {
                state.consume(value, sender, tool_names).await?;
                Ok(StreamProgress::Continue)
            }
        }
    }

    fn finish(
        &mut self,
        tool_names: &BTreeMap<String, String>,
    ) -> Result<ModelResponse, ModelError> {
        match self {
            Self::OpenAi => Err(ModelError::new(ModelErrorKind::Disconnected, true)),
            Self::Anthropic(state) => state.response(tool_names),
            Self::Gemini(state) => state.response(),
        }
    }
}

async fn consume_openai_event(
    event_name: &str,
    value: Value,
    sender: &mpsc::Sender<Result<ModelEvent, ModelError>>,
    tool_names: &BTreeMap<String, String>,
) -> Result<StreamProgress, ModelError> {
    let kind = if event_name.is_empty() || event_name == "message" {
        value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
    } else {
        event_name
    };
    match kind {
        "response.output_text.delta" => {
            let delta = required_string(&value, "delta")?;
            send_text_delta(sender, 0, delta).await?;
            Ok(StreamProgress::Continue)
        }
        "response.completed" => {
            let response = value.get("response").cloned().ok_or_else(protocol_error)?;
            let response = normalize_response_output(parse_openai_response(response)?);
            let response = map_response_tool_names(response, tool_names);
            Ok(StreamProgress::Complete(response))
        }
        "response.failed" | "response.incomplete" | "error" => Err(ModelError::new(
            if kind == "response.incomplete" {
                ModelErrorKind::Incomplete
            } else {
                ModelErrorKind::Server
            },
            false,
        )),
        _ => Ok(StreamProgress::Continue),
    }
}

#[derive(Default)]
struct AnthropicStreamState {
    blocks: BTreeMap<u32, AnthropicBlock>,
    input_tokens: Option<u64>,
    cached_input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    semantic_bytes: usize,
}

enum AnthropicBlock {
    Text(String),
    Tool {
        id: String,
        name: String,
        arguments: String,
    },
}

impl AnthropicStreamState {
    async fn consume(
        &mut self,
        event_name: &str,
        value: Value,
        sender: &mpsc::Sender<Result<ModelEvent, ModelError>>,
    ) -> Result<(), ModelError> {
        match event_name {
            "message_start" => {
                if let Some(usage) = value.pointer("/message/usage") {
                    self.input_tokens = u64_field(usage, "input_tokens");
                    self.cached_input_tokens = u64_field(usage, "cache_read_input_tokens");
                }
            }
            "content_block_start" => {
                let index = u32_field(&value, "index").ok_or_else(protocol_error)?;
                let block = value.get("content_block").ok_or_else(protocol_error)?;
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let text = block
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        self.add_bytes(text.len())?;
                        self.blocks
                            .insert(index, AnthropicBlock::Text(text.to_owned()));
                        if !text.is_empty() {
                            send_text_delta(sender, 0, text).await?;
                        }
                    }
                    Some("tool_use") => {
                        self.blocks.insert(
                            index,
                            AnthropicBlock::Tool {
                                id: required_string(block, "id")?.to_owned(),
                                name: required_string(block, "name")?.to_owned(),
                                arguments: String::new(),
                            },
                        );
                    }
                    _ => {}
                }
            }
            "content_block_delta" => {
                let index = u32_field(&value, "index").ok_or_else(protocol_error)?;
                let delta = value.get("delta").ok_or_else(protocol_error)?;
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        let text = required_string(delta, "text")?;
                        self.add_bytes(text.len())?;
                        match self.blocks.get_mut(&index) {
                            Some(AnthropicBlock::Text(current)) => current.push_str(text),
                            _ => return Err(protocol_error()),
                        }
                        send_text_delta(sender, 0, text).await?;
                    }
                    Some("input_json_delta") => {
                        let partial = required_string(delta, "partial_json")?;
                        self.add_bytes(partial.len())?;
                        match self.blocks.get_mut(&index) {
                            Some(AnthropicBlock::Tool { arguments, .. }) => {
                                arguments.push_str(partial);
                            }
                            _ => return Err(protocol_error()),
                        }
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                if let Some(usage) = value.get("usage") {
                    self.output_tokens = u64_field(usage, "output_tokens");
                }
            }
            "error" => return Err(ModelError::new(ModelErrorKind::Server, false)),
            _ => {}
        }
        Ok(())
    }

    fn add_bytes(&mut self, bytes: usize) -> Result<(), ModelError> {
        self.semantic_bytes = self.semantic_bytes.saturating_add(bytes);
        if self.semantic_bytes > MAX_SEMANTIC_OUTPUT_BYTES {
            Err(ModelError::new(ModelErrorKind::OutputTooLarge, false))
        } else {
            Ok(())
        }
    }

    fn response(&self, tool_names: &BTreeMap<String, String>) -> Result<ModelResponse, ModelError> {
        let mut output = Vec::new();
        for block in self.blocks.values() {
            match block {
                AnthropicBlock::Text(text) if !text.is_empty() => push_text(&mut output, text),
                AnthropicBlock::Tool {
                    id,
                    name,
                    arguments,
                } => {
                    let arguments = serde_json::from_str(arguments)
                        .map_err(|_| ModelError::new(ModelErrorKind::Protocol, false))?;
                    push_tool(
                        &mut output,
                        id,
                        tool_names.get(name).map_or(name.as_str(), String::as_str),
                        arguments,
                    );
                }
                AnthropicBlock::Text(_) => {}
            }
        }
        complete_response(
            output,
            usage_from_parts(
                self.input_tokens,
                self.cached_input_tokens,
                self.output_tokens,
                None,
            ),
        )
        .map(normalize_response_output)
    }
}

#[derive(Default)]
struct GeminiStreamState {
    output: Vec<ModelOutputItem>,
    usage: Option<ModelUsage>,
    semantic_bytes: usize,
}

impl GeminiStreamState {
    async fn consume(
        &mut self,
        value: Value,
        sender: &mpsc::Sender<Result<ModelEvent, ModelError>>,
        tool_names: &BTreeMap<String, String>,
    ) -> Result<(), ModelError> {
        if let Some(parts) = value
            .pointer("/candidates/0/content/parts")
            .and_then(Value::as_array)
        {
            for part in parts {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    self.add_bytes(text.len())?;
                    push_text(&mut self.output, text);
                    send_text_delta(sender, 0, text).await?;
                } else if let Some(call) = part.get("functionCall") {
                    let index = self.output.len();
                    let id = call
                        .get("id")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                        .unwrap_or_else(|| format!("gemini_call_{index}"));
                    let wire_name = required_string(call, "name")?;
                    let name = tool_names.get(wire_name).map_or(wire_name, String::as_str);
                    let arguments = call.get("args").cloned().unwrap_or_else(|| json!({}));
                    self.add_bytes(
                        id.len()
                            .saturating_add(name.len())
                            .saturating_add(arguments.to_string().len()),
                    )?;
                    push_tool(&mut self.output, &id, name, arguments);
                }
            }
        }
        if let Some(usage) = value.get("usageMetadata") {
            self.usage = Some(ModelUsage {
                input_tokens: u64_field(usage, "promptTokenCount"),
                cached_input_tokens: u64_field(usage, "cachedContentTokenCount"),
                output_tokens: u64_field(usage, "candidatesTokenCount"),
                reasoning_output_tokens: u64_field(usage, "thoughtsTokenCount"),
                total_tokens: u64_field(usage, "totalTokenCount"),
            });
        }
        Ok(())
    }

    fn add_bytes(&mut self, bytes: usize) -> Result<(), ModelError> {
        self.semantic_bytes = self.semantic_bytes.saturating_add(bytes);
        if self.semantic_bytes > MAX_SEMANTIC_OUTPUT_BYTES {
            Err(ModelError::new(ModelErrorKind::OutputTooLarge, false))
        } else {
            Ok(())
        }
    }

    fn response(&self) -> Result<ModelResponse, ModelError> {
        complete_response(self.output.clone(), self.usage.clone()).map(normalize_response_output)
    }
}

fn complete_response(
    output: Vec<ModelOutputItem>,
    usage: Option<ModelUsage>,
) -> Result<ModelResponse, ModelError> {
    if output.is_empty() {
        Err(ModelError::new(ModelErrorKind::Incomplete, false))
    } else {
        Ok(ModelResponse { output, usage })
    }
}

fn usage_from_parts(
    input_tokens: Option<u64>,
    cached_input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    reasoning_output_tokens: Option<u64>,
) -> Option<ModelUsage> {
    if input_tokens.is_none() && output_tokens.is_none() {
        return None;
    }
    Some(ModelUsage {
        input_tokens,
        cached_input_tokens,
        output_tokens,
        reasoning_output_tokens,
        total_tokens: input_tokens
            .zip(output_tokens)
            .and_then(|(input, output)| input.checked_add(output)),
    })
}

fn map_response_tool_names(
    mut response: ModelResponse,
    tool_names: &BTreeMap<String, String>,
) -> ModelResponse {
    for item in &mut response.output {
        if let ModelOutputItemKind::ToolCall(call) = &mut item.kind {
            if let Some(internal) = tool_names.get(&call.name) {
                call.name.clone_from(internal);
            }
        }
    }
    response
}

fn normalize_response_output(response: ModelResponse) -> ModelResponse {
    let mut text = String::new();
    let mut calls = Vec::new();
    for item in response.output {
        match item.kind {
            ModelOutputItemKind::AssistantText {
                text: output_text, ..
            } => text.push_str(&output_text),
            ModelOutputItemKind::ToolCall(call) => calls.push(call),
        }
    }
    let mut output = Vec::with_capacity(calls.len().saturating_add(usize::from(!text.is_empty())));
    if !text.is_empty() {
        output.push(ModelOutputItem {
            output_index: 0,
            kind: ModelOutputItemKind::AssistantText {
                phase: if calls.is_empty() {
                    ModelTextPhase::Final
                } else {
                    ModelTextPhase::Commentary
                },
                text,
            },
        });
    }
    for call in calls {
        output.push(ModelOutputItem {
            output_index: u32::try_from(output.len()).unwrap_or(u32::MAX),
            kind: ModelOutputItemKind::ToolCall(call),
        });
    }
    ModelResponse {
        output,
        usage: response.usage,
    }
}

async fn send_text_delta(
    sender: &mpsc::Sender<Result<ModelEvent, ModelError>>,
    output_index: u32,
    delta: &str,
) -> Result<(), ModelError> {
    sender
        .send(Ok(ModelEvent::OutputTextDelta {
            output_index,
            delta: delta.to_owned(),
        }))
        .await
        .map_err(|_| ModelError::new(ModelErrorKind::Disconnected, false))
}

async fn send_stream_error(
    sender: &mpsc::Sender<Result<ModelEvent, ModelError>>,
    error: ModelError,
) {
    let _ = sender.send(Err(error)).await;
}

fn rendered_instructions(request: &ModelRequest) -> String {
    request
        .instructions
        .iter()
        .map(|instruction| instruction.rendered_content())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn openai_request(
    request: &ModelRequest,
    strict_tools: bool,
    parallel_tools: bool,
    max_output_tokens: u32,
) -> Value {
    let input = request
        .messages
        .iter()
        .flat_map(openai_input_items)
        .collect::<Vec<_>>();
    let tools = request
        .tools
        .iter()
        .map(|tool| {
            json!({
                "type": "function",
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
                "strict": strict_tools,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "model": request.model,
        "instructions": rendered_instructions(request),
        "input": input,
        "tools": tools,
        "parallel_tool_calls": parallel_tools,
        "max_output_tokens": max_output_tokens,
        "store": false,
        "stream": true,
    })
}

fn openai_input_items(message: &ModelMessage) -> Vec<Value> {
    match message {
        ModelMessage::Text { role, text } => vec![json!({
            "role": match role { ModelRole::User => "user", ModelRole::Assistant => "assistant" },
            "content": text,
        })],
        ModelMessage::Commentary { text } => {
            vec![json!({ "role": "assistant", "content": text })]
        }
        ModelMessage::ContextCompaction { content } => {
            vec![json!({ "role": "user", "content": content })]
        }
        ModelMessage::ToolCall(call) => vec![openai_tool_call(call)],
        ModelMessage::ToolCallBatch(calls) => calls.iter().map(openai_tool_call).collect(),
        ModelMessage::ToolResult { call_id, content } => vec![json!({
            "type": "function_call_output",
            "call_id": call_id,
            "output": content,
        })],
    }
}

fn openai_tool_call(call: &ModelToolCall) -> Value {
    json!({
        "type": "function_call",
        "call_id": call.id,
        "name": call.name,
        "arguments": serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".to_owned()),
    })
}

fn anthropic_request(request: &ModelRequest, strict_tools: bool, max_output_tokens: u32) -> Value {
    let messages = request
        .messages
        .iter()
        .map(anthropic_message)
        .collect::<Vec<_>>();
    let tools = request
        .tools
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.parameters,
                "strict": strict_tools,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "model": request.model,
        "max_tokens": max_output_tokens,
        "system": rendered_instructions(request),
        "messages": messages,
        "tools": tools,
        "stream": true,
    })
}

fn anthropic_message(message: &ModelMessage) -> Value {
    match message {
        ModelMessage::Text { role, text } => json!({
            "role": match role { ModelRole::User => "user", ModelRole::Assistant => "assistant" },
            "content": [{ "type": "text", "text": text }],
        }),
        ModelMessage::Commentary { text } => {
            json!({ "role": "assistant", "content": [{ "type": "text", "text": text }] })
        }
        ModelMessage::ContextCompaction { content } => {
            json!({ "role": "user", "content": [{ "type": "text", "text": content }] })
        }
        ModelMessage::ToolCall(call) => json!({
            "role": "assistant",
            "content": [anthropic_tool_call(call)],
        }),
        ModelMessage::ToolCallBatch(calls) => json!({
            "role": "assistant",
            "content": calls.iter().map(anthropic_tool_call).collect::<Vec<_>>(),
        }),
        ModelMessage::ToolResult { call_id, content } => json!({
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": call_id,
                "content": content,
            }],
        }),
    }
}

fn anthropic_tool_call(call: &ModelToolCall) -> Value {
    json!({
        "type": "tool_use",
        "id": call.id,
        "name": call.name,
        "input": call.arguments,
    })
}

fn gemini_request(request: &ModelRequest, max_output_tokens: u32) -> Value {
    let call_names = request
        .messages
        .iter()
        .flat_map(|message| match message {
            ModelMessage::ToolCall(call) => std::slice::from_ref(call),
            ModelMessage::ToolCallBatch(calls) => calls.as_slice(),
            _ => &[],
        })
        .map(|call| (call.id.as_str(), call.name.as_str()))
        .collect::<std::collections::BTreeMap<_, _>>();
    let contents = request
        .messages
        .iter()
        .map(|message| gemini_message(message, &call_names))
        .collect::<Vec<_>>();
    let declarations = request
        .tools
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "systemInstruction": {
            "parts": [{ "text": rendered_instructions(request) }],
        },
        "contents": contents,
        "tools": [{ "functionDeclarations": declarations }],
        "generationConfig": { "maxOutputTokens": max_output_tokens },
    })
}

fn gemini_message(
    message: &ModelMessage,
    call_names: &std::collections::BTreeMap<&str, &str>,
) -> Value {
    match message {
        ModelMessage::Text { role, text } => json!({
            "role": match role { ModelRole::User => "user", ModelRole::Assistant => "model" },
            "parts": [{ "text": text }],
        }),
        ModelMessage::Commentary { text } => {
            json!({ "role": "model", "parts": [{ "text": text }] })
        }
        ModelMessage::ContextCompaction { content } => {
            json!({ "role": "user", "parts": [{ "text": content }] })
        }
        ModelMessage::ToolCall(call) => json!({
            "role": "model",
            "parts": [{ "functionCall": {
                "id": call.id,
                "name": call.name,
                "args": call.arguments,
            }}],
        }),
        ModelMessage::ToolCallBatch(calls) => json!({
            "role": "model",
            "parts": calls.iter().map(|call| json!({ "functionCall": {
                "id": call.id,
                "name": call.name,
                "args": call.arguments,
            }})).collect::<Vec<_>>(),
        }),
        ModelMessage::ToolResult { call_id, content } => json!({
            "role": "user",
            "parts": [{ "functionResponse": {
                "id": call_id,
                "name": call_names.get(call_id.as_str()).copied().unwrap_or("sugarcode_tool"),
                "response": { "result": content },
            }}],
        }),
    }
}

fn parse_openai_response(value: Value) -> Result<ModelResponse, ModelError> {
    let output = value
        .get("output")
        .and_then(Value::as_array)
        .ok_or_else(protocol_error)?;
    let mut items = Vec::new();
    for value in output {
        match value.get("type").and_then(Value::as_str) {
            Some("message") => {
                for content in value
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if content.get("type").and_then(Value::as_str) == Some("output_text")
                        && let Some(text) = content.get("text").and_then(Value::as_str)
                    {
                        push_text(&mut items, text);
                    }
                }
            }
            Some("function_call") => {
                let id = required_string(value, "call_id")?;
                let name = required_string(value, "name")?;
                let arguments = required_string(value, "arguments")
                    .and_then(|raw| serde_json::from_str(raw).map_err(|_| protocol_error()))?;
                push_tool(&mut items, id, name, arguments);
            }
            _ => {}
        }
    }
    if items.is_empty() {
        return Err(ModelError::new(ModelErrorKind::Incomplete, false));
    }
    Ok(ModelResponse {
        output: items,
        usage: value.get("usage").map(|usage| ModelUsage {
            input_tokens: u64_field(usage, "input_tokens"),
            cached_input_tokens: usage
                .pointer("/input_tokens_details/cached_tokens")
                .and_then(Value::as_u64),
            output_tokens: u64_field(usage, "output_tokens"),
            reasoning_output_tokens: usage
                .pointer("/output_tokens_details/reasoning_tokens")
                .and_then(Value::as_u64),
            total_tokens: u64_field(usage, "total_tokens"),
        }),
    })
}

fn push_text(items: &mut Vec<ModelOutputItem>, text: &str) {
    if text.is_empty() {
        return;
    }
    items.push(ModelOutputItem {
        output_index: u32::try_from(items.len()).unwrap_or(u32::MAX),
        kind: ModelOutputItemKind::AssistantText {
            phase: ModelTextPhase::Final,
            text: text.to_owned(),
        },
    });
}

fn push_tool(items: &mut Vec<ModelOutputItem>, id: &str, name: &str, arguments: Value) {
    items.push(ModelOutputItem {
        output_index: u32::try_from(items.len()).unwrap_or(u32::MAX),
        kind: ModelOutputItemKind::ToolCall(ModelToolCall {
            id: id.to_owned(),
            name: name.to_owned(),
            arguments,
        }),
    });
}

fn required_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, ModelError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(protocol_error)
}

fn u64_field(value: &Value, field: &str) -> Option<u64> {
    value.get(field).and_then(Value::as_u64)
}

fn u32_field(value: &Value, field: &str) -> Option<u32> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
}

fn valid_base_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

pub fn append_path(base_url: &Url, suffix: &str) -> Result<Url, ModelError> {
    let mut url = base_url.clone();
    let base = url.path().trim_end_matches('/');
    url.set_path(&format!("{base}/{}", suffix.trim_start_matches('/')));
    Ok(url)
}

fn gemini_stream_endpoint(base_url: &Url, model: &str) -> Result<Url, ModelError> {
    let mut url = append_path(
        base_url,
        &format!(
            "models/{}:streamGenerateContent",
            percent_encode_path_segment(model)
        ),
    )?;
    url.set_query(Some("alt=sse"));
    Ok(url)
}

fn percent_encode_path_segment(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.') {
                vec![char::from(byte)]
            } else {
                format!("%{byte:02X}").chars().collect()
            }
        })
        .collect()
}

fn bearer_header(token: &Zeroizing<String>) -> Result<HeaderValue, ModelError> {
    let value = Zeroizing::new(format!("Bearer {}", token.as_str()));
    sensitive_header(&value)
}

fn sensitive_header(token: &str) -> Result<HeaderValue, ModelError> {
    let mut value = HeaderValue::from_str(token)
        .map_err(|_| ModelError::new(ModelErrorKind::Authentication, false))?;
    value.set_sensitive(true);
    Ok(value)
}

fn map_reqwest_error(error: reqwest::Error) -> ModelError {
    if error.is_timeout() {
        ModelError::new(ModelErrorKind::Timeout, true)
    } else {
        ModelError::new(ModelErrorKind::Transport, true)
    }
}

fn map_error(status: StatusCode, body: &[u8]) -> ModelError {
    let text = String::from_utf8_lossy(body).to_ascii_lowercase();
    if matches!(
        status,
        StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY
    ) && [
        "context_length_exceeded",
        "maximum context length",
        "context window",
        "too many tokens",
        "input token count",
    ]
    .iter()
    .any(|marker| text.contains(marker))
    {
        return ModelError::new(ModelErrorKind::ContextLengthExceeded, false);
    }
    match status.as_u16() {
        401 | 403 => ModelError::new(ModelErrorKind::Authentication, false),
        408 => ModelError::new(ModelErrorKind::Timeout, true),
        429 => ModelError::new(ModelErrorKind::RateLimited, true),
        400..=499 => ModelError::new(ModelErrorKind::InvalidRequest, false),
        500..=599 => ModelError::new(ModelErrorKind::Server, true),
        _ => ModelError::new(ModelErrorKind::Server, false),
    }
}

fn protocol_error() -> ModelError {
    ModelError::new(ModelErrorKind::Protocol, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool_names() -> BTreeMap<String, String> {
        BTreeMap::from([("workspace_read".to_owned(), "workspace/read".to_owned())])
    }

    #[tokio::test]
    async fn openai_sse_completion_restores_internal_tool_names_and_usage() {
        let (sender, mut receiver) = mpsc::channel(4);
        let value = json!({
            "type": "response.completed",
            "response": {
                "output": [
                    {
                        "type": "message",
                        "content": [{"type": "output_text", "text": "Checking."}]
                    },
                    {
                        "type": "function_call",
                        "call_id": "call_1",
                        "name": "workspace_read",
                        "arguments": "{\"path\":\"README.md\"}"
                    }
                ],
                "usage": {
                    "input_tokens": 12,
                    "output_tokens": 3,
                    "total_tokens": 15
                }
            }
        });
        let StreamProgress::Complete(response) =
            consume_openai_event("response.completed", value, &sender, &tool_names())
                .await
                .expect("completed response")
        else {
            panic!("completion event");
        };
        assert!(receiver.try_recv().is_err());
        assert!(matches!(
            &response.output[0].kind,
            ModelOutputItemKind::AssistantText {
                phase: ModelTextPhase::Commentary,
                text,
            } if text == "Checking."
        ));
        assert!(matches!(
            &response.output[1].kind,
            ModelOutputItemKind::ToolCall(call)
                if call.name == "workspace/read"
                    && call.arguments == json!({"path": "README.md"})
        ));
        assert_eq!(
            response.usage.and_then(|usage| usage.total_tokens),
            Some(15)
        );
    }

    #[tokio::test]
    async fn anthropic_sse_assembles_text_tool_arguments_and_usage() {
        let (sender, mut receiver) = mpsc::channel(8);
        let mut state = AnthropicStreamState::default();
        state
            .consume(
                "message_start",
                json!({"message": {"usage": {"input_tokens": 10}}}),
                &sender,
            )
            .await
            .expect("message start");
        state
            .consume(
                "content_block_start",
                json!({"index": 0, "content_block": {"type": "text", "text": ""}}),
                &sender,
            )
            .await
            .expect("text start");
        state
            .consume(
                "content_block_delta",
                json!({"index": 0, "delta": {"type": "text_delta", "text": "Checking."}}),
                &sender,
            )
            .await
            .expect("text delta");
        state
            .consume(
                "content_block_start",
                json!({"index": 1, "content_block": {
                    "type": "tool_use",
                    "id": "call_1",
                    "name": "workspace_read",
                    "input": {}
                }}),
                &sender,
            )
            .await
            .expect("tool start");
        state
            .consume(
                "content_block_delta",
                json!({"index": 1, "delta": {
                    "type": "input_json_delta",
                    "partial_json": "{\"path\":\"README.md\"}"
                }}),
                &sender,
            )
            .await
            .expect("tool delta");
        state
            .consume(
                "message_delta",
                json!({"usage": {"output_tokens": 7}}),
                &sender,
            )
            .await
            .expect("usage");
        assert!(matches!(
            receiver.recv().await,
            Some(Ok(ModelEvent::OutputTextDelta { delta, .. })) if delta == "Checking."
        ));
        let response = state.response(&tool_names()).expect("response");
        assert!(matches!(
            &response.output[0].kind,
            ModelOutputItemKind::AssistantText {
                phase: ModelTextPhase::Commentary,
                text,
            } if text == "Checking."
        ));
        assert!(matches!(
            &response.output[1].kind,
            ModelOutputItemKind::ToolCall(call)
                if call.name == "workspace/read"
                    && call.arguments == json!({"path": "README.md"})
        ));
        assert_eq!(
            response.usage.and_then(|usage| usage.total_tokens),
            Some(17)
        );
    }

    #[tokio::test]
    async fn gemini_sse_accumulates_chunks_and_emits_deltas() {
        let (sender, mut receiver) = mpsc::channel(8);
        let mut state = GeminiStreamState::default();
        state
            .consume(
                json!({"candidates": [{"content": {"parts": [{"text": "Hello "}]}}]}),
                &sender,
                &tool_names(),
            )
            .await
            .expect("first chunk");
        state
            .consume(
                json!({
                    "candidates": [{"content": {"parts": [{
                        "functionCall": {
                            "id": "call_1",
                            "name": "workspace_read",
                            "args": {"path": "README.md"}
                        }
                    }]}}],
                    "usageMetadata": {
                        "promptTokenCount": 8,
                        "candidatesTokenCount": 4,
                        "totalTokenCount": 12
                    }
                }),
                &sender,
                &tool_names(),
            )
            .await
            .expect("second chunk");
        assert!(matches!(
            receiver.recv().await,
            Some(Ok(ModelEvent::OutputTextDelta { delta, .. })) if delta == "Hello "
        ));
        let response = state.response().expect("response");
        assert!(matches!(
            &response.output[0].kind,
            ModelOutputItemKind::AssistantText {
                phase: ModelTextPhase::Commentary,
                text,
            } if text == "Hello "
        ));
        assert!(matches!(
            &response.output[1].kind,
            ModelOutputItemKind::ToolCall(call) if call.name == "workspace/read"
        ));
        assert_eq!(
            response.usage.and_then(|usage| usage.total_tokens),
            Some(12)
        );
    }

    #[test]
    fn native_requests_enable_streaming_and_gemini_uses_sse_endpoint() {
        let request = ModelRequest {
            model: "model/id".to_owned(),
            instructions: Vec::new(),
            messages: Vec::new(),
            tools: Vec::new(),
        };
        assert_eq!(openai_request(&request, true, true, 4096)["stream"], true);
        assert_eq!(anthropic_request(&request, true, 4096)["stream"], true);
        assert_eq!(
            gemini_stream_endpoint(
                &Url::parse("https://generativelanguage.googleapis.com/v1beta").expect("base URL"),
                &request.model,
            )
            .expect("stream URL")
            .as_str(),
            "https://generativelanguage.googleapis.com/v1beta/models/model%2Fid:streamGenerateContent?alt=sse"
        );
    }
}
