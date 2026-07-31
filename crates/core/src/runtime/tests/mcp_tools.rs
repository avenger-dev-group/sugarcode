use super::*;
use crate::{McpToolExecutionResult, PreparedMcpToolCall};
use futures_util::future::BoxFuture;
use sha2::{Digest, Sha256};

#[derive(Debug)]
struct RecordedMcpExecutor {
    executions: Arc<AtomicUsize>,
}

impl McpToolExecutor for RecordedMcpExecutor {
    fn definitions(&self) -> Vec<ModelToolDefinition> {
        vec![ModelToolDefinition {
            name: "mcp__fixture__inspect".to_string(),
            description: "Inspect one value.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {"value": {"type": "string"}},
                "required": ["value"],
                "additionalProperties": false
            }),
        }]
    }

    fn prepare(
        &self,
        callable_name: &str,
        arguments: serde_json::Value,
    ) -> Result<PreparedMcpToolCall, McpToolPrepareError> {
        if callable_name != "mcp__fixture__inspect"
            || arguments
                .get("value")
                .and_then(serde_json::Value::as_str)
                .is_none()
        {
            return Err(McpToolPrepareError::InvalidArguments);
        }
        let bytes = serde_json::to_vec(&arguments).expect("arguments");
        let arguments_sha256 = format!("{:x}", Sha256::digest(&bytes));
        Ok(PreparedMcpToolCall {
            callable_name: callable_name.to_string(),
            arguments,
            arguments_bytes: bytes.len() as u64,
            arguments_sha256,
            inventory_sha256: "b".repeat(64),
        })
    }

    fn execute(
        &self,
        _call: PreparedMcpToolCall,
        _cancellation: CancellationToken,
    ) -> BoxFuture<'static, McpToolExecutionOutcome> {
        self.executions.fetch_add(1, Ordering::AcqRel);
        let content = r#"{"isError":false,"text":["ok"]}"#.to_string();
        let sha256 = format!("{:x}", Sha256::digest(content.as_bytes()));
        async move {
            McpToolExecutionOutcome::Completed(McpToolExecutionResult {
                canonical_bytes: content.len() as u64,
                observed_bytes: content.len() as u64,
                content,
                is_error: false,
                sha256,
                content_blocks: 1,
                structured_content: false,
            })
        }
        .boxed()
    }
}

#[derive(Debug)]
struct RecordedMcpApproval {
    outcome: McpToolApprovalOutcome,
    requests: Arc<Mutex<Vec<McpToolApprovalRequest>>>,
}

impl McpToolApprovalRequester for RecordedMcpApproval {
    fn request(
        &self,
        request: McpToolApprovalRequest,
    ) -> BoxFuture<'static, McpToolApprovalOutcome> {
        self.requests.lock().expect("requests").push(request);
        let outcome = self.outcome;
        async move { outcome }.boxed()
    }
}

#[tokio::test]
async fn local_mcp_local_tools_alternate_in_one_turn() {
    let directory = tempfile::tempdir().expect("workspace");
    std::fs::write(directory.path().join("first.txt"), "first").expect("first fixture");
    std::fs::write(directory.path().join("second.txt"), "second").expect("second fixture");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([
            vec![
                Ok(model_event::tool_call(ModelToolCall {
                    id: "call_local_1".to_string(),
                    name: "workspace/read".to_string(),
                    arguments: serde_json::json!({"path": "first.txt"}),
                })),
                Ok(model_event::COMPLETED),
            ],
            vec![
                Ok(model_event::tool_call(ModelToolCall {
                    id: "call_mcp_between".to_string(),
                    name: "mcp__fixture__inspect".to_string(),
                    arguments: serde_json::json!({"value": "between"}),
                })),
                Ok(model_event::COMPLETED),
            ],
            vec![
                Ok(model_event::tool_call(ModelToolCall {
                    id: "call_local_2".to_string(),
                    name: "workspace/read".to_string(),
                    arguments: serde_json::json!({"path": "second.txt"}),
                })),
                Ok(model_event::COMPLETED),
            ],
            vec![
                Ok(model_event::text_delta(
                    "Alternating tools completed.".to_string(),
                )),
                Ok(model_event::COMPLETED),
            ],
        ])),
        requests: requests.clone(),
    };
    let mut core = Core::new();
    let started = core.start_thread(CoreRequestId::new(1)).expect("thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    let executions = Arc::new(AtomicUsize::new(0));
    let capability = McpToolCapability::default();
    capability.set_enabled(true);
    let workspace = Arc::new(WorkspaceTool::open(directory.path()).expect("workspace tool"));
    let (runtime, mut events) = CoreRuntime::new_with_workspace(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        Some(workspace),
        None,
    );
    let mut runtime = runtime.with_mcp(
        Arc::new(RecordedMcpExecutor {
            executions: executions.clone(),
        }),
        Arc::new(RecordedMcpApproval {
            outcome: McpToolApprovalOutcome::Approved,
            requests: Arc::new(Mutex::new(Vec::new())),
        }),
        capability,
    );
    runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Read, inspect remotely, then read again".to_string()),
        )
        .expect("turn");
    while !matches!(
        events.recv().await.expect("event").kind,
        CoreEventKind::TurnCompleted { .. }
    ) {}

    assert_eq!(executions.load(Ordering::Acquire), 1);
    let requests = requests.lock().expect("requests");
    assert_eq!(requests.len(), 4);
    assert!(requests.iter().all(|request| {
        request
            .tools
            .iter()
            .any(|tool| tool.name == "workspace/read")
            && request
                .tools
                .iter()
                .any(|tool| tool.name == "mcp__fixture__inspect")
    }));
    drop(requests);
    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let calls = snapshot.turns[0]
        .items
        .iter()
        .filter_map(|item| match item {
            sugarcode_state::DurableItemSnapshot::ToolCall { name, .. }
            | sugarcode_state::DurableItemSnapshot::McpToolCall { name, .. } => Some(name.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        calls,
        ["workspace/read", "mcp__fixture__inspect", "workspace/read"]
    );
}

#[tokio::test]
async fn approved_mcp_call_crosses_attempt_before_one_execution_and_second_round() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([
            vec![
                Ok(model_event::tool_call(ModelToolCall {
                    id: "call_mcp".to_string(),
                    name: "mcp__fixture__inspect".to_string(),
                    arguments: serde_json::json!({"value": "hello"}),
                })),
                Ok(model_event::COMPLETED),
            ],
            vec![
                Ok(model_event::text_delta("Finished.".to_string())),
                Ok(model_event::COMPLETED),
            ],
        ])),
        requests: requests.clone(),
    };
    let mut core = Core::new();
    let started = core.start_thread(CoreRequestId::new(1)).expect("thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    let executions = Arc::new(AtomicUsize::new(0));
    let approvals = Arc::new(Mutex::new(Vec::new()));
    let capability = McpToolCapability::default();
    capability.set_enabled(true);
    let (runtime, mut events) =
        CoreRuntime::new(core, Arc::new(provider), "fixture-model".to_string());
    let mut runtime = runtime.with_mcp(
        Arc::new(RecordedMcpExecutor {
            executions: executions.clone(),
        }),
        Arc::new(RecordedMcpApproval {
            outcome: McpToolApprovalOutcome::Approved,
            requests: approvals.clone(),
        }),
        capability,
    );
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Use MCP".to_string()),
        )
        .expect("turn")
    else {
        panic!("async turn");
    };
    loop {
        match events.recv().await.expect("event").kind {
            CoreEventKind::TurnCompleted { .. } => break,
            CoreEventKind::TurnFailed { error, .. } => panic!("turn failed: {error:?}"),
            CoreEventKind::TurnInterrupted { .. } => panic!("turn interrupted"),
            _ => {}
        }
    }

    assert_eq!(executions.load(Ordering::Acquire), 1);
    let approvals = approvals.lock().expect("approvals");
    assert_eq!(approvals.len(), 1);
    assert_eq!(approvals[0].name, "mcp__fixture__inspect");
    assert_eq!(
        approvals[0].arguments,
        serde_json::json!({"value": "hello"})
    );
    drop(approvals);

    let provider_requests = requests.lock().expect("provider requests");
    assert_eq!(provider_requests.len(), 2);
    assert_eq!(
        provider_requests[0]
            .tools
            .iter()
            .filter(|tool| tool.name.starts_with("mcp__"))
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        vec!["mcp__fixture__inspect"]
    );
    assert_eq!(
        provider_requests[1]
            .tools
            .iter()
            .filter(|tool| tool.name.starts_with("mcp__"))
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        vec!["mcp__fixture__inspect"]
    );
    assert!(matches!(
        provider_requests[1].messages.as_slice(),
        [
            ModelMessage::Text { .. },
            ModelMessage::ToolCall(_),
            ModelMessage::ToolResult { content, .. }
        ] if content == r#"{"isError":false,"text":["ok"]}"#
    ));
    drop(provider_requests);

    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.id == turn_id)
        .expect("turn");
    assert!(matches!(
        turn.items.as_slice(),
        [
            sugarcode_state::DurableItemSnapshot::UserMessage { .. },
            sugarcode_state::DurableItemSnapshot::McpToolCall { .. },
            sugarcode_state::DurableItemSnapshot::McpToolCallApprovalRequest { .. },
            sugarcode_state::DurableItemSnapshot::McpToolCallApprovalDecision {
                decision,
                ..
            },
            sugarcode_state::DurableItemSnapshot::McpToolExecutionAttempt { .. },
            sugarcode_state::DurableItemSnapshot::McpToolResult {
                result: sugarcode_state::DurableMcpToolResult::Completed { .. },
                ..
            },
            sugarcode_state::DurableItemSnapshot::AgentMessage { text, .. },
        ] if decision == "approved" && text == "Finished."
    ));
    let original_items = turn.items.clone();
    let fork = runtime.fork_thread(&thread_id).expect("fork");
    assert_ne!(fork.id, thread_id);
    assert_eq!(fork.turns.len(), 1);
    assert_eq!(fork.turns[0].items.len(), original_items.len());
    for (original, remapped) in original_items.iter().zip(&fork.turns[0].items) {
        assert_ne!(original.id(), remapped.id());
    }
    assert!(matches!(
        (&original_items[1], &fork.turns[0].items[1]),
        (
            sugarcode_state::DurableItemSnapshot::McpToolCall {
                call_id: original_call_id,
                name: original_name,
                arguments_sha256: original_arguments_sha256,
                inventory_sha256: original_inventory_sha256,
                ..
            },
            sugarcode_state::DurableItemSnapshot::McpToolCall {
                call_id: fork_call_id,
                name: fork_name,
                arguments_sha256: fork_arguments_sha256,
                inventory_sha256: fork_inventory_sha256,
                ..
            }
        ) if original_call_id == fork_call_id
            && original_name == fork_name
            && original_arguments_sha256 == fork_arguments_sha256
            && original_inventory_sha256 == fork_inventory_sha256
    ));
}

#[tokio::test]
async fn effectful_tool_batch_is_not_limited_by_item_count() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let calls = (1..=5)
        .map(|ordinal| ModelToolCall {
            id: format!("call_mcp_{ordinal}"),
            name: "mcp__fixture__inspect".to_string(),
            arguments: serde_json::json!({"value": format!("value-{ordinal}")}),
        })
        .collect::<Vec<_>>();
    let rounds = VecDeque::from([
        vec![Ok(model_event::tool_call_batch(calls))],
        vec![
            Ok(model_event::text_delta("Finished five calls.".to_string())),
            Ok(model_event::COMPLETED),
        ],
    ]);
    let provider = SequencedProvider {
        rounds: Mutex::new(rounds),
        requests: requests.clone(),
    };
    let mut core = Core::new();
    let started = core.start_thread(CoreRequestId::new(1)).expect("thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    let executions = Arc::new(AtomicUsize::new(0));
    let approvals = Arc::new(Mutex::new(Vec::new()));
    let capability = McpToolCapability::default();
    capability.set_enabled(true);
    let (runtime, mut events) =
        CoreRuntime::new(core, Arc::new(provider), "fixture-model".to_string());
    let mut runtime = runtime.with_mcp(
        Arc::new(RecordedMcpExecutor {
            executions: executions.clone(),
        }),
        Arc::new(RecordedMcpApproval {
            outcome: McpToolApprovalOutcome::Approved,
            requests: approvals.clone(),
        }),
        capability,
    );
    runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Use MCP five times".to_string()),
        )
        .expect("turn");
    loop {
        match events.recv().await.expect("event").kind {
            CoreEventKind::TurnCompleted { .. } => break,
            CoreEventKind::TurnFailed { error, .. } => panic!("turn failed: {error:?}"),
            CoreEventKind::TurnInterrupted { .. } => panic!("turn interrupted"),
            _ => {}
        }
    }

    assert_eq!(executions.load(Ordering::Acquire), 5);
    let approvals = approvals.lock().expect("approvals");
    assert_eq!(approvals.len(), 5);
    assert_eq!(
        approvals
            .iter()
            .map(|request| request.call_id.as_str())
            .collect::<Vec<_>>(),
        vec![
            "call_mcp_1",
            "call_mcp_2",
            "call_mcp_3",
            "call_mcp_4",
            "call_mcp_5"
        ]
    );
    drop(approvals);

    let provider_requests = requests.lock().expect("provider requests");
    assert_eq!(provider_requests.len(), 2);
    assert!(provider_requests.iter().all(|request| {
        request
            .tools
            .iter()
            .filter(|tool| tool.name.starts_with("mcp__"))
            .map(|tool| tool.name.as_str())
            .eq(["mcp__fixture__inspect"])
    }));
    let messages = &provider_requests[1].messages;
    assert!(matches!(
        messages.iter().find(|message| matches!(message, ModelMessage::ToolCallBatch(_))),
        Some(ModelMessage::ToolCallBatch(calls)) if calls.len() == 5
    ));
    assert_eq!(
        messages
            .iter()
            .filter(|message| matches!(message, ModelMessage::ToolResult { .. }))
            .count(),
        5
    );
    for ordinal in 1..=5 {
        let call_id = format!("call_mcp_{ordinal}");
        assert!(messages.iter().any(|message| {
            matches!(
                message,
                ModelMessage::ToolResult {
                    call_id: result_call_id,
                    ..
                } if result_call_id == &call_id
            )
        }));
    }
    drop(provider_requests);

    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot.turns.last().expect("turn");
    assert_eq!(
        turn.items
            .iter()
            .filter(|item| matches!(
                item,
                sugarcode_state::DurableItemSnapshot::McpToolCall { .. }
            ))
            .count(),
        5
    );
    assert_eq!(
        turn.items
            .iter()
            .filter(|item| matches!(
                item,
                sugarcode_state::DurableItemSnapshot::McpToolResult { .. }
            ))
            .count(),
        5
    );
    let original_items = turn.items.clone();
    let fork = runtime.fork_thread(&thread_id).expect("fork");
    assert_eq!(fork.turns.len(), 1);
    assert_eq!(fork.turns[0].items.len(), original_items.len());
    assert_eq!(
        fork.turns[0]
            .items
            .iter()
            .filter(|item| matches!(
                item,
                sugarcode_state::DurableItemSnapshot::McpToolCall { .. }
            ))
            .count(),
        5
    );
    for (original, remapped) in original_items.iter().zip(&fork.turns[0].items) {
        assert_ne!(original.id(), remapped.id());
    }
}

#[tokio::test]
async fn denied_mcp_call_never_crosses_attempt_or_executes() {
    let provider_requests = Arc::new(Mutex::new(Vec::new()));
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([
            vec![
                Ok(model_event::tool_call(ModelToolCall {
                    id: "call_denied".to_string(),
                    name: "mcp__fixture__inspect".to_string(),
                    arguments: serde_json::json!({"value": "hello"}),
                })),
                Ok(model_event::COMPLETED),
            ],
            vec![
                Ok(model_event::text_delta("Denied.".to_string())),
                Ok(model_event::COMPLETED),
            ],
        ])),
        requests: provider_requests.clone(),
    };
    let mut core = Core::new();
    let started = core.start_thread(CoreRequestId::new(1)).expect("thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    let executions = Arc::new(AtomicUsize::new(0));
    let capability = McpToolCapability::default();
    capability.set_enabled(true);
    let (runtime, mut events) =
        CoreRuntime::new(core, Arc::new(provider), "fixture-model".to_string());
    let mut runtime = runtime.with_mcp(
        Arc::new(RecordedMcpExecutor {
            executions: executions.clone(),
        }),
        Arc::new(RecordedMcpApproval {
            outcome: McpToolApprovalOutcome::Denied,
            requests: Arc::new(Mutex::new(Vec::new())),
        }),
        capability,
    );
    let TurnStartOutcome::Accepted { .. } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Use MCP".to_string()),
        )
        .expect("turn")
    else {
        panic!("async turn");
    };
    loop {
        match events.recv().await.expect("event").kind {
            CoreEventKind::TurnCompleted { .. } => break,
            CoreEventKind::TurnFailed { error, .. } => panic!("turn failed: {error:?}"),
            CoreEventKind::TurnInterrupted { .. } => panic!("turn interrupted"),
            _ => {}
        }
    }
    assert_eq!(executions.load(Ordering::Acquire), 0);
    let provider_requests = provider_requests.lock().expect("provider requests");
    assert_eq!(provider_requests.len(), 2);
    assert!(!provider_requests[1].tools.is_empty());
    drop(provider_requests);
    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot.turns.last().expect("turn");
    assert!(!turn.items.iter().any(|item| {
        matches!(
            item,
            sugarcode_state::DurableItemSnapshot::McpToolExecutionAttempt { .. }
        )
    }));
    assert!(turn.items.iter().any(|item| {
        matches!(
            item,
            sugarcode_state::DurableItemSnapshot::McpToolResult {
                result: sugarcode_state::DurableMcpToolResult::Error {
                    kind,
                    request_state,
                },
                ..
            } if kind == "approvalDenied" && request_state == "notSent"
        )
    }));
}

#[tokio::test]
async fn missing_client_capability_omits_mcp_definition_and_execution() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = RecordedProvider {
        events: vec![
            Ok(model_event::tool_call(ModelToolCall {
                id: "call_hidden".to_string(),
                name: "mcp__fixture__inspect".to_string(),
                arguments: serde_json::json!({"value": "hello"}),
            })),
            Ok(model_event::COMPLETED),
        ],
        stay_open: false,
    };
    let (runtime, mut events, thread_id) = runtime(provider);
    let executions = Arc::new(AtomicUsize::new(0));
    let capability = McpToolCapability::default();
    let mut runtime = runtime.with_mcp(
        Arc::new(RecordedMcpExecutor {
            executions: executions.clone(),
        }),
        Arc::new(RecordedMcpApproval {
            outcome: McpToolApprovalOutcome::Approved,
            requests: requests.clone(),
        }),
        capability,
    );
    let TurnStartOutcome::Accepted { .. } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id,
            Some("Try hidden MCP".to_string()),
        )
        .expect("turn")
    else {
        panic!("async turn");
    };
    while !matches!(
        events.recv().await.expect("event").kind,
        CoreEventKind::TurnFailed { .. }
    ) {}
    assert_eq!(executions.load(Ordering::Acquire), 0);
    assert!(requests.lock().expect("requests").is_empty());
}
