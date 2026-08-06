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
use crate::ModelProtocolCode;
use crate::ModelProtocolDiagnostic;
use crate::ModelProtocolStage;
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
use crate::OpenAiChatCompletionsProvider;
use crate::ProviderContextEnvelope;
use crate::ProviderWireApi;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use futures_util::FutureExt;
use futures_util::StreamExt;
use reqwest::StatusCode;
use reqwest::header::AUTHORIZATION;
use reqwest::header::HeaderValue;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::fmt;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use url::Url;
use zeroize::Zeroizing;

pub(crate) mod requests;
pub(crate) mod streaming;

use requests::openai_provider_managed_request;
use requests::openai_request;
use streaming::OpenAiStreamState;

const MODEL_STREAM_CAPACITY: usize = 16;
const MAX_SEMANTIC_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenAiContinuationMode {
    LocalReplay,
    ProviderManaged,
}

pub struct OpenAiResponsesProvider {
    client: reqwest::Client,
    base_url: Url,
    token: Option<Zeroizing<String>>,
    strict_tools: ModelStrictToolsMode,
    parallel_tools: bool,
    max_output_tokens: u32,
    openai_continuation_mode: OpenAiContinuationMode,
    compatible_chat_fallback: Option<OpenAiChatCompletionsProvider>,
}

impl OpenAiResponsesProvider {
    pub fn new(
        base_url: Url,
        token: Option<Zeroizing<String>>,
        strict_tools: ModelStrictToolsMode,
        parallel_tools: bool,
        max_output_tokens: u32,
    ) -> Result<Self, ModelError> {
        if !crate::transport::valid_base_url(&base_url) {
            return Err(ModelError::new(ModelErrorKind::InvalidRequest, false));
        }
        let client = crate::transport::client()?;
        let compatible_chat_fallback = (!is_official_openai_base(&base_url))
            .then(|| {
                let endpoint = crate::transport::append_path(&base_url, "chat/completions")?;
                OpenAiChatCompletionsProvider::new_secret_with_client_and_capabilities(
                    client.clone(),
                    endpoint,
                    token.clone(),
                    strict_tools,
                    parallel_tools,
                )
            })
            .transpose()?;
        Ok(Self {
            client,
            base_url,
            token: token.filter(|token| !token.is_empty()),
            strict_tools,
            parallel_tools,
            max_output_tokens,
            openai_continuation_mode: OpenAiContinuationMode::LocalReplay,
            compatible_chat_fallback,
        })
    }

    pub fn with_openai_continuation_mode(mut self, mode: OpenAiContinuationMode) -> Self {
        self.openai_continuation_mode = mode;
        self
    }
}

impl fmt::Debug for OpenAiResponsesProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenAiResponsesProvider")
            .field("base_url", &"<redacted>")
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .field("strict_tools", &self.strict_tools)
            .field("parallel_tools", &self.parallel_tools)
            .field("max_output_tokens", &self.max_output_tokens)
            .field("openai_continuation_mode", &self.openai_continuation_mode)
            .field(
                "compatible_chat_fallback",
                &self.compatible_chat_fallback.is_some(),
            )
            .finish()
    }
}

impl ModelProvider for OpenAiResponsesProvider {
    fn stream(&self, request: ModelRequest) -> BoxModelFuture<'_> {
        async move {
            let normalized = crate::tool_names::normalize_request(request);
            let request = &normalized.request;
            let endpoint = crate::transport::append_path(&self.base_url, "responses")?;
            let local = openai_request(
                request,
                self.strict_tools,
                self.parallel_tools,
                self.max_output_tokens,
            )?;
            let (body, local_fallback) =
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
                    (managed, fallback)
                } else {
                    (local, None)
                };
            let mut builder = self.client.post(endpoint.clone()).json(&body);
            if let Some(token) = &self.token {
                builder = builder.header(AUTHORIZATION, bearer_header(token)?);
            }
            let mut response = builder
                .send()
                .await
                .map_err(crate::transport::map_reqwest_error)?;
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
                response = fallback
                    .send()
                    .await
                    .map_err(crate::transport::map_reqwest_error)?;
                used_local_fallback = true;
            }
            if !response.status().is_success() {
                return Err(crate::transport::provider_error(response).await);
            }
            crate::transport::require_event_stream(&response)?;
            let (_, tool_names) = normalized.into_parts();
            let (sender, receiver) = mpsc::channel(MODEL_STREAM_CAPACITY);
            tokio::spawn(process_openai_stream(
                response,
                sender,
                tool_names,
                used_local_fallback,
            ));
            Ok(ReceiverStream::new(receiver).boxed())
        }
        .boxed()
    }

    fn retry_after_no_output(&self, request: ModelRequest) -> BoxModelFuture<'_> {
        match &self.compatible_chat_fallback {
            Some(provider)
                if !request.messages.iter().any(|message| {
                    message
                        .content
                        .iter()
                        .any(|part| matches!(part, ModelContentPart::ProviderContext(_)))
                }) =>
            {
                provider.stream(request)
            }
            _ => self.stream(request),
        }
    }
}

fn is_official_openai_base(base_url: &Url) -> bool {
    base_url
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("api.openai.com"))
}

async fn process_openai_stream(
    response: reqwest::Response,
    sender: mpsc::Sender<Result<ModelEvent, ModelError>>,
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
    let mut records = crate::transport::sse_records(response);
    let mut state = OpenAiStreamState::default();
    loop {
        let event = tokio::select! {
            _ = sender.closed() => return,
            next = records.recv() => next,
        };
        let event = match event {
            None => {
                send_stream_error(&sender, ModelError::new(ModelErrorKind::Disconnected, true))
                    .await;
                return;
            }
            Some(Err(error)) => {
                send_stream_error(&sender, error).await;
                return;
            }
            Some(Ok(event)) => event,
        };
        if event.data.is_empty() || event.data == "[DONE]" {
            if event.data == "[DONE]" {
                send_stream_error(&sender, ModelError::new(ModelErrorKind::Disconnected, true))
                    .await;
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
    let provider_context = output
        .iter()
        .any(|item| {
            item.get("type").and_then(Value::as_str) == Some("reasoning")
                && item
                    .get("encrypted_content")
                    .and_then(Value::as_str)
                    .is_some_and(|content| !content.is_empty())
        })
        .then(|| {
            ProviderContextEnvelope::new_with_replay_tokens(
                ProviderWireApi::OpenAiResponses,
                value
                    .get("id")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                serde_json::to_vec(output).map_err(|_| protocol_error())?,
                usage.and_then(|usage| usage.output_tokens),
            )
        })
        .transpose()?;
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
                let nested = value.get("function").filter(|value| value.is_object());
                let id = value
                    .get("call_id")
                    .and_then(Value::as_str)
                    .or_else(|| value.get("id").and_then(Value::as_str))
                    .or_else(|| {
                        nested.and_then(|value| value.get("call_id").and_then(Value::as_str))
                    })
                    .ok_or_else(|| {
                        protocol_error_for_json(
                            ModelProtocolStage::OutputNormalization,
                            ModelProtocolCode::MalformedToolCall,
                            Some("response.completed"),
                            value,
                        )
                    })?;
                let name = value
                    .get("name")
                    .or_else(|| nested.and_then(|value| value.get("name")))
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        protocol_error_for_json(
                            ModelProtocolStage::OutputNormalization,
                            ModelProtocolCode::MalformedToolCall,
                            Some("response.completed"),
                            value,
                        )
                    })?;
                let raw_arguments = value
                    .get("arguments")
                    .or_else(|| nested.and_then(|value| value.get("arguments")));
                let arguments = match raw_arguments {
                    Some(Value::String(raw)) => serde_json::from_str(raw)
                        // Preserve malformed provider arguments as a
                        // non-object value. Core's tool-schema boundary will
                        // reject it and send bounded correction feedback; the
                        // adapter must not execute or discard the call merely
                        // because a gateway encoded invalid JSON text.
                        .unwrap_or_else(|_| Value::String(raw.clone())),
                    Some(arguments @ Value::Object(_)) => arguments.clone(),
                    // A no-argument function is valid; several Responses
                    // gateways omit `arguments` or send it as null. Let Core
                    // perform the normal schema validation with an empty
                    // object instead of discarding the tool call at parsing.
                    None | Some(Value::Null) => serde_json::json!({}),
                    Some(_) => {
                        return Err(protocol_error_for_json(
                            ModelProtocolStage::OutputNormalization,
                            ModelProtocolCode::MalformedToolCall,
                            Some("response.completed"),
                            value,
                        ));
                    }
                };
                push_tool(&mut items, id, name, arguments);
            }
            Some("custom_tool_call") => {
                let id = value
                    .get("call_id")
                    .and_then(Value::as_str)
                    .or_else(|| value.get("id").and_then(Value::as_str))
                    .ok_or_else(|| {
                        protocol_error_for_json(
                            ModelProtocolStage::OutputNormalization,
                            ModelProtocolCode::MalformedToolCall,
                            Some("response.completed"),
                            value,
                        )
                    })?;
                let name = value.get("name").and_then(Value::as_str).ok_or_else(|| {
                    protocol_error_for_json(
                        ModelProtocolStage::OutputNormalization,
                        ModelProtocolCode::MalformedToolCall,
                        Some("response.completed"),
                        value,
                    )
                })?;
                let input = value.get("input").and_then(Value::as_str).ok_or_else(|| {
                    protocol_error_for_json(
                        ModelProtocolStage::OutputNormalization,
                        ModelProtocolCode::MalformedToolCall,
                        Some("response.completed"),
                        value,
                    )
                })?;
                push_tool(&mut items, id, name, Value::String(input.to_owned()));
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
            continuation: if output.iter().any(|item| {
                matches!(
                    item.get("type").and_then(Value::as_str),
                    Some("function_call" | "custom_tool_call")
                )
            }) {
                ModelContinuation::ToolCalls
            } else {
                ModelContinuation::Complete
            },
        },
        provider_context: provider_context.map(Box::new),
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

fn protocol_error() -> ModelError {
    protocol_error_for_json(
        ModelProtocolStage::ResponseAssembly,
        ModelProtocolCode::InvalidEventShape,
        None,
        &Value::Null,
    )
}

fn protocol_error_for_json(
    stage: ModelProtocolStage,
    code: ModelProtocolCode,
    event_type: Option<&str>,
    value: &Value,
) -> ModelError {
    ModelError::new(ModelErrorKind::Protocol, false).with_protocol_diagnostic(
        ModelProtocolDiagnostic::from_json_shape(stage, code, event_type, value),
    )
}

#[cfg(test)]
#[path = "openai_responses/tests/mod.rs"]
mod tests;
