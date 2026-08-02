use std::fs;
use sugarcode_protocol::ItemId;
use sugarcode_protocol::ThreadId;
use sugarcode_protocol::TurnId;
use sugarcode_state::DurableItemSnapshot;
use sugarcode_state::DurableThreadLifecycle;
use sugarcode_state::DurableThreadSnapshot;
use sugarcode_state::DurableTurnError;
use sugarcode_state::DurableTurnErrorKind;
use sugarcode_state::DurableTurnSnapshot;
use sugarcode_state::DurableTurnStatus;
use sugarcode_state::HomeResolutionInputs;
use sugarcode_state::RolloutError;
use sugarcode_state::RolloutRepository;
use sugarcode_state::ThreadRepository;
use sugarcode_state::resolve_sugarcode_home;
use tempfile::tempdir;

fn home(directory: &tempfile::TempDir) -> sugarcode_state::SugarCodeHome {
    resolve_sugarcode_home(HomeResolutionInputs {
        cli_override: Some(directory.path().to_path_buf()),
        ..Default::default()
    })
    .expect("resolve home")
}

fn thread(sequence: u64) -> ThreadId {
    ThreadId::new(format!("thr_{sequence:016}"))
}

fn turn(sequence: u64, text: &str) -> DurableTurnSnapshot {
    DurableTurnSnapshot {
        model: None,
        id: TurnId::new(format!("turn_{sequence:016}")),
        status: DurableTurnStatus::Completed,
        items: vec![DurableItemSnapshot::AgentMessage {
            id: ItemId::new(format!("item_{sequence:016}")),
            text: text.to_string(),
        }],
        context_compaction: None,
        workspace_instructions: None,
        workspace_skills: None,
        error: None,
        usage: None,
    }
}

fn seed(repository: &mut RolloutRepository) {
    repository.create_thread(&thread(1)).expect("first thread");
    repository
        .append_completed_turn(&thread(1), &turn(1, "Café release planning"))
        .expect("first turn");
    repository.create_thread(&thread(2)).expect("second thread");
    repository
        .append_completed_turn(&thread(2), &turn(2, "SugarCode release notes"))
        .expect("second turn");
    repository.create_thread(&thread(3)).expect("empty thread");
}

fn started_turn(sequence: u64, input: &str) -> DurableTurnSnapshot {
    DurableTurnSnapshot {
        model: None,
        id: TurnId::new(format!("turn_{sequence:016}")),
        status: DurableTurnStatus::InProgress,
        items: vec![
            DurableItemSnapshot::UserMessage {
                id: ItemId::new(format!("item_{:016}", sequence * 2 - 1)),
                content: vec![sugarcode_state::DurableUserContentPart::Text {
                    text: input.to_string(),
                }],
            },
            DurableItemSnapshot::AgentMessage {
                id: ItemId::new(format!("item_{:016}", sequence * 2)),
                text: String::new(),
            },
        ],
        context_compaction: None,
        workspace_instructions: None,
        workspace_skills: None,
        error: None,
        usage: None,
    }
}

#[test]
fn searches_completed_messages_with_unicode_terms_and_stable_id_paging() {
    let directory = tempdir().expect("home");
    let mut repository = RolloutRepository::open(&home(&directory)).expect("repository");
    seed(&mut repository);

    let release = repository
        .search_threads("release", None, 1)
        .expect("first page");
    assert_eq!(release.data[0].id, thread(2));
    assert_eq!(release.next_cursor, Some(thread(2)));
    let second = repository
        .search_threads("release", release.next_cursor.as_ref(), 1)
        .expect("second page");
    assert_eq!(second.data[0].id, thread(1));
    assert_eq!(second.next_cursor, None);

    assert_eq!(
        repository
            .search_threads("cafe planning", None, 50)
            .expect("diacritic-insensitive search")
            .data[0]
            .id,
        thread(1)
    );
    assert!(
        repository
            .search_threads("notes planning", None, 50)
            .expect("AND terms")
            .data
            .is_empty()
    );
    assert!(
        repository
            .search_threads("SugarCode", None, 50)
            .expect("search")
            .data
            .iter()
            .all(|summary| summary.id != thread(3))
    );
    for literal_query in ["NEAR", "\"", "-", "*", "type:agentMessage"] {
        repository
            .search_threads(literal_query, None, 50)
            .unwrap_or_else(|error| panic!("literal query {literal_query:?} failed: {error}"));
    }
    let database = directory
        .path()
        .join("projections/v1/thread-search.sqlite3");
    let connection = rusqlite::Connection::open(database).expect("open search database");
    let stored_text: Option<String> = connection
        .query_row("SELECT text FROM search_fts LIMIT 1", [], |row| row.get(0))
        .expect("contentless FTS row");
    assert_eq!(stored_text, None, "FTS must not expose a content column");
}

#[test]
fn failed_and_interrupted_partial_output_is_never_searchable_even_after_rebuild() {
    let directory = tempdir().expect("home");
    let resolved_home = home(&directory);
    {
        let mut repository = RolloutRepository::open(&resolved_home).expect("repository");
        for (sequence, status) in [
            (1, DurableTurnStatus::Failed),
            (2, DurableTurnStatus::Interrupted),
        ] {
            let thread_id = thread(sequence);
            repository.create_thread(&thread_id).expect("thread");
            let started = started_turn(sequence, "private input");
            repository
                .begin_turn(&thread_id, &started)
                .expect("turn start");
            let mut terminal = started;
            terminal.status = status;
            let DurableItemSnapshot::AgentMessage { text, .. } = &mut terminal.items[1] else {
                panic!("agent item");
            };
            *text = format!("partial-secret-{sequence}");
            if status == DurableTurnStatus::Failed {
                terminal.error = Some(DurableTurnError {
                    kind: DurableTurnErrorKind::Protocol,
                    retryable: false,
                    provider: None,
                    protocol: None,
                    tool_schema: None,
                });
            }
            repository
                .finish_turn(&thread_id, &terminal)
                .expect("turn terminal");
        }
        assert!(
            repository
                .search_threads("partial-secret", None, 50)
                .expect("search")
                .data
                .is_empty()
        );
    }

    fs::remove_file(
        directory
            .path()
            .join("projections/v1/thread-search.sqlite3"),
    )
    .expect("remove projection");
    let mut repository = RolloutRepository::open(&resolved_home).expect("rebuild");
    assert!(
        repository
            .search_threads("partial-secret", None, 50)
            .expect("rebuilt search")
            .data
            .is_empty()
    );
}

#[test]
fn indexes_a_materialized_thread_snapshot_in_one_rebuildable_update() {
    let directory = tempdir().expect("home");
    let resolved_home = home(&directory);
    let mut repository = RolloutRepository::open(&resolved_home).expect("repository");
    repository.create_thread(&thread(1)).expect("source");
    repository
        .append_completed_turn(&thread(1), &turn(1, "source private history"))
        .expect("source turn");
    let fork = DurableThreadSnapshot {
        id: thread(2),
        turns: vec![
            turn(2, "copied private history"),
            turn(3, "second copied message"),
        ],
        lifecycle: DurableThreadLifecycle::Active,
        origin: None,
    };
    repository
        .create_thread_snapshot(&fork)
        .expect("materialized fork");
    assert_eq!(
        repository
            .search_threads("copied", None, 50)
            .expect("search")
            .data,
        vec![sugarcode_state::DurableThreadSummary {
            id: thread(2),
            title: None,
        }]
    );
    drop(repository);

    fs::remove_file(
        directory
            .path()
            .join("projections/v1/thread-search.sqlite3"),
    )
    .expect("remove search projection");
    let mut repository = RolloutRepository::open(&resolved_home).expect("rebuild");
    assert_eq!(
        repository
            .search_threads("copied", None, 50)
            .expect("rebuilt search")
            .data[0]
            .id,
        thread(2)
    );
}

#[test]
fn fork_search_update_failure_never_rolls_back_the_durable_snapshot() {
    let directory = tempdir().expect("home");
    let resolved_home = home(&directory);
    let mut repository = RolloutRepository::open(&resolved_home).expect("repository");
    repository.create_thread(&thread(1)).expect("source");
    repository
        .append_completed_turn(&thread(1), &turn(1, "source private history"))
        .expect("source turn");
    let database = directory
        .path()
        .join("projections/v1/thread-search.sqlite3");
    let blocker = rusqlite::Connection::open(&database).expect("projection");
    blocker
        .execute_batch("BEGIN EXCLUSIVE")
        .expect("hold search lock");

    repository
        .create_thread_snapshot(&DurableThreadSnapshot {
            id: thread(2),
            turns: vec![turn(2, "copied private history")],
            lifecycle: DurableThreadLifecycle::Active,
            origin: None,
        })
        .expect("durable snapshot remains successful");
    assert_eq!(
        repository
            .load_thread(&thread(2))
            .expect("load")
            .expect("fork")
            .turns[0],
        turn(2, "copied private history")
    );
    assert_eq!(
        repository.list_threads(None, 50).expect("list").data[0].id,
        thread(2)
    );
    let RolloutError::Projection(diagnostic) = repository
        .search_threads("copied", None, 50)
        .expect_err("dirty search is unavailable")
    else {
        panic!("expected projection error");
    };
    assert_eq!(diagnostic.kind, "busy");

    blocker.execute_batch("ROLLBACK").expect("release lock");
    drop(blocker);
    drop(repository);
    let mut repository =
        RolloutRepository::open(&resolved_home).expect("rebuild from durable snapshot");
    assert_eq!(
        repository
            .search_threads("copied", None, 50)
            .expect("rebuilt search")
            .data[0]
            .id,
        thread(2)
    );
}

#[test]
fn archived_threads_are_excluded_before_and_after_search_rebuild() {
    let directory = tempdir().expect("home");
    let resolved_home = home(&directory);
    {
        let mut repository = RolloutRepository::open(&resolved_home).expect("repository");
        seed(&mut repository);
        repository.archive_thread(&thread(2)).expect("archive");
        assert_eq!(
            repository
                .search_threads("release", None, 50)
                .expect("search")
                .data
                .iter()
                .map(|summary| summary.id.clone())
                .collect::<Vec<_>>(),
            [thread(1)]
        );
        assert_eq!(
            repository
                .load_thread(&thread(2))
                .expect("load")
                .expect("thread")
                .lifecycle,
            DurableThreadLifecycle::Archived
        );
    }

    let database = directory
        .path()
        .join("projections/v1/thread-search.sqlite3");
    fs::write(&database, b"private-archived-projection-sentinel")
        .expect("corrupt search projection");
    let mut repository = RolloutRepository::open(&resolved_home).expect("rebuild");
    assert_eq!(
        repository
            .search_threads("release", None, 50)
            .expect("rebuilt search")
            .data
            .iter()
            .map(|summary| summary.id.clone())
            .collect::<Vec<_>>(),
        [thread(1)]
    );
    assert!(
        !repository.search_projection_diagnostics()[0]
            .to_string()
            .contains("private-archived-projection-sentinel")
    );
}

#[test]
fn unarchived_threads_restore_search_with_exact_turn_record_sequences() {
    let directory = tempdir().expect("home");
    let resolved_home = home(&directory);
    let database = directory
        .path()
        .join("projections/v1/thread-search.sqlite3");
    {
        let mut repository = RolloutRepository::open(&resolved_home).expect("repository");
        repository.create_thread(&thread(1)).expect("thread");
        repository
            .append_completed_turn(&thread(1), &turn(1, "before archive"))
            .expect("first turn");
        repository.archive_thread(&thread(1)).expect("archive");
        repository.unarchive_thread(&thread(1)).expect("unarchive");
        repository
            .append_completed_turn(&thread(1), &turn(2, "after restore"))
            .expect("second turn");
        assert_eq!(
            repository
                .search_threads("restore", None, 50)
                .expect("restored search")
                .data[0]
                .id,
            thread(1)
        );
        let connection = rusqlite::Connection::open(&database).expect("open projection");
        let sequence: i64 = connection
            .query_row(
                "SELECT rollout_sequence FROM search_documents WHERE item_id = ?1",
                ["item_0000000000000002"],
                |row| row.get(0),
            )
            .expect("second turn sequence");
        assert_eq!(sequence, 11);
    }

    fs::remove_file(&database).expect("remove projection");
    let mut repository = RolloutRepository::open(&resolved_home).expect("rebuild");
    assert_eq!(
        repository
            .search_threads("restore", None, 50)
            .expect("rebuilt restored search")
            .data[0]
            .id,
        thread(1)
    );
    let connection = rusqlite::Connection::open(database).expect("open rebuilt projection");
    let sequence: i64 = connection
        .query_row(
            "SELECT rollout_sequence FROM search_documents WHERE item_id = ?1",
            ["item_0000000000000002"],
            |row| row.get(0),
        )
        .expect("rebuilt second turn sequence");
    assert_eq!(sequence, 11);
}

#[test]
fn deleted_threads_are_excluded_before_and_after_search_rebuild() {
    let directory = tempdir().expect("home");
    let resolved_home = home(&directory);
    {
        let mut repository = RolloutRepository::open(&resolved_home).expect("repository");
        seed(&mut repository);
        repository.delete_thread(&thread(2)).expect("delete");
        assert_eq!(
            repository
                .search_threads("release", None, 50)
                .expect("search")
                .data
                .iter()
                .map(|summary| summary.id.clone())
                .collect::<Vec<_>>(),
            [thread(1)]
        );
        assert_eq!(
            repository
                .load_thread(&thread(2))
                .expect("load")
                .expect("thread")
                .lifecycle,
            DurableThreadLifecycle::Deleted
        );
    }

    let database = directory
        .path()
        .join("projections/v1/thread-search.sqlite3");
    fs::remove_file(&database).expect("remove search projection");
    let mut repository = RolloutRepository::open(&resolved_home).expect("rebuild");
    assert_eq!(
        repository
            .search_threads("release", None, 50)
            .expect("rebuilt search")
            .data
            .iter()
            .map(|summary| summary.id.clone())
            .collect::<Vec<_>>(),
        [thread(1)]
    );
}

#[test]
fn rejects_unbounded_or_control_character_queries_without_writing_them() {
    let directory = tempdir().expect("home");
    let mut repository = RolloutRepository::open(&home(&directory)).expect("repository");
    seed(&mut repository);
    let sentinel = "private-query-sentinel\n";

    assert!(matches!(
        repository.search_threads(sentinel, None, 50),
        Err(RolloutError::InvalidRecord {
            kind: "threadSearchQuery"
        })
    ));
    assert!(matches!(
        repository.search_threads(&"x".repeat(257), None, 50),
        Err(RolloutError::InvalidRecord {
            kind: "threadSearchQuery"
        })
    ));
    assert!(matches!(
        repository.search_threads(&"term ".repeat(17), None, 50),
        Err(RolloutError::InvalidRecord {
            kind: "threadSearchQuery"
        })
    ));
    let database = directory
        .path()
        .join("projections/v1/thread-search.sqlite3");
    assert!(
        !fs::read(database)
            .expect("read projection")
            .windows(sentinel.len())
            .any(|window| window == sentinel.as_bytes())
    );
}

#[test]
fn rebuilds_missing_corrupt_and_stale_search_projections_from_rollouts() {
    for corruption in ["missing", "invalid-header", "stale"] {
        let directory = tempdir().expect("home");
        let resolved_home = home(&directory);
        {
            let mut repository =
                RolloutRepository::open(&resolved_home).expect("initial repository");
            seed(&mut repository);
        }
        let database = directory
            .path()
            .join("projections/v1/thread-search.sqlite3");
        match corruption {
            "missing" => fs::remove_file(&database).expect("remove projection"),
            "invalid-header" => {
                fs::write(&database, b"private-corruption-sentinel").expect("corrupt projection")
            }
            "stale" => {
                let connection =
                    rusqlite::Connection::open(&database).expect("open search projection");
                connection
                    .execute("DELETE FROM search_documents", [])
                    .expect("make stale");
            }
            _ => unreachable!(),
        }

        let mut repository =
            RolloutRepository::open(&resolved_home).expect("rollouts remain available");
        assert_eq!(
            repository
                .search_threads("release", None, 50)
                .expect("rebuilt search")
                .data
                .iter()
                .map(|summary| summary.id.clone())
                .collect::<Vec<_>>(),
            [thread(2), thread(1)]
        );
        if corruption != "missing" {
            assert_eq!(repository.search_projection_diagnostics().len(), 1);
            assert!(
                !repository.search_projection_diagnostics()[0]
                    .to_string()
                    .contains("private-corruption-sentinel")
            );
        }
    }
}

#[test]
fn a_busy_search_projection_does_not_disable_list_or_resume() {
    let directory = tempdir().expect("home");
    let resolved_home = home(&directory);
    {
        let mut repository = RolloutRepository::open(&resolved_home).expect("repository");
        seed(&mut repository);
    }
    let database = directory
        .path()
        .join("projections/v1/thread-search.sqlite3");
    let blocker = rusqlite::Connection::open(&database).expect("projection");
    blocker
        .execute_batch("BEGIN EXCLUSIVE")
        .expect("hold search lock");

    let mut repository =
        RolloutRepository::open(&resolved_home).expect("repository remains available");
    assert_eq!(
        repository.list_threads(None, 50).expect("list").data.len(),
        3
    );
    assert!(
        repository
            .load_thread(&thread(1))
            .expect("resume")
            .is_some()
    );
    let RolloutError::Projection(diagnostic) = repository
        .search_threads("release", None, 50)
        .expect_err("search is unavailable")
    else {
        panic!("expected projection error");
    };
    assert_eq!(diagnostic.kind, "busy");
    assert!(diagnostic.to_string().contains("thread search"));
}

#[test]
fn a_search_update_failure_never_rolls_back_the_durable_commit() {
    let directory = tempdir().expect("home");
    let resolved_home = home(&directory);
    let mut repository = RolloutRepository::open(&resolved_home).expect("repository");
    let database = directory
        .path()
        .join("projections/v1/thread-search.sqlite3");
    let blocker = rusqlite::Connection::open(&database).expect("projection");
    blocker
        .execute_batch("BEGIN EXCLUSIVE")
        .expect("hold search lock");
    let thread_id = thread(1);

    repository
        .create_thread(&thread_id)
        .expect("rollout commit remains successful");
    let RolloutError::Projection(diagnostic) = repository
        .search_threads("anything", None, 50)
        .expect_err("dirty search is unavailable")
    else {
        panic!("expected projection error");
    };
    assert_eq!(diagnostic.kind, "busy");
    assert!(
        repository
            .load_thread(&thread_id)
            .expect("resume")
            .is_some()
    );
    assert_eq!(
        repository.list_threads(None, 50).expect("list").data.len(),
        1
    );

    blocker.execute_batch("ROLLBACK").expect("release lock");
    drop(blocker);
    drop(repository);
    let mut repository =
        RolloutRepository::open(&resolved_home).expect("stale search rebuilds from rollout");
    assert!(
        repository
            .search_threads("anything", None, 50)
            .expect("search")
            .data
            .is_empty()
    );
    assert!(
        repository
            .load_thread(&thread_id)
            .expect("resume")
            .is_some()
    );
}

#[test]
fn an_archive_search_update_failure_never_rolls_back_the_durable_commit() {
    let directory = tempdir().expect("home");
    let resolved_home = home(&directory);
    let mut repository = RolloutRepository::open(&resolved_home).expect("repository");
    repository.create_thread(&thread(1)).expect("thread");
    repository
        .append_completed_turn(&thread(1), &turn(1, "SugarCode archive proof"))
        .expect("turn");
    let database = directory
        .path()
        .join("projections/v1/thread-search.sqlite3");
    let blocker = rusqlite::Connection::open(&database).expect("projection");
    blocker
        .execute_batch("BEGIN EXCLUSIVE")
        .expect("hold search lock");

    repository
        .archive_thread(&thread(1))
        .expect("durable archive remains successful");
    assert_eq!(
        repository
            .load_thread(&thread(1))
            .expect("load")
            .expect("thread")
            .lifecycle,
        DurableThreadLifecycle::Archived
    );
    assert!(
        repository
            .list_threads(None, 50)
            .expect("discovery remains available")
            .data
            .is_empty()
    );
    assert!(matches!(
        repository.search_threads("archive", None, 50),
        Err(RolloutError::Projection(_))
    ));

    blocker.execute_batch("ROLLBACK").expect("release lock");
    drop(blocker);
    drop(repository);
    let mut repository = RolloutRepository::open(&resolved_home).expect("stale search rebuilds");
    assert!(
        repository
            .search_threads("archive", None, 50)
            .expect("rebuilt search")
            .data
            .is_empty()
    );
}

#[test]
fn an_unarchive_search_update_failure_never_rolls_back_the_durable_commit() {
    let directory = tempdir().expect("home");
    let resolved_home = home(&directory);
    let mut repository = RolloutRepository::open(&resolved_home).expect("repository");
    repository.create_thread(&thread(1)).expect("thread");
    repository
        .append_completed_turn(&thread(1), &turn(1, "SugarCode restore proof"))
        .expect("turn");
    repository.archive_thread(&thread(1)).expect("archive");
    let database = directory
        .path()
        .join("projections/v1/thread-search.sqlite3");
    let blocker = rusqlite::Connection::open(&database).expect("projection");
    blocker
        .execute_batch("BEGIN EXCLUSIVE")
        .expect("hold search lock");

    repository
        .unarchive_thread(&thread(1))
        .expect("durable unarchive remains successful");
    assert_eq!(
        repository
            .load_thread(&thread(1))
            .expect("load")
            .expect("thread")
            .lifecycle,
        DurableThreadLifecycle::Active
    );
    assert_eq!(
        repository
            .list_threads(None, 50)
            .expect("discovery remains available")
            .data[0]
            .id,
        thread(1)
    );
    assert!(matches!(
        repository.search_threads("restore", None, 50),
        Err(RolloutError::Projection(_))
    ));

    blocker.execute_batch("ROLLBACK").expect("release lock");
    drop(blocker);
    drop(repository);
    let mut repository = RolloutRepository::open(&resolved_home).expect("stale search rebuilds");
    assert_eq!(
        repository
            .search_threads("restore", None, 50)
            .expect("rebuilt search")
            .data[0]
            .id,
        thread(1)
    );
}

#[test]
fn a_delete_search_update_failure_never_rolls_back_the_durable_commit() {
    let directory = tempdir().expect("home");
    let resolved_home = home(&directory);
    let mut repository = RolloutRepository::open(&resolved_home).expect("repository");
    repository.create_thread(&thread(1)).expect("thread");
    repository
        .append_completed_turn(&thread(1), &turn(1, "SugarCode delete proof"))
        .expect("turn");
    let database = directory
        .path()
        .join("projections/v1/thread-search.sqlite3");
    let blocker = rusqlite::Connection::open(&database).expect("projection");
    blocker
        .execute_batch("BEGIN EXCLUSIVE")
        .expect("hold search lock");

    repository
        .delete_thread(&thread(1))
        .expect("durable delete remains successful");
    assert_eq!(
        repository
            .load_thread(&thread(1))
            .expect("load")
            .expect("thread")
            .lifecycle,
        DurableThreadLifecycle::Deleted
    );
    assert!(
        repository
            .list_threads(None, 50)
            .expect("discovery remains available")
            .data
            .is_empty()
    );
    assert!(matches!(
        repository.search_threads("delete", None, 50),
        Err(RolloutError::Projection(_))
    ));

    blocker.execute_batch("ROLLBACK").expect("release lock");
    drop(blocker);
    drop(repository);
    let mut repository = RolloutRepository::open(&resolved_home).expect("stale search rebuilds");
    assert!(
        repository
            .search_threads("delete", None, 50)
            .expect("rebuilt search")
            .data
            .is_empty()
    );
}

#[cfg(unix)]
#[test]
fn a_search_database_symlink_is_isolated_and_never_followed() {
    use std::os::unix::fs::symlink;

    let directory = tempdir().expect("home");
    let resolved_home = home(&directory);
    {
        let repository = RolloutRepository::open(&resolved_home).expect("repository");
        drop(repository);
    }
    let database = directory
        .path()
        .join("projections/v1/thread-search.sqlite3");
    let target = directory.path().join("outside.sqlite3");
    fs::write(&target, b"outside").expect("outside");
    fs::remove_file(&database).expect("remove search database");
    symlink(&target, &database).expect("search symlink");

    let mut repository =
        RolloutRepository::open(&resolved_home).expect("rollout repository remains usable");
    assert!(
        repository
            .list_threads(None, 50)
            .expect("list")
            .data
            .is_empty()
    );
    let error = repository
        .search_threads("anything", None, 50)
        .expect_err("search unavailable");
    assert!(matches!(error, RolloutError::Projection(_)));
    assert_eq!(fs::read(target).expect("outside unchanged"), b"outside");
}
