use futures_util::future::BoxFuture;
use serde_json::Value;
use std::fmt;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use sugarcode_model_provider::ModelToolDefinition;
use sugarcode_protocol::ThreadId;
use sugarcode_protocol::TurnId;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Default)]
pub struct McpToolCapability {
    enabled: Arc<AtomicBool>,
}

impl McpToolCapability {
    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Release);
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedMcpToolCall {
    pub callable_name: String,
    pub arguments: Value,
    pub arguments_bytes: u64,
    pub arguments_sha256: String,
    pub inventory_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpToolPrepareError {
    InvalidArguments,
    ValueTooComplex,
    ArgumentTooLarge,
    InputSchemaMismatch,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpToolRequestState {
    NotSent,
    MayHaveStarted,
    Responded,
}

impl fmt::Display for McpToolRequestState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::NotSent => "notSent",
            Self::MayHaveStarted => "mayHaveStarted",
            Self::Responded => "responded",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpToolExecutionError {
    InventoryDrift,
    SpawnFailed,
    ProcessControlUnavailable,
    Timeout,
    Cancelled,
    StderrTooLarge,
    UnexpectedEof,
    AbnormalExit,
    MessageTooLarge,
    OutputTooLarge,
    TooManyMessages,
    InvalidUtf8,
    InvalidJsonRpc,
    UnsupportedProtocolVersion,
    MissingToolsCapability,
    UnsupportedServerRequest,
    InvalidToolInventory,
    ShutdownFailed,
    ServerError,
    InvalidResult,
    UnsupportedContent,
    OutputSchemaMismatch,
    ResultTooLarge,
    HttpTransport,
    HttpStatus,
    InvalidContentType,
    InvalidSse,
    InvalidSession,
    SessionExpired,
}

impl fmt::Display for McpToolExecutionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InventoryDrift => "inventoryDrift",
            Self::SpawnFailed => "spawnFailed",
            Self::ProcessControlUnavailable => "processControlUnavailable",
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
            Self::StderrTooLarge => "stderrTooLarge",
            Self::UnexpectedEof => "unexpectedEof",
            Self::AbnormalExit => "abnormalExit",
            Self::MessageTooLarge => "messageTooLarge",
            Self::OutputTooLarge => "outputTooLarge",
            Self::TooManyMessages => "tooManyMessages",
            Self::InvalidUtf8 => "invalidUtf8",
            Self::InvalidJsonRpc => "invalidJsonRpc",
            Self::UnsupportedProtocolVersion => "unsupportedProtocolVersion",
            Self::MissingToolsCapability => "missingToolsCapability",
            Self::UnsupportedServerRequest => "unsupportedServerRequest",
            Self::InvalidToolInventory => "invalidToolInventory",
            Self::ShutdownFailed => "shutdownFailed",
            Self::ServerError => "serverError",
            Self::InvalidResult => "invalidResult",
            Self::UnsupportedContent => "unsupportedContent",
            Self::OutputSchemaMismatch => "outputSchemaMismatch",
            Self::ResultTooLarge => "resultTooLarge",
            Self::HttpTransport => "httpTransport",
            Self::HttpStatus => "httpStatus",
            Self::InvalidContentType => "invalidContentType",
            Self::InvalidSse => "invalidSse",
            Self::InvalidSession => "invalidSession",
            Self::SessionExpired => "sessionExpired",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpToolExecutionResult {
    pub content: String,
    pub is_error: bool,
    pub observed_bytes: u64,
    pub canonical_bytes: u64,
    pub sha256: String,
    pub content_blocks: u64,
    pub structured_content: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpToolExecutionOutcome {
    Completed(McpToolExecutionResult),
    Error {
        kind: McpToolExecutionError,
        request_state: McpToolRequestState,
    },
}

pub trait McpToolExecutor: fmt::Debug + Send + Sync {
    fn definitions(&self) -> Vec<ModelToolDefinition>;

    fn prepare(
        &self,
        callable_name: &str,
        arguments: Value,
    ) -> Result<PreparedMcpToolCall, McpToolPrepareError>;

    fn execute(
        &self,
        call: PreparedMcpToolCall,
        cancellation: CancellationToken,
    ) -> BoxFuture<'static, McpToolExecutionOutcome>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpToolApprovalRequest {
    pub approval_id: String,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub call_id: String,
    pub name: String,
    pub arguments: Value,
    pub arguments_bytes: u64,
    pub arguments_sha256: String,
    pub inventory_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpToolApprovalOutcome {
    Approved,
    Denied,
    TimedOut,
    Unsupported,
    ClientDisconnected,
}

pub trait McpToolApprovalRequester: fmt::Debug + Send + Sync {
    fn request(
        &self,
        request: McpToolApprovalRequest,
    ) -> BoxFuture<'static, McpToolApprovalOutcome>;
}
