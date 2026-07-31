use super::*;

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
