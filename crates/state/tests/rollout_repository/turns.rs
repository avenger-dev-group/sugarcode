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
            network_policy: Some("networkDeniedV1".to_string()),
        },
        DurableItemSnapshot::CommandApprovalDecision {
            id: ItemId::new("item_0000000000000004"),
            approval_id: "approval/one".to_string(),
            decision: "approved".to_string(),
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
                    id: turn_id.clone(),
                    status: DurableTurnStatus::InProgress,
                    items: vec![user.clone()],
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
                    id: turn_id.clone(),
                    status: DurableTurnStatus::Completed,
                    items,
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
fn execution_attempt_without_result_recovers_as_interrupted_and_is_not_replayed() {
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
            network_policy: Some("networkDeniedV1".to_string()),
        },
        DurableItemSnapshot::CommandApprovalDecision {
            id: ItemId::new("item_0000000000000004"),
            approval_id: "approval/one".to_string(),
            decision: "approved".to_string(),
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
                    id: turn_id.clone(),
                    status: DurableTurnStatus::InProgress,
                    items: vec![user],
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
    assert!(
        !snapshot.turns[0]
            .items
            .iter()
            .any(|item| matches!(item, DurableItemSnapshot::ToolResult { .. }))
    );
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
                id: turn_id.clone(),
                status: DurableTurnStatus::InProgress,
                items: vec![DurableItemSnapshot::UserMessage {
                    id: ItemId::new("item_0000000000000001"),
                    text: "Run it".to_string(),
                }],
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

fn remove_command_policy_fields(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            object.remove("sandboxPolicy");
            object.remove("networkPolicy");
            object.remove("sandbox_policy");
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
                    id: turn_id.clone(),
                    status: DurableTurnStatus::InProgress,
                    items: vec![DurableItemSnapshot::UserMessage {
                        id: ItemId::new("item_0000000000000001"),
                        text: "Update it".to_string(),
                    }],
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
