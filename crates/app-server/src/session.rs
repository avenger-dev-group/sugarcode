use crate::event_mapping::map_thread_snapshot;
use crate::event_mapping::map_turn_lifecycle;
use serde_json::Value;
use serde_json::json;
use std::collections::HashSet;
use sugarcode_app_server_protocol::DEFAULT_THREAD_LIST_LIMIT;
use sugarcode_app_server_protocol::DEFAULT_THREAD_SEARCH_LIMIT;
use sugarcode_app_server_protocol::ERROR_ALREADY_INITIALIZED;
use sugarcode_app_server_protocol::ERROR_DUPLICATE_REQUEST;
use sugarcode_app_server_protocol::ERROR_INTERNAL;
use sugarcode_app_server_protocol::ERROR_INVALID_PARAMS;
use sugarcode_app_server_protocol::ERROR_INVALID_REQUEST;
use sugarcode_app_server_protocol::ERROR_METHOD_NOT_FOUND;
use sugarcode_app_server_protocol::ERROR_NOT_INITIALIZED;
use sugarcode_app_server_protocol::ERROR_PARSE;
use sugarcode_app_server_protocol::ERROR_STATE_UNAVAILABLE;
use sugarcode_app_server_protocol::ERROR_THREAD_NOT_FOUND;
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
use sugarcode_app_server_protocol::SUGARCODE_PRODUCT_VERSION;
use sugarcode_app_server_protocol::ServerCapabilities;
use sugarcode_app_server_protocol::ServerInfo;
use sugarcode_app_server_protocol::Thread as PublicThread;
use sugarcode_app_server_protocol::ThreadArchiveParams;
use sugarcode_app_server_protocol::ThreadArchiveResponse;
use sugarcode_app_server_protocol::ThreadListParams;
use sugarcode_app_server_protocol::ThreadListResponse;
use sugarcode_app_server_protocol::ThreadResumeParams;
use sugarcode_app_server_protocol::ThreadSearchParams;
use sugarcode_app_server_protocol::ThreadSearchResponse;
use sugarcode_app_server_protocol::ThreadStartParams;
use sugarcode_app_server_protocol::ThreadStartResponse;
use sugarcode_app_server_protocol::ThreadStartedNotification;
use sugarcode_app_server_protocol::TurnStartParams;
use sugarcode_app_server_protocol::TurnStartResponse;
use sugarcode_core::Core;
use sugarcode_core::CoreApi;
use sugarcode_core::CoreError;
use sugarcode_protocol::CoreEventKind;
use sugarcode_protocol::CoreRequestId;
use sugarcode_protocol::ThreadId;

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
    accepted_request_ids: HashSet<RequestId>,
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
            accepted_request_ids: HashSet::new(),
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
            "thread/list" => {
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
                self.list_threads(id, object.get("params").cloned())
            }
            "thread/archive" => {
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
                self.archive_thread(id, object.get("params").cloned())
            }
            "thread/search" => {
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
                self.search_threads(id, object.get("params").cloned())
            }
            "thread/resume" => {
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
                self.resume_thread(id, object.get("params").cloned())
            }
            "turn/start" => {
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
                self.start_turn(id, object.get("params").cloned())
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
                version: SUGARCODE_PRODUCT_VERSION.to_string(),
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

        if self.accepted_request_ids.contains(&id) {
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
        self.accepted_request_ids.insert(id.clone());

        let event = match self.core.start_thread(core_request_id) {
            Ok(event) if event.request_id == core_request_id => event,
            Err(CoreError::StateUnavailable) => {
                return vec![error(
                    Some(id),
                    ERROR_STATE_UNAVAILABLE,
                    "State unavailable",
                    None,
                )];
            }
            Ok(_) | Err(_) => {
                return vec![error(Some(id), ERROR_INTERNAL, "Internal error", None)];
            }
        };

        let thread_id = match event.kind {
            CoreEventKind::ThreadStarted { thread_id } => thread_id,
            _ => {
                return vec![error(Some(id), ERROR_INTERNAL, "Internal error", None)];
            }
        };
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

    fn resume_thread(&mut self, id: RequestId, params: Option<Value>) -> Vec<JsonRpcMessage> {
        let params = match params
            .ok_or(())
            .and_then(|value| serde_json::from_value::<ThreadResumeParams>(value).map_err(|_| ()))
        {
            Ok(params) => params,
            Err(()) => {
                return vec![error(
                    Some(id),
                    ERROR_INVALID_PARAMS,
                    "Invalid params",
                    None,
                )];
            }
        };
        if self.accepted_request_ids.contains(&id) {
            return vec![error(
                Some(id),
                ERROR_DUPLICATE_REQUEST,
                "Duplicate request id",
                None,
            )];
        }

        let thread_id = ThreadId::new(params.thread_id.clone());
        let snapshot = match self.core.resume_thread(&thread_id) {
            Ok(snapshot) => snapshot,
            Err(CoreError::ThreadNotFound(_)) => {
                return vec![error(
                    Some(id),
                    ERROR_THREAD_NOT_FOUND,
                    "Thread not found",
                    Some(json!({ "threadId": params.thread_id })),
                )];
            }
            Err(CoreError::StateUnavailable) => {
                return vec![error(
                    Some(id),
                    ERROR_STATE_UNAVAILABLE,
                    "State unavailable",
                    None,
                )];
            }
            Err(_) => {
                return vec![error(Some(id), ERROR_INTERNAL, "Internal error", None)];
            }
        };
        self.accepted_request_ids.insert(id.clone());
        let response = map_thread_snapshot(snapshot);
        vec![JsonRpcMessage::Response(JsonRpcResponse {
            jsonrpc: JsonRpcVersion::V2,
            id,
            result: serde_json::to_value(response).expect("thread/resume response must serialize"),
        })]
    }

    fn archive_thread(&mut self, id: RequestId, params: Option<Value>) -> Vec<JsonRpcMessage> {
        let params = match params
            .ok_or(())
            .and_then(|value| serde_json::from_value::<ThreadArchiveParams>(value).map_err(|_| ()))
        {
            Ok(params) => params,
            Err(()) => {
                return vec![error(
                    Some(id),
                    ERROR_INVALID_PARAMS,
                    "Invalid params",
                    None,
                )];
            }
        };
        if self.accepted_request_ids.contains(&id) {
            return vec![error(
                Some(id),
                ERROR_DUPLICATE_REQUEST,
                "Duplicate request id",
                None,
            )];
        }

        let thread_id = ThreadId::new(params.thread_id.clone());
        match self.core.archive_thread(&thread_id) {
            Ok(()) => {
                self.accepted_request_ids.insert(id.clone());
                let response = ThreadArchiveResponse {};
                vec![JsonRpcMessage::Response(JsonRpcResponse {
                    jsonrpc: JsonRpcVersion::V2,
                    id,
                    result: serde_json::to_value(response)
                        .expect("thread/archive response must serialize"),
                })]
            }
            Err(CoreError::ThreadNotFound(_)) => vec![error(
                Some(id),
                ERROR_THREAD_NOT_FOUND,
                "Thread not found",
                Some(json!({ "threadId": params.thread_id })),
            )],
            Err(CoreError::StateUnavailable) => {
                self.accepted_request_ids.insert(id.clone());
                vec![error(
                    Some(id),
                    ERROR_STATE_UNAVAILABLE,
                    "State unavailable",
                    None,
                )]
            }
            Err(_) => {
                self.accepted_request_ids.insert(id.clone());
                vec![error(Some(id), ERROR_INTERNAL, "Internal error", None)]
            }
        }
    }

    fn list_threads(&mut self, id: RequestId, params: Option<Value>) -> Vec<JsonRpcMessage> {
        let params = match params {
            Some(value) => match serde_json::from_value::<ThreadListParams>(value) {
                Ok(params) => params,
                Err(_) => {
                    return vec![error(
                        Some(id),
                        ERROR_INVALID_PARAMS,
                        "Invalid params",
                        None,
                    )];
                }
            },
            None => ThreadListParams::default(),
        };
        if self.accepted_request_ids.contains(&id) {
            return vec![error(
                Some(id),
                ERROR_DUPLICATE_REQUEST,
                "Duplicate request id",
                None,
            )];
        }

        let cursor = params.cursor.as_deref().map(ThreadId::new);
        let limit = params.limit.unwrap_or(DEFAULT_THREAD_LIST_LIMIT) as usize;
        let page = match self.core.list_threads(cursor.as_ref(), limit) {
            Ok(page) => page,
            Err(CoreError::StateUnavailable) => {
                return vec![error(
                    Some(id),
                    ERROR_STATE_UNAVAILABLE,
                    "State unavailable",
                    None,
                )];
            }
            Err(_) => {
                return vec![error(Some(id), ERROR_INTERNAL, "Internal error", None)];
            }
        };
        self.accepted_request_ids.insert(id.clone());
        let response = ThreadListResponse {
            data: page
                .data
                .into_iter()
                .map(|summary| PublicThread {
                    id: summary.id.into_string(),
                })
                .collect(),
            next_cursor: page.next_cursor.map(ThreadId::into_string),
        };
        vec![JsonRpcMessage::Response(JsonRpcResponse {
            jsonrpc: JsonRpcVersion::V2,
            id,
            result: serde_json::to_value(response).expect("thread/list response must serialize"),
        })]
    }

    fn search_threads(&mut self, id: RequestId, params: Option<Value>) -> Vec<JsonRpcMessage> {
        let params = match params
            .ok_or(())
            .and_then(|value| serde_json::from_value::<ThreadSearchParams>(value).map_err(|_| ()))
        {
            Ok(params) => params,
            Err(()) => {
                return vec![error(
                    Some(id),
                    ERROR_INVALID_PARAMS,
                    "Invalid params",
                    None,
                )];
            }
        };
        if self.accepted_request_ids.contains(&id) {
            return vec![error(
                Some(id),
                ERROR_DUPLICATE_REQUEST,
                "Duplicate request id",
                None,
            )];
        }

        let cursor = params.cursor.as_deref().map(ThreadId::new);
        let limit = params.limit.unwrap_or(DEFAULT_THREAD_SEARCH_LIMIT) as usize;
        let page = match self
            .core
            .search_threads(&params.query, cursor.as_ref(), limit)
        {
            Ok(page) => page,
            Err(CoreError::StateUnavailable) => {
                return vec![error(
                    Some(id),
                    ERROR_STATE_UNAVAILABLE,
                    "State unavailable",
                    None,
                )];
            }
            Err(_) => {
                return vec![error(Some(id), ERROR_INTERNAL, "Internal error", None)];
            }
        };
        self.accepted_request_ids.insert(id.clone());
        let response = ThreadSearchResponse {
            data: page
                .data
                .into_iter()
                .map(|summary| PublicThread {
                    id: summary.id.into_string(),
                })
                .collect(),
            next_cursor: page.next_cursor.map(ThreadId::into_string),
        };
        vec![JsonRpcMessage::Response(JsonRpcResponse {
            jsonrpc: JsonRpcVersion::V2,
            id,
            result: serde_json::to_value(response).expect("thread/search response must serialize"),
        })]
    }

    fn start_turn(&mut self, id: RequestId, params: Option<Value>) -> Vec<JsonRpcMessage> {
        let params = match params
            .ok_or(())
            .and_then(|value| serde_json::from_value::<TurnStartParams>(value).map_err(|_| ()))
        {
            Ok(params) => params,
            Err(()) => {
                return vec![error(
                    Some(id),
                    ERROR_INVALID_PARAMS,
                    "Invalid params",
                    None,
                )];
            }
        };

        if self.accepted_request_ids.contains(&id) {
            return vec![error(
                Some(id),
                ERROR_DUPLICATE_REQUEST,
                "Duplicate request id",
                None,
            )];
        }

        let thread_id = ThreadId::new(params.thread_id.clone());
        if !self.core.contains_thread(&thread_id) {
            return vec![error(
                Some(id),
                ERROR_THREAD_NOT_FOUND,
                "Thread not found",
                Some(json!({ "threadId": params.thread_id })),
            )];
        }

        let Some(sequence) = self.last_core_request_sequence.checked_add(1) else {
            return vec![error(Some(id), ERROR_INTERNAL, "Internal error", None)];
        };
        let core_request_id = CoreRequestId::new(sequence);
        self.last_core_request_sequence = sequence;
        self.accepted_request_ids.insert(id.clone());

        let events = match self.core.start_turn(core_request_id, thread_id.clone()) {
            Ok(events) => events,
            Err(CoreError::StateUnavailable) => {
                return vec![error(
                    Some(id),
                    ERROR_STATE_UNAVAILABLE,
                    "State unavailable",
                    None,
                )];
            }
            Err(_) => {
                return vec![error(Some(id), ERROR_INTERNAL, "Internal error", None)];
            }
        };

        let mapped = match map_turn_lifecycle(events, core_request_id, &thread_id) {
            Ok(mapped) => mapped,
            Err(_) => {
                return vec![error(Some(id), ERROR_INTERNAL, "Internal error", None)];
            }
        };
        let response = match serde_json::to_value(TurnStartResponse { turn: mapped.turn }) {
            Ok(response) => response,
            Err(_) => return vec![error(Some(id), ERROR_INTERNAL, "Internal error", None)],
        };
        let mut messages = Vec::with_capacity(1 + mapped.notifications.len());
        messages.push(JsonRpcMessage::Response(JsonRpcResponse {
            jsonrpc: JsonRpcVersion::V2,
            id,
            result: response,
        }));
        messages.extend(mapped.notifications);
        messages
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
    use sugarcode_protocol::CoreItemKind;
    use sugarcode_protocol::CoreItemSnapshot;
    use sugarcode_protocol::ItemId;
    use sugarcode_protocol::TurnId;

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
    fn thread_resume_returns_the_complete_snapshot_without_notifications() {
        let mut session = ready_session(Core::new());
        session.process_line(
            r#"{"jsonrpc":"2.0","id":"thread-1","method":"thread/start","params":{}}"#,
        );
        session.process_line(
            r#"{"jsonrpc":"2.0","id":"turn-1","method":"turn/start","params":{"threadId":"thr_0000000000000001"}}"#,
        );

        let messages = session.process_line(
            r#"{"jsonrpc":"2.0","id":"resume-1","method":"thread/resume","params":{"threadId":"thr_0000000000000001"}}"#,
        );
        assert_eq!(messages.len(), 1);
        assert_eq!(
            serde_json::to_value(&messages[0]).expect("message serializes"),
            json!({
                "jsonrpc": "2.0",
                "id": "resume-1",
                "result": {
                    "thread": {"id": "thr_0000000000000001"},
                    "turns": [{
                        "id": "turn_0000000000000001",
                        "status": "completed",
                        "items": [{
                            "type": "agentMessage",
                            "id": "item_0000000000000001",
                            "text": "SugarCode deterministic response."
                        }]
                    }]
                }
            })
        );
    }

    #[test]
    fn thread_archive_excludes_the_thread_and_is_idempotent() {
        let mut session = ready_session(Core::new());
        session.process_line(
            r#"{"jsonrpc":"2.0","id":"thread-1","method":"thread/start","params":{}}"#,
        );
        session.process_line(
            r#"{"jsonrpc":"2.0","id":"turn-1","method":"turn/start","params":{"threadId":"thr_0000000000000001"}}"#,
        );

        for request_id in ["archive-1", "archive-2"] {
            let messages = session.process_line(
                &json!({
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "thread/archive",
                    "params": {"threadId": "thr_0000000000000001"}
                })
                .to_string(),
            );
            assert_eq!(
                serde_json::to_value(&messages[0]).expect("message serializes"),
                json!({"jsonrpc": "2.0", "id": request_id, "result": {}})
            );
        }

        let list = session
            .process_line(r#"{"jsonrpc":"2.0","id":"list","method":"thread/list","params":{}}"#);
        let JsonRpcMessage::Response(list) = &list[0] else {
            panic!("expected list response");
        };
        assert_eq!(list.result, json!({"data": [], "nextCursor": null}));

        let search = session.process_line(
            r#"{"jsonrpc":"2.0","id":"search","method":"thread/search","params":{"query":"SugarCode"}}"#,
        );
        let JsonRpcMessage::Response(search) = &search[0] else {
            panic!("expected search response");
        };
        assert_eq!(search.result, json!({"data": [], "nextCursor": null}));

        for method in ["thread/resume", "turn/start"] {
            let messages = session.process_line(
                &json!({
                    "jsonrpc": "2.0",
                    "id": format!("{method}-after-archive"),
                    "method": method,
                    "params": {"threadId": "thr_0000000000000001"}
                })
                .to_string(),
            );
            let JsonRpcMessage::Error(error) = &messages[0] else {
                panic!("expected not found error");
            };
            assert_eq!(error.error.code, ERROR_THREAD_NOT_FOUND);
        }
    }

    #[test]
    fn thread_archive_rejects_invalid_and_missing_targets_without_consuming_request_id() {
        let mut session = ready_session(Core::new());

        for params in [
            json!({"threadId": "thr_missing"}),
            json!({"threadId": "thr_0000000000000001", "path": "/tmp"}),
        ] {
            let messages = session.process_line(
                &json!({
                    "jsonrpc": "2.0",
                    "id": "retry",
                    "method": "thread/archive",
                    "params": params
                })
                .to_string(),
            );
            let JsonRpcMessage::Error(error) = &messages[0] else {
                panic!("expected archive error");
            };
            assert!(
                error.error.code == ERROR_INVALID_PARAMS
                    || error.error.code == ERROR_THREAD_NOT_FOUND
            );
        }

        session.process_line(
            r#"{"jsonrpc":"2.0","id":"thread-1","method":"thread/start","params":{}}"#,
        );
        let success = session.process_line(
            r#"{"jsonrpc":"2.0","id":"retry","method":"thread/archive","params":{"threadId":"thr_0000000000000001"}}"#,
        );
        assert!(matches!(success[0], JsonRpcMessage::Response(_)));

        let duplicate = session.process_line(
            r#"{"jsonrpc":"2.0","id":"retry","method":"thread/archive","params":{"threadId":"thr_0000000000000001"}}"#,
        );
        let JsonRpcMessage::Error(error) = &duplicate[0] else {
            panic!("expected duplicate error");
        };
        assert_eq!(error.error.code, ERROR_DUPLICATE_REQUEST);
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
    fn turn_start_returns_response_then_complete_lifecycle() {
        let mut session = ready_session(Core::new());
        let thread_messages =
            session.process_line(r#"{"jsonrpc":"2.0","id":"thread-1","method":"thread/start"}"#);
        let thread_id = response_thread_id(&thread_messages).to_string();

        let messages = session.process_line(
            &json!({
                "jsonrpc": "2.0",
                "id": "turn-1",
                "method": "turn/start",
                "params": {
                    "threadId": thread_id
                }
            })
            .to_string(),
        );

        assert_eq!(
            messages
                .into_iter()
                .map(|message| serde_json::to_value(message).expect("message serializes"))
                .collect::<Vec<_>>(),
            vec![
                json!({
                    "jsonrpc": "2.0",
                    "id": "turn-1",
                    "result": {
                        "turn": {
                            "id": "turn_0000000000000001",
                            "status": "inProgress"
                        }
                    }
                }),
                json!({
                    "jsonrpc": "2.0",
                    "method": "turn/started",
                    "params": {
                        "threadId": "thr_0000000000000001",
                        "turn": {
                            "id": "turn_0000000000000001",
                            "status": "inProgress"
                        }
                    }
                }),
                json!({
                    "jsonrpc": "2.0",
                    "method": "item/started",
                    "params": {
                        "threadId": "thr_0000000000000001",
                        "turnId": "turn_0000000000000001",
                        "item": {
                            "type": "agentMessage",
                            "id": "item_0000000000000001",
                            "text": ""
                        }
                    }
                }),
                json!({
                    "jsonrpc": "2.0",
                    "method": "item/agentMessage/delta",
                    "params": {
                        "threadId": "thr_0000000000000001",
                        "turnId": "turn_0000000000000001",
                        "itemId": "item_0000000000000001",
                        "delta": "SugarCode deterministic response."
                    }
                }),
                json!({
                    "jsonrpc": "2.0",
                    "method": "item/completed",
                    "params": {
                        "threadId": "thr_0000000000000001",
                        "turnId": "turn_0000000000000001",
                        "item": {
                            "type": "agentMessage",
                            "id": "item_0000000000000001",
                            "text": "SugarCode deterministic response."
                        }
                    }
                }),
                json!({
                    "jsonrpc": "2.0",
                    "method": "turn/completed",
                    "params": {
                        "threadId": "thr_0000000000000001",
                        "turn": {
                            "id": "turn_0000000000000001",
                            "status": "completed"
                        }
                    }
                }),
            ]
        );
    }

    #[test]
    fn turn_start_rejects_invalid_params_without_accepting_the_request_id() {
        let mut session = ready_session(Core::new());
        let thread_messages =
            session.process_line(r#"{"jsonrpc":"2.0","id":"thread-1","method":"thread/start"}"#);
        let thread_id = response_thread_id(&thread_messages).to_string();

        let mut invalid = session.process_line(
            r#"{"jsonrpc":"2.0","id":"retry","method":"turn/start","params":{"threadId":" "}}"#,
        );
        let JsonRpcMessage::Error(error) = invalid.pop().expect("invalid params response") else {
            panic!("expected error");
        };
        assert_eq!(error.error.code, ERROR_INVALID_PARAMS);

        let messages = session.process_line(
            &json!({
                "jsonrpc": "2.0",
                "id": "retry",
                "method": "turn/start",
                "params": {
                    "threadId": thread_id
                }
            })
            .to_string(),
        );
        assert_eq!(response_turn_id(&messages), "turn_0000000000000001");
    }

    #[test]
    fn turn_start_rejects_missing_thread_without_accepting_the_request_id() {
        let mut session = ready_session(Core::new());

        let mut missing = session.process_line(
            r#"{"jsonrpc":"2.0","id":"retry","method":"turn/start","params":{"threadId":"thr_missing"}}"#,
        );
        let JsonRpcMessage::Error(error) = missing.pop().expect("missing thread response") else {
            panic!("expected error");
        };
        assert_eq!(error.error.code, ERROR_THREAD_NOT_FOUND);
        assert_eq!(error.error.data, Some(json!({"threadId": "thr_missing"})));

        let thread_messages =
            session.process_line(r#"{"jsonrpc":"2.0","id":"thread-1","method":"thread/start"}"#);
        let thread_id = response_thread_id(&thread_messages).to_string();
        let messages = session.process_line(
            &json!({
                "jsonrpc": "2.0",
                "id": "retry",
                "method": "turn/start",
                "params": {
                    "threadId": thread_id
                }
            })
            .to_string(),
        );
        assert_eq!(response_turn_id(&messages), "turn_0000000000000001");
    }

    #[test]
    fn starts_consecutive_turns_in_the_same_thread_and_turns_in_other_threads() {
        let mut session = ready_session(Core::new());
        let first_thread =
            session.process_line(r#"{"jsonrpc":"2.0","id":"thread-1","method":"thread/start"}"#);
        let first_thread_id = response_thread_id(&first_thread).to_string();
        let second_thread =
            session.process_line(r#"{"jsonrpc":"2.0","id":"thread-2","method":"thread/start"}"#);
        let second_thread_id = response_thread_id(&second_thread).to_string();

        for (id, thread_id, expected_turn_id) in [
            ("turn-1", first_thread_id.as_str(), "turn_0000000000000001"),
            ("turn-2", first_thread_id.as_str(), "turn_0000000000000002"),
            ("turn-3", second_thread_id.as_str(), "turn_0000000000000003"),
        ] {
            let messages = session.process_line(
                &json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "method": "turn/start",
                    "params": {
                        "threadId": thread_id
                    }
                })
                .to_string(),
            );
            assert_eq!(response_turn_id(&messages), expected_turn_id);
            assert_eq!(
                notification_thread_id(&messages),
                thread_id,
                "turn notification must identify its owning thread"
            );
        }
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
    fn accepted_request_ids_are_shared_across_lifecycle_methods() {
        let mut session = ready_session(Core::new());

        let first = session
            .process_line(r#"{"jsonrpc":"2.0","id":"shared","method":"thread/start","params":{}}"#);
        let thread_id = response_thread_id(&first).to_string();

        let mut duplicate = session.process_line(
            &json!({
                "jsonrpc": "2.0",
                "id": "shared",
                "method": "turn/start",
                "params": {
                    "threadId": thread_id
                }
            })
            .to_string(),
        );
        let JsonRpcMessage::Error(error) = duplicate.pop().expect("duplicate response") else {
            panic!("expected error");
        };
        assert_eq!(error.error.code, ERROR_DUPLICATE_REQUEST);

        let turn = session.process_line(
            r#"{"jsonrpc":"2.0","id":"turn-1","method":"turn/start","params":{"threadId":"thr_0000000000000001"}}"#,
        );
        assert_eq!(response_turn_id(&turn), "turn_0000000000000001");
        let mut repeated = session.process_line(
            r#"{"jsonrpc":"2.0","id":"turn-1","method":"turn/start","params":{"threadId":"thr_0000000000000001"}}"#,
        );
        let JsonRpcMessage::Error(error) = repeated.pop().expect("duplicate response") else {
            panic!("expected error");
        };
        assert_eq!(error.error.code, ERROR_DUPLICATE_REQUEST);

        let second_turn = session.process_line(
            r#"{"jsonrpc":"2.0","id":"turn-2","method":"turn/start","params":{"threadId":"thr_0000000000000001"}}"#,
        );
        assert_eq!(response_turn_id(&second_turn), "turn_0000000000000002");
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
    fn durable_state_failures_use_the_stable_public_error_without_details() {
        for request in [
            r#"{"jsonrpc":"2.0","id":"start","method":"thread/start","params":{}}"#,
            r#"{"jsonrpc":"2.0","id":"archive","method":"thread/archive","params":{"threadId":"thr_0000000000000001"}}"#,
            r#"{"jsonrpc":"2.0","id":"resume","method":"thread/resume","params":{"threadId":"thr_0000000000000001"}}"#,
            r#"{"jsonrpc":"2.0","id":"turn","method":"turn/start","params":{"threadId":"thr_0000000000000001"}}"#,
        ] {
            let mut session = ready_session(StateUnavailableCore);
            let mut messages = session.process_line(request);
            assert_eq!(messages.len(), 1);
            let JsonRpcMessage::Error(error) = messages.pop().expect("state error response") else {
                panic!("expected error");
            };
            assert_eq!(error.error.code, ERROR_STATE_UNAVAILABLE);
            assert_eq!(error.error.message, "State unavailable");
            assert!(error.error.data.is_none());
        }
    }

    #[test]
    fn an_uncertain_archive_attempt_consumes_its_request_id() {
        let mut session = ready_session(StateUnavailableCore);
        let request = r#"{"jsonrpc":"2.0","id":"archive","method":"thread/archive","params":{"threadId":"thr_0000000000000001"}}"#;

        let first = session.process_line(request);
        let JsonRpcMessage::Error(error) = &first[0] else {
            panic!("expected state error");
        };
        assert_eq!(error.error.code, ERROR_STATE_UNAVAILABLE);

        let second = session.process_line(request);
        let JsonRpcMessage::Error(error) = &second[0] else {
            panic!("expected duplicate error");
        };
        assert_eq!(error.error.code, ERROR_DUPLICATE_REQUEST);
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

    #[test]
    fn turn_start_failure_returns_internal_error_without_notification() {
        for behavior in [TurnCoreBehavior::Fail, TurnCoreBehavior::AdvanceFail] {
            let mut session = ready_session(TurnCore::new(behavior));

            let mut messages = session.process_line(
                r#"{"jsonrpc":"2.0","id":"turn-1","method":"turn/start","params":{"threadId":"thr_existing"}}"#,
            );

            assert_eq!(messages.len(), 1);
            let JsonRpcMessage::Error(error) = messages.pop().expect("internal error response")
            else {
                panic!("expected error");
            };
            assert_eq!(error.error.code, ERROR_INTERNAL);
            assert_eq!(error.error.message, "Internal error");
            assert!(error.error.data.is_none());
        }
    }

    #[test]
    fn mismatched_turn_event_correlation_returns_internal_error() {
        for behavior in [
            TurnCoreBehavior::WrongRequest,
            TurnCoreBehavior::WrongThread,
            TurnCoreBehavior::WrongEvent,
            TurnCoreBehavior::WrongCompletedText,
        ] {
            let mut session = ready_session(TurnCore::new(behavior));
            let mut messages = session.process_line(
                r#"{"jsonrpc":"2.0","id":"turn-1","method":"turn/start","params":{"threadId":"thr_existing"}}"#,
            );

            assert_eq!(messages.len(), 1);
            let JsonRpcMessage::Error(error) = messages.pop().expect("internal error response")
            else {
                panic!("expected error");
            };
            assert_eq!(error.error.code, ERROR_INTERNAL);
        }
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

    #[test]
    fn thread_list_is_descending_bounded_and_cursor_paginated() {
        let mut session = ready_session(Core::new());
        for id in ["start-1", "start-2", "start-3"] {
            let messages = session.process_line(&format!(
                r#"{{"jsonrpc":"2.0","id":"{id}","method":"thread/start","params":{{}}}}"#
            ));
            assert_eq!(messages.len(), 2);
        }

        let first = session.process_line(
            r#"{"jsonrpc":"2.0","id":"list-1","method":"thread/list","params":{"limit":2}}"#,
        );
        let JsonRpcMessage::Response(first) = &first[0] else {
            panic!("expected list response");
        };
        assert_eq!(
            first.result,
            json!({
                "data": [
                    {"id": "thr_0000000000000003"},
                    {"id": "thr_0000000000000002"}
                ],
                "nextCursor": "thr_0000000000000002"
            })
        );

        let second = session.process_line(
            r#"{"jsonrpc":"2.0","id":"list-2","method":"thread/list","params":{"cursor":"thr_0000000000000002","limit":2}}"#,
        );
        let JsonRpcMessage::Response(second) = &second[0] else {
            panic!("expected second list response");
        };
        assert_eq!(
            second.result,
            json!({
                "data": [{"id": "thr_0000000000000001"}],
                "nextCursor": null
            })
        );
    }

    #[test]
    fn thread_list_rejects_invalid_params_and_maps_state_failure() {
        let mut session = ready_session(Core::new());
        for (index, params) in [
            r#"{"limit":0}"#,
            r#"{"limit":101}"#,
            r#"{"cursor":"thr_missing"}"#,
            r#"{"search":"later"}"#,
        ]
        .into_iter()
        .enumerate()
        {
            let messages = session.process_line(&format!(
                r#"{{"jsonrpc":"2.0","id":"invalid-{index}","method":"thread/list","params":{params}}}"#
            ));
            let JsonRpcMessage::Error(error) = &messages[0] else {
                panic!("expected invalid params");
            };
            assert_eq!(error.error.code, ERROR_INVALID_PARAMS);
        }

        let mut unavailable = ready_session(StateUnavailableCore);
        let messages =
            unavailable.process_line(r#"{"jsonrpc":"2.0","id":"list","method":"thread/list"}"#);
        let JsonRpcMessage::Error(error) = &messages[0] else {
            panic!("expected state error");
        };
        assert_eq!(error.error.code, ERROR_STATE_UNAVAILABLE);
    }

    #[test]
    fn thread_search_returns_only_matching_threads_in_stable_id_order() {
        let mut session = ready_session(Core::new());
        for sequence in 1..=3 {
            session.process_line(&format!(
                r#"{{"jsonrpc":"2.0","id":"start-{sequence}","method":"thread/start","params":{{}}}}"#
            ));
            if sequence < 3 {
                session.process_line(&format!(
                    r#"{{"jsonrpc":"2.0","id":"turn-{sequence}","method":"turn/start","params":{{"threadId":"thr_{sequence:016}"}}}}"#
                ));
            }
        }

        let first = session.process_line(
            r#"{"jsonrpc":"2.0","id":"search-1","method":"thread/search","params":{"query":"SugarCode response","limit":1}}"#,
        );
        let JsonRpcMessage::Response(first) = &first[0] else {
            panic!("expected search response");
        };
        assert_eq!(
            first.result,
            json!({
                "data": [{"id": "thr_0000000000000002"}],
                "nextCursor": "thr_0000000000000002"
            })
        );

        let second = session.process_line(
            r#"{"jsonrpc":"2.0","id":"search-2","method":"thread/search","params":{"query":"SugarCode response","cursor":"thr_0000000000000002","limit":1}}"#,
        );
        let JsonRpcMessage::Response(second) = &second[0] else {
            panic!("expected second search response");
        };
        assert_eq!(
            second.result,
            json!({
                "data": [{"id": "thr_0000000000000001"}],
                "nextCursor": null
            })
        );
    }

    #[test]
    fn thread_search_rejects_invalid_params_and_redacts_state_failures() {
        let mut session = ready_session(Core::new());
        for (index, params) in [
            r#"{}"#,
            r#"{"query":""}"#,
            r#"{"query":"private\nquery"}"#,
            r#"{"query":"valid","limit":0}"#,
            r#"{"query":"valid","limit":101}"#,
            r#"{"query":"valid","cursor":"thr_missing"}"#,
            r#"{"query":"valid","score":true}"#,
        ]
        .into_iter()
        .enumerate()
        {
            let messages = session.process_line(&format!(
                r#"{{"jsonrpc":"2.0","id":"invalid-search-{index}","method":"thread/search","params":{params}}}"#
            ));
            let JsonRpcMessage::Error(error) = &messages[0] else {
                panic!("expected invalid params");
            };
            assert_eq!(error.error.code, ERROR_INVALID_PARAMS);
            assert!(error.error.data.is_none());
        }

        let mut unavailable = ready_session(StateUnavailableCore);
        let messages = unavailable.process_line(
            r#"{"jsonrpc":"2.0","id":"search","method":"thread/search","params":{"query":"private-query-sentinel"}}"#,
        );
        let JsonRpcMessage::Error(error) = &messages[0] else {
            panic!("expected state error");
        };
        assert_eq!(error.error.code, ERROR_STATE_UNAVAILABLE);
        assert_eq!(error.error.message, "State unavailable");
        assert!(error.error.data.is_none());
        assert!(
            !serde_json::to_string(error)
                .expect("serialize")
                .contains("private-query-sentinel")
        );
    }

    fn response_turn_id(messages: &[JsonRpcMessage]) -> &str {
        let JsonRpcMessage::Response(response) = &messages[0] else {
            panic!("expected response first");
        };
        response
            .result
            .get("turn")
            .and_then(|turn| turn.get("id"))
            .and_then(Value::as_str)
            .expect("response turn id")
    }

    fn notification_thread_id(messages: &[JsonRpcMessage]) -> &str {
        let JsonRpcMessage::Notification(notification) = &messages[1] else {
            panic!("expected notification second");
        };
        notification
            .params
            .as_ref()
            .and_then(|params| params.get("threadId"))
            .and_then(Value::as_str)
            .expect("notification thread id")
    }

    struct FailingCore;

    impl CoreApi for FailingCore {
        fn start_thread(&mut self, _request_id: CoreRequestId) -> Result<CoreEvent, CoreError> {
            Err(CoreError::Internal("sensitive failure".to_string()))
        }

        fn contains_thread(&self, _thread_id: &ThreadId) -> bool {
            false
        }

        fn list_threads(
            &mut self,
            _cursor: Option<&ThreadId>,
            _limit: usize,
        ) -> Result<sugarcode_state::DurableThreadPage, CoreError> {
            Ok(sugarcode_state::DurableThreadPage {
                data: Vec::new(),
                next_cursor: None,
            })
        }

        fn resume_thread(
            &mut self,
            thread_id: &ThreadId,
        ) -> Result<sugarcode_state::DurableThreadSnapshot, CoreError> {
            Err(CoreError::ThreadNotFound(thread_id.clone()))
        }

        fn start_turn(
            &mut self,
            _request_id: CoreRequestId,
            _thread_id: ThreadId,
        ) -> Result<Vec<CoreEvent>, CoreError> {
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

        fn contains_thread(&self, _thread_id: &ThreadId) -> bool {
            false
        }

        fn list_threads(
            &mut self,
            _cursor: Option<&ThreadId>,
            _limit: usize,
        ) -> Result<sugarcode_state::DurableThreadPage, CoreError> {
            Ok(sugarcode_state::DurableThreadPage {
                data: Vec::new(),
                next_cursor: None,
            })
        }

        fn resume_thread(
            &mut self,
            thread_id: &ThreadId,
        ) -> Result<sugarcode_state::DurableThreadSnapshot, CoreError> {
            Err(CoreError::ThreadNotFound(thread_id.clone()))
        }

        fn start_turn(
            &mut self,
            _request_id: CoreRequestId,
            _thread_id: ThreadId,
        ) -> Result<Vec<CoreEvent>, CoreError> {
            Err(CoreError::Internal("unexpected turn request".to_string()))
        }
    }

    struct StateUnavailableCore;

    impl CoreApi for StateUnavailableCore {
        fn start_thread(&mut self, _request_id: CoreRequestId) -> Result<CoreEvent, CoreError> {
            Err(CoreError::StateUnavailable)
        }

        fn contains_thread(&self, _thread_id: &ThreadId) -> bool {
            true
        }

        fn list_threads(
            &mut self,
            _cursor: Option<&ThreadId>,
            _limit: usize,
        ) -> Result<sugarcode_state::DurableThreadPage, CoreError> {
            Err(CoreError::StateUnavailable)
        }

        fn resume_thread(
            &mut self,
            _thread_id: &ThreadId,
        ) -> Result<sugarcode_state::DurableThreadSnapshot, CoreError> {
            Err(CoreError::StateUnavailable)
        }

        fn start_turn(
            &mut self,
            _request_id: CoreRequestId,
            _thread_id: ThreadId,
        ) -> Result<Vec<CoreEvent>, CoreError> {
            Err(CoreError::StateUnavailable)
        }
    }

    #[derive(Clone, Copy)]
    enum TurnCoreBehavior {
        Fail,
        AdvanceFail,
        WrongRequest,
        WrongThread,
        WrongEvent,
        WrongCompletedText,
    }

    struct TurnCore {
        behavior: TurnCoreBehavior,
    }

    impl TurnCore {
        fn new(behavior: TurnCoreBehavior) -> Self {
            Self { behavior }
        }
    }

    impl CoreApi for TurnCore {
        fn start_thread(&mut self, request_id: CoreRequestId) -> Result<CoreEvent, CoreError> {
            Ok(CoreEvent {
                request_id,
                kind: CoreEventKind::ThreadStarted {
                    thread_id: ThreadId::new("thr_existing"),
                },
            })
        }

        fn contains_thread(&self, thread_id: &ThreadId) -> bool {
            thread_id.as_str() == "thr_existing"
        }

        fn list_threads(
            &mut self,
            _cursor: Option<&ThreadId>,
            _limit: usize,
        ) -> Result<sugarcode_state::DurableThreadPage, CoreError> {
            Ok(sugarcode_state::DurableThreadPage {
                data: Vec::new(),
                next_cursor: None,
            })
        }

        fn resume_thread(
            &mut self,
            thread_id: &ThreadId,
        ) -> Result<sugarcode_state::DurableThreadSnapshot, CoreError> {
            Err(CoreError::ThreadNotFound(thread_id.clone()))
        }

        fn start_turn(
            &mut self,
            request_id: CoreRequestId,
            thread_id: ThreadId,
        ) -> Result<Vec<CoreEvent>, CoreError> {
            match self.behavior {
                TurnCoreBehavior::Fail => {
                    Err(CoreError::Internal("sensitive turn failure".to_string()))
                }
                TurnCoreBehavior::AdvanceFail => Err(CoreError::Internal(
                    "sensitive completion failure".to_string(),
                )),
                TurnCoreBehavior::WrongRequest => {
                    let mut events = valid_turn_events(request_id, thread_id);
                    events[2].request_id = CoreRequestId::new(request_id.get() + 1);
                    Ok(events)
                }
                TurnCoreBehavior::WrongThread => {
                    let mut events = valid_turn_events(request_id, thread_id);
                    events[3].kind = CoreEventKind::ItemCompleted {
                        thread_id: ThreadId::new("thr_wrong"),
                        turn_id: TurnId::new("turn_test"),
                        item: completed_test_item(),
                    };
                    Ok(events)
                }
                TurnCoreBehavior::WrongEvent => {
                    let mut events = valid_turn_events(request_id, thread_id);
                    events.swap(3, 4);
                    Ok(events)
                }
                TurnCoreBehavior::WrongCompletedText => {
                    let mut events = valid_turn_events(request_id, thread_id);
                    events[3].kind = CoreEventKind::ItemCompleted {
                        thread_id: ThreadId::new("thr_existing"),
                        turn_id: TurnId::new("turn_test"),
                        item: CoreItemSnapshot {
                            id: ItemId::new("item_test"),
                            kind: CoreItemKind::AgentMessage {
                                text: "contradictory text".to_string(),
                            },
                        },
                    };
                    Ok(events)
                }
            }
        }
    }

    fn valid_turn_events(request_id: CoreRequestId, thread_id: ThreadId) -> Vec<CoreEvent> {
        let turn_id = TurnId::new("turn_test");
        let mut events = vec![
            CoreEvent {
                request_id,
                kind: CoreEventKind::TurnStarted {
                    thread_id: thread_id.clone(),
                    turn_id: turn_id.clone(),
                },
            },
            CoreEvent {
                request_id,
                kind: CoreEventKind::ItemStarted {
                    thread_id: thread_id.clone(),
                    turn_id: turn_id.clone(),
                    item: CoreItemSnapshot {
                        id: ItemId::new("item_test"),
                        kind: CoreItemKind::AgentMessage {
                            text: String::new(),
                        },
                    },
                },
            },
            CoreEvent {
                request_id,
                kind: CoreEventKind::AgentMessageDelta {
                    thread_id: thread_id.clone(),
                    turn_id: turn_id.clone(),
                    item_id: ItemId::new("item_test"),
                    delta: "test response".to_string(),
                },
            },
        ];
        events.extend([
            CoreEvent {
                request_id,
                kind: CoreEventKind::ItemCompleted {
                    thread_id: thread_id.clone(),
                    turn_id: turn_id.clone(),
                    item: completed_test_item(),
                },
            },
            CoreEvent {
                request_id,
                kind: CoreEventKind::TurnCompleted { thread_id, turn_id },
            },
        ]);
        events
    }

    fn completed_test_item() -> CoreItemSnapshot {
        CoreItemSnapshot {
            id: ItemId::new("item_test"),
            kind: CoreItemKind::AgentMessage {
                text: "test response".to_string(),
            },
        }
    }
}
