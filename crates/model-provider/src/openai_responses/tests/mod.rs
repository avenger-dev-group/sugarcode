use super::*;
use crate::ModelAssetRef;
use crate::ModelToolDefinition;
use crate::ModelToolGrammar;
use crate::ModelToolGrammarSyntax;
use crate::ModelToolResult;
use crate::anthropic_messages::requests::anthropic_request;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;

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
            freeform: None,
        },
        ModelToolDefinition {
            name: "loose_tool".to_owned(),
            description: "loose".to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {"path": {"type": "string"}}
            }),
            freeform: None,
        },
    ];
    request
}

fn freeform_tool() -> ModelToolDefinition {
    ModelToolDefinition {
        name: "workspace/apply-patch".to_owned(),
        description: "apply patch".to_owned(),
        parameters: json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {"patch": {"type": "string"}},
            "required": ["patch"]
        }),
        freeform: Some(ModelToolGrammar {
            syntax: ModelToolGrammarSyntax::Lark,
            definition: "start: \"patch\"".to_owned(),
            fallback_argument: "patch".to_owned(),
        }),
    }
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
fn retained_wire_apis_encode_image_and_pdf_parts() {
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
}

#[test]
fn openai_responses_explicitly_requests_sequential_tool_calls() {
    let request = request_with_strict_and_loose_tools();
    let body = openai_request(&request, ModelStrictToolsMode::Auto, false, 1024)
        .expect("Responses request");

    assert_eq!(body["parallel_tool_calls"], false);
}

#[test]
fn responses_uses_native_custom_tools_while_anthropic_keeps_json_fallback() {
    let mut request = continuation_request(Vec::new());
    request.tools.push(freeform_tool());

    let responses = openai_request(&request, ModelStrictToolsMode::Auto, false, 1024)
        .expect("Responses request");
    assert_eq!(responses["tools"][0]["type"], "custom");
    assert_eq!(responses["tools"][0]["format"]["type"], "grammar");
    assert_eq!(responses["tools"][0]["format"]["syntax"], "lark");
    assert!(responses["tools"][0].get("parameters").is_none());
    assert!(responses["tools"][0].get("strict").is_none());

    request
        .messages
        .push(ModelMessage::tool_calls(vec![ModelToolCall {
            id: "call_custom".to_owned(),
            name: "workspace/apply-patch".to_owned(),
            arguments: Value::String("raw patch".to_owned()),
        }]));
    let anthropic =
        anthropic_request(&request, ModelStrictToolsMode::Auto, 1024).expect("Anthropic request");
    assert_eq!(
        anthropic["tools"][0]["input_schema"],
        request.tools[0].parameters
    );
    assert!(anthropic["tools"][0].get("format").is_none());
    assert_eq!(
        anthropic["messages"][0]["content"][0]["input"]["patch"],
        "raw patch"
    );
}

#[test]
fn responses_normalizes_and_replays_custom_tool_calls_with_matching_outputs() {
    let raw_patch = "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch";
    let response = parse_openai_response(json!({
        "id": "resp_custom",
        "status": "completed",
        "output": [{
            "type": "custom_tool_call",
            "call_id": "call_custom",
            "name": "workspace_apply-patch",
            "input": raw_patch
        }]
    }))
    .expect("custom response");
    let ModelOutputItemKind::ToolCall(call) = &response.output[0].kind else {
        panic!("custom tool call");
    };
    assert_eq!(call.arguments, Value::String(raw_patch.to_owned()));

    let mut request = continuation_request(vec![
        ModelMessage::tool_calls(vec![ModelToolCall {
            id: "call_custom".to_owned(),
            name: "workspace/apply-patch".to_owned(),
            arguments: Value::String(raw_patch.to_owned()),
        }]),
        ModelMessage::tool_results(vec![ModelToolResult::from_serialized(
            "call_custom".to_owned(),
            "ok".to_owned(),
        )]),
    ]);
    request.tools.push(freeform_tool());
    let body =
        openai_request(&request, ModelStrictToolsMode::Auto, false, 1024).expect("replay request");
    assert_eq!(body["input"][0]["type"], "custom_tool_call");
    assert_eq!(body["input"][0]["input"], raw_patch);
    assert_eq!(body["input"][1]["type"], "custom_tool_call_output");
}

#[test]
fn responses_preserves_json_function_fallback_calls_for_freeform_tools() {
    let raw_patch = "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch";
    let mut request = continuation_request(vec![
        ModelMessage::tool_calls(vec![ModelToolCall {
            id: "chatcmpl-tool-patch".to_owned(),
            name: "workspace/apply-patch".to_owned(),
            arguments: json!({"patch": raw_patch}),
        }]),
        ModelMessage::tool_results(vec![ModelToolResult::from_serialized(
            "chatcmpl-tool-patch".to_owned(),
            "invalid patch".to_owned(),
        )]),
    ]);
    request.tools.push(freeform_tool());

    let body =
        openai_request(&request, ModelStrictToolsMode::Auto, false, 1024).expect("replay request");
    assert_eq!(body["input"][0]["type"], "function_call");
    assert_eq!(body["input"][0]["name"], "workspace/apply-patch");
    assert_eq!(
        body["input"][0]["arguments"],
        serde_json::to_string(&json!({"patch": raw_patch})).expect("arguments")
    );
    assert_eq!(body["input"][1]["type"], "function_call_output");
    assert_eq!(body["input"][1]["call_id"], "chatcmpl-tool-patch");
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
fn provider_managed_responses_pairs_custom_outputs_from_opaque_context() {
    let mut request = continuation_request(vec![
        continuation_message(
            ProviderWireApi::OpenAiResponses,
            json!([{
                "type": "custom_tool_call",
                "call_id": "call_custom",
                "name": "workspace_apply-patch",
                "input": "patch"
            }]),
        ),
        ModelMessage::tool_results(vec![ModelToolResult::from_serialized(
            "call_custom".to_owned(),
            "applied".to_owned(),
        )]),
    ]);
    request.tools.push(freeform_tool());

    let body = openai_provider_managed_request(&request, ModelStrictToolsMode::Auto, false, 1024)
        .expect("provider-managed custom request");
    assert_eq!(body["input"].as_array().map(Vec::len), Some(1));
    assert_eq!(body["input"][0]["type"], "custom_tool_call_output");
    assert_eq!(body["input"][0]["call_id"], "call_custom");
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
async fn unqualified_incomplete_response_is_retryable_before_output() {
    let (sender, _receiver) = mpsc::channel(1);
    let mut state = OpenAiStreamState::default();
    let result = state
        .consume(
            "response.incomplete",
            json!({
                "type": "response.incomplete",
                "response": {"status": "incomplete", "output": []}
            }),
            &sender,
            &tool_names(),
        )
        .await;
    let Err(error) = result else {
        panic!("unqualified incomplete response");
    };

    assert_eq!(error.kind(), ModelErrorKind::Incomplete);
    assert!(error.retryable());
}

#[tokio::test]
async fn empty_explicit_output_limit_is_retryable() {
    let (sender, _receiver) = mpsc::channel(1);
    let mut state = OpenAiStreamState::default();
    let result = state
        .consume(
            "response.incomplete",
            json!({
                "type": "response.incomplete",
                "response": {
                    "status": "incomplete",
                    "output": [],
                    "incomplete_details": {"reason": "max_output_tokens"}
                }
            }),
            &sender,
            &tool_names(),
        )
        .await;
    let Err(error) = result else {
        panic!("explicit output limit");
    };

    assert_eq!(error.kind(), ModelErrorKind::Incomplete);
    assert!(error.retryable());
}

#[tokio::test]
async fn explicit_output_limit_after_semantic_output_is_not_retryable() {
    let (sender, mut receiver) = mpsc::channel(2);
    let mut state = OpenAiStreamState::default();
    state
        .consume(
            "response.output_text.delta",
            json!({
                "type": "response.output_text.delta",
                "output_index": 0,
                "delta": "partial"
            }),
            &sender,
            &tool_names(),
        )
        .await
        .expect("semantic preview");
    let result = state
        .consume(
            "response.incomplete",
            json!({
                "type": "response.incomplete",
                "response": {
                    "status": "incomplete",
                    "output": [],
                    "incomplete_details": {"reason": "max_output_tokens"}
                }
            }),
            &sender,
            &tool_names(),
        )
        .await;
    let Err(error) = result else {
        panic!("output-limited semantic response");
    };
    assert!(matches!(
        receiver.recv().await,
        Some(Ok(ModelEvent::OutputTextDelta { delta, .. })) if delta == "partial"
    ));
    assert_eq!(error.kind(), ModelErrorKind::Incomplete);
    assert!(!error.retryable());
}

#[test]
fn retained_requests_enable_streaming() {
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
}

#[test]
fn compatible_responses_endpoints_prepare_chat_fallback() {
    let compatible = OpenAiResponsesProvider::new(
        Url::parse("https://gateway.example/v1").expect("compatible URL"),
        None,
        ModelStrictToolsMode::Auto,
        false,
        4096,
    )
    .expect("compatible provider");
    assert!(compatible.compatible_chat_fallback.is_some());

    let official = OpenAiResponsesProvider::new(
        Url::parse("https://api.openai.com/v1").expect("official URL"),
        None,
        ModelStrictToolsMode::Auto,
        false,
        4096,
    )
    .expect("official provider");
    assert!(official.compatible_chat_fallback.is_none());
}

#[tokio::test]
async fn compatible_responses_no_output_retry_uses_streaming_chat() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind compatible gateway");
    let address = listener.local_addr().expect("compatible gateway address");
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept retry request");
        let mut request = Vec::new();
        loop {
            let mut chunk = [0u8; 8192];
            let bytes = socket.read(&mut chunk).await.expect("read retry request");
            assert!(bytes > 0, "retry request closed before its body completed");
            request.extend_from_slice(&chunk[..bytes]);
            let Some(header_end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") else {
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    line.split_once(':').and_then(|(name, value)| {
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().expect("content length"))
                    })
                })
                .expect("request content length");
            if request.len() >= header_end + 4 + content_length {
                break;
            }
        }
        let request = String::from_utf8_lossy(&request);
        assert!(request.starts_with("POST /v1/chat/completions "));
        assert!(request.contains("\"stream\":true"));

        let body = concat!(
            "data: {\"id\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Recovered.\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n",
        );
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .expect("write retry response headers");
        socket
            .write_all(body.as_bytes())
            .await
            .expect("write retry response");
    });
    let provider = OpenAiResponsesProvider::new(
        Url::parse(&format!("http://{address}/v1")).expect("compatible URL"),
        None,
        ModelStrictToolsMode::Auto,
        false,
        4096,
    )
    .expect("compatible provider");
    let events = provider
        .retry_after_no_output(ModelRequest {
            model: "fixture-model".to_owned(),
            instructions: Vec::new(),
            messages: vec![ModelMessage::user_text("Continue".to_owned())],
            tools: Vec::new(),
        })
        .await
        .expect("streaming Chat retry")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("compatible gateway");

    assert!(matches!(
        events.as_slice(),
        [
            Ok(ModelEvent::OutputTextDelta { delta, .. }),
            Ok(ModelEvent::ResponseCompleted(ModelResponse { output, .. }))
        ] if delta == "Recovered."
            && matches!(output.as_slice(), [ModelOutputItem {
                kind: ModelOutputItemKind::AssistantText { text, .. }, ..
            }] if text == "Recovered.")
    ));
}
