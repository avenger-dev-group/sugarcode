use crate::DiscoveryError;
use crate::DiscoveryErrorKind;
use crate::MCP_PROTOCOL_VERSION;
use crate::inventory::McpServerInventory;
use crate::inventory::StdioServerSpec;
use crate::transport::JsonRpcTransport;
use serde_json::Value;
use serde_json::json;
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) async fn discover(spec: &StdioServerSpec) -> Result<McpServerInventory, DiscoveryError> {
    let server_id = spec.id.clone();
    tokio::time::timeout(DISCOVERY_TIMEOUT, discover_inner(spec))
        .await
        .map_err(|_| DiscoveryError::new(&server_id, DiscoveryErrorKind::Timeout))?
}

async fn discover_inner(spec: &StdioServerSpec) -> Result<McpServerInventory, DiscoveryError> {
    let mut transport = JsonRpcTransport::spawn(spec)?;
    let result = async {
        transport
            .send(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {
                        "name": "sugarcode",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }
            }))
            .await?;
        let initialize = receive_response(&mut transport, 1).await?;
        let (server_name, server_version) = validate_initialize(spec, &initialize)?;
        transport
            .send(&json!({
                "jsonrpc": "2.0",
                "method": "notifications/initialized"
            }))
            .await?;
        transport
            .send(&json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/list",
                "params": {}
            }))
            .await?;
        let list = receive_response(&mut transport, 2).await?;
        let raw_tools = validate_tools_list(spec, &list)?;
        McpServerInventory::from_protocol(&spec.id, server_name, server_version, raw_tools)
    }
    .await;
    let shutdown = transport.shutdown().await;
    match (result, shutdown) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Ok(inventory), Ok(())) => Ok(inventory),
    }
}

async fn receive_response(
    transport: &mut JsonRpcTransport,
    expected_id: i64,
) -> Result<Value, DiscoveryError> {
    loop {
        let message = transport.receive(REQUEST_TIMEOUT).await?;
        let object = message.as_object().ok_or_else(|| invalid_rpc(transport))?;
        if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Err(invalid_rpc(transport));
        }
        if let Some(method) = object.get("method").and_then(Value::as_str) {
            if object.contains_key("id") {
                if method != "ping" {
                    return Err(DiscoveryError::new(
                        transport.server_id(),
                        DiscoveryErrorKind::UnsupportedServerRequest,
                    ));
                }
                let id = object
                    .get("id")
                    .cloned()
                    .ok_or_else(|| invalid_rpc(transport))?;
                transport
                    .send(&json!({"jsonrpc": "2.0", "id": id, "result": {}}))
                    .await?;
            } else if !matches!(
                method,
                "notifications/message" | "notifications/progress" | "notifications/cancelled"
            ) {
                return Err(invalid_rpc(transport));
            }
            continue;
        }
        if object.get("id").and_then(Value::as_i64) != Some(expected_id) {
            return Err(invalid_rpc(transport));
        }
        if object.contains_key("error") || !object.contains_key("result") {
            return Err(invalid_rpc(transport));
        }
        return Ok(object["result"].clone());
    }
}

fn validate_initialize(
    spec: &StdioServerSpec,
    result: &Value,
) -> Result<(String, String), DiscoveryError> {
    let object = result.as_object().ok_or_else(|| invalid(spec))?;
    if object.get("protocolVersion").and_then(Value::as_str) != Some(MCP_PROTOCOL_VERSION) {
        return Err(DiscoveryError::new(
            &spec.id,
            DiscoveryErrorKind::UnsupportedProtocolVersion,
        ));
    }
    if object
        .get("capabilities")
        .and_then(Value::as_object)
        .and_then(|capabilities| capabilities.get("tools"))
        .and_then(Value::as_object)
        .is_none()
    {
        return Err(DiscoveryError::new(
            &spec.id,
            DiscoveryErrorKind::MissingToolsCapability,
        ));
    }
    let server_info = object
        .get("serverInfo")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid(spec))?;
    let name = server_info
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(spec))?
        .to_owned();
    let version = server_info
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(spec))?
        .to_owned();
    Ok((name, version))
}

fn validate_tools_list(
    spec: &StdioServerSpec,
    result: &Value,
) -> Result<Vec<Value>, DiscoveryError> {
    let object = result.as_object().ok_or_else(|| invalid(spec))?;
    if object
        .get("nextCursor")
        .is_some_and(|value| !value.is_null())
    {
        return Err(invalid(spec));
    }
    object
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| invalid(spec))
}

fn invalid(spec: &StdioServerSpec) -> DiscoveryError {
    DiscoveryError::new(&spec.id, DiscoveryErrorKind::InvalidJsonRpc)
}

fn invalid_rpc(transport: &JsonRpcTransport) -> DiscoveryError {
    DiscoveryError::new(transport.server_id(), DiscoveryErrorKind::InvalidJsonRpc)
}
