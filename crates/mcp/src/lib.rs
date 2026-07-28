mod call;
mod inventory;
mod process;
mod protocol;
mod result;
mod streamable_http;
mod transport;

pub use call::McpCallErrorKind;
pub use call::McpCallOutcome;
pub use call::McpCallRequestState;
pub use call::PreparedMcpCall;
pub use inventory::McpServerInventory;
pub use inventory::McpToolDefinition;
pub use inventory::StdioServerSpec;
pub use result::McpNormalizedResult;
pub use streamable_http::LoopbackStreamableHttpServerSpec;

use std::error::Error;
use std::fmt;

pub const MCP_PROTOCOL_VERSION: &str = "2025-11-25";
pub const MAX_SERVER_TOOLS: usize = 32;
pub const MAX_TOOL_NAME_BYTES: usize = 64;
pub const MAX_TOOL_DESCRIPTION_BYTES: usize = 4 * 1024;
pub const MAX_TOOL_SCHEMA_BYTES: usize = 32 * 1024;
pub const MAX_TOOL_DEFINITION_BYTES: usize = 64 * 1024;
pub const MAX_INVENTORY_BYTES: usize = 256 * 1024;
pub const MAX_MESSAGE_BYTES: usize = 512 * 1024;
pub const MAX_STDOUT_BYTES: usize = 1024 * 1024;
pub const MAX_STDERR_BYTES: usize = 256 * 1024;
pub const MAX_MESSAGES: usize = 32;
pub const MAX_JSON_DEPTH: usize = 32;
pub const MAX_SCHEMA_DEPTH: usize = 16;
pub const MAX_SCHEMA_NODES: usize = 2048;
pub const MAX_CALL_ARGUMENT_BYTES: usize = 32 * 1024;
pub const MAX_CALL_ARGUMENT_NODES: usize = 2048;
pub const MAX_RESULT_CONTENT_BLOCKS: usize = 32;
pub const MAX_STRUCTURED_RESULT_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscoveryErrorKind {
    SpawnFailed,
    ProcessControlUnavailable,
    Timeout,
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
    HttpTransport,
    HttpStatus,
    InvalidContentType,
    InvalidSse,
    InvalidSession,
    SessionExpired,
}

#[derive(Debug)]
pub struct DiscoveryError {
    server_id: String,
    kind: DiscoveryErrorKind,
}

impl DiscoveryError {
    pub(crate) fn new(server_id: &str, kind: DiscoveryErrorKind) -> Self {
        Self {
            server_id: server_id.to_owned(),
            kind,
        }
    }

    pub const fn kind(&self) -> DiscoveryErrorKind {
        self.kind
    }

    pub fn server_id(&self) -> &str {
        &self.server_id
    }
}

impl fmt::Display for DiscoveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "MCP server `{}` discovery failed ({:?})",
            self.server_id, self.kind
        )
    }
}

impl Error for DiscoveryError {}

pub async fn discover_stdio(spec: &StdioServerSpec) -> Result<McpServerInventory, DiscoveryError> {
    protocol::discover(spec).await
}

pub async fn discover_loopback_streamable_http(
    spec: &LoopbackStreamableHttpServerSpec,
) -> Result<McpServerInventory, DiscoveryError> {
    streamable_http::discover(spec).await
}

pub fn prepare_call(
    inventory: &McpServerInventory,
    callable_name: &str,
    arguments: serde_json::Value,
) -> Result<PreparedMcpCall, McpCallErrorKind> {
    call::prepare(inventory, callable_name, arguments)
}

pub async fn call_stdio(
    spec: &StdioServerSpec,
    inventory: &McpServerInventory,
    call: &PreparedMcpCall,
    cancellation: tokio_util::sync::CancellationToken,
) -> McpCallOutcome {
    call::execute(spec, inventory, call, cancellation).await
}

pub async fn call_loopback_streamable_http(
    spec: &LoopbackStreamableHttpServerSpec,
    inventory: &McpServerInventory,
    call: &PreparedMcpCall,
    cancellation: tokio_util::sync::CancellationToken,
) -> McpCallOutcome {
    streamable_http::call(spec, inventory, call, cancellation).await
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
