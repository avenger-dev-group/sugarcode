use super::*;

#[test]
fn atomically_materializes_a_complete_independent_v1_thread_snapshot() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let source_id = ThreadId::new("thr_0000000000000001");
    let fork_id = ThreadId::new("thr_0000000000000002");
    let fork = DurableThreadSnapshot {
        id: fork_id.clone(),
        turns: vec![completed_turn(2), completed_turn(3)],
        lifecycle: DurableThreadLifecycle::Active,
    };
    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&source_id).expect("source");
        repository
            .append_completed_turn(&source_id, &completed_turn(1))
            .expect("source turn");
        repository
            .create_thread_snapshot(&fork)
            .expect("materialize fork");

        assert_eq!(
            repository
                .load_thread(&source_id)
                .expect("source load")
                .expect("source"),
            DurableThreadSnapshot {
                id: source_id.clone(),
                turns: vec![completed_turn(1)],
                lifecycle: DurableThreadLifecycle::Active,
            }
        );
        assert_eq!(
            repository
                .load_thread(&fork_id)
                .expect("fork load")
                .expect("fork"),
            fork
        );
        assert_eq!(repository.id_sequences().thread, 2);
        assert_eq!(repository.id_sequences().turn, 3);
        assert_eq!(repository.id_sequences().item, 3);
        assert_eq!(
            repository
                .list_threads(None, 50)
                .expect("list")
                .data
                .iter()
                .map(|thread| thread.id.clone())
                .collect::<Vec<_>>(),
            [fork_id.clone(), source_id.clone()]
        );
        assert_eq!(
            repository
                .search_threads("SugarCode", None, 50)
                .expect("search")
                .data
                .iter()
                .map(|thread| thread.id.clone())
                .collect::<Vec<_>>(),
            [fork_id.clone(), source_id]
        );
    }

    let rollout = directory
        .path()
        .join("rollouts/v1/thr_0000000000000002.jsonl");
    let contents = fs::read_to_string(&rollout).expect("fork rollout");
    let records = contents
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).expect("record"))
        .collect::<Vec<_>>();
    assert_eq!(records.len(), 9);
    assert_eq!(records[0]["type"], "threadCreated");
    assert_eq!(records[1]["type"], "turnStarted");
    assert_eq!(records[2]["type"], "turnItemStarted");
    assert_eq!(records[3]["type"], "turnItemCompleted");
    assert_eq!(records[4]["type"], "turnCompleted");
    assert_eq!(records[5]["type"], "turnStarted");
    assert_eq!(records[8]["type"], "turnCompleted");
    assert_eq!(records[0]["threadId"], fork_id.as_str());
    assert_eq!(records[1]["turn"]["id"], "turn_0000000000000002");
    assert_eq!(records[2]["item"]["id"], "item_0000000000000002");
    assert_eq!(records[3]["item"]["id"], "item_0000000000000002");
    assert_eq!(records[4]["turn"]["items"], serde_json::json!([]));
    assert!(
        !directory
            .path()
            .join("rollouts/v1/.thr_0000000000000002.fork.tmp")
            .exists()
    );

    let repository = RolloutRepository::open(&home).expect("replay");
    assert_eq!(
        repository
            .load_thread(&fork_id)
            .expect("fork load")
            .expect("fork"),
        fork
    );
}

#[test]
fn fork_temp_collision_leaves_no_visible_thread_and_poisoned_state_recovers_on_replay() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let source_id = ThreadId::new("thr_0000000000000001");
    let fork_id = ThreadId::new("thr_0000000000000002");
    let source_path = directory
        .path()
        .join("rollouts/v1/thr_0000000000000001.jsonl");
    let temp_path = directory
        .path()
        .join("rollouts/v1/.thr_0000000000000002.fork.tmp");
    let final_path = directory
        .path()
        .join("rollouts/v1/thr_0000000000000002.jsonl");
    let mut repository = RolloutRepository::open(&home).expect("repository");
    repository.create_thread(&source_id).expect("source");
    repository
        .append_completed_turn(&source_id, &completed_turn(1))
        .expect("source turn");
    let source_before = fs::read(&source_path).expect("source rollout");
    fs::write(&temp_path, b"private-incomplete-fork").expect("colliding artifact");

    let error = repository
        .create_thread_snapshot(&DurableThreadSnapshot {
            id: fork_id.clone(),
            turns: vec![completed_turn(2)],
            lifecycle: DurableThreadLifecycle::Active,
        })
        .expect_err("temp collision");
    assert!(matches!(
        error,
        RolloutError::Collision {
            kind: "forkCreateArtifact"
        }
    ));
    assert!(matches!(
        repository.load_thread(&source_id),
        Err(RolloutError::Poisoned)
    ));
    assert!(!final_path.exists());
    assert_eq!(
        fs::read(&source_path).expect("source rollout after failure"),
        source_before
    );
    drop(repository);

    let repository = RolloutRepository::open(&home).expect("replay removes artifact");
    assert!(!temp_path.exists());
    assert!(
        repository
            .load_thread(&fork_id)
            .expect("fork lookup")
            .is_none()
    );
    assert_eq!(repository.id_sequences().thread, 1);
    assert_eq!(
        repository.diagnostics()[0].kind,
        "forkCreateArtifactRecovered"
    );
    assert!(
        !repository.diagnostics()[0]
            .to_string()
            .contains("private-incomplete-fork")
    );
}

#[test]
fn fork_discovery_update_failure_never_rolls_back_the_durable_snapshot() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let mut repository = RolloutRepository::open(&home).expect("repository");
    repository
        .create_thread(&ThreadId::new("thr_0000000000000001"))
        .expect("source");
    repository
        .append_completed_turn(&ThreadId::new("thr_0000000000000001"), &completed_turn(1))
        .expect("source turn");
    let database = directory
        .path()
        .join("projections/v1/thread-discovery.sqlite3");
    let blocker = rusqlite::Connection::open(&database).expect("projection");
    blocker
        .execute_batch("BEGIN EXCLUSIVE")
        .expect("hold discovery lock");
    let fork_id = ThreadId::new("thr_0000000000000002");

    repository
        .create_thread_snapshot(&DurableThreadSnapshot {
            id: fork_id.clone(),
            turns: vec![completed_turn(2)],
            lifecycle: DurableThreadLifecycle::Active,
        })
        .expect("durable snapshot remains successful");
    assert_eq!(
        repository
            .load_thread(&fork_id)
            .expect("load fork")
            .expect("fork")
            .turns,
        vec![completed_turn(2)]
    );
    let listed = repository.list_threads(None, 50);
    if let Err(RolloutError::Projection(diagnostic)) = &listed {
        assert_eq!(diagnostic.kind, "busy");
    } else {
        assert_eq!(
            listed
                .expect("projection may complete before the lock is observed")
                .data[0]
                .id,
            fork_id
        );
    }
    assert_eq!(
        repository
            .search_threads("SugarCode", None, 50)
            .expect("search projection remains available")
            .data[0]
            .id,
        fork_id
    );

    blocker.execute_batch("ROLLBACK").expect("release lock");
    drop(blocker);
    drop(repository);
    let mut repository = RolloutRepository::open(&home).expect("rebuild from durable snapshot");
    assert_eq!(
        repository
            .list_threads(None, 50)
            .expect("rebuilt list")
            .data[0]
            .id,
        fork_id
    );
}
