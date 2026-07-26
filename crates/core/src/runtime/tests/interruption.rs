use super::*;

#[tokio::test]
async fn output_limit_fails_once_without_committing_the_oversized_delta() {
    let oversized = "x".repeat(crate::thread::MAX_AGENT_MESSAGE_BYTES + 1);
    let (mut runtime, mut events, thread_id) = runtime(RecordedProvider {
        events: vec![
            Ok(ModelEvent::TextDelta(oversized)),
            Ok(ModelEvent::Completed),
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
        .is_none_or(|event: &CoreEvent| !matches!(event.kind, CoreEventKind::TurnFailed { .. }))
    {
        lifecycle.push(events.recv().await.expect("core event"));
    }
    assert!(
        !lifecycle
            .iter()
            .any(|event| matches!(event.kind, CoreEventKind::AgentMessageDelta { .. }))
    );
    let CoreEventKind::TurnFailed { error, .. } =
        lifecycle.last().expect("failed terminal").kind.clone()
    else {
        panic!("failed terminal");
    };
    assert_eq!(error.kind, CoreTurnErrorKind::OutputTooLarge);
    assert!(!error.retryable);

    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.id == turn_id)
        .expect("persisted turn");
    assert_eq!(turn.status, DurableTurnStatus::Failed);
    assert_eq!(
        turn.error.as_ref().map(|error| error.kind),
        Some(DurableTurnErrorKind::OutputTooLarge)
    );
    assert!(matches!(
        turn.items.last(),
        Some(sugarcode_state::DurableItemSnapshot::AgentMessage { text, .. })
            if text.is_empty()
    ));
}

#[tokio::test]
async fn interrupt_cancels_a_pending_stream_and_emits_one_interrupted_terminal() {
    let (mut runtime, mut events, thread_id) = runtime(RecordedProvider {
        events: vec![Ok(ModelEvent::TextDelta("partial".to_string()))],
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
        if matches!(event.kind, CoreEventKind::AgentMessageDelta { .. }) {
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
        1
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
async fn interrupt_after_durable_agent_start_preserves_one_item_lifecycle_and_terminal() {
    let (mut runtime, mut events, thread_id) = runtime(RecordedProvider {
        events: vec![Ok(ModelEvent::TextDelta("partial".to_string()))],
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
                    sugarcode_state::DurableItemSnapshot::AgentMessage { .. }
                )
            }) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("durable agent item");
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
        1
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
        1
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
        1
    );
}

#[tokio::test]
async fn active_turn_rejects_thread_lifecycle_and_fork_until_terminal() {
    let (mut runtime, mut events, thread_id) = runtime(RecordedProvider {
        events: vec![Ok(ModelEvent::TextDelta("partial".to_string()))],
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
            CoreEventKind::AgentMessageDelta { .. }
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
        events: vec![Ok(ModelEvent::TextDelta("partial".to_string()))],
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
            CoreEventKind::AgentMessageDelta { .. }
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
