use super::requests::anthropic_request;
use super::streaming::AnthropicStreamState;
use crate::ModelContentPart;
use crate::ModelEvent;
use crate::ModelMessage;
use crate::ModelOutputItemKind;
use crate::ModelRequest;
use crate::ModelRole;
use crate::ModelStrictToolsMode;
use crate::ModelTextPhase;
use crate::ModelToolCall;
use crate::ModelToolResult;
use crate::ProviderContextEnvelope;
use crate::ProviderWireApi;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use tokio::sync::mpsc;

fn tool_names() -> BTreeMap<String, String> {
    BTreeMap::from([("workspace_read".to_owned(), "workspace/read".to_owned())])
}

fn continuation_message(wire_api: ProviderWireApi, payload: Value) -> ModelMessage {
    ModelMessage {
        role: ModelRole::Assistant,
        content: vec![ModelContentPart::ProviderContext(
            ProviderContextEnvelope::new(
                wire_api,
                Some("response_fixture".to_owned()),
                serde_json::to_vec(&payload).expect("context payload"),
            )
            .expect("provider context"),
        )],
    }
}

fn continuation_request(messages: Vec<ModelMessage>) -> ModelRequest {
    ModelRequest {
        model: "fixture-model".to_owned(),
        instructions: Vec::new(),
        messages,
        tools: Vec::new(),
    }
}

#[test]
fn replays_thinking_signatures_and_block_order() {
    let raw_blocks = json!([
        {
            "type": "thinking",
            "thinking": "private chain",
            "signature": "opaque-signature"
        },
        {"type": "redacted_thinking", "data": "opaque-redacted"},
        {
            "type": "tool_use",
            "id": "call_1",
            "name": "workspace_read",
            "input": {"path": "README.md"}
        }
    ]);
    let request = continuation_request(vec![
        continuation_message(ProviderWireApi::AnthropicMessages, raw_blocks.clone()),
        ModelMessage::tool_results(vec![ModelToolResult::from_serialized(
            "call_1".to_owned(),
            "contents".to_owned(),
        )]),
    ]);

    let body = anthropic_request(&request, ModelStrictToolsMode::Auto, 1024).expect("request");
    assert_eq!(body["messages"][0]["role"], "assistant");
    assert_eq!(body["messages"][0]["content"], raw_blocks);
    assert_eq!(body["messages"][1]["content"][0]["tool_use_id"], "call_1");
}

#[test]
fn coalesces_portable_tool_batches_and_consecutive_roles() {
    let request = continuation_request(vec![
        ModelMessage::user_text("inspect".to_owned()),
        ModelMessage::assistant_text(ModelTextPhase::Commentary, "checking".to_owned()),
        ModelMessage::tool_calls(vec![ModelToolCall {
            id: "call_1".to_owned(),
            name: "workspace_read".to_owned(),
            arguments: json!({"path": "a.md"}),
        }]),
        ModelMessage::tool_calls(vec![ModelToolCall {
            id: "call_2".to_owned(),
            name: "workspace_read".to_owned(),
            arguments: json!({"path": "b.md"}),
        }]),
        ModelMessage::tool_results(vec![ModelToolResult::from_serialized(
            "call_1".to_owned(),
            "a".to_owned(),
        )]),
        ModelMessage::tool_results(vec![ModelToolResult::from_serialized(
            "call_2".to_owned(),
            "b".to_owned(),
        )]),
        ModelMessage::assistant_text(ModelTextPhase::Final, "done".to_owned()),
        ModelMessage::user_text("retry".to_owned()),
        ModelMessage::user_text("continue".to_owned()),
    ]);

    let body = anthropic_request(&request, ModelStrictToolsMode::Auto, 1024).expect("request");
    let messages = body["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 5);
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(
        messages[1]["content"]
            .as_array()
            .expect("assistant content")
            .iter()
            .map(|block| block["type"].as_str().expect("block type"))
            .collect::<Vec<_>>(),
        ["text", "tool_use", "tool_use"]
    );
    assert_eq!(messages[2]["role"], "user");
    assert_eq!(
        messages[2]["content"]
            .as_array()
            .expect("tool result content")
            .iter()
            .map(|block| block["tool_use_id"].as_str().expect("tool use id"))
            .collect::<Vec<_>>(),
        ["call_1", "call_2"]
    );
    assert_eq!(messages[4]["role"], "user");
    assert_eq!(messages[4]["content"].as_array().map(Vec::len), Some(2));
}

#[tokio::test]
async fn sse_assembles_text_tool_arguments_and_usage() {
    let (sender, mut receiver) = mpsc::channel(8);
    let mut state = AnthropicStreamState::default();
    state
        .consume(
            "message_start",
            json!({"message": {"usage": {"input_tokens": 10}}}),
            &sender,
        )
        .await
        .expect("message start");
    state
        .consume(
            "content_block_start",
            json!({"index": 0, "content_block": {"type": "text", "text": ""}}),
            &sender,
        )
        .await
        .expect("text start");
    state
        .consume(
            "content_block_delta",
            json!({"index": 0, "delta": {"type": "text_delta", "text": "Checking."}}),
            &sender,
        )
        .await
        .expect("text delta");
    state
        .consume(
            "content_block_start",
            json!({"index": 1, "content_block": {
                "type": "tool_use",
                "id": "call_1",
                "name": "workspace_read",
                "input": {}
            }}),
            &sender,
        )
        .await
        .expect("tool start");
    state
        .consume(
            "content_block_delta",
            json!({"index": 1, "delta": {
                "type": "input_json_delta",
                "partial_json": "{\"path\":\"README.md\"}"
            }}),
            &sender,
        )
        .await
        .expect("tool delta");
    state
        .consume(
            "message_delta",
            json!({"usage": {"output_tokens": 7}}),
            &sender,
        )
        .await
        .expect("usage");
    assert!(matches!(
        receiver.recv().await,
        Some(Ok(ModelEvent::OutputTextDelta { delta, .. })) if delta == "Checking."
    ));
    let response = state.response(&tool_names()).expect("response");
    assert!(matches!(
        &response.output[0].kind,
        ModelOutputItemKind::AssistantText {
            phase: ModelTextPhase::Commentary,
            text,
        } if text == "Checking."
    ));
    assert!(matches!(
        &response.output[1].kind,
        ModelOutputItemKind::ToolCall(call)
            if call.name == "workspace/read"
                && call.arguments == json!({"path": "README.md"})
    ));
    assert_eq!(
        response.usage.and_then(|usage| usage.total_tokens),
        Some(17)
    );
}
