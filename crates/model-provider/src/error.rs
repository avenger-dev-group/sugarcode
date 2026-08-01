use std::error::Error;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelErrorKind {
    Authentication,
    ContextLengthExceeded,
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
    UnsupportedToolArguments,
    OutputTooLarge,
}

#[derive(Clone, PartialEq, Eq)]
pub struct ModelError {
    kind: ModelErrorKind,
    retryable: bool,
    details: Option<Box<ModelErrorDetails>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ModelErrorDetails {
    ToolSchema {
        tool_name: String,
        schema_reason: String,
    },
    Provider {
        http_status: u16,
        provider_code: Option<String>,
        provider_request_id: Option<String>,
        retry_after: Option<String>,
    },
}

impl ModelError {
    pub const fn new(kind: ModelErrorKind, retryable: bool) -> Self {
        Self {
            kind,
            retryable,
            details: None,
        }
    }

    pub fn strict_tool_schema(tool_name: String, schema_reason: String) -> Self {
        Self {
            kind: ModelErrorKind::InvalidRequest,
            retryable: false,
            details: Some(Box::new(ModelErrorDetails::ToolSchema {
                tool_name,
                schema_reason,
            })),
        }
    }

    pub fn with_provider_metadata(
        mut self,
        http_status: u16,
        provider_code: Option<&str>,
        provider_request_id: Option<&str>,
        retry_after: Option<&str>,
    ) -> Self {
        self.details = Some(Box::new(ModelErrorDetails::Provider {
            http_status,
            provider_code: provider_code.and_then(sanitize_code),
            provider_request_id: provider_request_id.and_then(sanitize_opaque),
            retry_after: retry_after.and_then(sanitize_opaque),
        }));
        self
    }

    pub const fn kind(&self) -> ModelErrorKind {
        self.kind
    }

    pub const fn retryable(&self) -> bool {
        self.retryable
    }

    pub fn tool_name(&self) -> Option<&str> {
        match self.details.as_deref() {
            Some(ModelErrorDetails::ToolSchema { tool_name, .. }) => Some(tool_name),
            _ => None,
        }
    }

    pub fn schema_reason(&self) -> Option<&str> {
        match self.details.as_deref() {
            Some(ModelErrorDetails::ToolSchema { schema_reason, .. }) => Some(schema_reason),
            _ => None,
        }
    }

    pub fn http_status(&self) -> Option<u16> {
        match self.details.as_deref() {
            Some(ModelErrorDetails::Provider { http_status, .. }) => Some(*http_status),
            _ => None,
        }
    }

    pub fn provider_code(&self) -> Option<&str> {
        match self.details.as_deref() {
            Some(ModelErrorDetails::Provider { provider_code, .. }) => provider_code.as_deref(),
            _ => None,
        }
    }

    pub fn provider_request_id(&self) -> Option<&str> {
        match self.details.as_deref() {
            Some(ModelErrorDetails::Provider {
                provider_request_id,
                ..
            }) => provider_request_id.as_deref(),
            _ => None,
        }
    }

    pub fn retry_after(&self) -> Option<&str> {
        match self.details.as_deref() {
            Some(ModelErrorDetails::Provider { retry_after, .. }) => retry_after.as_deref(),
            _ => None,
        }
    }
}

impl fmt::Debug for ModelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ModelError")
            .field("kind", &self.kind)
            .field("retryable", &self.retryable)
            .field("details", &self.details)
            .finish()
    }
}

impl fmt::Display for ModelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self.kind {
            ModelErrorKind::Authentication => "model authentication failed",
            ModelErrorKind::ContextLengthExceeded => "model context window was exceeded",
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
            ModelErrorKind::UnsupportedToolArguments => {
                "model repeatedly returned unsupported tool arguments"
            }
            ModelErrorKind::OutputTooLarge => "model output exceeded the limit",
        })
    }
}

impl Error for ModelError {}

fn sanitize_code(value: &str) -> Option<String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b'/'))
    {
        None
    } else {
        Some(value.to_owned())
    }
}

fn sanitize_opaque(value: &str) -> Option<String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_graphic() || byte == b' ')
    {
        None
    } else {
        Some(value.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_metadata_is_bounded_and_control_characters_are_dropped() {
        let error = ModelError::new(ModelErrorKind::RateLimited, true).with_provider_metadata(
            429,
            Some("rate_limit_exceeded"),
            Some("req_fixture"),
            Some("12"),
        );
        assert_eq!(error.http_status(), Some(429));
        assert_eq!(error.provider_code(), Some("rate_limit_exceeded"));
        assert_eq!(error.provider_request_id(), Some("req_fixture"));
        assert_eq!(error.retry_after(), Some("12"));

        let redacted = ModelError::new(ModelErrorKind::Server, true).with_provider_metadata(
            500,
            Some("bad\ncode"),
            Some("bad\rrequest"),
            Some("bad\nretry"),
        );
        assert_eq!(redacted.provider_code(), None);
        assert_eq!(redacted.provider_request_id(), None);
        assert_eq!(redacted.retry_after(), None);
    }
}
