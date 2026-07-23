use serde_json::Value;
use serde_json::json;
use std::collections::HashSet;
use sugarcode_app_server_protocol::ERROR_ALREADY_INITIALIZED;
use sugarcode_app_server_protocol::ERROR_DUPLICATE_REQUEST;
use sugarcode_app_server_protocol::ERROR_INTERNAL;
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
use sugarcode_app_server_protocol::Thread as PublicThread;
use sugarcode_app_server_protocol::ThreadStartParams;
use sugarcode_app_server_protocol::ThreadStartResponse;
use sugarcode_app_server_protocol::ThreadStartedNotification;
use sugarcode_core::Core;
use sugarcode_core::CoreApi;
use sugarcode_protocol::CoreEventKind;
use sugarcode_protocol::CoreRequestId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    Uninitialized,
    AwaitingInitialized,
    Ready,
}

#[derive(Debug)]
pub struct Session<C = Core> {
    state: SessionState,
    core: C,
    accepted_thread_start_ids: HashSet<RequestId>,
    last_core_request_sequence: u64,
}

impl Default for Session<Core> {
    fn default() -> Self {
        Self::new()
    }
}

impl Session<Core> {
    pub fn new() -> Self {
        Self::with_core(Core::new())
    }
}

impl<C> Session<C>
where
    C: CoreApi,
{
    pub fn with_core(core: C) -> Self {
        Self {
            state: SessionState::Uninitialized,
            core,
            accepted_thread_start_ids: HashSet::new(),
            last_core_request_sequence: 0,
        }
    }

    pub fn state(&self) -> SessionState {
        self.state
    }

    pub fn process_line(&mut self, line: &str) -> Vec<JsonRpcMessage> {
        let value = match serde_json::from_str::<Value>(line) {
            Ok(value) => value,
            Err(_) => return vec![error(None, ERROR_PARSE, "Parse error", None)],
        };
        self.process_value(value)
    }

    fn process_value(&mut self, value: Value) -> Vec<JsonRpcMessage> {
        let Some(object) = value.as_object() else {
            return vec![error(None, ERROR_INVALID_REQUEST, "Invalid Request", None)];
        };

        if object.get("jsonrpc").and_then(Value::as_str) != Some(JSON_RPC_VERSION) {
            return vec![error(None, ERROR_INVALID_REQUEST, "Invalid Request", None)];
        }

        let Some(method) = object.get("method").and_then(Value::as_str) else {
            return vec![error(None, ERROR_INVALID_REQUEST, "Invalid Request", None)];
        };

        let has_id = object.contains_key("id");
        let request_id = if has_id {
            match parse_request_id(object.get("id")) {
                Some(id) => Some(id),
                None => {
                    return vec![error(None, ERROR_INVALID_REQUEST, "Invalid Request", None)];
                }
            }
        } else {
            None
        };

        match method {
            "initialize" => {
                let Some(id) = request_id else {
                    return Vec::new();
                };
                vec![self.initialize(id, object.get("params").cloned())]
            }
            "initialized" => {
                if request_id.is_some() {
                    return vec![error(
                        request_id,
                        ERROR_INVALID_REQUEST,
                        "Invalid Request",
                        None,
                    )];
                }
                if params_are_empty(object.get("params"))
                    && self.state == SessionState::AwaitingInitialized
                {
                    self.state = SessionState::Ready;
                }
                Vec::new()
            }
            "thread/start" => {
                let Some(id) = request_id else {
                    return Vec::new();
                };
                if self.state != SessionState::Ready {
                    return vec![error(
                        Some(id),
                        ERROR_NOT_INITIALIZED,
                        "Not initialized",
                        None,
                    )];
                }
                self.start_thread(id, object.get("params").cloned())
            }
            _ if request_id.is_none() => Vec::new(),
            _ if self.state != SessionState::Ready => vec![error(
                request_id,
                ERROR_NOT_INITIALIZED,
                "Not initialized",
                None,
            )],
            _ => vec![error(
                request_id,
                ERROR_METHOD_NOT_FOUND,
                "Method not found",
                None,
            )],
        }
    }

    fn initialize(&mut self, id: RequestId, params: Option<Value>) -> JsonRpcMessage {
        if self.state != SessionState::Uninitialized {
            return error(
                Some(id),
                ERROR_ALREADY_INITIALIZED,
                "Already initialized",
                None,
            );
        }

        let params = match params
            .ok_or(())
            .and_then(|value| serde_json::from_value::<InitializeParams>(value).map_err(|_| ()))
        {
            Ok(params) => params,
            Err(()) => {
                return error(Some(id), ERROR_INVALID_PARAMS, "Invalid params", None);
            }
        };

        if params.protocol_version != PROTOCOL_VERSION {
            return error(
                Some(id),
                ERROR_UNSUPPORTED_PROTOCOL_VERSION,
                "Unsupported protocol version",
                Some(json!({
                    "requested": params.protocol_version,
                    "supported": [PROTOCOL_VERSION],
                })),
            );
        }

        if params.client_info.name.trim().is_empty() || params.client_info.version.trim().is_empty()
        {
            return error(Some(id), ERROR_INVALID_PARAMS, "Invalid params", None);
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
        JsonRpcMessage::Response(JsonRpcResponse {
            jsonrpc: JsonRpcVersion::V2,
            id,
            result,
        })
    }

    fn start_thread(&mut self, id: RequestId, params: Option<Value>) -> Vec<JsonRpcMessage> {
        if let Some(params) = params
            && serde_json::from_value::<ThreadStartParams>(params).is_err()
        {
            return vec![error(
                Some(id),
                ERROR_INVALID_PARAMS,
                "Invalid params",
                None,
            )];
        }

        if self.accepted_thread_start_ids.contains(&id) {
            return vec![error(
                Some(id),
                ERROR_DUPLICATE_REQUEST,
                "Duplicate request id",
                None,
            )];
        }

        let Some(sequence) = self.last_core_request_sequence.checked_add(1) else {
            return vec![error(Some(id), ERROR_INTERNAL, "Internal error", None)];
        };
        let core_request_id = CoreRequestId::new(sequence);
        self.last_core_request_sequence = sequence;
        self.accepted_thread_start_ids.insert(id.clone());

        let event = match self.core.start_thread(core_request_id) {
            Ok(event) if event.request_id == core_request_id => event,
            Ok(_) | Err(_) => {
                return vec![error(Some(id), ERROR_INTERNAL, "Internal error", None)];
            }
        };

        let CoreEventKind::ThreadStarted { thread_id } = event.kind;
        let thread = PublicThread {
            id: thread_id.into_string(),
        };
        let response = ThreadStartResponse {
            thread: thread.clone(),
        };
        let notification = ThreadStartedNotification { thread };

        vec![
            JsonRpcMessage::Response(JsonRpcResponse {
                jsonrpc: JsonRpcVersion::V2,
                id,
                result: serde_json::to_value(response)
                    .expect("thread/start response must serialize"),
            }),
            JsonRpcMessage::Notification(sugarcode_app_server_protocol::JsonRpcNotification {
                jsonrpc: JsonRpcVersion::V2,
                method: "thread/started".to_string(),
                params: Some(
                    serde_json::to_value(notification)
                        .expect("thread/started notification must serialize"),
                ),
            }),
        ]
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
    use sugarcode_core::CoreError;
    use sugarcode_protocol::CoreEvent;
    use sugarcode_protocol::ThreadId;

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
        assert_eq!(session.process_line(&initialize_line(1)).len(), 1);
        assert_eq!(session.state(), SessionState::AwaitingInitialized);

        let mut response =
            session.process_line(r#"{"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}"#);
        let JsonRpcMessage::Error(error) = response.pop().expect("error response") else {
            panic!("expected error");
        };
        assert_eq!(error.error.code, ERROR_NOT_INITIALIZED);

        assert!(
            session
                .process_line(r#"{"jsonrpc":"2.0","method":"initialized"}"#)
                .is_empty()
        );
        assert_eq!(session.state(), SessionState::Ready);
    }

    #[test]
    fn incompatible_version_does_not_commit_session() {
        let mut session = Session::new();
        let mut response = session.process_line(&initialize_line(2));
        let JsonRpcMessage::Error(error) = response.pop().expect("error response") else {
            panic!("expected error");
        };
        assert_eq!(error.error.code, ERROR_UNSUPPORTED_PROTOCOL_VERSION);
        assert_eq!(session.state(), SessionState::Uninitialized);
    }

    #[test]
    fn duplicate_initialize_is_rejected() {
        let mut session = Session::new();
        session.process_line(&initialize_line(1));
        let mut response = session.process_line(&initialize_line(1));
        let JsonRpcMessage::Error(error) = response.pop().expect("error response") else {
            panic!("expected error");
        };
        assert_eq!(error.error.code, ERROR_ALREADY_INITIALIZED);
    }

    #[test]
    fn thread_start_returns_response_then_notification() {
        let mut session = ready_session(Core::new());

        let messages =
            session.process_line(r#"{"jsonrpc":"2.0","id":"start-1","method":"thread/start"}"#);

        assert_eq!(
            messages
                .into_iter()
                .map(|message| serde_json::to_value(message).expect("message serializes"))
                .collect::<Vec<_>>(),
            vec![
                json!({
                    "jsonrpc": "2.0",
                    "id": "start-1",
                    "result": {
                        "thread": {
                            "id": "thr_0000000000000001"
                        }
                    }
                }),
                json!({
                    "jsonrpc": "2.0",
                    "method": "thread/started",
                    "params": {
                        "thread": {
                            "id": "thr_0000000000000001"
                        }
                    }
                }),
            ]
        );
    }

    #[test]
    fn invalid_params_do_not_reach_core() {
        let mut session = ready_session(Core::new());

        let mut invalid = session.process_line(
            r#"{"jsonrpc":"2.0","id":"bad","method":"thread/start","params":{"model":"later"}}"#,
        );
        let JsonRpcMessage::Error(error) = invalid.pop().expect("invalid params response") else {
            panic!("expected error");
        };
        assert_eq!(error.error.code, ERROR_INVALID_PARAMS);

        let messages = session
            .process_line(r#"{"jsonrpc":"2.0","id":"good","method":"thread/start","params":{}}"#);
        assert_eq!(response_thread_id(&messages), "thr_0000000000000001");
    }

    #[test]
    fn duplicate_accepted_request_id_does_not_create_another_thread() {
        let mut session = ready_session(Core::new());

        let first = session.process_line(
            r#"{"jsonrpc":"2.0","id":"start-1","method":"thread/start","params":{}}"#,
        );
        assert_eq!(response_thread_id(&first), "thr_0000000000000001");

        let mut duplicate = session.process_line(
            r#"{"jsonrpc":"2.0","id":"start-1","method":"thread/start","params":{}}"#,
        );
        let JsonRpcMessage::Error(error) = duplicate.pop().expect("duplicate response") else {
            panic!("expected error");
        };
        assert_eq!(error.error.code, ERROR_DUPLICATE_REQUEST);

        let second = session.process_line(
            r#"{"jsonrpc":"2.0","id":"start-2","method":"thread/start","params":{}}"#,
        );
        assert_eq!(response_thread_id(&second), "thr_0000000000000002");
    }

    #[test]
    fn core_failure_returns_internal_error_without_notification() {
        let mut session = ready_session(FailingCore);

        let mut messages = session.process_line(
            r#"{"jsonrpc":"2.0","id":"start-1","method":"thread/start","params":{}}"#,
        );

        assert_eq!(messages.len(), 1);
        let JsonRpcMessage::Error(error) = messages.pop().expect("internal error response") else {
            panic!("expected error");
        };
        assert_eq!(error.id, Some(RequestId::String("start-1".to_string())));
        assert_eq!(error.error.code, ERROR_INTERNAL);
        assert_eq!(error.error.message, "Internal error");
        assert!(error.error.data.is_none());
    }

    #[test]
    fn mismatched_core_request_id_returns_internal_error() {
        let mut session = ready_session(MismatchedCore);

        let mut messages = session.process_line(
            r#"{"jsonrpc":"2.0","id":"start-1","method":"thread/start","params":{}}"#,
        );

        assert_eq!(messages.len(), 1);
        let JsonRpcMessage::Error(error) = messages.pop().expect("internal error response") else {
            panic!("expected error");
        };
        assert_eq!(error.error.code, ERROR_INTERNAL);
    }

    fn ready_session<C>(core: C) -> Session<C>
    where
        C: CoreApi,
    {
        let mut session = Session::with_core(core);
        assert_eq!(session.process_line(&initialize_line(1)).len(), 1);
        assert!(
            session
                .process_line(r#"{"jsonrpc":"2.0","method":"initialized"}"#)
                .is_empty()
        );
        assert_eq!(session.state(), SessionState::Ready);
        session
    }

    fn response_thread_id(messages: &[JsonRpcMessage]) -> &str {
        let JsonRpcMessage::Response(response) = &messages[0] else {
            panic!("expected response first");
        };
        response
            .result
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str)
            .expect("response thread id")
    }

    struct FailingCore;

    impl CoreApi for FailingCore {
        fn start_thread(&mut self, _request_id: CoreRequestId) -> Result<CoreEvent, CoreError> {
            Err(CoreError::Internal("sensitive failure".to_string()))
        }
    }

    struct MismatchedCore;

    impl CoreApi for MismatchedCore {
        fn start_thread(&mut self, request_id: CoreRequestId) -> Result<CoreEvent, CoreError> {
            Ok(CoreEvent {
                request_id: CoreRequestId::new(request_id.get() + 1),
                kind: CoreEventKind::ThreadStarted {
                    thread_id: ThreadId::new("thr_wrong_request"),
                },
            })
        }
    }
}
