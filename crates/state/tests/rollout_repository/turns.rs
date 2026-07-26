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
    assert_eq!(
        fs::read_to_string(&rollout)
            .expect("read recovered rollout")
            .lines()
            .count(),
        3
    );
    let reopened = RolloutRepository::open(&home).expect("reopen recovered repository");
    assert!(
        !reopened
            .diagnostics()
            .iter()
            .any(|diagnostic| diagnostic.kind == "danglingTurnRecovered")
    );
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
                    id: TurnId::new("turn_0000000000000001"),
                    status: DurableTurnStatus::InProgress,
                    items: Vec::new(),
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
fn a_durable_tool_call_survives_recovery_without_an_unwritten_result() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    let turn_id = TurnId::new("turn_0000000000000001");
    let tool_call = DurableItemSnapshot::ToolCall {
        id: ItemId::new("item_0000000000000002"),
        call_id: "call_1".to_string(),
        name: "workspace/read".to_string(),
        path: "README.txt".to_string(),
    };
    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&thread_id).expect("thread");
        repository
            .begin_turn(
                &thread_id,
                &DurableTurnSnapshot {
                    id: turn_id.clone(),
                    status: DurableTurnStatus::InProgress,
                    items: vec![DurableItemSnapshot::UserMessage {
                        id: ItemId::new("item_0000000000000001"),
                        text: "Read it".to_string(),
                    }],
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
            "sequence": 3,
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
