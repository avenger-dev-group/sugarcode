use std::error::Error;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelErrorKind {
    Authentication,
    InvalidRequest,
    RateLimited,
    Timeout,
    Transport,
    Disconnected,
    Server,
    Protocol,
    Incomplete,
    Filtered,
    UnsupportedOutput,
    OutputTooLarge,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct ModelError {
    kind: ModelErrorKind,
    retryable: bool,
}

impl ModelError {
    pub const fn new(kind: ModelErrorKind, retryable: bool) -> Self {
        Self { kind, retryable }
    }

    pub const fn kind(self) -> ModelErrorKind {
        self.kind
    }

    pub const fn retryable(self) -> bool {
        self.retryable
    }
}

impl fmt::Debug for ModelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ModelError")
            .field("kind", &self.kind)
            .field("retryable", &self.retryable)
            .finish()
    }
}

impl fmt::Display for ModelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self.kind {
            ModelErrorKind::Authentication => "model authentication failed",
            ModelErrorKind::InvalidRequest => "model request was rejected",
            ModelErrorKind::RateLimited => "model request was rate limited",
            ModelErrorKind::Timeout => "model request timed out",
            ModelErrorKind::Transport => "model transport failed",
            ModelErrorKind::Disconnected => "model stream disconnected",
            ModelErrorKind::Server => "model server failed",
            ModelErrorKind::Protocol => "model stream was invalid",
            ModelErrorKind::Incomplete => "model response was incomplete",
            ModelErrorKind::Filtered => "model response was filtered",
            ModelErrorKind::UnsupportedOutput => "model returned unsupported output",
            ModelErrorKind::OutputTooLarge => "model output exceeded the limit",
        })
    }
}

impl Error for ModelError {}
