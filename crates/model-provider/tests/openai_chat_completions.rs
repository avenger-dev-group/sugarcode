use futures_util::StreamExt;
use std::sync::Arc;
use sugarcode_model_provider::ModelErrorKind;
use sugarcode_model_provider::ModelEvent;
use sugarcode_model_provider::ModelInstruction;
use sugarcode_model_provider::ModelInstructionSource;
use sugarcode_model_provider::ModelMessage;
use sugarcode_model_provider::ModelOutputItem;
use sugarcode_model_provider::ModelOutputItemKind;
use sugarcode_model_provider::ModelProvider;
use sugarcode_model_provider::ModelRequest;
use sugarcode_model_provider::ModelResponse;
use sugarcode_model_provider::ModelRole;
use sugarcode_model_provider::ModelTextPhase;
use sugarcode_model_provider::ModelToolCall;
use sugarcode_model_provider::ModelToolDefinition;
use sugarcode_model_provider::ModelUsage;
use sugarcode_model_provider::OpenAiChatCompletionsProvider;
use sugarcode_model_provider::WORKSPACE_AGENTS_HIERARCHY_INSTRUCTION_PREFIX;
use sugarcode_model_provider::WORKSPACE_ROOT_AGENTS_INSTRUCTION_PREFIX;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use url::Url;

const SUCCESS: &str = include_str!("fixtures/completed.sse");
const COMPLETED_CHUNKS: &str = include_str!("fixtures/completed.chunks.json");
const UTF8: &str = include_str!("fixtures/chat-completions-utf8.sse");
const TERMINAL_ERROR: &str = include_str!("fixtures/terminal-error.sse");
const MALFORMED: &str = include_str!("fixtures/malformed.sse");
const DISCONNECT: &str = include_str!("fixtures/chat-completions-disconnect.sse");
const CANCELLATION: &str = include_str!("fixtures/cancellable.sse");

mod model_event {
    use super::*;

    pub const COMPLETED: ModelEvent = ModelEvent::ResponseCompleted(ModelResponse {
        output: Vec::new(),
        usage: None,
    });

    pub fn text_delta(delta: String) -> ModelEvent {
        ModelEvent::OutputTextDelta {
            output_index: 0,
            delta,
        }
    }

    pub fn commentary(text: String) -> ModelEvent {
        text_delta(text)
    }

    pub fn tool_call(call: ModelToolCall) -> ModelEvent {
        ModelEvent::ResponseCompleted(ModelResponse {
            output: vec![ModelOutputItem {
                output_index: 0,
                kind: ModelOutputItemKind::ToolCall(call),
            }],
            usage: None,
        })
    }

    pub fn tool_call_batch(calls: Vec<ModelToolCall>) -> ModelEvent {
        ModelEvent::ResponseCompleted(ModelResponse {
            output: calls
                .into_iter()
                .enumerate()
                .map(|(index, call)| ModelOutputItem {
                    output_index: u32::try_from(index).expect("test output index"),
                    kind: ModelOutputItemKind::ToolCall(call),
                })
                .collect(),
            usage: None,
        })
    }

    pub fn usage(usage: sugarcode_model_provider::ModelUsage) -> ModelEvent {
        ModelEvent::ResponseCompleted(ModelResponse {
            output: Vec::new(),
            usage: Some(usage),
        })
    }
}

fn normalize_expected_model_events(
    events: Vec<Result<ModelEvent, sugarcode_model_provider::ModelError>>,
) -> Vec<Result<ModelEvent, sugarcode_model_provider::ModelError>> {
    let mut normalized = Vec::with_capacity(events.len());
    let mut preview = String::new();
    let mut response = None::<ModelResponse>;
    let mut usage = None;
    for event in events {
        match event {
            Ok(ModelEvent::OutputTextDelta {
                output_index,
                delta,
            }) => {
                preview.push_str(&delta);
                normalized.push(Ok(ModelEvent::OutputTextDelta {
                    output_index,
                    delta,
                }));
            }
            Ok(ModelEvent::ResponseCompleted(mut completed)) if completed.output.is_empty() => {
                if let Some(value) = completed.usage.take() {
                    usage = Some(value);
                } else if let Some(mut pending) = response.take() {
                    if !preview.is_empty() {
                        for item in &mut pending.output {
                            item.output_index += 1;
                        }
                        pending.output.insert(
                            0,
                            ModelOutputItem {
                                output_index: 0,
                                kind: ModelOutputItemKind::AssistantText {
                                    phase: ModelTextPhase::Commentary,
                                    text: std::mem::take(&mut preview),
                                },
                            },
                        );
                    }
                    pending.usage = usage.take();
                    normalized.push(Ok(ModelEvent::ResponseCompleted(pending)));
                } else {
                    normalized.push(Ok(ModelEvent::ResponseCompleted(ModelResponse {
                        output: vec![ModelOutputItem {
                            output_index: 0,
                            kind: ModelOutputItemKind::AssistantText {
                                phase: ModelTextPhase::Final,
                                text: std::mem::take(&mut preview),
                            },
                        }],
                        usage: usage.take(),
                    })));
                }
            }
            Ok(ModelEvent::ResponseCompleted(completed)) => response = Some(completed),
            Err(error) => normalized.push(Err(error)),
        }
    }
    normalized
}

#[tokio::test]
async fn recorded_success_stream_normalizes_text_and_usage() {
    let (endpoint, server) = response_server(SUCCESS.as_bytes().to_vec(), Vec::new()).await;
    let provider = provider(endpoint);
    let events = provider
        .stream(request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");

    assert_eq!(
        events,
        normalize_expected_model_events(vec![
            Ok(model_event::text_delta(
                "SugarCode deterministic response.".to_string()
            )),
            Ok(model_event::usage(sugarcode_model_provider::ModelUsage {
                input_tokens: Some(1),
                output_tokens: Some(3),
                total_tokens: Some(4),
                ..Default::default()
            })),
            Ok(model_event::COMPLETED),
        ])
    );
}

#[tokio::test]
async fn built_in_base_precedes_workspace_instructions_as_redacted_developer_context() {
    let (endpoint, server, request_rx) =
        capturing_response_server(SUCCESS.as_bytes().to_vec()).await;
    let provider = provider(endpoint);
    let mut request = request();
    request.instructions = vec![
        ModelInstruction {
            source: ModelInstructionSource::SugarCodeBaseAgentV1,
            content: "You are SugarCode. Follow the built-in contract.".to_string(),
        },
        ModelInstruction {
            source: ModelInstructionSource::WorkspaceRootAgentsV1,
            content: "Keep the repository green.".to_string(),
        },
    ];
    let debug = format!("{request:?}");
    assert!(debug.contains("instruction_count: 2"));
    assert!(!debug.contains("You are SugarCode."));
    assert!(!debug.contains("Keep the repository green."));

    let events = provider
        .stream(request)
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    assert!(events.iter().all(Result::is_ok));
    server.await.expect("mock server");
    let body = request_rx.await.expect("captured request");
    assert_eq!(body["messages"][0]["role"], "developer");
    assert_eq!(
        body["messages"][0]["content"],
        "You are SugarCode. Follow the built-in contract."
    );
    assert_eq!(body["messages"][1]["role"], "developer");
    assert_eq!(
        body["messages"][1]["content"],
        format!("{WORKSPACE_ROOT_AGENTS_INSTRUCTION_PREFIX}Keep the repository green.")
    );
    assert_eq!(body["messages"][2]["role"], "user");
    assert_eq!(body["messages"][2]["content"], "Hello");
}

#[tokio::test]
async fn workspace_skills_follow_agents_and_precede_compaction_history_and_input() {
    let (endpoint, server, request_rx) =
        capturing_response_server(SUCCESS.as_bytes().to_vec()).await;
    let provider = provider(endpoint);
    let mut request = request();
    request.instructions = vec![
        ModelInstruction {
            source: ModelInstructionSource::WorkspaceRootAgentsV1,
            content: "root rule".to_string(),
        },
        ModelInstruction {
            source: ModelInstructionSource::WorkspaceSkillsInventoryV1,
            content: "- $review: \"Review changes\"\n".to_string(),
        },
        ModelInstruction {
            source: ModelInstructionSource::SelectedWorkspaceSkillsV1,
            content: "--- Selected Skill: $review ---\nprivate body".to_string(),
        },
    ];
    request.messages.insert(
        0,
        ModelMessage::ContextCompaction {
            content: "checkpoint".to_string(),
        },
    );

    let events = provider
        .stream(request)
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    assert!(events.iter().all(Result::is_ok));
    server.await.expect("mock server");
    let body = request_rx.await.expect("captured request");
    let messages = body["messages"].as_array().expect("messages");
    assert_eq!(
        messages
            .iter()
            .map(|message| message["role"].as_str().expect("role"))
            .collect::<Vec<_>>(),
        vec!["developer", "developer", "developer", "user", "user"]
    );
    assert!(
        messages[0]["content"]
            .as_str()
            .expect("agents")
            .contains("boundedWorkspaceInstructionsV1")
    );
    assert!(
        messages[1]["content"]
            .as_str()
            .expect("inventory")
            .contains("Available bounded local workspace Skills")
    );
    assert!(
        messages[2]["content"]
            .as_str()
            .expect("selected")
            .contains("private body")
    );
    assert_eq!(messages[3]["content"], "checkpoint");
    assert_eq!(messages[4]["content"], "Hello");
}

#[tokio::test]
async fn persisted_compaction_is_a_redacted_user_message_after_developer_instructions() {
    let (endpoint, server, request_rx) =
        capturing_response_server(SUCCESS.as_bytes().to_vec()).await;
    let provider = provider(endpoint);
    let mut request = request();
    request.instructions.push(ModelInstruction {
        source: ModelInstructionSource::WorkspaceRootAgentsV1,
        content: "Keep the repository green.".to_string(),
    });
    let compaction = "SugarCode deterministic persisted compaction v1\nreceipt".to_string();
    request.messages.insert(
        0,
        ModelMessage::ContextCompaction {
            content: compaction.clone(),
        },
    );
    let expected_context_bytes = request
        .instructions
        .iter()
        .map(ModelInstruction::context_bytes)
        .sum::<usize>()
        + request
            .messages
            .iter()
            .map(ModelMessage::context_bytes)
            .sum::<usize>();
    assert_eq!(request.context_bytes(), expected_context_bytes);
    assert!(!format!("{request:?}").contains(&compaction));

    let events = provider
        .stream(request)
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    assert!(events.iter().all(Result::is_ok));
    server.await.expect("mock server");
    let body = request_rx.await.expect("captured request");
    assert_eq!(body["messages"][0]["role"], "developer");
    assert_eq!(body["messages"][1]["role"], "user");
    assert_eq!(body["messages"][1]["content"], compaction);
    assert_eq!(body["messages"][2]["role"], "user");
    assert_eq!(body["messages"][2]["content"], "Hello");
}

#[tokio::test]
async fn nested_workspace_instructions_have_explicit_deeper_precedence() {
    let (endpoint, server, request_rx) =
        capturing_response_server(SUCCESS.as_bytes().to_vec()).await;
    let provider = provider(endpoint);
    let mut request = request();
    let instruction = ModelInstruction {
        source: ModelInstructionSource::WorkspaceAgentsHierarchyV1,
        content: concat!(
            "--- AGENTS.md: AGENTS.md ---\nroot\n\n",
            "--- AGENTS.md: projects/active/AGENTS.md ---\nleaf"
        )
        .to_string(),
    };
    assert_eq!(
        instruction.context_bytes(),
        instruction.rendered_content().len()
    );
    request.instructions.push(instruction);

    let events = provider
        .stream(request)
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    assert!(events.iter().all(Result::is_ok));
    server.await.expect("mock server");
    let body = request_rx.await.expect("captured request");
    let content = body["messages"][0]["content"]
        .as_str()
        .expect("developer content");
    assert!(content.starts_with(WORKSPACE_AGENTS_HIERARCHY_INSTRUCTION_PREFIX));
    assert!(content.contains("subordinate to SugarCode's built-in agent instructions"));
    assert!(
        content.find("AGENTS.md ---\nroot") < content.find("projects/active/AGENTS.md ---\nleaf")
    );
}

#[tokio::test]
async fn fragmented_single_tool_call_is_assembled_into_one_typed_event() {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"workspace/read\",\"arguments\":\"\"}},{\"index\":0,\"function\":{\"arguments\":\"{\\\"path\\\":\\\"READ\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"ME.txt\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    let (endpoint, server) = response_server(body.as_bytes().to_vec(), Vec::new()).await;
    let events = provider(endpoint)
        .stream(tool_request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");

    assert_eq!(
        events,
        normalize_expected_model_events(vec![
            Ok(model_event::tool_call(ModelToolCall {
                id: "call_1".to_string(),
                name: "workspace/read".to_string(),
                arguments: serde_json::json!({ "path": "README.txt" }),
            })),
            Ok(model_event::COMPLETED),
        ])
    );
}

#[tokio::test]
async fn interleaved_parallel_tool_fragments_are_sorted_and_assembled_as_one_batch() {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":1,\"id\":\"call_2\",\"type\":\"function\",\"function\":{\"name\":\"workspace/list\",\"arguments\":\"{\\\"path\\\":\"}},{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"workspace/read\",\"arguments\":\"{\\\"path\\\":\\\"REA\"}},{\"index\":1,\"function\":{\"arguments\":\"\\\".\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"DME.md\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    let (endpoint, server) = response_server(body.as_bytes().to_vec(), Vec::new()).await;
    let events = provider(endpoint)
        .stream(tool_request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");

    assert_eq!(
        events,
        normalize_expected_model_events(vec![
            Ok(model_event::tool_call_batch(vec![
                ModelToolCall {
                    id: "call_1".to_string(),
                    name: "workspace/read".to_string(),
                    arguments: serde_json::json!({ "path": "README.md" }),
                },
                ModelToolCall {
                    id: "call_2".to_string(),
                    name: "workspace/list".to_string(),
                    arguments: serde_json::json!({ "path": "." }),
                },
            ])),
            Ok(model_event::COMPLETED),
        ])
    );
}

#[tokio::test]
async fn consecutive_persisted_tool_calls_are_replayed_as_one_assistant_batch() {
    let (endpoint, server, request_rx) =
        capturing_response_server(SUCCESS.as_bytes().to_vec()).await;
    let mut request = request();
    request.messages = vec![
        ModelMessage::Commentary {
            text: "I will inspect the workspace.".to_string(),
        },
        ModelMessage::ToolCall(ModelToolCall {
            id: "call_1".to_string(),
            name: "workspace/read".to_string(),
            arguments: serde_json::json!({ "path": "README.md" }),
        }),
        ModelMessage::ToolCall(ModelToolCall {
            id: "call_2".to_string(),
            name: "workspace/list".to_string(),
            arguments: serde_json::json!({ "path": "." }),
        }),
        ModelMessage::ToolResult {
            call_id: "call_1".to_string(),
            content: "read result".to_string(),
        },
        ModelMessage::ToolResult {
            call_id: "call_2".to_string(),
            content: "list result".to_string(),
        },
    ];
    let events = provider(endpoint)
        .stream(request)
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    assert!(events.iter().all(Result::is_ok));
    server.await.expect("mock server");
    let body = request_rx.await.expect("captured request");

    assert_eq!(body["messages"][0]["role"], "assistant");
    assert_eq!(
        body["messages"][0]["content"],
        "I will inspect the workspace."
    );
    assert_eq!(
        body["messages"][0]["tool_calls"]
            .as_array()
            .expect("assistant tool calls")
            .len(),
        2
    );
    assert_eq!(body["messages"][1]["tool_call_id"], "call_1");
    assert_eq!(body["messages"][2]["tool_call_id"], "call_2");
}

#[tokio::test]
async fn leading_whitespace_before_a_tool_call_is_preserved_as_commentary() {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"\\n  \"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"workspace/list\",\"arguments\":\"{\\\"path\\\":\\\".\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    let (endpoint, server) = response_server(body.as_bytes().to_vec(), Vec::new()).await;
    let events = provider(endpoint)
        .stream(tool_request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");

    assert_eq!(
        events,
        normalize_expected_model_events(vec![
            Ok(model_event::commentary("\n  ".to_string())),
            Ok(model_event::tool_call(ModelToolCall {
                id: "call_1".to_string(),
                name: "workspace/list".to_string(),
                arguments: serde_json::json!({ "path": "." }),
            })),
            Ok(model_event::COMPLETED),
        ])
    );
}

#[tokio::test]
async fn whitespace_only_completed_response_is_non_retryable_incomplete() {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"\\n  \"},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    let (endpoint, server) = response_server(body.as_bytes().to_vec(), Vec::new()).await;
    let events = provider(endpoint)
        .stream(request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");
    let [Ok(ModelEvent::OutputTextDelta { delta, .. }), Err(error)] = events.as_slice() else {
        panic!("whitespace-only response must preview then fail");
    };
    assert_eq!(delta, "\n  ");
    assert_eq!(error.kind(), ModelErrorKind::Incomplete);
    assert!(!error.retryable());
}

#[tokio::test]
async fn structured_tool_call_error_matrix_is_stable_and_non_retryable() {
    let cases = [
        (
            concat!(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"function_call\":{\"name\":\"workspace/read\",\"arguments\":\"{}\"}},\"finish_reason\":\"function_call\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ModelErrorKind::UnsupportedOutput,
        ),
        (
            concat!(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_custom\",\"type\":\"custom\"}]},\"finish_reason\":null}]}\n\n",
                "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ModelErrorKind::UnsupportedOutput,
        ),
        (
            concat!(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"type\":\"function\",\"function\":{\"name\":\"workspace/read\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}\n\n",
                "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ModelErrorKind::Protocol,
        ),
        (
            concat!(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"workspace/read\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}\n\n",
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_2\"}]},\"finish_reason\":null}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ModelErrorKind::Protocol,
        ),
        (
            concat!(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"workspace/read\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ModelErrorKind::Protocol,
        ),
        (
            concat!(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0},{\"index\":1}]},\"finish_reason\":null}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ModelErrorKind::Protocol,
        ),
        (
            concat!(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"workspace/read\",\"arguments\":\"{\"}}]},\"finish_reason\":null}]}\n\n",
                "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ModelErrorKind::Protocol,
        ),
        (
            concat!(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"mcp__fixture__inspect\",\"arguments\":\"{\\\"value\\\":1,\\\"value\\\":2}\"}}]},\"finish_reason\":null}]}\n\n",
                "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ModelErrorKind::Protocol,
        ),
        (
            concat!(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"bad id\",\"type\":\"function\",\"function\":{\"name\":\"workspace/read\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ModelErrorKind::Protocol,
        ),
    ];
    for (case_index, (body, expected)) in cases.into_iter().enumerate() {
        let (endpoint, server) = response_server(body.as_bytes().to_vec(), Vec::new()).await;
        let events = provider(endpoint)
            .stream(tool_request())
            .await
            .expect("stream starts")
            .collect::<Vec<_>>()
            .await;
        let error = events
            .last()
            .expect("terminal event")
            .as_ref()
            .expect_err("invalid tool output");
        server.await.expect("mock server");
        assert_eq!(error.kind(), expected, "case {case_index}");
        assert!(!error.retryable());
    }
}

#[tokio::test]
async fn oversized_tool_arguments_are_a_non_retryable_output_limit() {
    let arguments = "x".repeat(32 * 1024 + 1);
    let chunk = serde_json::json!({
        "choices": [{
            "index": 0,
            "delta": {
                "tool_calls": [{
                    "index": 0,
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "workspace/read",
                        "arguments": arguments,
                    }
                }]
            },
            "finish_reason": null
        }]
    });
    let body = format!("data: {chunk}\n\ndata: [DONE]\n\n");
    let (endpoint, server) = response_server(body.into_bytes(), Vec::new()).await;
    let error = provider(endpoint)
        .stream(tool_request())
        .await
        .expect("stream starts")
        .next()
        .await
        .expect("terminal event")
        .expect_err("oversized arguments");
    server.await.expect("mock server");
    assert_eq!(error.kind(), ModelErrorKind::OutputTooLarge);
    assert!(!error.retryable());
}

#[tokio::test]
async fn utf8_survives_arbitrary_network_chunk_boundaries() {
    let bytes = UTF8.as_bytes().to_vec();
    let first_utf8 = bytes
        .windows("你".len())
        .position(|window| window == "你".as_bytes())
        .expect("UTF-8 fixture");
    let mut split_points =
        serde_json::from_str::<Vec<usize>>(COMPLETED_CHUNKS).expect("chunk fixture");
    split_points.extend([first_utf8 + 1, first_utf8 + 2, bytes.len() - 3]);
    let (endpoint, server) = response_server(bytes, split_points).await;
    let provider = provider(endpoint);
    let events = provider
        .stream(request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");

    assert_eq!(
        events,
        normalize_expected_model_events(vec![
            Ok(model_event::text_delta("你".to_string())),
            Ok(model_event::text_delta("好".to_string())),
            Ok(model_event::COMPLETED),
        ])
    );
}

#[tokio::test]
async fn recorded_terminal_error_is_redacted_and_retryable() {
    let (endpoint, server) = response_server(TERMINAL_ERROR.as_bytes().to_vec(), Vec::new()).await;
    let provider = provider(endpoint);
    let error = provider
        .stream(request())
        .await
        .expect("HTTP request succeeds")
        .next()
        .await
        .expect("terminal event")
        .expect_err("provider error");
    server.await.expect("mock server");

    assert_eq!(error.kind(), ModelErrorKind::Server);
    assert!(error.retryable());
    assert!(!error.to_string().contains("fixture payload"));
    assert!(!format!("{error:?}").contains("fixture payload"));
}

#[tokio::test]
async fn malformed_recorded_event_is_a_non_retryable_protocol_error() {
    let (endpoint, server) = response_server(MALFORMED.as_bytes().to_vec(), Vec::new()).await;
    let provider = provider(endpoint);
    let error = provider
        .stream(request())
        .await
        .expect("HTTP request succeeds")
        .next()
        .await
        .expect("terminal event")
        .expect_err("protocol error");
    server.await.expect("mock server");

    assert_eq!(error.kind(), ModelErrorKind::Protocol);
    assert!(!error.retryable());
}

#[test]
fn remote_plaintext_http_endpoint_is_accepted() {
    let endpoint =
        Url::parse("http://example.com/v1/chat/completions").expect("remote HTTP endpoint");
    OpenAiChatCompletionsProvider::new(endpoint, None).expect("remote plaintext HTTP is supported");
}

#[tokio::test]
async fn non_event_stream_content_type_is_rejected() {
    let (endpoint, server) = response_server_with_options(
        SUCCESS.as_bytes().to_vec(),
        Vec::new(),
        "application/json",
        true,
    )
    .await;
    let error = match provider(endpoint).stream(request()).await {
        Ok(_) => panic!("non-SSE response must fail"),
        Err(error) => error,
    };
    server.await.expect("mock server");
    assert_eq!(error.kind(), ModelErrorKind::Protocol);
    assert!(!error.retryable());
}

#[tokio::test]
async fn empty_token_sends_no_authorization_header() {
    let (endpoint, server) = response_server_with_options(
        SUCCESS.as_bytes().to_vec(),
        Vec::new(),
        "text/event-stream",
        false,
    )
    .await;
    let provider =
        OpenAiChatCompletionsProvider::new(endpoint, Some(String::new())).expect("provider");
    let events = provider
        .stream(request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");
    assert!(matches!(
        events.last(),
        Some(Ok(ModelEvent::ResponseCompleted(_)))
    ));
}

#[tokio::test]
async fn data_after_finish_reason_is_a_protocol_error() {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"late\"},\"finish_reason\":null}]}\n\n",
        "data: [DONE]\n\n"
    );
    let (endpoint, server) = response_server(body.as_bytes().to_vec(), Vec::new()).await;
    let error = provider(endpoint)
        .stream(request())
        .await
        .expect("stream starts")
        .next()
        .await
        .expect("terminal event")
        .expect_err("late data must fail");
    server.await.expect("mock server");
    assert_eq!(error.kind(), ModelErrorKind::Protocol);
}

#[tokio::test]
async fn usage_only_chunk_after_finish_reason_is_accepted_once() {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"done\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3,\"total_tokens\":5}}\n\n",
        "data: [DONE]\n\n"
    );
    let (endpoint, server) = response_server(body.as_bytes().to_vec(), Vec::new()).await;
    let events = provider(endpoint)
        .stream(request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");
    assert_eq!(
        events,
        normalize_expected_model_events(vec![
            Ok(model_event::text_delta("done".to_string())),
            Ok(model_event::usage(sugarcode_model_provider::ModelUsage {
                input_tokens: Some(2),
                output_tokens: Some(3),
                total_tokens: Some(5),
                ..Default::default()
            })),
            Ok(model_event::COMPLETED),
        ])
    );
}

#[tokio::test]
async fn usage_chunk_with_one_empty_choice_is_accepted() {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"done\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":null}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3,\"total_tokens\":5}}\n\n",
        "data: [DONE]\n\n"
    );
    let (endpoint, server) = response_server(body.as_bytes().to_vec(), Vec::new()).await;
    let events = provider(endpoint)
        .stream(request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");
    assert_eq!(
        events,
        normalize_expected_model_events(vec![
            Ok(model_event::text_delta("done".to_string())),
            Ok(model_event::usage(sugarcode_model_provider::ModelUsage {
                input_tokens: Some(2),
                output_tokens: Some(3),
                total_tokens: Some(5),
                ..Default::default()
            })),
            Ok(model_event::COMPLETED),
        ])
    );
}

#[tokio::test]
async fn nullable_delta_and_identical_repeated_usage_are_accepted() {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"done\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":null,\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3,\"total_tokens\":5}}\n\n",
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3,\"total_tokens\":5}}\n\n",
        "data: [DONE]\n\n"
    );
    let (endpoint, server) = response_server(body.as_bytes().to_vec(), Vec::new()).await;
    let events = provider(endpoint)
        .stream(request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");
    assert_eq!(
        events,
        normalize_expected_model_events(vec![
            Ok(model_event::text_delta("done".to_string())),
            Ok(model_event::usage(sugarcode_model_provider::ModelUsage {
                input_tokens: Some(2),
                output_tokens: Some(3),
                total_tokens: Some(5),
                ..Default::default()
            })),
            Ok(model_event::COMPLETED),
        ])
    );
}

#[tokio::test]
async fn conflicting_repeated_usage_remains_a_protocol_error() {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"done\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3,\"total_tokens\":5}}\n\n",
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":4,\"total_tokens\":6}}\n\n",
        "data: [DONE]\n\n"
    );
    let (endpoint, server) = response_server(body.as_bytes().to_vec(), Vec::new()).await;
    let events = provider(endpoint)
        .stream(request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");
    let error = events
        .last()
        .expect("terminal event")
        .as_ref()
        .expect_err("conflicting usage must fail");
    assert_eq!(error.kind(), ModelErrorKind::Protocol);
    assert!(!error.retryable());
}

#[tokio::test]
async fn repeated_identical_tool_id_and_stop_finish_are_normalized() {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"workspace/read\",\"arguments\":\"{\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"arguments\":\"\\\"path\\\":\\\"README.md\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    let (endpoint, server) = response_server(body.as_bytes().to_vec(), Vec::new()).await;
    let events = provider(endpoint)
        .stream(tool_request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");
    assert_eq!(
        events,
        normalize_expected_model_events(vec![
            Ok(model_event::tool_call(ModelToolCall {
                id: "call_1".to_string(),
                name: "workspace/read".to_string(),
                arguments: serde_json::json!({"path": "README.md"}),
            })),
            Ok(model_event::COMPLETED),
        ])
    );
}

#[tokio::test]
async fn empty_completed_response_is_non_retryable_incomplete() {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    let (endpoint, server) = response_server(body.as_bytes().to_vec(), Vec::new()).await;
    let error = provider(endpoint)
        .stream(request())
        .await
        .expect("stream starts")
        .next()
        .await
        .expect("terminal event")
        .expect_err("empty response must fail");
    server.await.expect("mock server");
    assert_eq!(error.kind(), ModelErrorKind::Incomplete);
    assert!(!error.retryable());
}

#[tokio::test]
async fn empty_tool_call_arrays_on_text_deltas_are_ignored() {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你\",\"tool_calls\":[]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"好\",\"tool_calls\":[]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[]},\"finish_reason\":null}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1,\"total_tokens\":3}}\n\n",
        "data: [DONE]\n\n"
    );
    let (endpoint, server) = response_server(body.as_bytes().to_vec(), Vec::new()).await;
    let events = provider(endpoint)
        .stream(request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");

    assert_eq!(
        events,
        normalize_expected_model_events(vec![
            Ok(model_event::text_delta("你".to_string())),
            Ok(model_event::text_delta("好".to_string())),
            Ok(model_event::usage(sugarcode_model_provider::ModelUsage {
                input_tokens: Some(2),
                output_tokens: Some(1),
                total_tokens: Some(3),
                ..Default::default()
            })),
            Ok(model_event::COMPLETED),
        ])
    );
}

#[tokio::test]
async fn tool_capable_answer_streams_every_chunk_without_a_time_heuristic() {
    let parts = vec![
        (
            std::time::Duration::ZERO,
            b"data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"A\"},\"finish_reason\":null}]}\n\n"
                .to_vec(),
        ),
        (
            std::time::Duration::from_millis(150),
            b"data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"B\"},\"finish_reason\":null}]}\n\n"
                .to_vec(),
        ),
        (
            std::time::Duration::from_millis(150),
            concat!(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"C\"},\"finish_reason\":null}]}\n\n",
                "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n"
            )
            .as_bytes()
            .to_vec(),
        ),
    ];
    let (endpoint, server) = delayed_response_server(parts).await;
    let events = provider(endpoint)
        .stream(tool_request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");

    assert_eq!(
        events,
        normalize_expected_model_events(vec![
            Ok(model_event::text_delta("A".to_string())),
            Ok(model_event::text_delta("B".to_string())),
            Ok(model_event::text_delta("C".to_string())),
            Ok(model_event::COMPLETED),
        ])
    );
}

#[tokio::test]
async fn provider_reasoning_content_is_not_classified_as_assistant_output() {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"private reasoning\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Reviewed.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    let (endpoint, server) = response_server(body.as_bytes().to_vec(), Vec::new()).await;
    let events = provider(endpoint)
        .stream(tool_request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");

    assert_eq!(
        events,
        normalize_expected_model_events(vec![
            Ok(model_event::text_delta("Reviewed.".to_string())),
            Ok(model_event::COMPLETED),
        ])
    );
}

#[tokio::test]
async fn tool_call_collection_is_not_limited_by_item_count() {
    let tool_calls = (0..32)
        .map(|index| {
            serde_json::json!({
                "index": index,
                "id": format!("call_{index}"),
                "type": "function",
                "function": {
                    "name": "workspace/read",
                    "arguments": format!("{{\"path\":\"{index}.md\"}}"),
                },
            })
        })
        .collect::<Vec<_>>();
    let first_chunk = format!(
        "data: {}\n\n",
        serde_json::json!({
            "choices": [{
                "index": 0,
                "delta": {"tool_calls": tool_calls},
                "finish_reason": null,
            }]
        })
    )
    .into_bytes();
    let parts = vec![
        (std::time::Duration::ZERO, first_chunk),
        (
            std::time::Duration::from_millis(200),
            concat!(
                "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":32,\"total_tokens\":42}}\n\n",
                "data: [DONE]\n\n"
            )
            .as_bytes()
            .to_vec(),
        ),
    ];
    let (endpoint, server) = delayed_response_server(parts).await;
    let mut events = provider(endpoint)
        .stream(tool_request())
        .await
        .expect("stream starts");

    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), events.next())
            .await
            .is_err(),
        "tool fragments must remain provisional until response completion"
    );
    let completed = events
        .next()
        .await
        .expect("terminal event")
        .expect("call count does not classify a completed response as unsupported");
    let ModelEvent::ResponseCompleted(response) = completed else {
        panic!("completed response");
    };
    assert_eq!(response.output.len(), 32);
    for (index, item) in response.output.iter().enumerate() {
        assert_eq!(
            item.output_index,
            u32::try_from(index).expect("output index")
        );
        let ModelOutputItemKind::ToolCall(call) = &item.kind else {
            panic!("tool call output");
        };
        assert_eq!(call.id, format!("call_{index}"));
        assert_eq!(call.name, "workspace/read");
        assert_eq!(
            call.arguments,
            serde_json::json!({"path": format!("{index}.md")})
        );
    }
    assert_eq!(
        response.usage,
        Some(ModelUsage {
            input_tokens: Some(10),
            cached_input_tokens: None,
            output_tokens: Some(32),
            reasoning_output_tokens: None,
            total_tokens: Some(42),
        })
    );
    assert!(events.next().await.is_none());
    server.await.expect("mock server");
}

#[tokio::test]
async fn delayed_short_commentary_before_a_tool_call_is_preserved() {
    let parts = vec![
        (
            std::time::Duration::ZERO,
            b"data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"I will inspect the workspace.\"},\"finish_reason\":null}]}\n\n"
                .to_vec(),
        ),
        (
            std::time::Duration::from_millis(300),
            concat!(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"workspace/read\",\"arguments\":\"{\\\"path\\\":\\\"README.md\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
                "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: [DONE]\n\n"
            )
            .as_bytes()
            .to_vec(),
        ),
    ];
    let (endpoint, server) = delayed_response_server(parts).await;
    let events = provider(endpoint)
        .stream(tool_request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");

    assert_eq!(
        events,
        normalize_expected_model_events(vec![
            Ok(model_event::commentary(
                "I will inspect the workspace.".to_string()
            )),
            Ok(model_event::tool_call(ModelToolCall {
                id: "call_1".to_string(),
                name: "workspace/read".to_string(),
                arguments: serde_json::json!({"path": "README.md"}),
            })),
            Ok(model_event::COMPLETED),
        ])
    );
}

#[tokio::test]
async fn commentary_and_tool_fragments_may_interleave_without_changing_semantics() {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"I will \"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"workspace/read\",\"arguments\":\"{\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"inspect now.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"path\\\":\\\"README.md\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    let (endpoint, server) = response_server(body.as_bytes().to_vec(), Vec::new()).await;
    let events = provider(endpoint)
        .stream(tool_request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");

    assert_eq!(
        events,
        normalize_expected_model_events(vec![
            Ok(model_event::commentary("I will ".to_string())),
            Ok(model_event::commentary("inspect now.".to_string())),
            Ok(model_event::tool_call(ModelToolCall {
                id: "call_1".to_string(),
                name: "workspace/read".to_string(),
                arguments: serde_json::json!({"path": "README.md"}),
            })),
            Ok(model_event::COMPLETED),
        ])
    );
}

#[tokio::test]
async fn short_commentary_before_a_tool_call_is_preserved_and_executed() {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"I will inspect the workspace.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"workspace/read\",\"arguments\":\"{\\\"path\\\":\\\"README.md\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    let (endpoint, server) = response_server(body.as_bytes().to_vec(), Vec::new()).await;
    let events = provider(endpoint)
        .stream(tool_request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");
    assert_eq!(
        events,
        normalize_expected_model_events(vec![
            Ok(model_event::commentary(
                "I will inspect the workspace.".to_string()
            )),
            Ok(model_event::tool_call(ModelToolCall {
                id: "call_1".to_string(),
                name: "workspace/read".to_string(),
                arguments: serde_json::json!({"path": "README.md"}),
            })),
            Ok(model_event::COMPLETED),
        ])
    );
}

#[tokio::test]
async fn oversized_commentary_followed_by_a_tool_call_hits_the_output_limit() {
    let long_text = "x".repeat(513);
    let body = format!(
        concat!(
            "data: {{\"choices\":[{{\"index\":0,\"delta\":{{\"content\":\"{}\"}},\"finish_reason\":null}}]}}\n\n",
            "data: {{\"choices\":[{{\"index\":0,\"delta\":{{\"tool_calls\":[{{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{{\"name\":\"workspace/read\",\"arguments\":\"{{}}\"}}}}]}},\"finish_reason\":null}}]}}\n\n",
            "data: {{\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\n",
            "data: [DONE]\n\n"
        ),
        long_text
    );
    let (endpoint, server) = response_server(body.into_bytes(), Vec::new()).await;
    let events = provider(endpoint)
        .stream(tool_request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");
    assert!(matches!(
        events.as_slice(),
        [
            Ok(ModelEvent::OutputTextDelta { delta: text, .. }),
            Err(error)
        ] if text.len() == 513 && error.kind() == ModelErrorKind::OutputTooLarge
    ));
}

#[tokio::test]
async fn secondary_choice_is_a_protocol_error_before_primary_delta() {
    let body = concat!(
        "data: {\"choices\":[",
        "{\"index\":0,\"delta\":{\"content\":\"must-not-emit\"},\"finish_reason\":null},",
        "{\"index\":1,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"workspace/read\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}",
        "]}\n\n",
        "data: [DONE]\n\n"
    );
    let (endpoint, server) = response_server(body.as_bytes().to_vec(), Vec::new()).await;
    let events = provider(endpoint)
        .stream(request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");
    assert_eq!(events.len(), 1);
    let error = events[0].as_ref().expect_err("protocol error");
    assert_eq!(error.kind(), ModelErrorKind::Protocol);
}

#[tokio::test]
async fn oversized_sse_event_is_rejected_without_unbounded_buffering() {
    let body = format!("data: {}\n\n", "x".repeat(256 * 1024));
    let (endpoint, server) = response_server(body.into_bytes(), Vec::new()).await;
    let error = provider(endpoint)
        .stream(request())
        .await
        .expect("stream starts")
        .next()
        .await
        .expect("terminal event")
        .expect_err("oversized event must fail");
    server.await.expect("mock server");
    assert_eq!(error.kind(), ModelErrorKind::Protocol);
}

#[tokio::test]
async fn http_statuses_map_to_stable_retryable_errors() {
    for (status, kind, retryable) in [
        (400, ModelErrorKind::InvalidRequest, false),
        (401, ModelErrorKind::Authentication, false),
        (408, ModelErrorKind::Timeout, true),
        (429, ModelErrorKind::RateLimited, true),
        (500, ModelErrorKind::Server, true),
    ] {
        let (endpoint, server) = status_server(status).await;
        let error = match provider(endpoint).stream(request()).await {
            Ok(_) => panic!("HTTP {status} must fail"),
            Err(error) => error,
        };
        server.await.expect("mock server");
        assert_eq!(error.kind(), kind, "HTTP {status}");
        assert_eq!(error.retryable(), retryable, "HTTP {status}");
    }
}

#[tokio::test]
async fn context_length_rejections_are_distinct_from_other_invalid_requests() {
    for (status, body) in [
        (413, ""),
        (
            400,
            r#"{"error":{"code":"context_length_exceeded","message":"maximum context length reached"}}"#,
        ),
        (
            422,
            r#"{"error":{"message":"This prompt is too long for the context window."}}"#,
        ),
    ] {
        let (endpoint, server) = status_server_with_body(status, body.as_bytes()).await;
        let error = match provider(endpoint).stream(request()).await {
            Ok(_) => panic!("context rejection must not open a stream"),
            Err(error) => error,
        };
        server.await.expect("mock server");
        assert_eq!(error.kind(), ModelErrorKind::ContextLengthExceeded);
        assert!(!error.retryable());
    }
}

#[tokio::test]
async fn terminal_reason_matrix_maps_to_stable_non_retryable_errors() {
    for (terminal, kind) in [
        (
            "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"length\"}]}",
            ModelErrorKind::Incomplete,
        ),
        (
            "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"content_filter\"}]}",
            ModelErrorKind::Filtered,
        ),
        (
            "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}",
            ModelErrorKind::UnsupportedOutput,
        ),
        (
            "{\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[]},\"finish_reason\":null}]}",
            ModelErrorKind::Protocol,
        ),
        (
            "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"fixture_unknown\"}]}",
            ModelErrorKind::Protocol,
        ),
    ] {
        let body = format!("data: {terminal}\n\ndata: [DONE]\n\n");
        let (endpoint, server) = response_server(body.into_bytes(), Vec::new()).await;
        let error = provider(endpoint)
            .stream(request())
            .await
            .expect("stream starts")
            .next()
            .await
            .expect("terminal event")
            .expect_err("terminal reason must fail");
        server.await.expect("mock server");
        assert_eq!(error.kind(), kind);
        assert!(!error.retryable());
    }
}

#[tokio::test]
async fn done_without_finish_reason_is_a_protocol_error() {
    let (endpoint, server) = response_server(b"data: [DONE]\n\n".to_vec(), Vec::new()).await;
    let error = provider(endpoint)
        .stream(request())
        .await
        .expect("stream starts")
        .next()
        .await
        .expect("terminal event")
        .expect_err("DONE without finish must fail");
    server.await.expect("mock server");
    assert_eq!(error.kind(), ModelErrorKind::Protocol);
    assert!(!error.retryable());
}

#[tokio::test]
async fn response_header_timeout_uses_virtual_time() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind header timeout server");
    let address = listener.local_addr().expect("header timeout address");
    let (accepted_tx, accepted_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (_socket, _) = listener.accept().await.expect("accept request");
        let _ = accepted_tx.send(());
        let _ = release_rx.await;
    });
    let endpoint =
        Url::parse(&format!("http://{address}/v1/chat/completions")).expect("mock endpoint");
    let client = tokio::spawn(async move { provider(endpoint).stream(request()).await });
    accepted_rx.await.expect("request accepted");
    tokio::time::pause();
    tokio::time::advance(std::time::Duration::from_secs(31)).await;
    let error = match client.await.expect("provider task") {
        Ok(_) => panic!("missing response headers must time out"),
        Err(error) => error,
    };
    let _ = release_tx.send(());
    server.await.expect("mock server");
    assert_eq!(error.kind(), ModelErrorKind::Timeout);
    assert!(error.retryable());
}

#[tokio::test]
async fn stream_idle_timeout_uses_virtual_time() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind idle timeout server");
    let address = listener.local_addr().expect("idle timeout address");
    let (headers_tx, headers_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept request");
        read_request(&mut socket, true).await;
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
            )
            .await
            .expect("write response headers");
        socket.flush().await.expect("flush response headers");
        let _ = headers_tx.send(());
        let _ = release_rx.await;
    });
    let endpoint =
        Url::parse(&format!("http://{address}/v1/chat/completions")).expect("mock endpoint");
    let client = tokio::spawn(async move { provider(endpoint).stream(request()).await });
    headers_rx.await.expect("headers sent");
    let mut stream = client.await.expect("provider task").expect("stream starts");
    tokio::task::yield_now().await;
    tokio::time::pause();
    let next = tokio::spawn(async move { stream.next().await });
    tokio::task::yield_now().await;
    tokio::time::advance(std::time::Duration::from_secs(61)).await;
    let error = next
        .await
        .expect("stream task")
        .expect("terminal event")
        .expect_err("idle stream must time out");
    let _ = release_tx.send(());
    server.await.expect("mock server");
    assert_eq!(error.kind(), ModelErrorKind::Timeout);
    assert!(error.retryable());
}

#[tokio::test]
async fn disconnect_before_done_is_retryable_transport_failure() {
    let (endpoint, server) = response_server(DISCONNECT.as_bytes().to_vec(), Vec::new()).await;
    let provider = provider(endpoint);
    let events = provider
        .stream(request())
        .await
        .expect("HTTP request succeeds")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");

    assert_eq!(
        events[0],
        Ok(model_event::text_delta("partial".to_string()))
    );
    let error = *events[1].as_ref().expect_err("disconnect error");
    assert_eq!(error.kind(), ModelErrorKind::Disconnected);
    assert!(error.retryable());
}

#[tokio::test]
async fn truncated_http_body_after_delta_is_retryable_disconnect_not_protocol() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind truncated server");
    let address = listener.local_addr().expect("truncated server address");
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept request");
        read_request(&mut socket, true).await;
        let event = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n";
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    event.len() + 1024,
                    event
                )
                .as_bytes(),
            )
            .await
            .expect("write truncated response");
        socket.shutdown().await.expect("close truncated response");
    });
    let endpoint =
        Url::parse(&format!("http://{address}/v1/chat/completions")).expect("mock endpoint");
    let events = provider(endpoint)
        .stream(request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");
    assert_eq!(
        events[0],
        Ok(model_event::text_delta("partial".to_string()))
    );
    let error = events[1].as_ref().expect_err("disconnect");
    assert_eq!(error.kind(), ModelErrorKind::Disconnected);
    assert!(error.retryable());
}

#[tokio::test]
async fn dropping_the_stream_closes_the_upstream_response_without_sleep() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind mock server");
    let address = listener.local_addr().expect("mock address");
    let (closed_tx, closed_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept request");
        read_request(&mut socket, true).await;
        let event = CANCELLATION;
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{}\r\n",
                    event.len(),
                    event
                )
                .as_bytes(),
            )
            .await
            .expect("write partial stream");
        socket.flush().await.expect("flush partial stream");
        let mut byte = [0u8; 1];
        let result = socket.read(&mut byte).await;
        let _ = closed_tx.send(matches!(result, Ok(0) | Err(_)));
    });
    let endpoint =
        Url::parse(&format!("http://{address}/v1/chat/completions")).expect("mock endpoint");
    let provider = provider(endpoint);
    let mut stream = provider.stream(request()).await.expect("stream starts");
    assert_eq!(
        stream.next().await.expect("delta").expect("valid delta"),
        model_event::text_delta("partial".to_string())
    );
    drop(stream);

    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(2), closed_rx)
            .await
            .expect("upstream close deadline")
            .expect("close signal")
    );
    server.await.expect("mock server");
}

#[tokio::test]
async fn dropping_during_tool_argument_assembly_closes_upstream_without_an_event() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind mock server");
    let address = listener.local_addr().expect("mock address");
    let (fragment_tx, fragment_rx) = oneshot::channel();
    let (closed_tx, closed_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept request");
        read_request(&mut socket, true).await;
        let event = concat!(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[",
            "{\"index\":0,\"id\":\"call_partial\",\"type\":\"function\",\"function\":",
            "{\"name\":\"workspace/\",\"arguments\":\"{\\\"path\\\":\\\"partial\"}}",
            "]},\"finish_reason\":null}]}\n\n"
        );
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{}\r\n",
                    event.len(),
                    event
                )
                .as_bytes(),
            )
            .await
            .expect("write partial tool stream");
        socket.flush().await.expect("flush partial tool stream");
        let _ = fragment_tx.send(());
        let mut byte = [0u8; 1];
        let result = socket.read(&mut byte).await;
        let _ = closed_tx.send(matches!(result, Ok(0) | Err(_)));
    });
    let endpoint =
        Url::parse(&format!("http://{address}/v1/chat/completions")).expect("mock endpoint");
    let stream = provider(endpoint)
        .stream(tool_request())
        .await
        .expect("stream starts");
    fragment_rx.await.expect("fragment sent");
    tokio::task::yield_now().await;
    drop(stream);
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(2), closed_rx)
            .await
            .expect("upstream close deadline")
            .expect("close signal")
    );
    server.await.expect("mock server");
}

fn provider(endpoint: Url) -> Arc<dyn ModelProvider> {
    Arc::new(
        OpenAiChatCompletionsProvider::new(endpoint, Some("fixture-token".to_string()))
            .expect("provider"),
    )
}

fn request() -> ModelRequest {
    ModelRequest {
        model: "fixture-model".to_string(),
        instructions: Vec::new(),
        messages: vec![ModelMessage::Text {
            role: ModelRole::User,
            text: "Hello".to_string(),
        }],
        tools: Vec::new(),
    }
}

fn tool_request() -> ModelRequest {
    let mut request = request();
    request.tools.push(ModelToolDefinition {
        name: "workspace/read".to_string(),
        description: "Read a workspace file".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": { "path": { "type": "string" } },
            "required": ["path"]
        }),
    });
    request
}

async fn response_server(
    body: Vec<u8>,
    split_points: Vec<usize>,
) -> (Url, tokio::task::JoinHandle<()>) {
    response_server_with_options(body, split_points, "text/event-stream", true).await
}

async fn response_server_with_options(
    body: Vec<u8>,
    split_points: Vec<usize>,
    content_type: &'static str,
    expect_auth: bool,
) -> (Url, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind mock server");
    let address = listener.local_addr().expect("mock address");
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept request");
        read_request(&mut socket, expect_auth).await;
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .expect("write response headers");
        let mut start = 0usize;
        for end in split_points
            .into_iter()
            .filter(|end| *end > 0 && *end < body.len())
            .chain(std::iter::once(body.len()))
        {
            if end <= start {
                continue;
            }
            socket
                .write_all(&body[start..end])
                .await
                .expect("write response chunk");
            start = end;
        }
        socket.flush().await.expect("flush response");
    });
    (
        Url::parse(&format!("http://{address}/v1/chat/completions")).expect("mock endpoint"),
        server,
    )
}

async fn delayed_response_server(
    parts: Vec<(std::time::Duration, Vec<u8>)>,
) -> (Url, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind delayed mock server");
    let address = listener.local_addr().expect("delayed mock server address");
    let content_length = parts.iter().map(|(_, part)| part.len()).sum::<usize>();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept request");
        read_request(&mut socket, true).await;
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {content_length}\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .expect("write response headers");
        for (delay, part) in parts {
            tokio::time::sleep(delay).await;
            socket.write_all(&part).await.expect("write delayed chunk");
            socket.flush().await.expect("flush delayed chunk");
        }
    });
    (
        Url::parse(&format!("http://{address}/v1/chat/completions")).expect("mock endpoint"),
        server,
    )
}

async fn capturing_response_server(
    body: Vec<u8>,
) -> (
    Url,
    tokio::task::JoinHandle<()>,
    oneshot::Receiver<serde_json::Value>,
) {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind capture server");
    let address = listener.local_addr().expect("capture server address");
    let (request_tx, request_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept request");
        let request = read_request(&mut socket, true).await;
        let _ = request_tx.send(request);
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .expect("write response headers");
        socket.write_all(&body).await.expect("write response body");
        socket.flush().await.expect("flush response");
    });
    (
        Url::parse(&format!("http://{address}/v1/chat/completions")).expect("mock endpoint"),
        server,
        request_rx,
    )
}

async fn status_server(status: u16) -> (Url, tokio::task::JoinHandle<()>) {
    status_server_with_body(status, &[]).await
}

async fn status_server_with_body(status: u16, body: &[u8]) -> (Url, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind status server");
    let address = listener.local_addr().expect("status server address");
    let body = body.to_vec();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept request");
        read_request(&mut socket, true).await;
        socket
            .write_all(
                format!(
                    "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .expect("write status response");
        socket
            .write_all(&body)
            .await
            .expect("write status response body");
        socket.flush().await.expect("flush status response");
    });
    (
        Url::parse(&format!("http://{address}/v1/chat/completions")).expect("mock endpoint"),
        server,
    )
}

async fn read_request(socket: &mut TcpStream, expect_auth: bool) -> serde_json::Value {
    let mut request = Vec::new();
    let mut buffer = [0u8; 4096];
    let header_end = loop {
        let read = socket.read(&mut buffer).await.expect("read request");
        assert!(read > 0, "request ended before headers");
        request.extend_from_slice(&buffer[..read]);
        if let Some(position) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
        assert!(request.len() <= 64 * 1024, "request headers too large");
    };
    let headers = String::from_utf8_lossy(&request[..header_end]);
    assert!(headers.starts_with("POST /v1/chat/completions HTTP/1.1\r\n"));
    let has_auth = headers
        .to_ascii_lowercase()
        .contains("authorization: bearer fixture-token\r\n");
    assert_eq!(has_auth, expect_auth);
    let content_length = headers
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length: ")
                .and_then(|value| value.parse::<usize>().ok())
        })
        .expect("content length");
    assert!(content_length <= 1024 * 1024);
    while request.len() - header_end < content_length {
        let read = socket.read(&mut buffer).await.expect("read request body");
        assert!(read > 0, "request body ended early");
        request.extend_from_slice(&buffer[..read]);
    }
    let body: serde_json::Value =
        serde_json::from_slice(&request[header_end..header_end + content_length])
            .expect("JSON request body");
    let keys = body
        .as_object()
        .expect("request object")
        .keys()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    let mut expected =
        std::collections::BTreeSet::from(["messages", "model", "stream", "stream_options"]);
    if body.get("tools").is_some() {
        expected.insert("tools");
        expected.insert("parallel_tool_calls");
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["function"]["name"], "workspace_read");
        assert_eq!(body["parallel_tool_calls"], false);
    }
    assert_eq!(keys, expected);
    assert_eq!(body["stream_options"]["include_usage"], true);
    body
}
