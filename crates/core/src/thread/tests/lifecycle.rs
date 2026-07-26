use super::*;

#[test]
fn starts_deterministic_threads_and_correlates_events() {
    let mut core = Core::new();

    let first_request_id = CoreRequestId::new(7);
    let first_thread_id = start_thread(&mut core, first_request_id.get());
    assert_eq!(first_thread_id.as_str(), "thr_0000000000000001");
    assert!(core.contains_thread(&first_thread_id));

    let second_thread_id = start_thread(&mut core, 8);
    assert_eq!(second_thread_id.as_str(), "thr_0000000000000002");
    assert!(core.contains_thread(&second_thread_id));
    assert_eq!(core.thread_count(), 2);
}

#[test]
fn search_returns_only_completed_matching_threads_in_descending_id_order() {
    let mut core = Core::new();
    let first = start_thread(&mut core, 1);
    core.start_turn(CoreRequestId::new(2), first.clone())
        .expect("first completed turn");
    let second = start_thread(&mut core, 3);
    core.start_turn(CoreRequestId::new(4), second.clone())
        .expect("second completed turn");
    let empty = start_thread(&mut core, 5);

    let page = core
        .search_threads("SugarCode response", None, 50)
        .expect("search");
    assert_eq!(
        page.data
            .iter()
            .map(|summary| summary.id.clone())
            .collect::<Vec<_>>(),
        [second, first]
    );
    assert!(
        page.data.iter().all(|summary| summary.id != empty),
        "empty threads are not searchable"
    );
}

#[test]
fn archive_is_idempotent_and_hides_thread_without_reusing_ids() {
    let mut core = Core::new();
    let archived = start_thread(&mut core, 1);
    core.start_turn(CoreRequestId::new(2), archived.clone())
        .expect("completed turn");

    core.archive_thread(&archived).expect("archive");
    core.archive_thread(&archived).expect("idempotent archive");
    assert!(!core.contains_thread(&archived));
    assert_eq!(
        core.resume_thread(&archived),
        Err(CoreError::ThreadNotFound(archived.clone()))
    );
    assert_eq!(
        core.start_turn(CoreRequestId::new(3), archived.clone()),
        Err(CoreError::ThreadNotFound(archived.clone()))
    );
    assert!(core.list_threads(None, 50).expect("list").data.is_empty());
    assert!(
        core.search_threads("SugarCode", None, 50)
            .expect("search")
            .data
            .is_empty()
    );

    let next = start_thread(&mut core, 4);
    assert_eq!(next.as_str(), "thr_0000000000000002");
}

#[test]
fn unarchive_is_idempotent_restores_history_and_allows_the_next_turn() {
    let mut core = Core::new();
    let thread_id = start_thread(&mut core, 1);
    core.start_turn(CoreRequestId::new(2), thread_id.clone())
        .expect("first turn");
    core.archive_thread(&thread_id).expect("archive");

    core.unarchive_thread(&thread_id).expect("unarchive");
    core.unarchive_thread(&thread_id)
        .expect("idempotent unarchive");
    assert!(core.contains_thread(&thread_id));
    assert_eq!(
        core.list_threads(None, 50).expect("list").data[0].id,
        thread_id
    );
    assert_eq!(
        core.search_threads("SugarCode", None, 50)
            .expect("search")
            .data[0]
            .id,
        thread_id
    );
    assert_eq!(
        core.resume_thread(&thread_id)
            .expect("resume restored history")
            .turns
            .len(),
        1
    );
    let events = core
        .start_turn(CoreRequestId::new(3), thread_id.clone())
        .expect("turn after unarchive");
    assert_eq!(turn_id(&events).as_str(), "turn_0000000000000002");
    assert_eq!(core.turn_count(&thread_id), 2);

    let missing = ThreadId::new("thr_0000000000000099");
    assert_eq!(
        core.unarchive_thread(&missing),
        Err(CoreError::ThreadNotFound(missing))
    );
}

#[test]
fn delete_is_terminal_idempotent_and_preserves_id_sequences() {
    let mut core = Core::new();
    let active = start_thread(&mut core, 1);
    core.start_turn(CoreRequestId::new(2), active.clone())
        .expect("active turn");
    let archived = start_thread(&mut core, 3);
    core.start_turn(CoreRequestId::new(4), archived.clone())
        .expect("archived turn");
    core.archive_thread(&archived).expect("archive");

    core.delete_thread(&active).expect("delete active");
    core.delete_thread(&active).expect("idempotent delete");
    core.delete_thread(&archived).expect("delete archived");
    assert!(!core.contains_thread(&active));
    assert!(!core.contains_thread(&archived));
    for thread_id in [&active, &archived] {
        assert_eq!(
            core.resume_thread(thread_id),
            Err(CoreError::ThreadNotFound(thread_id.clone()))
        );
        assert_eq!(
            core.archive_thread(thread_id),
            Err(CoreError::ThreadNotFound(thread_id.clone()))
        );
        assert_eq!(
            core.unarchive_thread(thread_id),
            Err(CoreError::ThreadNotFound(thread_id.clone()))
        );
        assert_eq!(
            core.start_turn(CoreRequestId::new(5), thread_id.clone()),
            Err(CoreError::ThreadNotFound(thread_id.clone()))
        );
    }
    assert!(core.list_threads(None, 50).expect("list").data.is_empty());
    assert!(
        core.search_threads("SugarCode", None, 50)
            .expect("search")
            .data
            .is_empty()
    );

    let next = start_thread(&mut core, 6);
    assert_eq!(next.as_str(), "thr_0000000000000003");
    let events = core
        .start_turn(CoreRequestId::new(7), next)
        .expect("next turn");
    assert_eq!(turn_id(&events).as_str(), "turn_0000000000000003");
    let CoreEventKind::ItemStarted { item, .. } = &events[1].kind else {
        panic!("expected item started");
    };
    assert_eq!(item.id.as_str(), "item_0000000000000003");
}

#[test]
fn fork_remaps_complete_history_and_keeps_threads_independent() {
    let mut core = Core::new();
    let source = start_thread(&mut core, 1);
    core.start_turn(CoreRequestId::new(2), source.clone())
        .expect("first source turn");
    core.start_turn(CoreRequestId::new(3), source.clone())
        .expect("second source turn");

    let fork = core.fork_thread(&source).expect("fork");
    assert_eq!(fork.id.as_str(), "thr_0000000000000002");
    assert_eq!(fork.lifecycle, DurableThreadLifecycle::Active);
    assert_eq!(fork.turns.len(), 2);
    assert_eq!(fork.turns[0].id.as_str(), "turn_0000000000000003");
    assert_eq!(fork.turns[1].id.as_str(), "turn_0000000000000004");
    assert_eq!(
        fork.turns[0].items[0].id().as_str(),
        "item_0000000000000003"
    );
    assert_eq!(
        fork.turns[1].items[0].id().as_str(),
        "item_0000000000000004"
    );
    let source_snapshot = core.resume_thread(&source).expect("source snapshot");
    let DurableItemSnapshot::AgentMessage {
        text: source_text, ..
    } = &source_snapshot.turns[0].items[0]
    else {
        panic!("expected agent message");
    };
    let DurableItemSnapshot::AgentMessage {
        text: fork_text, ..
    } = &fork.turns[0].items[0]
    else {
        panic!("expected agent message");
    };
    assert_eq!(source_text, fork_text);
    assert_ne!(source_snapshot.turns[0].id, fork.turns[0].id);
    assert_ne!(
        source_snapshot.turns[0].items[0].id(),
        fork.turns[0].items[0].id()
    );

    core.archive_thread(&source).expect("archive source");
    assert!(core.resume_thread(&source).is_err());
    assert_eq!(
        core.resume_thread(&fork.id).expect("fork stays active"),
        fork
    );
    let continued = core
        .start_turn(CoreRequestId::new(4), fork.id.clone())
        .expect("continue fork");
    assert_eq!(turn_id(&continued).as_str(), "turn_0000000000000005");
    let CoreEventKind::ItemStarted { item, .. } = &continued[1].kind else {
        panic!("expected item started");
    };
    assert_eq!(item.id.as_str(), "item_0000000000000005");
}

#[test]
fn fork_copies_completed_tool_history_and_excludes_failed_and_interrupted_tool_turns() {
    let mut core = Core::new();
    let source = start_thread(&mut core, 1);
    let completed = core
        .prepare_text_turn(
            CoreRequestId::new(2),
            source.clone(),
            Some("read".to_string()),
        )
        .expect("completed tool turn");
    core.append_completed_item(
        &source,
        &completed.turn_id,
        CoreItemKind::ToolCall {
            call_id: "call_1".to_string(),
            name: "workspace/search".to_string(),
            path: "src".to_string(),
            query: Some("needle".to_string()),
        },
    )
    .expect("tool call");
    core.append_completed_item(
        &source,
        &completed.turn_id,
        CoreItemKind::ToolResult {
            call_id: "call_1".to_string(),
            name: "workspace/read".to_string(),
            result: CoreToolResult::Success {
                content: "context".to_string(),
                bytes: 7,
            },
        },
    )
    .expect("tool result");
    core.append_text_delta(&source, &completed.turn_id, "answer")
        .expect("answer");
    core.finish_text_turn(
        &source,
        &completed.turn_id,
        DurableTurnStatus::Completed,
        None,
        None,
    )
    .expect("complete");

    let failed = core
        .prepare_text_turn(
            CoreRequestId::new(3),
            source.clone(),
            Some("excluded".to_string()),
        )
        .expect("failed tool turn");
    core.append_completed_item(
        &source,
        &failed.turn_id,
        CoreItemKind::ToolCall {
            call_id: "call_2".to_string(),
            name: "workspace/read".to_string(),
            path: "missing.txt".to_string(),
            query: None,
        },
    )
    .expect("failed call");
    core.finish_turn(
        &source,
        &failed.turn_id,
        DurableTurnStatus::Failed,
        Some(DurableTurnError {
            kind: sugarcode_state::DurableTurnErrorKind::Server,
            retryable: true,
        }),
        None,
    )
    .expect("fail turn");

    let interrupted = core
        .prepare_text_turn(
            CoreRequestId::new(4),
            source.clone(),
            Some("interrupted".to_string()),
        )
        .expect("interrupted tool turn");
    core.append_completed_item(
        &source,
        &interrupted.turn_id,
        CoreItemKind::ToolCall {
            call_id: "call_3".to_string(),
            name: "workspace/read".to_string(),
            path: "blocked.txt".to_string(),
            query: None,
        },
    )
    .expect("interrupted call");
    core.finish_turn(
        &source,
        &interrupted.turn_id,
        DurableTurnStatus::Interrupted,
        None,
        None,
    )
    .expect("interrupt turn");

    let source_snapshot = core.resume_thread(&source).expect("source");
    let fork = core.fork_thread(&source).expect("fork");
    assert_eq!(source_snapshot.turns.len(), 3);
    assert_eq!(fork.turns.len(), 1);
    assert_eq!(fork.turns[0].status, DurableTurnStatus::Completed);
    assert!(matches!(
        fork.turns[0].items.as_slice(),
        [
            DurableItemSnapshot::UserMessage { .. },
            DurableItemSnapshot::ToolCall {
                call_id,
                name,
                path,
                query,
                ..
            },
            DurableItemSnapshot::ToolResult { .. },
            DurableItemSnapshot::AgentMessage { text, .. }
        ] if call_id == "call_1"
            && name == "workspace/search"
            && path == "src"
            && query.as_deref() == Some("needle")
            && text == "answer"
    ));
    assert!(
        source_snapshot.turns[0]
            .items
            .iter()
            .zip(&fork.turns[0].items)
            .all(|(source, fork)| source.id() != fork.id())
    );
}

#[test]
fn fork_rejects_inactive_or_missing_sources_without_allocating_ids() {
    let mut core = Core::new();
    let archived = start_thread(&mut core, 1);
    core.archive_thread(&archived).expect("archive");
    assert_eq!(
        core.fork_thread(&archived),
        Err(CoreError::ThreadNotFound(archived.clone()))
    );
    let deleted = start_thread(&mut core, 2);
    core.delete_thread(&deleted).expect("delete");
    assert_eq!(
        core.fork_thread(&deleted),
        Err(CoreError::ThreadNotFound(deleted.clone()))
    );
    let missing = ThreadId::new("thr_0000000000000099");
    assert_eq!(
        core.fork_thread(&missing),
        Err(CoreError::ThreadNotFound(missing))
    );

    let next = start_thread(&mut core, 3);
    assert_eq!(next.as_str(), "thr_0000000000000003");
}

#[test]
fn fork_id_exhaustion_never_materializes_a_partial_thread() {
    let mut thread_exhausted = Core::new();
    let source = start_thread(&mut thread_exhausted, 1);
    thread_exhausted.last_thread_sequence = u64::MAX;
    assert_eq!(
        thread_exhausted.fork_thread(&source),
        Err(CoreError::ThreadIdExhausted)
    );
    assert_eq!(thread_exhausted.thread_count(), 1);

    let mut turn_exhausted = Core::new();
    let source = start_thread(&mut turn_exhausted, 1);
    turn_exhausted
        .start_turn(CoreRequestId::new(2), source.clone())
        .expect("source turn");
    turn_exhausted.last_turn_sequence = u64::MAX;
    assert_eq!(
        turn_exhausted.fork_thread(&source),
        Err(CoreError::TurnIdExhausted)
    );
    assert_eq!(turn_exhausted.thread_count(), 1);

    let mut item_exhausted = Core::new();
    let source = start_thread(&mut item_exhausted, 1);
    item_exhausted
        .start_turn(CoreRequestId::new(2), source.clone())
        .expect("source turn");
    item_exhausted.last_item_sequence = u64::MAX;
    assert_eq!(
        item_exhausted.fork_thread(&source),
        Err(CoreError::ItemIdExhausted)
    );
    assert_eq!(item_exhausted.thread_count(), 1);
}
