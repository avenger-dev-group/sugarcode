use crate::DiscoveryError;
use crate::DiscoveryErrorKind;
use crate::MAX_CALL_ARGUMENT_BYTES;
use crate::McpNormalizedResult;
use crate::McpServerInventory;
use crate::StdioServerSpec;
use crate::protocol;
use crate::result;
use crate::transport::JsonRpcTransport;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const EXECUTION_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpCallRequestState {
    NotSent,
    MayHaveStarted,
    Responded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpCallErrorKind {
    InvalidArguments,
    ValueTooComplex,
    ArgumentTooLarge,
    InputSchemaMismatch,
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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedMcpCall {
    callable_name: String,
    raw_name: String,
    arguments: Value,
    arguments_bytes: u64,
    arguments_sha256: String,
    inventory_sha256: String,
}

impl PreparedMcpCall {
    pub fn callable_name(&self) -> &str {
        &self.callable_name
    }

    pub fn raw_name(&self) -> &str {
        &self.raw_name
    }

    pub fn arguments(&self) -> &Value {
        &self.arguments
    }

    pub const fn arguments_bytes(&self) -> u64 {
        self.arguments_bytes
    }

    pub fn arguments_sha256(&self) -> &str {
        &self.arguments_sha256
    }

    pub fn inventory_sha256(&self) -> &str {
        &self.inventory_sha256
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpCallOutcome {
    Completed(McpNormalizedResult),
    Error {
        kind: McpCallErrorKind,
        request_state: McpCallRequestState,
    },
}

pub(crate) fn prepare(
    inventory: &McpServerInventory,
    callable_name: &str,
    arguments: Value,
) -> Result<PreparedMcpCall, McpCallErrorKind> {
    let tool = inventory
        .tool_for_callable(callable_name)
        .ok_or(McpCallErrorKind::InvalidArguments)?;
    if !arguments.is_object() {
        return Err(McpCallErrorKind::InvalidArguments);
    }
    result::validate_value_bounds(&arguments)?;
    let arguments = result::canonicalize(&arguments);
    let bytes = serde_json::to_vec(&arguments).map_err(|_| McpCallErrorKind::InvalidArguments)?;
    if bytes.len() > MAX_CALL_ARGUMENT_BYTES {
        return Err(McpCallErrorKind::ArgumentTooLarge);
    }
    let validator = jsonschema::validator_for(tool.input_schema())
        .map_err(|_| McpCallErrorKind::InvalidArguments)?;
    if !validator.is_valid(&arguments) {
        return Err(McpCallErrorKind::InputSchemaMismatch);
    }
    Ok(PreparedMcpCall {
        callable_name: callable_name.to_owned(),
        raw_name: tool.name().to_owned(),
        arguments,
        arguments_bytes: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
        arguments_sha256: format!("{:x}", Sha256::digest(&bytes)),
        inventory_sha256: inventory.canonical_sha256().to_owned(),
    })
}

pub(crate) async fn execute(
    spec: &StdioServerSpec,
    expected_inventory: &McpServerInventory,
    call: &PreparedMcpCall,
    cancellation: CancellationToken,
) -> McpCallOutcome {
    execute_inner(spec, expected_inventory, call, cancellation).await
}

async fn execute_inner(
    spec: &StdioServerSpec,
    expected_inventory: &McpServerInventory,
    call: &PreparedMcpCall,
    cancellation: CancellationToken,
) -> McpCallOutcome {
    let mut transport = match JsonRpcTransport::spawn(spec) {
        Ok(transport) => transport,
        Err(error) => return discovery_outcome(error, McpCallRequestState::NotSent),
    };
    let mut request_sent = false;
    let result = tokio::time::timeout(EXECUTION_TIMEOUT, async {
        let live_inventory = protocol::negotiate(&mut transport, spec)
            .await
            .map_err(|error| CallFailure::Discovery(error, McpCallRequestState::NotSent))?;
        if live_inventory.canonical_sha256() != expected_inventory.canonical_sha256()
            || call.inventory_sha256 != expected_inventory.canonical_sha256()
        {
            return Err(CallFailure::Discovery(
                DiscoveryError::new(spec.id(), DiscoveryErrorKind::InvalidToolInventory),
                McpCallRequestState::NotSent,
            ));
        }
        transport
            .send(&json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": call.raw_name,
                    "arguments": call.arguments,
                }
            }))
            .await
            .map_err(|error| CallFailure::Discovery(error, McpCallRequestState::NotSent))?;
        request_sent = true;
        receive_call_result(&mut transport, expected_inventory, call, &cancellation).await
    })
    .await
    .unwrap_or_else(|_| {
        Err(CallFailure::Discovery(
            DiscoveryError::new(spec.id(), DiscoveryErrorKind::Timeout),
            if request_sent {
                McpCallRequestState::MayHaveStarted
            } else {
                McpCallRequestState::NotSent
            },
        ))
    });
    let shutdown = transport.shutdown().await;
    match (result, shutdown) {
        (Ok(result), Ok(())) => McpCallOutcome::Completed(result),
        (Ok(_), Err(error)) => discovery_outcome(error, McpCallRequestState::Responded),
        (Err(CallFailure::Cancelled), _) => McpCallOutcome::Error {
            kind: McpCallErrorKind::Cancelled,
            request_state: McpCallRequestState::MayHaveStarted,
        },
        (Err(CallFailure::ServerError), _) => McpCallOutcome::Error {
            kind: McpCallErrorKind::ServerError,
            request_state: McpCallRequestState::Responded,
        },
        (Err(CallFailure::Result(kind)), _) => McpCallOutcome::Error {
            kind,
            request_state: McpCallRequestState::Responded,
        },
        (Err(CallFailure::Discovery(error, state)), _) => {
            if error.kind() == DiscoveryErrorKind::InvalidToolInventory
                && state == McpCallRequestState::NotSent
            {
                McpCallOutcome::Error {
                    kind: McpCallErrorKind::InventoryDrift,
                    request_state: state,
                }
            } else {
                discovery_outcome(error, state)
            }
        }
    }
}

enum CallFailure {
    Cancelled,
    ServerError,
    Result(McpCallErrorKind),
    Discovery(DiscoveryError, McpCallRequestState),
}

impl From<(DiscoveryError, McpCallRequestState)> for CallFailure {
    fn from((error, state): (DiscoveryError, McpCallRequestState)) -> Self {
        Self::Discovery(error, state)
    }
}

async fn receive_call_result(
    transport: &mut JsonRpcTransport,
    inventory: &McpServerInventory,
    call: &PreparedMcpCall,
    cancellation: &CancellationToken,
) -> Result<McpNormalizedResult, CallFailure> {
    loop {
        let message = tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                let _ = transport.send(&json!({
                    "jsonrpc": "2.0",
                    "method": "notifications/cancelled",
                    "params": {
                        "requestId": 3,
                        "reason": "cancelled",
                    }
                })).await;
                return Err(CallFailure::Cancelled);
            }
            message = transport.receive(CALL_TIMEOUT) => {
                message.map_err(|error| CallFailure::Discovery(
                    error,
                    McpCallRequestState::MayHaveStarted,
                ))?
            }
        };
        let object = message.as_object().ok_or_else(|| {
            CallFailure::Discovery(
                DiscoveryError::new(transport.server_id(), DiscoveryErrorKind::InvalidJsonRpc),
                McpCallRequestState::MayHaveStarted,
            )
        })?;
        if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Err(CallFailure::Discovery(
                DiscoveryError::new(transport.server_id(), DiscoveryErrorKind::InvalidJsonRpc),
                McpCallRequestState::MayHaveStarted,
            ));
        }
        if let Some(method) = object.get("method").and_then(Value::as_str) {
            if object.contains_key("id") {
                if method != "ping" {
                    return Err(CallFailure::Discovery(
                        DiscoveryError::new(
                            transport.server_id(),
                            DiscoveryErrorKind::UnsupportedServerRequest,
                        ),
                        McpCallRequestState::MayHaveStarted,
                    ));
                }
                let id = object.get("id").cloned().ok_or_else(|| {
                    CallFailure::Discovery(
                        DiscoveryError::new(
                            transport.server_id(),
                            DiscoveryErrorKind::InvalidJsonRpc,
                        ),
                        McpCallRequestState::MayHaveStarted,
                    )
                })?;
                transport
                    .send(&json!({"jsonrpc": "2.0", "id": id, "result": {}}))
                    .await
                    .map_err(|error| {
                        CallFailure::Discovery(error, McpCallRequestState::MayHaveStarted)
                    })?;
            } else if !matches!(
                method,
                "notifications/message" | "notifications/progress" | "notifications/cancelled"
            ) {
                return Err(CallFailure::Discovery(
                    DiscoveryError::new(transport.server_id(), DiscoveryErrorKind::InvalidJsonRpc),
                    McpCallRequestState::MayHaveStarted,
                ));
            }
            continue;
        }
        if object.get("id").and_then(Value::as_i64) != Some(3) {
            return Err(CallFailure::Discovery(
                DiscoveryError::new(transport.server_id(), DiscoveryErrorKind::InvalidJsonRpc),
                McpCallRequestState::MayHaveStarted,
            ));
        }
        if object.contains_key("error") {
            return Err(CallFailure::ServerError);
        }
        let result = object.get("result").cloned().ok_or_else(|| {
            CallFailure::Discovery(
                DiscoveryError::new(transport.server_id(), DiscoveryErrorKind::InvalidJsonRpc),
                McpCallRequestState::MayHaveStarted,
            )
        })?;
        let tool = inventory
            .tool_for_callable(call.callable_name())
            .ok_or(CallFailure::Result(McpCallErrorKind::InventoryDrift))?;
        return result::normalize(tool, result, transport.last_message_bytes())
            .map_err(CallFailure::Result);
    }
}

fn discovery_outcome(error: DiscoveryError, request_state: McpCallRequestState) -> McpCallOutcome {
    let kind = match error.kind() {
        DiscoveryErrorKind::SpawnFailed => McpCallErrorKind::SpawnFailed,
        DiscoveryErrorKind::ProcessControlUnavailable => {
            McpCallErrorKind::ProcessControlUnavailable
        }
        DiscoveryErrorKind::Timeout => McpCallErrorKind::Timeout,
        DiscoveryErrorKind::StderrTooLarge => McpCallErrorKind::StderrTooLarge,
        DiscoveryErrorKind::UnexpectedEof => McpCallErrorKind::UnexpectedEof,
        DiscoveryErrorKind::AbnormalExit => McpCallErrorKind::AbnormalExit,
        DiscoveryErrorKind::MessageTooLarge => McpCallErrorKind::MessageTooLarge,
        DiscoveryErrorKind::OutputTooLarge => McpCallErrorKind::OutputTooLarge,
        DiscoveryErrorKind::TooManyMessages => McpCallErrorKind::TooManyMessages,
        DiscoveryErrorKind::InvalidUtf8 => McpCallErrorKind::InvalidUtf8,
        DiscoveryErrorKind::InvalidJsonRpc => McpCallErrorKind::InvalidJsonRpc,
        DiscoveryErrorKind::UnsupportedProtocolVersion => {
            McpCallErrorKind::UnsupportedProtocolVersion
        }
        DiscoveryErrorKind::MissingToolsCapability => McpCallErrorKind::MissingToolsCapability,
        DiscoveryErrorKind::UnsupportedServerRequest => McpCallErrorKind::UnsupportedServerRequest,
        DiscoveryErrorKind::InvalidToolInventory => McpCallErrorKind::InvalidToolInventory,
        DiscoveryErrorKind::ShutdownFailed => McpCallErrorKind::ShutdownFailed,
    };
    McpCallOutcome::Error {
        kind,
        request_state,
    }
}
