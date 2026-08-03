use super::super::*;

impl<C> Session<C>
where
    C: CoreApi,
{
    pub(in crate::session) fn start_turn(
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

        let thread_id = ThreadId::parse(params.thread_id.clone()).expect("validated thread ID");
        if !self.agent.contains_thread(&thread_id) {
            return vec![error(
                Some(id),
                ERROR_THREAD_NOT_FOUND,
                "Thread not found",
                Some(json!({ "threadId": params.thread_id })),
            )];
        }

        let input = params.input.map(|content| {
            content
                .into_iter()
                .map(core_turn_input_part)
                .collect::<Vec<_>>()
        });
        let (core_request_id, outcome) = match self.agent.start_content_turn_with_model(
            thread_id.clone(),
            input,
            params.model_profile_id,
        ) {
            Ok(result) => result,
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
                let model = self
                    .agent
                    .resume_thread(&thread_id)
                    .ok()
                    .and_then(|snapshot| {
                        snapshot
                            .turns
                            .into_iter()
                            .find(|turn| turn.id == turn_id)
                            .and_then(|turn| turn.model)
                    })
                    .map(map_model_selection);
                let response = TurnStartResponse {
                    turn: sugarcode_app_server_protocol::Turn {
                        id: turn_id.into_string(),
                        status: sugarcode_app_server_protocol::TurnStatus::InProgress,
                        model,
                        error: None,
                        usage: None,
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

    pub(in crate::session) fn interrupt_turn(
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
        let thread_id = ThreadId::parse(params.thread_id.clone()).expect("validated thread ID");
        let turn_id = TurnId::parse(params.turn_id.clone()).expect("validated turn ID");
        if !self.agent.contains_thread(&thread_id) {
            return vec![error(
                Some(id),
                ERROR_THREAD_NOT_FOUND,
                "Thread not found",
                Some(json!({ "threadId": params.thread_id })),
            )];
        }
        let outcome = self.agent.interrupt_turn(&thread_id, &turn_id);
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

fn core_turn_input_part(
    part: sugarcode_app_server_protocol::TurnInputPart,
) -> sugarcode_protocol::CoreUserContentPart {
    match part {
        sugarcode_app_server_protocol::TurnInputPart::Text { text } => {
            sugarcode_protocol::CoreUserContentPart::Text { text }
        }
        sugarcode_app_server_protocol::TurnInputPart::Image { asset } => {
            sugarcode_protocol::CoreUserContentPart::Image {
                asset: core_asset(asset),
            }
        }
        sugarcode_app_server_protocol::TurnInputPart::Document { asset } => {
            sugarcode_protocol::CoreUserContentPart::Document {
                asset: core_asset(asset),
            }
        }
    }
}

fn core_asset(
    asset: sugarcode_app_server_protocol::AssetDescriptor,
) -> sugarcode_protocol::CoreContentAsset {
    sugarcode_protocol::CoreContentAsset {
        asset_id: asset.asset_id,
        sha256: asset.sha256,
        media_type: asset.media_type,
        original_name: asset.original_name,
        size_bytes: u64::from(asset.size_bytes),
    }
}
