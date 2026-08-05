use super::*;

#[tokio::test(start_paused = true)]
async fn active_turn_remains_running_after_thirty_minutes_until_interrupted() {
    let (mut runtime, mut events, thread_id) = runtime(RecordedProvider {
        events: Vec::new(),
        stay_open: true,
    });
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Wait for the provider".to_string()),
        )
        .expect("start text turn")
    else {
        panic!("asynchronous turn");
    };

    while !matches!(
        events.recv().await.expect("opening event").kind,
        CoreEventKind::ItemCompleted {
            item: CoreItemSnapshot {
                kind: CoreItemKind::UserMessage { .. },
                ..
            },
            ..
        }
    ) {}
    tokio::time::advance(std::time::Duration::from_secs(30 * 60)).await;
    tokio::task::yield_now().await;
    assert_eq!(
        runtime
            .interrupt_turn(&thread_id, &turn_id)
            .expect("interrupt long-running turn"),
        TurnInterruptOutcome::Accepted
    );
    loop {
        if matches!(
            events.recv().await.expect("interrupted terminal").kind,
            CoreEventKind::TurnInterrupted { .. }
        ) {
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
    assert!(turn.error.is_none());
}

#[tokio::test]
async fn final_text_above_the_preview_budget_completes_and_persists() {
    let completed_text = "x".repeat(MAX_AGENT_PREVIEW_BYTES + 64 * 1024);
    let (mut runtime, mut events, thread_id) = runtime(RecordedProvider {
        events: vec![
            Ok(model_event::text_delta(completed_text.clone())),
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

    let mut lifecycle = Vec::new();
    while lifecycle
        .last()
        .is_none_or(|event: &CoreEvent| !matches!(event.kind, CoreEventKind::TurnCompleted { .. }))
    {
        lifecycle.push(events.recv().await.expect("core event"));
    }
    assert!(lifecycle.iter().any(|event| matches!(
        &event.kind,
        CoreEventKind::AgentMessageDelta { delta, .. } if delta == &completed_text
    )));

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
        sugarcode_state::DurableItemSnapshot::AgentMessage { text, .. }
            if text == &completed_text
    )));
}

#[tokio::test]
async fn interrupt_cancels_a_pending_stream_and_emits_one_interrupted_terminal() {
    let (mut runtime, mut events, thread_id) = runtime(RecordedProvider {
        events: vec![Ok(model_event::text_delta("partial".to_string()))],
        stay_open: true,
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
    loop {
        let event = events.recv().await.expect("pre-interrupt event");
        if matches!(event.kind, CoreEventKind::AgentOutputDelta { .. }) {
            break;
        }
    }
    assert_eq!(
        runtime
            .interrupt_turn(&thread_id, &turn_id)
            .expect("interrupt"),
        TurnInterruptOutcome::Accepted
    );

    let mut terminals = Vec::new();
    while terminals.last().is_none_or(|event: &CoreEvent| {
        !matches!(event.kind, CoreEventKind::TurnInterrupted { .. })
    }) {
        terminals.push(events.recv().await.expect("terminal event"));
    }
    assert_eq!(
        terminals
            .iter()
            .filter(|event| matches!(event.kind, CoreEventKind::ItemCompleted { .. }))
            .count(),
        0
    );
    assert_eq!(
        terminals
            .iter()
            .filter(|event| matches!(event.kind, CoreEventKind::TurnInterrupted { .. }))
            .count(),
        1
    );
    assert_eq!(
        runtime
            .interrupt_turn(&thread_id, &turn_id)
            .expect("terminal interrupt is idempotent"),
        TurnInterruptOutcome::AlreadyTerminal
    );
    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    assert_eq!(
        snapshot
            .turns
            .iter()
            .find(|turn| turn.id == turn_id)
            .expect("persisted turn")
            .status,
        DurableTurnStatus::Interrupted
    );
}

#[tokio::test]
async fn closed_event_consumer_interrupts_without_claiming_state_is_unavailable() {
    let directory = tempfile::tempdir().expect("workspace");
    std::fs::write(directory.path().join("README.md"), "hello").expect("workspace fixture");
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([vec![Ok(model_event::tool_call(
            ModelToolCall {
                id: "call_read".to_string(),
                name: "workspace/read".to_string(),
                arguments: serde_json::json!({ "path": "README.md" }),
            },
        ))]])),
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
        .expect("start turn")
    else {
        panic!("asynchronous turn");
    };
    loop {
        let event = events.recv().await.expect("tool lifecycle");
        if matches!(
            event.kind,
            CoreEventKind::ItemStarted {
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
    drop(events);
    let turn = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let turn = runtime
                .resume_thread(&thread_id)
                .expect("resume")
                .turns
                .into_iter()
                .find(|turn| turn.id == turn_id)
                .expect("turn");
            if turn.status != DurableTurnStatus::InProgress {
                break turn;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("event consumer closure must terminate the turn");
    assert_eq!(turn.status, DurableTurnStatus::Interrupted);
    assert!(turn.error.is_none());
    runtime.shutdown().await.expect("shutdown");
}

#[tokio::test]
async fn interrupt_while_preview_is_backpressured_persists_no_agent_item() {
    let (mut runtime, mut events, thread_id) = runtime(RecordedProvider {
        events: vec![Ok(model_event::text_delta("partial".to_string()))],
        stay_open: true,
    });
    for _ in 0..CORE_EVENT_CAPACITY - 3 {
        runtime
            .event_tx
            .send(CoreEvent {
                request_id: CoreRequestId::new(999),
                kind: CoreEventKind::RuntimeFailed,
            })
            .await
            .expect("seed event queue");
    }
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

    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let snapshot = runtime.resume_thread(&thread_id).expect("resume");
            let turn = snapshot
                .turns
                .iter()
                .find(|turn| turn.id == turn_id)
                .expect("persisted turn");
            if turn.items.iter().any(|item| {
                matches!(
                    item,
                    sugarcode_state::DurableItemSnapshot::UserMessage { .. }
                )
            }) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("durable user item");
    assert_eq!(
        runtime
            .interrupt_turn(&thread_id, &turn_id)
            .expect("interrupt"),
        TurnInterruptOutcome::Accepted
    );

    let mut lifecycle = Vec::new();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let event = events.recv().await.expect("terminal event");
            if event.request_id == CoreRequestId::new(2) {
                let interrupted = matches!(event.kind, CoreEventKind::TurnInterrupted { .. });
                lifecycle.push(event);
                if interrupted {
                    break;
                }
            }
        }
    })
    .await
    .expect("interrupted lifecycle");
    assert_eq!(
        lifecycle
            .iter()
            .filter(|event| matches!(
                event.kind,
                CoreEventKind::ItemStarted {
                    item: CoreItemSnapshot {
                        kind: CoreItemKind::AgentMessage { .. },
                        ..
                    },
                    ..
                }
            ))
            .count(),
        0
    );
    assert_eq!(
        lifecycle
            .iter()
            .filter(|event| matches!(
                event.kind,
                CoreEventKind::ItemCompleted {
                    item: CoreItemSnapshot {
                        kind: CoreItemKind::AgentMessage { .. },
                        ..
                    },
                    ..
                }
            ))
            .count(),
        0
    );
    assert_eq!(
        lifecycle
            .iter()
            .filter(|event| matches!(event.kind, CoreEventKind::TurnInterrupted { .. }))
            .count(),
        1
    );
    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.id == turn_id)
        .expect("persisted turn");
    assert_eq!(turn.status, DurableTurnStatus::Interrupted);
    assert_eq!(
        turn.items
            .iter()
            .filter(|item| matches!(
                item,
                sugarcode_state::DurableItemSnapshot::AgentMessage { .. }
            ))
            .count(),
        0
    );
}

#[tokio::test]
async fn active_turn_rejects_thread_lifecycle_and_fork_until_terminal() {
    let (mut runtime, mut events, thread_id) = runtime(RecordedProvider {
        events: vec![Ok(model_event::text_delta("partial".to_string()))],
        stay_open: true,
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
    loop {
        if matches!(
            events.recv().await.expect("pre-lifecycle event").kind,
            CoreEventKind::AgentOutputDelta { .. }
        ) {
            break;
        }
    }

    for error in [
        runtime.archive_thread(&thread_id).expect_err("archive"),
        runtime.delete_thread(&thread_id).expect_err("delete"),
        runtime.fork_thread(&thread_id).expect_err("fork"),
    ] {
        assert!(matches!(
            error,
            CoreError::TurnAlreadyActive {
                thread_id: ref active_thread,
                turn_id: ref active_turn,
            } if active_thread == &thread_id && active_turn == &turn_id
        ));
    }

    assert_eq!(
        runtime
            .interrupt_turn(&thread_id, &turn_id)
            .expect("interrupt"),
        TurnInterruptOutcome::Accepted
    );
    loop {
        if matches!(
            events.recv().await.expect("terminal event").kind,
            CoreEventKind::TurnInterrupted { .. }
        ) {
            break;
        }
    }
    runtime.shutdown().await.expect("terminal cleanup");
    runtime
        .archive_thread(&thread_id)
        .expect("archive terminal thread");
}

#[tokio::test]
async fn shutdown_waits_for_active_turn_to_persist_interrupted() {
    let (mut runtime, mut events, thread_id) = runtime(RecordedProvider {
        events: vec![Ok(model_event::text_delta("partial".to_string()))],
        stay_open: true,
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
    loop {
        if matches!(
            events.recv().await.expect("pre-shutdown event").kind,
            CoreEventKind::AgentOutputDelta { .. }
        ) {
            break;
        }
    }

    runtime.shutdown().await.expect("graceful shutdown");
    let mut interrupted = false;
    while let Ok(event) = events.try_recv() {
        interrupted |= matches!(event.kind, CoreEventKind::TurnInterrupted { .. });
    }
    assert!(interrupted);
    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.id == turn_id)
        .expect("persisted turn");
    assert_eq!(turn.status, DurableTurnStatus::Interrupted);
}
