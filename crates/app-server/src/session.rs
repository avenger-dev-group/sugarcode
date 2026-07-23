use serde_json::Value;
use serde_json::json;
use sugarcode_app_server_protocol::ERROR_ALREADY_INITIALIZED;
use sugarcode_app_server_protocol::ERROR_INVALID_PARAMS;
use sugarcode_app_server_protocol::ERROR_INVALID_REQUEST;
use sugarcode_app_server_protocol::ERROR_METHOD_NOT_FOUND;
use sugarcode_app_server_protocol::ERROR_NOT_INITIALIZED;
use sugarcode_app_server_protocol::ERROR_PARSE;
use sugarcode_app_server_protocol::ERROR_UNSUPPORTED_PROTOCOL_VERSION;
use sugarcode_app_server_protocol::InitializeParams;
use sugarcode_app_server_protocol::InitializeResponse;
use sugarcode_app_server_protocol::JSON_RPC_VERSION;
use sugarcode_app_server_protocol::JsonRpcError;
use sugarcode_app_server_protocol::JsonRpcErrorObject;
use sugarcode_app_server_protocol::JsonRpcMessage;
use sugarcode_app_server_protocol::JsonRpcResponse;
use sugarcode_app_server_protocol::JsonRpcVersion;
use sugarcode_app_server_protocol::PROTOCOL_VERSION;
use sugarcode_app_server_protocol::PlatformInfo;
use sugarcode_app_server_protocol::RequestId;
use sugarcode_app_server_protocol::ServerCapabilities;
use sugarcode_app_server_protocol::ServerInfo;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    Uninitialized,
    AwaitingInitialized,
    Ready,
}

#[derive(Debug)]
pub struct Session {
    state: SessionState,
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

impl Session {
    pub fn new() -> Self {
        Self {
            state: SessionState::Uninitialized,
        }
    }

    pub fn state(&self) -> SessionState {
        self.state
    }

    pub fn process_line(&mut self, line: &str) -> Option<JsonRpcMessage> {
        let value = match serde_json::from_str::<Value>(line) {
            Ok(value) => value,
            Err(_) => return Some(error(None, ERROR_PARSE, "Parse error", None)),
        };
        self.process_value(value)
    }

    fn process_value(&mut self, value: Value) -> Option<JsonRpcMessage> {
        let Some(object) = value.as_object() else {
            return Some(error(None, ERROR_INVALID_REQUEST, "Invalid Request", None));
        };

        if object.get("jsonrpc").and_then(Value::as_str) != Some(JSON_RPC_VERSION) {
            return Some(error(None, ERROR_INVALID_REQUEST, "Invalid Request", None));
        }

        let Some(method) = object.get("method").and_then(Value::as_str) else {
            return Some(error(None, ERROR_INVALID_REQUEST, "Invalid Request", None));
        };

        let has_id = object.contains_key("id");
        let request_id = if has_id {
            match parse_request_id(object.get("id")) {
                Some(id) => Some(id),
                None => {
                    return Some(error(None, ERROR_INVALID_REQUEST, "Invalid Request", None));
                }
            }
        } else {
            None
        };

        match method {
            "initialize" => {
                let id = request_id?;
                self.initialize(id, object.get("params").cloned())
            }
            "initialized" => {
                if request_id.is_some() {
                    return Some(error(
                        request_id,
                        ERROR_INVALID_REQUEST,
                        "Invalid Request",
                        None,
                    ));
                }
                if params_are_empty(object.get("params"))
                    && self.state == SessionState::AwaitingInitialized
                {
                    self.state = SessionState::Ready;
                }
                None
            }
            _ if request_id.is_none() => None,
            _ if self.state != SessionState::Ready => Some(error(
                request_id,
                ERROR_NOT_INITIALIZED,
                "Not initialized",
                None,
            )),
            _ => Some(error(
                request_id,
                ERROR_METHOD_NOT_FOUND,
                "Method not found",
                None,
            )),
        }
    }

    fn initialize(&mut self, id: RequestId, params: Option<Value>) -> Option<JsonRpcMessage> {
        if self.state != SessionState::Uninitialized {
            return Some(error(
                Some(id),
                ERROR_ALREADY_INITIALIZED,
                "Already initialized",
                None,
            ));
        }

        let params = match params
            .ok_or(())
            .and_then(|value| serde_json::from_value::<InitializeParams>(value).map_err(|_| ()))
        {
            Ok(params) => params,
            Err(()) => {
                return Some(error(
                    Some(id),
                    ERROR_INVALID_PARAMS,
                    "Invalid params",
                    None,
                ));
            }
        };

        if params.protocol_version != PROTOCOL_VERSION {
            return Some(error(
                Some(id),
                ERROR_UNSUPPORTED_PROTOCOL_VERSION,
                "Unsupported protocol version",
                Some(json!({
                    "requested": params.protocol_version,
                    "supported": [PROTOCOL_VERSION],
                })),
            ));
        }

        if params.client_info.name.trim().is_empty() || params.client_info.version.trim().is_empty()
        {
            return Some(error(
                Some(id),
                ERROR_INVALID_PARAMS,
                "Invalid params",
                None,
            ));
        }

        let response = InitializeResponse {
            protocol_version: PROTOCOL_VERSION,
            server_info: ServerInfo {
                name: "sugarcode".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
            },
            platform: PlatformInfo {
                family: std::env::consts::FAMILY.to_string(),
                os: std::env::consts::OS.to_string(),
                arch: std::env::consts::ARCH.to_string(),
            },
            capabilities: ServerCapabilities::default(),
        };
        let result = serde_json::to_value(response).expect("initialize response must serialize");
        self.state = SessionState::AwaitingInitialized;
        Some(JsonRpcMessage::Response(JsonRpcResponse {
            jsonrpc: JsonRpcVersion::V2,
            id,
            result,
        }))
    }
}

fn parse_request_id(value: Option<&Value>) -> Option<RequestId> {
    match value? {
        Value::String(value) => Some(RequestId::String(value.clone())),
        Value::Number(value) => value.as_i64().map(RequestId::Integer),
        _ => None,
    }
}

fn params_are_empty(value: Option<&Value>) -> bool {
    match value {
        None => true,
        Some(Value::Object(object)) => object.is_empty(),
        _ => false,
    }
}

fn error(id: Option<RequestId>, code: i32, message: &str, data: Option<Value>) -> JsonRpcMessage {
    JsonRpcMessage::Error(JsonRpcError {
        jsonrpc: JsonRpcVersion::V2,
        id,
        error: JsonRpcErrorObject {
            code,
            message: message.to_string(),
            data,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn initialize_line(version: u32) -> String {
        json!({
            "jsonrpc": "2.0",
            "id": "init-1",
            "method": "initialize",
            "params": {
                "protocolVersion": version,
                "clientInfo": {
                    "name": "test-client",
                    "version": "1.0.0"
                }
            }
        })
        .to_string()
    }

    #[test]
    fn initialization_requires_acknowledgement() {
        let mut session = Session::new();
        assert!(session.process_line(&initialize_line(1)).is_some());
        assert_eq!(session.state(), SessionState::AwaitingInitialized);

        let response =
            session.process_line(r#"{"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}"#);
        let JsonRpcMessage::Error(error) = response.expect("error response") else {
            panic!("expected error");
        };
        assert_eq!(error.error.code, ERROR_NOT_INITIALIZED);

        assert!(
            session
                .process_line(r#"{"jsonrpc":"2.0","method":"initialized"}"#)
                .is_none()
        );
        assert_eq!(session.state(), SessionState::Ready);
    }

    #[test]
    fn incompatible_version_does_not_commit_session() {
        let mut session = Session::new();
        let response = session.process_line(&initialize_line(2));
        let JsonRpcMessage::Error(error) = response.expect("error response") else {
            panic!("expected error");
        };
        assert_eq!(error.error.code, ERROR_UNSUPPORTED_PROTOCOL_VERSION);
        assert_eq!(session.state(), SessionState::Uninitialized);
    }

    #[test]
    fn duplicate_initialize_is_rejected() {
        let mut session = Session::new();
        session.process_line(&initialize_line(1));
        let response = session.process_line(&initialize_line(1));
        let JsonRpcMessage::Error(error) = response.expect("error response") else {
            panic!("expected error");
        };
        assert_eq!(error.error.code, ERROR_ALREADY_INITIALIZED);
    }
}
