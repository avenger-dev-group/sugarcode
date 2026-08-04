use super::super::*;

impl<C> Session<C>
where
    C: CoreApi,
{
    pub(in crate::session) fn list_thread_descendants(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> Vec<JsonRpcMessage> {
        let Ok(params) = params.ok_or(()).and_then(|value| {
            serde_json::from_value::<ThreadDescendantsListParams>(value).map_err(|_| ())
        }) else {
            return vec![error(
                Some(id),
                ERROR_INVALID_PARAMS,
                "Invalid params",
                None,
            )];
        };
        if self.accepted_request_ids.contains(&id) {
            return vec![error(
                Some(id),
                ERROR_DUPLICATE_REQUEST,
                "Duplicate request id",
                None,
            )];
        }
        let thread_id = ThreadId::parse(params.thread_id.clone()).expect("validated thread ID");
        let workspace_id = self.workspace_id().unwrap_or("unbound").to_owned();
        let descendants = match self.agent.list_descendants(&thread_id) {
            Ok(descendants) => descendants,
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
        let response = ThreadDescendantsListResponse {
            data: descendants
                .into_iter()
                .map(|snapshot| map_thread_snapshot(snapshot, &workspace_id))
                .collect(),
        };
        vec![JsonRpcMessage::Response(JsonRpcResponse {
            jsonrpc: JsonRpcVersion::V2,
            id,
            result: serde_json::to_value(response)
                .expect("thread/descendants/list response must serialize"),
        })]
    }

    pub(in crate::session) fn start_thread(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> Vec<JsonRpcMessage> {
        let params = match self
            .workspace_scoped_params(params)
            .ok_or(())
            .and_then(|value| serde_json::from_value::<ThreadStartParams>(value).map_err(|_| ()))
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
        if !self.accepts_workspace_id(&params.workspace_id) {
            return vec![error(
                Some(id),
                ERROR_WORKSPACE_UNAVAILABLE,
                "Workspace unavailable",
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

        self.accepted_request_ids.insert(id.clone());

        let event = match self.agent.start_thread() {
            Ok(event) => event,
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

        let thread_id = match event.kind {
            CoreEventKind::ThreadStarted { thread_id } => thread_id,
            _ => {
                return vec![error(Some(id), ERROR_INTERNAL, "Internal error", None)];
            }
        };
        let thread = PublicThread {
            id: thread_id.into_string(),
            workspace_id: params.workspace_id.clone(),
            title: None,
            origin: None,
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

    pub(in crate::session) fn generate_thread_title(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> Vec<JsonRpcMessage> {
        let Ok(params) = params.ok_or(()).and_then(|value| {
            serde_json::from_value::<ThreadTitleGenerateParams>(value).map_err(|_| ())
        }) else {
            return vec![error(
                Some(id),
                ERROR_INVALID_PARAMS,
                "Invalid params",
                None,
            )];
        };
        if self.accepted_request_ids.contains(&id) {
            return vec![error(
                Some(id),
                ERROR_DUPLICATE_REQUEST,
                "Duplicate request id",
                None,
            )];
        }
        let thread_id = ThreadId::parse(params.thread_id.clone()).expect("validated thread ID");
        if !self.agent.contains_thread(&thread_id) {
            return vec![error(
                Some(id),
                ERROR_THREAD_NOT_FOUND,
                "Thread not found",
                Some(json!({ "threadId": params.thread_id })),
            )];
        }
        match self.agent.generate_thread_title(thread_id) {
            Ok(()) => {
                self.accepted_request_ids.insert(id.clone());
                vec![JsonRpcMessage::Response(JsonRpcResponse {
                    jsonrpc: JsonRpcVersion::V2,
                    id,
                    result: serde_json::to_value(ThreadTitleGenerateResponse::default())
                        .expect("thread/title/generate response must serialize"),
                })]
            }
            Err(CoreError::ModelUnavailable) => vec![error(
                Some(id),
                ERROR_MODEL_UNAVAILABLE,
                "Model unavailable",
                None,
            )],
            Err(CoreError::InvalidInput) => vec![error(
                Some(id),
                ERROR_INVALID_PARAMS,
                "Invalid params",
                None,
            )],
            Err(CoreError::StateUnavailable) => vec![error(
                Some(id),
                ERROR_STATE_UNAVAILABLE,
                "State unavailable",
                None,
            )],
            Err(_) => vec![error(Some(id), ERROR_INTERNAL, "Internal error", None)],
        }
    }

    pub(in crate::session) fn resume_thread(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> Vec<JsonRpcMessage> {
        let params = match self
            .workspace_scoped_params(params)
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
        if !self.accepts_workspace_id(&params.workspace_id) {
            return vec![error(
                Some(id),
                ERROR_WORKSPACE_UNAVAILABLE,
                "Workspace unavailable",
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

        let thread_id = ThreadId::parse(params.thread_id.clone()).expect("validated thread ID");
        let snapshot = match self.agent.resume_thread(&thread_id) {
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
        let response = map_thread_snapshot(snapshot, &params.workspace_id);
        vec![JsonRpcMessage::Response(JsonRpcResponse {
            jsonrpc: JsonRpcVersion::V2,
            id,
            result: serde_json::to_value(response).expect("thread/resume response must serialize"),
        })]
    }

    pub(in crate::session) fn archive_thread(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> Vec<JsonRpcMessage> {
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

        let thread_id = ThreadId::parse(params.thread_id.clone()).expect("validated thread ID");
        match self.agent.archive_thread(&thread_id) {
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
            Err(CoreError::TurnAlreadyActive { turn_id, .. }) => vec![error(
                Some(id),
                ERROR_TURN_ACTIVE,
                "Turn active",
                Some(json!({
                    "threadId": params.thread_id,
                    "turnId": turn_id.into_string(),
                })),
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

    pub(in crate::session) fn unarchive_thread(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> Vec<JsonRpcMessage> {
        let params = match params.ok_or(()).and_then(|value| {
            serde_json::from_value::<ThreadUnarchiveParams>(value).map_err(|_| ())
        }) {
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

        let thread_id = ThreadId::parse(params.thread_id.clone()).expect("validated thread ID");
        match self.agent.unarchive_thread(&thread_id) {
            Ok(()) => {
                self.accepted_request_ids.insert(id.clone());
                let response = ThreadUnarchiveResponse {};
                vec![JsonRpcMessage::Response(JsonRpcResponse {
                    jsonrpc: JsonRpcVersion::V2,
                    id,
                    result: serde_json::to_value(response)
                        .expect("thread/unarchive response must serialize"),
                })]
            }
            Err(CoreError::ThreadNotFound(_)) => vec![error(
                Some(id),
                ERROR_THREAD_NOT_FOUND,
                "Thread not found",
                Some(json!({ "threadId": params.thread_id })),
            )],
            Err(CoreError::TurnAlreadyActive { turn_id, .. }) => vec![error(
                Some(id),
                ERROR_TURN_ACTIVE,
                "Turn active",
                Some(json!({
                    "threadId": params.thread_id,
                    "turnId": turn_id.into_string(),
                })),
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

    pub(in crate::session) fn delete_thread(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> Vec<JsonRpcMessage> {
        let params = match params
            .ok_or(())
            .and_then(|value| serde_json::from_value::<ThreadDeleteParams>(value).map_err(|_| ()))
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

        let thread_id = ThreadId::parse(params.thread_id.clone()).expect("validated thread ID");
        match self.agent.delete_thread(&thread_id) {
            Ok(()) => {
                self.accepted_request_ids.insert(id.clone());
                let response = ThreadDeleteResponse {};
                vec![JsonRpcMessage::Response(JsonRpcResponse {
                    jsonrpc: JsonRpcVersion::V2,
                    id,
                    result: serde_json::to_value(response)
                        .expect("thread/delete response must serialize"),
                })]
            }
            Err(CoreError::ThreadNotFound(_)) => vec![error(
                Some(id),
                ERROR_THREAD_NOT_FOUND,
                "Thread not found",
                Some(json!({ "threadId": params.thread_id })),
            )],
            Err(CoreError::TurnAlreadyActive { turn_id, .. }) => vec![error(
                Some(id),
                ERROR_TURN_ACTIVE,
                "Turn active",
                Some(json!({
                    "threadId": params.thread_id,
                    "turnId": turn_id.into_string(),
                })),
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

    pub(in crate::session) fn fork_thread(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> Vec<JsonRpcMessage> {
        let params = match params
            .ok_or(())
            .and_then(|value| serde_json::from_value::<ThreadForkParams>(value).map_err(|_| ()))
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

        let source_thread_id =
            ThreadId::parse(params.thread_id.clone()).expect("validated thread ID");
        let snapshot = match self.agent.fork_thread(&source_thread_id) {
            Ok(snapshot) => snapshot,
            Err(CoreError::ThreadNotFound(_)) => {
                return vec![error(
                    Some(id),
                    ERROR_THREAD_NOT_FOUND,
                    "Thread not found",
                    Some(json!({ "threadId": params.thread_id })),
                )];
            }
            Err(CoreError::TurnAlreadyActive { turn_id, .. }) => {
                return vec![error(
                    Some(id),
                    ERROR_TURN_ACTIVE,
                    "Turn active",
                    Some(json!({
                        "threadId": params.thread_id,
                        "turnId": turn_id.into_string(),
                    })),
                )];
            }
            Err(CoreError::StateUnavailable) => {
                self.accepted_request_ids.insert(id.clone());
                return vec![error(
                    Some(id),
                    ERROR_STATE_UNAVAILABLE,
                    "State unavailable",
                    None,
                )];
            }
            Err(_) => {
                self.accepted_request_ids.insert(id.clone());
                return vec![error(Some(id), ERROR_INTERNAL, "Internal error", None)];
            }
        };
        self.accepted_request_ids.insert(id.clone());
        let workspace_id = self.workspace_id().unwrap_or("unbound").to_owned();
        let response = map_fork_snapshot(snapshot, &workspace_id);
        let notification = ThreadStartedNotification {
            thread: response.thread.clone(),
        };
        vec![
            JsonRpcMessage::Response(JsonRpcResponse {
                jsonrpc: JsonRpcVersion::V2,
                id,
                result: serde_json::to_value(response)
                    .expect("thread/fork response must serialize"),
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
