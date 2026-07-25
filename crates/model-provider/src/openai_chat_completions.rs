use crate::BoxModelFuture;
use crate::ModelError;
use crate::ModelErrorKind;
use crate::ModelEvent;
use crate::ModelMessage;
use crate::ModelProvider;
use crate::ModelRequest;
use crate::ModelRole;
use crate::ModelUsage;
use eventsource_stream::Eventsource;
use futures_util::FutureExt;
use futures_util::StreamExt;
use reqwest::StatusCode;
use reqwest::header::AUTHORIZATION;
use reqwest::header::HeaderValue;
use serde::Deserialize;
use serde::Serialize;
use std::fmt;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use url::Url;
use zeroize::Zeroizing;

const MODEL_STREAM_CAPACITY: usize = 16;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const RESPONSE_HEADER_TIMEOUT: Duration = Duration::from_secs(30);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

pub struct OpenAiChatCompletionsProvider {
    client: reqwest::Client,
    endpoint: Url,
    token: Option<Zeroizing<String>>,
}

impl OpenAiChatCompletionsProvider {
    pub fn new(endpoint: Url, token: Option<String>) -> Result<Self, ModelError> {
        validate_endpoint(&endpoint)?;
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| ModelError::new(ModelErrorKind::Transport, true))?;
        Ok(Self {
            client,
            endpoint,
            token: token.map(Zeroizing::new),
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
            let mut builder = self.client.post(self.endpoint.clone()).json(&body);
            if let Some(token) = &self.token {
                let value = HeaderValue::from_str(&format!("Bearer {}", token.as_str()))
                    .map_err(|_| ModelError::new(ModelErrorKind::Authentication, false))?;
                builder = builder.header(AUTHORIZATION, value);
            }
            let response = tokio::time::timeout(RESPONSE_HEADER_TIMEOUT, builder.send())
                .await
                .map_err(|_| ModelError::new(ModelErrorKind::Timeout, true))?
                .map_err(map_reqwest_error)?;
            if !response.status().is_success() {
                return Err(map_status(response.status()));
            }

            let (sender, receiver) = mpsc::channel(MODEL_STREAM_CAPACITY);
            tokio::spawn(process_stream(response, sender));
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
) {
    let mut stream = response.bytes_stream().eventsource();
    let mut clean_finish = false;
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
                send_error(&sender, ModelError::new(ModelErrorKind::Transport, true)).await;
                return;
            }
            Ok(Some(Err(_))) => {
                send_error(&sender, ModelError::new(ModelErrorKind::Protocol, false)).await;
                return;
            }
            Ok(Some(Ok(event))) => event,
        };
        if event.data == "[DONE]" {
            if clean_finish {
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
        if let Some(usage) = chunk.usage
            && sender
                .send(Ok(ModelEvent::Usage(usage.into())))
                .await
                .is_err()
        {
            return;
        }
        for choice in chunk.choices {
            if choice.index != 0 {
                continue;
            }
            if let Some(content) = choice.delta.content
                && !content.is_empty()
                && sender
                    .send(Ok(ModelEvent::TextDelta(content)))
                    .await
                    .is_err()
            {
                return;
            }
            if let Some(reason) = choice.finish_reason.as_deref() {
                match reason {
                    "stop" => clean_finish = true,
                    "length" => {
                        send_error(&sender, ModelError::new(ModelErrorKind::Incomplete, false))
                            .await;
                        return;
                    }
                    "content_filter" => {
                        send_error(&sender, ModelError::new(ModelErrorKind::Filtered, false)).await;
                        return;
                    }
                    "tool_calls" | "function_call" => {
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
        400 | 404 | 409 | 413 | 422 => ModelError::new(ModelErrorKind::InvalidRequest, false),
        401 | 403 => ModelError::new(ModelErrorKind::Authentication, false),
        408 => ModelError::new(ModelErrorKind::Timeout, true),
        429 => ModelError::new(ModelErrorKind::RateLimited, true),
        500..=599 => ModelError::new(ModelErrorKind::Server, true),
        _ => ModelError::new(ModelErrorKind::Server, false),
    }
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    stream: bool,
}

impl From<ModelRequest> for ChatRequest {
    fn from(request: ModelRequest) -> Self {
        Self {
            model: request.model,
            messages: request.messages.into_iter().map(Into::into).collect(),
            stream: true,
        }
    }
}

#[derive(Serialize)]
struct ChatMessage {
    role: &'static str,
    content: String,
}

impl From<ModelMessage> for ChatMessage {
    fn from(message: ModelMessage) -> Self {
        Self {
            role: match message.role {
                ModelRole::User => "user",
                ModelRole::Assistant => "assistant",
            },
            content: message.text,
        }
    }
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
