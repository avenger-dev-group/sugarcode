use crate::BoxModelFuture;
use crate::ModelContentPart;
use crate::ModelContinuation;
use crate::ModelError;
use crate::ModelErrorKind;
use crate::ModelEvent;
use crate::ModelFinishReason;
use crate::ModelMessage;
use crate::ModelOutputItem;
use crate::ModelOutputItemKind;
use crate::ModelProvider;
use crate::ModelRequest;
use crate::ModelResponse;
use crate::ModelRole;
use crate::ModelStrictToolsMode;
use crate::ModelTerminalMetadata;
use crate::ModelTextPhase;
use crate::ModelToolCall;
use crate::ModelToolResultContent;
use crate::ModelUsage;
use crate::ProviderContextEnvelope;
use crate::ProviderWireApi;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use eventsource_stream::EventStreamError;
use eventsource_stream::Eventsource;
use futures_util::FutureExt;
use futures_util::StreamExt;
use reqwest::StatusCode;
use reqwest::header::AUTHORIZATION;
use reqwest::header::CONTENT_TYPE;
use reqwest::header::HeaderMap;
use reqwest::header::HeaderName;
use reqwest::header::HeaderValue;
use reqwest::header::RETRY_AFTER;
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
const MAX_SSE_EVENT_BYTES: usize = crate::MAX_PROVIDER_RESPONSE_BYTES;
const MAX_SEMANTIC_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_ERROR_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeProtocol {
    OpenAiResponses,
    AnthropicMessages,
    GeminiGenerateContent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenAiContinuationMode {
    LocalReplay,
    ProviderManaged,
}

pub struct NativeModelProvider {
    client: reqwest::Client,
    base_url: Url,
    token: Option<Zeroizing<String>>,
    protocol: NativeProtocol,
    strict_tools: ModelStrictToolsMode,
    parallel_tools: bool,
    max_output_tokens: u32,
    openai_continuation_mode: OpenAiContinuationMode,
}

impl NativeModelProvider {
    pub fn openai_responses(
        base_url: Url,
        token: Option<Zeroizing<String>>,
        strict_tools: ModelStrictToolsMode,
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
        strict_tools: ModelStrictToolsMode,
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
        strict_tools: ModelStrictToolsMode,
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
        strict_tools: ModelStrictToolsMode,
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
            openai_continuation_mode: OpenAiContinuationMode::LocalReplay,
        })
    }

    pub fn with_openai_continuation_mode(mut self, mode: OpenAiContinuationMode) -> Self {
        if self.protocol == NativeProtocol::OpenAiResponses {
            self.openai_continuation_mode = mode;
        }
        self
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
            .field("openai_continuation_mode", &self.openai_continuation_mode)
            .finish()
    }
}

impl ModelProvider for NativeModelProvider {
    fn stream(&self, request: ModelRequest) -> BoxModelFuture<'_> {
        async move {
            let normalized = crate::tool_names::normalize_request(request);
            let request = &normalized.request;
            let (endpoint, body, local_fallback) = match self.protocol {
                NativeProtocol::OpenAiResponses => {
                    let endpoint = append_path(&self.base_url, "responses")?;
                    let local = openai_request(
                        request,
                        self.strict_tools,
                        self.parallel_tools,
                        self.max_output_tokens,
                    )?;
                    if self.openai_continuation_mode == OpenAiContinuationMode::ProviderManaged {
                        let managed = openai_provider_managed_request(
                            request,
                            self.strict_tools,
                            self.parallel_tools,
                            self.max_output_tokens,
                        )?;
                        let fallback = managed
                            .get("previous_response_id")
                            .is_some()
                            .then_some(local);
                        (endpoint, managed, fallback)
                    } else {
                        (endpoint, local, None)
                    }
                }
                NativeProtocol::AnthropicMessages => (
                    append_path(&self.base_url, "messages")?,
                    anthropic_request(request, self.strict_tools, self.max_output_tokens)?,
                    None,
                ),
                NativeProtocol::GeminiGenerateContent => (
                    gemini_stream_endpoint(&self.base_url, &request.model)?,
                    gemini_request(request, self.strict_tools, self.max_output_tokens)?,
                    None,
                ),
            };
            let mut builder = self.client.post(endpoint.clone()).json(&body);
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
            let mut response = builder.send().await.map_err(map_reqwest_error)?;
            let mut used_local_fallback = false;
            if !response.status().is_success()
                && matches!(
                    response.status(),
                    StatusCode::BAD_REQUEST
                        | StatusCode::NOT_FOUND
                        | StatusCode::UNPROCESSABLE_ENTITY
                )
                && let Some(local_fallback) = local_fallback
            {
                let mut fallback = self.client.post(endpoint).json(&local_fallback);
                if let Some(token) = &self.token {
                    fallback = fallback.header(AUTHORIZATION, bearer_header(token)?);
                }
                response = fallback.send().await.map_err(map_reqwest_error)?;
                used_local_fallback = true;
            }
            let status = response.status();
            if !status.is_success() {
                let provider_request_id = provider_request_id(response.headers());
                let retry_after = header_text(response.headers(), RETRY_AFTER.as_str());
                let bytes = response.bytes().await.map_err(map_reqwest_error)?;
                let provider_code = provider_error_code(&bytes);
                return Err(
                    map_error(status, &bytes[..bytes.len().min(MAX_ERROR_BYTES)])
                        .with_provider_metadata(
                            status.as_u16(),
                            provider_code.as_deref(),
                            provider_request_id.as_deref(),
                            retry_after.as_deref(),
                        ),
                );
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
                self.parallel_tools,
                tool_names,
                used_local_fallback,
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
    parallel_tools: bool,
    tool_names: BTreeMap<String, String>,
    used_local_fallback: bool,
) {
    if used_local_fallback
        && sender
            .send(Ok(ModelEvent::Warning {
                code: "providerManagedContinuationFallback",
            }))
            .await
            .is_err()
    {
        return;
    }
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
    let mut state = NativeStreamState::new(protocol, parallel_tools);
    loop {
        let next = tokio::select! {
            _ = sender.closed() => return,
            next = stream.next() => next,
        };
        let event = match next {
            None => {
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
            Some(Err(error)) => {
                let error = match error {
                    EventStreamError::Transport(error)
                        if error.kind() != io::ErrorKind::InvalidData =>
                    {
                        ModelError::new(ModelErrorKind::Disconnected, true)
                    }
                    EventStreamError::Transport(error)
                        if error.kind() == io::ErrorKind::InvalidData =>
                    {
                        ModelError::new(ModelErrorKind::ProviderResponseTooLarge, false)
                    }
                    EventStreamError::Utf8(_) | EventStreamError::Parser(_) => {
                        ModelError::new(ModelErrorKind::Protocol, false)
                    }
                    EventStreamError::Transport(_) => {
                        ModelError::new(ModelErrorKind::Disconnected, true)
                    }
                };
                send_stream_error(&sender, error).await;
                return;
            }
            Some(Ok(event)) => event,
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
                    .send(Ok(ModelEvent::ResponseCompleted(*response)))
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
    Complete(Box<ModelResponse>),
}

enum NativeStreamState {
    OpenAi,
    Anthropic(AnthropicStreamState),
    Gemini(GeminiStreamState),
}

impl NativeStreamState {
    fn new(protocol: NativeProtocol, parallel_tools: bool) -> Self {
        match protocol {
            NativeProtocol::OpenAiResponses => Self::OpenAi,
            NativeProtocol::AnthropicMessages => Self::Anthropic(AnthropicStreamState::default()),
            NativeProtocol::GeminiGenerateContent => {
                Self::Gemini(GeminiStreamState::new(parallel_tools))
            }
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
                    Ok(StreamProgress::Complete(Box::new(
                        state.response(tool_names)?,
                    )))
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
            Ok(StreamProgress::Complete(Box::new(response)))
        }
        "response.failed" | "response.incomplete" | "error" => Err(ModelError::new(
            if kind == "response.incomplete" {
                ModelErrorKind::Incomplete
            } else {
                ModelErrorKind::Server
            },
            false,
        )),
        "response.created"
        | "response.in_progress"
        | "response.output_item.added"
        | "response.output_item.done"
        | "response.content_part.added"
        | "response.content_part.done"
        | "response.output_text.done"
        | "response.function_call_arguments.delta"
        | "response.function_call_arguments.done"
        | "response.reasoning_summary_part.added"
        | "response.reasoning_summary_part.done"
        | "response.reasoning_summary_text.delta"
        | "response.reasoning_summary_text.done" => Ok(StreamProgress::Continue),
        // A completed Responses payload is authoritative. Providers may add
        // optional typed progress events without changing that final payload,
        // so keep the streaming consumer forward compatible with those events.
        // Terminal events remain explicitly handled above and final output
        // items are still validated by `parse_openai_response`.
        kind if kind.starts_with("response.") => Ok(StreamProgress::Continue),
        _ => Err(ModelError::new(ModelErrorKind::UnsupportedOutput, false)),
    }
}

#[derive(Default)]
struct AnthropicStreamState {
    blocks: BTreeMap<u32, AnthropicBlock>,
    message_id: Option<String>,
    stop_reason: Option<String>,
    input_tokens: Option<u64>,
    cached_input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    semantic_bytes: usize,
}

enum AnthropicBlock {
    Text(String),
    Thinking {
        thinking: String,
        signature: String,
    },
    RedactedThinking {
        data: String,
    },
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
                self.message_id = value
                    .pointer("/message/id")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
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
                    Some("thinking") => {
                        let thinking = block
                            .get("thinking")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned();
                        let signature = block
                            .get("signature")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned();
                        self.add_bytes(thinking.len().saturating_add(signature.len()))?;
                        self.blocks.insert(
                            index,
                            AnthropicBlock::Thinking {
                                thinking,
                                signature,
                            },
                        );
                    }
                    Some("redacted_thinking") => {
                        let data = required_string(block, "data")?.to_owned();
                        self.add_bytes(data.len())?;
                        self.blocks
                            .insert(index, AnthropicBlock::RedactedThinking { data });
                    }
                    _ => {
                        return Err(ModelError::new(ModelErrorKind::UnsupportedOutput, false));
                    }
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
                    Some("thinking_delta") => {
                        let partial = required_string(delta, "thinking")?;
                        self.add_bytes(partial.len())?;
                        match self.blocks.get_mut(&index) {
                            Some(AnthropicBlock::Thinking { thinking, .. }) => {
                                thinking.push_str(partial);
                            }
                            _ => return Err(protocol_error()),
                        }
                    }
                    Some("signature_delta") => {
                        let partial = required_string(delta, "signature")?;
                        self.add_bytes(partial.len())?;
                        match self.blocks.get_mut(&index) {
                            Some(AnthropicBlock::Thinking { signature, .. }) => {
                                signature.push_str(partial);
                            }
                            _ => return Err(protocol_error()),
                        }
                    }
                    _ => return Err(protocol_error()),
                }
            }
            "message_delta" => {
                self.stop_reason = value
                    .pointer("/delta/stop_reason")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .or_else(|| self.stop_reason.take());
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
        let mut raw_blocks = Vec::new();
        for block in self.blocks.values() {
            match block {
                AnthropicBlock::Text(text) => {
                    raw_blocks.push(json!({"type": "text", "text": text}));
                    if !text.is_empty() {
                        push_text(&mut output, text);
                    }
                }
                AnthropicBlock::Thinking {
                    thinking,
                    signature,
                } => raw_blocks.push(json!({
                    "type": "thinking",
                    "thinking": thinking,
                    "signature": signature,
                })),
                AnthropicBlock::RedactedThinking { data } => raw_blocks.push(json!({
                    "type": "redacted_thinking",
                    "data": data,
                })),
                AnthropicBlock::Tool {
                    id,
                    name,
                    arguments,
                } => {
                    let raw_arguments = serde_json::from_str::<Value>(arguments)
                        .map_err(|_| ModelError::new(ModelErrorKind::Protocol, false))?;
                    raw_blocks.push(json!({
                        "type": "tool_use",
                        "id": id,
                        "name": name,
                        "input": raw_arguments,
                    }));
                    let arguments = serde_json::from_str(arguments)
                        .map_err(|_| ModelError::new(ModelErrorKind::Protocol, false))?;
                    push_tool(
                        &mut output,
                        id,
                        tool_names.get(name).map_or(name.as_str(), String::as_str),
                        arguments,
                    );
                }
            }
        }
        let mut response = complete_response(
            output,
            usage_from_parts(
                self.input_tokens,
                self.cached_input_tokens,
                self.output_tokens,
                None,
            ),
        )?;
        response.terminal = ModelTerminalMetadata {
            finish_reason: match self.stop_reason.as_deref() {
                Some("end_turn" | "stop_sequence") => {
                    if self.stop_reason.as_deref() == Some("stop_sequence") {
                        ModelFinishReason::StopSequence
                    } else {
                        ModelFinishReason::Stop
                    }
                }
                Some("tool_use") => ModelFinishReason::ToolCalls,
                Some("max_tokens") => ModelFinishReason::MaxTokens,
                Some(reason) => ModelFinishReason::Unknown(reason.to_owned()),
                None => ModelFinishReason::Unknown("missing".to_owned()),
            },
            provider_request_id: self.message_id.clone(),
            continuation: if self
                .blocks
                .values()
                .any(|block| matches!(block, AnthropicBlock::Tool { .. }))
            {
                ModelContinuation::ToolCalls
            } else {
                ModelContinuation::Complete
            },
        };
        response.provider_context = Some(ProviderContextEnvelope::new_with_replay_tokens(
            ProviderWireApi::AnthropicMessages,
            self.message_id.clone(),
            serde_json::to_vec(&raw_blocks).map_err(|_| protocol_error())?,
            self.output_tokens,
        )?);
        Ok(response)
    }
}

struct GeminiStreamState {
    output: Vec<ModelOutputItem>,
    raw_parts: Vec<Value>,
    usage: Option<ModelUsage>,
    semantic_bytes: usize,
    finish_reason: Option<String>,
    provider_request_id: Option<String>,
    parallel_tools: bool,
}

impl Default for GeminiStreamState {
    fn default() -> Self {
        Self::new(true)
    }
}

impl GeminiStreamState {
    fn new(parallel_tools: bool) -> Self {
        Self {
            output: Vec::new(),
            raw_parts: Vec::new(),
            usage: None,
            semantic_bytes: 0,
            finish_reason: None,
            provider_request_id: None,
            parallel_tools,
        }
    }

    async fn consume(
        &mut self,
        value: Value,
        sender: &mpsc::Sender<Result<ModelEvent, ModelError>>,
        tool_names: &BTreeMap<String, String>,
    ) -> Result<(), ModelError> {
        if let Some(reason) = value
            .pointer("/promptFeedback/blockReason")
            .and_then(Value::as_str)
        {
            return Err(ModelError::new(
                if reason == "SAFETY" {
                    ModelErrorKind::Filtered
                } else {
                    ModelErrorKind::UnsupportedOutput
                },
                false,
            ));
        }
        if value
            .get("candidates")
            .and_then(Value::as_array)
            .is_some_and(|candidates| candidates.len() > 1)
        {
            return Err(ModelError::new(ModelErrorKind::UnsupportedOutput, false));
        }
        self.provider_request_id = value
            .get("responseId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| self.provider_request_id.take());
        self.finish_reason = value
            .pointer("/candidates/0/finishReason")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| self.finish_reason.take());
        if let Some(parts) = value
            .pointer("/candidates/0/content/parts")
            .and_then(Value::as_array)
        {
            for part in parts {
                self.raw_parts.push(part.clone());
                if part.get("thought").and_then(Value::as_bool) == Some(true) {
                    continue;
                }
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
                } else {
                    return Err(ModelError::new(ModelErrorKind::UnsupportedOutput, false));
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
        let tool_call_count = self
            .output
            .iter()
            .filter(|item| matches!(item.kind, ModelOutputItemKind::ToolCall(_)))
            .count();
        if tool_call_count > 1 && !self.parallel_tools {
            return Err(ModelError::new(ModelErrorKind::Protocol, false));
        }
        let mut response = complete_response(self.output.clone(), self.usage)?;
        response.terminal = ModelTerminalMetadata {
            finish_reason: match self.finish_reason.as_deref() {
                Some("STOP") => ModelFinishReason::Stop,
                Some("MAX_TOKENS") => ModelFinishReason::MaxTokens,
                Some("SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT") => {
                    ModelFinishReason::Safety
                }
                Some(reason) => ModelFinishReason::Unknown(reason.to_owned()),
                None if tool_call_count > 0 => ModelFinishReason::ToolCalls,
                None => ModelFinishReason::Unknown("missing".to_owned()),
            },
            provider_request_id: self.provider_request_id.clone(),
            continuation: if tool_call_count > 0 {
                ModelContinuation::ToolCalls
            } else {
                ModelContinuation::Complete
            },
        };
        response.provider_context = Some(ProviderContextEnvelope::new_with_replay_tokens(
            ProviderWireApi::GeminiGenerateContent,
            self.provider_request_id.clone(),
            serde_json::to_vec(&json!({
                "role": "model",
                "parts": self.raw_parts,
            }))
            .map_err(|_| protocol_error())?,
            self.usage.and_then(|usage| usage.output_tokens),
        )?);
        Ok(response)
    }
}

fn complete_response(
    output: Vec<ModelOutputItem>,
    usage: Option<ModelUsage>,
) -> Result<ModelResponse, ModelError> {
    if output.is_empty() {
        Err(ModelError::new(ModelErrorKind::Incomplete, false))
    } else {
        let continuation = if output
            .iter()
            .any(|item| matches!(item.kind, ModelOutputItemKind::ToolCall(_)))
        {
            ModelContinuation::ToolCalls
        } else {
            ModelContinuation::Complete
        };
        Ok(normalize_response_output(ModelResponse {
            output,
            usage,
            terminal: ModelTerminalMetadata::completed(continuation),
            provider_context: None,
        }))
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
        if let ModelOutputItemKind::ToolCall(call) = &mut item.kind
            && let Some(internal) = tool_names.get(&call.name)
        {
            call.name.clone_from(internal);
        }
    }
    response
}

fn normalize_response_output(mut response: ModelResponse) -> ModelResponse {
    let has_tool_calls = response
        .output
        .iter()
        .any(|item| matches!(item.kind, ModelOutputItemKind::ToolCall(_)));
    for (index, item) in response.output.iter_mut().enumerate() {
        item.output_index = u32::try_from(index).unwrap_or(u32::MAX);
        if let ModelOutputItemKind::AssistantText { phase, .. } = &mut item.kind {
            *phase = if has_tool_calls {
                ModelTextPhase::Commentary
            } else {
                ModelTextPhase::Final
            };
        }
    }
    response
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
    strict_tools: ModelStrictToolsMode,
    parallel_tools: bool,
    max_output_tokens: u32,
) -> Result<Value, ModelError> {
    let input = request
        .messages
        .iter()
        .map(openai_input_items)
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let tools = request
        .tools
        .iter()
        .map(|tool| {
            let strict = crate::tool_schema::strict_for_tool(
                &tool.name,
                &tool.parameters,
                crate::tool_schema::ToolSchemaDialect::OpenAi,
                strict_tools,
            )?;
            Ok(json!({
                "type": "function",
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
                "strict": strict,
            }))
        })
        .collect::<Result<Vec<_>, ModelError>>()?;
    Ok(json!({
        "model": request.model,
        "instructions": rendered_instructions(request),
        "input": input,
        "tools": tools,
        "parallel_tool_calls": parallel_tools,
        "max_output_tokens": max_output_tokens,
        "store": false,
        "stream": true,
        "include": ["reasoning.encrypted_content"],
    }))
}

fn openai_provider_managed_request(
    request: &ModelRequest,
    strict_tools: ModelStrictToolsMode,
    parallel_tools: bool,
    max_output_tokens: u32,
) -> Result<Value, ModelError> {
    let mut previous_response_id = None;
    let mut tail_start = 0usize;
    for (index, message) in request.messages.iter().enumerate() {
        if let Some(context) = sole_provider_context(message)? {
            ensure_context_wire(context, ProviderWireApi::OpenAiResponses)?;
            if let Some(response_id) = context.response_id() {
                previous_response_id = Some(response_id.to_owned());
                tail_start = index.saturating_add(1);
            }
        }
    }
    let mut managed_request = request.clone();
    if previous_response_id.is_some() {
        managed_request.messages = request.messages[tail_start..].to_vec();
    }
    let mut body = openai_request(
        &managed_request,
        strict_tools,
        parallel_tools,
        max_output_tokens,
    )?;
    body["store"] = Value::Bool(true);
    if let Some(previous_response_id) = previous_response_id {
        body["previous_response_id"] = Value::String(previous_response_id);
    }
    Ok(body)
}

fn openai_input_items(message: &ModelMessage) -> Result<Vec<Value>, ModelError> {
    if let Some(context) = sole_provider_context(message)? {
        ensure_context_wire(context, ProviderWireApi::OpenAiResponses)?;
        return serde_json::from_slice::<Vec<Value>>(&context.payload()?)
            .map_err(|_| protocol_error());
    }
    if message.role == ModelRole::User
        && message.content.iter().any(|part| {
            matches!(
                part,
                ModelContentPart::ImageAsset(_) | ModelContentPart::PdfDocument(_)
            )
        })
    {
        let content = message
            .content
            .iter()
            .map(|part| match part {
                ModelContentPart::Text { text, .. }
                | ModelContentPart::ContextCompaction { content: text } => {
                    Ok(json!({"type": "input_text", "text": text}))
                }
                ModelContentPart::ImageAsset(asset) => Ok(json!({
                    "type": "input_image",
                    "image_url": data_url(&asset.media_type, &asset.bytes),
                })),
                ModelContentPart::PdfDocument(asset) => Ok(json!({
                    "type": "input_file",
                    "filename": asset.original_name,
                    "file_data": data_url(&asset.media_type, &asset.bytes),
                })),
                ModelContentPart::ToolCall { .. }
                | ModelContentPart::ToolResult { .. }
                | ModelContentPart::ProviderContext(_) => Err(protocol_error()),
            })
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(vec![json!({"role": "user", "content": content})]);
    }
    message
        .content
        .iter()
        .map(|part| match part {
            ModelContentPart::Text { text, .. } => Ok(json!({
                "role": match message.role {
                    ModelRole::User => "user",
                    ModelRole::Assistant => "assistant",
                },
                "content": text,
            })),
            ModelContentPart::ContextCompaction { content } => Ok(json!({
                "role": "user",
                "content": content,
            })),
            ModelContentPart::ToolCall { call } => Ok(openai_tool_call(call)),
            ModelContentPart::ToolResult { result } => Ok(json!({
                "type": "function_call_output",
                "call_id": result.call_id,
                "output": tool_result_text(&result.content),
            })),
            ModelContentPart::ImageAsset(_) | ModelContentPart::PdfDocument(_) => {
                Err(ModelError::new(ModelErrorKind::InvalidRequest, false))
            }
            ModelContentPart::ProviderContext(_) => Err(protocol_error()),
        })
        .collect()
}

fn openai_tool_call(call: &ModelToolCall) -> Value {
    json!({
        "type": "function_call",
        "call_id": call.id,
        "name": call.name,
        "arguments": serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".to_owned()),
    })
}

fn anthropic_request(
    request: &ModelRequest,
    strict_tools: ModelStrictToolsMode,
    max_output_tokens: u32,
) -> Result<Value, ModelError> {
    let messages = request
        .messages
        .iter()
        .map(anthropic_message)
        .collect::<Result<Vec<_>, _>>()?;
    let tools = request
        .tools
        .iter()
        .map(|tool| {
            let strict = crate::tool_schema::strict_for_tool(
                &tool.name,
                &tool.parameters,
                crate::tool_schema::ToolSchemaDialect::Anthropic,
                strict_tools,
            )?;
            Ok(json!({
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.parameters,
                "strict": strict,
            }))
        })
        .collect::<Result<Vec<_>, ModelError>>()?;
    Ok(json!({
        "model": request.model,
        "max_tokens": max_output_tokens,
        "system": rendered_instructions(request),
        "messages": messages,
        "tools": tools,
        "stream": true,
    }))
}

fn anthropic_message(message: &ModelMessage) -> Result<Value, ModelError> {
    if let Some(context) = sole_provider_context(message)? {
        ensure_context_wire(context, ProviderWireApi::AnthropicMessages)?;
        let content = serde_json::from_slice::<Vec<Value>>(&context.payload()?)
            .map_err(|_| protocol_error())?;
        return Ok(json!({"role": "assistant", "content": content}));
    }
    let content = message
        .content
        .iter()
        .map(|part| match part {
            ModelContentPart::Text { text, .. }
            | ModelContentPart::ContextCompaction { content: text } => {
                Ok(json!({"type": "text", "text": text}))
            }
            ModelContentPart::ToolCall { call } => Ok(anthropic_tool_call(call)),
            ModelContentPart::ToolResult { result } => Ok(json!({
                "type": "tool_result",
                "tool_use_id": result.call_id,
                "content": tool_result_text(&result.content),
                "is_error": matches!(&result.content, ModelToolResultContent::Error { .. }),
            })),
            ModelContentPart::ImageAsset(asset) => Ok(json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": asset.media_type,
                    "data": BASE64_STANDARD.encode(&asset.bytes),
                },
            })),
            ModelContentPart::PdfDocument(asset) => Ok(json!({
                "type": "document",
                "source": {
                    "type": "base64",
                    "media_type": asset.media_type,
                    "data": BASE64_STANDARD.encode(&asset.bytes),
                },
            })),
            ModelContentPart::ProviderContext(_) => Err(protocol_error()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "role": match message.role {
            ModelRole::User => "user",
            ModelRole::Assistant => "assistant",
        },
        "content": content,
    }))
}

fn anthropic_tool_call(call: &ModelToolCall) -> Value {
    json!({
        "type": "tool_use",
        "id": call.id,
        "name": call.name,
        "input": call.arguments,
    })
}

fn gemini_request(
    request: &ModelRequest,
    strict_tools: ModelStrictToolsMode,
    max_output_tokens: u32,
) -> Result<Value, ModelError> {
    let mut call_names = request
        .messages
        .iter()
        .flat_map(|message| {
            message.content.iter().filter_map(|part| match part {
                ModelContentPart::ToolCall { call } => Some((call.id.clone(), call.name.clone())),
                _ => None,
            })
        })
        .collect::<BTreeMap<_, _>>();
    for message in &request.messages {
        let Some(context) = sole_provider_context(message)? else {
            continue;
        };
        ensure_context_wire(context, ProviderWireApi::GeminiGenerateContent)?;
        let value: Value =
            serde_json::from_slice(&context.payload()?).map_err(|_| protocol_error())?;
        for call in value
            .get("parts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|part| part.get("functionCall"))
        {
            if let (Some(id), Some(name)) = (
                call.get("id").and_then(Value::as_str),
                call.get("name").and_then(Value::as_str),
            ) {
                call_names.insert(id.to_owned(), name.to_owned());
            }
        }
    }
    let contents = request
        .messages
        .iter()
        .map(|message| gemini_message(message, &call_names))
        .collect::<Result<Vec<_>, _>>()?;
    let declarations = request
        .tools
        .iter()
        .map(|tool| {
            crate::tool_schema::strict_for_tool(
                &tool.name,
                &tool.parameters,
                crate::tool_schema::ToolSchemaDialect::Gemini,
                strict_tools,
            )?;
            Ok(json!({
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            }))
        })
        .collect::<Result<Vec<_>, ModelError>>()?;
    Ok(json!({
        "systemInstruction": {
            "parts": [{ "text": rendered_instructions(request) }],
        },
        "contents": contents,
        "tools": [{ "functionDeclarations": declarations }],
        "generationConfig": { "maxOutputTokens": max_output_tokens },
    }))
}

fn gemini_message(
    message: &ModelMessage,
    call_names: &BTreeMap<String, String>,
) -> Result<Value, ModelError> {
    if let Some(context) = sole_provider_context(message)? {
        ensure_context_wire(context, ProviderWireApi::GeminiGenerateContent)?;
        return serde_json::from_slice(&context.payload()?).map_err(|_| protocol_error());
    }
    let parts = message
        .content
        .iter()
        .map(|part| match part {
            ModelContentPart::Text { text, .. }
            | ModelContentPart::ContextCompaction { content: text } => Ok(json!({"text": text})),
            ModelContentPart::ToolCall { call } => Ok(json!({"functionCall": {
                "id": call.id,
                "name": call.name,
                "args": call.arguments,
            }})),
            ModelContentPart::ToolResult { result } => Ok(json!({"functionResponse": {
                "id": result.call_id,
                "name": call_names
                    .get(result.call_id.as_str())
                    .map(String::as_str)
                    .unwrap_or("sugarcode_tool"),
                "response": match &result.content {
                    ModelToolResultContent::Json(value) => value.clone(),
                    ModelToolResultContent::Text(text) => json!({"result": text}),
                    ModelToolResultContent::Error { kind, message } => {
                        json!({"error": {"kind": kind, "message": message}})
                    }
                },
            }})),
            ModelContentPart::ImageAsset(asset) | ModelContentPart::PdfDocument(asset) => {
                Ok(json!({"inlineData": {
                    "mimeType": asset.media_type,
                    "data": BASE64_STANDARD.encode(&asset.bytes),
                }}))
            }
            ModelContentPart::ProviderContext(_) => Err(protocol_error()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "role": match message.role {
            ModelRole::User => "user",
            ModelRole::Assistant => "model",
        },
        "parts": parts,
    }))
}

fn data_url(media_type: &str, bytes: &[u8]) -> String {
    format!("data:{media_type};base64,{}", BASE64_STANDARD.encode(bytes))
}

fn sole_provider_context(
    message: &ModelMessage,
) -> Result<Option<&ProviderContextEnvelope>, ModelError> {
    let mut contexts = message.content.iter().filter_map(|part| match part {
        ModelContentPart::ProviderContext(context) => Some(context),
        _ => None,
    });
    let context = contexts.next();
    if contexts.next().is_some() || context.is_some_and(|_| message.content.len() != 1) {
        return Err(protocol_error());
    }
    Ok(context)
}

fn ensure_context_wire(
    context: &ProviderContextEnvelope,
    expected: ProviderWireApi,
) -> Result<(), ModelError> {
    if context.wire_api() == expected {
        Ok(())
    } else {
        Err(ModelError::new(ModelErrorKind::InvalidRequest, false))
    }
}

fn tool_result_text(content: &ModelToolResultContent) -> String {
    match content {
        ModelToolResultContent::Json(value) => value.to_string(),
        ModelToolResultContent::Text(text) => text.clone(),
        ModelToolResultContent::Error { kind, message } => {
            json!({"error": {"kind": kind, "message": message}}).to_string()
        }
    }
}

fn parse_openai_response(value: Value) -> Result<ModelResponse, ModelError> {
    let output = value
        .get("output")
        .and_then(Value::as_array)
        .ok_or_else(protocol_error)?;
    let usage = value.get("usage").map(|usage| ModelUsage {
        input_tokens: u64_field(usage, "input_tokens"),
        cached_input_tokens: usage
            .pointer("/input_tokens_details/cached_tokens")
            .and_then(Value::as_u64),
        output_tokens: u64_field(usage, "output_tokens"),
        reasoning_output_tokens: usage
            .pointer("/output_tokens_details/reasoning_tokens")
            .and_then(Value::as_u64),
        total_tokens: u64_field(usage, "total_tokens"),
    });
    let provider_context = ProviderContextEnvelope::new_with_replay_tokens(
        ProviderWireApi::OpenAiResponses,
        value
            .get("id")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        serde_json::to_vec(output).map_err(|_| protocol_error())?,
        usage.and_then(|usage| usage.output_tokens),
    )?;
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
                    match content.get("type").and_then(Value::as_str) {
                        Some("output_text") => {
                            let text = required_string(content, "text")?;
                            push_text(&mut items, text);
                        }
                        Some("refusal") => {
                            let text = required_string(content, "refusal")?;
                            push_text(&mut items, text);
                        }
                        _ => {
                            return Err(ModelError::new(ModelErrorKind::UnsupportedOutput, false));
                        }
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
            Some("reasoning") => {}
            _ => {
                return Err(ModelError::new(ModelErrorKind::UnsupportedOutput, false));
            }
        }
    }
    if items.is_empty() {
        return Err(ModelError::new(ModelErrorKind::Incomplete, false));
    }
    Ok(ModelResponse {
        output: items,
        usage,
        terminal: ModelTerminalMetadata {
            finish_reason: openai_finish_reason(&value),
            provider_request_id: value
                .get("id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            continuation: if output
                .iter()
                .any(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
            {
                ModelContinuation::ToolCalls
            } else {
                ModelContinuation::Complete
            },
        },
        provider_context: Some(provider_context),
    })
}

fn openai_finish_reason(value: &Value) -> ModelFinishReason {
    match value.get("status").and_then(Value::as_str) {
        Some("completed") => ModelFinishReason::Stop,
        Some("incomplete") => match value
            .pointer("/incomplete_details/reason")
            .and_then(Value::as_str)
        {
            Some("max_output_tokens") => ModelFinishReason::MaxTokens,
            Some(reason) => ModelFinishReason::Unknown(reason.to_owned()),
            None => ModelFinishReason::Unknown("incomplete".to_owned()),
        },
        Some(status) => ModelFinishReason::Unknown(status.to_owned()),
        // This parser is reached only from a `response.completed` event. Some
        // compatible gateways omit the redundant inner status, so the outer
        // terminal event remains sufficient evidence of normal completion.
        None => ModelFinishReason::Stop,
    }
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
        StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY | StatusCode::PAYLOAD_TOO_LARGE
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
        413 => ModelError::new(ModelErrorKind::ProviderRequestTooLarge, false),
        429 => ModelError::new(ModelErrorKind::RateLimited, true),
        400..=499 => ModelError::new(ModelErrorKind::InvalidRequest, false),
        500..=599 => ModelError::new(ModelErrorKind::Server, true),
        _ => ModelError::new(ModelErrorKind::Server, false),
    }
}

fn protocol_error() -> ModelError {
    ModelError::new(ModelErrorKind::Protocol, false)
}

fn provider_request_id(headers: &HeaderMap) -> Option<String> {
    ["x-request-id", "request-id", "x-goog-request-id"]
        .into_iter()
        .find_map(|name| header_text(headers, name))
}

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned)
}

fn provider_error_code(body: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(body).ok()?;
    ["/error/code", "/error/type", "/error/status", "/type"]
        .into_iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ModelAssetRef;
    use crate::ModelToolDefinition;
    use crate::ModelToolResult;

    fn tool_names() -> BTreeMap<String, String> {
        BTreeMap::from([("workspace_read".to_owned(), "workspace/read".to_owned())])
    }

    fn continuation_message(wire_api: ProviderWireApi, payload: Value) -> ModelMessage {
        ModelMessage {
            role: ModelRole::Assistant,
            content: vec![ModelContentPart::ProviderContext(
                ProviderContextEnvelope::new(
                    wire_api,
                    Some("response_fixture".to_owned()),
                    serde_json::to_vec(&payload).expect("context payload"),
                )
                .expect("provider context"),
            )],
        }
    }

    fn continuation_request(messages: Vec<ModelMessage>) -> ModelRequest {
        ModelRequest {
            model: "fixture-model".to_owned(),
            instructions: Vec::new(),
            messages,
            tools: Vec::new(),
        }
    }

    fn request_with_strict_and_loose_tools() -> ModelRequest {
        let mut request = continuation_request(Vec::new());
        request.tools = vec![
            ModelToolDefinition {
                name: "strict_tool".to_owned(),
                description: "strict".to_owned(),
                parameters: json!({
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                    "additionalProperties": false
                }),
            },
            ModelToolDefinition {
                name: "loose_tool".to_owned(),
                description: "loose".to_owned(),
                parameters: json!({
                    "type": "object",
                    "properties": {"path": {"type": "string"}}
                }),
            },
        ];
        request
    }

    fn asset(media_type: &str, original_name: &str, bytes: &[u8]) -> ModelAssetRef {
        ModelAssetRef {
            asset_id: format!("ast_{}", "a".repeat(64)),
            sha256: "a".repeat(64),
            media_type: media_type.to_owned(),
            original_name: original_name.to_owned(),
            size_bytes: bytes.len() as u64,
            bytes: bytes.to_vec(),
        }
    }

    #[test]
    fn native_wire_apis_encode_image_and_pdf_parts() {
        let request = continuation_request(vec![ModelMessage {
            role: ModelRole::User,
            content: vec![
                ModelContentPart::Text {
                    phase: ModelTextPhase::Final,
                    text: "inspect".to_owned(),
                },
                ModelContentPart::ImageAsset(asset("image/png", "image.png", b"png")),
                ModelContentPart::PdfDocument(asset("application/pdf", "document.pdf", b"pdf")),
            ],
        }]);

        let responses = openai_request(&request, ModelStrictToolsMode::Auto, true, 1024)
            .expect("Responses request");
        assert_eq!(responses["input"][0]["content"][1]["type"], "input_image");
        assert_eq!(responses["input"][0]["content"][2]["type"], "input_file");

        let anthropic = anthropic_request(&request, ModelStrictToolsMode::Auto, 1024)
            .expect("Anthropic request");
        assert_eq!(anthropic["messages"][0]["content"][1]["type"], "image");
        assert_eq!(anthropic["messages"][0]["content"][2]["type"], "document");
        assert_eq!(
            anthropic["messages"][0]["content"][2]["source"]["data"],
            "cGRm"
        );

        let gemini =
            gemini_request(&request, ModelStrictToolsMode::Auto, 1024).expect("Gemini request");
        assert_eq!(
            gemini["contents"][0]["parts"][1]["inlineData"]["mimeType"],
            "image/png"
        );
        assert_eq!(
            gemini["contents"][0]["parts"][2]["inlineData"]["mimeType"],
            "application/pdf"
        );
    }

    #[test]
    fn strict_auto_is_resolved_per_tool_and_enabled_rejects_before_io() {
        let request = request_with_strict_and_loose_tools();
        let openai = openai_request(&request, ModelStrictToolsMode::Auto, true, 1024)
            .expect("OpenAI auto request");
        assert_eq!(openai["tools"][0]["strict"], true);
        assert_eq!(openai["tools"][1]["strict"], false);

        let anthropic = anthropic_request(&request, ModelStrictToolsMode::Auto, 1024)
            .expect("Anthropic auto request");
        assert_eq!(anthropic["tools"][0]["strict"], true);
        assert_eq!(anthropic["tools"][1]["strict"], false);

        let error = openai_request(&request, ModelStrictToolsMode::Enabled, true, 1024)
            .expect_err("strict enabled must reject the loose tool");
        assert_eq!(error.tool_name(), Some("loose_tool"));
        assert!(error.schema_reason().is_some());
    }

    #[test]
    fn openai_responses_replays_encrypted_reasoning_and_output_items_in_order() {
        let raw_output = json!([
            {
                "type": "reasoning",
                "id": "reasoning_1",
                "encrypted_content": "opaque-encrypted-reasoning"
            },
            {
                "type": "function_call",
                "call_id": "call_1",
                "name": "workspace_read",
                "arguments": "{\"path\":\"README.md\"}"
            }
        ]);
        let request = continuation_request(vec![
            continuation_message(ProviderWireApi::OpenAiResponses, raw_output.clone()),
            ModelMessage::tool_results(vec![ModelToolResult::from_serialized(
                "call_1".to_owned(),
                "contents".to_owned(),
            )]),
        ]);

        let body =
            openai_request(&request, ModelStrictToolsMode::Auto, true, 1024).expect("request");
        let input = body["input"].as_array().expect("input items");
        assert_eq!(&input[..2], raw_output.as_array().expect("raw output"));
        assert_eq!(body["input"][2]["type"], "function_call_output");
        assert_eq!(body["input"][2]["call_id"], "call_1");
        assert_eq!(body["store"], false);
        assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
    }

    #[test]
    fn provider_managed_responses_uses_previous_response_id_and_only_sends_tail() {
        let request = continuation_request(vec![
            ModelMessage::user_text("original task".to_owned()),
            continuation_message(
                ProviderWireApi::OpenAiResponses,
                json!([{"type": "reasoning", "encrypted_content": "opaque"}]),
            ),
            ModelMessage::tool_results(vec![ModelToolResult::from_serialized(
                "call_1".to_owned(),
                "contents".to_owned(),
            )]),
        ]);

        let body =
            openai_provider_managed_request(&request, ModelStrictToolsMode::Auto, true, 1024)
                .expect("provider-managed request");
        assert_eq!(body["store"], true);
        assert_eq!(body["previous_response_id"], "response_fixture");
        assert_eq!(body["input"].as_array().map(Vec::len), Some(1));
        assert_eq!(body["input"][0]["type"], "function_call_output");
        assert!(!body.to_string().contains("opaque"));
        assert!(!body.to_string().contains("original task"));
    }

    #[test]
    fn anthropic_replays_thinking_signatures_and_block_order() {
        let raw_blocks = json!([
            {
                "type": "thinking",
                "thinking": "private chain",
                "signature": "opaque-signature"
            },
            {"type": "redacted_thinking", "data": "opaque-redacted"},
            {
                "type": "tool_use",
                "id": "call_1",
                "name": "workspace_read",
                "input": {"path": "README.md"}
            }
        ]);
        let request = continuation_request(vec![
            continuation_message(ProviderWireApi::AnthropicMessages, raw_blocks.clone()),
            ModelMessage::tool_results(vec![ModelToolResult::from_serialized(
                "call_1".to_owned(),
                "contents".to_owned(),
            )]),
        ]);

        let body = anthropic_request(&request, ModelStrictToolsMode::Auto, 1024).expect("request");
        assert_eq!(body["messages"][0]["role"], "assistant");
        assert_eq!(body["messages"][0]["content"], raw_blocks);
        assert_eq!(body["messages"][1]["content"][0]["tool_use_id"], "call_1");
    }

    #[test]
    fn gemini_replays_thought_signatures_and_groups_parallel_function_responses() {
        let raw_content = json!({
            "role": "model",
            "parts": [
                {"text": "private thought", "thought": true, "thoughtSignature": "sig-1"},
                {"functionCall": {"id": "call_1", "name": "workspace_read", "args": {"path": "a.md"}}},
                {"functionCall": {"id": "call_2", "name": "workspace_read", "args": {"path": "b.md"}}}
            ]
        });
        let request = continuation_request(vec![
            continuation_message(ProviderWireApi::GeminiGenerateContent, raw_content.clone()),
            ModelMessage::tool_results(vec![
                ModelToolResult::from_serialized("call_1".to_owned(), "a".to_owned()),
                ModelToolResult::from_serialized("call_2".to_owned(), "b".to_owned()),
            ]),
        ]);

        let body = gemini_request(&request, ModelStrictToolsMode::Auto, 1024).expect("request");
        assert_eq!(body["contents"][0], raw_content);
        assert_eq!(body["contents"][1]["role"], "user");
        let responses = body["contents"][1]["parts"]
            .as_array()
            .expect("parallel responses");
        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0]["functionResponse"]["id"], "call_1");
        assert_eq!(responses[0]["functionResponse"]["name"], "workspace_read");
        assert_eq!(responses[1]["functionResponse"]["id"], "call_2");
        assert_eq!(responses[1]["functionResponse"]["name"], "workspace_read");
    }

    #[test]
    fn provider_context_cannot_cross_wire_apis() {
        let request = continuation_request(vec![continuation_message(
            ProviderWireApi::AnthropicMessages,
            json!([]),
        )]);
        let error = openai_request(&request, ModelStrictToolsMode::Auto, true, 1024)
            .expect_err("wire mismatch");
        assert_eq!(error.kind(), ModelErrorKind::InvalidRequest);
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
        assert_eq!(response.terminal.finish_reason, ModelFinishReason::Stop);
    }

    #[tokio::test]
    async fn openai_sse_ignores_optional_response_progress_events() {
        let (sender, _receiver) = mpsc::channel(4);

        for event_name in [
            "response.output_text.annotation.added",
            "response.refusal.delta",
            "response.code_interpreter_call.in_progress",
            "response.future_progress_event",
        ] {
            assert!(matches!(
                consume_openai_event(event_name, json!({}), &sender, &tool_names())
                    .await
                    .expect("optional progress event"),
                StreamProgress::Continue
            ));
        }

        let Err(error) =
            consume_openai_event("message", json!({"choices": []}), &sender, &tool_names()).await
        else {
            panic!("a Chat Completions chunk is not a Responses event");
        };
        assert_eq!(error.kind(), ModelErrorKind::UnsupportedOutput);
    }

    #[test]
    fn openai_completed_response_preserves_visible_refusals() {
        let response = parse_openai_response(json!({
            "id": "resp_refusal",
            "status": "completed",
            "output": [{
                "type": "message",
                "content": [{"type": "refusal", "refusal": "I cannot help with that."}]
            }]
        }))
        .expect("visible refusal");

        assert!(matches!(
            &response.output[0].kind,
            ModelOutputItemKind::AssistantText {
                phase: ModelTextPhase::Final,
                text,
            } if text == "I cannot help with that."
        ));
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
        assert_eq!(
            openai_request(&request, ModelStrictToolsMode::Auto, true, 4096)
                .expect("OpenAI request")["stream"],
            true
        );
        assert_eq!(
            anthropic_request(&request, ModelStrictToolsMode::Auto, 4096)
                .expect("Anthropic request")["stream"],
            true
        );
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
