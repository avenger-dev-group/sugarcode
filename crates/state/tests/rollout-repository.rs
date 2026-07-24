use std::fs;
use std::io::Write;
use sugarcode_protocol::ItemId;
use sugarcode_protocol::ThreadId;
use sugarcode_protocol::TurnId;
use sugarcode_state::DurableItemSnapshot;
use sugarcode_state::DurableThreadLifecycle;
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

fn resolved_temp_home(directory: &tempfile::TempDir) -> sugarcode_state::SugarCodeHome {
    resolve_sugarcode_home(HomeResolutionInputs {
        cli_override: Some(directory.path().to_path_buf()),
        ..Default::default()
    })
    .expect("resolve home")
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
fn archives_with_one_v1_record_and_rebuilds_active_only_views() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    let rollout = directory
        .path()
        .join("rollouts/v1/thr_0000000000000001.jsonl");

    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&thread_id).expect("thread");
        repository
            .append_completed_turn(&thread_id, &completed_turn(1))
            .expect("turn");
        repository.archive_thread(&thread_id).expect("archive");
        let archived_bytes = fs::read(&rollout).expect("read archived rollout");

        repository
            .archive_thread(&thread_id)
            .expect("archive is idempotent");
        assert_eq!(
            fs::read(&rollout).expect("read idempotent rollout"),
            archived_bytes,
            "an idempotent archive must not append another record"
        );
        assert_eq!(
            repository
                .load_thread(&thread_id)
                .expect("load")
                .expect("thread")
                .lifecycle,
            DurableThreadLifecycle::Archived
        );
        assert!(
            repository
                .list_threads(None, 50)
                .expect("list")
                .data
                .is_empty()
        );
        assert!(
            repository
                .search_threads("SugarCode", None, 50)
                .expect("search")
                .data
                .is_empty()
        );
        assert!(matches!(
            repository.append_completed_turn(&thread_id, &completed_turn(2)),
            Err(RolloutError::InvalidRecord {
                kind: "recordAfterThreadArchive"
            })
        ));
    }

    assert!(
        fs::read_to_string(&rollout)
            .expect("read rollout")
            .ends_with(
                "{\"schemaVersion\":1,\"sequence\":3,\"type\":\"threadArchived\",\"threadId\":\"thr_0000000000000001\"}\n"
            )
    );
    for database in ["thread-discovery.sqlite3", "thread-search.sqlite3"] {
        fs::remove_file(directory.path().join("projections/v1").join(database))
            .expect("remove projection");
    }

    let mut repository = RolloutRepository::open(&home).expect("rebuild from rollout");
    let snapshot = repository
        .load_thread(&thread_id)
        .expect("load")
        .expect("thread");
    assert_eq!(snapshot.lifecycle, DurableThreadLifecycle::Archived);
    assert_eq!(snapshot.turns, vec![completed_turn(1)]);
    assert!(
        repository
            .list_threads(None, 50)
            .expect("list rebuilt data")
            .data
            .is_empty()
    );
    assert!(
        repository
            .search_threads("SugarCode", None, 50)
            .expect("search rebuilt data")
            .data
            .is_empty()
    );
}

#[test]
fn lists_threads_in_descending_numeric_order_with_stable_cursor_paging() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let mut repository = RolloutRepository::open(&home).expect("repository");
    for sequence in [1, 9, 10] {
        repository
            .create_thread(&ThreadId::new(format!("thr_{sequence:016}")))
            .expect("persist thread");
    }

    let first = repository.list_threads(None, 2).expect("first page");
    assert_eq!(
        first
            .data
            .iter()
            .map(|thread| thread.id.as_str())
            .collect::<Vec<_>>(),
        ["thr_0000000000000010", "thr_0000000000000009"]
    );
    assert_eq!(
        first.next_cursor.as_ref().map(ThreadId::as_str),
        Some("thr_0000000000000009")
    );

    let second = repository
        .list_threads(first.next_cursor.as_ref(), 2)
        .expect("second page");
    assert_eq!(
        second
            .data
            .iter()
            .map(|thread| thread.id.as_str())
            .collect::<Vec<_>>(),
        ["thr_0000000000000001"]
    );
    assert_eq!(second.next_cursor, None);
}

#[test]
fn rebuilds_a_missing_projection_from_rollouts() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&thread_id).expect("thread");
        repository
            .append_completed_turn(&thread_id, &completed_turn(1))
            .expect("turn");
    }
    let database = directory
        .path()
        .join("projections/v1/thread-discovery.sqlite3");
    fs::remove_file(&database).expect("remove projection");

    let mut repository = RolloutRepository::open(&home).expect("rebuild projection");
    assert!(repository.projection_diagnostics().is_empty());
    let page = repository
        .list_threads(None, 50)
        .expect("list rebuilt data");
    assert_eq!(page.data.len(), 1);
    assert_eq!(page.data[0].id, thread_id);
    assert!(database.is_file());
}

#[test]
fn rebuilds_an_invalid_header_without_exposing_database_contents() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&thread_id).expect("thread");
    }
    let database = directory
        .path()
        .join("projections/v1/thread-discovery.sqlite3");
    let sentinel = "do-not-leak-projection-content";
    fs::write(&database, sentinel).expect("corrupt projection");

    let mut repository = RolloutRepository::open(&home).expect("recover projection");
    assert_eq!(repository.projection_diagnostics().len(), 1);
    let diagnostic = repository.projection_diagnostics()[0].to_string();
    assert!(diagnostic.contains("invalidHeaderRecovered"));
    assert!(!diagnostic.contains(sentinel));
    assert_eq!(
        repository.list_threads(None, 50).expect("list").data[0].id,
        thread_id
    );
}

#[test]
fn rebuilds_a_stale_projection_from_exact_rollout_watermarks() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&thread_id).expect("thread");
    }
    let database = directory
        .path()
        .join("projections/v1/thread-discovery.sqlite3");
    let connection = rusqlite::Connection::open(&database).expect("open projection");
    connection
        .execute("DELETE FROM threads", [])
        .expect("make projection stale");
    connection.close().expect("close projection");

    let mut repository = RolloutRepository::open(&home).expect("recover stale projection");
    assert_eq!(repository.projection_diagnostics().len(), 1);
    assert_eq!(
        repository.projection_diagnostics()[0].kind,
        "staleRecovered"
    );
    assert_eq!(
        repository.list_threads(None, 50).expect("list").data[0].id,
        thread_id
    );
}

#[test]
fn database_busy_is_reported_without_replacing_the_projection() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository
            .create_thread(&ThreadId::new("thr_0000000000000001"))
            .expect("thread");
    }
    let database = directory
        .path()
        .join("projections/v1/thread-discovery.sqlite3");
    let connection = rusqlite::Connection::open(&database).expect("open projection");
    connection
        .execute_batch("BEGIN EXCLUSIVE")
        .expect("hold exclusive database lock");

    let error = RolloutRepository::open(&home).expect_err("busy projection must fail");
    let RolloutError::Projection(diagnostic) = error else {
        panic!("expected projection failure");
    };
    assert_eq!(diagnostic.kind, "busy");
    assert!(database.is_file());
    connection
        .execute_batch("ROLLBACK")
        .expect("release database lock");
}

#[test]
fn projection_write_failure_does_not_erase_a_durable_rollout_commit() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let mut repository = RolloutRepository::open(&home).expect("repository");
    let database = directory
        .path()
        .join("projections/v1/thread-discovery.sqlite3");
    let blocker = rusqlite::Connection::open(&database).expect("open projection");
    blocker
        .execute_batch("BEGIN EXCLUSIVE")
        .expect("hold exclusive database lock");
    let thread_id = ThreadId::new("thr_0000000000000001");

    repository
        .create_thread(&thread_id)
        .expect("rollout commit remains successful");
    let error = repository
        .list_threads(None, 50)
        .expect_err("busy dirty projection is unavailable");
    let RolloutError::Projection(diagnostic) = error else {
        panic!("expected projection failure");
    };
    assert_eq!(diagnostic.kind, "busy");
    blocker
        .execute_batch("ROLLBACK")
        .expect("release database lock");
    drop(blocker);
    drop(repository);

    let mut repository = RolloutRepository::open(&home).expect("rebuild stale projection");
    assert_eq!(
        repository.list_threads(None, 50).expect("list").data[0].id,
        thread_id
    );
    assert!(repository.load_thread(&thread_id).expect("load").is_some());
}

#[test]
fn archive_projection_failure_does_not_erase_the_durable_commit() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    let mut repository = RolloutRepository::open(&home).expect("repository");
    repository.create_thread(&thread_id).expect("thread");
    let database = directory
        .path()
        .join("projections/v1/thread-discovery.sqlite3");
    let blocker = rusqlite::Connection::open(&database).expect("open projection");
    blocker
        .execute_batch("BEGIN EXCLUSIVE")
        .expect("hold exclusive database lock");

    repository
        .archive_thread(&thread_id)
        .expect("durable archive remains successful");
    assert_eq!(
        repository
            .load_thread(&thread_id)
            .expect("load")
            .expect("thread")
            .lifecycle,
        DurableThreadLifecycle::Archived
    );
    assert!(matches!(
        repository.list_threads(None, 50),
        Err(RolloutError::Projection(_))
    ));

    blocker
        .execute_batch("ROLLBACK")
        .expect("release database lock");
    drop(blocker);
    drop(repository);
    let mut repository = RolloutRepository::open(&home).expect("rebuild stale projection");
    assert!(
        repository
            .list_threads(None, 50)
            .expect("list")
            .data
            .is_empty()
    );
    assert_eq!(
        repository
            .load_thread(&thread_id)
            .expect("load")
            .expect("thread")
            .lifecycle,
        DurableThreadLifecycle::Archived
    );
}

#[cfg(unix)]
#[test]
fn rejects_a_projection_database_symlink_without_following_it() {
    use std::os::unix::fs::symlink;

    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    {
        let repository = RolloutRepository::open(&home).expect("repository");
        drop(repository);
    }
    let database = directory
        .path()
        .join("projections/v1/thread-discovery.sqlite3");
    let target = directory.path().join("outside.sqlite3");
    fs::write(&target, b"outside").expect("outside file");
    fs::remove_file(&database).expect("remove projection");
    symlink(&target, &database).expect("projection symlink");

    let error = RolloutRepository::open(&home).expect_err("symlink must fail");
    let RolloutError::Projection(diagnostic) = error else {
        panic!("expected projection failure");
    };
    assert_eq!(diagnostic.kind, "invalidPathType");
    assert_eq!(fs::read(target).expect("outside remains"), b"outside");
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
