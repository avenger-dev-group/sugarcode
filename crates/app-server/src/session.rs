use crate::approval::PendingCommandApproval;
use crate::event_mapping::EventMappingError;
use crate::event_mapping::map_core_event;
use crate::event_mapping::map_fork_snapshot;
use crate::event_mapping::map_thread_snapshot;
use crate::event_mapping::map_turn_lifecycle;
use serde_json::Value;
use serde_json::json;
use std::collections::HashMap;
use std::collections::HashSet;
use sugarcode_app_server_protocol::CommandApprovalParams;
use sugarcode_app_server_protocol::CommandApprovalResponse;
use sugarcode_app_server_protocol::CommandApprovalResponseDecision;
use sugarcode_app_server_protocol::DEFAULT_THREAD_LIST_LIMIT;
use sugarcode_app_server_protocol::DEFAULT_THREAD_SEARCH_LIMIT;
use sugarcode_app_server_protocol::ERROR_ALREADY_INITIALIZED;
use sugarcode_app_server_protocol::ERROR_DUPLICATE_REQUEST;
use sugarcode_app_server_protocol::ERROR_INTERNAL;
use sugarcode_app_server_protocol::ERROR_INVALID_PARAMS;
use sugarcode_app_server_protocol::ERROR_INVALID_REQUEST;
use sugarcode_app_server_protocol::ERROR_METHOD_NOT_FOUND;
use sugarcode_app_server_protocol::ERROR_MODEL_UNAVAILABLE;
use sugarcode_app_server_protocol::ERROR_NOT_INITIALIZED;
use sugarcode_app_server_protocol::ERROR_PARSE;
use sugarcode_app_server_protocol::ERROR_STATE_UNAVAILABLE;
use sugarcode_app_server_protocol::ERROR_THREAD_NOT_FOUND;
use sugarcode_app_server_protocol::ERROR_TURN_ACTIVE;
use sugarcode_app_server_protocol::ERROR_TURN_NOT_ACTIVE;
use sugarcode_app_server_protocol::ERROR_UNSUPPORTED_PROTOCOL_VERSION;
use sugarcode_app_server_protocol::InitializeParams;
use sugarcode_app_server_protocol::InitializeResponse;
use sugarcode_app_server_protocol::JSON_RPC_VERSION;
use sugarcode_app_server_protocol::JsonRpcError;
use sugarcode_app_server_protocol::JsonRpcErrorObject;
use sugarcode_app_server_protocol::JsonRpcMessage;
use sugarcode_app_server_protocol::JsonRpcRequest;
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
use sugarcode_app_server_protocol::ThreadDeleteParams;
use sugarcode_app_server_protocol::ThreadDeleteResponse;
use sugarcode_app_server_protocol::ThreadForkParams;
use sugarcode_app_server_protocol::ThreadListParams;
use sugarcode_app_server_protocol::ThreadListResponse;
use sugarcode_app_server_protocol::ThreadResumeParams;
use sugarcode_app_server_protocol::ThreadSearchParams;
use sugarcode_app_server_protocol::ThreadSearchResponse;
use sugarcode_app_server_protocol::ThreadStartParams;
use sugarcode_app_server_protocol::ThreadStartResponse;
use sugarcode_app_server_protocol::ThreadStartedNotification;
use sugarcode_app_server_protocol::ThreadUnarchiveParams;
use sugarcode_app_server_protocol::ThreadUnarchiveResponse;
use sugarcode_app_server_protocol::TurnInterruptParams;
use sugarcode_app_server_protocol::TurnInterruptResponse;
use sugarcode_app_server_protocol::TurnStartParams;
use sugarcode_app_server_protocol::TurnStartResponse;
use sugarcode_core::CommandApprovalOutcome;
use sugarcode_core::Core;
use sugarcode_core::CoreApi;
use sugarcode_core::CoreError;
use sugarcode_core::TurnInterruptOutcome;
use sugarcode_core::TurnStartOutcome;
use sugarcode_protocol::CoreEventKind;
use sugarcode_protocol::CoreRequestId;
use sugarcode_protocol::ThreadId;
use sugarcode_protocol::TurnId;
use tokio::sync::oneshot;

mod handlers;

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
    pending_interrupts: HashMap<(String, String), RequestId>,
    pending_approvals: HashMap<RequestId, oneshot::Sender<CommandApprovalOutcome>>,
    command_approvals: bool,
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
            pending_interrupts: HashMap::new(),
            pending_approvals: HashMap::new(),
            command_approvals: false,
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

    pub(crate) fn process_core_event(
        &mut self,
        event: sugarcode_protocol::CoreEvent,
    ) -> Result<Vec<JsonRpcMessage>, EventMappingError> {
        let interrupted = match &event.kind {
            CoreEventKind::TurnInterrupted { thread_id, turn_id } => {
                Some((thread_id.as_str().to_string(), turn_id.as_str().to_string()))
            }
            _ => None,
        };
        let notification = map_core_event(event)?;
        let mut messages = vec![notification];
        if let Some(key) = interrupted
            && let Some(id) = self.pending_interrupts.remove(&key)
        {
            messages.push(JsonRpcMessage::Response(JsonRpcResponse {
                jsonrpc: JsonRpcVersion::V2,
                id,
                result: serde_json::to_value(TurnInterruptResponse {})
                    .expect("turn/interrupt response must serialize"),
            }));
        }
        Ok(messages)
    }

    pub fn shutdown(&mut self) -> futures_util::future::BoxFuture<'static, Result<(), CoreError>> {
        self.pending_approvals.clear();
        self.core.shutdown()
    }

    pub(crate) fn process_approval_request(
        &mut self,
        pending: PendingCommandApproval,
    ) -> Option<JsonRpcMessage> {
        if self.state != SessionState::Ready || !self.command_approvals {
            let _ = pending.response.send(CommandApprovalOutcome::Unsupported);
            return None;
        }
        let id = RequestId::String(pending.request.approval_id.clone());
        if self.pending_approvals.contains_key(&id) {
            let _ = pending.response.send(CommandApprovalOutcome::Unsupported);
            return None;
        }
        let params = CommandApprovalParams {
            approval_id: pending.request.approval_id,
            thread_id: pending.request.thread_id.into_string(),
            turn_id: pending.request.turn_id.into_string(),
            call_id: pending.request.call_id,
            command: pending.request.command,
            arguments: pending.request.arguments,
            cwd: pending.request.cwd,
            approval_scope: "command".to_string(),
            environment_policy: pending.request.environment_policy,
            sandboxed: pending.request.sandboxed,
            sandbox_policy: match pending.request.sandbox_policy {
                sugarcode_protocol::CoreCommandSandboxPolicy::FilesystemReadOnlyV1 => {
                    sugarcode_app_server_protocol::CommandSandboxPolicy::FilesystemReadOnlyV1
                }
            },
            workspace_write_policy: pending.request.workspace_write_policy.map(|policy| {
                match policy {
                    sugarcode_protocol::CoreCommandWorkspaceWritePolicy::CommandWorkspaceWriteV1 => {
                        sugarcode_app_server_protocol::CommandWorkspaceWritePolicy::CommandWorkspaceWriteV1
                    }
                }
            }),
            network_policy: match pending.request.network_policy {
                sugarcode_protocol::CoreCommandNetworkPolicy::NetworkDeniedV1 => {
                    sugarcode_app_server_protocol::CommandNetworkPolicy::NetworkDeniedV1
                }
            },
        };
        self.pending_approvals.insert(id.clone(), pending.response);
        Some(JsonRpcMessage::Request(JsonRpcRequest {
            jsonrpc: JsonRpcVersion::V2,
            id,
            method: "item/commandExecution/requestApproval".to_string(),
            params: Some(serde_json::to_value(params).expect("approval params must serialize")),
        }))
    }

    fn process_value(&mut self, value: Value) -> Vec<JsonRpcMessage> {
        let Some(object) = value.as_object() else {
            return vec![error(None, ERROR_INVALID_REQUEST, "Invalid Request", None)];
        };

        if object.get("jsonrpc").and_then(Value::as_str) != Some(JSON_RPC_VERSION) {
            return vec![error(None, ERROR_INVALID_REQUEST, "Invalid Request", None)];
        }

        if !object.contains_key("method") {
            self.process_response(object);
            return Vec::new();
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
            "thread/unarchive" => {
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
                self.unarchive_thread(id, object.get("params").cloned())
            }
            "thread/delete" => {
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
                self.delete_thread(id, object.get("params").cloned())
            }
            "thread/fork" => {
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
                self.fork_thread(id, object.get("params").cloned())
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
            "turn/interrupt" => {
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
                self.interrupt_turn(id, object.get("params").cloned())
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

    fn process_response(&mut self, object: &serde_json::Map<String, Value>) {
        let Some(id) = parse_request_id(object.get("id")) else {
            return;
        };
        let Some(sender) = self.pending_approvals.remove(&id) else {
            return;
        };
        let outcome = if let Some(result) = object.get("result") {
            serde_json::from_value::<CommandApprovalResponse>(result.clone())
                .map(|response| match response.decision {
                    CommandApprovalResponseDecision::Approved => CommandApprovalOutcome::Approved,
                    CommandApprovalResponseDecision::Denied => CommandApprovalOutcome::Denied,
                })
                .unwrap_or(CommandApprovalOutcome::Denied)
        } else {
            CommandApprovalOutcome::Denied
        };
        let _ = sender.send(outcome);
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
#[path = "session/tests/mod.rs"]
mod tests;
