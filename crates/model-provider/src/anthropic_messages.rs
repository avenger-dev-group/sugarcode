use crate::BoxModelFuture;
use crate::ModelError;
use crate::ModelErrorKind;
use crate::ModelEvent;
use crate::ModelProvider;
use crate::ModelRequest;
use crate::ModelStrictToolsMode;
use futures_util::FutureExt;
use futures_util::StreamExt;
use reqwest::header::HeaderName;
use reqwest::header::HeaderValue;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use url::Url;
use zeroize::Zeroizing;

pub(crate) mod requests;
pub(crate) mod streaming;

use requests::anthropic_request;
use streaming::AnthropicStreamState;

const MODEL_STREAM_CAPACITY: usize = 16;

pub struct AnthropicMessagesProvider {
    client: reqwest::Client,
    base_url: Url,
    token: Option<Zeroizing<String>>,
    strict_tools: ModelStrictToolsMode,
    max_output_tokens: u32,
}

impl AnthropicMessagesProvider {
    pub fn new(
        base_url: Url,
        token: Option<Zeroizing<String>>,
        strict_tools: ModelStrictToolsMode,
        max_output_tokens: u32,
    ) -> Result<Self, ModelError> {
        if !crate::transport::valid_base_url(&base_url) {
            return Err(ModelError::new(ModelErrorKind::InvalidRequest, false));
        }
        Ok(Self {
            client: crate::transport::client()?,
            base_url,
            token: token.filter(|token| !token.is_empty()),
            strict_tools,
            max_output_tokens,
        })
    }
}

impl fmt::Debug for AnthropicMessagesProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AnthropicMessagesProvider")
            .field("base_url", &"<redacted>")
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .field("strict_tools", &self.strict_tools)
            .field("max_output_tokens", &self.max_output_tokens)
            .finish()
    }
}

impl ModelProvider for AnthropicMessagesProvider {
    fn stream(&self, request: ModelRequest) -> BoxModelFuture<'_> {
        async move {
            let normalized = crate::tool_names::normalize_request(request);
            let request = &normalized.request;
            let endpoint = crate::transport::append_path(&self.base_url, "messages")?;
            let body = anthropic_request(request, self.strict_tools, self.max_output_tokens)?;
            let mut builder = self
                .client
                .post(endpoint)
                .header(
                    HeaderName::from_static("anthropic-version"),
                    HeaderValue::from_static("2023-06-01"),
                )
                .json(&body);
            if let Some(token) = &self.token {
                builder = builder.header(
                    HeaderName::from_static("x-api-key"),
                    sensitive_header(token)?,
                );
            }
            let response = builder
                .send()
                .await
                .map_err(crate::transport::map_reqwest_error)?;
            if !response.status().is_success() {
                return Err(crate::transport::provider_error(response).await);
            }
            crate::transport::require_event_stream(&response)?;
            let (_, tool_names) = normalized.into_parts();
            let (sender, receiver) = mpsc::channel(MODEL_STREAM_CAPACITY);
            tokio::spawn(process_stream(response, sender, tool_names));
            Ok(ReceiverStream::new(receiver).boxed())
        }
        .boxed()
    }
}

async fn process_stream(
    response: reqwest::Response,
    sender: mpsc::Sender<Result<ModelEvent, ModelError>>,
    tool_names: BTreeMap<String, String>,
) {
    let mut records = crate::transport::sse_records(response);
    let mut state = AnthropicStreamState::default();
    loop {
        let record = tokio::select! {
            _ = sender.closed() => return,
            next = records.recv() => next,
        };
        let record = match record {
            None => {
                send_error(&sender, ModelError::new(ModelErrorKind::Disconnected, true)).await;
                return;
            }
            Some(Err(error)) => {
                send_error(&sender, error).await;
                return;
            }
            Some(Ok(record)) => record,
        };
        if record.data.is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(&record.data) {
            Ok(value) => value,
            Err(_) => {
                send_error(&sender, ModelError::new(ModelErrorKind::Protocol, false)).await;
                return;
            }
        };
        if let Err(error) = state.consume(&record.event, value, &sender).await {
            send_error(&sender, error).await;
            return;
        }
        if record.event == "message_stop" {
            match state.response(&tool_names) {
                Ok(response) => {
                    let _ = sender
                        .send(Ok(ModelEvent::ResponseCompleted(response)))
                        .await;
                }
                Err(error) => send_error(&sender, error).await,
            }
            return;
        }
    }
}

async fn send_error(sender: &mpsc::Sender<Result<ModelEvent, ModelError>>, error: ModelError) {
    let _ = sender.send(Err(error)).await;
}

fn sensitive_header(token: &str) -> Result<HeaderValue, ModelError> {
    let mut value = HeaderValue::from_str(token)
        .map_err(|_| ModelError::new(ModelErrorKind::Authentication, false))?;
    value.set_sensitive(true);
    Ok(value)
}

#[cfg(test)]
#[path = "anthropic_messages/tests.rs"]
mod tests;
