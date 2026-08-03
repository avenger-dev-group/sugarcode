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
fn openai_responses_explicitly_requests_sequential_tool_calls() {
    let request = request_with_strict_and_loose_tools();
    let body = openai_request(&request, ModelStrictToolsMode::Auto, false, 1024)
        .expect("Responses request");

    assert_eq!(body["parallel_tool_calls"], false);
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
fn anthropic_coalesces_portable_tool_batches_and_consecutive_roles() {
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
    assert!(response.provider_context.is_none());
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
    assert_eq!(error.kind(), ModelErrorKind::Protocol);
    assert_eq!(
        error
            .protocol_diagnostic()
            .map(|diagnostic| diagnostic.code()),
        Some(ModelProtocolCode::WireMismatch)
    );
}

#[tokio::test]
async fn openai_sse_normalizes_compatible_cumulative_text_deltas() {
    let (sender, mut receiver) = mpsc::channel(4);
    let mut state = OpenAiStreamState::default();

    for delta in ["A", "AB", "ABC"] {
        state
            .consume(
                "response.output_text.delta",
                json!({"output_index": 2, "delta": delta}),
                &sender,
                &tool_names(),
            )
            .await
            .expect("compatible cumulative delta");
    }

    let deltas = (0..3)
        .map(|_| receiver.try_recv().expect("normalized delta"))
        .collect::<Result<Vec<_>, _>>()
        .expect("successful deltas");
    assert_eq!(
        deltas,
        vec![
            ModelEvent::OutputTextDelta {
                output_index: 0,
                delta: "A".to_owned(),
            },
            ModelEvent::OutputTextDelta {
                output_index: 0,
                delta: "B".to_owned(),
            },
            ModelEvent::OutputTextDelta {
                output_index: 0,
                delta: "C".to_owned(),
            },
        ]
    );
}

#[tokio::test]
async fn openai_sse_preserves_standard_non_prefix_text_deltas() {
    let (sender, mut receiver) = mpsc::channel(4);
    let mut state = OpenAiStreamState::default();

    for delta in ["Hello ", "world"] {
        state
            .consume(
                "response.output_text.delta",
                json!({"delta": delta}),
                &sender,
                &tool_names(),
            )
            .await
            .expect("standard delta");
    }

    let text = (0..2)
        .map(
            |_| match receiver.try_recv().expect("text delta").expect("success") {
                ModelEvent::OutputTextDelta { delta, .. } => delta,
                _ => panic!("text delta"),
            },
        )
        .collect::<String>();
    assert_eq!(text, "Hello world");
}

#[tokio::test]
async fn openai_sse_discards_only_an_oversized_provisional_preview() {
    let (sender, mut receiver) = mpsc::channel(4);
    let mut state = OpenAiStreamState::default();
    state
        .consume(
            "response.output_text.delta",
            json!({"output_index": 0, "delta": "preview"}),
            &sender,
            &tool_names(),
        )
        .await
        .expect("initial preview");
    state
        .consume(
            "response.output_text.delta",
            json!({
                "output_index": 0,
                "delta": "x".repeat(MAX_SEMANTIC_OUTPUT_BYTES + 1),
            }),
            &sender,
            &tool_names(),
        )
        .await
        .expect("oversized provisional preview is presentation-only");
    let StreamProgress::Complete(response) = state
        .consume(
            "response.completed",
            json!({
                "response": {
                    "status": "completed",
                    "output": [{
                        "type": "message",
                        "content": [{
                            "type": "output_text",
                            "text": "Authoritative final answer."
                        }]
                    }]
                }
            }),
            &sender,
            &tool_names(),
        )
        .await
        .expect("authoritative completion remains valid")
    else {
        panic!("completion event");
    };

    assert!(matches!(
        receiver.try_recv(),
        Ok(Ok(ModelEvent::OutputTextDelta { delta, .. })) if delta == "preview"
    ));
    assert!(receiver.try_recv().is_err());
    assert!(matches!(
        &response.output[0].kind,
        ModelOutputItemKind::AssistantText { text, .. }
            if text == "Authoritative final answer."
    ));
}

#[tokio::test]
async fn openai_sse_uses_completed_response_snapshot_as_authority() {
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
                "output_index": 0,
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
        ModelOutputItemKind::AssistantText { text, .. } if text == "stale snapshot"
    ));
}

#[tokio::test]
async fn openai_sse_ignores_partial_done_items_when_snapshot_is_present() {
    let (sender, mut receiver) = mpsc::channel(4);
    let mut state = OpenAiStreamState::default();
    state
        .consume(
            "response.output_text.delta",
            json!({"output_index": 1, "delta": "Checking the project."}),
            &sender,
            &tool_names(),
        )
        .await
        .expect("commentary delta");
    state
        .consume(
            "response.output_item.done",
            json!({
                "output_index": 2,
                "item": {
                    "type": "function_call",
                    "id": "fc_1",
                    "call_id": "call_1",
                    "name": "workspace_read",
                    "arguments": "{\"path\":\"README.md\"}"
                }
            }),
            &sender,
            &tool_names(),
        )
        .await
        .expect("partial completed output item");
    let StreamProgress::Complete(response) = state
        .consume(
            "response.completed",
            json!({
                "response": {
                    "id": "resp_partial_done",
                    "status": "completed",
                    "output": [
                        {"type": "reasoning", "id": "reasoning_1"},
                        {
                            "type": "message",
                            "id": "message_1",
                            "content": [{
                                "type": "output_text",
                                "text": "Checking the project."
                            }]
                        },
                        {
                            "type": "function_call",
                            "id": "fc_1",
                            "call_id": "call_1",
                            "name": "workspace_read",
                            "arguments": "{\"path\":\"stale.md\"}"
                        }
                    ],
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
        Ok(Ok(ModelEvent::OutputTextDelta { delta, .. }))
            if delta == "Checking the project."
    ));
    assert!(matches!(
        &response.output[0].kind,
        ModelOutputItemKind::AssistantText {
            phase: ModelTextPhase::Commentary,
            text,
        } if text == "Checking the project."
    ));
    assert!(matches!(
        &response.output[1].kind,
        ModelOutputItemKind::ToolCall(call)
            if call.name == "workspace/read"
                && call.arguments == json!({"path": "stale.md"})
    ));
}

#[tokio::test]
async fn openai_sse_uses_done_items_only_when_snapshot_is_empty() {
    let (sender, _receiver) = mpsc::channel(4);
    let mut state = OpenAiStreamState::default();
    state
        .consume(
            "response.output_item.done",
            json!({
                "item": {
                    "type": "function_call",
                    "id": "fc_1",
                    "call_id": "call_1",
                    "name": "workspace_read",
                    "arguments": "{\"path\":\"README.md\"}"
                }
            }),
            &sender,
            &tool_names(),
        )
        .await
        .expect("unindexed completed output item");
    let StreamProgress::Complete(response) = state
        .consume(
            "response.completed",
            json!({
            "response": {
                        "status": "completed",
                        "output": [

                        ]
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
        &response.output[0].kind,
        ModelOutputItemKind::ToolCall(call)
            if call.name == "workspace/read"
                && call.arguments == json!({"path": "README.md"})
    ));
}

#[tokio::test]
async fn openai_sse_deduplicates_stable_done_items_and_ignores_snapshot_ids() {
    let (sender, _receiver) = mpsc::channel(4);
    let mut duplicate = OpenAiStreamState::default();
    for id in ["message_1", "message_1"] {
        duplicate
            .consume(
                "response.output_item.done",
                json!({
                    "output_index": 0,
                    "item": {
                        "type": "message",
                        "id": id,
                        "content": [{"type": "output_text", "text": "Recovered."}]
                    }
                }),
                &sender,
                &tool_names(),
            )
            .await
            .expect("buffer duplicate index until completion");
    }
    let StreamProgress::Complete(duplicate_response) = duplicate
        .consume(
            "response.completed",
            json!({
                "response": {
                    "output": []
                }
            }),
            &sender,
            &tool_names(),
        )
        .await
        .expect("duplicate stable item is idempotent")
    else {
        panic!("completion event");
    };
    assert_eq!(duplicate_response.output.len(), 1);
    assert!(matches!(
        &duplicate_response.output[0].kind,
        ModelOutputItemKind::AssistantText { text, .. } if text == "Recovered."
    ));

    let mut reidentified = OpenAiStreamState::default();
    reidentified
        .consume(
            "response.output_item.done",
            json!({
                "output_index": 0,
                "item": {
                    "type": "message",
                    "id": "gateway_stream_id",
                    "content": [{"type": "output_text", "text": "Final answer."}]
                }
            }),
            &sender,
            &tool_names(),
        )
        .await
        .expect("buffer reidentified item");
    let StreamProgress::Complete(response) = reidentified
        .consume(
            "response.completed",
            json!({
                "response": {
                    "output": [{
                        "type": "message",
                        "id": "gateway_snapshot_id",
                        "content": [{"type": "output_text", "text": "Stale answer."}]
                    }]
                }
            }),
            &sender,
            &tool_names(),
        )
        .await
        .expect("reidentified output at the same index")
    else {
        panic!("completion event");
    };
    assert!(matches!(
        &response.output[0].kind,
        ModelOutputItemKind::AssistantText { text, .. } if text == "Stale answer."
    ));
}

#[tokio::test]
async fn openai_sse_prefers_final_function_call_over_done_commentary() {
    let (sender, _receiver) = mpsc::channel(4);
    let mut state = OpenAiStreamState::default();
    state
        .consume(
            "response.output_item.done",
            json!({
                "output_index": 0,
                "item": {
                    "type": "message",
                    "id": "gateway_stream_message",
                    "content": [{
                        "type": "output_text",
                        "text": "I will inspect the project."
                    }]
                }
            }),
            &sender,
            &tool_names(),
        )
        .await
        .expect("streamed commentary item");
    let StreamProgress::Complete(response) = state
        .consume(
            "response.completed",
            json!({
                "response": {
                    "status": "completed",
                    "output": [{
                        "type": "function_call",
                        "id": "fc_snapshot",
                        "call_id": "call_snapshot",
                        "name": "workspace_read",
                        "arguments": "{\"path\":\"README.md\"}"
                    }]
                }
            }),
            &sender,
            &tool_names(),
        )
        .await
        .expect("completed response with reused index")
    else {
        panic!("completion event");
    };

    assert_eq!(response.output.len(), 1);
    assert!(matches!(
        &response.output[0].kind,
        ModelOutputItemKind::ToolCall(call)
            if call.name == "workspace/read"
                && call.arguments == json!({"path": "README.md"})
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

#[test]
fn openai_completed_response_normalizes_compatible_function_call_fields() {
    let response = parse_openai_response(json!({
        "id": "resp_tool",
        "status": "completed",
        "output": [{
            "type": "function_call",
            "id": "fc_1",
            "name": "workspace_read",
            "arguments": {"path": "README.md"}
        }]
    }))
    .expect("compatible function call");

    assert!(matches!(
        &response.output[0].kind,
        ModelOutputItemKind::ToolCall(call)
            if call.id == "fc_1"
                && call.arguments == json!({"path": "README.md"})
    ));
}

#[test]
fn openai_completed_response_accepts_nested_functions_and_omitted_arguments() {
    let response = parse_openai_response(json!({
        "id": "resp_nested_tool",
        "status": "completed",
        "output": [{
            "type": "function_call",
            "id": "fc_nested",
            "function": {"name": "workspace_read"},
            "arguments": null
        }]
    }))
    .expect("nested function call");

    assert!(matches!(
        &response.output[0].kind,
        ModelOutputItemKind::ToolCall(call)
            if call.id == "fc_nested"
                && call.name == "workspace_read"
                && call.arguments == json!({})
    ));
}

#[test]
fn openai_completed_response_preserves_malformed_argument_text_for_schema_feedback() {
    let response = parse_openai_response(json!({
        "id": "resp_invalid_args",
        "status": "completed",
        "output": [{
            "type": "function_call",
            "id": "fc_invalid_args",
            "name": "workspace_read",
            "arguments": "{path: README.md}"
        }]
    }))
    .expect("tool call remains classifiable");

    assert!(matches!(
        &response.output[0].kind,
        ModelOutputItemKind::ToolCall(call)
            if call.arguments == json!("{path: README.md}")
    ));
}

#[test]
fn openai_completed_response_keeps_exact_replay_only_for_opaque_reasoning() {
    let response = parse_openai_response(json!({
        "id": "resp_reasoning_tool",
        "status": "completed",
        "output": [
            {
                "type": "reasoning",
                "id": "reasoning_1",
                "encrypted_content": "opaque"
            },
            {
                "type": "function_call",
                "call_id": "call_1",
                "name": "workspace_read",
                "arguments": "{\"path\":\"README.md\"}"
            }
        ]
    }))
    .expect("opaque reasoning response");

    assert!(response.provider_context.is_some());

    let portable = parse_openai_response(json!({
        "id": "resp_reasoning_without_ciphertext",
        "status": "completed",
        "output": [
            {"type": "reasoning", "id": "reasoning_2", "summary": []},
            {
                "type": "function_call",
                "call_id": "call_2",
                "name": "workspace_read",
                "arguments": "{\"path\":\"README.md\"}"
            }
        ]
    }))
    .expect("non-opaque reasoning response");
    assert!(portable.provider_context.is_none());
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

#[tokio::test]
async fn gemini_multiple_tool_calls_are_normalized_when_parallel_is_disabled() {
    let (sender, _receiver) = mpsc::channel(8);
    let mut state = GeminiStreamState::new(false);
    state
        .consume(
            json!({
                "candidates": [{"content": {"parts": [
                    {"functionCall": {
                        "id": "call_1",
                        "name": "workspace_read",
                        "args": {"path": "README.md"}
                    }},
                    {"functionCall": {
                        "id": "call_2",
                        "name": "workspace_read",
                        "args": {"path": "Cargo.toml"}
                    }}
                ]}}]
            }),
            &sender,
            &tool_names(),
        )
        .await
        .expect("tool batch");

    let response = state.response().expect("normalized response");
    assert_eq!(
        response
            .output
            .iter()
            .filter(|item| matches!(item.kind, ModelOutputItemKind::ToolCall(_)))
            .count(),
        2
    );
}

#[tokio::test]
async fn gemini_sse_merges_incremental_text_chunks_into_one_final_item() {
    let (sender, mut receiver) = mpsc::channel(8);
    let mut state = GeminiStreamState::default();
    state
        .consume(
            json!({"candidates": [{"content": {"parts": [{"text": "fixture"}]}}]}),
            &sender,
            &tool_names(),
        )
        .await
        .expect("first chunk");
    state
        .consume(
            json!({"candidates": [{"content": {"parts": [{"text": " answer"}]}}]}),
            &sender,
            &tool_names(),
        )
        .await
        .expect("second chunk");

    assert!(matches!(
        receiver.recv().await,
        Some(Ok(ModelEvent::OutputTextDelta { delta, .. })) if delta == "fixture"
    ));
    assert!(matches!(
        receiver.recv().await,
        Some(Ok(ModelEvent::OutputTextDelta { delta, .. })) if delta == " answer"
    ));
    let response = state.response().expect("response");
    assert_eq!(response.output.len(), 1);
    assert!(matches!(
        &response.output[0].kind,
        ModelOutputItemKind::AssistantText {
            phase: ModelTextPhase::Final,
            text,
        } if text == "fixture answer"
    ));
    assert_eq!(response.terminal.finish_reason, ModelFinishReason::Stop);
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
