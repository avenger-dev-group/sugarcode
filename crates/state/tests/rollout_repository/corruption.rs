use super::*;

#[test]
fn rejects_an_empty_completed_turn_before_writing() {
    let directory = tempdir().expect("home");
    let home = resolve_sugarcode_home(HomeResolutionInputs {
        cli_override: Some(directory.path().to_path_buf()),
        ..Default::default()
    })
    .expect("resolve home");
    let thread_id = ThreadId::new("thr_0000000000000001");
    let mut repository = RolloutRepository::open(&home).expect("repository");
    repository.create_thread(&thread_id).expect("thread");
    let path = directory
        .path()
        .join("rollouts/v1/thr_0000000000000001.jsonl");
    let before = fs::read(&path).expect("read before");

    let error = repository
        .append_completed_turn(
            &thread_id,
            &DurableTurnSnapshot {
                id: TurnId::new("turn_0000000000000001"),
                status: DurableTurnStatus::Completed,
                items: Vec::new(),
                context_compaction: None,
                workspace_instructions: None,
                workspace_skills: None,
                error: None,
                usage: None,
            },
        )
        .expect_err("empty completed turn");

    assert!(matches!(error, RolloutError::InvalidRecord { .. }));
    assert_eq!(fs::read(path).expect("read after"), before);
}

#[test]
fn rejects_a_tampered_persisted_compaction_without_echoing_its_message() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    let prior = completed_turn(1);
    let checkpoint =
        sugarcode_state::build_context_compaction(std::slice::from_ref(&prior), 3_200_000, 30_000)
            .expect("checkpoint");
    let started = DurableTurnSnapshot {
        id: TurnId::new("turn_0000000000000002"),
        status: DurableTurnStatus::InProgress,
        items: vec![DurableItemSnapshot::UserMessage {
            id: ItemId::new("item_0000000000000002"),
            text: "continue".to_string(),
        }],
        context_compaction: Some(checkpoint),
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
            .expect("prior");
        repository
            .begin_turn(&thread_id, &started)
            .expect("checkpoint start");
    }

    let path = directory
        .path()
        .join("rollouts/v1/thr_0000000000000001.jsonl");
    let mut records = fs::read_to_string(&path)
        .expect("rollout")
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).expect("record"))
        .collect::<Vec<_>>();
    let sentinel = "tampered-compaction-must-not-leak";
    records[2]["turn"]["contextCompaction"]["message"] =
        serde_json::Value::String(sentinel.to_string());
    let rewritten = records
        .iter()
        .map(|record| serde_json::to_string(record).expect("encode"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    fs::write(&path, rewritten).expect("tamper rollout");

    let error = RolloutRepository::open(&home).expect_err("tampering is fatal");
    assert!(matches!(error, RolloutError::Corrupt(_)));
    assert!(error.to_string().contains("invalidContextCompaction"));
    assert!(!error.to_string().contains(sentinel));
}

#[test]
fn rejects_invalid_workspace_skills_audit_with_redacted_diagnostics() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    let mut started = started_text_turn();
    started.workspace_skills = Some(DurableWorkspaceSkillsAudit {
        source: DurableWorkspaceSkillsSource::RootToActiveScopeAgentsSkillsV1,
        status: DurableWorkspaceSkillsStatus::Present,
        discovered_count: 1,
        effective_count: 1,
        selected_count: 0,
        source_bytes: 40,
        inventory_bytes: 20,
        selected_bytes: 0,
        manifest_sha256: "e".repeat(64),
        selection_sha256: None,
    });
    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&thread_id).expect("thread");
        repository
            .begin_turn(&thread_id, &started)
            .expect("turn start");
    }
    let path = directory
        .path()
        .join("rollouts/v1/thr_0000000000000001.jsonl");
    let mut records = fs::read_to_string(&path)
        .expect("rollout")
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).expect("record"))
        .collect::<Vec<_>>();
    let sentinel = "private-skill-name-must-not-leak";
    records[1]["turn"]["workspaceSkills"]["manifestSha256"] =
        serde_json::Value::String(sentinel.to_string());
    let rewritten = records
        .iter()
        .map(|record| serde_json::to_string(record).expect("encode"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    fs::write(&path, rewritten).expect("tamper rollout");

    let error = RolloutRepository::open(&home).expect_err("tampering is fatal");
    assert!(matches!(error, RolloutError::Corrupt(_)));
    assert!(error.to_string().contains("invalidWorkspaceSkillsAudit"));
    assert!(!error.to_string().contains(sentinel));
}

#[test]
fn rejects_a_second_writer_for_the_same_home() {
    let directory = tempdir().expect("home");
    let home = resolve_sugarcode_home(HomeResolutionInputs {
        cli_override: Some(directory.path().to_path_buf()),
        ..Default::default()
    })
    .expect("resolve home");
    let _first = RolloutRepository::open(&home).expect("first writer");
    assert!(matches!(
        RolloutRepository::open(&home),
        Err(RolloutError::Busy { .. })
    ));
}

#[test]
fn recovers_only_an_unterminated_final_record() {
    let directory = tempdir().expect("home");
    let home = resolve_sugarcode_home(HomeResolutionInputs {
        cli_override: Some(directory.path().to_path_buf()),
        ..Default::default()
    })
    .expect("resolve home");
    let thread_id = ThreadId::new("thr_0000000000000001");
    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&thread_id).expect("thread");
    }
    let path = directory
        .path()
        .join("rollouts/v1/thr_0000000000000001.jsonl");
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("open rollout");
    file.write_all(br#"{"schemaVersion":1,"sequence":2"#)
        .expect("write partial tail");
    file.flush().expect("flush tail");

    let repository = RolloutRepository::open(&home).expect("tail recovers");
    assert_eq!(repository.diagnostics().len(), 1);
    assert_eq!(repository.diagnostics()[0].kind, "truncatedTailRecovered");
    assert!(
        repository
            .load_thread(&thread_id)
            .expect("load")
            .expect("thread")
            .turns
            .is_empty()
    );
    assert_eq!(
        fs::read_to_string(path).expect("read repaired"),
        "{\"schemaVersion\":1,\"sequence\":1,\"type\":\"threadCreated\",\"threadId\":\"thr_0000000000000001\"}\n"
    );
}

#[test]
fn terminated_corruption_is_fatal_and_does_not_echo_record_contents() {
    let directory = tempdir().expect("home");
    let home = resolve_sugarcode_home(HomeResolutionInputs {
        cli_override: Some(directory.path().to_path_buf()),
        ..Default::default()
    })
    .expect("resolve home");
    {
        let _repository = RolloutRepository::open(&home).expect("create layout");
    }
    let sentinel = "do-not-leak-this-message";
    fs::write(
        directory
            .path()
            .join("rollouts/v1/thr_0000000000000001.jsonl"),
        format!("{{broken:{sentinel}}}\n"),
    )
    .expect("write corrupt rollout");

    let error = RolloutRepository::open(&home).expect_err("corruption fails");
    assert!(matches!(error, RolloutError::Corrupt(_)));
    assert!(!error.to_string().contains(sentinel));
}

#[test]
fn corrupt_complete_prefix_is_not_mutated_when_an_unterminated_tail_exists() {
    let directory = tempdir().expect("home");
    let home = resolve_sugarcode_home(HomeResolutionInputs {
        cli_override: Some(directory.path().to_path_buf()),
        ..Default::default()
    })
    .expect("resolve home");
    {
        let _repository = RolloutRepository::open(&home).expect("create layout");
    }
    let path = directory
        .path()
        .join("rollouts/v1/thr_0000000000000001.jsonl");
    let contents = b"{\"schemaVersion\":1,\"sequence\":99,\"type\":\"threadCreated\",\"threadId\":\"thr_0000000000000001\"}\nunfinished";
    fs::write(&path, contents).expect("write corrupt rollout");

    let error = RolloutRepository::open(&home).expect_err("corrupt prefix must fail");

    assert!(matches!(error, RolloutError::Corrupt(_)));
    assert_eq!(fs::read(path).expect("read rollout"), contents);
}

#[test]
fn rejects_unknown_versions_types_sequences_and_non_utf8_records() {
    for (name, bytes, expected_kind) in [
        (
            "unsupported version",
            br#"{"schemaVersion":2,"sequence":1,"type":"threadCreated","threadId":"thr_0000000000000001"}
"#
            .as_slice(),
            "unsupportedSchemaVersion",
        ),
        (
            "unknown type",
            br#"{"schemaVersion":1,"sequence":1,"type":"futureRecord","threadId":"thr_0000000000000001"}
"#
            .as_slice(),
            "unknownRecordType",
        ),
        (
            "invalid sequence",
            br#"{"schemaVersion":1,"sequence":2,"type":"threadCreated","threadId":"thr_0000000000000001"}
"#
            .as_slice(),
            "invalidSequence",
        ),
        ("non UTF-8", &[0xff, b'\n'], "invalidUtf8"),
    ] {
        let directory = tempdir().expect("home");
        let home = resolve_sugarcode_home(HomeResolutionInputs {
            cli_override: Some(directory.path().to_path_buf()),
            ..Default::default()
        })
        .expect("resolve home");
        {
            let _repository = RolloutRepository::open(&home).expect("create layout");
        }
        fs::write(
            directory
                .path()
                .join("rollouts/v1/thr_0000000000000001.jsonl"),
            bytes,
        )
        .expect("write corrupt record");

        let error = RolloutRepository::open(&home).expect_err(name);
        let RolloutError::Corrupt(diagnostic) = error else {
            panic!("{name}: expected corruption");
        };
        assert_eq!(diagnostic.kind, expected_kind, "{name}");
    }
}

#[test]
fn rejects_duplicate_archive_and_records_after_archive_without_echoing_content() {
    for (name, records, expected_kind) in [
        (
            "duplicate archive",
            concat!(
                "{\"schemaVersion\":1,\"sequence\":1,\"type\":\"threadCreated\",\"threadId\":\"thr_0000000000000001\"}\n",
                "{\"schemaVersion\":1,\"sequence\":2,\"type\":\"threadArchived\",\"threadId\":\"thr_0000000000000001\"}\n",
                "{\"schemaVersion\":1,\"sequence\":3,\"type\":\"threadArchived\",\"threadId\":\"thr_0000000000000001\"}\n"
            ),
            "duplicateThreadArchive",
        ),
        (
            "turn after archive",
            concat!(
                "{\"schemaVersion\":1,\"sequence\":1,\"type\":\"threadCreated\",\"threadId\":\"thr_0000000000000001\"}\n",
                "{\"schemaVersion\":1,\"sequence\":2,\"type\":\"threadArchived\",\"threadId\":\"thr_0000000000000001\"}\n",
                "{\"schemaVersion\":1,\"sequence\":3,\"type\":\"turnCompleted\",\"threadId\":\"thr_0000000000000001\",\"turn\":{\"id\":\"turn_0000000000000001\",\"status\":\"completed\",\"items\":[{\"type\":\"agentMessage\",\"id\":\"item_0000000000000001\",\"text\":\"private-archive-sentinel\"}]}}\n"
            ),
            "recordAfterThreadArchive",
        ),
        (
            "unarchive while active",
            concat!(
                "{\"schemaVersion\":1,\"sequence\":1,\"type\":\"threadCreated\",\"threadId\":\"thr_0000000000000001\"}\n",
                "{\"schemaVersion\":1,\"sequence\":2,\"type\":\"threadUnarchived\",\"threadId\":\"thr_0000000000000001\",\"private\":\"private-archive-sentinel\"}\n"
            ),
            "invalidRecordShape",
        ),
        (
            "valid-shaped unarchive while active",
            concat!(
                "{\"schemaVersion\":1,\"sequence\":1,\"type\":\"threadCreated\",\"threadId\":\"thr_0000000000000001\"}\n",
                "{\"schemaVersion\":1,\"sequence\":2,\"type\":\"threadUnarchived\",\"threadId\":\"thr_0000000000000001\"}\n"
            ),
            "threadUnarchiveWhileActive",
        ),
    ] {
        let directory = tempdir().expect("home");
        let home = resolved_temp_home(&directory);
        {
            let _repository = RolloutRepository::open(&home).expect("create layout");
        }
        fs::write(
            directory
                .path()
                .join("rollouts/v1/thr_0000000000000001.jsonl"),
            records,
        )
        .expect("write invalid rollout");

        let error = RolloutRepository::open(&home).expect_err(name);
        let RolloutError::Corrupt(diagnostic) = error else {
            panic!("{name}: expected corruption");
        };
        assert_eq!(diagnostic.kind, expected_kind, "{name}");
        assert!(!diagnostic.to_string().contains("private-archive-sentinel"));
    }
}

#[test]
fn rejects_duplicate_delete_and_records_after_delete_without_echoing_content() {
    for (name, records, expected_kind) in [
        (
            "duplicate delete",
            concat!(
                "{\"schemaVersion\":1,\"sequence\":1,\"type\":\"threadCreated\",\"threadId\":\"thr_0000000000000001\"}\n",
                "{\"schemaVersion\":1,\"sequence\":2,\"type\":\"threadDeleted\",\"threadId\":\"thr_0000000000000001\"}\n",
                "{\"schemaVersion\":1,\"sequence\":3,\"type\":\"threadDeleted\",\"threadId\":\"thr_0000000000000001\"}\n"
            ),
            "duplicateThreadDelete",
        ),
        (
            "turn after delete",
            concat!(
                "{\"schemaVersion\":1,\"sequence\":1,\"type\":\"threadCreated\",\"threadId\":\"thr_0000000000000001\"}\n",
                "{\"schemaVersion\":1,\"sequence\":2,\"type\":\"threadDeleted\",\"threadId\":\"thr_0000000000000001\"}\n",
                "{\"schemaVersion\":1,\"sequence\":3,\"type\":\"turnCompleted\",\"threadId\":\"thr_0000000000000001\",\"turn\":{\"id\":\"turn_0000000000000001\",\"status\":\"completed\",\"items\":[{\"type\":\"agentMessage\",\"id\":\"item_0000000000000001\",\"text\":\"private-delete-sentinel\"}]}}\n"
            ),
            "recordAfterThreadDelete",
        ),
        (
            "archive after delete",
            concat!(
                "{\"schemaVersion\":1,\"sequence\":1,\"type\":\"threadCreated\",\"threadId\":\"thr_0000000000000001\"}\n",
                "{\"schemaVersion\":1,\"sequence\":2,\"type\":\"threadDeleted\",\"threadId\":\"thr_0000000000000001\"}\n",
                "{\"schemaVersion\":1,\"sequence\":3,\"type\":\"threadArchived\",\"threadId\":\"thr_0000000000000001\"}\n"
            ),
            "recordAfterThreadDelete",
        ),
        (
            "unarchive after delete",
            concat!(
                "{\"schemaVersion\":1,\"sequence\":1,\"type\":\"threadCreated\",\"threadId\":\"thr_0000000000000001\"}\n",
                "{\"schemaVersion\":1,\"sequence\":2,\"type\":\"threadDeleted\",\"threadId\":\"thr_0000000000000001\"}\n",
                "{\"schemaVersion\":1,\"sequence\":3,\"type\":\"threadUnarchived\",\"threadId\":\"thr_0000000000000001\"}\n"
            ),
            "recordAfterThreadDelete",
        ),
    ] {
        let directory = tempdir().expect("home");
        let home = resolved_temp_home(&directory);
        {
            let _repository = RolloutRepository::open(&home).expect("create layout");
        }
        fs::write(
            directory
                .path()
                .join("rollouts/v1/thr_0000000000000001.jsonl"),
            records,
        )
        .expect("write invalid rollout");

        let error = RolloutRepository::open(&home).expect_err(name);
        let RolloutError::Corrupt(diagnostic) = error else {
            panic!("{name}: expected corruption");
        };
        assert_eq!(diagnostic.kind, expected_kind, "{name}");
        assert!(!diagnostic.to_string().contains("private-delete-sentinel"));
    }
}

#[test]
fn removes_an_empty_unacknowledged_create_artifact() {
    let directory = tempdir().expect("home");
    let home = resolve_sugarcode_home(HomeResolutionInputs {
        cli_override: Some(directory.path().to_path_buf()),
        ..Default::default()
    })
    .expect("resolve home");
    {
        let _repository = RolloutRepository::open(&home).expect("create layout");
    }
    let path = directory
        .path()
        .join("rollouts/v1/thr_0000000000000001.jsonl");
    fs::write(&path, []).expect("empty create artifact");

    let repository = RolloutRepository::open(&home).expect("empty artifact recovers");
    assert!(!path.exists());
    assert_eq!(
        repository.diagnostics()[0].kind,
        "emptyCreateArtifactRecovered"
    );
}

#[test]
fn removes_an_unacknowledged_fork_create_artifact() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    {
        let _repository = RolloutRepository::open(&home).expect("create layout");
    }
    let path = directory
        .path()
        .join("rollouts/v1/.thr_0000000000000001.fork.tmp");
    fs::write(&path, b"private-fork-create-sentinel").expect("fork artifact");

    let repository = RolloutRepository::open(&home).expect("artifact recovers");
    assert!(!path.exists());
    assert_eq!(
        repository.diagnostics()[0].kind,
        "forkCreateArtifactRecovered"
    );
    assert!(
        !repository.diagnostics()[0]
            .to_string()
            .contains("private-fork-create-sentinel")
    );
}

#[cfg(unix)]
#[test]
fn rejects_symlinks_inside_the_rollout_tree() {
    use std::os::unix::fs::symlink;

    let directory = tempdir().expect("home");
    let home = resolve_sugarcode_home(HomeResolutionInputs {
        cli_override: Some(directory.path().to_path_buf()),
        ..Default::default()
    })
    .expect("resolve home");
    let target = directory.path().join("target");
    fs::create_dir(&target).expect("target");
    symlink(&target, directory.path().join("rollouts")).expect("rollouts symlink");

    assert!(RolloutRepository::open(&home).is_err());
}

#[cfg(unix)]
#[test]
fn refuses_to_follow_a_rollout_replaced_by_a_symlink_before_append() {
    use std::os::unix::fs::symlink;

    let directory = tempdir().expect("home");
    let home = resolve_sugarcode_home(HomeResolutionInputs {
        cli_override: Some(directory.path().to_path_buf()),
        ..Default::default()
    })
    .expect("resolve home");
    let thread_id = ThreadId::new("thr_0000000000000001");
    let mut repository = RolloutRepository::open(&home).expect("repository");
    repository.create_thread(&thread_id).expect("thread");
    let rollout = directory
        .path()
        .join("rollouts/v1/thr_0000000000000001.jsonl");
    let target = directory.path().join("outside.jsonl");
    fs::write(&target, b"outside").expect("outside target");
    fs::remove_file(&rollout).expect("replace rollout");
    symlink(&target, &rollout).expect("rollout symlink");

    assert!(matches!(
        repository.append_completed_turn(&thread_id, &completed_turn(1)),
        Err(RolloutError::Unavailable { .. })
    ));
    assert_eq!(fs::read(target).expect("outside target"), b"outside");
}
