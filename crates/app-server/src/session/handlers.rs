use super::*;

impl<C> Session<C>
where
    C: CoreApi,
{
    pub(super) fn initialize(&mut self, id: RequestId, params: Option<Value>) -> JsonRpcMessage {
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
        self.command_approvals = params
            .capabilities
            .as_ref()
            .is_some_and(|capabilities| capabilities.command_approvals);

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
            capabilities: ServerCapabilities {
                command_approvals: true,
            },
        };
        let result = serde_json::to_value(response).expect("initialize response must serialize");
        self.state = SessionState::AwaitingInitialized;
        JsonRpcMessage::Response(JsonRpcResponse {
            jsonrpc: JsonRpcVersion::V2,
            id,
            result,
        })
    }

    pub(super) fn start_thread(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> Vec<JsonRpcMessage> {
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

    pub(super) fn resume_thread(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> Vec<JsonRpcMessage> {
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

    pub(super) fn archive_thread(
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

    pub(super) fn unarchive_thread(
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

        let thread_id = ThreadId::new(params.thread_id.clone());
        match self.core.unarchive_thread(&thread_id) {
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

    pub(super) fn delete_thread(
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

        let thread_id = ThreadId::new(params.thread_id.clone());
        match self.core.delete_thread(&thread_id) {
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

    pub(super) fn fork_thread(
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

        let source_thread_id = ThreadId::new(params.thread_id.clone());
        let snapshot = match self.core.fork_thread(&source_thread_id) {
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
        let response = map_fork_snapshot(snapshot);
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

    pub(super) fn list_threads(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> Vec<JsonRpcMessage> {
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

    pub(super) fn search_threads(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> Vec<JsonRpcMessage> {
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

    pub(super) fn start_turn(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> Vec<JsonRpcMessage> {
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
        let outcome =
            match self
                .core
                .start_text_turn(core_request_id, thread_id.clone(), params.input)
            {
                Ok(outcome) => outcome,
                Err(CoreError::StateUnavailable) => {
                    self.accepted_request_ids.insert(id.clone());
                    return vec![error(
                        Some(id),
                        ERROR_STATE_UNAVAILABLE,
                        "State unavailable",
                        None,
                    )];
                }
                Err(CoreError::ModelUnavailable) => {
                    return vec![error(
                        Some(id),
                        ERROR_MODEL_UNAVAILABLE,
                        "Model unavailable",
                        None,
                    )];
                }
                Err(CoreError::InvalidInput | CoreError::ContextTooLarge) => {
                    return vec![error(
                        Some(id),
                        ERROR_INVALID_PARAMS,
                        "Invalid params",
                        None,
                    )];
                }
                Err(_) => {
                    return vec![error(Some(id), ERROR_INTERNAL, "Internal error", None)];
                }
            };
        self.accepted_request_ids.insert(id.clone());

        match outcome {
            TurnStartOutcome::Immediate(events) => {
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
            TurnStartOutcome::Accepted { turn_id } => {
                let response = TurnStartResponse {
                    turn: sugarcode_app_server_protocol::Turn {
                        id: turn_id.into_string(),
                        status: sugarcode_app_server_protocol::TurnStatus::InProgress,
                        error: None,
                    },
                };
                vec![JsonRpcMessage::Response(JsonRpcResponse {
                    jsonrpc: JsonRpcVersion::V2,
                    id,
                    result: serde_json::to_value(response)
                        .expect("turn/start response must serialize"),
                })]
            }
        }
    }

    pub(super) fn interrupt_turn(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> Vec<JsonRpcMessage> {
        let params = match params
            .ok_or(())
            .and_then(|value| serde_json::from_value::<TurnInterruptParams>(value).map_err(|_| ()))
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
        let turn_id = TurnId::new(params.turn_id.clone());
        if !self.core.contains_thread(&thread_id) {
            return vec![error(
                Some(id),
                ERROR_THREAD_NOT_FOUND,
                "Thread not found",
                Some(json!({ "threadId": params.thread_id })),
            )];
        }
        let outcome = self.core.interrupt_turn(&thread_id, &turn_id);
        match outcome {
            Ok(TurnInterruptOutcome::Accepted) => {
                self.accepted_request_ids.insert(id.clone());
                self.pending_interrupts
                    .insert((params.thread_id, params.turn_id), id);
                Vec::new()
            }
            Ok(TurnInterruptOutcome::AlreadyTerminal) => vec![error(
                Some(id),
                ERROR_TURN_NOT_ACTIVE,
                "Turn not active",
                Some(json!({
                    "threadId": params.thread_id,
                    "turnId": params.turn_id,
                })),
            )],
            Err(CoreError::StateUnavailable) => vec![error(
                Some(id),
                ERROR_STATE_UNAVAILABLE,
                "State unavailable",
                None,
            )],
            Err(CoreError::NoActiveTurn(_)) => vec![error(
                Some(id),
                ERROR_TURN_NOT_ACTIVE,
                "Turn not active",
                Some(json!({
                    "threadId": params.thread_id,
                    "turnId": params.turn_id,
                })),
            )],
            Err(_) => vec![error(Some(id), ERROR_INTERNAL, "Internal error", None)],
        }
    }
}
