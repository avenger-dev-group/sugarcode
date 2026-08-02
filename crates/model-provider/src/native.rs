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

mod requests;
mod streaming;

use requests::anthropic_request;
use requests::gemini_request;
use requests::openai_provider_managed_request;
use requests::openai_request;
use streaming::AnthropicStreamState;
use streaming::GeminiStreamState;
use streaming::OpenAiStreamState;

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
    OpenAi(OpenAiStreamState),
    Anthropic(AnthropicStreamState),
    Gemini(GeminiStreamState),
}

impl NativeStreamState {
    fn new(protocol: NativeProtocol, parallel_tools: bool) -> Self {
        match protocol {
            NativeProtocol::OpenAiResponses => Self::OpenAi(OpenAiStreamState::default()),
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
            Self::OpenAi(state) => state.consume(event_name, value, sender, tool_names).await,
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
            Self::OpenAi(_) => Err(ModelError::new(ModelErrorKind::Disconnected, true)),
            Self::Anthropic(state) => state.response(tool_names),
            Self::Gemini(state) => state.response(),
        }
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
        provider_context: Some(Box::new(provider_context)),
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
#[path = "native/tests/mod.rs"]
mod tests;
