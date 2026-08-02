use super::*;
use crate::ModelAssetRef;
use crate::ModelInstruction;
use crate::ModelInstructionSource;
use crate::ModelToolDefinition;
use crate::ModelToolResult;

#[test]
fn chat_strict_auto_is_resolved_per_tool() {
    let request = ModelRequest {
        model: "fixture".to_owned(),
        instructions: Vec::new(),
        messages: Vec::new(),
        tools: vec![
            ModelToolDefinition {
                name: "strict_tool".to_owned(),
                description: "strict".to_owned(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                    "additionalProperties": false
                }),
            },
            ModelToolDefinition {
                name: "loose_tool".to_owned(),
                description: "loose".to_owned(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {"path": {"type": "string"}}
                }),
            },
        ],
    };
    let body = serde_json::to_value(
        ChatRequest::from_model_request(request, ModelStrictToolsMode::Auto, true)
            .expect("chat request"),
    )
    .expect("request JSON");
    assert_eq!(body["tools"][0]["function"]["strict"], true);
    assert_eq!(body["tools"][1]["function"]["strict"], false);
}

#[test]
fn chat_compatibility_baseline_omits_optional_request_fields() {
    let request = ModelRequest {
        model: "fixture".to_owned(),
        instructions: vec![ModelInstruction {
            source: ModelInstructionSource::SugarCodeBaseAgentV1,
            content: "instruction".to_owned(),
        }],
        messages: vec![ModelMessage::user_text("hello".to_owned())],
        tools: vec![ModelToolDefinition {
            name: "workspace/read".to_owned(),
            description: "read".to_owned(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"]
            }),
        }],
    };
    let body = serde_json::to_value(
        ChatRequest::from_model_request(request, ModelStrictToolsMode::Disabled, false)
            .expect("chat request"),
    )
    .expect("request JSON");
    assert_eq!(body["messages"][0]["role"], "system");
    assert!(body.get("stream_options").is_none());
    assert!(body.get("parallel_tool_calls").is_none());
    assert!(body["tools"][0]["function"].get("strict").is_none());
}

#[test]
fn chat_encodes_images_and_rejects_pdf_parts() {
    let image = ModelAssetRef {
        asset_id: format!("ast_{}", "a".repeat(64)),
        sha256: "a".repeat(64),
        media_type: "image/png".to_owned(),
        original_name: "image.png".to_owned(),
        size_bytes: 3,
        bytes: b"png".to_vec(),
    };
    let messages = chat_messages_from_model_messages(vec![ModelMessage {
        role: ModelRole::User,
        content: vec![
            ModelContentPart::Text {
                phase: ModelTextPhase::Final,
                text: "inspect".to_owned(),
            },
            ModelContentPart::ImageAsset(image.clone()),
        ],
    }])
    .expect("image request");
    let value = serde_json::to_value(&messages[0]).expect("chat message");
    assert_eq!(value["content"][0]["type"], "text");
    assert_eq!(value["content"][1]["type"], "image_url");
    assert_eq!(
        value["content"][1]["image_url"]["url"],
        "data:image/png;base64,cG5n"
    );

    let result = chat_messages_from_model_messages(vec![ModelMessage {
        role: ModelRole::User,
        content: vec![ModelContentPart::PdfDocument(ModelAssetRef {
            media_type: "application/pdf".to_owned(),
            original_name: "document.pdf".to_owned(),
            ..image
        })],
    }]);
    let Err(error) = result else {
        panic!("PDF must be rejected");
    };
    assert_eq!(error.kind(), ModelErrorKind::InvalidRequest);
}

#[test]
fn recognized_reasoning_extension_is_replayed_only_on_chat_wire() {
    let raw = serde_json::json!({
        "role": "assistant",
        "content": "Checking.",
        "reasoning_content": "opaque reasoning extension",
        "tool_calls": [{
            "id": "call_1",
            "type": "function",
            "function": {
                "name": "workspace_read",
                "arguments": "{\"path\":\"README.md\"}"
            }
        }]
    });
    let context = ProviderContextEnvelope::new(
        ProviderWireApi::OpenAiChatCompletions,
        Some("request_fixture".to_owned()),
        serde_json::to_vec(&raw).expect("context payload"),
    )
    .expect("context envelope");
    let messages = chat_messages_from_model_messages(vec![
        ModelMessage {
            role: ModelRole::Assistant,
            content: vec![ModelContentPart::ProviderContext(context)],
        },
        ModelMessage::tool_results(vec![ModelToolResult::from_serialized(
            "call_1".to_owned(),
            "contents".to_owned(),
        )]),
    ])
    .expect("chat continuation");

    assert_eq!(messages.len(), 2);
    assert_eq!(
        serde_json::to_value(&messages[0]).expect("assistant message"),
        raw
    );
    assert_eq!(messages[1].role, "tool");
    assert_eq!(messages[1].tool_call_id.as_deref(), Some("call_1"));

    let wrong_wire = ProviderContextEnvelope::new(
        ProviderWireApi::OpenAiResponses,
        None,
        serde_json::to_vec(&serde_json::json!([])).expect("wrong payload"),
    )
    .expect("wrong-wire context");
    let Err(error) = chat_messages_from_model_messages(vec![ModelMessage {
        role: ModelRole::Assistant,
        content: vec![ModelContentPart::ProviderContext(wrong_wire)],
    }]) else {
        panic!("cross-wire replay must fail");
    };
    assert_eq!(error.kind(), ModelErrorKind::InvalidRequest);
}
