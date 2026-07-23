use serde_json::json;
use sugarcode_app_server_protocol::AgentMessageDeltaNotification;
use sugarcode_app_server_protocol::ERROR_PARSE;
use sugarcode_app_server_protocol::Item;
use sugarcode_app_server_protocol::ItemCompletedNotification;
use sugarcode_app_server_protocol::ItemStartedNotification;
use sugarcode_app_server_protocol::JsonRpcError;
use sugarcode_app_server_protocol::JsonRpcErrorObject;
use sugarcode_app_server_protocol::JsonRpcMessage;
use sugarcode_app_server_protocol::JsonRpcVersion;
use sugarcode_app_server_protocol::RequestId;
use sugarcode_app_server_protocol::Thread;
use sugarcode_app_server_protocol::ThreadStartParams;
use sugarcode_app_server_protocol::ThreadStartResponse;
use sugarcode_app_server_protocol::ThreadStartedNotification;
use sugarcode_app_server_protocol::Turn;
use sugarcode_app_server_protocol::TurnCompletedNotification;
use sugarcode_app_server_protocol::TurnStartParams;
use sugarcode_app_server_protocol::TurnStartResponse;
use sugarcode_app_server_protocol::TurnStartedNotification;
use sugarcode_app_server_protocol::TurnStatus;

#[test]
fn error_envelope_uses_json_rpc_2_and_null_unknown_id() {
    let message = JsonRpcMessage::Error(JsonRpcError {
        jsonrpc: JsonRpcVersion::V2,
        id: None,
        error: JsonRpcErrorObject {
            code: ERROR_PARSE,
            message: "Parse error".to_string(),
            data: None,
        },
    });

    assert_eq!(
        serde_json::to_value(message).expect("message serializes"),
        json!({
            "jsonrpc": "2.0",
            "id": null,
            "error": {
                "code": -32700,
                "message": "Parse error"
            }
        })
    );
}

#[test]
fn request_ids_support_strings_and_integers() {
    for id in [
        RequestId::String("request-1".to_string()),
        RequestId::Integer(7),
    ] {
        let encoded = serde_json::to_string(&id).expect("id serializes");
        let decoded = serde_json::from_str::<RequestId>(&encoded).expect("id deserializes");
        assert_eq!(decoded, id);
    }
}

#[test]
fn thread_start_types_use_the_public_thread_dto() {
    let thread = Thread {
        id: "thr_0000000000000001".to_string(),
    };

    assert_eq!(
        serde_json::to_value(ThreadStartResponse {
            thread: thread.clone(),
        })
        .expect("response serializes"),
        json!({
            "thread": {
                "id": "thr_0000000000000001"
            }
        })
    );
    assert_eq!(
        serde_json::to_value(ThreadStartedNotification { thread })
            .expect("notification serializes"),
        json!({
            "thread": {
                "id": "thr_0000000000000001"
            }
        })
    );
}

#[test]
fn thread_start_params_accept_only_an_empty_object() {
    assert!(serde_json::from_value::<ThreadStartParams>(json!({})).is_ok());
    for invalid in [
        json!(null),
        json!([]),
        json!("invalid"),
        json!({"model": "not-supported-yet"}),
    ] {
        assert!(
            serde_json::from_value::<ThreadStartParams>(invalid).is_err(),
            "non-empty or non-object params must be rejected"
        );
    }
}

#[test]
fn turn_start_types_use_the_public_turn_dto() {
    let turn = Turn {
        id: "turn_0000000000000001".to_string(),
        status: TurnStatus::InProgress,
    };

    assert_eq!(
        serde_json::to_value(TurnStartResponse { turn: turn.clone() })
            .expect("response serializes"),
        json!({
            "turn": {
                "id": "turn_0000000000000001",
                "status": "inProgress"
            }
        })
    );
    assert_eq!(
        serde_json::to_value(TurnStartedNotification {
            thread_id: "thr_0000000000000001".to_string(),
            turn,
        })
        .expect("notification serializes"),
        json!({
            "threadId": "thr_0000000000000001",
            "turn": {
                "id": "turn_0000000000000001",
                "status": "inProgress"
            }
        })
    );
}

#[test]
fn agent_message_item_lifecycle_types_preserve_correlation_and_text() {
    let thread_id = "thr_0000000000000001".to_string();
    let turn_id = "turn_0000000000000001".to_string();
    let item_id = "item_0000000000000001".to_string();
    let started_item = Item::AgentMessage {
        id: item_id.clone(),
        text: String::new(),
    };
    let completed_item = Item::AgentMessage {
        id: item_id.clone(),
        text: "SugarCode deterministic response.".to_string(),
    };

    assert_eq!(
        serde_json::to_value(ItemStartedNotification {
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            item: started_item,
        })
        .expect("item/started serializes"),
        json!({
            "threadId": thread_id,
            "turnId": turn_id,
            "item": {
                "type": "agentMessage",
                "id": item_id,
                "text": ""
            }
        })
    );
    assert_eq!(
        serde_json::to_value(AgentMessageDeltaNotification {
            thread_id: "thr_0000000000000001".to_string(),
            turn_id: "turn_0000000000000001".to_string(),
            item_id: "item_0000000000000001".to_string(),
            delta: "SugarCode deterministic response.".to_string(),
        })
        .expect("agent message delta serializes"),
        json!({
            "threadId": "thr_0000000000000001",
            "turnId": "turn_0000000000000001",
            "itemId": "item_0000000000000001",
            "delta": "SugarCode deterministic response."
        })
    );
    assert_eq!(
        serde_json::to_value(ItemCompletedNotification {
            thread_id: "thr_0000000000000001".to_string(),
            turn_id: "turn_0000000000000001".to_string(),
            item: completed_item,
        })
        .expect("item/completed serializes"),
        json!({
            "threadId": "thr_0000000000000001",
            "turnId": "turn_0000000000000001",
            "item": {
                "type": "agentMessage",
                "id": "item_0000000000000001",
                "text": "SugarCode deterministic response."
            }
        })
    );
    assert_eq!(
        serde_json::to_value(TurnCompletedNotification {
            thread_id: "thr_0000000000000001".to_string(),
            turn: Turn {
                id: "turn_0000000000000001".to_string(),
                status: TurnStatus::Completed,
            },
        })
        .expect("turn/completed serializes"),
        json!({
            "threadId": "thr_0000000000000001",
            "turn": {
                "id": "turn_0000000000000001",
                "status": "completed"
            }
        })
    );
}

#[test]
fn turn_start_params_require_one_non_blank_thread_id() {
    assert_eq!(
        serde_json::from_value::<TurnStartParams>(json!({
            "threadId": "thr_0000000000000001"
        }))
        .expect("valid params"),
        TurnStartParams {
            thread_id: "thr_0000000000000001".to_string()
        }
    );

    for invalid in [
        json!(null),
        json!([]),
        json!("invalid"),
        json!({}),
        json!({"threadId": null}),
        json!({"threadId": ""}),
        json!({"threadId": "   "}),
        json!({"threadId": "thr_0000000000000001", "input": []}),
    ] {
        assert!(
            serde_json::from_value::<TurnStartParams>(invalid).is_err(),
            "missing, blank, or unknown turn/start params must be rejected"
        );
    }
}
