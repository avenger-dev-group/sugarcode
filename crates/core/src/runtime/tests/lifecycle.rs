use super::*;

#[tokio::test]
async fn successful_task_streams_and_persists_one_terminal_lifecycle() {
    let (mut runtime, mut events, thread_id) = runtime(RecordedProvider {
        events: vec![
            Ok(ModelEvent::TextDelta("hello ".to_string())),
            Ok(ModelEvent::TextDelta("world".to_string())),
            Ok(ModelEvent::Usage(ModelUsage {
                input_tokens: Some(2),
                output_tokens: Some(2),
                total_tokens: Some(4),
                ..Default::default()
            })),
            Ok(ModelEvent::Completed),
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
            Ok(ModelEvent::TextDelta(" \n\t".to_string())),
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
