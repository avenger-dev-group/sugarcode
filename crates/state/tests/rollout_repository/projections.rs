use super::*;

#[test]
fn lists_threads_in_descending_uuid_order_with_stable_cursor_paging() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let mut repository = RolloutRepository::open(&home).expect("repository");
    for sequence in [1, 9, 10] {
        repository
            .create_thread(
                &ThreadId::parse(format!("00000000-0000-7000-8000-{sequence:012}"))
                    .expect("valid thread UUIDv7"),
            )
            .expect("persist thread");
    }

    let first = repository.list_threads(None, 2).expect("first page");
    assert_eq!(
        first
            .data
            .iter()
            .map(|thread| thread.id.as_str())
            .collect::<Vec<_>>(),
        [
            "00000000-0000-7000-8000-000000000010",
            "00000000-0000-7000-8000-000000000009"
        ]
    );
    assert_eq!(
        first.next_cursor.as_ref().map(ThreadId::as_str),
        Some("00000000-0000-7000-8000-000000000009")
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
        ["00000000-0000-7000-8000-000000000001"]
    );
    assert_eq!(second.next_cursor, None);
}

#[test]
fn rebuilt_discovery_and_search_hide_subagent_threads() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let root_id =
        ThreadId::parse("00000000-0000-7000-8000-000000000001").expect("valid thread UUIDv7");
    let child_id =
        ThreadId::parse("00000000-0000-7000-8000-000000000002").expect("valid thread UUIDv7");

    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&root_id).expect("root thread");
        repository
            .append_completed_turn(&root_id, &completed_turn(1))
            .expect("root turn");
        repository
            .create_thread_with_origin(
                &child_id,
                &DurableThreadOrigin {
                    parent_thread_id: root_id.clone(),
                    parent_turn_id: TurnId::parse("00000000-0001-7000-8000-000000000001")
                        .expect("valid turn UUIDv7"),
                    orchestration_id: "orch/root/turn/review".to_string(),
                    task_id: "orch/root/turn/review/child".to_string(),
                    role: "explorer".to_string(),
                },
            )
            .expect("child thread");
        repository
            .append_completed_turn(&child_id, &completed_turn(2))
            .expect("child turn");
    }

    let mut repository = RolloutRepository::open(&home).expect("rebuild projections");
    assert_eq!(
        repository.list_threads(None, 50).expect("list roots").data,
        vec![sugarcode_state::DurableThreadSummary {
            id: root_id.clone(),
            title: None,
        }]
    );
    assert_eq!(
        repository
            .search_threads("SugarCode deterministic", None, 50)
            .expect("search roots")
            .data,
        vec![sugarcode_state::DurableThreadSummary {
            id: root_id,
            title: None,
        }]
    );
    assert_eq!(
        repository
            .list_descendants(
                &ThreadId::parse("00000000-0000-7000-8000-000000000001")
                    .expect("valid thread UUIDv7")
            )
            .expect("child remains addressable")
            .into_iter()
            .map(|thread| thread.id)
            .collect::<Vec<_>>(),
        vec![child_id]
    );
}

#[test]
fn rebuilds_a_missing_projection_from_rollouts() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id =
        ThreadId::parse("00000000-0000-7000-8000-000000000001").expect("valid thread UUIDv7");
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
    let thread_id =
        ThreadId::parse("00000000-0000-7000-8000-000000000001").expect("valid thread UUIDv7");
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
    let thread_id =
        ThreadId::parse("00000000-0000-7000-8000-000000000001").expect("valid thread UUIDv7");
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
            .create_thread(
                &ThreadId::parse("00000000-0000-7000-8000-000000000001")
                    .expect("valid thread UUIDv7"),
            )
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
    let thread_id =
        ThreadId::parse("00000000-0000-7000-8000-000000000001").expect("valid thread UUIDv7");

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
    let thread_id =
        ThreadId::parse("00000000-0000-7000-8000-000000000001").expect("valid thread UUIDv7");
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

#[test]
fn unarchive_projection_failure_does_not_erase_the_durable_commit() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id =
        ThreadId::parse("00000000-0000-7000-8000-000000000001").expect("valid thread UUIDv7");
    let mut repository = RolloutRepository::open(&home).expect("repository");
    repository.create_thread(&thread_id).expect("thread");
    repository.archive_thread(&thread_id).expect("archive");
    let database = directory
        .path()
        .join("projections/v1/thread-discovery.sqlite3");
    let blocker = rusqlite::Connection::open(&database).expect("open projection");
    blocker
        .execute_batch("BEGIN EXCLUSIVE")
        .expect("hold exclusive database lock");

    repository
        .unarchive_thread(&thread_id)
        .expect("durable unarchive remains successful");
    assert_eq!(
        repository
            .load_thread(&thread_id)
            .expect("load")
            .expect("thread")
            .lifecycle,
        DurableThreadLifecycle::Active
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
    assert_eq!(
        repository.list_threads(None, 50).expect("list").data[0].id,
        thread_id
    );
}

#[test]
fn delete_projection_failure_does_not_erase_the_durable_commit() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id =
        ThreadId::parse("00000000-0000-7000-8000-000000000001").expect("valid thread UUIDv7");
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
        .delete_thread(&thread_id)
        .expect("durable delete remains successful");
    assert_eq!(
        repository
            .load_thread(&thread_id)
            .expect("load")
            .expect("thread")
            .lifecycle,
        DurableThreadLifecycle::Deleted
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
        DurableThreadLifecycle::Deleted
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
