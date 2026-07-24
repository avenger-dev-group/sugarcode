use std::fs;
use std::io::Write;
use sugarcode_protocol::ItemId;
use sugarcode_protocol::ThreadId;
use sugarcode_protocol::TurnId;
use sugarcode_state::DurableItemSnapshot;
use sugarcode_state::DurableTurnSnapshot;
use sugarcode_state::HomeResolutionInputs;
use sugarcode_state::RolloutError;
use sugarcode_state::RolloutRepository;
use sugarcode_state::ThreadRepository;
use sugarcode_state::resolve_sugarcode_home;
use tempfile::tempdir;

fn completed_turn(sequence: u64) -> DurableTurnSnapshot {
    DurableTurnSnapshot {
        id: TurnId::new(format!("turn_{sequence:016}")),
        items: vec![DurableItemSnapshot::AgentMessage {
            id: ItemId::new(format!("item_{sequence:016}")),
            text: "SugarCode deterministic response.".to_string(),
        }],
    }
}

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
                items: Vec::new(),
            },
        )
        .expect_err("empty completed turn");

    assert!(matches!(error, RolloutError::InvalidRecord { .. }));
    assert_eq!(fs::read(path).expect("read after"), before);
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
