use crate::BoxModelFuture;
use crate::ModelError;
use crate::ModelErrorKind;
use crate::ModelEvent;
use crate::ModelInstruction;
use crate::ModelMessage;
use crate::ModelProvider;
use crate::ModelRequest;
use crate::ModelRole;
use crate::ModelToolCall;
use crate::ModelUsage;
use eventsource_stream::EventStreamError;
use eventsource_stream::Eventsource;
use futures_util::FutureExt;
use futures_util::StreamExt;
use reqwest::StatusCode;
use reqwest::header::AUTHORIZATION;
use reqwest::header::CONTENT_TYPE;
use reqwest::header::HeaderValue;
use serde::Deserialize;
use serde::Serialize;
use serde::de::MapAccess;
use serde::de::SeqAccess;
use serde::de::Visitor;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
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
const MAX_TOOL_CALL_ID_BYTES: usize = 128;
const MAX_TOOL_NAME_BYTES: usize = 128;
const MAX_TOOL_ARGUMENT_BYTES: usize = 32 * 1024;

pub struct OpenAiChatCompletionsProvider {
    client: reqwest::Client,
    endpoint: Url,
    token: Option<Zeroizing<String>>,
}

impl OpenAiChatCompletionsProvider {
    pub fn new(endpoint: Url, token: Option<String>) -> Result<Self, ModelError> {
        Self::new_secret(endpoint, token.map(Zeroizing::new))
    }

    pub fn new_secret(endpoint: Url, token: Option<Zeroizing<String>>) -> Result<Self, ModelError> {
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
            let body = ChatRequest::from(request);
            let allow_tools = !body.tools.is_empty();
            let mut builder = self.client.post(self.endpoint.clone()).json(&body);
            if let Some(token) = &self.token {
                let encoded = Zeroizing::new(format!("Bearer {}", token.as_str()));
                let mut value = HeaderValue::from_str(encoded.as_str())
                    .map_err(|_| ModelError::new(ModelErrorKind::Authentication, false))?;
                value.set_sensitive(true);
                builder = builder.header(AUTHORIZATION, value);
            }
            let response = tokio::time::timeout(RESPONSE_HEADER_TIMEOUT, builder.send())
                .await
                .map_err(|_| ModelError::new(ModelErrorKind::Timeout, true))?
                .map_err(map_reqwest_error)?;
            if !response.status().is_success() {
                return Err(map_status(response.status()));
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
            tokio::spawn(process_stream(response, sender, allow_tools));
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
    let mut clean_finish = false;
    let mut usage_seen = false;
    let mut text_seen = false;
    let mut tool_assembler: Option<ToolCallAssembler> = None;
    let mut completed_tool_call = None;
    loop {
        let next = tokio::select! {
            _ = sender.closed() => return,
            next = tokio::time::timeout(IDLE_TIMEOUT, stream.next()) => next,
        };
        let event = match next {
            Err(_) => {
                send_error(&sender, ModelError::new(ModelErrorKind::Timeout, true)).await;
                return;
            }
            Ok(None) => {
                send_error(&sender, ModelError::new(ModelErrorKind::Disconnected, true)).await;
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
                send_error(&sender, error).await;
                return;
            }
            Ok(Some(Ok(event))) => event,
        };
        if event.data == "[DONE]" {
            if clean_finish {
                if completed_tool_call.is_none() && !text_seen {
                    send_error(&sender, ModelError::new(ModelErrorKind::Incomplete, false)).await;
                    return;
                }
                if let Some(call) = completed_tool_call
                    && sender.send(Ok(ModelEvent::ToolCall(call))).await.is_err()
                {
                    return;
                }
                let _ = sender.send(Ok(ModelEvent::Completed)).await;
            } else {
                send_error(&sender, ModelError::new(ModelErrorKind::Protocol, false)).await;
            }
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
            send_error(&sender, ModelError::new(ModelErrorKind::Server, true)).await;
            return;
        }
        if clean_finish {
            let Some(usage) = chunk.usage else {
                send_error(&sender, ModelError::new(ModelErrorKind::Protocol, false)).await;
                return;
            };
            if usage_seen || !is_usage_only_choices(&chunk.choices) {
                send_error(&sender, ModelError::new(ModelErrorKind::Protocol, false)).await;
                return;
            }
            usage_seen = true;
            if sender
                .send(Ok(ModelEvent::Usage(usage.into())))
                .await
                .is_err()
            {
                return;
            }
            continue;
        }
        if let Some(usage) = chunk.usage {
            if usage_seen {
                send_error(&sender, ModelError::new(ModelErrorKind::Protocol, false)).await;
                return;
            }
            usage_seen = true;
            if sender
                .send(Ok(ModelEvent::Usage(usage.into())))
                .await
                .is_err()
            {
                return;
            }
        }
        if chunk
            .choices
            .iter()
            .any(|choice| choice.delta.has_unsupported_output(allow_tools))
        {
            send_error(
                &sender,
                ModelError::new(ModelErrorKind::UnsupportedOutput, false),
            )
            .await;
            return;
        }
        if chunk.choices.iter().any(|choice| choice.index != 0) {
            send_error(&sender, ModelError::new(ModelErrorKind::Protocol, false)).await;
            return;
        }
        for choice in chunk.choices {
            if let Some(tool_calls) = choice.delta.tool_calls
                && !tool_calls.is_empty()
            {
                if !allow_tools || text_seen || tool_calls.len() != 1 {
                    send_error(
                        &sender,
                        ModelError::new(ModelErrorKind::UnsupportedOutput, false),
                    )
                    .await;
                    return;
                }
                let assembler = tool_assembler.get_or_insert_with(ToolCallAssembler::default);
                if let Err(error) = assembler.push(tool_calls.into_iter().next().expect("one call"))
                {
                    send_error(&sender, error).await;
                    return;
                }
            }
            if let Some(content) = choice.delta.content
                && !content.is_empty()
                && (text_seen || content.chars().any(|character| !character.is_whitespace()))
            {
                if tool_assembler.is_some() {
                    send_error(
                        &sender,
                        ModelError::new(ModelErrorKind::UnsupportedOutput, false),
                    )
                    .await;
                    return;
                }
                text_seen = true;
                if sender
                    .send(Ok(ModelEvent::TextDelta(content)))
                    .await
                    .is_err()
                {
                    return;
                }
            }
            if let Some(reason) = choice.finish_reason.as_deref() {
                match reason {
                    "stop" if tool_assembler.is_none() => clean_finish = true,
                    "length" => {
                        send_error(&sender, ModelError::new(ModelErrorKind::Incomplete, false))
                            .await;
                        return;
                    }
                    "content_filter" => {
                        send_error(&sender, ModelError::new(ModelErrorKind::Filtered, false)).await;
                        return;
                    }
                    "tool_calls" if allow_tools && !text_seen => {
                        let Some(assembler) = tool_assembler.take() else {
                            send_error(&sender, ModelError::new(ModelErrorKind::Protocol, false))
                                .await;
                            return;
                        };
                        match assembler.finish() {
                            Ok(call) => {
                                completed_tool_call = Some(call);
                                clean_finish = true;
                            }
                            Err(error) => {
                                send_error(&sender, error).await;
                                return;
                            }
                        }
                    }
                    "tool_calls" | "function_call" | "stop" => {
                        send_error(
                            &sender,
                            ModelError::new(ModelErrorKind::UnsupportedOutput, false),
                        )
                        .await;
                        return;
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

fn map_status(status: StatusCode) -> ModelError {
    match status.as_u16() {
        300..=399 | 400 | 404 | 409 | 413 | 422 => {
            ModelError::new(ModelErrorKind::InvalidRequest, false)
        }
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
    stream_options: StreamOptions,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tools: Vec<ChatToolDefinition>,
}

#[derive(Serialize)]
struct StreamOptions {
    include_usage: bool,
}

impl From<ModelRequest> for ChatRequest {
    fn from(request: ModelRequest) -> Self {
        let messages = request
            .instructions
            .into_iter()
            .map(ChatMessage::from)
            .chain(request.messages.into_iter().map(ChatMessage::from))
            .collect();
        Self {
            model: request.model,
            messages,
            stream: true,
            stream_options: StreamOptions {
                include_usage: true,
            },
            tools: request
                .tools
                .into_iter()
                .map(|tool| ChatToolDefinition {
                    kind: "function",
                    function: ChatFunctionDefinition {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.parameters,
                    },
                })
                .collect(),
        }
    }
}

impl From<ModelInstruction> for ChatMessage {
    fn from(instruction: ModelInstruction) -> Self {
        Self {
            role: "developer",
            content: Some(instruction.rendered_content()),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }
    }
}

#[derive(Serialize)]
struct ChatMessage {
    role: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tool_calls: Vec<ChatToolCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
}

impl From<ModelMessage> for ChatMessage {
    fn from(message: ModelMessage) -> Self {
        match message {
            ModelMessage::Text { role, text } => Self {
                role: match role {
                    ModelRole::User => "user",
                    ModelRole::Assistant => "assistant",
                },
                content: Some(text),
                tool_calls: Vec::new(),
                tool_call_id: None,
            },
            ModelMessage::ContextCompaction { content } => Self {
                role: "user",
                content: Some(content),
                tool_calls: Vec::new(),
                tool_call_id: None,
            },
            ModelMessage::ToolCall(call) => Self {
                role: "assistant",
                content: None,
                tool_calls: vec![ChatToolCall {
                    id: call.id,
                    kind: "function",
                    function: ChatFunctionCall {
                        name: call.name,
                        arguments: serde_json::to_string(&call.arguments)
                            .expect("tool arguments serialize"),
                    },
                }],
                tool_call_id: None,
            },
            ModelMessage::ToolResult { call_id, content } => Self {
                role: "tool",
                content: Some(content),
                tool_calls: Vec::new(),
                tool_call_id: Some(call_id),
            },
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
}

#[derive(Serialize)]
struct ChatToolCall {
    id: String,
    #[serde(rename = "type")]
    kind: &'static str,
    function: ChatFunctionCall,
}

#[derive(Serialize)]
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
struct ChatChoice {
    index: u64,
    #[serde(default)]
    delta: ChatDelta,
    finish_reason: Option<String>,
}

#[derive(Default, Deserialize)]
struct ChatDelta {
    content: Option<String>,
    role: Option<String>,
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
            && self
                .tool_calls
                .as_ref()
                .is_none_or(|tool_calls| tool_calls.is_empty())
            && self.function_call.is_none()
            && self.refusal.is_none()
            && self.audio.is_none()
            && self.extra.is_empty()
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
            || self.role.as_deref().is_some_and(|role| role != "assistant")
            || !self.extra.is_empty()
    }
}

#[derive(Deserialize)]
struct ChatToolCallDelta {
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

#[derive(Default)]
struct ToolCallAssembler {
    id: Option<String>,
    name: String,
    arguments: String,
    saw_function: bool,
}

impl ToolCallAssembler {
    fn push(&mut self, delta: ChatToolCallDelta) -> Result<(), ModelError> {
        if delta.index != 0 {
            return Err(ModelError::new(ModelErrorKind::UnsupportedOutput, false));
        }
        if let Some(kind) = delta.kind
            && kind != "function"
        {
            return Err(ModelError::new(ModelErrorKind::UnsupportedOutput, false));
        }
        if let Some(id) = delta.id {
            if self.id.is_some()
                || id.is_empty()
                || id.len() > MAX_TOOL_CALL_ID_BYTES
                || !id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            {
                return Err(ModelError::new(ModelErrorKind::Protocol, false));
            }
            self.id = Some(id);
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

    fn finish(self) -> Result<ModelToolCall, ModelError> {
        let id = self
            .id
            .ok_or_else(|| ModelError::new(ModelErrorKind::Protocol, false))?;
        if !self.saw_function || self.name.is_empty() || self.arguments.is_empty() {
            return Err(ModelError::new(ModelErrorKind::Protocol, false));
        }
        let arguments = parse_json_without_duplicates(&self.arguments)
            .map_err(|_| ModelError::new(ModelErrorKind::Protocol, false))?;
        if !arguments.is_object() {
            return Err(ModelError::new(ModelErrorKind::Protocol, false));
        }
        Ok(ModelToolCall {
            id,
            name: self.name,
            arguments,
        })
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
