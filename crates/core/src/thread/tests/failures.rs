use super::*;

#[test]
fn failed_thread_write_does_not_commit_memory_or_advance_ids() {
    let mut core = Core::with_repository(Box::new(FailingRepository {
        fail_create: true,
        fail_append: false,
        ..Default::default()
    }));

    assert_eq!(
        core.start_thread(CoreRequestId::new(1)),
        Err(CoreError::StateUnavailable)
    );
    assert_eq!(core.thread_count(), 0);
    assert_eq!(core.last_thread_sequence, 0);
}

#[test]
fn failed_turn_write_does_not_commit_memory_or_advance_ids() {
    let mut core = Core::with_repository(Box::new(FailingRepository {
        fail_create: false,
        fail_append: true,
        ..Default::default()
    }));
    let thread_id = start_thread(&mut core, 1);

    assert_eq!(
        core.start_turn(CoreRequestId::new(2), thread_id.clone()),
        Err(CoreError::StateUnavailable)
    );
    assert_eq!(core.turn_count(&thread_id), 0);
    assert_eq!(core.last_turn_sequence, 0);
    assert_eq!(core.last_item_sequence, 0);
}

#[test]
fn failed_archive_write_does_not_hide_the_in_memory_thread() {
    let mut core = Core::with_repository(Box::new(FailingRepository {
        fail_create: false,
        fail_append: false,
        ..Default::default()
    }));
    let thread_id = start_thread(&mut core, 1);

    assert_eq!(
        core.archive_thread(&thread_id),
        Err(CoreError::StateUnavailable)
    );
    assert!(core.contains_thread(&thread_id));
    core.start_turn(CoreRequestId::new(2), thread_id)
        .expect("thread stays active");
}

#[test]
fn failed_unarchive_write_does_not_restore_the_thread_in_memory() {
    let thread_id = ThreadId::new("thr_0000000000000001");
    let mut threads = BTreeMap::new();
    threads.insert(
        thread_id.clone(),
        DurableThreadSnapshot {
            id: thread_id.clone(),
            turns: Vec::new(),
            lifecycle: DurableThreadLifecycle::Archived,
            origin: None,
        },
    );
    let mut core = Core::with_repository(Box::new(FailingRepository {
        threads,
        ..Default::default()
    }));

    assert_eq!(
        core.unarchive_thread(&thread_id),
        Err(CoreError::StateUnavailable)
    );
    assert!(!core.contains_thread(&thread_id));
}

#[test]
fn failed_delete_write_does_not_hide_the_in_memory_thread() {
    let mut core = Core::with_repository(Box::new(FailingRepository {
        fail_create: false,
        fail_append: false,
        ..Default::default()
    }));
    let thread_id = start_thread(&mut core, 1);

    assert_eq!(
        core.delete_thread(&thread_id),
        Err(CoreError::StateUnavailable)
    );
    assert!(core.contains_thread(&thread_id));
    core.start_turn(CoreRequestId::new(2), thread_id)
        .expect("thread stays active");
}

#[test]
fn failed_fork_write_does_not_materialize_or_advance_ids() {
    let source_id = ThreadId::new("thr_0000000000000001");
    let source = DurableThreadSnapshot {
        id: source_id.clone(),
        turns: vec![DurableTurnSnapshot {
            id: TurnId::new("turn_0000000000000001"),
            status: DurableTurnStatus::Completed,
            items: vec![DurableItemSnapshot::AgentMessage {
                id: ItemId::new("item_0000000000000001"),
                text: DETERMINISTIC_AGENT_MESSAGE.to_string(),
            }],
            context_compaction: None,
            workspace_instructions: None,
            workspace_skills: None,
            error: None,
            usage: None,
        }],
        lifecycle: DurableThreadLifecycle::Active,
        origin: None,
    };
    let mut threads = BTreeMap::new();
    threads.insert(source_id.clone(), source);
    let mut core = Core::with_repository(Box::new(FailingRepository {
        fail_create: true,
        threads,
        sequences: IdSequences {
            thread: 1,
            turn: 1,
            item: 1,
        },
        ..Default::default()
    }));

    assert_eq!(
        core.fork_thread(&source_id),
        Err(CoreError::StateUnavailable)
    );
    assert_eq!(core.thread_count(), 0);
    assert_eq!(core.last_thread_sequence, 1);
    assert_eq!(core.last_turn_sequence, 1);
    assert_eq!(core.last_item_sequence, 1);
}

#[derive(Debug, Default)]
struct FailingRepository {
    fail_create: bool,
    fail_append: bool,
    threads: BTreeMap<ThreadId, DurableThreadSnapshot>,
    sequences: IdSequences,
}

impl ThreadRepository for FailingRepository {
    fn id_sequences(&self) -> IdSequences {
        self.sequences
    }

    fn create_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError> {
        if self.fail_create {
            return Err(RolloutError::Poisoned);
        }
        self.threads.insert(
            thread_id.clone(),
            DurableThreadSnapshot {
                id: thread_id.clone(),
                turns: Vec::new(),
                lifecycle: DurableThreadLifecycle::Active,
                origin: None,
            },
        );
        Ok(())
    }

    fn create_thread_snapshot(
        &mut self,
        snapshot: &DurableThreadSnapshot,
    ) -> Result<(), RolloutError> {
        if self.fail_create {
            return Err(RolloutError::Poisoned);
        }
        self.threads.insert(snapshot.id.clone(), snapshot.clone());
        Ok(())
    }

    fn append_completed_turn(
        &mut self,
        _thread_id: &ThreadId,
        _turn: &DurableTurnSnapshot,
    ) -> Result<(), RolloutError> {
        if self.fail_append {
            Err(RolloutError::Poisoned)
        } else {
            Ok(())
        }
    }

    fn archive_thread(&mut self, _thread_id: &ThreadId) -> Result<(), RolloutError> {
        Err(RolloutError::Poisoned)
    }

    fn unarchive_thread(&mut self, _thread_id: &ThreadId) -> Result<(), RolloutError> {
        Err(RolloutError::Poisoned)
    }

    fn delete_thread(&mut self, _thread_id: &ThreadId) -> Result<(), RolloutError> {
        Err(RolloutError::Poisoned)
    }

    fn load_thread(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Option<DurableThreadSnapshot>, RolloutError> {
        Ok(self.threads.get(thread_id).cloned())
    }

    fn list_threads(
        &mut self,
        _cursor: Option<&ThreadId>,
        _limit: usize,
    ) -> Result<DurableThreadPage, RolloutError> {
        Err(RolloutError::Poisoned)
    }

    fn search_threads(
        &mut self,
        _query: &str,
        _cursor: Option<&ThreadId>,
        _limit: usize,
    ) -> Result<DurableThreadPage, RolloutError> {
        Err(RolloutError::Poisoned)
    }
}
