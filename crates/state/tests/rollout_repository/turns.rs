use super::*;

#[test]
fn persists_and_replays_completed_thread_history() {
    let directory = tempdir().expect("home");
    let home = resolve_sugarcode_home(HomeResolutionInputs {
        cli_override: Some(directory.path().to_path_buf()),
        ..Default::default()
    })
    .expect("resolve home");
    let thread_id = ThreadId::new("thr_0000000000000001");

    {
        let mut repository = RolloutRepository::open(&home).expect("open repository");
        repository
            .create_thread(&thread_id)
            .expect("persist thread");
        repository
            .append_completed_turn(&thread_id, &completed_turn(1))
            .expect("persist turn");
    }

    let repository = RolloutRepository::open(&home).expect("reopen repository");
    let history = repository
        .load_thread(&thread_id)
        .expect("load thread")
        .expect("thread exists");
    assert_eq!(history.id, thread_id);
    assert_eq!(history.turns, vec![completed_turn(1)]);
    assert_eq!(repository.id_sequences().thread, 1);
    assert_eq!(repository.id_sequences().turn, 1);
    assert_eq!(repository.id_sequences().item, 1);
}

#[test]
fn replay_accepts_globally_unique_incremental_items_out_of_file_order() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let earlier_file = ThreadId::new("thr_0000000000000001");
    let later_file = ThreadId::new("thr_0000000000000002");

    let later_turn = DurableTurnSnapshot {
        model: None,
        id: TurnId::new("turn_0000000000000001"),
        status: DurableTurnStatus::Completed,
        items: vec![
            DurableItemSnapshot::UserMessage {
                id: ItemId::new("item_0000000000000001"),
                text: "Review the child task.".to_string(),
            },
            DurableItemSnapshot::AgentCommentary {
                id: ItemId::new("item_0000000000000002"),
                text: "Inspecting the child task.".to_string(),
            },
        ],
        context_compaction: None,
        workspace_instructions: None,
        workspace_skills: None,
        error: None,
        usage: None,
    };
    let earlier_turn = DurableTurnSnapshot {
        model: None,
        id: TurnId::new("turn_0000000000000002"),
        status: DurableTurnStatus::Completed,
        items: vec![
            DurableItemSnapshot::UserMessage {
                id: ItemId::new("item_0000000000000003"),
                text: "Continue the parent task.".to_string(),
            },
            DurableItemSnapshot::AgentCommentary {
                id: ItemId::new("item_0000000000000004"),
                text: "Continuing the parent task.".to_string(),
            },
        ],
        context_compaction: None,
        workspace_instructions: None,
        workspace_skills: None,
        error: None,
        usage: None,
    };

    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository
            .create_thread(&earlier_file)
            .expect("earlier rollout file");
        repository
            .create_thread(&later_file)
            .expect("later rollout file");
        for (thread_id, turn) in [(&later_file, &later_turn), (&earlier_file, &earlier_turn)] {
            repository
                .begin_turn(
                    thread_id,
                    &DurableTurnSnapshot {
                        model: None,
                        status: DurableTurnStatus::InProgress,
                        items: vec![turn.items[0].clone()],
                        ..turn.clone()
                    },
                )
                .expect("begin turn");
            repository
                .append_turn_item(thread_id, &turn.id, &turn.items[1])
                .expect("append incremental item");
            repository
                .complete_turn_item(thread_id, &turn.id, &turn.items[1])
                .expect("complete incremental item");
            repository
                .finish_turn(thread_id, turn)
                .expect("finish turn");
        }
    }

    let repository = RolloutRepository::open(&home).expect("replay out-of-order files");
    assert_eq!(repository.id_sequences().item, 4);
    assert_eq!(
        repository
            .load_thread(&earlier_file)
            .expect("load earlier file")
            .expect("earlier thread")
            .turns,
        vec![earlier_turn]
    );
    assert_eq!(
        repository
            .load_thread(&later_file)
            .expect("load later file")
            .expect("later thread")
            .turns,
        vec![later_turn]
    );
}

#[test]
fn commentary_round_trips_through_the_jsonl_rollout() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    let turn = DurableTurnSnapshot {
        model: None,
        id: TurnId::new("turn_0000000000000001"),
        status: DurableTurnStatus::Completed,
        items: vec![
            DurableItemSnapshot::UserMessage {
                id: ItemId::new("item_0000000000000001"),
                text: "Inspect the workspace.".to_string(),
            },
            DurableItemSnapshot::AgentCommentary {
                id: ItemId::new("item_0000000000000002"),
                text: "I will inspect the workspace first.".to_string(),
            },
            DurableItemSnapshot::ToolCall {
                id: ItemId::new("item_0000000000000003"),
                call_id: "call_1".to_string(),
                name: "workspace/read".to_string(),
                path: "README.md".to_string(),
                query: None,
                patch: None,
                command: None,
                arguments: None,
            },
            DurableItemSnapshot::ToolResult {
                id: ItemId::new("item_0000000000000004"),
                call_id: "call_1".to_string(),
                name: "workspace/read".to_string(),
                result: DurableToolResult::Success {
                    content: "workspace".to_string(),
                    bytes: 9,
                },
            },
            DurableItemSnapshot::AgentMessage {
                id: ItemId::new("item_0000000000000005"),
                text: "Done.".to_string(),
            },
        ],
        context_compaction: None,
        workspace_instructions: None,
        workspace_skills: None,
        error: None,
        usage: None,
    };
    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&thread_id).expect("thread");
        repository
            .append_completed_turn(&thread_id, &turn)
            .expect("commentary turn");
    }

    let rollout = fs::read_to_string(
        directory
            .path()
            .join("rollouts/v1/thr_0000000000000001.jsonl"),
    )
    .expect("rollout");
    assert!(rollout.contains("\"type\":\"agentCommentary\""));
    let repository = RolloutRepository::open(&home).expect("replay");
    assert_eq!(
        repository
            .load_thread(&thread_id)
            .expect("load")
            .expect("thread")
            .turns,
        vec![turn]
    );
}

#[test]
fn collaboration_items_round_trip_through_incremental_rollout_records() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    let turn_id = TurnId::new("turn_0000000000000001");
    let user = DurableItemSnapshot::UserMessage {
        id: ItemId::new("item_0000000000000001"),
        text: "Review the project.".to_string(),
    };
    let collaboration_items = vec![
        DurableItemSnapshot::AgentTask {
            id: ItemId::new("item_0000000000000002"),
            orchestration_id: "orch/1".to_string(),
            task_id: "orch/1/explore".to_string(),
            client_task_key: "explore".to_string(),
            child_thread_id: ThreadId::new("thr_0000000000000002"),
            title: "Explore".to_string(),
            role: "explorer".to_string(),
            access: "readOnly".to_string(),
            depends_on: Vec::new(),
            task_markdown: "# Objective\nExplore.".to_string(),
        },
        DurableItemSnapshot::AgentTaskAmendment {
            id: ItemId::new("item_0000000000000003"),
            orchestration_id: "orch/1".to_string(),
            task_id: "orch/1/explore".to_string(),
            amendment_markdown: "Inspect tests too.".to_string(),
        },
        DurableItemSnapshot::AgentTaskResult {
            id: ItemId::new("item_0000000000000004"),
            orchestration_id: "orch/1".to_string(),
            task_id: "orch/1/explore".to_string(),
            status: "completed".to_string(),
            summary_markdown: "Reviewed.".to_string(),
            duration_ms: 12,
        },
    ];
    let completed = DurableTurnSnapshot {
        model: None,
        id: turn_id.clone(),
        status: DurableTurnStatus::Completed,
        items: std::iter::once(user.clone())
            .chain(collaboration_items.clone())
            .collect(),
        context_compaction: None,
        workspace_instructions: None,
        workspace_skills: None,
        error: None,
        usage: None,
    };
    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&thread_id).expect("thread");
        repository
            .begin_turn(
                &thread_id,
                &DurableTurnSnapshot {
                    model: None,
                    id: turn_id.clone(),
                    status: DurableTurnStatus::InProgress,
                    items: vec![user],
                    context_compaction: None,
                    workspace_instructions: None,
                    workspace_skills: None,
                    error: None,
                    usage: None,
                },
            )
            .expect("turn start");
        for item in &collaboration_items {
            repository
                .append_turn_item(&thread_id, &turn_id, item)
                .expect("start collaboration item");
            repository
                .complete_turn_item(&thread_id, &turn_id, item)
                .expect("complete collaboration item");
        }
        repository
            .finish_turn(&thread_id, &completed)
            .expect("finish turn");
    }

    let repository = RolloutRepository::open(&home).expect("reopen");
    assert_eq!(
        repository
            .load_thread(&thread_id)
            .expect("load")
            .expect("thread")
            .turns,
        vec![completed]
    );
}

#[test]
fn incremental_item_records_replay_turn_content_above_the_old_terminal_limit() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    let mut items = vec![DurableItemSnapshot::UserMessage {
        id: ItemId::new("item_0000000000000001"),
        text: "Read several large bounded results.".to_string(),
    }];
    let content = "x".repeat(300 * 1024);
    for ordinal in 1..=4u64 {
        let item_sequence = ordinal * 2;
        let call_id = format!("call_{ordinal}");
        items.push(DurableItemSnapshot::ToolCall {
            id: ItemId::new(format!("item_{item_sequence:016}")),
            call_id: call_id.clone(),
            name: "workspace/read".to_string(),
            path: format!("file-{ordinal}.txt"),
            query: None,
            patch: None,
            command: None,
            arguments: None,
        });
        items.push(DurableItemSnapshot::ToolResult {
            id: ItemId::new(format!("item_{:016}", item_sequence + 1)),
            call_id,
            name: "workspace/read".to_string(),
            result: DurableToolResult::Success {
                content: content.clone(),
                bytes: content.len() as u64,
            },
        });
    }
    items.push(DurableItemSnapshot::AgentMessage {
        id: ItemId::new("item_0000000000000010"),
        text: "Done.".to_string(),
    });
    let turn = DurableTurnSnapshot {
        model: None,
        id: TurnId::new("turn_0000000000000001"),
        status: DurableTurnStatus::Completed,
        items,
        context_compaction: None,
        workspace_instructions: None,
        workspace_skills: None,
        error: None,
        usage: None,
    };
    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&thread_id).expect("thread");
        repository
            .append_completed_turn(&thread_id, &turn)
            .expect("large incremental turn");
    }
    let path = directory
        .path()
        .join("rollouts/v1/thr_0000000000000001.jsonl");
    let records = fs::read_to_string(path).expect("rollout");
    assert!(records.len() > 1024 * 1024);
    let terminal = records.lines().last().expect("terminal record");
    assert!(terminal.contains("\"type\":\"turnCompleted\""));
    assert!(terminal.contains("\"items\":[]"));

    let repository = RolloutRepository::open(&home).expect("replay");
    assert_eq!(
        repository
            .load_thread(&thread_id)
            .expect("load")
            .expect("thread")
            .turns,
        vec![turn]
    );
}

#[test]
fn an_unfinished_started_turn_replays_as_one_interrupted_terminal() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&thread_id).expect("thread");
        repository
            .begin_turn(&thread_id, &started_text_turn())
            .expect("durable turn start");
    }

    let repository = RolloutRepository::open(&home).expect("reopen");
    let snapshot = repository
        .load_thread(&thread_id)
        .expect("load")
        .expect("thread");
    assert_eq!(snapshot.turns.len(), 1);
    assert_eq!(snapshot.turns[0].status, DurableTurnStatus::Interrupted);
    assert_eq!(snapshot.turns[0].items.len(), 2);
    assert!(snapshot.turns[0].error.is_none());
    assert!(
        repository
            .diagnostics()
            .iter()
            .any(|diagnostic| diagnostic.kind == "danglingTurnRecovered")
    );
    drop(repository);

    let rollout = directory
        .path()
        .join("rollouts/v1/thr_0000000000000001.jsonl");
    let records = fs::read_to_string(&rollout).expect("read recovered rollout");
    assert_eq!(records.lines().count(), 7);
    assert!(records.contains("\"type\":\"turnItemStarted\""));
    assert!(records.contains("\"type\":\"turnItemCompleted\""));
    let reopened = RolloutRepository::open(&home).expect("reopen recovered repository");
    assert!(
        !reopened
            .diagnostics()
            .iter()
            .any(|diagnostic| diagnostic.kind == "danglingTurnRecovered")
    );
}

#[test]
fn an_unfinished_checkpoint_is_retained_for_audit_but_remains_interrupted() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    let prior = completed_turn(1);
    let checkpoint =
        sugarcode_state::build_context_compaction(std::slice::from_ref(&prior), 3_200_000, 30_000)
            .expect("checkpoint");
    let started = DurableTurnSnapshot {
        model: None,
        id: TurnId::new("turn_0000000000000002"),
        status: DurableTurnStatus::InProgress,
        items: vec![DurableItemSnapshot::UserMessage {
            id: ItemId::new("item_0000000000000002"),
            text: "continue".to_string(),
        }],
        context_compaction: Some(checkpoint.clone()),
        workspace_instructions: None,
        workspace_skills: None,
        error: None,
        usage: None,
    };
    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&thread_id).expect("thread");
        repository
            .append_completed_turn(&thread_id, &prior)
            .expect("prior turn");
        repository
            .begin_turn(&thread_id, &started)
            .expect("checkpoint start");
    }

    let repository = RolloutRepository::open(&home).expect("recover");
    let snapshot = repository
        .load_thread(&thread_id)
        .expect("load")
        .expect("thread");
    assert_eq!(snapshot.turns.len(), 2);
    assert_eq!(snapshot.turns[1].status, DurableTurnStatus::Interrupted);
    assert_eq!(
        snapshot.turns[1].context_compaction.as_ref(),
        Some(&checkpoint)
    );
    assert!(
        repository
            .diagnostics()
            .iter()
            .any(|diagnostic| diagnostic.kind == "danglingTurnRecovered")
    );
}

#[test]
fn workspace_instruction_audit_survives_recovery_without_persisting_content() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    let audit = DurableWorkspaceInstructionsAudit {
        source: DurableWorkspaceInstructionsSource::RootAgentsMdV1,
        status: DurableWorkspaceInstructionsStatus::Present,
        bytes: Some(24),
        sha256: Some("a".repeat(64)),
    };
    let mut started = started_text_turn();
    started.workspace_instructions = Some(audit.clone());
    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&thread_id).expect("thread");
        repository
            .begin_turn(&thread_id, &started)
            .expect("durable turn start");
    }

    let repository = RolloutRepository::open(&home).expect("recover");
    let snapshot = repository
        .load_thread(&thread_id)
        .expect("load")
        .expect("thread");
    assert_eq!(snapshot.turns[0].status, DurableTurnStatus::Interrupted);
    assert_eq!(
        snapshot.turns[0].workspace_instructions.as_ref(),
        Some(&audit)
    );
    drop(repository);

    let rollout = fs::read_to_string(
        directory
            .path()
            .join("rollouts/v1/thr_0000000000000001.jsonl"),
    )
    .expect("rollout");
    assert!(rollout.contains("\"workspaceInstructions\""));
    assert!(rollout.contains("\"rootAgentsMdV1\""));
    assert!(rollout.contains(&"a".repeat(64)));
    assert!(!rollout.contains("private workspace instruction"));
    assert!(!rollout.contains("\"content\""));
}

#[test]
fn an_unfinished_active_compaction_is_completed_as_interrupted_before_recovery_terminal() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    let turn_id = TurnId::new("turn_0000000000000001");
    let compaction = DurableItemSnapshot::ContextCompaction {
        id: ItemId::new("item_0000000000000002"),
        strategy: "modelGeneratedActiveTurnV1".to_string(),
        ordinal: 1,
        pre_context_bytes: 3_200_000,
        source_messages: 1,
        source_bytes: 64,
        source_sha256: "a".repeat(64),
        outcome: None,
        summary: None,
    };
    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&thread_id).expect("thread");
        repository
            .begin_turn(
                &thread_id,
                &DurableTurnSnapshot {
                    model: None,
                    id: turn_id.clone(),
                    status: DurableTurnStatus::InProgress,
                    items: vec![DurableItemSnapshot::UserMessage {
                        id: ItemId::new("item_0000000000000001"),
                        text: "Continue after compaction.".to_string(),
                    }],
                    context_compaction: None,
                    workspace_instructions: None,
                    workspace_skills: None,
                    error: None,
                    usage: None,
                },
            )
            .expect("turn start");
        repository
            .append_turn_item(&thread_id, &turn_id, &compaction)
            .expect("compaction start");
    }

    let repository = RolloutRepository::open(&home).expect("recovery");
    let recovered = repository
        .load_thread(&thread_id)
        .expect("load")
        .expect("thread");
    assert!(matches!(
        &recovered.turns[0].items[1],
        DurableItemSnapshot::ContextCompaction {
            outcome: Some(sugarcode_state::DurableActiveTurnCompactionOutcome::Interrupted),
            summary: None,
            ..
        }
    ));
    drop(repository);

    let records = fs::read_to_string(
        directory
            .path()
            .join("rollouts/v1/thr_0000000000000001.jsonl"),
    )
    .expect("rollout")
    .lines()
    .map(|line| serde_json::from_str::<serde_json::Value>(line).expect("record"))
    .collect::<Vec<_>>();
    assert_eq!(records[records.len() - 2]["type"], "turnItemCompleted");
    assert_eq!(
        records[records.len() - 2]["item"]["outcome"]["type"],
        "interrupted"
    );
    assert_eq!(records.last().expect("terminal")["type"], "turnCompleted");

    let reopened = RolloutRepository::open(&home).expect("stable replay");
    assert!(
        !reopened
            .diagnostics()
            .iter()
            .any(|diagnostic| diagnostic.kind == "danglingTurnRecovered")
    );
}

#[test]
fn nested_workspace_manifest_audit_survives_recovery_without_scope_or_content() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    let audit = DurableWorkspaceInstructionsAudit {
        source: DurableWorkspaceInstructionsSource::RootToActiveScopeAgentsMdV1,
        status: DurableWorkspaceInstructionsStatus::Present,
        bytes: Some(31),
        sha256: Some("b".repeat(64)),
    };
    let mut started = started_text_turn();
    started.workspace_instructions = Some(audit.clone());
    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&thread_id).expect("thread");
        repository
            .begin_turn(&thread_id, &started)
            .expect("durable turn start");
    }

    let repository = RolloutRepository::open(&home).expect("recover");
    let snapshot = repository
        .load_thread(&thread_id)
        .expect("load")
        .expect("thread");
    assert_eq!(snapshot.turns[0].status, DurableTurnStatus::Interrupted);
    assert_eq!(
        snapshot.turns[0].workspace_instructions.as_ref(),
        Some(&audit)
    );
    drop(repository);

    let rollout = fs::read_to_string(
        directory
            .path()
            .join("rollouts/v1/thr_0000000000000001.jsonl"),
    )
    .expect("rollout");
    assert!(rollout.contains("\"rootToActiveScopeAgentsMdV1\""));
    assert!(rollout.contains(&"b".repeat(64)));
    assert!(!rollout.contains("projects/active"));
    assert!(!rollout.contains("private nested instruction"));
}

#[test]
fn workspace_skills_audit_survives_recovery_without_inventory_path_or_content() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    let audit = DurableWorkspaceSkillsAudit {
        source: DurableWorkspaceSkillsSource::RootToActiveScopeAgentsSkillsV1,
        status: DurableWorkspaceSkillsStatus::Present,
        discovered_count: 2,
        effective_count: 1,
        selected_count: 1,
        source_bytes: 80,
        inventory_bytes: 24,
        selected_bytes: 40,
        manifest_sha256: "c".repeat(64),
        selection_sha256: Some("d".repeat(64)),
    };
    let mut started = started_text_turn();
    started.workspace_skills = Some(audit.clone());
    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&thread_id).expect("thread");
        repository
            .begin_turn(&thread_id, &started)
            .expect("durable turn start");
    }

    let repository = RolloutRepository::open(&home).expect("recover");
    let snapshot = repository
        .load_thread(&thread_id)
        .expect("load")
        .expect("thread");
    assert_eq!(snapshot.turns[0].status, DurableTurnStatus::Interrupted);
    assert_eq!(snapshot.turns[0].workspace_skills.as_ref(), Some(&audit));
    drop(repository);

    let rollout = fs::read_to_string(
        directory
            .path()
            .join("rollouts/v1/thr_0000000000000001.jsonl"),
    )
    .expect("rollout");
    assert!(rollout.contains("\"workspaceSkills\""));
    assert!(rollout.contains("\"rootToActiveScopeAgentsSkillsV1\""));
    assert!(!rollout.contains(".agents/skills"));
    assert!(!rollout.contains("private skill body"));
    assert!(!rollout.contains("Review changes"));
}

#[test]
fn an_empty_inputless_started_turn_replays_as_one_interrupted_terminal() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&thread_id).expect("thread");
        repository
            .begin_turn(
                &thread_id,
                &DurableTurnSnapshot {
                    model: None,
                    id: TurnId::new("turn_0000000000000001"),
                    status: DurableTurnStatus::InProgress,
                    items: Vec::new(),
                    context_compaction: None,
                    workspace_instructions: None,
                    workspace_skills: None,
                    error: None,
                    usage: None,
                },
            )
            .expect("empty continue start");
    }

    let repository = RolloutRepository::open(&home).expect("recover");
    let turn = &repository
        .load_thread(&thread_id)
        .expect("load")
        .expect("thread")
        .turns[0];
    assert_eq!(turn.status, DurableTurnStatus::Interrupted);
    assert!(turn.items.is_empty());
    drop(repository);
    RolloutRepository::open(&home).expect("reopen recovered terminal");
}

#[test]
fn a_durable_tool_call_query_survives_recovery_without_an_unwritten_result() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    let turn_id = TurnId::new("turn_0000000000000001");
    let tool_call = DurableItemSnapshot::ToolCall {
        id: ItemId::new("item_0000000000000002"),
        call_id: "call_1".to_string(),
        name: "workspace/search".to_string(),
        path: "src".to_string(),
        query: Some("needle".to_string()),
        patch: None,
        command: None,
        arguments: None,
    };
    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&thread_id).expect("thread");
        repository
            .begin_turn(
                &thread_id,
                &DurableTurnSnapshot {
                    model: None,
                    id: turn_id.clone(),
                    status: DurableTurnStatus::InProgress,
                    items: vec![DurableItemSnapshot::UserMessage {
                        id: ItemId::new("item_0000000000000001"),
                        text: "Read it".to_string(),
                    }],
                    context_compaction: None,
                    workspace_instructions: None,
                    workspace_skills: None,
                    error: None,
                    usage: None,
                },
            )
            .expect("turn start");
        repository
            .append_turn_item(&thread_id, &turn_id, &tool_call)
            .expect("durable tool call");
    }

    let repository = RolloutRepository::open(&home).expect("recover");
    let snapshot = repository
        .load_thread(&thread_id)
        .expect("load")
        .expect("thread");
    assert_eq!(snapshot.turns.len(), 1);
    assert_eq!(snapshot.turns[0].status, DurableTurnStatus::Interrupted);
    assert_eq!(snapshot.turns[0].items.last(), Some(&tool_call));
    assert!(
        !snapshot.turns[0]
            .items
            .iter()
            .any(|item| matches!(item, DurableItemSnapshot::ToolResult { .. }))
    );
    assert_eq!(repository.id_sequences().item, 2);
}

#[test]
fn shell_approval_audit_and_process_result_survive_recovery() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    let turn_id = TurnId::new("turn_0000000000000001");
    let user = DurableItemSnapshot::UserMessage {
        id: ItemId::new("item_0000000000000001"),
        text: "Run it".to_string(),
    };
    let incremental = vec![
        DurableItemSnapshot::ToolCall {
            id: ItemId::new("item_0000000000000002"),
            call_id: "call_shell".to_string(),
            name: "shell/exec".to_string(),
            path: ".".to_string(),
            query: None,
            patch: None,
            command: Some("/bin/echo".to_string()),
            arguments: Some(vec!["ok".to_string()]),
        },
        DurableItemSnapshot::CommandApprovalRequest {
            id: ItemId::new("item_0000000000000003"),
            approval_id: "approval/one".to_string(),
            call_id: "call_shell".to_string(),
            command: "/bin/echo".to_string(),
            arguments: vec!["ok".to_string()],
            cwd: ".".to_string(),
            environment_policy: "minimalV1".to_string(),
            sandboxed: true,
            sandbox_policy: Some("filesystemReadOnlyV1".to_string()),
            workspace_write_policy: None,
            network_policy: Some("networkDeniedV1".to_string()),
            workspace_write_risk: None,
        },
        DurableItemSnapshot::CommandApprovalDecision {
            id: ItemId::new("item_0000000000000004"),
            approval_id: "approval/one".to_string(),
            decision: "approved".to_string(),
            workspace_write_risk_acknowledgement: None,
        },
        DurableItemSnapshot::ToolResult {
            id: ItemId::new("item_0000000000000005"),
            call_id: "call_shell".to_string(),
            name: "shell/exec".to_string(),
            result: DurableToolResult::Process(DurableProcessResult {
                stdout: "ok\n".to_string(),
                stderr: String::new(),
                stdout_bytes: 3,
                stderr_bytes: 0,
                stdout_truncated: false,
                stderr_truncated: false,
                encoding: "utf8Lossy".to_string(),
                duration_ms: 2,
                outcome: DurableProcessOutcome::ExitCode { code: 0 },
                sandbox_policy: Some("filesystemReadOnlyV1".to_string()),
                workspace_write_policy: None,
                network_policy: Some("networkDeniedV1".to_string()),
            }),
        },
    ];
    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&thread_id).expect("thread");
        repository
            .begin_turn(
                &thread_id,
                &DurableTurnSnapshot {
                    model: None,
                    id: turn_id.clone(),
                    status: DurableTurnStatus::InProgress,
                    items: vec![user.clone()],
                    context_compaction: None,
                    workspace_instructions: None,
                    workspace_skills: None,
                    error: None,
                    usage: None,
                },
            )
            .expect("turn start");
        for item in &incremental {
            repository
                .append_turn_item(&thread_id, &turn_id, item)
                .expect("append shell item");
        }
        let mut items = vec![user.clone()];
        items.extend(incremental.clone());
        repository
            .finish_turn(
                &thread_id,
                &DurableTurnSnapshot {
                    model: None,
                    id: turn_id.clone(),
                    status: DurableTurnStatus::Completed,
                    items,
                    context_compaction: None,
                    workspace_instructions: None,
                    workspace_skills: None,
                    error: None,
                    usage: None,
                },
            )
            .expect("finish shell turn");
    }

    let repository = RolloutRepository::open(&home).expect("reopen");
    let snapshot = repository
        .load_thread(&thread_id)
        .expect("load")
        .expect("thread");
    assert_eq!(snapshot.turns[0].items[1..], incremental);
    drop(repository);

    let rollout = directory
        .path()
        .join("rollouts/v1/thr_0000000000000001.jsonl");
    let legacy = fs::read_to_string(&rollout)
        .expect("read rollout")
        .lines()
        .map(|line| {
            let mut record =
                serde_json::from_str::<serde_json::Value>(line).expect("parse rollout record");
            remove_command_policy_fields(&mut record);
            serde_json::to_string(&record).expect("serialize legacy rollout record")
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    assert!(!legacy.contains("networkDeniedV1"), "{legacy}");
    fs::write(&rollout, legacy).expect("rewrite legacy rollout fixture");
    let repository = RolloutRepository::open(&home).expect("reopen legacy rollout");
    let snapshot = repository
        .load_thread(&thread_id)
        .expect("load legacy rollout")
        .expect("legacy thread");
    assert!(
        matches!(
            &snapshot.turns[0].items[2],
            DurableItemSnapshot::CommandApprovalRequest {
                sandbox_policy: None,
                network_policy: None,
                ..
            }
        ),
        "{:?}",
        snapshot.turns[0].items[2]
    );
    assert!(matches!(
        &snapshot.turns[0].items[4],
        DurableItemSnapshot::ToolResult {
            result: DurableToolResult::Process(DurableProcessResult {
                sandbox_policy: None,
                network_policy: None,
                ..
            }),
            ..
        }
    ));
}

#[test]
fn workspace_write_attempt_without_result_recovers_as_interrupted_and_is_not_replayed() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    let turn_id = TurnId::new("turn_0000000000000001");
    let user = DurableItemSnapshot::UserMessage {
        id: ItemId::new("item_0000000000000001"),
        text: "Run it".to_string(),
    };
    let incremental = [
        DurableItemSnapshot::ToolCall {
            id: ItemId::new("item_0000000000000002"),
            call_id: "call_shell".to_string(),
            name: "shell/exec".to_string(),
            path: ".".to_string(),
            query: None,
            patch: None,
            command: Some("/bin/echo".to_string()),
            arguments: Some(vec!["ok".to_string()]),
        },
        DurableItemSnapshot::CommandApprovalRequest {
            id: ItemId::new("item_0000000000000003"),
            approval_id: "approval/one".to_string(),
            call_id: "call_shell".to_string(),
            command: "/bin/echo".to_string(),
            arguments: vec!["ok".to_string()],
            cwd: ".".to_string(),
            environment_policy: "minimalV1".to_string(),
            sandboxed: true,
            sandbox_policy: Some("filesystemReadOnlyV1".to_string()),
            workspace_write_policy: Some("commandWorkspaceWriteV1".to_string()),
            network_policy: Some("networkDeniedV1".to_string()),
            workspace_write_risk: Some("nonTransactionalWorkspaceTreeV1".to_string()),
        },
        DurableItemSnapshot::CommandApprovalDecision {
            id: ItemId::new("item_0000000000000004"),
            approval_id: "approval/one".to_string(),
            decision: "approved".to_string(),
            workspace_write_risk_acknowledgement: Some(
                "nonTransactionalWorkspaceTreeV1".to_string(),
            ),
        },
        DurableItemSnapshot::CommandExecutionAttempt {
            id: ItemId::new("item_0000000000000005"),
            approval_id: "approval/one".to_string(),
            call_id: "call_shell".to_string(),
        },
    ];
    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&thread_id).expect("thread");
        repository
            .begin_turn(
                &thread_id,
                &DurableTurnSnapshot {
                    model: None,
                    id: turn_id.clone(),
                    status: DurableTurnStatus::InProgress,
                    items: vec![user],
                    context_compaction: None,
                    workspace_instructions: None,
                    workspace_skills: None,
                    error: None,
                    usage: None,
                },
            )
            .expect("turn start");
        for item in &incremental {
            repository
                .append_turn_item(&thread_id, &turn_id, item)
                .expect("append audit item");
        }
    }

    let repository = RolloutRepository::open(&home).expect("recover");
    let snapshot = repository
        .load_thread(&thread_id)
        .expect("load")
        .expect("thread");
    assert_eq!(snapshot.turns[0].status, DurableTurnStatus::Interrupted);
    assert_eq!(snapshot.turns[0].items.last(), incremental.last());
    assert!(matches!(
        &snapshot.turns[0].items[2],
        DurableItemSnapshot::CommandApprovalRequest {
            workspace_write_policy: Some(policy),
            ..
        } if policy == "commandWorkspaceWriteV1"
    ));
    assert!(!snapshot.turns[0].items.iter().any(|item| matches!(
        item,
        DurableItemSnapshot::ToolResult { .. } | DurableItemSnapshot::FileChange { .. }
    )));
    assert_eq!(repository.id_sequences().item, 5);
}

#[test]
fn execution_attempt_requires_matching_approved_shell_audit() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    let turn_id = TurnId::new("turn_0000000000000001");
    let mut repository = RolloutRepository::open(&home).expect("repository");
    repository.create_thread(&thread_id).expect("thread");
    repository
        .begin_turn(
            &thread_id,
            &DurableTurnSnapshot {
                model: None,
                id: turn_id.clone(),
                status: DurableTurnStatus::InProgress,
                items: vec![DurableItemSnapshot::UserMessage {
                    id: ItemId::new("item_0000000000000001"),
                    text: "Run it".to_string(),
                }],
                context_compaction: None,
                workspace_instructions: None,
                workspace_skills: None,
                error: None,
                usage: None,
            },
        )
        .expect("turn start");
    let error = repository
        .append_turn_item(
            &thread_id,
            &turn_id,
            &DurableItemSnapshot::CommandExecutionAttempt {
                id: ItemId::new("item_0000000000000002"),
                approval_id: "approval/missing".to_string(),
                call_id: "call_missing".to_string(),
            },
        )
        .expect_err("orphan attempt");
    assert!(matches!(
        error,
        RolloutError::InvalidRecord {
            kind: "invalidCommandExecutionAttempt"
        }
    ));
}

#[test]
fn workspace_write_attempt_requires_the_exact_risk_acknowledgement() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    let turn_id = TurnId::new("turn_0000000000000001");
    let mut repository = RolloutRepository::open(&home).expect("repository");
    repository.create_thread(&thread_id).expect("thread");
    repository
        .begin_turn(
            &thread_id,
            &DurableTurnSnapshot {
                model: None,
                id: turn_id.clone(),
                status: DurableTurnStatus::InProgress,
                items: vec![DurableItemSnapshot::UserMessage {
                    id: ItemId::new("item_0000000000000001"),
                    text: "Run it".to_string(),
                }],
                context_compaction: None,
                workspace_instructions: None,
                workspace_skills: None,
                error: None,
                usage: None,
            },
        )
        .expect("turn start");
    for item in [
        DurableItemSnapshot::ToolCall {
            id: ItemId::new("item_0000000000000002"),
            call_id: "call_shell".to_string(),
            name: "shell/exec".to_string(),
            path: ".".to_string(),
            query: None,
            patch: None,
            command: Some("/bin/echo".to_string()),
            arguments: Some(vec!["ok".to_string()]),
        },
        DurableItemSnapshot::CommandApprovalRequest {
            id: ItemId::new("item_0000000000000003"),
            approval_id: "approval/one".to_string(),
            call_id: "call_shell".to_string(),
            command: "/bin/echo".to_string(),
            arguments: vec!["ok".to_string()],
            cwd: ".".to_string(),
            environment_policy: "minimalV1".to_string(),
            sandboxed: true,
            sandbox_policy: Some("filesystemReadOnlyV1".to_string()),
            workspace_write_policy: Some("commandWorkspaceWriteV1".to_string()),
            workspace_write_risk: Some("nonTransactionalWorkspaceTreeV1".to_string()),
            network_policy: Some("networkDeniedV1".to_string()),
        },
    ] {
        repository
            .append_turn_item(&thread_id, &turn_id, &item)
            .expect("append prerequisite");
    }

    let error = repository
        .append_turn_item(
            &thread_id,
            &turn_id,
            &DurableItemSnapshot::CommandApprovalDecision {
                id: ItemId::new("item_0000000000000004"),
                approval_id: "approval/one".to_string(),
                decision: "approved".to_string(),
                workspace_write_risk_acknowledgement: None,
            },
        )
        .expect_err("missing acknowledgement");
    assert!(matches!(
        error,
        RolloutError::InvalidRecord {
            kind: "invalidCommandApprovalRisk"
        }
    ));

    repository
        .append_turn_item(
            &thread_id,
            &turn_id,
            &DurableItemSnapshot::CommandApprovalDecision {
                id: ItemId::new("item_0000000000000004"),
                approval_id: "approval/one".to_string(),
                decision: "approved".to_string(),
                workspace_write_risk_acknowledgement: Some(
                    "nonTransactionalWorkspaceTreeV1".to_string(),
                ),
            },
        )
        .expect("exact acknowledgement");
    repository
        .append_turn_item(
            &thread_id,
            &turn_id,
            &DurableItemSnapshot::CommandExecutionAttempt {
                id: ItemId::new("item_0000000000000005"),
                approval_id: "approval/one".to_string(),
                call_id: "call_shell".to_string(),
            },
        )
        .expect("acknowledged attempt");
}

fn remove_command_policy_fields(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            object.remove("sandboxPolicy");
            object.remove("workspaceWritePolicy");
            object.remove("networkPolicy");
            object.remove("sandbox_policy");
            object.remove("workspace_write_policy");
            object.remove("network_policy");
            for value in object.values_mut() {
                remove_command_policy_fields(value);
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                remove_command_policy_fields(value);
            }
        }
        _ => {}
    }
}

#[test]
fn file_change_proposal_survives_recovery_without_replaying_the_write() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    let turn_id = TurnId::new("turn_0000000000000001");
    let proposal = DurableItemSnapshot::FileChange {
        id: ItemId::new("item_0000000000000003"),
        call_id: "call_patch".to_string(),
        path: "notes.txt".to_string(),
        kind: "update".to_string(),
        diff: "--- a/notes.txt\n+++ b/notes.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n".to_string(),
        before_sha256: "a".repeat(64),
        after_sha256: "b".repeat(64),
        before_bytes: 4,
        after_bytes: 4,
        newline_style: "lf".to_string(),
        final_newline: true,
    };
    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&thread_id).expect("thread");
        repository
            .begin_turn(
                &thread_id,
                &DurableTurnSnapshot {
                    model: None,
                    id: turn_id.clone(),
                    status: DurableTurnStatus::InProgress,
                    items: vec![DurableItemSnapshot::UserMessage {
                        id: ItemId::new("item_0000000000000001"),
                        text: "Update it".to_string(),
                    }],
                    context_compaction: None,
                    workspace_instructions: None,
                    workspace_skills: None,
                    error: None,
                    usage: None,
                },
            )
            .expect("turn start");
        repository
            .append_turn_item(
                &thread_id,
                &turn_id,
                &DurableItemSnapshot::ToolCall {
                    id: ItemId::new("item_0000000000000002"),
                    call_id: "call_patch".to_string(),
                    name: "workspace/apply-patch".to_string(),
                    path: "notes.txt".to_string(),
                    query: None,
                    patch: Some("@@ -1,1 +1,1 @@\n-old\n+new\n".to_string()),
                    command: None,
                    arguments: None,
                },
            )
            .expect("tool call");
        repository
            .append_turn_item(&thread_id, &turn_id, &proposal)
            .expect("file change proposal");
    }
    let repository = RolloutRepository::open(&home).expect("recover");
    let snapshot = repository
        .load_thread(&thread_id)
        .expect("load")
        .expect("thread");
    assert_eq!(snapshot.turns[0].status, DurableTurnStatus::Interrupted);
    assert_eq!(snapshot.turns[0].items.last(), Some(&proposal));
    assert!(
        !snapshot.turns[0]
            .items
            .iter()
            .any(|item| matches!(item, DurableItemSnapshot::ToolResult { .. }))
    );
}

#[test]
fn a_started_turn_is_replaced_by_its_single_terminal_record() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    let mut repository = RolloutRepository::open(&home).expect("repository");
    repository.create_thread(&thread_id).expect("thread");
    let started = started_text_turn();
    repository
        .begin_turn(&thread_id, &started)
        .expect("durable turn start");
    let mut completed = started;
    completed.status = DurableTurnStatus::Completed;
    let DurableItemSnapshot::AgentMessage { text, .. } = &mut completed.items[1] else {
        panic!("agent item");
    };
    *text = "Hello from the model".to_string();
    repository
        .complete_turn_item(&thread_id, &completed.id, &completed.items[1])
        .expect("durable item completion");
    repository
        .finish_turn(&thread_id, &completed)
        .expect("durable terminal");
    drop(repository);

    let repository = RolloutRepository::open(&home).expect("reopen");
    let snapshot = repository
        .load_thread(&thread_id)
        .expect("load")
        .expect("thread");
    assert_eq!(snapshot.turns, vec![completed]);
}

#[test]
fn active_turn_rejects_lifecycle_records_and_non_terminal_fork_snapshots() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    let mut repository = RolloutRepository::open(&home).expect("repository");
    repository.create_thread(&thread_id).expect("thread");
    repository
        .begin_turn(&thread_id, &started_text_turn())
        .expect("turn start");

    for error in [
        repository.archive_thread(&thread_id).expect_err("archive"),
        repository
            .unarchive_thread(&thread_id)
            .expect_err("unarchive"),
        repository.delete_thread(&thread_id).expect_err("delete"),
    ] {
        assert!(matches!(
            error,
            RolloutError::InvalidRecord {
                kind: "threadLifecycleWhileTurnActive"
            }
        ));
    }
    let mut in_progress = started_text_turn();
    in_progress.id = TurnId::new("turn_0000000000000002");
    in_progress.items[0] = DurableItemSnapshot::UserMessage {
        id: ItemId::new("item_0000000000000003"),
        text: "copied input".to_string(),
    };
    in_progress.items[1] = DurableItemSnapshot::AgentMessage {
        id: ItemId::new("item_0000000000000004"),
        text: String::new(),
    };
    assert!(matches!(
        repository
            .create_thread_snapshot(&DurableThreadSnapshot {
                id: ThreadId::new("thr_0000000000000002"),
                turns: vec![in_progress],
                lifecycle: DurableThreadLifecycle::Active,
                origin: None,
            })
            .expect_err("in-progress fork"),
        RolloutError::InvalidRecord {
            kind: "invalidTerminalTurn"
        }
    ));
}

#[test]
fn replay_rejects_lifecycle_record_while_turn_is_pending() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&thread_id).expect("thread");
        repository
            .begin_turn(&thread_id, &started_text_turn())
            .expect("turn start");
    }
    let rollout = directory
        .path()
        .join("rollouts/v1/thr_0000000000000001.jsonl");
    writeln!(
        fs::OpenOptions::new()
            .append(true)
            .open(&rollout)
            .expect("rollout"),
        "{}",
        serde_json::json!({
            "schemaVersion": 1,
            "sequence": 7,
            "type": "threadArchived",
            "threadId": thread_id.as_str()
        })
    )
    .expect("append invalid lifecycle");
    let error = RolloutRepository::open(&home).expect_err("corrupt rollout");
    let RolloutError::Corrupt(diagnostic) = error else {
        panic!("corrupt diagnostic");
    };
    assert_eq!(diagnostic.kind, "threadLifecycleWhileTurnPending");
}
