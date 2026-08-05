use super::*;

fn workspace_read_payload(content: &str) -> String {
    use sha2::Digest;

    serde_json::to_string(&serde_json::json!({
        "content": content,
        "bytes": content.len(),
        "sha256": format!("{:x}", sha2::Sha256::digest(content.as_bytes())),
    }))
    .expect("workspace/read payload")
}

#[test]
fn workspace_list_accepts_only_exact_lowercase_boolean_strings() {
    for (value, expected) in [
        (serde_json::json!(true), true),
        (serde_json::json!(false), false),
        (serde_json::json!("true"), true),
        (serde_json::json!("false"), false),
    ] {
        let arguments = workspace_tool_arguments(&ModelToolCall {
            id: "call_list".to_string(),
            name: "workspace/list".to_string(),
            arguments: serde_json::json!({"path": ".", "recursive": value}),
        })
        .expect("compatible recursive boolean");
        assert_eq!(arguments.recursive, expected);
    }

    for value in [
        serde_json::json!("TRUE"),
        serde_json::json!("False"),
        serde_json::json!(" false"),
        serde_json::json!("0"),
        serde_json::json!(0),
        serde_json::Value::Null,
    ] {
        assert!(
            workspace_tool_arguments(&ModelToolCall {
                id: "call_invalid_list".to_string(),
                name: "workspace/list".to_string(),
                arguments: serde_json::json!({"path": ".", "recursive": value}),
            })
            .is_err(),
            "recursive must reject {value}"
        );
    }
}

#[tokio::test]
async fn compatible_list_boolean_does_not_reject_a_read_only_batch() {
    let directory = tempfile::tempdir().expect("workspace");
    std::fs::write(directory.path().join("package.json"), "fixture package")
        .expect("package fixture");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([
            vec![Ok(model_event::tool_call_batch(vec![
                ModelToolCall {
                    id: "call_list".to_string(),
                    name: "workspace/list".to_string(),
                    arguments: serde_json::json!({"path": ".", "recursive": "false"}),
                },
                ModelToolCall {
                    id: "call_read".to_string(),
                    name: "workspace/read".to_string(),
                    arguments: serde_json::json!({"path": "package.json"}),
                },
            ]))],
            vec![Ok(model_event::final_response("Review completed."))],
        ])),
        requests: Arc::clone(&requests),
    };
    let mut core = Core::new();
    let CoreEventKind::ThreadStarted { thread_id } = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread")
        .kind
    else {
        panic!("thread event");
    };
    let tool = Arc::new(WorkspaceTool::open(directory.path()).expect("workspace tool"));
    let workspace_read: Arc<dyn WorkspaceReadExecutor> = tool.clone();
    let workspace_list: Arc<dyn WorkspaceListExecutor> = tool;
    let (mut runtime, mut events) = CoreRuntime::new_with_workspace(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        Some(workspace_read),
        Some(workspace_list),
    );
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Review the project".to_string()),
        )
        .expect("start turn")
    else {
        panic!("asynchronous turn");
    };

    while !matches!(
        events.recv().await.expect("terminal event").kind,
        CoreEventKind::TurnCompleted { .. }
    ) {}

    let requests = requests.lock().expect("requests");
    assert_eq!(requests.len(), 2);
    let results = message_tool_results(requests[1].messages.last().expect("result message"));
    assert_eq!(
        results
            .iter()
            .map(|result| result.call_id.as_str())
            .collect::<Vec<_>>(),
        ["call_list", "call_read"]
    );
    assert!(
        results
            .iter()
            .all(|result| !tool_result_serialized(result).contains("Rejected"))
    );
    drop(requests);

    let turn = runtime
        .resume_thread(&thread_id)
        .expect("resume")
        .turns
        .into_iter()
        .find(|turn| turn.id == turn_id)
        .expect("turn");
    assert_eq!(turn.status, DurableTurnStatus::Completed);
    assert!(!turn.items.iter().any(|item| matches!(
        item,
        sugarcode_state::DurableItemSnapshot::ToolValidationRejected { .. }
    )));
}

#[derive(Debug)]
struct ConcurrentWorkspaceRead {
    barrier: Arc<tokio::sync::Barrier>,
    active: AtomicUsize,
    maximum: AtomicUsize,
}

impl WorkspaceReadExecutor for ConcurrentWorkspaceRead {
    fn read<'a>(
        &'a self,
        arguments: &'a WorkspaceReadArguments,
        _cancellation: &'a CancellationToken,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = WorkspaceReadOutcome> + Send + 'a>>
    {
        Box::pin(async move {
            let active = self.active.fetch_add(1, Ordering::AcqRel) + 1;
            self.maximum.fetch_max(active, Ordering::AcqRel);
            self.barrier.wait().await;
            self.active.fetch_sub(1, Ordering::AcqRel);
            WorkspaceReadOutcome::Content {
                content: arguments.path.clone(),
                bytes: arguments.path.len(),
            }
        })
    }
}

#[tokio::test]
async fn three_workspace_reads_execute_concurrently_and_replay_in_call_order() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([
            vec![
                Ok(model_event::tool_call_batch(vec![
                    ModelToolCall {
                        id: "call_a".to_string(),
                        name: "workspace/read".to_string(),
                        arguments: serde_json::json!({ "path": "a.md" }),
                    },
                    ModelToolCall {
                        id: "call_b".to_string(),
                        name: "workspace/read".to_string(),
                        arguments: serde_json::json!({ "path": "b.md" }),
                    },
                    ModelToolCall {
                        id: "call_c".to_string(),
                        name: "workspace/read".to_string(),
                        arguments: serde_json::json!({ "path": "c.md" }),
                    },
                ])),
                Ok(model_event::COMPLETED),
            ],
            vec![
                Ok(model_event::text_delta("Done.".to_string())),
                Ok(model_event::COMPLETED),
            ],
        ])),
        requests: requests.clone(),
    };
    let mut core = Core::new();
    let started = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    let read = Arc::new(ConcurrentWorkspaceRead {
        barrier: Arc::new(tokio::sync::Barrier::new(3)),
        active: AtomicUsize::new(0),
        maximum: AtomicUsize::new(0),
    });
    let (mut runtime, mut events) = CoreRuntime::new_with_workspace(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        Some(read.clone()),
        None,
    );
    runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id,
            Some("Read three files".to_string()),
        )
        .expect("start batch turn");

    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while !matches!(
            events.recv().await.expect("terminal event").kind,
            CoreEventKind::TurnCompleted { .. }
        ) {}
    })
    .await
    .expect("parallel reads must not deadlock");
    assert_eq!(read.maximum.load(Ordering::Acquire), 3);

    let requests = requests.lock().expect("requests");
    let messages = &requests[1].messages;
    assert_eq!(messages.len(), 3);
    assert_eq!(message_texts(&messages[0]).len(), 1);
    assert_eq!(message_tool_calls(&messages[1]).len(), 3);
    let results = message_tool_results(&messages[2]);
    assert_eq!(results.len(), 3);
    assert_eq!(
        results
            .iter()
            .map(|result| (result.call_id.as_str(), tool_result_serialized(result)))
            .collect::<Vec<_>>(),
        vec![
            ("call_a", workspace_read_payload("a.md")),
            ("call_b", workspace_read_payload("b.md")),
            ("call_c", workspace_read_payload("c.md")),
        ]
    );
}

#[tokio::test]
async fn workspace_read_runs_one_durable_tool_round_before_the_final_answer() {
    let directory = tempfile::tempdir().expect("workspace");
    std::fs::write(directory.path().join("README.txt"), "bounded context")
        .expect("workspace fixture");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([
            vec![
                Ok(model_event::tool_call(ModelToolCall {
                    id: "call_1".to_string(),
                    name: "workspace/read".to_string(),
                    arguments: serde_json::json!({ "path": "README.txt" }),
                })),
                Ok(model_event::usage(ModelUsage {
                    input_tokens: Some(3),
                    cached_input_tokens: Some(1),
                    output_tokens: Some(2),
                    reasoning_output_tokens: Some(1),
                    total_tokens: Some(5),
                })),
                Ok(model_event::COMPLETED),
            ],
            vec![
                Ok(model_event::text_delta("I read it.".to_string())),
                Ok(model_event::usage(ModelUsage {
                    input_tokens: Some(7),
                    cached_input_tokens: Some(2),
                    output_tokens: Some(4),
                    reasoning_output_tokens: Some(2),
                    total_tokens: Some(11),
                })),
                Ok(model_event::COMPLETED),
            ],
        ])),
        requests: requests.clone(),
    };
    let mut core = Core::new();
    let started = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    let tool = Arc::new(WorkspaceTool::open(directory.path()).expect("workspace tool"));
    let (mut runtime, mut events) = CoreRuntime::new_with_workspace(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        Some(tool),
        None,
    );
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Read the file".to_string()),
        )
        .expect("start tool turn")
    else {
        panic!("asynchronous turn");
    };

    let mut lifecycle = Vec::new();
    while lifecycle
        .last()
        .is_none_or(|event: &CoreEvent| !matches!(event.kind, CoreEventKind::TurnCompleted { .. }))
    {
        lifecycle.push(events.recv().await.expect("core event"));
    }
    let expected_payload = workspace_read_payload("bounded context");
    assert!(lifecycle.iter().any(|event| {
        matches!(
            &event.kind,
            CoreEventKind::ItemCompleted {
                item: CoreItemSnapshot {
                    kind: CoreItemKind::ToolCall { arguments, .. },
                    ..
                },
                ..
            } if arguments.get("path").and_then(serde_json::Value::as_str) == Some("README.txt")
        )
    }));
    assert!(lifecycle.iter().any(|event| {
        matches!(
            &event.kind,
            CoreEventKind::ItemCompleted {
                item: CoreItemSnapshot {
                    kind: CoreItemKind::ToolResult {
                        result: CoreToolResult::Success { content, .. },
                        ..
                    },
                    ..
                },
                ..
            } if content == &expected_payload
        )
    }));

    let requests = requests.lock().expect("requests");
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0]
            .tools
            .iter()
            .filter(|tool| tool.name.starts_with("workspace/"))
            .count(),
        1
    );
    assert!(
        requests[1]
            .tools
            .iter()
            .any(|tool| tool.name == "workspace/read")
    );
    let messages = &requests[1].messages;
    assert_eq!(messages.len(), 3);
    assert_eq!(message_texts(&messages[0]).len(), 1);
    assert_eq!(message_tool_calls(&messages[1]).len(), 1);
    let results = message_tool_results(&messages[2]);
    assert_eq!(results.len(), 1);
    assert_eq!(tool_result_serialized(results[0]), expected_payload);
    drop(requests);

    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.id == turn_id)
        .expect("persisted tool turn");
    assert_eq!(turn.status, DurableTurnStatus::Completed);
    assert_eq!(
        turn.usage,
        Some(DurableUsage {
            input_tokens: Some(10),
            cached_input_tokens: Some(3),
            output_tokens: Some(6),
            reasoning_tokens: Some(3),
            total_tokens: Some(16),
            last_request: Some(sugarcode_state::DurableUsageSample {
                input_tokens: Some(7),
                cached_input_tokens: Some(2),
                output_tokens: Some(4),
                reasoning_tokens: Some(2),
                total_tokens: Some(11),
            }),
            max_request_input_tokens: Some(7),
            request_count: 2,
            context_window_tokens: Some(131_072),
            source: Some(sugarcode_state::DurableUsageSource::Provider),
        })
    );
    assert!(matches!(
        turn.items.as_slice(),
        [
            sugarcode_state::DurableItemSnapshot::UserMessage { .. },
            sugarcode_state::DurableItemSnapshot::ToolCall { .. },
            sugarcode_state::DurableItemSnapshot::ToolResult {
                result: sugarcode_state::DurableToolResult::Success { content, .. },
                ..
            },
            sugarcode_state::DurableItemSnapshot::AgentMessage { text, .. }
        ] if content == &workspace_read_payload("bounded context") && text == "I read it."
    ));
}

#[tokio::test]
async fn commentary_is_durable_and_replayed_before_its_tool_call() {
    let directory = tempfile::tempdir().expect("workspace");
    std::fs::write(directory.path().join("README.txt"), "bounded context")
        .expect("workspace fixture");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([
            vec![
                Ok(model_event::commentary(
                    "I will inspect the workspace first.".to_string(),
                )),
                Ok(model_event::tool_call(ModelToolCall {
                    id: "call_commentary".to_string(),
                    name: "workspace/read".to_string(),
                    arguments: serde_json::json!({ "path": "README.txt" }),
                })),
                Ok(model_event::COMPLETED),
            ],
            vec![
                Ok(model_event::text_delta(
                    "The workspace is ready.".to_string(),
                )),
                Ok(model_event::COMPLETED),
            ],
        ])),
        requests: requests.clone(),
    };
    let mut core = Core::new();
    let started = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    let tool = Arc::new(WorkspaceTool::open(directory.path()).expect("workspace tool"));
    let (mut runtime, mut events) = CoreRuntime::new_with_workspace(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        Some(tool),
        None,
    );
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Inspect the workspace".to_string()),
        )
        .expect("start commentary turn")
    else {
        panic!("asynchronous turn");
    };

    while !matches!(
        events.recv().await.expect("core event").kind,
        CoreEventKind::TurnCompleted { .. }
    ) {}

    let requests = requests.lock().expect("requests");
    let messages = &requests[1].messages;
    assert_eq!(messages.len(), 4);
    assert_eq!(message_texts(&messages[0]).len(), 1);
    assert_eq!(
        message_texts(&messages[1]),
        vec!["I will inspect the workspace first."]
    );
    let calls = message_tool_calls(&messages[2]);
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].id, "call_commentary");
    let results = message_tool_results(&messages[3]);
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].call_id, "call_commentary");
    assert_eq!(
        tool_result_serialized(results[0]),
        workspace_read_payload("bounded context")
    );
    drop(requests);

    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.id == turn_id)
        .expect("persisted commentary turn");
    assert!(matches!(
        turn.items.as_slice(),
        [
            sugarcode_state::DurableItemSnapshot::UserMessage { .. },
            sugarcode_state::DurableItemSnapshot::AgentCommentary { text, .. },
            sugarcode_state::DurableItemSnapshot::ToolCall { .. },
            sugarcode_state::DurableItemSnapshot::ToolResult { .. },
            sugarcode_state::DurableItemSnapshot::AgentMessage { .. }
        ] if text == "I will inspect the workspace first."
    ));
}

#[tokio::test]
async fn workspace_list_uses_the_shared_authority_and_one_durable_tool_round() {
    let directory = tempfile::tempdir().expect("workspace");
    std::fs::write(directory.path().join("zeta.txt"), "z").expect("zeta fixture");
    std::fs::write(directory.path().join("Alpha.txt"), "a").expect("alpha fixture");
    std::fs::create_dir(directory.path().join("src")).expect("directory fixture");
    std::fs::write(directory.path().join("src/nested.txt"), "nested").expect("nested fixture");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([
            vec![
                Ok(model_event::tool_call(ModelToolCall {
                    id: "call_list".to_string(),
                    name: "workspace/list".to_string(),
                    arguments: serde_json::json!({ "path": "." }),
                })),
                Ok(model_event::COMPLETED),
            ],
            vec![
                Ok(model_event::text_delta("I listed it.".to_string())),
                Ok(model_event::COMPLETED),
            ],
        ])),
        requests: requests.clone(),
    };
    let mut core = Core::new();
    let started = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    let tool = Arc::new(WorkspaceTool::open(directory.path()).expect("workspace tool"));
    let workspace_read: Arc<dyn WorkspaceReadExecutor> = tool.clone();
    let workspace_list: Arc<dyn WorkspaceListExecutor> = tool;
    let (mut runtime, mut events) = CoreRuntime::new_with_workspace(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        Some(workspace_read),
        Some(workspace_list),
    );
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("List the workspace".to_string()),
        )
        .expect("start tool turn")
    else {
        panic!("asynchronous turn");
    };

    while !matches!(
        events.recv().await.expect("terminal event").kind,
        CoreEventKind::TurnCompleted { .. }
    ) {}

    let expected = serde_json::json!({
        "entries": [
            { "name": "Alpha.txt", "kind": "file" },
            { "name": "src", "kind": "directory" },
            { "name": "zeta.txt", "kind": "file" }
        ]
    });
    let requests = requests.lock().expect("requests");
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0]
            .tools
            .iter()
            .filter(|definition| definition.name.starts_with("workspace/"))
            .map(|definition| definition.name.as_str())
            .collect::<Vec<_>>(),
        vec!["workspace/read", "workspace/list"]
    );
    assert!(
        requests[1]
            .tools
            .iter()
            .any(|tool| tool.name == "workspace/list")
    );
    let results = message_tool_results(requests[1].messages.last().expect("result message"));
    assert_eq!(results.len(), 1);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&tool_result_serialized(results[0]))
            .expect("list JSON"),
        expected
    );
    drop(requests);

    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.id == turn_id)
        .expect("persisted tool turn");
    assert_eq!(turn.status, DurableTurnStatus::Completed);
    assert!(matches!(
        turn.items.as_slice(),
        [
            sugarcode_state::DurableItemSnapshot::UserMessage { .. },
            sugarcode_state::DurableItemSnapshot::ToolCall { name, arguments, .. },
            sugarcode_state::DurableItemSnapshot::ToolResult {
                result: sugarcode_state::DurableToolResult::Success { content, .. },
                ..
            },
            sugarcode_state::DurableItemSnapshot::AgentMessage { text, .. }
        ] if name == "workspace/list"
            && arguments.get("path").and_then(serde_json::Value::as_str) == Some(".")
            && serde_json::from_str::<serde_json::Value>(content).expect("durable list JSON") == expected
            && text == "I listed it."
    ));
}

#[tokio::test]
async fn serialized_tool_result_limit_becomes_one_durable_error_result() {
    let directory = tempfile::tempdir().expect("workspace");
    std::fs::write(
        directory.path().join("escaped.txt"),
        vec![1u8; sugarcode_tools::MAX_WORKSPACE_READ_BYTES],
    )
    .expect("workspace fixture");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([
            vec![
                Ok(model_event::tool_call(ModelToolCall {
                    id: "call_escaped".to_string(),
                    name: "workspace/read".to_string(),
                    arguments: serde_json::json!({ "path": "escaped.txt" }),
                })),
                Ok(model_event::COMPLETED),
            ],
            vec![
                Ok(model_event::text_delta(
                    "The result was bounded.".to_string(),
                )),
                Ok(model_event::COMPLETED),
            ],
        ])),
        requests: requests.clone(),
    };
    let mut core = Core::new();
    let started = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    let tool = Arc::new(WorkspaceTool::open(directory.path()).expect("workspace tool"));
    let (mut runtime, mut events) = CoreRuntime::new_with_workspace(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        Some(tool),
        None,
    );
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Read the file".to_string()),
        )
        .expect("start tool turn")
    else {
        panic!("asynchronous turn");
    };
    while !matches!(
        events.recv().await.expect("terminal event").kind,
        CoreEventKind::TurnCompleted { .. }
    ) {}

    let requests = requests.lock().expect("requests");
    let results = message_tool_results(requests[1].messages.last().expect("result message"));
    assert_eq!(results.len(), 1);
    assert_eq!(
        tool_result_serialized(results[0]),
        "workspace/read error: resultTooLarge"
    );
    drop(requests);
    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.id == turn_id)
        .expect("persisted turn");
    assert!(turn.items.iter().any(|item| matches!(
        item,
        sugarcode_state::DurableItemSnapshot::ToolResult {
            result: sugarcode_state::DurableToolResult::Error {
                kind,
            },
            ..
        } if kind == "resultTooLarge"
    )));
}

#[tokio::test]
async fn unknown_tool_calls_return_model_visible_errors_without_execution() {
    for rounds in [VecDeque::from([
        vec![
            Ok(model_event::tool_call(ModelToolCall {
                id: "call_unknown".to_string(),
                name: "workspace/unknown".to_string(),
                arguments: serde_json::json!({ "path": "README.txt" }),
            })),
            Ok(model_event::COMPLETED),
        ],
        vec![
            Ok(model_event::text_delta(
                "Recovered from the tool error.".to_string(),
            )),
            Ok(model_event::COMPLETED),
        ],
    ])] {
        let directory = tempfile::tempdir().expect("workspace");
        std::fs::write(directory.path().join("README.txt"), "bounded context")
            .expect("workspace fixture");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let provider = SequencedProvider {
            rounds: Mutex::new(rounds),
            requests: requests.clone(),
        };
        let mut core = Core::new();
        let started = core
            .start_thread(CoreRequestId::new(1))
            .expect("start thread");
        let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
            panic!("thread event");
        };
        let tool = Arc::new(WorkspaceTool::open(directory.path()).expect("workspace tool"));
        let (mut runtime, mut events) = CoreRuntime::new_with_workspace(
            core,
            Arc::new(provider),
            "fixture-model".to_string(),
            Some(tool),
            None,
        );
        let TurnStartOutcome::Accepted { turn_id } = runtime
            .start_text_turn(
                CoreRequestId::new(2),
                thread_id.clone(),
                Some("Read it".to_string()),
            )
            .expect("start tool turn")
        else {
            panic!("asynchronous turn");
        };
        while !matches!(
            events.recv().await.expect("terminal event").kind,
            CoreEventKind::TurnCompleted { .. }
        ) {}
        let requests = requests.lock().expect("requests");
        assert_eq!(requests.len(), 2);
        let results = message_tool_results(requests[1].messages.last().expect("result message"));
        assert_eq!(results.len(), 1);
        let content = tool_result_serialized(results[0]);
        assert!(content.contains("unknownTool"));
        assert!(content.contains("\"argumentsBytes\":"));
        assert!(content.contains("\"argumentsSha256\":"));
        drop(requests);
        let snapshot = runtime.resume_thread(&thread_id).expect("resume");
        let turn = snapshot
            .turns
            .iter()
            .find(|turn| turn.id == turn_id)
            .expect("persisted turn");
        assert_eq!(turn.status, DurableTurnStatus::Completed);
        assert!(turn.error.is_none());
        assert!(turn.items.iter().any(|item| matches!(
            item,
            sugarcode_state::DurableItemSnapshot::ToolValidationRejected { kind, .. }
                if kind == "unknownTool"
        )));
    }
}

#[tokio::test]
async fn invalid_tool_batch_is_rejected_without_partial_execution() {
    let directory = tempfile::tempdir().expect("workspace");
    std::fs::write(directory.path().join("README.txt"), "must not be read")
        .expect("workspace fixture");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([
            vec![Ok(model_event::tool_call_batch(vec![
                ModelToolCall {
                    id: "call_valid".to_string(),
                    name: "workspace/read".to_string(),
                    arguments: serde_json::json!({"path": "README.txt"}),
                },
                ModelToolCall {
                    id: "call_invalid".to_string(),
                    name: "workspace/read".to_string(),
                    arguments: serde_json::json!({}),
                },
            ]))],
            vec![Ok(model_event::tool_call(ModelToolCall {
                id: "call_retry".to_string(),
                name: "workspace/read".to_string(),
                arguments: serde_json::json!({"path": "README.txt"}),
            }))],
            vec![Ok(model_event::final_response(
                "Regenerated after batch rejection.",
            ))],
        ])),
        requests: Arc::clone(&requests),
    };
    let mut core = Core::new();
    let CoreEventKind::ThreadStarted { thread_id } = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread")
        .kind
    else {
        panic!("thread event");
    };
    let tool = Arc::new(WorkspaceTool::open(directory.path()).expect("workspace tool"));
    let (mut runtime, mut events) = CoreRuntime::new_with_workspace(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        Some(tool),
        None,
    );
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Read safely".to_string()),
        )
        .expect("start turn")
    else {
        panic!("async turn");
    };
    while !matches!(
        events.recv().await.expect("terminal").kind,
        CoreEventKind::TurnCompleted { .. }
    ) {}

    let requests = requests.lock().expect("requests");
    assert_eq!(requests.len(), 3);
    let results = requests[1]
        .messages
        .iter()
        .flat_map(message_tool_results)
        .map(tool_result_serialized)
        .collect::<Vec<_>>();
    assert_eq!(results.len(), 2);
    assert!(results[0].contains("batchRejected"));
    assert!(results[1].contains("invalidArguments"));
    assert!(
        !results
            .iter()
            .any(|result| result.contains("must not be read"))
    );
    drop(requests);

    let turn = runtime
        .resume_thread(&thread_id)
        .expect("resume")
        .turns
        .into_iter()
        .find(|turn| turn.id == turn_id)
        .expect("turn");
    let error_kinds = turn
        .items
        .iter()
        .filter_map(|item| match item {
            sugarcode_state::DurableItemSnapshot::ToolValidationRejected { kind, .. } => {
                Some(kind.as_str())
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(error_kinds, ["batchRejected", "invalidArguments"]);
}

#[tokio::test]
async fn invalid_workspace_edit_requires_a_corrected_edit_before_finalizing() {
    use sha2::Digest;

    let directory = tempfile::tempdir().expect("workspace");
    let target = directory.path().join("notes.txt");
    std::fs::write(&target, "old\n").expect("workspace fixture");
    let base_sha256 = format!("{:x}", sha2::Sha256::digest(b"old\n"));
    let line_edit = serde_json::json!({
        "startLine": 1,
        "deleteLineCount": 1,
        "expected": "old",
        "replacement": "new"
    });
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([
            vec![Ok(model_event::tool_call(ModelToolCall {
                id: "call_invalid_edit".to_string(),
                name: "workspace/edit".to_string(),
                arguments: serde_json::json!({
                    "operations": [{
                        "type": "update",
                        "path": "notes.txt",
                        "edits": [line_edit.clone()]
                    }]
                }),
            }))],
            vec![Ok(model_event::final_response(
                "Let me re-read the current files to make precise edits:",
            ))],
            vec![Ok(model_event::tool_call(ModelToolCall {
                id: "call_corrected_edit".to_string(),
                name: "workspace/edit".to_string(),
                arguments: serde_json::json!({
                    "operations": [{
                        "type": "update",
                        "path": "notes.txt",
                        "baseSha256": base_sha256,
                        "edits": [line_edit]
                    }]
                }),
            }))],
            vec![Ok(model_event::final_response(
                "The edit was applied and verified.",
            ))],
        ])),
        requests: Arc::clone(&requests),
    };
    let mut core = Core::new();
    let CoreEventKind::ThreadStarted { thread_id } = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread")
        .kind
    else {
        panic!("thread event");
    };
    let tool = Arc::new(WorkspaceTool::open(directory.path()).expect("workspace tool"));
    let workspace_patch: Arc<dyn WorkspacePatchExecutor> = tool;
    let (runtime, mut events) = CoreRuntime::new_with_workspace(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        None,
        None,
    );
    let mut runtime = runtime.with_workspace_patch(Some(workspace_patch));
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Fix notes.txt".to_string()),
        )
        .expect("start turn")
    else {
        panic!("async turn");
    };
    let mut discarded = false;
    loop {
        let event = events.recv().await.expect("terminal");
        discarded |= matches!(event.kind, CoreEventKind::AgentOutputDiscarded { .. });
        if matches!(event.kind, CoreEventKind::TurnCompleted { .. }) {
            break;
        }
    }

    assert!(discarded);
    assert_eq!(
        std::fs::read_to_string(target).expect("edited file"),
        "new\n"
    );
    let requests = requests.lock().expect("requests");
    assert_eq!(requests.len(), 4);
    let correction = requests[1]
        .messages
        .iter()
        .flat_map(message_tool_results)
        .map(tool_result_serialized)
        .find(|content| content.contains("\"tool\":\"workspace/edit\""))
        .expect("workspace/edit correction");
    assert!(correction.contains("\"fieldPath\":\"$.operations[0].baseSha256\""));
    assert!(correction.contains("\"reason\":\"missingRequiredField\""));
    assert!(correction.contains("readFileAndUseReturnedSha256"));
    drop(requests);

    let turn = runtime
        .resume_thread(&thread_id)
        .expect("resume")
        .turns
        .into_iter()
        .find(|turn| turn.id == turn_id)
        .expect("turn");
    assert_eq!(turn.status, DurableTurnStatus::Completed);
    assert!(!turn.items.iter().any(|item| matches!(
        item,
        sugarcode_state::DurableItemSnapshot::AgentMessage { text, .. }
            if text.contains("Let me re-read")
    )));
}

#[tokio::test]
async fn repeated_structural_argument_errors_end_with_explicit_terminal_kind() {
    let invalid_round = |id: &str, arguments: serde_json::Value| {
        vec![Ok(model_event::tool_call(ModelToolCall {
            id: id.to_string(),
            name: "workspace/read".to_string(),
            arguments,
        }))]
    };
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([
            invalid_round("call_invalid_1", serde_json::json!({})),
            invalid_round("call_invalid_2", serde_json::json!({ "path": 7 })),
            invalid_round("call_invalid_3", serde_json::json!({ "path": false })),
            invalid_round("call_invalid_4", serde_json::json!({ "path": null })),
        ])),
        requests: Arc::new(Mutex::new(Vec::new())),
    };
    let mut core = Core::new();
    let CoreEventKind::ThreadStarted { thread_id } = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread")
        .kind
    else {
        panic!("thread event");
    };
    let directory = tempfile::tempdir().expect("workspace");
    let tool = Arc::new(WorkspaceTool::open(directory.path()).expect("workspace tool"));
    let (mut runtime, mut events) = CoreRuntime::new_with_workspace(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        Some(tool),
        None,
    );
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Read".to_string()),
        )
        .expect("start turn")
    else {
        panic!("async turn");
    };
    while !matches!(
        events.recv().await.expect("terminal").kind,
        CoreEventKind::TurnFailed { .. }
    ) {}

    let turn = runtime
        .resume_thread(&thread_id)
        .expect("resume")
        .turns
        .into_iter()
        .find(|turn| turn.id == turn_id)
        .expect("turn");
    assert_eq!(
        turn.error.map(|error| error.kind),
        Some(DurableTurnErrorKind::UnsupportedToolArguments)
    );
}

#[tokio::test]
async fn read_only_tool_batch_is_not_limited_by_item_count() {
    let calls = (0..32)
        .map(|index| ModelToolCall {
            id: format!("call_{index}"),
            name: "workspace/read".to_string(),
            arguments: serde_json::json!({ "path": "README.txt" }),
        })
        .collect();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([
            vec![Ok(model_event::tool_call_batch(calls))],
            vec![
                Ok(model_event::text_delta("Reviewed.".to_string())),
                Ok(model_event::COMPLETED),
            ],
        ])),
        requests: requests.clone(),
    };
    let mut core = Core::new();
    let started = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    let directory = tempfile::tempdir().expect("workspace");
    std::fs::write(directory.path().join("README.txt"), "bounded context")
        .expect("workspace fixture");
    let tool = Arc::new(WorkspaceTool::open(directory.path()).expect("workspace tool"));
    let (mut runtime, mut events) = CoreRuntime::new_with_workspace(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        Some(tool),
        None,
    );
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Review it".to_string()),
        )
        .expect("start text turn")
    else {
        panic!("asynchronous turn");
    };
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !matches!(
            events.recv().await.expect("terminal event").kind,
            CoreEventKind::TurnCompleted { .. }
        ) {}
    })
    .await
    .expect("read-only calls must complete with bounded execution concurrency");
    assert_eq!(requests.lock().expect("requests").len(), 2);
    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.id == turn_id)
        .expect("persisted turn");
    assert_eq!(turn.status, DurableTurnStatus::Completed);
}

#[tokio::test]
async fn duplicate_call_id_across_provider_rounds_is_unsupported_output() {
    let directory = tempfile::tempdir().expect("workspace");
    std::fs::write(directory.path().join("README.txt"), "bounded context")
        .expect("workspace fixture");
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([
            vec![
                Ok(model_event::tool_call(ModelToolCall {
                    id: "call_duplicate".to_string(),
                    name: "workspace/read".to_string(),
                    arguments: serde_json::json!({ "path": "README.txt" }),
                })),
                Ok(model_event::COMPLETED),
            ],
            vec![
                Ok(model_event::tool_call(ModelToolCall {
                    id: "call_duplicate".to_string(),
                    name: "workspace/read".to_string(),
                    arguments: serde_json::json!({ "path": "README.txt" }),
                })),
                Ok(model_event::COMPLETED),
            ],
        ])),
        requests: Arc::new(Mutex::new(Vec::new())),
    };
    let mut core = Core::new();
    let started = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    let tool = Arc::new(WorkspaceTool::open(directory.path()).expect("workspace tool"));
    let (mut runtime, mut events) = CoreRuntime::new_with_workspace(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        Some(tool),
        None,
    );
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Read it twice".to_string()),
        )
        .expect("start text turn")
    else {
        panic!("asynchronous turn");
    };
    while !matches!(
        events.recv().await.expect("terminal event").kind,
        CoreEventKind::TurnFailed { .. }
    ) {}
    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.id == turn_id)
        .expect("persisted turn");
    assert_eq!(
        turn.error.as_ref().map(|error| error.kind),
        Some(DurableTurnErrorKind::UnsupportedOutput)
    );
}

#[tokio::test]
async fn twenty_lightweight_local_calls_continue_in_one_turn_before_final_text() {
    let mut rounds = VecDeque::new();
    for index in 0..20 {
        rounds.push_back(vec![
            Ok(model_event::tool_call(ModelToolCall {
                id: format!("call_{index}"),
                name: "workspace/read".to_string(),
                arguments: serde_json::json!({ "path": "README.txt" }),
            })),
            Ok(model_event::COMPLETED),
        ]);
    }
    rounds.push_back(vec![
        Ok(model_event::text_delta(
            "Verified after twenty reads.".to_string(),
        )),
        Ok(model_event::COMPLETED),
    ]);
    let directory = tempfile::tempdir().expect("workspace");
    std::fs::write(directory.path().join("README.txt"), "bounded context")
        .expect("workspace fixture");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = SequencedProvider {
        rounds: Mutex::new(rounds),
        requests: requests.clone(),
    };
    let mut core = Core::new();
    let started = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    let tool = Arc::new(WorkspaceTool::open(directory.path()).expect("workspace tool"));
    let (mut runtime, mut events) = CoreRuntime::new_with_workspace(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        Some(tool),
        None,
    );
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Keep reading until verified".to_string()),
        )
        .expect("start turn")
    else {
        panic!("asynchronous turn");
    };
    while !matches!(
        events.recv().await.expect("terminal event").kind,
        CoreEventKind::TurnCompleted { .. }
    ) {}
    assert_eq!(requests.lock().expect("requests").len(), 21);
    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.id == turn_id)
        .expect("persisted turn");
    assert_eq!(turn.status, DurableTurnStatus::Completed);
    assert_eq!(
        turn.items
            .iter()
            .filter(|item| matches!(
                item,
                sugarcode_state::DurableItemSnapshot::ToolResult { .. }
            ))
            .count(),
        20
    );
}

#[tokio::test]
async fn active_turn_context_compacts_without_tools_and_continues_the_same_turn() {
    #[derive(Debug)]
    struct CompactionAwareProvider {
        calls: AtomicUsize,
        requests: Arc<Mutex<Vec<ModelRequest>>>,
    }
    impl ModelProvider for CompactionAwareProvider {
        fn stream(&self, request: ModelRequest) -> BoxModelFuture<'_> {
            let compaction = request.tools.is_empty();
            self.requests.lock().expect("requests").push(request);
            let call = self.calls.load(Ordering::Acquire);
            let events = if compaction {
                let text = "The user asked to inspect large.txt. Prior reads succeeded; continue with the final answer.";
                vec![
                    Ok(model_event::text_delta(text.to_string())),
                    Ok(ModelEvent::ResponseCompleted(ModelResponse {
                        output: vec![sugarcode_model_provider::ModelOutputItem {
                            output_index: 0,
                            kind: ModelOutputItemKind::AssistantText {
                                phase: ModelTextPhase::Final,
                                text: text.to_string(),
                            },
                        }],
                        usage: Some(ModelUsage {
                            input_tokens: Some(10),
                            cached_input_tokens: None,
                            output_tokens: Some(5),
                            reasoning_output_tokens: None,
                            total_tokens: Some(15),
                        }),
                        terminal: ModelTerminalMetadata::completed(ModelContinuation::Complete),
                        provider_context: None,
                    })),
                ]
            } else if call < 13 {
                self.calls.fetch_add(1, Ordering::AcqRel);
                vec![Ok(model_event::tool_call(ModelToolCall {
                    id: format!("large_call_{call}"),
                    name: "workspace/read".to_string(),
                    arguments: serde_json::json!({ "path": "large.txt" }),
                }))]
            } else {
                let text = "Large file inspection completed.";
                vec![
                    Ok(model_event::text_delta(text.to_string())),
                    Ok(ModelEvent::ResponseCompleted(ModelResponse {
                        output: vec![sugarcode_model_provider::ModelOutputItem {
                            output_index: 0,
                            kind: ModelOutputItemKind::AssistantText {
                                phase: ModelTextPhase::Final,
                                text: text.to_string(),
                            },
                        }],
                        usage: None,
                        terminal: ModelTerminalMetadata::completed(ModelContinuation::Complete),
                        provider_context: None,
                    })),
                ]
            };
            async move { Ok(stream::iter(events).boxed()) }.boxed()
        }
    }
    let directory = tempfile::tempdir().expect("workspace");
    std::fs::write(
        directory.path().join("large.txt"),
        vec![b'a'; crate::context::COMPACTION_TARGET_BYTES / 12],
    )
    .expect("large workspace fixture");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = CompactionAwareProvider {
        calls: AtomicUsize::new(0),
        requests: requests.clone(),
    };
    let mut core = Core::new();
    let started = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    let tool = Arc::new(WorkspaceTool::open(directory.path()).expect("workspace tool"));
    let (mut runtime, mut events) = CoreRuntime::new_with_workspace(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        Some(tool),
        None,
    );
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Inspect the large file completely".to_string()),
        )
        .expect("start turn")
    else {
        panic!("asynchronous turn");
    };
    let mut compaction_started = 0;
    let mut compaction_completed = 0;
    loop {
        match events.recv().await.expect("turn event").kind {
            CoreEventKind::ItemStarted {
                item:
                    CoreItemSnapshot {
                        kind: CoreItemKind::ContextCompaction { outcome: None, .. },
                        ..
                    },
                ..
            } => compaction_started += 1,
            CoreEventKind::ItemCompleted {
                item:
                    CoreItemSnapshot {
                        kind:
                            CoreItemKind::ContextCompaction {
                                outcome: Some(CoreContextCompactionOutcome::Completed { .. }),
                                ..
                            },
                        ..
                    },
                ..
            } => compaction_completed += 1,
            CoreEventKind::TurnCompleted { .. } => break,
            _ => {}
        }
    }
    assert_eq!((compaction_started, compaction_completed), (1, 1));
    {
        let recorded_requests = requests.lock().expect("requests");
        assert_eq!(recorded_requests.len(), 15);
        assert!(
            recorded_requests
                .iter()
                .filter(|request| !request.tools.is_empty())
                .all(|request| {
                    request.estimated_context_tokens()
                        <= u64::from(
                            ModelCapabilities::new(131_072, true, false, false, true, true)
                                .active_turn_compaction_target_tokens(),
                        )
                })
        );
        let compaction_index = recorded_requests
            .iter()
            .position(|request| request.tools.is_empty())
            .expect("compaction request");
        let compaction_request = &recorded_requests[compaction_index];
        assert!(compaction_request.tools.is_empty());
        assert_eq!(
            compaction_request
                .instructions
                .last()
                .map(|item| item.source),
            Some(ModelInstructionSource::SugarCodeActiveTurnCompactionV1)
        );
        assert!(
            compaction_request.context_bytes()
                <= ModelCapabilities::new(131_072, true, false, false, true, true)
                    .input_compaction_target_bytes()
        );
        assert!(
            recorded_requests[compaction_index + 1]
                .tools
                .iter()
                .any(|tool| tool.name == "workspace/read")
        );
        assert!(
            recorded_requests[compaction_index + 1]
                .messages
                .first()
                .and_then(message_compaction)
                .is_some_and(|checkpoint| {
                    checkpoint.contains("Inspect the large file completely")
                        && checkpoint.contains("Prior reads succeeded")
                        && checkpoint.contains("Continue executing the same user task")
                })
        );
    }
    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.id == turn_id)
        .expect("persisted turn");
    assert!(
        turn.items.iter().any(|item| matches!(
            item,
            sugarcode_state::DurableItemSnapshot::ContextCompaction {
                summary: Some(summary),
                outcome: Some(sugarcode_state::DurableActiveTurnCompactionOutcome::Completed { .. }),
                ..
            } if summary.contains("Prior reads succeeded")
        )),
        "{:?}",
        turn.items
    );
    assert_eq!(
        turn.usage.as_ref().and_then(|usage| usage.total_tokens),
        Some(15)
    );
    let debug = format!("{turn:?}");
    assert!(!debug.contains("Prior reads succeeded"));
    assert!(debug.contains("DurableCompactionSummary"));
    runtime
        .start_text_turn(
            CoreRequestId::new(3),
            thread_id,
            Some("Confirm the durable checkpoint is reused".to_string()),
        )
        .expect("start turn after compaction");
    while !matches!(
        events.recv().await.expect("next turn event").kind,
        CoreEventKind::TurnCompleted { .. }
    ) {}
    let requests = requests.lock().expect("requests");
    assert_eq!(requests.len(), 16);
    assert!(
        requests[15]
            .messages
            .first()
            .and_then(message_compaction)
            .is_some_and(|content| content.contains("Prior reads succeeded"))
    );
    assert!(
        requests[15].estimated_context_tokens()
            < u64::from(
                ModelCapabilities::new(131_072, true, false, false, true, true)
                    .active_turn_compaction_target_tokens(),
            )
    );
}

#[tokio::test]
async fn large_private_continuation_and_cumulative_usage_do_not_fake_context_overflow() {
    #[derive(Debug)]
    struct ContinuationProvider {
        calls: AtomicUsize,
        requests: Arc<Mutex<Vec<ModelRequest>>>,
    }

    impl ModelProvider for ContinuationProvider {
        fn stream(&self, request: ModelRequest) -> BoxModelFuture<'_> {
            let call = self.calls.fetch_add(1, Ordering::AcqRel);
            self.requests.lock().expect("requests").push(request);
            let events = if call == 0 {
                let context =
                    sugarcode_model_provider::ProviderContextEnvelope::new_with_replay_tokens(
                        sugarcode_model_provider::ProviderWireApi::OpenAiResponses,
                        Some("response_large_continuation".to_string()),
                        vec![0x6b; 1024 * 1024],
                        Some(1_000),
                    )
                    .expect("large private continuation");
                assert!(context.is_spilled());
                vec![Ok(ModelEvent::ResponseCompleted(ModelResponse {
                    output: vec![
                        sugarcode_model_provider::ModelOutputItem {
                            output_index: 0,
                            kind: ModelOutputItemKind::ToolCall(ModelToolCall {
                                id: "read_a".to_string(),
                                name: "workspace/read".to_string(),
                                arguments: serde_json::json!({"path": "a.txt"}),
                            }),
                        },
                        sugarcode_model_provider::ModelOutputItem {
                            output_index: 1,
                            kind: ModelOutputItemKind::ToolCall(ModelToolCall {
                                id: "read_b".to_string(),
                                name: "workspace/read".to_string(),
                                arguments: serde_json::json!({"path": "b.txt"}),
                            }),
                        },
                    ],
                    usage: Some(ModelUsage {
                        input_tokens: Some(60_000),
                        cached_input_tokens: Some(55_000),
                        output_tokens: Some(1_000),
                        reasoning_output_tokens: Some(900),
                        total_tokens: Some(61_000),
                    }),
                    terminal: ModelTerminalMetadata::completed(ModelContinuation::ToolCalls),
                    provider_context: Some(Box::new(context)),
                }))]
            } else {
                vec![Ok(ModelEvent::ResponseCompleted(ModelResponse {
                    output: vec![sugarcode_model_provider::ModelOutputItem {
                        output_index: 0,
                        kind: ModelOutputItemKind::AssistantText {
                            phase: ModelTextPhase::Final,
                            text: "Both files were read; the requested task is complete."
                                .to_string(),
                        },
                    }],
                    usage: Some(ModelUsage {
                        input_tokens: Some(115_318),
                        cached_input_tokens: Some(110_000),
                        output_tokens: Some(426),
                        reasoning_output_tokens: Some(300),
                        total_tokens: Some(115_744),
                    }),
                    terminal: ModelTerminalMetadata::completed(ModelContinuation::Complete),
                    provider_context: None,
                }))]
            };
            async move { Ok(stream::iter(events).boxed()) }.boxed()
        }
    }

    struct TwoHundredKResolver {
        provider: Arc<dyn ModelProvider>,
    }

    impl ModelResolver for TwoHundredKResolver {
        fn resolve(&self, _: Option<&str>) -> Result<ResolvedModel, ModelError> {
            Ok(ResolvedModel {
                provider: self.provider.clone(),
                model: "fixture-model".to_string(),
                profile_id: "fixture".to_string(),
                provider_family: "openai".to_string(),
                wire_api: "openaiResponses".to_string(),
                display_name: "Fixture 200K".to_string(),
                capabilities: ModelCapabilities::new(200_000, true, true, true, true, true),
            })
        }
    }

    let directory = tempfile::tempdir().expect("workspace");
    std::fs::write(directory.path().join("a.txt"), "alpha").expect("a fixture");
    std::fs::write(directory.path().join("b.txt"), "beta").expect("b fixture");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = Arc::new(ContinuationProvider {
        calls: AtomicUsize::new(0),
        requests: requests.clone(),
    });
    let mut core = Core::new();
    let CoreEventKind::ThreadStarted { thread_id } = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread")
        .kind
    else {
        panic!("thread event");
    };
    let tool = Arc::new(WorkspaceTool::open(directory.path()).expect("workspace tool"));
    let (mut runtime, mut events) = CoreRuntime::new_with_model_resolver(
        core,
        Arc::new(TwoHundredKResolver { provider }),
        Some(tool),
        None,
        None,
    );
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Read both files and finish the task.".to_string()),
        )
        .expect("start turn")
    else {
        panic!("asynchronous turn");
    };
    while !matches!(
        events.recv().await.expect("turn event").kind,
        CoreEventKind::TurnCompleted { .. }
    ) {}

    let recorded = requests.lock().expect("requests");
    assert_eq!(recorded.len(), 2);
    assert_eq!(recorded[1].provider_context_bytes(), 1024 * 1024);
    assert!(recorded[1].estimated_context_tokens() < 150_000);
    drop(recorded);
    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.id == turn_id)
        .expect("turn");
    assert_eq!(turn.status, DurableTurnStatus::Completed);
    assert!(turn.context_compaction.is_none());
    let usage = turn.usage.as_ref().expect("usage");
    assert_eq!(usage.input_tokens, Some(175_318));
    assert_eq!(
        usage.last_request.and_then(|sample| sample.input_tokens),
        Some(115_318)
    );
    assert_eq!(usage.request_count, 2);
    assert_eq!(usage.context_window_tokens, Some(200_000));
}

#[tokio::test]
async fn non_shrinking_context_compaction_fails_without_a_retry_loop() {
    #[derive(Debug)]
    struct ContextRejectingProvider {
        calls: AtomicUsize,
        requests: Arc<Mutex<Vec<ModelRequest>>>,
    }

    impl ModelProvider for ContextRejectingProvider {
        fn stream(&self, request: ModelRequest) -> BoxModelFuture<'_> {
            let call = self.calls.fetch_add(1, Ordering::AcqRel);
            self.requests
                .lock()
                .expect("requests")
                .push(request.clone());
            async move {
                match call {
                    0 => Ok(stream::iter(vec![Ok(model_event::tool_call(ModelToolCall {
                        id: "context_call".to_string(),
                        name: "workspace/read".to_string(),
                        arguments: serde_json::json!({ "path": "context.txt" }),
                    }))])
                    .boxed()),
                    1 => Err(ModelError::new(ModelErrorKind::InvalidRequest, false)),
                    2 => Ok(stream::iter(vec![Ok(model_event::final_response(
                        "The task and successful read must be preserved.",
                    ))])
                    .boxed()),
                    _ => panic!("unexpected provider request"),
                }
            }
            .boxed()
        }
    }

    let directory = tempfile::tempdir().expect("workspace");
    std::fs::write(
        directory.path().join("context.txt"),
        "context that makes the follow-up request larger",
    )
    .expect("workspace fixture");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = ContextRejectingProvider {
        calls: AtomicUsize::new(0),
        requests: requests.clone(),
    };
    let mut core = Core::new();
    let started = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    let tool = Arc::new(WorkspaceTool::open(directory.path()).expect("workspace tool"));
    let (mut runtime, mut events) = CoreRuntime::new_with_workspace(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        Some(tool),
        None,
    );
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Read context.txt and finish the task".to_string()),
        )
        .expect("start turn")
    else {
        panic!("asynchronous turn");
    };
    while !matches!(
        events.recv().await.expect("turn event").kind,
        CoreEventKind::TurnFailed { .. }
    ) {}

    let recorded_requests = requests.lock().expect("requests");
    assert_eq!(recorded_requests.len(), 3);
    assert!(recorded_requests[1].context_bytes() > recorded_requests[0].context_bytes());
    assert!(recorded_requests[2].tools.is_empty());
    drop(recorded_requests);

    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.id == turn_id)
        .expect("persisted turn");
    assert_eq!(turn.status, DurableTurnStatus::Failed);
    assert_eq!(
        turn.error.as_ref().map(|error| error.kind),
        Some(DurableTurnErrorKind::ContextWindowExceeded)
    );
    assert!(turn.items.iter().any(|item| matches!(
        item,
        sugarcode_state::DurableItemSnapshot::ContextCompaction {
            outcome: Some(sugarcode_state::DurableActiveTurnCompactionOutcome::Failed { .. }),
            ..
        }
    )));
    assert!(!turn.items.iter().any(|item| matches!(
        item,
        sugarcode_state::DurableItemSnapshot::AgentMessage { .. }
    )));
}

#[tokio::test]
async fn interrupt_after_tool_call_persists_no_tool_result() {
    let (entered_tx, entered_rx) = oneshot::channel();
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([
            vec![
                Ok(model_event::tool_call(ModelToolCall {
                    id: "call_cancel".to_string(),
                    name: "workspace/read".to_string(),
                    arguments: serde_json::json!({ "path": "blocked.txt" }),
                })),
                Ok(model_event::COMPLETED),
            ],
            Vec::new(),
        ])),
        requests: Arc::new(Mutex::new(Vec::new())),
    };
    let mut core = Core::new();
    let started = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    let tool: Arc<dyn WorkspaceReadExecutor> = Arc::new(BlockingWorkspaceRead {
        entered: Mutex::new(Some(entered_tx)),
    });
    let (mut runtime, mut events) = CoreRuntime::new_with_workspace(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        Some(tool),
        None,
    );
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Read it".to_string()),
        )
        .expect("start tool turn")
    else {
        panic!("asynchronous turn");
    };
    loop {
        let event = events.recv().await.expect("tool call event");
        if matches!(
            event.kind,
            CoreEventKind::ItemCompleted {
                item: CoreItemSnapshot {
                    kind: CoreItemKind::ToolCall { .. },
                    ..
                },
                ..
            }
        ) {
            break;
        }
    }
    entered_rx.await.expect("tool execution entered");
    assert_eq!(
        runtime
            .interrupt_turn(&thread_id, &turn_id)
            .expect("interrupt"),
        TurnInterruptOutcome::Accepted
    );
    loop {
        let event = events.recv().await.expect("terminal event");
        if matches!(event.kind, CoreEventKind::TurnInterrupted { .. }) {
            break;
        }
    }
    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.id == turn_id)
        .expect("persisted turn");
    assert_eq!(turn.status, DurableTurnStatus::Interrupted);
    assert!(matches!(
        turn.items.last(),
        Some(sugarcode_state::DurableItemSnapshot::ToolCall { .. })
    ));
    assert!(!turn.items.iter().any(|item| matches!(
        item,
        sugarcode_state::DurableItemSnapshot::ToolResult { .. }
    )));
}

#[tokio::test]
async fn interrupt_during_second_round_keeps_durable_tool_result_for_audit_only() {
    let directory = tempfile::tempdir().expect("workspace");
    std::fs::write(directory.path().join("README.txt"), "bounded context")
        .expect("workspace fixture");
    let (second_entered_tx, second_entered_rx) = oneshot::channel();
    let provider = BlockingSecondRoundProvider {
        calls: AtomicUsize::new(0),
        second_entered: Mutex::new(Some(second_entered_tx)),
    };
    let mut core = Core::new();
    let started = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    let tool = Arc::new(WorkspaceTool::open(directory.path()).expect("workspace tool"));
    let (mut runtime, mut events) = CoreRuntime::new_with_workspace(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        Some(tool),
        None,
    );
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Read it".to_string()),
        )
        .expect("start tool turn")
    else {
        panic!("asynchronous turn");
    };
    second_entered_rx.await.expect("second round entered");
    assert_eq!(
        runtime
            .interrupt_turn(&thread_id, &turn_id)
            .expect("interrupt"),
        TurnInterruptOutcome::Accepted
    );
    while !matches!(
        events.recv().await.expect("terminal event").kind,
        CoreEventKind::TurnInterrupted { .. }
    ) {}
    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.id == turn_id)
        .expect("persisted turn");
    assert_eq!(turn.status, DurableTurnStatus::Interrupted);
    assert!(turn.items.iter().any(|item| matches!(
        item,
        sugarcode_state::DurableItemSnapshot::ToolResult { .. }
    )));
}
