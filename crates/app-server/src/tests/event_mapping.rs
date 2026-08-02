use super::*;
use sugarcode_protocol::CoreAgentOutputRef;
use sugarcode_protocol::CoreItemSnapshot;
use sugarcode_protocol::ItemId;
use sugarcode_protocol::TurnId;

#[test]
fn provisional_delta_and_resolution_keep_one_output_reference() {
    let thread_id = ThreadId::new("thr_0000000000000001");
    let turn_id = TurnId::new("turn_0000000000000001");
    let output = CoreAgentOutputRef {
        response_ordinal: 2,
        output_index: 0,
    };
    let delta = map_core_event(CoreEvent {
        request_id: CoreRequestId::new(1),
        kind: CoreEventKind::AgentOutputDelta {
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            output,
            delta: "Inspecting".to_string(),
        },
    })
    .expect("delta maps");
    assert_eq!(
        serde_json::to_value(delta).expect("delta serializes"),
        serde_json::json!({
            "jsonrpc": "2.0",
            "method": "turn/agentOutput/delta",
            "params": {
                "threadId": thread_id.as_str(),
                "turnId": turn_id.as_str(),
                "output": {"responseOrdinal": 2, "outputIndex": 0},
                "delta": "Inspecting"
            }
        })
    );

    let resolved = map_core_event(CoreEvent {
        request_id: CoreRequestId::new(1),
        kind: CoreEventKind::AgentOutputResolved {
            thread_id,
            turn_id,
            output,
            item: CoreItemSnapshot {
                id: ItemId::new("item_0000000000000001"),
                kind: CoreItemKind::AgentCommentary {
                    text: "Inspecting".to_string(),
                },
            },
        },
    })
    .expect("resolution maps");
    let value = serde_json::to_value(resolved).expect("resolution serializes");
    assert_eq!(value["method"], "item/started");
    assert_eq!(value["params"]["agentOutput"]["responseOrdinal"], 2);
    assert_eq!(value["params"]["item"]["type"], "agentCommentary");
}

#[test]
fn provisional_delta_can_be_explicitly_discarded() {
    let thread_id = ThreadId::new("thr_0000000000000001");
    let turn_id = TurnId::new("turn_0000000000000001");
    let discarded = map_core_event(CoreEvent {
        request_id: CoreRequestId::new(1),
        kind: CoreEventKind::AgentOutputDiscarded {
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            output: CoreAgentOutputRef {
                response_ordinal: 1,
                output_index: 0,
            },
        },
    })
    .expect("discard maps");
    assert_eq!(
        serde_json::to_value(discarded).expect("discard serializes"),
        serde_json::json!({
            "jsonrpc": "2.0",
            "method": "turn/agentOutput/discarded",
            "params": {
                "threadId": thread_id.as_str(),
                "turnId": turn_id.as_str(),
                "output": {"responseOrdinal": 1, "outputIndex": 0}
            }
        })
    );
}
