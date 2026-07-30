use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use std::fmt;
use sugarcode_core::McpToolExecutionError;
use sugarcode_core::McpToolExecutionOutcome;
use sugarcode_core::McpToolExecutionResult;
use sugarcode_core::McpToolExecutor;
use sugarcode_core::McpToolPrepareError;
use sugarcode_core::McpToolRequestState;
use sugarcode_core::PreparedMcpToolCall;
use sugarcode_mcp::LoopbackStreamableHttpServerSpec;
use sugarcode_mcp::McpCallErrorKind;
use sugarcode_mcp::McpCallOutcome;
use sugarcode_mcp::McpCallRequestState;
use sugarcode_mcp::McpServerInventory;
use sugarcode_mcp::StdioServerSpec;
use sugarcode_model_provider::ModelToolDefinition;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct McpServerRuntime {
    spec: McpServerSpec,
    inventory: McpServerInventory,
}

#[derive(Debug, Clone)]
pub(super) enum McpServerSpec {
    Stdio(StdioServerSpec),
    LoopbackStreamableHttp(LoopbackStreamableHttpServerSpec),
}

impl McpServerSpec {
    pub(super) fn id(&self) -> &str {
        match self {
            Self::Stdio(spec) => spec.id(),
            Self::LoopbackStreamableHttp(spec) => spec.id(),
        }
    }
}

#[derive(Clone)]
pub(super) struct McpRuntimeAdapter {
    servers: Vec<McpServerRuntime>,
    definitions: Vec<ModelToolDefinition>,
}

impl fmt::Debug for McpRuntimeAdapter {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("McpRuntimeAdapter")
            .field("server_count", &self.servers.len())
            .field("tool_count", &self.definitions.len())
            .finish()
    }
}

impl McpRuntimeAdapter {
    pub(super) fn new(
        mut discovered: Vec<(McpServerSpec, McpServerInventory)>,
    ) -> Result<Self, &'static str> {
        if discovered.is_empty() || discovered.len() > sugarcode_state::MAX_MCP_SERVERS {
            return Err("invalid MCP server set");
        }
        discovered.sort_by(|left, right| {
            left.1
                .server_id()
                .as_bytes()
                .cmp(right.1.server_id().as_bytes())
        });
        let mut callable_names = std::collections::BTreeSet::new();
        let mut definitions = Vec::new();
        let mut servers = Vec::with_capacity(discovered.len());
        for (spec, inventory) in discovered {
            if spec.id() != inventory.server_id()
                || servers.last().is_some_and(|server: &McpServerRuntime| {
                    server.inventory.server_id() == inventory.server_id()
                })
            {
                return Err("invalid MCP server identity");
            }
            for tool in inventory.tools() {
                let name = inventory
                    .callable_name(tool.name())
                    .ok_or("invalid MCP callable identity")?;
                if !callable_names.insert(name.clone()) {
                    return Err("duplicate MCP callable identity");
                }
                definitions.push(ModelToolDefinition {
                    name,
                    description: tool.description().unwrap_or("").to_owned(),
                    parameters: tool.input_schema().clone(),
                });
            }
            servers.push(McpServerRuntime { spec, inventory });
        }
        Ok(Self {
            servers,
            definitions,
        })
    }

    fn server_for_callable(&self, callable_name: &str) -> Option<&McpServerRuntime> {
        self.servers
            .iter()
            .find(|server| server.inventory.tool_for_callable(callable_name).is_some())
    }
}

impl McpToolExecutor for McpRuntimeAdapter {
    fn definitions(&self) -> Vec<ModelToolDefinition> {
        self.definitions.clone()
    }

    fn prepare(
        &self,
        callable_name: &str,
        arguments: serde_json::Value,
    ) -> Result<PreparedMcpToolCall, McpToolPrepareError> {
        let server = self
            .server_for_callable(callable_name)
            .ok_or(McpToolPrepareError::Unavailable)?;
        let call = sugarcode_mcp::prepare_call(&server.inventory, callable_name, arguments)
            .map_err(map_prepare_error)?;
        Ok(PreparedMcpToolCall {
            callable_name: call.callable_name().to_owned(),
            arguments: call.arguments().clone(),
            arguments_bytes: call.arguments_bytes(),
            arguments_sha256: call.arguments_sha256().to_owned(),
            inventory_sha256: call.inventory_sha256().to_owned(),
        })
    }

    fn execute(
        &self,
        call: PreparedMcpToolCall,
        cancellation: CancellationToken,
    ) -> BoxFuture<'static, McpToolExecutionOutcome> {
        let Some(server) = self.server_for_callable(&call.callable_name) else {
            return async {
                McpToolExecutionOutcome::Error {
                    kind: McpToolExecutionError::InvalidResult,
                    request_state: McpToolRequestState::NotSent,
                }
            }
            .boxed();
        };
        let spec = server.spec.clone();
        let inventory = server.inventory.clone();
        async move {
            let prepared = match sugarcode_mcp::prepare_call(
                &inventory,
                &call.callable_name,
                call.arguments,
            ) {
                Ok(prepared)
                    if prepared.arguments_bytes() == call.arguments_bytes
                        && prepared.arguments_sha256() == call.arguments_sha256
                        && prepared.inventory_sha256() == call.inventory_sha256 =>
                {
                    prepared
                }
                Ok(_) | Err(_) => {
                    return McpToolExecutionOutcome::Error {
                        kind: McpToolExecutionError::InvalidResult,
                        request_state: McpToolRequestState::NotSent,
                    };
                }
            };
            let outcome = match &spec {
                McpServerSpec::Stdio(spec) => {
                    sugarcode_mcp::call_stdio(spec, &inventory, &prepared, cancellation).await
                }
                McpServerSpec::LoopbackStreamableHttp(spec) => {
                    sugarcode_mcp::call_loopback_streamable_http(
                        spec,
                        &inventory,
                        &prepared,
                        cancellation,
                    )
                    .await
                }
            };
            match outcome {
                McpCallOutcome::Completed(result) => {
                    McpToolExecutionOutcome::Completed(McpToolExecutionResult {
                        content: result.content().to_owned(),
                        is_error: result.is_error(),
                        observed_bytes: result.observed_bytes(),
                        canonical_bytes: result.canonical_bytes(),
                        sha256: result.sha256().to_owned(),
                        content_blocks: result.content_blocks(),
                        structured_content: result.has_structured_content(),
                    })
                }
                McpCallOutcome::Error {
                    kind,
                    request_state,
                } => McpToolExecutionOutcome::Error {
                    kind: map_execution_error(kind),
                    request_state: map_request_state(request_state),
                },
            }
        }
        .boxed()
    }
}

fn map_prepare_error(kind: McpCallErrorKind) -> McpToolPrepareError {
    match kind {
        McpCallErrorKind::InvalidArguments => McpToolPrepareError::InvalidArguments,
        McpCallErrorKind::ValueTooComplex => McpToolPrepareError::ValueTooComplex,
        McpCallErrorKind::ArgumentTooLarge => McpToolPrepareError::ArgumentTooLarge,
        McpCallErrorKind::InputSchemaMismatch => McpToolPrepareError::InputSchemaMismatch,
        _ => McpToolPrepareError::Unavailable,
    }
}

fn map_request_state(state: McpCallRequestState) -> McpToolRequestState {
    match state {
        McpCallRequestState::NotSent => McpToolRequestState::NotSent,
        McpCallRequestState::MayHaveStarted => McpToolRequestState::MayHaveStarted,
        McpCallRequestState::Responded => McpToolRequestState::Responded,
    }
}

fn map_execution_error(kind: McpCallErrorKind) -> McpToolExecutionError {
    match kind {
        McpCallErrorKind::InventoryDrift => McpToolExecutionError::InventoryDrift,
        McpCallErrorKind::SpawnFailed => McpToolExecutionError::SpawnFailed,
        McpCallErrorKind::ProcessControlUnavailable => {
            McpToolExecutionError::ProcessControlUnavailable
        }
        McpCallErrorKind::Timeout => McpToolExecutionError::Timeout,
        McpCallErrorKind::Cancelled => McpToolExecutionError::Cancelled,
        McpCallErrorKind::StderrTooLarge => McpToolExecutionError::StderrTooLarge,
        McpCallErrorKind::UnexpectedEof => McpToolExecutionError::UnexpectedEof,
        McpCallErrorKind::AbnormalExit => McpToolExecutionError::AbnormalExit,
        McpCallErrorKind::MessageTooLarge => McpToolExecutionError::MessageTooLarge,
        McpCallErrorKind::OutputTooLarge => McpToolExecutionError::OutputTooLarge,
        McpCallErrorKind::TooManyMessages => McpToolExecutionError::TooManyMessages,
        McpCallErrorKind::InvalidUtf8 => McpToolExecutionError::InvalidUtf8,
        McpCallErrorKind::InvalidJsonRpc => McpToolExecutionError::InvalidJsonRpc,
        McpCallErrorKind::UnsupportedProtocolVersion => {
            McpToolExecutionError::UnsupportedProtocolVersion
        }
        McpCallErrorKind::MissingToolsCapability => McpToolExecutionError::MissingToolsCapability,
        McpCallErrorKind::UnsupportedServerRequest => {
            McpToolExecutionError::UnsupportedServerRequest
        }
        McpCallErrorKind::InvalidToolInventory => McpToolExecutionError::InvalidToolInventory,
        McpCallErrorKind::ShutdownFailed => McpToolExecutionError::ShutdownFailed,
        McpCallErrorKind::ServerError => McpToolExecutionError::ServerError,
        McpCallErrorKind::InvalidResult
        | McpCallErrorKind::InvalidArguments
        | McpCallErrorKind::ValueTooComplex
        | McpCallErrorKind::ArgumentTooLarge
        | McpCallErrorKind::InputSchemaMismatch => McpToolExecutionError::InvalidResult,
        McpCallErrorKind::UnsupportedContent => McpToolExecutionError::UnsupportedContent,
        McpCallErrorKind::OutputSchemaMismatch => McpToolExecutionError::OutputSchemaMismatch,
        McpCallErrorKind::ResultTooLarge => McpToolExecutionError::ResultTooLarge,
        McpCallErrorKind::HttpTransport => McpToolExecutionError::HttpTransport,
        McpCallErrorKind::HttpStatus => McpToolExecutionError::HttpStatus,
        McpCallErrorKind::InvalidContentType => McpToolExecutionError::InvalidContentType,
        McpCallErrorKind::InvalidSse => McpToolExecutionError::InvalidSse,
        McpCallErrorKind::InvalidSession => McpToolExecutionError::InvalidSession,
        McpCallErrorKind::SessionExpired => McpToolExecutionError::SessionExpired,
    }
}
