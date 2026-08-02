use super::*;
use crate::ModelAssetRef;
use crate::ModelToolDefinition;
use crate::ModelToolResult;

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

fn request_with_strict_and_loose_tools() -> ModelRequest {
    let mut request = continuation_request(Vec::new());
    request.tools = vec![
        ModelToolDefinition {
            name: "strict_tool".to_owned(),
            description: "strict".to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
                "additionalProperties": false
            }),
        },
        ModelToolDefinition {
            name: "loose_tool".to_owned(),
            description: "loose".to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {"path": {"type": "string"}}
            }),
        },
    ];
    request
}

fn asset(media_type: &str, original_name: &str, bytes: &[u8]) -> ModelAssetRef {
    ModelAssetRef {
        asset_id: format!("ast_{}", "a".repeat(64)),
        sha256: "a".repeat(64),
        media_type: media_type.to_owned(),
        original_name: original_name.to_owned(),
        size_bytes: bytes.len() as u64,
        bytes: bytes.to_vec(),
    }
}

#[test]
fn native_wire_apis_encode_image_and_pdf_parts() {
    let request = continuation_request(vec![ModelMessage {
        role: ModelRole::User,
        content: vec![
            ModelContentPart::Text {
                phase: ModelTextPhase::Final,
                text: "inspect".to_owned(),
            },
            ModelContentPart::ImageAsset(asset("image/png", "image.png", b"png")),
            ModelContentPart::PdfDocument(asset("application/pdf", "document.pdf", b"pdf")),
        ],
    }]);

    let responses = openai_request(&request, ModelStrictToolsMode::Auto, true, 1024)
        .expect("Responses request");
    assert_eq!(responses["input"][0]["content"][1]["type"], "input_image");
    assert_eq!(responses["input"][0]["content"][2]["type"], "input_file");

    let anthropic =
        anthropic_request(&request, ModelStrictToolsMode::Auto, 1024).expect("Anthropic request");
    assert_eq!(anthropic["messages"][0]["content"][1]["type"], "image");
    assert_eq!(anthropic["messages"][0]["content"][2]["type"], "document");
    assert_eq!(
        anthropic["messages"][0]["content"][2]["source"]["data"],
        "cGRm"
    );

    let gemini =
        gemini_request(&request, ModelStrictToolsMode::Auto, 1024).expect("Gemini request");
    assert_eq!(
        gemini["contents"][0]["parts"][1]["inlineData"]["mimeType"],
        "image/png"
    );
    assert_eq!(
        gemini["contents"][0]["parts"][2]["inlineData"]["mimeType"],
        "application/pdf"
    );
}

#[test]
fn strict_auto_is_resolved_per_tool_and_enabled_rejects_before_io() {
    let request = request_with_strict_and_loose_tools();
    let openai = openai_request(&request, ModelStrictToolsMode::Auto, true, 1024)
        .expect("OpenAI auto request");
    assert_eq!(openai["tools"][0]["strict"], true);
    assert_eq!(openai["tools"][1]["strict"], false);

    let anthropic = anthropic_request(&request, ModelStrictToolsMode::Auto, 1024)
        .expect("Anthropic auto request");
    assert_eq!(anthropic["tools"][0]["strict"], true);
    assert_eq!(anthropic["tools"][1]["strict"], false);

    let error = openai_request(&request, ModelStrictToolsMode::Enabled, true, 1024)
        .expect_err("strict enabled must reject the loose tool");
    assert_eq!(error.tool_name(), Some("loose_tool"));
    assert!(error.schema_reason().is_some());
}

#[test]
fn openai_responses_replays_encrypted_reasoning_and_output_items_in_order() {
    let raw_output = json!([
        {
            "type": "reasoning",
            "id": "reasoning_1",
            "encrypted_content": "opaque-encrypted-reasoning"
        },
        {
            "type": "function_call",
            "call_id": "call_1",
            "name": "workspace_read",
            "arguments": "{\"path\":\"README.md\"}"
        }
    ]);
    let request = continuation_request(vec![
        continuation_message(ProviderWireApi::OpenAiResponses, raw_output.clone()),
        ModelMessage::tool_results(vec![ModelToolResult::from_serialized(
            "call_1".to_owned(),
            "contents".to_owned(),
        )]),
    ]);

    let body = openai_request(&request, ModelStrictToolsMode::Auto, true, 1024).expect("request");
    let input = body["input"].as_array().expect("input items");
    assert_eq!(&input[..2], raw_output.as_array().expect("raw output"));
    assert_eq!(body["input"][2]["type"], "function_call_output");
    assert_eq!(body["input"][2]["call_id"], "call_1");
    assert_eq!(body["store"], false);
    assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
}

#[test]
fn provider_managed_responses_uses_previous_response_id_and_only_sends_tail() {
    let request = continuation_request(vec![
        ModelMessage::user_text("original task".to_owned()),
        continuation_message(
            ProviderWireApi::OpenAiResponses,
            json!([{"type": "reasoning", "encrypted_content": "opaque"}]),
        ),
        ModelMessage::tool_results(vec![ModelToolResult::from_serialized(
            "call_1".to_owned(),
            "contents".to_owned(),
        )]),
    ]);

    let body = openai_provider_managed_request(&request, ModelStrictToolsMode::Auto, true, 1024)
        .expect("provider-managed request");
    assert_eq!(body["store"], true);
    assert_eq!(body["previous_response_id"], "response_fixture");
    assert_eq!(body["input"].as_array().map(Vec::len), Some(1));
    assert_eq!(body["input"][0]["type"], "function_call_output");
    assert!(!body.to_string().contains("opaque"));
    assert!(!body.to_string().contains("original task"));
}

#[test]
fn anthropic_replays_thinking_signatures_and_block_order() {
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
fn gemini_replays_thought_signatures_and_groups_parallel_function_responses() {
    let raw_content = json!({
        "role": "model",
        "parts": [
            {"text": "private thought", "thought": true, "thoughtSignature": "sig-1"},
            {"functionCall": {"id": "call_1", "name": "workspace_read", "args": {"path": "a.md"}}},
            {"functionCall": {"id": "call_2", "name": "workspace_read", "args": {"path": "b.md"}}}
        ]
    });
    let request = continuation_request(vec![
        continuation_message(ProviderWireApi::GeminiGenerateContent, raw_content.clone()),
        ModelMessage::tool_results(vec![
            ModelToolResult::from_serialized("call_1".to_owned(), "a".to_owned()),
            ModelToolResult::from_serialized("call_2".to_owned(), "b".to_owned()),
        ]),
    ]);

    let body = gemini_request(&request, ModelStrictToolsMode::Auto, 1024).expect("request");
    assert_eq!(body["contents"][0], raw_content);
    assert_eq!(body["contents"][1]["role"], "user");
    let responses = body["contents"][1]["parts"]
        .as_array()
        .expect("parallel responses");
    assert_eq!(responses.len(), 2);
    assert_eq!(responses[0]["functionResponse"]["id"], "call_1");
    assert_eq!(responses[0]["functionResponse"]["name"], "workspace_read");
    assert_eq!(responses[1]["functionResponse"]["id"], "call_2");
    assert_eq!(responses[1]["functionResponse"]["name"], "workspace_read");
}

#[test]
fn provider_context_cannot_cross_wire_apis() {
    let request = continuation_request(vec![continuation_message(
        ProviderWireApi::AnthropicMessages,
        json!([]),
    )]);
    let error = openai_request(&request, ModelStrictToolsMode::Auto, true, 1024)
        .expect_err("wire mismatch");
    assert_eq!(error.kind(), ModelErrorKind::InvalidRequest);
}

#[tokio::test]
async fn openai_sse_completion_restores_internal_tool_names_and_usage() {
    let (sender, mut receiver) = mpsc::channel(4);
    let mut state = OpenAiStreamState::default();
    let value = json!({
        "type": "response.completed",
        "response": {
            "output": [
                {
                    "type": "message",
                    "content": [{"type": "output_text", "text": "Checking."}]
                },
                {
                    "type": "function_call",
                    "call_id": "call_1",
                    "name": "workspace_read",
                    "arguments": "{\"path\":\"README.md\"}"
                }
            ],
            "usage": {
                "input_tokens": 12,
                "output_tokens": 3,
                "total_tokens": 15
            }
        }
    });
    let StreamProgress::Complete(response) = state
        .consume("response.completed", value, &sender, &tool_names())
        .await
        .expect("completed response")
    else {
        panic!("completion event");
    };
    assert!(receiver.try_recv().is_err());
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
        Some(15)
    );
    assert_eq!(response.terminal.finish_reason, ModelFinishReason::Stop);
}

#[tokio::test]
async fn openai_sse_ignores_optional_response_progress_events() {
    let (sender, _receiver) = mpsc::channel(4);
    let mut state = OpenAiStreamState::default();

    for event_name in [
        "response.output_text.annotation.added",
        "response.refusal.delta",
        "response.code_interpreter_call.in_progress",
        "response.future_progress_event",
    ] {
        assert!(matches!(
            state
                .consume(event_name, json!({}), &sender, &tool_names())
                .await
                .expect("optional progress event"),
            StreamProgress::Continue
        ));
    }

    let Err(error) = state
        .consume("message", json!({"choices": []}), &sender, &tool_names())
        .await
    else {
        panic!("a Chat Completions chunk is not a Responses event");
    };
    assert_eq!(error.kind(), ModelErrorKind::UnsupportedOutput);
}

#[tokio::test]
async fn openai_sse_uses_completed_output_items_over_response_snapshot() {
    let (sender, mut receiver) = mpsc::channel(4);
    let mut state = OpenAiStreamState::default();
    state
        .consume(
            "response.output_text.delta",
            json!({"delta": "Final answer."}),
            &sender,
            &tool_names(),
        )
        .await
        .expect("text delta");
    state
        .consume(
            "response.output_item.done",
            json!({
                "item": {
                    "type": "message",
                    "content": [{"type": "output_text", "text": "Final answer."}]
                }
            }),
            &sender,
            &tool_names(),
        )
        .await
        .expect("completed output item");
    let StreamProgress::Complete(response) = state
        .consume(
            "response.completed",
            json!({
                "response": {
                    "id": "resp_compatible",
                    "output": [{
                        "type": "message",
                        "content": [{"type": "output_text", "text": "stale snapshot"}]
                    }],
                    "usage": {"input_tokens": 12, "output_tokens": 3}
                }
            }),
            &sender,
            &tool_names(),
        )
        .await
        .expect("completed response")
    else {
        panic!("completion event");
    };

    assert!(matches!(
        receiver.try_recv(),
        Ok(Ok(ModelEvent::OutputTextDelta { delta, .. })) if delta == "Final answer."
    ));
    assert!(matches!(
        &response.output[0].kind,
        ModelOutputItemKind::AssistantText { text, .. } if text == "Final answer."
    ));
}

#[test]
fn openai_completed_response_preserves_visible_refusals() {
    let response = parse_openai_response(json!({
        "id": "resp_refusal",
        "status": "completed",
        "output": [{
            "type": "message",
            "content": [{"type": "refusal", "refusal": "I cannot help with that."}]
        }]
    }))
    .expect("visible refusal");

    assert!(matches!(
        &response.output[0].kind,
        ModelOutputItemKind::AssistantText {
            phase: ModelTextPhase::Final,
            text,
        } if text == "I cannot help with that."
    ));
}

#[tokio::test]
async fn anthropic_sse_assembles_text_tool_arguments_and_usage() {
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

#[tokio::test]
async fn gemini_sse_accumulates_chunks_and_emits_deltas() {
    let (sender, mut receiver) = mpsc::channel(8);
    let mut state = GeminiStreamState::default();
    state
        .consume(
            json!({"candidates": [{"content": {"parts": [{"text": "Hello "}]}}]}),
            &sender,
            &tool_names(),
        )
        .await
        .expect("first chunk");
    state
        .consume(
            json!({
                "candidates": [{"content": {"parts": [{
                    "functionCall": {
                        "id": "call_1",
                        "name": "workspace_read",
                        "args": {"path": "README.md"}
                    }
                }]}}],
                "usageMetadata": {
                    "promptTokenCount": 8,
                    "candidatesTokenCount": 4,
                    "totalTokenCount": 12
                }
            }),
            &sender,
            &tool_names(),
        )
        .await
        .expect("second chunk");
    assert!(matches!(
        receiver.recv().await,
        Some(Ok(ModelEvent::OutputTextDelta { delta, .. })) if delta == "Hello "
    ));
    let response = state.response().expect("response");
    assert!(matches!(
        &response.output[0].kind,
        ModelOutputItemKind::AssistantText {
            phase: ModelTextPhase::Commentary,
            text,
        } if text == "Hello "
    ));
    assert!(matches!(
        &response.output[1].kind,
        ModelOutputItemKind::ToolCall(call) if call.name == "workspace/read"
    ));
    assert_eq!(
        response.usage.and_then(|usage| usage.total_tokens),
        Some(12)
    );
}

#[test]
fn native_requests_enable_streaming_and_gemini_uses_sse_endpoint() {
    let request = ModelRequest {
        model: "model/id".to_owned(),
        instructions: Vec::new(),
        messages: Vec::new(),
        tools: Vec::new(),
    };
    assert_eq!(
        openai_request(&request, ModelStrictToolsMode::Auto, true, 4096).expect("OpenAI request")["stream"],
        true
    );
    assert_eq!(
        anthropic_request(&request, ModelStrictToolsMode::Auto, 4096).expect("Anthropic request")["stream"],
        true
    );
    assert_eq!(
        gemini_stream_endpoint(
            &Url::parse("https://generativelanguage.googleapis.com/v1beta").expect("base URL"),
            &request.model,
        )
        .expect("stream URL")
        .as_str(),
        "https://generativelanguage.googleapis.com/v1beta/models/model%2Fid:streamGenerateContent?alt=sse"
    );
}
