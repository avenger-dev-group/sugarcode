use serde_json::to_value;
use sugarcode_app_server_protocol::AgentMessageDeltaNotification;
use sugarcode_app_server_protocol::Item as PublicItem;
use sugarcode_app_server_protocol::ItemCompletedNotification;
use sugarcode_app_server_protocol::ItemStartedNotification;
use sugarcode_app_server_protocol::JsonRpcMessage;
use sugarcode_app_server_protocol::JsonRpcNotification;
use sugarcode_app_server_protocol::JsonRpcVersion;
use sugarcode_app_server_protocol::ThreadForkResponse;
use sugarcode_app_server_protocol::ThreadResumeResponse;
use sugarcode_app_server_protocol::Turn as PublicTurn;
use sugarcode_app_server_protocol::TurnCompletedNotification;
use sugarcode_app_server_protocol::TurnSnapshot;
use sugarcode_app_server_protocol::TurnSnapshotStatus;
use sugarcode_app_server_protocol::TurnStartedNotification;
use sugarcode_app_server_protocol::TurnStatus;
use sugarcode_protocol::CoreEvent;
use sugarcode_protocol::CoreEventKind;
use sugarcode_protocol::CoreItemKind;
use sugarcode_protocol::CoreRequestId;
use sugarcode_protocol::ThreadId;
use sugarcode_state::DurableItemSnapshot;
use sugarcode_state::DurableThreadSnapshot;

#[derive(Debug)]
pub(crate) struct EventMappingError;

pub(crate) struct MappedTurnLifecycle {
    pub(crate) turn: PublicTurn,
    pub(crate) notifications: Vec<JsonRpcMessage>,
}

pub(crate) fn map_turn_lifecycle(
    events: Vec<CoreEvent>,
    expected_request_id: CoreRequestId,
    expected_thread_id: &ThreadId,
) -> Result<MappedTurnLifecycle, EventMappingError> {
    let [
        turn_started,
        item_started,
        agent_message_delta,
        item_completed,
        turn_completed,
    ] = events.as_slice()
    else {
        return Err(EventMappingError);
    };
    if events
        .iter()
        .any(|event| event.request_id != expected_request_id)
    {
        return Err(EventMappingError);
    }

    let CoreEventKind::TurnStarted { thread_id, turn_id } = &turn_started.kind else {
        return Err(EventMappingError);
    };
    if thread_id != expected_thread_id {
        return Err(EventMappingError);
    }

    let CoreEventKind::ItemStarted {
        thread_id: started_thread_id,
        turn_id: started_turn_id,
        item: started_item,
    } = &item_started.kind
    else {
        return Err(EventMappingError);
    };
    let CoreItemKind::AgentMessage { text: started_text } = &started_item.kind;
    if started_thread_id != thread_id || started_turn_id != turn_id || !started_text.is_empty() {
        return Err(EventMappingError);
    }

    let CoreEventKind::AgentMessageDelta {
        thread_id: delta_thread_id,
        turn_id: delta_turn_id,
        item_id,
        delta,
    } = &agent_message_delta.kind
    else {
        return Err(EventMappingError);
    };
    if delta_thread_id != thread_id
        || delta_turn_id != turn_id
        || item_id != &started_item.id
        || delta.is_empty()
    {
        return Err(EventMappingError);
    }

    let CoreEventKind::ItemCompleted {
        thread_id: completed_thread_id,
        turn_id: completed_turn_id,
        item: completed_item,
    } = &item_completed.kind
    else {
        return Err(EventMappingError);
    };
    let CoreItemKind::AgentMessage {
        text: completed_text,
    } = &completed_item.kind;
    if completed_thread_id != thread_id
        || completed_turn_id != turn_id
        || completed_item.id != started_item.id
        || completed_text != &format!("{started_text}{delta}")
    {
        return Err(EventMappingError);
    }

    let CoreEventKind::TurnCompleted {
        thread_id: terminal_thread_id,
        turn_id: terminal_turn_id,
    } = &turn_completed.kind
    else {
        return Err(EventMappingError);
    };
    if terminal_thread_id != thread_id || terminal_turn_id != turn_id {
        return Err(EventMappingError);
    }

    let public_thread_id = thread_id.as_str().to_string();
    let public_turn_id = turn_id.as_str().to_string();
    let public_item_id = started_item.id.as_str().to_string();
    let turn = PublicTurn {
        id: public_turn_id.clone(),
        status: TurnStatus::InProgress,
    };
    let started_public_item = PublicItem::AgentMessage {
        id: public_item_id.clone(),
        text: started_text.clone(),
    };
    let completed_public_item = PublicItem::AgentMessage {
        id: public_item_id.clone(),
        text: completed_text.clone(),
    };

    let notifications = vec![
        notification(
            "turn/started",
            to_value(TurnStartedNotification {
                thread_id: public_thread_id.clone(),
                turn: turn.clone(),
            })
            .map_err(|_| EventMappingError)?,
        ),
        notification(
            "item/started",
            to_value(ItemStartedNotification {
                thread_id: public_thread_id.clone(),
                turn_id: public_turn_id.clone(),
                item: started_public_item,
            })
            .map_err(|_| EventMappingError)?,
        ),
        notification(
            "item/agentMessage/delta",
            to_value(AgentMessageDeltaNotification {
                thread_id: public_thread_id.clone(),
                turn_id: public_turn_id.clone(),
                item_id: public_item_id,
                delta: delta.clone(),
            })
            .map_err(|_| EventMappingError)?,
        ),
        notification(
            "item/completed",
            to_value(ItemCompletedNotification {
                thread_id: public_thread_id.clone(),
                turn_id: public_turn_id.clone(),
                item: completed_public_item,
            })
            .map_err(|_| EventMappingError)?,
        ),
        notification(
            "turn/completed",
            to_value(TurnCompletedNotification {
                thread_id: public_thread_id,
                turn: PublicTurn {
                    id: public_turn_id,
                    status: TurnStatus::Completed,
                },
            })
            .map_err(|_| EventMappingError)?,
        ),
    ];

    Ok(MappedTurnLifecycle {
        turn,
        notifications,
    })
}

pub(crate) fn map_thread_snapshot(snapshot: DurableThreadSnapshot) -> ThreadResumeResponse {
    let (thread, turns) = map_snapshot_parts(snapshot);
    ThreadResumeResponse { thread, turns }
}

pub(crate) fn map_fork_snapshot(snapshot: DurableThreadSnapshot) -> ThreadForkResponse {
    let (thread, turns) = map_snapshot_parts(snapshot);
    ThreadForkResponse { thread, turns }
}

fn map_snapshot_parts(
    snapshot: DurableThreadSnapshot,
) -> (sugarcode_app_server_protocol::Thread, Vec<TurnSnapshot>) {
    (
        sugarcode_app_server_protocol::Thread {
            id: snapshot.id.into_string(),
        },
        snapshot
            .turns
            .into_iter()
            .map(|turn| TurnSnapshot {
                id: turn.id.into_string(),
                status: TurnSnapshotStatus::Completed,
                items: turn
                    .items
                    .into_iter()
                    .map(|item| match item {
                        DurableItemSnapshot::AgentMessage { id, text } => {
                            PublicItem::AgentMessage {
                                id: id.into_string(),
                                text,
                            }
                        }
                    })
                    .collect(),
            })
            .collect(),
    )
}

fn notification(method: &str, params: serde_json::Value) -> JsonRpcMessage {
    JsonRpcMessage::Notification(JsonRpcNotification {
        jsonrpc: JsonRpcVersion::V2,
        method: method.to_string(),
        params: Some(params),
    })
}
