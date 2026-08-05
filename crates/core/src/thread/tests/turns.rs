use super::*;

#[test]
fn commits_a_complete_deterministic_agent_message_lifecycle() {
    let mut core = Core::new();
    let thread_id = start_thread(&mut core, 1);
    let request_id = CoreRequestId::new(2);

    let events = core
        .start_turn(request_id, thread_id.clone())
        .expect("turn starts");

    assert_eq!(events.len(), 5);
    assert!(events.iter().all(|event| event.request_id == request_id));
    let turn_id = turn_id(&events);
    assert!(TurnId::parse(turn_id.as_str()).is_ok());

    let CoreEventKind::ItemStarted {
        thread_id: started_thread_id,
        turn_id: started_turn_id,
        item: started_item,
    } = &events[1].kind
    else {
        panic!("expected item started second");
    };
    assert_eq!(started_thread_id, &thread_id);
    assert_eq!(started_turn_id, &turn_id);
    assert!(ItemId::parse(started_item.id.as_str()).is_ok());
    assert_eq!(
        started_item.kind,
        CoreItemKind::AgentMessage {
            text: String::new()
        }
    );

    let CoreEventKind::AgentMessageDelta {
        thread_id: delta_thread_id,
        turn_id: delta_turn_id,
        item_id,
        delta,
    } = &events[2].kind
    else {
        panic!("expected agent message delta third");
    };
    assert_eq!(delta_thread_id, &thread_id);
    assert_eq!(delta_turn_id, &turn_id);
    assert_eq!(item_id, &started_item.id);
    assert_eq!(delta, DETERMINISTIC_AGENT_MESSAGE);

    let CoreEventKind::ItemCompleted {
        thread_id: completed_thread_id,
        turn_id: completed_turn_id,
        item: completed_item,
    } = &events[3].kind
    else {
        panic!("expected item completed first");
    };
    assert_eq!(completed_thread_id, &thread_id);
    assert_eq!(completed_turn_id, &turn_id);
    assert_eq!(completed_item.id, started_item.id);
    assert_eq!(
        completed_item.kind,
        CoreItemKind::AgentMessage {
            text: DETERMINISTIC_AGENT_MESSAGE.to_string()
        }
    );

    assert_eq!(
        events[4].kind,
        CoreEventKind::TurnCompleted {
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone()
        }
    );
    let stored_turn = &core.threads[&thread_id].turns[&turn_id];
    assert_eq!(stored_turn.state, TurnState::Completed);
    assert_eq!(
        stored_turn.items[&completed_item.id].state,
        ItemState::Completed
    );
    assert!(core.threads[&thread_id].active_turn_id.is_none());
}

#[test]
fn starts_consecutive_turns_after_completion_and_isolates_threads() {
    let mut core = Core::new();
    let first_thread_id = start_thread(&mut core, 1);
    let second_thread_id = start_thread(&mut core, 2);

    let first = core
        .start_turn(CoreRequestId::new(3), first_thread_id.clone())
        .expect("first turn starts");
    let second = core
        .start_turn(CoreRequestId::new(4), first_thread_id.clone())
        .expect("second turn starts");
    let third = core
        .start_turn(CoreRequestId::new(5), second_thread_id.clone())
        .expect("third turn starts");

    let turn_ids = [turn_id(&first), turn_id(&second), turn_id(&third)];
    assert!(
        turn_ids
            .iter()
            .all(|turn_id| TurnId::parse(turn_id.as_str()).is_ok())
    );
    assert_ne!(turn_ids[0], turn_ids[1]);
    assert_ne!(turn_ids[0], turn_ids[2]);
    assert_ne!(turn_ids[1], turn_ids[2]);
    assert_eq!(core.turn_count(&first_thread_id), 2);
    assert_eq!(core.turn_count(&second_thread_id), 1);

    let item_ids = [&first, &second, &third]
        .map(|events| {
            let CoreEventKind::ItemStarted { item, .. } = &events[1].kind else {
                panic!("expected item started");
            };
            item.id.as_str()
        })
        .to_vec();
    assert!(
        item_ids
            .iter()
            .all(|item_id| ItemId::parse(*item_id).is_ok())
    );
    assert_eq!(item_ids.iter().collect::<BTreeSet<_>>().len(), 3);
}

#[test]
fn provider_history_preserves_terminal_user_input_but_excludes_partial_output() {
    let mut core = Core::new();
    let thread_id = start_thread(&mut core, 1);
    for (request, status) in [
        (2, DurableTurnStatus::Failed),
        (3, DurableTurnStatus::Interrupted),
    ] {
        let prepared = core
            .prepare_text_turn(
                CoreRequestId::new(request),
                thread_id.clone(),
                Some(format!("recoverable-{request}")),
            )
            .expect("prepare excluded turn");
        core.append_text_delta(&thread_id, &prepared.turn_id, "partial")
            .expect("append partial");
        let error = (status == DurableTurnStatus::Failed).then_some(DurableTurnError {
            kind: sugarcode_state::DurableTurnErrorKind::Server,
            retryable: true,
            provider: None,
            protocol: None,
            tool_schema: None,
        });
        core.finish_text_turn(&thread_id, &prepared.turn_id, status, error, None)
            .expect("finish excluded turn");
    }

    let prepared = core
        .prepare_text_turn(
            CoreRequestId::new(4),
            thread_id,
            Some("included".to_string()),
        )
        .expect("prepare next turn");
    assert_eq!(
        prepared.history,
        vec![
            PreparedMessage::UserContent {
                content: vec![sugarcode_protocol::CoreUserContentPart::Text {
                    text: "recoverable-2".to_string(),
                }],
            },
            PreparedMessage::UserContent {
                content: vec![sugarcode_protocol::CoreUserContentPart::Text {
                    text: "recoverable-3".to_string(),
                }],
            },
            PreparedMessage::UserContent {
                content: vec![sugarcode_protocol::CoreUserContentPart::Text {
                    text: "included".to_string(),
                }],
            },
        ]
    );
}

#[test]
fn provider_history_preserves_balanced_tools_from_an_interrupted_turn() {
    let mut core = Core::new();
    let thread_id = start_thread(&mut core, 1);
    let interrupted = core
        .prepare_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Inspect the project".to_string()),
        )
        .expect("prepare interrupted turn");
    core.append_completed_item(
        &thread_id,
        &interrupted.turn_id,
        CoreItemKind::ToolCall {
            call_id: "call_1".to_string(),
            name: "workspace/list".to_string(),
            arguments: serde_json::json!({"path": "."}),
        },
    )
    .expect("tool call");
    core.append_completed_item(
        &thread_id,
        &interrupted.turn_id,
        CoreItemKind::ToolResult {
            call_id: "call_1".to_string(),
            name: "workspace/list".to_string(),
            result: CoreToolResult::Success {
                content: "project entries".to_string(),
                bytes: 15,
            },
        },
    )
    .expect("tool result");
    core.finish_turn(
        &thread_id,
        &interrupted.turn_id,
        DurableTurnStatus::Interrupted,
        None,
        None,
    )
    .expect("interrupt turn");

    let continued = core
        .prepare_text_turn(
            CoreRequestId::new(3),
            thread_id,
            Some("Continue".to_string()),
        )
        .expect("continue turn");
    assert!(matches!(
        continued.history.as_slice(),
        [
            PreparedMessage::UserContent { .. },
            PreparedMessage::ToolCall { call_id, name, .. },
            PreparedMessage::ToolResult { call_id: result_call_id, .. },
            PreparedMessage::UserContent { .. },
        ] if call_id == "call_1"
            && result_call_id == "call_1"
            && name == "workspace/list"
    ));
}

#[test]
fn provider_history_compacts_deterministically_above_the_compatibility_target() {
    let mut core = Core::new();
    let thread_id = start_thread(&mut core, 1);
    let maximum_output = "x".repeat(LARGE_AGENT_OUTPUT_BYTES);
    for request in 2..=7 {
        let prepared = core
            .prepare_text_turn(
                CoreRequestId::new(request),
                thread_id.clone(),
                Some("u".to_string()),
            )
            .expect("history remains within limit before completion");
        core.append_text_delta(&thread_id, &prepared.turn_id, &maximum_output)
            .expect("maximum output");
        core.finish_text_turn(
            &thread_id,
            &prepared.turn_id,
            DurableTurnStatus::Completed,
            None,
            None,
        )
        .expect("complete turn");
    }

    let compacted = core
        .prepare_text_turn(
            CoreRequestId::new(8),
            thread_id.clone(),
            Some("after-compaction".to_string()),
        )
        .expect("compaction makes the prospective request fit");
    assert_eq!(compacted.history.len(), 2);
    let PreparedMessage::ContextCompaction { content } = &compacted.history[0] else {
        panic!("expected persisted compaction first");
    };
    assert!(content.starts_with("SugarCode deterministic persisted compaction v1\n"));
    assert_eq!(
        compacted.history[1],
        PreparedMessage::UserContent {
            content: vec![sugarcode_protocol::CoreUserContentPart::Text {
                text: "after-compaction".to_string(),
            }],
        }
    );
    core.start_agent_message(&thread_id, &compacted.turn_id)
        .expect("start compacted response");
    core.append_text_delta(&thread_id, &compacted.turn_id, "answer")
        .expect("append response");
    core.finish_text_turn(
        &thread_id,
        &compacted.turn_id,
        DurableTurnStatus::Completed,
        None,
        None,
    )
    .expect("complete checkpoint turn");

    let snapshot = core.resume_thread(&thread_id).expect("snapshot");
    let checkpoint = snapshot.turns[6]
        .context_compaction
        .as_ref()
        .expect("completed turn persists checkpoint");
    assert_eq!(checkpoint.through_turn_id, snapshot.turns[5].id);
    assert_eq!(checkpoint.source_turns, 6);
    assert!(checkpoint.pre_context_bytes > crate::context::COMPACTION_TARGET_BYTES as u64);
    assert!(checkpoint.post_context_bytes <= crate::context::COMPACTION_TARGET_BYTES as u64);

    let continued = core
        .prepare_text_turn(
            CoreRequestId::new(9),
            thread_id,
            Some("continued".to_string()),
        )
        .expect("completed checkpoint is effective");
    assert_eq!(
        continued.history[0],
        PreparedMessage::ContextCompaction {
            content: checkpoint.message.clone(),
        }
    );
    assert_eq!(continued.history.len(), 4);
}

#[test]
fn interrupted_checkpoint_is_rebuilt_with_recoverable_input() {
    let mut core = Core::new();
    let thread_id = start_thread(&mut core, 1);
    let maximum_output = "x".repeat(LARGE_AGENT_OUTPUT_BYTES);
    for request in 2..=7 {
        let prepared = core
            .prepare_text_turn(
                CoreRequestId::new(request),
                thread_id.clone(),
                Some("u".to_string()),
            )
            .expect("prepare history");
        core.append_text_delta(&thread_id, &prepared.turn_id, &maximum_output)
            .expect("maximum output");
        core.finish_text_turn(
            &thread_id,
            &prepared.turn_id,
            DurableTurnStatus::Completed,
            None,
            None,
        )
        .expect("complete history");
    }
    let interrupted = core
        .prepare_text_turn(
            CoreRequestId::new(8),
            thread_id.clone(),
            Some("retry".to_string()),
        )
        .expect("first checkpoint");
    let PreparedMessage::ContextCompaction {
        content: first_message,
    } = &interrupted.history[0]
    else {
        panic!("checkpoint");
    };
    core.start_agent_message(&thread_id, &interrupted.turn_id)
        .expect("start interrupted answer");
    core.finish_text_turn(
        &thread_id,
        &interrupted.turn_id,
        DurableTurnStatus::Interrupted,
        None,
        None,
    )
    .expect("interrupt checkpoint turn");
    assert!(
        core.resume_thread(&thread_id).expect("snapshot").turns[6]
            .context_compaction
            .is_some()
    );

    let retried = core
        .prepare_text_turn(CoreRequestId::new(9), thread_id, Some("retry".to_string()))
        .expect("rebuild checkpoint with interrupted input");
    let PreparedMessage::ContextCompaction { content } = &retried.history[0] else {
        panic!("rebuilt checkpoint");
    };
    assert_ne!(content, first_message);
    assert!(content.contains("coveredTurns:7"));
    assert!(matches!(
        retried.history.last(),
        Some(PreparedMessage::UserContent { content })
            if matches!(content.as_slice(), [sugarcode_protocol::CoreUserContentPart::Text { text }] if text == "retry")
    ));
}

#[test]
fn compaction_trigger_is_strictly_above_target_and_failure_is_atomic() {
    let mut core = Core::new();
    let thread_id = start_thread(&mut core, 1);
    let first = core
        .prepare_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("u".to_string()),
        )
        .expect("first turn");
    core.append_text_delta(&thread_id, &first.turn_id, "a")
        .expect("first answer");
    core.finish_text_turn(
        &thread_id,
        &first.turn_id,
        DurableTurnStatus::Completed,
        None,
        None,
    )
    .expect("complete first turn");

    let fixed_at_target = crate::context::COMPACTION_TARGET_BYTES - 3;
    let exact = core
        .prepare_text_turn_with_workspace_instructions(
            CoreRequestId::new(3),
            thread_id.clone(),
            Some("n".to_string()),
            None,
            fixed_at_target,
            0,
        )
        .expect("exact target does not compact");
    assert!(TurnId::parse(exact.turn_id.as_str()).is_ok());
    assert!(
        exact
            .history
            .iter()
            .all(|message| !matches!(message, PreparedMessage::ContextCompaction { .. }))
    );
    core.start_agent_message(&thread_id, &exact.turn_id)
        .expect("start interrupted exact-target answer");
    core.finish_text_turn(
        &thread_id,
        &exact.turn_id,
        DurableTurnStatus::Interrupted,
        None,
        None,
    )
    .expect("interrupt exact-target turn");

    assert_eq!(
        core.prepare_text_turn_with_workspace_instructions(
            CoreRequestId::new(4),
            thread_id.clone(),
            Some("n".to_string()),
            None,
            fixed_at_target,
            0,
        ),
        Err(CoreError::ContextTooLarge)
    );
    let after_failure = core
        .prepare_text_turn_with_workspace_instructions(
            CoreRequestId::new(5),
            thread_id,
            Some("n".to_string()),
            None,
            fixed_at_target - 1,
            0,
        )
        .expect("failed compaction did not reserve a turn");
    assert!(TurnId::parse(after_failure.turn_id.as_str()).is_ok());
    assert_ne!(after_failure.turn_id, exact.turn_id);
}

#[test]
fn omitted_input_continues_completed_history_without_a_user_item() {
    let mut core = Core::new();
    let thread_id = start_thread(&mut core, 1);
    let first = core
        .prepare_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Hello".to_string()),
        )
        .expect("first turn");
    core.append_text_delta(&thread_id, &first.turn_id, "Answer")
        .expect("answer");
    core.finish_text_turn(
        &thread_id,
        &first.turn_id,
        DurableTurnStatus::Completed,
        None,
        None,
    )
    .expect("complete first turn");

    let continuation = core
        .prepare_text_turn(CoreRequestId::new(3), thread_id, None)
        .expect("continuation");
    assert!(continuation.user_item.is_none());
    assert_eq!(
        continuation.history,
        vec![
            PreparedMessage::UserContent {
                content: vec![sugarcode_protocol::CoreUserContentPart::Text {
                    text: "Hello".to_string(),
                }],
            },
            PreparedMessage::Text {
                role: PreparedMessageRole::Assistant,
                text: "Answer".to_string(),
            },
        ]
    );
}

#[test]
fn consecutive_turns_are_allowed_after_each_durable_completion() {
    let mut core = Core::new();
    let thread_id = start_thread(&mut core, 1);
    let first = core
        .start_turn(CoreRequestId::new(2), thread_id.clone())
        .expect("turn starts");
    let second = core
        .start_turn(CoreRequestId::new(3), thread_id)
        .expect("next turn starts");
    let first_turn_id = turn_id(&first);
    let second_turn_id = turn_id(&second);
    assert!(TurnId::parse(first_turn_id.as_str()).is_ok());
    assert!(TurnId::parse(second_turn_id.as_str()).is_ok());
    assert_ne!(first_turn_id, second_turn_id);
}

#[test]
fn completed_turns_and_items_reject_additional_work() {
    let turn_id = TurnId::parse("00000000-0001-7000-8000-000000000098").expect("valid turn UUIDv7");
    let item_id = ItemId::parse("00000000-0002-7000-8000-000000000098").expect("valid item UUIDv7");
    let mut item = Item::new_agent_message(item_id.clone());
    item.complete().expect("item completes");
    assert_eq!(
        item.append_agent_message_delta("late"),
        Err(CoreError::ItemNotInProgress(item_id.clone()))
    );

    let mut turn = Turn::new(turn_id.clone(), CoreRequestId::new(1));
    turn.add_item(Item::new_agent_message(
        ItemId::parse("00000000-0002-7000-8000-000000000097").expect("valid item UUIDv7"),
    ))
    .expect("active item is stored");
    turn.complete_active_item_and_turn()
        .expect("turn completes");
    assert_eq!(
        turn.add_item(Item::new_agent_message(
            ItemId::parse("00000000-0002-7000-8000-000000000096").expect("valid item UUIDv7")
        )),
        Err(CoreError::TurnNotInProgress(turn_id))
    );
    assert_eq!(item.state, ItemState::Completed);
}

#[test]
fn missing_thread_is_rejected_before_a_valid_turn_starts() {
    let mut core = Core::new();
    let missing_thread_id =
        ThreadId::parse("00000000-0000-7000-8000-000000000099").expect("valid thread UUIDv7");

    assert_eq!(
        core.start_turn(CoreRequestId::new(1), missing_thread_id.clone()),
        Err(CoreError::ThreadNotFound(missing_thread_id))
    );

    let thread_id = start_thread(&mut core, 2);
    let events = core
        .start_turn(CoreRequestId::new(3), thread_id)
        .expect("turn starts");
    assert!(TurnId::parse(turn_id(&events).as_str()).is_ok());
    let CoreEventKind::ItemStarted { item, .. } = &events[1].kind else {
        panic!("expected item started");
    };
    assert!(ItemId::parse(item.id.as_str()).is_ok());
}

#[test]
fn resumes_a_persisted_completed_history() {
    let mut core = Core::new();
    let thread_id = start_thread(&mut core, 1);
    core.start_turn(CoreRequestId::new(2), thread_id.clone())
        .expect("turn starts");
    let snapshot = core
        .resume_thread(&thread_id)
        .expect("resume loaded thread");
    assert_eq!(snapshot.id, thread_id);
    assert_eq!(snapshot.turns.len(), 1);
    assert!(TurnId::parse(snapshot.turns[0].id.as_str()).is_ok());
}

#[test]
fn lists_durable_threads_without_loading_history_into_core_memory() {
    let mut core = Core::new();
    let mut created = Vec::new();
    for request_id in 1..=3 {
        created.push(start_thread(&mut core, request_id));
    }
    created.sort_unstable_by(|left, right| right.cmp(left));
    let first = core.list_threads(None, 2).expect("first page");
    assert_eq!(
        first
            .data
            .iter()
            .map(|thread| thread.id.as_str())
            .collect::<Vec<_>>(),
        [created[0].as_str(), created[1].as_str()]
    );
    let second = core
        .list_threads(first.next_cursor.as_ref(), 2)
        .expect("second page");
    assert_eq!(
        second
            .data
            .iter()
            .map(|thread| thread.id.as_str())
            .collect::<Vec<_>>(),
        [created[2].as_str()]
    );
}
