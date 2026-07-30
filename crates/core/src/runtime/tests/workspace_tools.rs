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
    assert!(
        requests[1]
            .tools
            .iter()
            .any(|tool| tool.name == "workspace/read")
    );
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
    assert!(
        requests[1]
            .tools
            .iter()
            .any(|tool| tool.name == "workspace/list")
    );
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
async fn unknown_tool_calls_fail_without_execution() {
    for rounds in [VecDeque::from([vec![
        Ok(ModelEvent::ToolCall(ModelToolCall {
            id: "call_unknown".to_string(),
            name: "workspace/unknown".to_string(),
            arguments: serde_json::json!({ "path": "README.txt" }),
        })),
        Ok(ModelEvent::Completed),
    ]])] {
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
        assert_eq!(requests.lock().expect("requests").len(), 1);
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
async fn multiple_calls_and_text_with_tool_are_unsupported_output() {
    let cases = [
        vec![
            Ok(ModelEvent::ToolCall(ModelToolCall {
                id: "call_first".to_string(),
                name: "workspace/read".to_string(),
                arguments: serde_json::json!({ "path": "README.txt" }),
            })),
            Ok(ModelEvent::ToolCall(ModelToolCall {
                id: "call_second".to_string(),
                name: "workspace/read".to_string(),
                arguments: serde_json::json!({ "path": "README.txt" }),
            })),
            Ok(ModelEvent::Completed),
        ],
        vec![
            Ok(ModelEvent::TextDelta("I will read it.".to_string())),
            Ok(ModelEvent::ToolCall(ModelToolCall {
                id: "call_after_text".to_string(),
                name: "workspace/read".to_string(),
                arguments: serde_json::json!({ "path": "README.txt" }),
            })),
            Ok(ModelEvent::Completed),
        ],
    ];
    for events_for_case in cases {
        let (mut runtime, mut events, thread_id) = runtime(RecordedProvider {
            events: events_for_case,
            stay_open: false,
        });
        let TurnStartOutcome::Accepted { turn_id } = runtime
            .start_text_turn(
                CoreRequestId::new(2),
                thread_id.clone(),
                Some("Read it".to_string()),
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
}

#[tokio::test]
async fn duplicate_call_id_across_provider_rounds_is_unsupported_output() {
    let directory = tempfile::tempdir().expect("workspace");
    std::fs::write(directory.path().join("README.txt"), "bounded context")
        .expect("workspace fixture");
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([
            vec![
                Ok(ModelEvent::ToolCall(ModelToolCall {
                    id: "call_duplicate".to_string(),
                    name: "workspace/read".to_string(),
                    arguments: serde_json::json!({ "path": "README.txt" }),
                })),
                Ok(ModelEvent::Completed),
            ],
            vec![
                Ok(ModelEvent::ToolCall(ModelToolCall {
                    id: "call_duplicate".to_string(),
                    name: "workspace/read".to_string(),
                    arguments: serde_json::json!({ "path": "README.txt" }),
                })),
                Ok(ModelEvent::Completed),
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
            Ok(ModelEvent::ToolCall(ModelToolCall {
                id: format!("call_{index}"),
                name: "workspace/read".to_string(),
                arguments: serde_json::json!({ "path": "README.txt" }),
            })),
            Ok(ModelEvent::Completed),
        ]);
    }
    rounds.push_back(vec![
        Ok(ModelEvent::TextDelta(
            "Verified after twenty reads.".to_string(),
        )),
        Ok(ModelEvent::Completed),
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
                vec![
                    Ok(ModelEvent::TextDelta(
                        "The user asked to inspect large.txt. Prior reads succeeded; continue with the final answer."
                            .to_string(),
                    )),
                    Ok(ModelEvent::Usage(ModelUsage {
                        input_tokens: Some(10),
                        cached_input_tokens: None,
                        output_tokens: Some(5),
                        reasoning_output_tokens: None,
                        total_tokens: Some(15),
                    })),
                    Ok(ModelEvent::Completed),
                ]
            } else if call < 13 {
                self.calls.fetch_add(1, Ordering::AcqRel);
                vec![
                    Ok(ModelEvent::ToolCall(ModelToolCall {
                        id: format!("large_call_{call}"),
                        name: "workspace/read".to_string(),
                        arguments: serde_json::json!({ "path": "large.txt" }),
                    })),
                    Ok(ModelEvent::Completed),
                ]
            } else {
                vec![
                    Ok(ModelEvent::TextDelta(
                        "Large file inspection completed.".to_string(),
                    )),
                    Ok(ModelEvent::Completed),
                ]
            };
            async move { Ok(stream::iter(events).boxed()) }.boxed()
        }
    }
    let directory = tempfile::tempdir().expect("workspace");
    std::fs::write(directory.path().join("large.txt"), vec![b'a'; 256 * 1024])
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
            recorded_requests[compaction_index + 1]
                .tools
                .iter()
                .any(|tool| tool.name == "workspace/read")
        );
        assert!(matches!(
            recorded_requests[compaction_index + 1].messages.first(),
            Some(ModelMessage::ContextCompaction { .. })
        ));
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
    assert!(matches!(
        requests[15].messages.first(),
        Some(ModelMessage::ContextCompaction { content })
            if content.contains("Prior reads succeeded")
    ));
    assert!(requests[15].context_bytes() < crate::context::COMPACTION_TARGET_BYTES);
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
