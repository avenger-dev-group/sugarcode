use super::*;

#[tokio::test]
async fn workspace_read_runs_one_durable_tool_round_before_the_final_answer() {
    let directory = tempfile::tempdir().expect("workspace");
    std::fs::write(directory.path().join("README.txt"), "bounded context")
        .expect("workspace fixture");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([
            vec![
                Ok(ModelEvent::ToolCall(ModelToolCall {
                    id: "call_1".to_string(),
                    name: "workspace/read".to_string(),
                    arguments: serde_json::json!({ "path": "README.txt" }),
                })),
                Ok(ModelEvent::Usage(ModelUsage {
                    input_tokens: Some(3),
                    cached_input_tokens: Some(1),
                    output_tokens: Some(2),
                    reasoning_output_tokens: Some(1),
                    total_tokens: Some(5),
                })),
                Ok(ModelEvent::Completed),
            ],
            vec![
                Ok(ModelEvent::TextDelta("I read it.".to_string())),
                Ok(ModelEvent::Usage(ModelUsage {
                    input_tokens: Some(7),
                    cached_input_tokens: Some(2),
                    output_tokens: Some(4),
                    reasoning_output_tokens: Some(2),
                    total_tokens: Some(11),
                })),
                Ok(ModelEvent::Completed),
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
    assert!(lifecycle.iter().any(|event| {
        matches!(
            &event.kind,
            CoreEventKind::ItemCompleted {
                item: CoreItemSnapshot {
                    kind: CoreItemKind::ToolCall { path, .. },
                    ..
                },
                ..
            } if path == "README.txt"
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
            } if content == "bounded context"
        )
    }));

    let requests = requests.lock().expect("requests");
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].tools.len(), 1);
    assert!(requests[1].tools.is_empty());
    assert!(matches!(
        requests[1].messages.as_slice(),
        [
            ModelMessage::Text { .. },
            ModelMessage::ToolCall(_),
            ModelMessage::ToolResult { content, .. }
        ] if content == "bounded context"
    ));
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
        ] if content == "bounded context" && text == "I read it."
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
                Ok(ModelEvent::ToolCall(ModelToolCall {
                    id: "call_list".to_string(),
                    name: "workspace/list".to_string(),
                    arguments: serde_json::json!({ "path": "." }),
                })),
                Ok(ModelEvent::Completed),
            ],
            vec![
                Ok(ModelEvent::TextDelta("I listed it.".to_string())),
                Ok(ModelEvent::Completed),
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
            .map(|definition| definition.name.as_str())
            .collect::<Vec<_>>(),
        vec!["workspace/read", "workspace/list"]
    );
    assert!(requests[1].tools.is_empty());
    assert!(matches!(
        requests[1].messages.last(),
        Some(ModelMessage::ToolResult { content, .. })
            if serde_json::from_str::<serde_json::Value>(content).expect("list JSON") == expected
    ));
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
            sugarcode_state::DurableItemSnapshot::ToolCall { name, path, .. },
            sugarcode_state::DurableItemSnapshot::ToolResult {
                result: sugarcode_state::DurableToolResult::Success { content, .. },
                ..
            },
            sugarcode_state::DurableItemSnapshot::AgentMessage { text, .. }
        ] if name == "workspace/list"
            && path == "."
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
                Ok(ModelEvent::ToolCall(ModelToolCall {
                    id: "call_escaped".to_string(),
                    name: "workspace/read".to_string(),
                    arguments: serde_json::json!({ "path": "escaped.txt" }),
                })),
                Ok(ModelEvent::Completed),
            ],
            vec![
                Ok(ModelEvent::TextDelta("The result was bounded.".to_string())),
                Ok(ModelEvent::Completed),
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
    assert!(matches!(
        requests[1].messages.last(),
        Some(ModelMessage::ToolResult { content, .. })
            if content == "workspace/read error: resultTooLarge"
    ));
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
async fn unknown_and_second_round_tool_calls_fail_without_extra_execution() {
    for (rounds, expected_requests) in [
        (
            VecDeque::from([vec![
                Ok(ModelEvent::ToolCall(ModelToolCall {
                    id: "call_unknown".to_string(),
                    name: "workspace/unknown".to_string(),
                    arguments: serde_json::json!({ "path": "README.txt" }),
                })),
                Ok(ModelEvent::Completed),
            ]]),
            1,
        ),
        (
            VecDeque::from([
                vec![
                    Ok(ModelEvent::ToolCall(ModelToolCall {
                        id: "call_1".to_string(),
                        name: "workspace/read".to_string(),
                        arguments: serde_json::json!({ "path": "README.txt" }),
                    })),
                    Ok(ModelEvent::Completed),
                ],
                vec![
                    Ok(ModelEvent::ToolCall(ModelToolCall {
                        id: "call_2".to_string(),
                        name: "workspace/read".to_string(),
                        arguments: serde_json::json!({ "path": "README.txt" }),
                    })),
                    Ok(ModelEvent::Completed),
                ],
            ]),
            2,
        ),
    ] {
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
            CoreEventKind::TurnFailed { .. }
        ) {}
        assert_eq!(requests.lock().expect("requests").len(), expected_requests);
        let snapshot = runtime.resume_thread(&thread_id).expect("resume");
        let turn = snapshot
            .turns
            .iter()
            .find(|turn| turn.id == turn_id)
            .expect("persisted turn");
        assert_eq!(turn.status, DurableTurnStatus::Failed);
        assert_eq!(
            turn.error.as_ref().map(|error| error.kind),
            Some(DurableTurnErrorKind::UnsupportedOutput)
        );
    }
}

#[tokio::test]
async fn interrupt_after_tool_call_persists_no_tool_result() {
    let (entered_tx, entered_rx) = oneshot::channel();
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([
            vec![
                Ok(ModelEvent::ToolCall(ModelToolCall {
                    id: "call_cancel".to_string(),
                    name: "workspace/read".to_string(),
                    arguments: serde_json::json!({ "path": "blocked.txt" }),
                })),
                Ok(ModelEvent::Completed),
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
