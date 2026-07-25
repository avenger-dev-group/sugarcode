use crate::ModelError;
use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use std::fmt;

pub type ModelStream = BoxStream<'static, Result<ModelEvent, ModelError>>;
pub type BoxModelFuture<'a> = BoxFuture<'a, Result<ModelStream, ModelError>>;

#[derive(Clone, PartialEq, Eq)]
pub struct ModelRequest {
    pub model: String,
    pub messages: Vec<ModelMessage>,
}

impl fmt::Debug for ModelRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ModelRequest")
            .field("model", &"<redacted>")
            .field("message_count", &self.messages.len())
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ModelMessage {
    pub role: ModelRole,
    pub text: String,
}

impl fmt::Debug for ModelMessage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ModelMessage")
            .field("role", &self.role)
            .field("text", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelRole {
    User,
    Assistant,
}

#[derive(Clone, PartialEq, Eq)]
pub enum ModelEvent {
    TextDelta(String),
    Usage(ModelUsage),
    Completed,
}

impl fmt::Debug for ModelEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TextDelta(delta) => formatter
                .debug_tuple("TextDelta")
                .field(&format_args!("{} bytes", delta.len()))
                .finish(),
            Self::Usage(usage) => formatter.debug_tuple("Usage").field(usage).finish(),
            Self::Completed => formatter.write_str("Completed"),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ModelUsage {
    pub input_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub reasoning_output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

pub trait ModelProvider: fmt::Debug + Send + Sync {
    fn stream(&self, request: ModelRequest) -> BoxModelFuture<'_>;
}
