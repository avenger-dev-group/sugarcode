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
use reqwest::header::HeaderValue;
use reqwest::header::RETRY_AFTER;
use serde::Deserialize;
use serde::Serialize;
use serde::de::MapAccess;
use serde::de::SeqAccess;
use serde::de::Visitor;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::fmt;
use std::io;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use url::Url;
use zeroize::Zeroizing;

const MODEL_STREAM_CAPACITY: usize = 16;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MODEL_STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const ERROR_BODY_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_ERROR_RESPONSE_BYTES: usize = 16 * 1024;
const MAX_SSE_EVENT_BYTES: usize = crate::MAX_PROVIDER_RESPONSE_BYTES;
const MAX_TOOL_CALL_ID_BYTES: usize = 128;
const MAX_TOOL_NAME_BYTES: usize = 128;
const MAX_TOOL_ARGUMENT_BYTES: usize = 32 * 1024;
const MAX_ACCUMULATED_SEMANTIC_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_TOOL_COMMENTARY_BYTES: usize = 512;
const MAX_OUTPUT_TEXT_BYTES: usize = 512 * 1024;
static COMPATIBLE_TOOL_CALL_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub struct OpenAiChatCompletionsProvider {
    client: reqwest::Client,
    endpoint: Url,
    token: Option<Zeroizing<String>>,
    strict_tools: ModelStrictToolsMode,
    parallel_tools: bool,
}

impl OpenAiChatCompletionsProvider {
    pub fn new(endpoint: Url, token: Option<String>) -> Result<Self, ModelError> {
        Self::new_secret(endpoint, token.map(Zeroizing::new))
    }

    pub fn new_secret(endpoint: Url, token: Option<Zeroizing<String>>) -> Result<Self, ModelError> {
        Self::new_secret_with_capabilities(endpoint, token, ModelStrictToolsMode::Disabled, false)
    }

    pub fn new_secret_with_capabilities(
        endpoint: Url,
        token: Option<Zeroizing<String>>,
        strict_tools: ModelStrictToolsMode,
        parallel_tools: bool,
    ) -> Result<Self, ModelError> {
        validate_endpoint(&endpoint)?;
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| ModelError::new(ModelErrorKind::Transport, true))?;
        Ok(Self {
            client,
            endpoint,
            token: token.filter(|token| !token.is_empty()),
            strict_tools,
            parallel_tools,
        })
    }
}

impl fmt::Debug for OpenAiChatCompletionsProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenAiChatCompletionsProvider")
            .field("endpoint", &"<redacted>")
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl ModelProvider for OpenAiChatCompletionsProvider {
    fn stream(&self, request: ModelRequest) -> BoxModelFuture<'_> {
        async move {
            let (request, tool_names) = crate::tool_names::normalize_request(request).into_parts();
            let body =
                ChatRequest::from_model_request(request, self.strict_tools, self.parallel_tools)?;
            let allow_tools = !body.tools.is_empty();
            let mut builder = self.client.post(self.endpoint.clone()).json(&body);
            if let Some(token) = &self.token {
                let encoded = Zeroizing::new(format!("Bearer {}", token.as_str()));
                let mut value = HeaderValue::from_str(encoded.as_str())
                    .map_err(|_| ModelError::new(ModelErrorKind::Authentication, false))?;
                value.set_sensitive(true);
                builder = builder.header(AUTHORIZATION, value);
            }
            let response = builder.send().await.map_err(map_reqwest_error)?;
            if !response.status().is_success() {
                return Err(map_error_response(response).await);
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

            let (sender, receiver) = mpsc::channel(MODEL_STREAM_CAPACITY);
            tokio::spawn(process_stream(response, sender, allow_tools, tool_names));
            Ok(ReceiverStream::new(receiver).boxed())
        }
        .boxed()
    }

    fn retry_after_no_output(&self, request: ModelRequest) -> BoxModelFuture<'_> {
        async move {
            let (request, tool_names) = crate::tool_names::normalize_request(request).into_parts();
            let mut body =
                ChatRequest::from_model_request(request, self.strict_tools, self.parallel_tools)?;
            body.stream = false;
            let allow_tools = !body.tools.is_empty();
            let mut builder = self.client.post(self.endpoint.clone()).json(&body);
            if let Some(token) = &self.token {
                let encoded = Zeroizing::new(format!("Bearer {}", token.as_str()));
                let mut value = HeaderValue::from_str(encoded.as_str())
                    .map_err(|_| ModelError::new(ModelErrorKind::Authentication, false))?;
                value.set_sensitive(true);
                builder = builder.header(AUTHORIZATION, value);
            }
            let response = builder.send().await.map_err(map_reqwest_error)?;
            if !response.status().is_success() {
                return Err(map_error_response(response).await);
            }

            let (sender, receiver) = mpsc::channel(MODEL_STREAM_CAPACITY);
            tokio::spawn(process_non_stream_response(
                response,
                sender,
                allow_tools,
                tool_names,
            ));
            Ok(ReceiverStream::new(receiver).boxed())
        }
        .boxed()
    }
}

fn validate_endpoint(endpoint: &Url) -> Result<(), ModelError> {
    let valid = matches!(endpoint.scheme(), "http" | "https")
        && endpoint.host_str().is_some()
        && endpoint.username().is_empty()
        && endpoint.password().is_none()
        && endpoint.query().is_none()
        && endpoint.fragment().is_none()
        && endpoint.path().ends_with("/chat/completions");
    if valid {
        Ok(())
    } else {
        Err(ModelError::new(ModelErrorKind::InvalidRequest, false))
    }
}

async fn process_stream(
    response: reqwest::Response,
    sender: mpsc::Sender<Result<ModelEvent, ModelError>>,
    allow_tools: bool,
    tool_names: BTreeMap<String, String>,
) {
    let provider_request_id = ["x-request-id", "request-id"]
        .into_iter()
        .find_map(|name| response.headers().get(name))
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned);
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
    let mut finish = None;
    let mut usage: Option<ModelUsage> = None;
    let mut output_text = String::new();
    let mut reasoning = ChatReasoningState::default();
    let mut semantic_output_bytes = 0usize;
    let mut tool_assemblers = BTreeMap::<u64, ToolCallAssembler>::new();
    let mut saw_unsupported_output = false;
    loop {
        let next = tokio::select! {
            _ = sender.closed() => return,
            next = tokio::time::timeout(MODEL_STREAM_IDLE_TIMEOUT, stream.next()) => next,
        };
        let next = match next {
            Ok(next) => next,
            Err(_) => {
                let retryable = reasoning.is_empty() && tool_assemblers.is_empty();
                send_error(&sender, ModelError::new(ModelErrorKind::Timeout, retryable)).await;
                return;
            }
        };
        let event = match next {
            None => {
                let finish = match finish.take() {
                    Some(finish) => finish,
                    None if output_text.is_empty()
                        && tool_assemblers.is_empty()
                        && reasoning.is_empty() =>
                    {
                        send_error(&sender, ModelError::new(ModelErrorKind::Disconnected, true))
                            .await;
                        return;
                    }
                    None => match infer_chat_finish(
                        allow_tools,
                        saw_unsupported_output,
                        &mut tool_assemblers,
                        &output_text,
                    ) {
                        Ok(finish) => finish,
                        Err(error) => {
                            send_error(&sender, error).await;
                            return;
                        }
                    },
                };
                complete_chat_stream(
                    &sender,
                    finish,
                    output_text,
                    reasoning,
                    usage,
                    provider_request_id,
                    &tool_names,
                )
                .await;
                return;
            }
            Some(Err(error)) => {
                let retryable = reasoning.is_empty() && tool_assemblers.is_empty();
                let error = match error {
                    EventStreamError::Transport(error)
                        if error.kind() != io::ErrorKind::InvalidData =>
                    {
                        ModelError::new(ModelErrorKind::Disconnected, retryable)
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
                        ModelError::new(ModelErrorKind::Disconnected, retryable)
                    }
                };
                send_error(&sender, error).await;
                return;
            }
            Some(Ok(event)) => event,
        };
        if event.data == "[DONE]" {
            let finish = match finish.take() {
                Some(finish) => Ok(finish),
                None => infer_chat_finish(
                    allow_tools,
                    saw_unsupported_output,
                    &mut tool_assemblers,
                    &output_text,
                ),
            };
            let finish = match finish {
                Ok(finish) => finish,
                Err(error) => {
                    send_error(&sender, error).await;
                    return;
                }
            };
            complete_chat_stream(
                &sender,
                finish,
                output_text,
                reasoning,
                usage,
                provider_request_id,
                &tool_names,
            )
            .await;
            return;
        }
        let chunk = match serde_json::from_str::<ChatChunk>(&event.data) {
            Ok(chunk) => chunk,
            Err(_) => {
                send_error(&sender, ModelError::new(ModelErrorKind::Protocol, false)).await;
                return;
            }
        };
        if chunk.error.is_some() {
            let retryable = reasoning.is_empty() && tool_assemblers.is_empty();
            send_error(&sender, ModelError::new(ModelErrorKind::Server, retryable)).await;
            return;
        }
        if finish.is_some() {
            let Some(chunk_usage) = chunk.usage else {
                send_error(&sender, ModelError::new(ModelErrorKind::Protocol, false)).await;
                return;
            };
            if !merge_usage(&mut usage, chunk_usage) || !is_usage_only_choices(&chunk.choices) {
                send_error(&sender, ModelError::new(ModelErrorKind::Protocol, false)).await;
                return;
            }
            continue;
        }
        if let Some(chunk_usage) = chunk.usage
            && !merge_usage(&mut usage, chunk_usage)
        {
            send_error(&sender, ModelError::new(ModelErrorKind::Protocol, false)).await;
            return;
        }
        if chunk.choices.iter().any(|choice| choice.index != 0) {
            send_error(&sender, ModelError::new(ModelErrorKind::Protocol, false)).await;
            return;
        }
        for mut choice in chunk.choices {
            if choice.delta.has_protocol_violation() {
                send_error(&sender, ModelError::new(ModelErrorKind::Protocol, false)).await;
                return;
            }
            saw_unsupported_output |= choice.delta.has_unsupported_output(allow_tools);
            for (value, target) in [
                (
                    choice.delta.reasoning_content.take(),
                    &mut reasoning.content,
                ),
                (choice.delta.reasoning.take(), &mut reasoning.reasoning),
            ] {
                let Some(value) = value else {
                    continue;
                };
                let Some(fragment) = value.as_str() else {
                    send_error(
                        &sender,
                        ModelError::new(ModelErrorKind::UnsupportedOutput, false),
                    )
                    .await;
                    return;
                };
                semantic_output_bytes = match semantic_output_bytes.checked_add(fragment.len()) {
                    Some(bytes) if bytes <= MAX_ACCUMULATED_SEMANTIC_OUTPUT_BYTES => bytes,
                    _ => {
                        send_error(
                            &sender,
                            ModelError::new(ModelErrorKind::OutputTooLarge, false),
                        )
                        .await;
                        return;
                    }
                };
                target.push_str(fragment);
            }
            if let Some(details) = choice.delta.reasoning_details.take() {
                let details_bytes =
                    serde_json::to_vec(&details).map_or(usize::MAX, |value| value.len());
                semantic_output_bytes = match semantic_output_bytes.checked_add(details_bytes) {
                    Some(bytes) if bytes <= MAX_ACCUMULATED_SEMANTIC_OUTPUT_BYTES => bytes,
                    _ => {
                        send_error(
                            &sender,
                            ModelError::new(ModelErrorKind::OutputTooLarge, false),
                        )
                        .await;
                        return;
                    }
                };
                match details {
                    serde_json::Value::Array(values) => reasoning.details.extend(values),
                    value => reasoning.details.push(value),
                }
            }
            if let Some(content) = choice.delta.content
                && !content.is_empty()
            {
                semantic_output_bytes = match semantic_output_bytes.checked_add(content.len()) {
                    Some(bytes) if bytes <= MAX_ACCUMULATED_SEMANTIC_OUTPUT_BYTES => bytes,
                    _ => {
                        send_error(
                            &sender,
                            ModelError::new(ModelErrorKind::OutputTooLarge, false),
                        )
                        .await;
                        return;
                    }
                };
                if output_text
                    .len()
                    .checked_add(content.len())
                    .is_none_or(|bytes| bytes > MAX_OUTPUT_TEXT_BYTES)
                {
                    send_error(
                        &sender,
                        ModelError::new(ModelErrorKind::OutputTooLarge, false),
                    )
                    .await;
                    return;
                }
                output_text.push_str(&content);
                if sender
                    .send(Ok(ModelEvent::OutputTextDelta {
                        output_index: 0,
                        delta: content,
                    }))
                    .await
                    .is_err()
                {
                    return;
                }
            }
            if let Some(tool_calls) = choice.delta.tool_calls
                && !tool_calls.is_empty()
            {
                for tool_call in tool_calls {
                    semantic_output_bytes = match tool_call
                        .accumulated_bytes()
                        .and_then(|bytes| semantic_output_bytes.checked_add(bytes))
                    {
                        Some(bytes) if bytes <= MAX_ACCUMULATED_SEMANTIC_OUTPUT_BYTES => bytes,
                        _ => {
                            send_error(
                                &sender,
                                ModelError::new(ModelErrorKind::OutputTooLarge, false),
                            )
                            .await;
                            return;
                        }
                    };
                    let assembler = tool_assemblers.entry(tool_call.index).or_default();
                    if let Err(error) = assembler.push(tool_call) {
                        send_error(&sender, error).await;
                        return;
                    }
                }
            }
            if let Some(reason) = choice.finish_reason.as_deref() {
                match reason {
                    "stop" if tool_assemblers.is_empty() => {
                        finish = Some(if saw_unsupported_output {
                            ChatFinish::Unsupported
                        } else {
                            ChatFinish::Final
                        });
                    }
                    "length" => {
                        finish = Some(ChatFinish::Incomplete);
                    }
                    "content_filter" => {
                        finish = Some(ChatFinish::Filtered);
                    }
                    "tool_calls" | "stop" => {
                        if tool_assemblers.is_empty() {
                            if allow_tools {
                                send_error(
                                    &sender,
                                    ModelError::new(ModelErrorKind::Protocol, false),
                                )
                                .await;
                                return;
                            }
                            finish = Some(ChatFinish::Unsupported);
                            continue;
                        }
                        let assemblers = std::mem::take(&mut tool_assemblers);
                        let calls = assemblers
                            .into_iter()
                            .map(|(index, assembler)| assembler.finish(index))
                            .collect::<Result<Vec<_>, _>>();
                        match calls {
                            Ok(calls) => {
                                let has_unsupported_tool_kind = calls.iter().any(Option::is_none);
                                let calls = calls.into_iter().flatten().collect::<Vec<_>>();
                                finish = Some(
                                    if !allow_tools
                                        || saw_unsupported_output
                                        || has_unsupported_tool_kind
                                    {
                                        ChatFinish::Unsupported
                                    } else {
                                        ChatFinish::ToolCalls(calls)
                                    },
                                );
                            }
                            Err(error) => {
                                send_error(&sender, error).await;
                                return;
                            }
                        }
                    }
                    "function_call" => {
                        finish = Some(ChatFinish::Unsupported);
                    }
                    _ => {
                        send_error(&sender, ModelError::new(ModelErrorKind::Protocol, false)).await;
                        return;
                    }
                }
            }
        }
    }
}

async fn process_non_stream_response(
    response: reqwest::Response,
    sender: mpsc::Sender<Result<ModelEvent, ModelError>>,
    allow_tools: bool,
    tool_names: BTreeMap<String, String>,
) {
    let provider_request_id = ["x-request-id", "request-id"]
        .into_iter()
        .find_map(|name| response.headers().get(name))
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned);
    let body = match bounded_success_body(response).await {
        Ok(body) => body,
        Err(error) => {
            send_error(&sender, error).await;
            return;
        }
    };
    let completion = match serde_json::from_slice::<ChatCompletion>(&body) {
        Ok(completion) => completion,
        Err(_) => {
            send_error(&sender, ModelError::new(ModelErrorKind::Protocol, false)).await;
            return;
        }
    };
    if completion.error.is_some() || completion.choices.len() != 1 {
        send_error(&sender, ModelError::new(ModelErrorKind::Protocol, false)).await;
        return;
    }
    let mut choice = completion
        .choices
        .into_iter()
        .next()
        .expect("choice length checked");
    if choice.index != 0 || choice.message.has_protocol_violation() {
        send_error(&sender, ModelError::new(ModelErrorKind::Protocol, false)).await;
        return;
    }
    let saw_unsupported_output = choice.message.has_unsupported_output(allow_tools);
    let mut semantic_output_bytes = 0usize;
    let mut reasoning = ChatReasoningState::default();
    for (value, target) in [
        (
            choice.message.reasoning_content.take(),
            &mut reasoning.content,
        ),
        (choice.message.reasoning.take(), &mut reasoning.reasoning),
    ] {
        let Some(value) = value else {
            continue;
        };
        let Some(fragment) = value.as_str() else {
            send_error(
                &sender,
                ModelError::new(ModelErrorKind::UnsupportedOutput, false),
            )
            .await;
            return;
        };
        semantic_output_bytes = match semantic_output_bytes.checked_add(fragment.len()) {
            Some(bytes) if bytes <= MAX_ACCUMULATED_SEMANTIC_OUTPUT_BYTES => bytes,
            _ => {
                send_error(
                    &sender,
                    ModelError::new(ModelErrorKind::OutputTooLarge, false),
                )
                .await;
                return;
            }
        };
        target.push_str(fragment);
    }
    if let Some(details) = choice.message.reasoning_details.take() {
        let details_bytes = serde_json::to_vec(&details).map_or(usize::MAX, |value| value.len());
        semantic_output_bytes = match semantic_output_bytes.checked_add(details_bytes) {
            Some(bytes) if bytes <= MAX_ACCUMULATED_SEMANTIC_OUTPUT_BYTES => bytes,
            _ => {
                send_error(
                    &sender,
                    ModelError::new(ModelErrorKind::OutputTooLarge, false),
                )
                .await;
                return;
            }
        };
        match details {
            serde_json::Value::Array(values) => reasoning.details.extend(values),
            value => reasoning.details.push(value),
        }
    }
    let output_text = choice.message.content.take().unwrap_or_default();
    if output_text.len() > MAX_OUTPUT_TEXT_BYTES
        || semantic_output_bytes
            .checked_add(output_text.len())
            .is_none_or(|bytes| bytes > MAX_ACCUMULATED_SEMANTIC_OUTPUT_BYTES)
    {
        send_error(
            &sender,
            ModelError::new(ModelErrorKind::OutputTooLarge, false),
        )
        .await;
        return;
    }

    let mut tool_assemblers = BTreeMap::<u64, ToolCallAssembler>::new();
    if let Some(tool_calls) = choice.message.tool_calls.take() {
        for (index, mut tool_call) in tool_calls.into_iter().enumerate() {
            let index = match u64::try_from(index) {
                Ok(index) => index,
                Err(_) => {
                    send_error(
                        &sender,
                        ModelError::new(ModelErrorKind::OutputTooLarge, false),
                    )
                    .await;
                    return;
                }
            };
            tool_call.index = index;
            semantic_output_bytes = match tool_call
                .accumulated_bytes()
                .and_then(|bytes| semantic_output_bytes.checked_add(bytes))
            {
                Some(bytes) if bytes <= MAX_ACCUMULATED_SEMANTIC_OUTPUT_BYTES => bytes,
                _ => {
                    send_error(
                        &sender,
                        ModelError::new(ModelErrorKind::OutputTooLarge, false),
                    )
                    .await;
                    return;
                }
            };
            if let Err(error) = tool_assemblers.entry(index).or_default().push(tool_call) {
                send_error(&sender, error).await;
                return;
            }
        }
    }
    let finish = match finish_chat_response(
        choice.finish_reason.as_deref(),
        allow_tools,
        saw_unsupported_output,
        &mut tool_assemblers,
        &output_text,
    ) {
        Ok(finish) => finish,
        Err(error) => {
            send_error(&sender, error).await;
            return;
        }
    };
    if !output_text.is_empty()
        && sender
            .send(Ok(ModelEvent::OutputTextDelta {
                output_index: 0,
                delta: output_text.clone(),
            }))
            .await
            .is_err()
    {
        return;
    }
    complete_chat_stream(
        &sender,
        finish,
        output_text,
        reasoning,
        completion.usage.map(ModelUsage::from),
        provider_request_id,
        &tool_names,
    )
    .await;
}

fn finish_chat_response(
    finish_reason: Option<&str>,
    allow_tools: bool,
    saw_unsupported_output: bool,
    tool_assemblers: &mut BTreeMap<u64, ToolCallAssembler>,
    output_text: &str,
) -> Result<ChatFinish, ModelError> {
    match finish_reason {
        None => infer_chat_finish(
            allow_tools,
            saw_unsupported_output,
            tool_assemblers,
            output_text,
        ),
        Some("stop") if tool_assemblers.is_empty() => Ok(if saw_unsupported_output {
            ChatFinish::Unsupported
        } else {
            ChatFinish::Final
        }),
        Some("tool_calls" | "stop") => {
            if tool_assemblers.is_empty() {
                return Ok(ChatFinish::Unsupported);
            }
            let assemblers = std::mem::take(tool_assemblers);
            let calls = assemblers
                .into_iter()
                .map(|(index, assembler)| assembler.finish(index))
                .collect::<Result<Vec<_>, _>>()?;
            if !allow_tools || saw_unsupported_output || calls.iter().any(Option::is_none) {
                Ok(ChatFinish::Unsupported)
            } else {
                Ok(ChatFinish::ToolCalls(calls.into_iter().flatten().collect()))
            }
        }
        Some("length") => Ok(ChatFinish::Incomplete),
        Some("content_filter") => Ok(ChatFinish::Filtered),
        Some("insufficient_system_resource") => Err(ModelError::new(ModelErrorKind::Server, true)),
        Some("function_call") => Ok(ChatFinish::Unsupported),
        Some(_) => Err(ModelError::new(ModelErrorKind::Protocol, false)),
    }
}

fn infer_chat_finish(
    allow_tools: bool,
    saw_unsupported_output: bool,
    tool_assemblers: &mut BTreeMap<u64, ToolCallAssembler>,
    output_text: &str,
) -> Result<ChatFinish, ModelError> {
    if saw_unsupported_output {
        return Ok(ChatFinish::Unsupported);
    }
    if !tool_assemblers.is_empty() {
        if !allow_tools {
            return Ok(ChatFinish::Unsupported);
        }
        let assemblers = std::mem::take(tool_assemblers);
        let calls = assemblers
            .into_iter()
            .map(|(index, assembler)| assembler.finish(index))
            .collect::<Result<Vec<_>, _>>()?;
        if calls.iter().any(Option::is_none) {
            return Ok(ChatFinish::Unsupported);
        }
        return Ok(ChatFinish::ToolCalls(calls.into_iter().flatten().collect()));
    }
    if output_text
        .chars()
        .any(|character| !character.is_whitespace())
    {
        Ok(ChatFinish::Final)
    } else {
        Ok(ChatFinish::Incomplete)
    }
}

async fn complete_chat_stream(
    sender: &mpsc::Sender<Result<ModelEvent, ModelError>>,
    finish: ChatFinish,
    mut output_text: String,
    mut reasoning: ChatReasoningState,
    usage: Option<ModelUsage>,
    provider_request_id: Option<String>,
    tool_names: &BTreeMap<String, String>,
) {
    if let Some((legacy_reasoning, visible)) = split_legacy_think(&output_text) {
        if reasoning.is_empty() {
            reasoning.content = legacy_reasoning;
        }
        output_text = visible;
    }
    let portable_text = output_text.clone();
    let mut output = Vec::new();
    match finish {
        ChatFinish::Incomplete => {
            send_error(sender, ModelError::new(ModelErrorKind::Incomplete, false)).await;
            return;
        }
        ChatFinish::Filtered => {
            send_error(sender, ModelError::new(ModelErrorKind::Filtered, false)).await;
            return;
        }
        ChatFinish::Unsupported => {
            send_error(
                sender,
                ModelError::new(ModelErrorKind::UnsupportedOutput, false),
            )
            .await;
            return;
        }
        ChatFinish::Final => {
            if !output_text
                .chars()
                .any(|character| !character.is_whitespace())
            {
                send_error(sender, ModelError::new(ModelErrorKind::Incomplete, false)).await;
                return;
            }
            output.push(ModelOutputItem {
                output_index: 0,
                kind: ModelOutputItemKind::AssistantText {
                    phase: ModelTextPhase::Final,
                    text: output_text,
                },
            });
        }
        ChatFinish::ToolCalls(calls) => {
            if output_text.len() > MAX_TOOL_COMMENTARY_BYTES {
                send_error(
                    sender,
                    ModelError::new(ModelErrorKind::OutputTooLarge, false),
                )
                .await;
                return;
            }
            if !output_text.is_empty() {
                output.push(ModelOutputItem {
                    output_index: 0,
                    kind: ModelOutputItemKind::AssistantText {
                        phase: ModelTextPhase::Commentary,
                        text: output_text,
                    },
                });
            }
            for mut call in calls {
                if let Some(internal_name) = tool_names.get(&call.name) {
                    call.name.clone_from(internal_name);
                }
                let output_index = match u32::try_from(output.len()) {
                    Ok(output_index) => output_index,
                    Err(_) => {
                        send_error(
                            sender,
                            ModelError::new(ModelErrorKind::OutputTooLarge, false),
                        )
                        .await;
                        return;
                    }
                };
                output.push(ModelOutputItem {
                    output_index,
                    kind: ModelOutputItemKind::ToolCall(call),
                });
            }
        }
    }
    let continuation = if output
        .iter()
        .any(|item| matches!(item.kind, ModelOutputItemKind::ToolCall(_)))
    {
        ModelContinuation::ToolCalls
    } else {
        ModelContinuation::Complete
    };
    let raw_tool_calls = output
        .iter()
        .filter_map(|item| match &item.kind {
            ModelOutputItemKind::ToolCall(call) => Some(ChatToolCall {
                id: call.id.clone(),
                kind: "function".to_owned(),
                function: ChatFunctionCall {
                    name: tool_names
                        .iter()
                        .find_map(|(wire, internal)| (internal == &call.name).then_some(wire))
                        .unwrap_or(&call.name)
                        .clone(),
                    arguments: serde_json::to_string(&call.arguments)
                        .expect("tool arguments serialize"),
                },
            }),
            ModelOutputItemKind::AssistantText { .. } => None,
        })
        .collect::<Vec<_>>();
    let context_payload = (!reasoning.is_empty()).then(|| {
        serde_json::to_vec(&ChatMessage {
            role: "assistant".to_owned(),
            content: (!portable_text.is_empty()).then_some(ChatContent::Text(portable_text)),
            tool_calls: raw_tool_calls,
            tool_call_id: None,
            reasoning_content: (!reasoning.content.is_empty())
                .then_some(serde_json::Value::String(reasoning.content)),
            reasoning: (!reasoning.reasoning.is_empty())
                .then_some(serde_json::Value::String(reasoning.reasoning)),
            reasoning_details: (!reasoning.details.is_empty())
                .then_some(serde_json::Value::Array(reasoning.details)),
        })
        .map_err(|_| ModelError::new(ModelErrorKind::Protocol, false))
        .and_then(|payload| {
            ProviderContextEnvelope::new_with_replay_tokens(
                ProviderWireApi::OpenAiChatCompletions,
                provider_request_id.clone(),
                payload,
                usage.and_then(|usage| usage.output_tokens),
            )
        })
    });
    let provider_context = match context_payload.transpose() {
        Ok(context) => context,
        Err(error) => {
            send_error(sender, error).await;
            return;
        }
    };
    let _ = sender
        .send(Ok(ModelEvent::ResponseCompleted(ModelResponse {
            output,
            usage,
            terminal: ModelTerminalMetadata {
                finish_reason: match continuation {
                    ModelContinuation::Complete => ModelFinishReason::Stop,
                    ModelContinuation::ToolCalls => ModelFinishReason::ToolCalls,
                },
                provider_request_id,
                continuation,
            },
            provider_context: provider_context.map(Box::new),
        })))
        .await;
}

enum ChatFinish {
    Final,
    ToolCalls(Vec<ModelToolCall>),
    Incomplete,
    Filtered,
    Unsupported,
}

#[derive(Default)]
struct ChatReasoningState {
    content: String,
    reasoning: String,
    details: Vec<serde_json::Value>,
}

impl ChatReasoningState {
    fn is_empty(&self) -> bool {
        self.content.is_empty() && self.reasoning.is_empty() && self.details.is_empty()
    }
}

fn split_legacy_think(content: &str) -> Option<(String, String)> {
    let trimmed = content.trim_start_matches([' ', '\t', '\r', '\n']);
    const OPEN: &str = "<think>";
    const CLOSE: &str = "</think>";
    if trimmed.len() < OPEN.len() || !trimmed[..OPEN.len()].eq_ignore_ascii_case(OPEN) {
        return None;
    }
    let body = &trimmed[OPEN.len()..];
    let lower = body.to_ascii_lowercase();
    let close = lower.rfind(CLOSE);
    let (reasoning, visible) = match close {
        Some(index) => (&body[..index], body[index + CLOSE.len()..].trim()),
        None => (body, ""),
    };
    Some((
        reasoning
            .replace("<think>", "")
            .replace("</think>", "")
            .trim()
            .to_owned(),
        visible.to_owned(),
    ))
}

fn is_usage_only_choices(choices: &[ChatChoice]) -> bool {
    choices.is_empty()
        || matches!(
            choices,
            [choice]
                if choice.index == 0
                    && choice.finish_reason.is_none()
                    && choice.delta.is_empty()
        )
}

fn merge_usage(usage: &mut Option<ModelUsage>, chunk_usage: ChatUsage) -> bool {
    let chunk_usage = ModelUsage::from(chunk_usage);
    match usage {
        Some(current) => current == &chunk_usage,
        None => {
            *usage = Some(chunk_usage);
            true
        }
    }
}

async fn send_error(sender: &mpsc::Sender<Result<ModelEvent, ModelError>>, error: ModelError) {
    let _ = sender.send(Err(error)).await;
}

fn map_reqwest_error(error: reqwest::Error) -> ModelError {
    if error.is_timeout() {
        ModelError::new(ModelErrorKind::Timeout, true)
    } else {
        ModelError::new(ModelErrorKind::Transport, true)
    }
}

async fn map_error_response(response: reqwest::Response) -> ModelError {
    let status = response.status();
    let provider_request_id = ["x-request-id", "request-id"]
        .into_iter()
        .find_map(|name| error_header_text(response.headers(), name));
    let retry_after = error_header_text(response.headers(), RETRY_AFTER.as_str());
    let body = bounded_error_body(response).await;
    let provider_code = body.as_deref().and_then(provider_error_code);
    let context_length_exceeded = matches!(
        status,
        StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY | StatusCode::PAYLOAD_TOO_LARGE
    ) && body.as_deref().is_some_and(is_context_length_error);
    let error = if context_length_exceeded {
        ModelError::new(ModelErrorKind::ContextLengthExceeded, false)
    } else if status == StatusCode::PAYLOAD_TOO_LARGE {
        ModelError::new(ModelErrorKind::ProviderRequestTooLarge, false)
    } else {
        map_status(status)
    };
    error.with_provider_metadata(
        status.as_u16(),
        provider_code.as_deref(),
        provider_request_id.as_deref(),
        retry_after.as_deref(),
    )
}

fn error_header_text(headers: &reqwest::header::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned)
}

fn provider_error_code(body: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    ["/error/code", "/error/type", "/type"]
        .into_iter()
        .find_map(|pointer| value.pointer(pointer).and_then(serde_json::Value::as_str))
        .map(ToOwned::to_owned)
}

async fn bounded_error_body(response: reqwest::Response) -> Option<Vec<u8>> {
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    loop {
        let chunk = match tokio::time::timeout(ERROR_BODY_TIMEOUT, stream.next()).await {
            Ok(Some(Ok(chunk))) => chunk,
            Ok(None) => return Some(body),
            Ok(Some(Err(_))) | Err(_) => return None,
        };
        if body
            .len()
            .checked_add(chunk.len())
            .is_none_or(|bytes| bytes > MAX_ERROR_RESPONSE_BYTES)
        {
            return None;
        }
        body.extend_from_slice(&chunk);
        if body.len() == MAX_ERROR_RESPONSE_BYTES {
            return Some(body);
        }
    }
}

async fn bounded_success_body(response: reqwest::Response) -> Result<Vec<u8>, ModelError> {
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    loop {
        let chunk = match tokio::time::timeout(MODEL_STREAM_IDLE_TIMEOUT, stream.next()).await {
            Ok(Some(Ok(chunk))) => chunk,
            Ok(None) => return Ok(body),
            Ok(Some(Err(_))) => {
                return Err(ModelError::new(ModelErrorKind::Disconnected, true));
            }
            Err(_) => return Err(ModelError::new(ModelErrorKind::Timeout, true)),
        };
        if body
            .len()
            .checked_add(chunk.len())
            .is_none_or(|bytes| bytes > crate::MAX_PROVIDER_RESPONSE_BYTES)
        {
            return Err(ModelError::new(
                ModelErrorKind::ProviderResponseTooLarge,
                false,
            ));
        }
        body.extend_from_slice(&chunk);
    }
}

fn is_context_length_error(body: &[u8]) -> bool {
    let text = String::from_utf8_lossy(body).to_ascii_lowercase();
    [
        "context_length_exceeded",
        "maximum context length",
        "context length exceeded",
        "context window",
        "too many tokens",
        "input is too long",
        "prompt is too long",
    ]
    .iter()
    .any(|marker| text.contains(marker))
}

fn map_status(status: StatusCode) -> ModelError {
    match status.as_u16() {
        300..=399 | 400 | 404 | 409 | 422 => ModelError::new(ModelErrorKind::InvalidRequest, false),
        401 | 403 => ModelError::new(ModelErrorKind::Authentication, false),
        408 => ModelError::new(ModelErrorKind::Timeout, true),
        429 => ModelError::new(ModelErrorKind::RateLimited, true),
        500..=599 => ModelError::new(ModelErrorKind::Server, true),
        400..=499 => ModelError::new(ModelErrorKind::InvalidRequest, false),
        _ => ModelError::new(ModelErrorKind::Server, false),
    }
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    stream: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tools: Vec<ChatToolDefinition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parallel_tool_calls: Option<bool>,
}

impl ChatRequest {
    fn from_model_request(
        request: ModelRequest,
        strict_tools: ModelStrictToolsMode,
        parallel_tools: bool,
    ) -> Result<Self, ModelError> {
        let system = request
            .instructions
            .into_iter()
            .map(|instruction| instruction.rendered_content())
            .collect::<Vec<_>>()
            .join("\n\n");
        let mut messages = Vec::new();
        if !system.is_empty() {
            messages.push(ChatMessage::system(system));
        }
        messages.extend(chat_messages_from_model_messages(request.messages)?);
        let tools = request
            .tools
            .into_iter()
            .map(|tool| {
                let strict = crate::tool_schema::strict_for_tool(
                    &tool.name,
                    &tool.parameters,
                    crate::tool_schema::ToolSchemaDialect::OpenAi,
                    strict_tools,
                )?;
                Ok(ChatToolDefinition {
                    kind: "function",
                    function: ChatFunctionDefinition {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.parameters,
                        strict: (strict_tools != ModelStrictToolsMode::Disabled).then_some(strict),
                    },
                })
            })
            .collect::<Result<Vec<_>, ModelError>>()?;
        let parallel_tool_calls = (!tools.is_empty() && parallel_tools).then_some(true);
        Ok(Self {
            model: request.model,
            messages,
            stream: true,
            tools,
            parallel_tool_calls,
        })
    }
}

impl ChatMessage {
    fn system(content: String) -> Self {
        Self {
            role: "system".to_owned(),
            content: Some(ChatContent::Text(content)),
            tool_calls: Vec::new(),
            tool_call_id: None,
            reasoning_content: None,
            reasoning: None,
            reasoning_details: None,
        }
    }
}

#[derive(Deserialize, Serialize)]
struct ChatMessage {
    role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<ChatContent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tool_calls: Vec<ChatToolCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_content: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_details: Option<serde_json::Value>,
}

#[derive(Deserialize, Serialize)]
#[serde(untagged)]
enum ChatContent {
    Text(String),
    Parts(Vec<serde_json::Value>),
}

fn chat_messages_from_model_messages(
    messages: Vec<ModelMessage>,
) -> Result<Vec<ChatMessage>, ModelError> {
    let mut rendered = Vec::with_capacity(messages.len());
    for message in messages {
        if let [ModelContentPart::ProviderContext(context)] = message.content.as_slice() {
            if context.wire_api() != ProviderWireApi::OpenAiChatCompletions {
                return Err(ModelError::new(ModelErrorKind::InvalidRequest, false));
            }
            let mut restored: ChatMessage = serde_json::from_slice(&context.payload()?)
                .map_err(|_| ModelError::new(ModelErrorKind::Protocol, false))?;
            restored.role = "assistant".to_owned();
            rendered.push(restored);
            continue;
        }
        let mut text = String::new();
        let mut ordered_content = Vec::new();
        let mut has_image = false;
        let mut calls = Vec::new();
        let mut results = Vec::new();
        for part in message.content {
            match part {
                ModelContentPart::Text { text: part, .. }
                | ModelContentPart::ContextCompaction { content: part } => {
                    text.push_str(&part);
                    ordered_content.push(serde_json::json!({"type": "text", "text": part}));
                }
                ModelContentPart::ToolCall { call } => calls.push(ChatToolCall {
                    id: call.id,
                    kind: "function".to_owned(),
                    function: ChatFunctionCall {
                        name: call.name,
                        arguments: serde_json::to_string(&call.arguments)
                            .expect("tool arguments serialize"),
                    },
                }),
                ModelContentPart::ToolResult { result } => results.push(result),
                ModelContentPart::ImageAsset(asset) => {
                    has_image = true;
                    ordered_content.push(serde_json::json!({
                        "type": "image_url",
                        "image_url": {
                            "url": format!(
                                "data:{};base64,{}",
                                asset.media_type,
                                BASE64_STANDARD.encode(&asset.bytes),
                            ),
                        },
                    }));
                }
                ModelContentPart::PdfDocument(_) => {
                    return Err(ModelError::new(ModelErrorKind::InvalidRequest, false));
                }
                ModelContentPart::ProviderContext(_) => {
                    return Err(ModelError::new(ModelErrorKind::Protocol, false));
                }
            }
        }
        if !results.is_empty() {
            if !text.is_empty() || !calls.is_empty() || message.role != ModelRole::User {
                return Err(ModelError::new(ModelErrorKind::Protocol, false));
            }
            rendered.extend(results.into_iter().map(|result| ChatMessage {
                role: "tool".to_owned(),
                content: Some(ChatContent::Text(chat_tool_result_text(&result.content))),
                tool_calls: Vec::new(),
                tool_call_id: Some(result.call_id),
                reasoning_content: None,
                reasoning: None,
                reasoning_details: None,
            }));
            continue;
        }
        rendered.push(ChatMessage {
            role: match message.role {
                ModelRole::User => "user",
                ModelRole::Assistant => "assistant",
            }
            .to_owned(),
            content: if has_image {
                Some(ChatContent::Parts(ordered_content))
            } else {
                (!text.is_empty()).then_some(ChatContent::Text(text))
            },
            tool_calls: calls,
            tool_call_id: None,
            reasoning_content: None,
            reasoning: None,
            reasoning_details: None,
        });
    }
    Ok(rendered)
}

fn chat_tool_result_text(content: &ModelToolResultContent) -> String {
    match content {
        ModelToolResultContent::Json(value) => value.to_string(),
        ModelToolResultContent::Text(text) => text.clone(),
        ModelToolResultContent::Error { kind, message } => {
            serde_json::json!({"error": {"kind": kind, "message": message}}).to_string()
        }
    }
}

#[derive(Serialize)]
struct ChatToolDefinition {
    #[serde(rename = "type")]
    kind: &'static str,
    function: ChatFunctionDefinition,
}

#[derive(Serialize)]
struct ChatFunctionDefinition {
    name: String,
    description: String,
    parameters: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    strict: Option<bool>,
}

#[derive(Deserialize, Serialize)]
struct ChatToolCall {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    function: ChatFunctionCall,
}

#[derive(Deserialize, Serialize)]
struct ChatFunctionCall {
    name: String,
    arguments: String,
}

#[derive(Deserialize)]
struct ChatChunk {
    #[serde(default)]
    choices: Vec<ChatChoice>,
    usage: Option<ChatUsage>,
    error: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct ChatCompletion {
    #[serde(default)]
    choices: Vec<ChatCompletionChoice>,
    usage: Option<ChatUsage>,
    error: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct ChatCompletionChoice {
    index: u64,
    message: ChatDelta,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct ChatChoice {
    index: u64,
    #[serde(default, deserialize_with = "deserialize_nullable_chat_delta")]
    delta: ChatDelta,
    finish_reason: Option<String>,
}

fn deserialize_nullable_chat_delta<'de, D>(deserializer: D) -> Result<ChatDelta, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<ChatDelta>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Default, Deserialize)]
struct ChatDelta {
    content: Option<String>,
    role: Option<String>,
    reasoning_content: Option<serde_json::Value>,
    reasoning: Option<serde_json::Value>,
    reasoning_details: Option<serde_json::Value>,
    tool_calls: Option<Vec<ChatToolCallDelta>>,
    function_call: Option<serde_json::Value>,
    refusal: Option<serde_json::Value>,
    audio: Option<serde_json::Value>,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}

impl ChatDelta {
    fn is_empty(&self) -> bool {
        self.content.is_none()
            && self.role.is_none()
            && self.reasoning_content.is_none()
            && self.reasoning.is_none()
            && self.reasoning_details.is_none()
            && self
                .tool_calls
                .as_ref()
                .is_none_or(|tool_calls| tool_calls.is_empty())
            && self.function_call.is_none()
            && self.refusal.is_none()
            && self.audio.is_none()
            && self.extra.is_empty()
    }

    fn has_protocol_violation(&self) -> bool {
        self.role.as_deref().is_some_and(|role| role != "assistant")
    }

    fn has_unsupported_output(&self, allow_tools: bool) -> bool {
        (!allow_tools
            && self
                .tool_calls
                .as_ref()
                .is_some_and(|tool_calls| !tool_calls.is_empty()))
            || self.function_call.is_some()
            || self.refusal.is_some()
            || self.audio.is_some()
            || self.extra.values().any(|value| !value.is_null())
    }
}

#[derive(Deserialize)]
struct ChatToolCallDelta {
    #[serde(default)]
    index: u64,
    id: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    function: Option<ChatFunctionCallDelta>,
}

#[derive(Deserialize)]
struct ChatFunctionCallDelta {
    name: Option<String>,
    arguments: Option<String>,
}

impl ChatToolCallDelta {
    fn accumulated_bytes(&self) -> Option<usize> {
        [
            self.id.as_ref().map_or(0, String::len),
            self.kind.as_ref().map_or(0, String::len),
            self.function
                .as_ref()
                .and_then(|function| function.name.as_ref())
                .map_or(0, String::len),
            self.function
                .as_ref()
                .and_then(|function| function.arguments.as_ref())
                .map_or(0, String::len),
        ]
        .into_iter()
        .try_fold(0usize, usize::checked_add)
    }
}

#[derive(Default)]
struct ToolCallAssembler {
    id: Option<String>,
    name: String,
    arguments: String,
    saw_function: bool,
    unsupported_kind: bool,
}

impl ToolCallAssembler {
    fn push(&mut self, delta: ChatToolCallDelta) -> Result<(), ModelError> {
        if let Some(kind) = delta.kind
            && kind != "function"
        {
            self.unsupported_kind = true;
        }
        if let Some(id) = delta.id.filter(|id| !id.is_empty()) {
            if id.len() > MAX_TOOL_CALL_ID_BYTES {
                return Err(ModelError::new(ModelErrorKind::OutputTooLarge, false));
            }
            match &self.id {
                Some(current) if current != &id => {
                    return Err(ModelError::new(ModelErrorKind::Protocol, false));
                }
                Some(_) => {}
                None => self.id = Some(id),
            }
        }
        if let Some(function) = delta.function {
            self.saw_function = true;
            if let Some(name) = function.name {
                if self
                    .name
                    .len()
                    .checked_add(name.len())
                    .is_none_or(|length| length > MAX_TOOL_NAME_BYTES)
                {
                    return Err(ModelError::new(ModelErrorKind::Protocol, false));
                }
                self.name.push_str(&name);
            }
            if let Some(arguments) = function.arguments {
                if self
                    .arguments
                    .len()
                    .checked_add(arguments.len())
                    .is_none_or(|length| length > MAX_TOOL_ARGUMENT_BYTES)
                {
                    return Err(ModelError::new(ModelErrorKind::OutputTooLarge, false));
                }
                self.arguments.push_str(&arguments);
            }
        }
        Ok(())
    }

    fn finish(self, provider_index: u64) -> Result<Option<ModelToolCall>, ModelError> {
        if self.unsupported_kind {
            return Ok(None);
        }
        if !self.saw_function || self.name.is_empty() {
            return Err(ModelError::new(ModelErrorKind::Protocol, false));
        }
        let id = self.id.unwrap_or_else(|| {
            let sequence = COMPATIBLE_TOOL_CALL_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            format!("compat_call_{sequence}_{provider_index}")
        });
        let arguments = if self.arguments.is_empty() {
            serde_json::Value::Object(serde_json::Map::new())
        } else {
            parse_json_without_duplicates(&self.arguments)
                .unwrap_or(serde_json::Value::String(self.arguments))
        };
        Ok(Some(ModelToolCall {
            id,
            name: self.name,
            arguments,
        }))
    }
}

fn parse_json_without_duplicates(text: &str) -> Result<serde_json::Value, serde_json::Error> {
    struct StrictValue(serde_json::Value);

    impl<'de> Deserialize<'de> for StrictValue {
        fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
        where
            D: serde::Deserializer<'de>,
        {
            deserializer.deserialize_any(StrictValueVisitor)
        }
    }

    struct StrictValueVisitor;

    impl<'de> Visitor<'de> for StrictValueVisitor {
        type Value = StrictValue;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a JSON value without duplicate object fields")
        }

        fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
            Ok(StrictValue(serde_json::Value::Bool(value)))
        }

        fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
            Ok(StrictValue(serde_json::Value::Number(value.into())))
        }

        fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
            Ok(StrictValue(serde_json::Value::Number(value.into())))
        }

        fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            serde_json::Number::from_f64(value)
                .map(serde_json::Value::Number)
                .map(StrictValue)
                .ok_or_else(|| E::custom("non-finite JSON number"))
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
            Ok(StrictValue(serde_json::Value::String(value.to_owned())))
        }

        fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
            Ok(StrictValue(serde_json::Value::String(value)))
        }

        fn visit_none<E>(self) -> Result<Self::Value, E> {
            Ok(StrictValue(serde_json::Value::Null))
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok(StrictValue(serde_json::Value::Null))
        }

        fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
        where
            A: SeqAccess<'de>,
        {
            let mut values = Vec::new();
            while let Some(value) = sequence.next_element::<StrictValue>()? {
                values.push(value.0);
            }
            Ok(StrictValue(serde_json::Value::Array(values)))
        }

        fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
        where
            A: MapAccess<'de>,
        {
            let mut fields = serde_json::Map::new();
            let mut names = BTreeSet::new();
            while let Some(name) = map.next_key::<String>()? {
                if !names.insert(name.clone()) {
                    return Err(serde::de::Error::custom("duplicate JSON object field"));
                }
                let value = map.next_value::<StrictValue>()?;
                fields.insert(name, value.0);
            }
            Ok(StrictValue(serde_json::Value::Object(fields)))
        }
    }

    let mut deserializer = serde_json::Deserializer::from_str(text);
    let value = StrictValue::deserialize(&mut deserializer)?.0;
    deserializer.end()?;
    Ok(value)
}

#[derive(Deserialize)]
struct ChatUsage {
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    total_tokens: Option<u64>,
    prompt_tokens_details: Option<ChatPromptTokenDetails>,
    completion_tokens_details: Option<ChatCompletionTokenDetails>,
}

#[derive(Deserialize)]
struct ChatPromptTokenDetails {
    cached_tokens: Option<u64>,
}

#[derive(Deserialize)]
struct ChatCompletionTokenDetails {
    reasoning_tokens: Option<u64>,
}

impl From<ChatUsage> for ModelUsage {
    fn from(usage: ChatUsage) -> Self {
        Self {
            input_tokens: usage.prompt_tokens,
            cached_input_tokens: usage
                .prompt_tokens_details
                .and_then(|details| details.cached_tokens),
            output_tokens: usage.completion_tokens,
            reasoning_output_tokens: usage
                .completion_tokens_details
                .and_then(|details| details.reasoning_tokens),
            total_tokens: usage.total_tokens,
        }
    }
}

#[cfg(test)]
#[path = "tests/openai_chat_completions.rs"]
mod tests;
