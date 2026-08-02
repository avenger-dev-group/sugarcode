use super::*;

#[test]
fn completed_text_replaces_a_different_streaming_preview() {
    let response = ModelResponse {
        output: vec![sugarcode_model_provider::ModelOutputItem {
            output_index: 0,
            kind: ModelOutputItemKind::AssistantText {
                phase: ModelTextPhase::Final,
                text: "authoritative completed text".to_owned(),
            },
        }],
        usage: None,
        terminal: ModelTerminalMetadata::completed(ModelContinuation::Complete),
        provider_context: None,
    };
    let preview = BTreeMap::from([(0, "provisional stream text".to_owned())]);

    assert!(matches!(
        classify_model_response(response, &preview).expect("completed response"),
        CompletedRoundOutput::Final { text, .. } if text == "authoritative completed text"
    ));
}

#[test]
fn provisional_commentary_preview_does_not_block_a_completed_tool_call() {
    let response = ModelResponse {
        output: vec![sugarcode_model_provider::ModelOutputItem {
            output_index: 0,
            kind: ModelOutputItemKind::ToolCall(ModelToolCall {
                id: "call_1".to_owned(),
                name: "workspace/read".to_owned(),
                arguments: serde_json::json!({"path": "README.md"}),
            }),
        }],
        usage: None,
        terminal: ModelTerminalMetadata::completed(ModelContinuation::ToolCalls),
        provider_context: None,
    };
    let preview = BTreeMap::from([(0, "I will inspect the project first.".to_owned())]);

    assert!(matches!(
        classify_model_response(response, &preview).expect("tool call response"),
        CompletedRoundOutput::ToolUse { calls, commentary: None }
            if calls.len() == 1 && calls[0].name == "workspace/read"
    ));
}

#[test]
fn alternating_tool_failures_share_one_total_non_progress_budget() {
    let mut state = AgentLoopState::default();

    assert!(!state.record_tool_argument_error("invalid-edit-1".to_owned()));
    state.reset_tool_argument_errors();
    assert!(!state.record_tool_execution_error("invalid-patch-1".to_owned()));
    state.reset_tool_execution_errors();
    assert!(!state.record_tool_argument_error("invalid-edit-2".to_owned()));
    state.reset_tool_argument_errors();
    assert!(state.record_tool_execution_error("invalid-patch-2".to_owned()));
}

#[tokio::test]
async fn oversized_provisional_preview_is_discarded_without_failing_final_output() {
    #[derive(Debug)]
    struct OversizedPreviewProvider;

    impl ModelProvider for OversizedPreviewProvider {
        fn stream(&self, _request: ModelRequest) -> BoxModelFuture<'_> {
            async move {
                Ok(stream::iter(vec![
                    Ok(model_event::text_delta("visible preview".to_owned())),
                    Ok(model_event::text_delta(
                        "x".repeat(crate::thread::MAX_AGENT_MESSAGE_BYTES),
                    )),
                    Ok(model_event::final_response("Authoritative final answer.")),
                ])
                .boxed())
            }
            .boxed()
        }
    }

    let mut core = Core::new();
    let CoreEventKind::ThreadStarted { thread_id } = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread")
        .kind
    else {
        panic!("thread event");
    };
    let (mut runtime, mut events) = CoreRuntime::new(
        core,
        Arc::new(OversizedPreviewProvider),
        "fixture-model".to_owned(),
    );
    runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id,
            Some("Continue".to_owned()),
        )
        .expect("start turn");

    let mut lifecycle = Vec::new();
    while lifecycle
        .last()
        .is_none_or(|event: &CoreEvent| !matches!(event.kind, CoreEventKind::TurnCompleted { .. }))
    {
        lifecycle.push(events.recv().await.expect("core event"));
    }

    let discarded_at = lifecycle
        .iter()
        .position(|event| matches!(event.kind, CoreEventKind::AgentOutputDiscarded { .. }))
        .expect("oversized preview discarded");
    let resolved_at = lifecycle
        .iter()
        .position(|event| matches!(event.kind, CoreEventKind::AgentOutputResolved { .. }))
        .expect("final output resolved");
    assert!(discarded_at < resolved_at);
    assert!(lifecycle.iter().any(|event| matches!(
        &event.kind,
        CoreEventKind::AgentMessageDelta { delta, .. }
            if delta == "Authoritative final answer."
    )));
}

#[tokio::test]
async fn tool_only_snapshot_discards_preview_before_the_next_model_round() {
    #[derive(Debug)]
    struct PreviewThenToolProvider {
        rounds: Mutex<VecDeque<Vec<Result<ModelEvent, ModelError>>>>,
    }

    impl ModelProvider for PreviewThenToolProvider {
        fn stream(&self, _request: ModelRequest) -> BoxModelFuture<'_> {
            let events = self
                .rounds
                .lock()
                .expect("rounds")
                .pop_front()
                .expect("recorded round");
            async move { Ok(stream::iter(events).boxed()) }.boxed()
        }
    }

    #[derive(Debug)]
    struct ImmediateWorkspaceRead;

    impl WorkspaceReadExecutor for ImmediateWorkspaceRead {
        fn read<'a>(
            &'a self,
            _arguments: &'a WorkspaceReadArguments,
            _cancellation: &'a CancellationToken,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = WorkspaceReadOutcome> + Send + 'a>>
        {
            Box::pin(async {
                WorkspaceReadOutcome::Content {
                    content: "fixture".to_owned(),
                    bytes: 7,
                }
            })
        }
    }

    let provider = PreviewThenToolProvider {
        rounds: Mutex::new(VecDeque::from([
            vec![
                Ok(model_event::text_delta("\n\n".to_owned())),
                Ok(model_event::tool_call(ModelToolCall {
                    id: "call_preview_tool".to_owned(),
                    name: "workspace/read".to_owned(),
                    arguments: serde_json::json!({"path": "README.md"}),
                })),
            ],
            vec![
                Ok(model_event::text_delta("Done.".to_owned())),
                Ok(model_event::final_response("Done.")),
            ],
        ])),
    };
    let mut core = Core::new();
    let CoreEventKind::ThreadStarted { thread_id } = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread")
        .kind
    else {
        panic!("thread event");
    };
    let (mut runtime, mut events) = CoreRuntime::new_with_workspace(
        core,
        Arc::new(provider),
        "fixture-model".to_owned(),
        Some(Arc::new(ImmediateWorkspaceRead)),
        None,
    );
    runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id,
            Some("Inspect the project".to_owned()),
        )
        .expect("start turn");

    let mut lifecycle = Vec::new();
    while lifecycle
        .last()
        .is_none_or(|event: &CoreEvent| !matches!(event.kind, CoreEventKind::TurnCompleted { .. }))
    {
        lifecycle.push(events.recv().await.expect("core event"));
    }

    let discarded_at = lifecycle
        .iter()
        .position(|event| {
            matches!(
                event.kind,
                CoreEventKind::AgentOutputDiscarded {
                    output: CoreAgentOutputRef {
                        response_ordinal: 1,
                        output_index: 0,
                    },
                    ..
                }
            )
        })
        .expect("first-round preview discarded");
    let second_delta_at = lifecycle
        .iter()
        .position(|event| {
            matches!(
                event.kind,
                CoreEventKind::AgentOutputDelta {
                    output: CoreAgentOutputRef {
                        response_ordinal: 2,
                        output_index: 0,
                    },
                    ..
                }
            )
        })
        .expect("second-round output starts");
    assert!(discarded_at < second_delta_at);
}

#[tokio::test]
async fn retryable_open_failure_is_retried_once_before_any_model_output() {
    #[derive(Debug)]
    struct OpeningRetryProvider {
        calls: AtomicUsize,
    }

    impl ModelProvider for OpeningRetryProvider {
        fn stream(&self, _request: ModelRequest) -> BoxModelFuture<'_> {
            let call = self.calls.fetch_add(1, Ordering::AcqRel);
            async move {
                if call == 0 {
                    Err(ModelError::new(ModelErrorKind::Transport, true))
                } else {
                    Ok(stream::iter(vec![Ok(model_event::final_response("Recovered."))]).boxed())
                }
            }
            .boxed()
        }
    }

    let provider = Arc::new(OpeningRetryProvider {
        calls: AtomicUsize::new(0),
    });
    let mut core = Core::new();
    let CoreEventKind::ThreadStarted { thread_id } = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread")
        .kind
    else {
        panic!("thread event");
    };
    let (mut runtime, mut events) =
        CoreRuntime::new(core, provider.clone(), "fixture-model".to_owned());
    let TurnStartOutcome::Accepted { .. } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id,
            Some("Continue".to_owned()),
        )
        .expect("start turn")
    else {
        panic!("asynchronous turn");
    };
    while !matches!(
        events.recv().await.expect("terminal").kind,
        CoreEventKind::TurnCompleted { .. }
    ) {}
    assert_eq!(provider.calls.load(Ordering::Acquire), 2);
}

#[tokio::test]
async fn retryable_stream_failure_is_retried_once_before_any_model_output() {
    #[derive(Debug)]
    struct StreamRetryProvider {
        stream_calls: AtomicUsize,
        compatibility_retry_calls: AtomicUsize,
    }

    impl ModelProvider for StreamRetryProvider {
        fn stream(&self, _request: ModelRequest) -> BoxModelFuture<'_> {
            self.stream_calls.fetch_add(1, Ordering::AcqRel);
            async move {
                Ok(stream::iter(vec![Err(ModelError::new(
                    ModelErrorKind::Disconnected,
                    true,
                ))])
                .boxed())
            }
            .boxed()
        }

        fn retry_after_no_output(&self, _request: ModelRequest) -> BoxModelFuture<'_> {
            self.compatibility_retry_calls
                .fetch_add(1, Ordering::AcqRel);
            async move {
                Ok(stream::iter(vec![Ok(model_event::final_response(
                    "Recovered after an empty stream.",
                ))])
                .boxed())
            }
            .boxed()
        }
    }

    let provider = Arc::new(StreamRetryProvider {
        stream_calls: AtomicUsize::new(0),
        compatibility_retry_calls: AtomicUsize::new(0),
    });
    let mut core = Core::new();
    let CoreEventKind::ThreadStarted { thread_id } = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread")
        .kind
    else {
        panic!("thread event");
    };
    let (mut runtime, mut events) =
        CoreRuntime::new(core, provider.clone(), "fixture-model".to_owned());
    let TurnStartOutcome::Accepted { .. } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id,
            Some("Continue".to_owned()),
        )
        .expect("start turn")
    else {
        panic!("asynchronous turn");
    };
    while !matches!(
        events.recv().await.expect("terminal").kind,
        CoreEventKind::TurnCompleted { .. }
    ) {}
    assert_eq!(provider.stream_calls.load(Ordering::Acquire), 1);
    assert_eq!(
        provider.compatibility_retry_calls.load(Ordering::Acquire),
        1
    );
}

#[tokio::test]
async fn stream_failure_after_a_delta_is_not_retried() {
    #[derive(Debug)]
    struct PartialStreamProvider {
        calls: AtomicUsize,
    }

    impl ModelProvider for PartialStreamProvider {
        fn stream(&self, _request: ModelRequest) -> BoxModelFuture<'_> {
            self.calls.fetch_add(1, Ordering::AcqRel);
            async move {
                Ok(stream::iter(vec![
                    Ok(model_event::text_delta("partial".to_owned())),
                    Err(ModelError::new(ModelErrorKind::Disconnected, true)),
                ])
                .boxed())
            }
            .boxed()
        }
    }

    let provider = Arc::new(PartialStreamProvider {
        calls: AtomicUsize::new(0),
    });
    let mut core = Core::new();
    let CoreEventKind::ThreadStarted { thread_id } = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread")
        .kind
    else {
        panic!("thread event");
    };
    let (mut runtime, mut events) =
        CoreRuntime::new(core, provider.clone(), "fixture-model".to_owned());
    let TurnStartOutcome::Accepted { .. } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id,
            Some("Continue".to_owned()),
        )
        .expect("start turn")
    else {
        panic!("asynchronous turn");
    };
    while !matches!(
        events.recv().await.expect("terminal").kind,
        CoreEventKind::TurnFailed { .. }
    ) {}
    assert_eq!(provider.calls.load(Ordering::Acquire), 1);
}

#[tokio::test]
async fn failed_turn_does_not_poison_runtime_or_the_next_turn() {
    #[derive(Debug)]
    struct TurnIsolatingProvider {
        calls: AtomicUsize,
    }

    impl ModelProvider for TurnIsolatingProvider {
        fn stream(&self, _request: ModelRequest) -> BoxModelFuture<'_> {
            let call = self.calls.fetch_add(1, Ordering::AcqRel);
            async move {
                if call == 0 {
                    Err(ModelError::new(ModelErrorKind::InvalidRequest, false))
                } else {
                    Ok(stream::iter(vec![Ok(model_event::final_response(
                        "The next Turn completed.",
                    ))])
                    .boxed())
                }
            }
            .boxed()
        }
    }

    let provider = Arc::new(TurnIsolatingProvider {
        calls: AtomicUsize::new(0),
    });
    let mut core = Core::new();
    let CoreEventKind::ThreadStarted { thread_id } = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread")
        .kind
    else {
        panic!("thread event");
    };
    let (mut runtime, mut events) =
        CoreRuntime::new(core, provider.clone(), "fixture-model".to_owned());

    let TurnStartOutcome::Accepted { .. } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("First Turn".to_owned()),
        )
        .expect("start failing turn")
    else {
        panic!("asynchronous turn");
    };
    while !matches!(
        events.recv().await.expect("failed terminal").kind,
        CoreEventKind::TurnFailed { .. }
    ) {}

    let TurnStartOutcome::Accepted { .. } = runtime
        .start_text_turn(
            CoreRequestId::new(3),
            thread_id,
            Some("Second Turn".to_owned()),
        )
        .expect("start next turn")
    else {
        panic!("asynchronous turn");
    };
    while !matches!(
        events.recv().await.expect("completed terminal").kind,
        CoreEventKind::TurnCompleted { .. }
    ) {}

    assert_eq!(provider.calls.load(Ordering::Acquire), 2);
}

#[tokio::test]
async fn successful_task_streams_and_persists_one_terminal_lifecycle() {
    let (mut runtime, mut events, thread_id) = runtime(RecordedProvider {
        events: vec![
            Ok(model_event::text_delta("hello ".to_string())),
            Ok(model_event::text_delta("world".to_string())),
            Ok(model_event::usage(ModelUsage {
                input_tokens: Some(2),
                output_tokens: Some(2),
                total_tokens: Some(4),
                ..Default::default()
            })),
            Ok(model_event::COMPLETED),
        ],
        stay_open: false,
    });
    let outcome = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Hello".to_string()),
        )
        .expect("start text turn");
    let TurnStartOutcome::Accepted { turn_id } = outcome else {
        panic!("asynchronous turn");
    };

    let mut lifecycle = Vec::new();
    while lifecycle
        .last()
        .is_none_or(|event: &CoreEvent| !matches!(event.kind, CoreEventKind::TurnCompleted { .. }))
    {
        lifecycle.push(events.recv().await.expect("core event"));
    }
    assert_eq!(
        lifecycle
            .iter()
            .filter(|event| matches!(event.kind, CoreEventKind::ItemCompleted { .. }))
            .count(),
        2
    );
    assert_eq!(
        lifecycle
            .iter()
            .filter(|event| matches!(event.kind, CoreEventKind::TurnCompleted { .. }))
            .count(),
        1
    );
    let preview = lifecycle
        .iter()
        .filter_map(|event| match &event.kind {
            CoreEventKind::AgentOutputDelta { output, delta, .. } => {
                Some((*output, delta.as_str()))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(preview.len(), 2);
    assert!(
        preview
            .iter()
            .all(|(output, _)| { output.response_ordinal == 1 && output.output_index == 0 })
    );
    assert_eq!(
        preview.iter().map(|(_, delta)| *delta).collect::<String>(),
        "hello world"
    );
    assert!(lifecycle.iter().any(|event| matches!(
        event.kind,
        CoreEventKind::AgentOutputResolved {
            output: CoreAgentOutputRef {
                response_ordinal: 1,
                output_index: 0,
            },
            item: CoreItemSnapshot {
                kind: CoreItemKind::AgentMessage { .. },
                ..
            },
            ..
        }
    )));
    assert!(lifecycle.iter().any(|event| matches!(
        &event.kind,
        CoreEventKind::AgentMessageDelta { delta, .. } if delta == "hello world"
    )));
    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.id == turn_id)
        .expect("persisted turn");
    assert_eq!(turn.status, DurableTurnStatus::Completed);
    assert_eq!(turn.items.len(), 2);
    assert_eq!(
        turn.usage.as_ref().and_then(|usage| usage.total_tokens),
        Some(4)
    );
}

#[tokio::test]
async fn whitespace_only_final_response_fails_without_a_completed_empty_message() {
    let (mut runtime, mut events, thread_id) = runtime(RecordedProvider {
        events: vec![
            Ok(model_event::text_delta(" \n\t".to_string())),
            Ok(model_event::COMPLETED),
        ],
        stay_open: false,
    });
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Hello".to_string()),
        )
        .expect("start text turn")
    else {
        panic!("asynchronous turn");
    };
    while !matches!(
        events.recv().await.expect("terminal event").kind,
        CoreEventKind::TurnCompleted { .. }
            | CoreEventKind::TurnFailed { .. }
            | CoreEventKind::TurnInterrupted { .. }
    ) {}
    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.id == turn_id)
        .expect("persisted turn");
    assert_eq!(turn.status, DurableTurnStatus::Failed);
    assert_eq!(
        turn.error.as_ref().map(|error| error.kind),
        Some(DurableTurnErrorKind::Incomplete)
    );
}

#[tokio::test]
async fn duplicate_response_completion_is_a_protocol_error_without_an_agent_item() {
    let (mut runtime, mut events, thread_id) = runtime(RecordedProvider {
        events: vec![
            Ok(model_event::final_response("first")),
            Ok(model_event::final_response("second")),
        ],
        stay_open: false,
    });
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Hello".to_string()),
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
        Some(DurableTurnErrorKind::Protocol)
    );
    assert!(!turn.items.iter().any(|item| matches!(
        item,
        sugarcode_state::DurableItemSnapshot::AgentMessage { .. }
    )));
}
