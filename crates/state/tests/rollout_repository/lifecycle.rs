use super::*;

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
fn unarchives_in_rollout_v1_with_monotonic_sequences_and_rebuildable_views() {
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
            .expect("first turn");
        repository.archive_thread(&thread_id).expect("archive");
        repository.unarchive_thread(&thread_id).expect("unarchive");
        let unarchived_bytes = fs::read(&rollout).expect("read unarchived rollout");
        repository
            .unarchive_thread(&thread_id)
            .expect("unarchive is idempotent");
        assert_eq!(
            fs::read(&rollout).expect("read idempotent rollout"),
            unarchived_bytes,
            "an idempotent unarchive must not append another record"
        );
        repository
            .append_completed_turn(&thread_id, &completed_turn(2))
            .expect("turn after unarchive");
        assert_eq!(
            repository.list_threads(None, 50).expect("list").data[0].id,
            thread_id
        );
        assert_eq!(
            repository
                .search_threads("SugarCode", None, 50)
                .expect("search")
                .data[0]
                .id,
            thread_id
        );
        repository.archive_thread(&thread_id).expect("rearchive");
    }

    assert_eq!(
        fs::read_to_string(&rollout).expect("read rollout"),
        concat!(
            "{\"schemaVersion\":1,\"sequence\":1,\"type\":\"threadCreated\",\"threadId\":\"thr_0000000000000001\"}\n",
            "{\"schemaVersion\":1,\"sequence\":2,\"type\":\"turnCompleted\",\"threadId\":\"thr_0000000000000001\",\"turn\":{\"id\":\"turn_0000000000000001\",\"status\":\"completed\",\"items\":[{\"type\":\"agentMessage\",\"id\":\"item_0000000000000001\",\"text\":\"SugarCode deterministic response.\"}]}}\n",
            "{\"schemaVersion\":1,\"sequence\":3,\"type\":\"threadArchived\",\"threadId\":\"thr_0000000000000001\"}\n",
            "{\"schemaVersion\":1,\"sequence\":4,\"type\":\"threadUnarchived\",\"threadId\":\"thr_0000000000000001\"}\n",
            "{\"schemaVersion\":1,\"sequence\":5,\"type\":\"turnCompleted\",\"threadId\":\"thr_0000000000000001\",\"turn\":{\"id\":\"turn_0000000000000002\",\"status\":\"completed\",\"items\":[{\"type\":\"agentMessage\",\"id\":\"item_0000000000000002\",\"text\":\"SugarCode deterministic response.\"}]}}\n",
            "{\"schemaVersion\":1,\"sequence\":6,\"type\":\"threadArchived\",\"threadId\":\"thr_0000000000000001\"}\n"
        )
    );

    for database in ["thread-discovery.sqlite3", "thread-search.sqlite3"] {
        fs::remove_file(directory.path().join("projections/v1").join(database))
            .expect("remove projection");
    }
    {
        let mut repository = RolloutRepository::open(&home).expect("rebuild archived views");
        assert!(
            repository
                .list_threads(None, 50)
                .expect("archived list")
                .data
                .is_empty()
        );
        repository
            .unarchive_thread(&thread_id)
            .expect("unarchive after replay");
        assert_eq!(
            repository
                .search_threads("SugarCode", None, 50)
                .expect("restored search")
                .data[0]
                .id,
            thread_id
        );
    }
    for database in ["thread-discovery.sqlite3", "thread-search.sqlite3"] {
        fs::remove_file(directory.path().join("projections/v1").join(database))
            .expect("remove projection again");
    }
    let mut repository = RolloutRepository::open(&home).expect("rebuild active views");
    let snapshot = repository
        .load_thread(&thread_id)
        .expect("load")
        .expect("thread");
    assert_eq!(snapshot.lifecycle, DurableThreadLifecycle::Active);
    assert_eq!(snapshot.turns, vec![completed_turn(1), completed_turn(2)]);
    assert_eq!(
        repository.list_threads(None, 50).expect("active list").data[0].id,
        thread_id
    );
}

#[test]
fn deletes_active_or_archived_threads_with_terminal_v1_tombstones() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let active_id = ThreadId::new("thr_0000000000000001");
    let archived_id = ThreadId::new("thr_0000000000000002");

    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        for (thread_id, turn) in [(&active_id, 1), (&archived_id, 2)] {
            repository.create_thread(thread_id).expect("thread");
            repository
                .append_completed_turn(thread_id, &completed_turn(turn))
                .expect("turn");
        }
        repository
            .archive_thread(&archived_id)
            .expect("archive second thread");
        repository.delete_thread(&active_id).expect("delete active");
        repository
            .delete_thread(&archived_id)
            .expect("delete archived");

        let active_bytes = fs::read(
            directory
                .path()
                .join("rollouts/v1/thr_0000000000000001.jsonl"),
        )
        .expect("read active rollout");
        repository
            .delete_thread(&active_id)
            .expect("delete is idempotent");
        assert_eq!(
            fs::read(
                directory
                    .path()
                    .join("rollouts/v1/thr_0000000000000001.jsonl")
            )
            .expect("read idempotent rollout"),
            active_bytes
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
        for thread_id in [&active_id, &archived_id] {
            assert_eq!(
                repository
                    .load_thread(thread_id)
                    .expect("load")
                    .expect("thread")
                    .lifecycle,
                DurableThreadLifecycle::Deleted
            );
            assert!(matches!(
                repository.archive_thread(thread_id),
                Err(RolloutError::InvalidRecord {
                    kind: "recordAfterThreadDelete"
                })
            ));
            assert!(matches!(
                repository.unarchive_thread(thread_id),
                Err(RolloutError::InvalidRecord {
                    kind: "recordAfterThreadDelete"
                })
            ));
            assert!(matches!(
                repository.append_completed_turn(thread_id, &completed_turn(3)),
                Err(RolloutError::InvalidRecord {
                    kind: "recordAfterThreadDelete"
                })
            ));
        }
    }

    assert!(
        fs::read_to_string(
            directory
                .path()
                .join("rollouts/v1/thr_0000000000000001.jsonl")
        )
        .expect("read rollout")
        .ends_with(
            "{\"schemaVersion\":1,\"sequence\":3,\"type\":\"threadDeleted\",\"threadId\":\"thr_0000000000000001\"}\n"
        )
    );
    assert!(
        fs::read_to_string(
            directory
                .path()
                .join("rollouts/v1/thr_0000000000000002.jsonl")
        )
        .expect("read rollout")
        .ends_with(
            "{\"schemaVersion\":1,\"sequence\":4,\"type\":\"threadDeleted\",\"threadId\":\"thr_0000000000000002\"}\n"
        )
    );

    for database in ["thread-discovery.sqlite3", "thread-search.sqlite3"] {
        fs::remove_file(directory.path().join("projections/v1").join(database))
            .expect("remove projection");
    }
    let mut repository = RolloutRepository::open(&home).expect("rebuild deleted views");
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
    assert_eq!(repository.id_sequences().thread, 2);
    assert_eq!(repository.id_sequences().turn, 2);
    assert_eq!(repository.id_sequences().item, 2);
}
