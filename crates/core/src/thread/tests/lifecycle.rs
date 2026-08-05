use super::*;

#[test]
fn starts_uuid_threads_and_correlates_events() {
    let mut core = Core::new();

    let first_request_id = CoreRequestId::new(7);
    let first_thread_id = start_thread(&mut core, first_request_id.get());
    assert!(ThreadId::parse(first_thread_id.as_str()).is_ok());
    assert!(core.contains_thread(&first_thread_id));

    let second_thread_id = start_thread(&mut core, 8);
    assert!(ThreadId::parse(second_thread_id.as_str()).is_ok());
    assert_ne!(first_thread_id, second_thread_id);
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
    assert!(ThreadId::parse(next.as_str()).is_ok());
    assert_ne!(next, archived);
}

#[test]
fn unarchive_is_idempotent_restores_history_and_allows_the_next_turn() {
    let mut core = Core::new();
    let thread_id = start_thread(&mut core, 1);
    let first = core
        .start_turn(CoreRequestId::new(2), thread_id.clone())
        .expect("first turn");
    let first_turn_id = turn_id(&first);
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
    let next_turn_id = turn_id(&events);
    assert!(TurnId::parse(next_turn_id.as_str()).is_ok());
    assert_ne!(next_turn_id, first_turn_id);
    assert_eq!(core.turn_count(&thread_id), 2);

    let missing =
        ThreadId::parse("00000000-0000-7000-8000-000000000099").expect("valid thread UUIDv7");
    assert_eq!(
        core.unarchive_thread(&missing),
        Err(CoreError::ThreadNotFound(missing))
    );
}

#[test]
fn delete_is_terminal_and_idempotent() {
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
    assert!(ThreadId::parse(next.as_str()).is_ok());
    assert_ne!(next, active);
    assert_ne!(next, archived);
    let events = core
        .start_turn(CoreRequestId::new(7), next)
        .expect("next turn");
    assert!(TurnId::parse(turn_id(&events).as_str()).is_ok());
    let CoreEventKind::ItemStarted { item, .. } = &events[1].kind else {
        panic!("expected item started");
    };
    assert!(ItemId::parse(item.id.as_str()).is_ok());
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
    assert!(ThreadId::parse(fork.id.as_str()).is_ok());
    assert_ne!(fork.id, source);
    assert_eq!(fork.lifecycle, DurableThreadLifecycle::Active);
    assert_eq!(fork.turns.len(), 2);
    assert!(
        fork.turns
            .iter()
            .all(|turn| TurnId::parse(turn.id.as_str()).is_ok())
    );
    assert_ne!(fork.turns[0].id, fork.turns[1].id);
    assert!(fork.turns.iter().all(|turn| {
        turn.items
            .iter()
            .all(|item| ItemId::parse(item.id().as_str()).is_ok())
    }));
    assert_ne!(fork.turns[0].items[0].id(), fork.turns[1].items[0].id());
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
    let continued_turn_id = turn_id(&continued);
    assert!(TurnId::parse(continued_turn_id.as_str()).is_ok());
    assert!(fork.turns.iter().all(|turn| turn.id != continued_turn_id));
    let CoreEventKind::ItemStarted { item, .. } = &continued[1].kind else {
        panic!("expected item started");
    };
    assert!(ItemId::parse(item.id.as_str()).is_ok());
    assert!(
        fork.turns
            .iter()
            .flat_map(|turn| &turn.items)
            .all(|fork_item| fork_item.id() != &item.id)
    );
}

#[test]
fn fork_remaps_a_completed_compaction_boundary_without_rewriting_the_summary() {
    let mut core = Core::new();
    let source = start_thread(&mut core, 1);
    let maximum_output = "x".repeat(LARGE_AGENT_OUTPUT_BYTES);
    for request in 2..=7 {
        let prepared = core
            .prepare_text_turn(
                CoreRequestId::new(request),
                source.clone(),
                Some("u".to_string()),
            )
            .expect("prepare source history");
        core.append_text_delta(&source, &prepared.turn_id, &maximum_output)
            .expect("append source output");
        core.finish_text_turn(
            &source,
            &prepared.turn_id,
            DurableTurnStatus::Completed,
            None,
            None,
        )
        .expect("complete source turn");
    }
    let compacted = core
        .prepare_text_turn(
            CoreRequestId::new(8),
            source.clone(),
            Some("checkpoint".to_string()),
        )
        .expect("prepare compacted turn");
    core.start_agent_message(&source, &compacted.turn_id)
        .expect("start answer");
    core.append_text_delta(&source, &compacted.turn_id, "answer")
        .expect("append answer");
    core.finish_text_turn(
        &source,
        &compacted.turn_id,
        DurableTurnStatus::Completed,
        None,
        None,
    )
    .expect("complete checkpoint turn");

    let source_snapshot = core.resume_thread(&source).expect("source snapshot");
    let source_checkpoint = source_snapshot.turns[6]
        .context_compaction
        .as_ref()
        .expect("source checkpoint");
    let fork = core.fork_thread(&source).expect("fork");
    let fork_checkpoint = fork.turns[6]
        .context_compaction
        .as_ref()
        .expect("fork checkpoint");

    assert_eq!(
        source_checkpoint.through_turn_id,
        source_snapshot.turns[5].id
    );
    assert_eq!(fork_checkpoint.through_turn_id, fork.turns[5].id);
    assert_ne!(
        source_checkpoint.through_turn_id,
        fork_checkpoint.through_turn_id
    );
    assert_eq!(source_checkpoint.message, fork_checkpoint.message);
    assert_eq!(
        source_checkpoint.message_sha256,
        fork_checkpoint.message_sha256
    );
    assert_eq!(
        source_checkpoint.source_sha256,
        fork_checkpoint.source_sha256
    );
}

#[test]
fn fork_preserves_workspace_instruction_audit_without_any_instruction_content() {
    let mut core = Core::new();
    let source = start_thread(&mut core, 1);
    let audit = DurableWorkspaceInstructionsAudit {
        source: sugarcode_state::DurableWorkspaceInstructionsSource::RootToActiveScopeAgentsMdV1,
        status: sugarcode_state::DurableWorkspaceInstructionsStatus::Present,
        bytes: Some(19),
        sha256: Some("b".repeat(64)),
    };
    let prepared = core
        .prepare_text_turn_with_workspace_instructions(
            CoreRequestId::new(2),
            source.clone(),
            Some("hello".to_string()),
            Some(audit.clone()),
            19,
            0,
        )
        .expect("prepare source turn");
    core.start_agent_message(&source, &prepared.turn_id)
        .expect("start answer");
    core.append_text_delta(&source, &prepared.turn_id, "answer")
        .expect("append answer");
    core.finish_text_turn(
        &source,
        &prepared.turn_id,
        DurableTurnStatus::Completed,
        None,
        None,
    )
    .expect("finish source turn");

    let fork = core.fork_thread(&source).expect("fork");
    assert_eq!(fork.turns.len(), 1);
    assert_eq!(fork.turns[0].workspace_instructions, Some(audit));
}

#[test]
fn fork_preserves_workspace_skills_audit_without_rediscovery() {
    let mut core = Core::new();
    let source = start_thread(&mut core, 1);
    let audit = sugarcode_state::DurableWorkspaceSkillsAudit {
        source: sugarcode_state::DurableWorkspaceSkillsSource::RootToActiveScopeAgentsSkillsV1,
        status: sugarcode_state::DurableWorkspaceSkillsStatus::Present,
        discovered_count: 2,
        effective_count: 1,
        selected_count: 1,
        source_bytes: 80,
        inventory_bytes: 24,
        selected_bytes: 40,
        manifest_sha256: "c".repeat(64),
        selection_sha256: Some("d".repeat(64)),
    };
    let prepared = core
        .prepare_text_turn_with_context(
            CoreRequestId::new(2),
            source.clone(),
            Some("use $review".to_string()),
            None,
            Some(audit.clone()),
            64,
            0,
        )
        .expect("prepare source turn");
    core.start_agent_message(&source, &prepared.turn_id)
        .expect("start answer");
    core.append_text_delta(&source, &prepared.turn_id, "answer")
        .expect("append answer");
    core.finish_text_turn(
        &source,
        &prepared.turn_id,
        DurableTurnStatus::Completed,
        None,
        None,
    )
    .expect("finish source turn");

    let fork = core.fork_thread(&source).expect("fork");
    assert_eq!(fork.turns.len(), 1);
    assert_eq!(fork.turns[0].workspace_skills, Some(audit));
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
            arguments: serde_json::json!({"path": "src", "query": "needle"}),
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
            arguments: serde_json::json!({"path": "missing.txt"}),
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
            provider: None,
            protocol: None,
            tool_schema: None,
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
            arguments: serde_json::json!({"path": "blocked.txt"}),
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
                arguments,
                ..
            },
            DurableItemSnapshot::ToolResult { .. },
            DurableItemSnapshot::AgentMessage { text, .. }
        ] if call_id == "call_1"
            && name == "workspace/search"
            && arguments == &serde_json::json!({"path": "src", "query": "needle"})
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
fn fork_rejects_inactive_or_missing_sources() {
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
    let missing =
        ThreadId::parse("00000000-0000-7000-8000-000000000099").expect("valid thread UUIDv7");
    assert_eq!(
        core.fork_thread(&missing),
        Err(CoreError::ThreadNotFound(missing))
    );

    let next = start_thread(&mut core, 3);
    assert!(ThreadId::parse(next.as_str()).is_ok());
    assert_ne!(next, archived);
    assert_ne!(next, deleted);
}
