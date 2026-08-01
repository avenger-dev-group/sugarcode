use super::*;
use crate::derive_thread_title;

impl RolloutRepository {
    fn create_thread_record(
        &mut self,
        thread_id: &ThreadId,
        origin: Option<&DurableThreadOrigin>,
    ) -> Result<(), RolloutError> {
        self.ensure_available()?;
        let thread_sequence = parse_canonical_id(thread_id.as_str(), "thr_", "thread")?;
        if self.threads.contains_key(thread_id) || thread_sequence <= self.sequences.thread {
            return Err(RolloutError::Collision { kind: "thread" });
        }
        if self.threads.len() >= MAX_ROLLOUT_FILES {
            return Err(RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "rolloutFiles",
            });
        }
        let path = self.thread_path(thread_id)?;
        let bytes = encode_thread_created(
            1,
            thread_id,
            self.active_workspace_binding_id.as_deref(),
            origin,
        )?;
        self.append_record(&path, &bytes, true, 1)?;
        self.threads.insert(
            thread_id.clone(),
            RolloutThreadState {
                snapshot: DurableThreadSnapshot {
                    id: thread_id.clone(),
                    turns: Vec::new(),
                    lifecycle: DurableThreadLifecycle::Active,
                    origin: origin.cloned(),
                },
                workspace_binding_id: self.active_workspace_binding_id.clone(),
                last_record_sequence: 1,
                turn_record_sequences: Vec::new(),
            },
        );
        self.sequences.thread = thread_sequence;
        if origin.is_none() {
            let _ = self.projection.record_thread_created(thread_id);
            let _ = self.search_projection.record_thread_created(thread_id);
        }
        Ok(())
    }
}

impl ThreadRepository for RolloutRepository {
    fn id_sequences(&self) -> IdSequences {
        self.sequences
    }

    fn create_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError> {
        self.create_thread_record(thread_id, None)
    }

    fn create_thread_with_origin(
        &mut self,
        thread_id: &ThreadId,
        origin: &DurableThreadOrigin,
    ) -> Result<(), RolloutError> {
        self.create_thread_record(thread_id, Some(origin))
    }

    fn create_thread_snapshot(
        &mut self,
        snapshot: &DurableThreadSnapshot,
    ) -> Result<(), RolloutError> {
        self.ensure_available()?;
        if snapshot.lifecycle != DurableThreadLifecycle::Active {
            return Err(RolloutError::InvalidRecord {
                kind: "materializedThreadNotActive",
            });
        }
        if snapshot.turns.iter().any(|turn| !valid_terminal_turn(turn)) {
            return Err(RolloutError::InvalidRecord {
                kind: "invalidTerminalTurn",
            });
        }
        if snapshot.turns.iter().enumerate().any(|(index, turn)| {
            turn.context_compaction.as_ref().is_some_and(|compaction| {
                !crate::validate_context_compaction(&snapshot.turns[..index], compaction)
            })
        }) {
            return Err(RolloutError::InvalidRecord {
                kind: "invalidContextCompaction",
            });
        }
        let thread_sequence = parse_canonical_id(snapshot.id.as_str(), "thr_", "thread")?;
        if self.threads.contains_key(&snapshot.id) || thread_sequence <= self.sequences.thread {
            return Err(RolloutError::Collision { kind: "thread" });
        }
        if self.threads.len() >= MAX_ROLLOUT_FILES {
            return Err(RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "rolloutFiles",
            });
        }

        let record_count = snapshot.turns.iter().try_fold(1usize, |count, turn| {
            count
                .checked_add(2)
                .and_then(|count| count.checked_add(turn.items.len().checked_mul(2)?))
                .ok_or_else(|| RolloutError::LimitExceeded {
                    path: self.root.clone(),
                    kind: "rolloutRecords",
                })
        })?;
        if record_count > MAX_ROLLOUT_RECORDS_PER_FILE {
            return Err(RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "rolloutRecords",
            });
        }
        if self
            .total_records
            .checked_add(record_count)
            .is_none_or(|count| count > MAX_TOTAL_REPLAY_RECORDS)
        {
            return Err(RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "totalReplayRecords",
            });
        }

        let mut records = Vec::with_capacity(record_count);
        records.push(encode_thread_created(
            1,
            &snapshot.id,
            self.active_workspace_binding_id.as_deref(),
            snapshot.origin.as_ref(),
        )?);
        let mut turn_sequence = self.sequences.turn;
        let mut item_sequence = self.sequences.item;
        let mut record_sequence = 1u64;
        let mut turn_record_sequences = Vec::with_capacity(snapshot.turns.len());
        for turn in &snapshot.turns {
            if turn.items.is_empty() {
                return Err(RolloutError::InvalidRecord {
                    kind: "completedTurnWithoutItems",
                });
            }
            let sequence = parse_canonical_id(turn.id.as_str(), "turn_", "turn")?;
            if sequence <= turn_sequence {
                return Err(RolloutError::Collision { kind: "turn" });
            }
            turn_sequence = sequence;
            for item in &turn.items {
                let sequence = parse_canonical_id(item.id().as_str(), "item_", "item")?;
                if sequence <= item_sequence {
                    return Err(RolloutError::Collision { kind: "item" });
                }
                item_sequence = sequence;
            }
            let mut started = turn.clone();
            started.status = DurableTurnStatus::InProgress;
            started.error = None;
            started.usage = None;
            record_sequence =
                record_sequence
                    .checked_add(1)
                    .ok_or(RolloutError::InvalidRecord {
                        kind: "recordSequenceOverflow",
                    })?;
            records.push(encode_turn_started(
                record_sequence,
                &snapshot.id,
                &started,
            )?);
            for item in &turn.items {
                let started_item = match item {
                    DurableItemSnapshot::AgentMessage { id, .. } => {
                        DurableItemSnapshot::AgentMessage {
                            id: id.clone(),
                            text: String::new(),
                        }
                    }
                    _ => item.clone(),
                };
                record_sequence =
                    record_sequence
                        .checked_add(1)
                        .ok_or(RolloutError::InvalidRecord {
                            kind: "recordSequenceOverflow",
                        })?;
                records.push(encode_turn_item_added(
                    record_sequence,
                    &snapshot.id,
                    &turn.id,
                    &started_item,
                )?);
                record_sequence =
                    record_sequence
                        .checked_add(1)
                        .ok_or(RolloutError::InvalidRecord {
                            kind: "recordSequenceOverflow",
                        })?;
                records.push(encode_turn_item_completed(
                    record_sequence,
                    &snapshot.id,
                    &turn.id,
                    item,
                )?);
            }
            record_sequence =
                record_sequence
                    .checked_add(1)
                    .ok_or(RolloutError::InvalidRecord {
                        kind: "recordSequenceOverflow",
                    })?;
            records.push(encode_turn_completed(record_sequence, &snapshot.id, turn)?);
            turn_record_sequences.push(record_sequence);
        }

        let mut added_bytes = 0u64;
        for record in &records {
            if record.len() > MAX_ROLLOUT_RECORD_BYTES {
                return Err(RolloutError::LimitExceeded {
                    path: self.root.clone(),
                    kind: "rolloutRecordBytes",
                });
            }
            let record_bytes =
                u64::try_from(record.len() + 1).map_err(|_| RolloutError::LimitExceeded {
                    path: self.root.clone(),
                    kind: "rolloutFileBytes",
                })?;
            added_bytes = added_bytes.checked_add(record_bytes).ok_or_else(|| {
                RolloutError::LimitExceeded {
                    path: self.root.clone(),
                    kind: "rolloutFileBytes",
                }
            })?;
        }
        if added_bytes > MAX_ROLLOUT_FILE_BYTES {
            return Err(RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "rolloutFileBytes",
            });
        }
        if self
            .total_bytes
            .checked_add(added_bytes)
            .is_none_or(|bytes| bytes > MAX_TOTAL_REPLAY_BYTES)
        {
            return Err(RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "totalReplayBytes",
            });
        }

        let path = self.thread_path(&snapshot.id)?;
        let temp_path = self.fork_temp_path(&snapshot.id)?;
        self.create_snapshot_file(&path, &temp_path, &records, added_bytes)?;

        let last_record_sequence =
            u64::try_from(record_count).map_err(|_| RolloutError::InvalidRecord {
                kind: "recordSequenceOverflow",
            })?;
        let state = RolloutThreadState {
            snapshot: snapshot.clone(),
            workspace_binding_id: self.active_workspace_binding_id.clone(),
            last_record_sequence,
            turn_record_sequences,
        };
        self.threads.insert(snapshot.id.clone(), state.clone());
        self.sequences.thread = thread_sequence;
        self.sequences.turn = turn_sequence;
        self.sequences.item = item_sequence;
        let _ = self.projection.record_thread_snapshot(&state);
        let _ = self.search_projection.record_thread_snapshot(&state);
        Ok(())
    }

    fn append_completed_turn(
        &mut self,
        thread_id: &ThreadId,
        turn: &DurableTurnSnapshot,
    ) -> Result<(), RolloutError> {
        if turn.status != DurableTurnStatus::Completed {
            return Err(RolloutError::InvalidRecord {
                kind: "completedTurnRequired",
            });
        }
        if turn.items.is_empty() {
            return Err(RolloutError::InvalidRecord {
                kind: "completedTurnWithoutItems",
            });
        }
        if !valid_workspace_instructions_audit(turn.workspace_instructions.as_ref()) {
            return Err(RolloutError::InvalidRecord {
                kind: "invalidWorkspaceInstructionsAudit",
            });
        }
        if !super::valid_workspace_skills_audit(turn.workspace_skills.as_ref()) {
            return Err(RolloutError::InvalidRecord {
                kind: "invalidWorkspaceSkillsAudit",
            });
        }
        let prior_turns = &self
            .threads
            .get(thread_id)
            .ok_or(RolloutError::InvalidId { kind: "thread" })?
            .snapshot
            .turns;
        if turn
            .context_compaction
            .as_ref()
            .is_some_and(|compaction| !crate::validate_context_compaction(prior_turns, compaction))
        {
            return Err(RolloutError::InvalidRecord {
                kind: "invalidContextCompaction",
            });
        }
        if let Some(thread) = self.threads.get(thread_id)
            && thread.snapshot.lifecycle != DurableThreadLifecycle::Active
        {
            return Err(RolloutError::InvalidRecord {
                kind: if thread.snapshot.lifecycle == DurableThreadLifecycle::Deleted {
                    "recordAfterThreadDelete"
                } else {
                    "recordAfterThreadArchive"
                },
            });
        }
        if !super::super::valid_turn_items(&turn.items) {
            return Err(RolloutError::InvalidRecord {
                kind: "invalidTurnItems",
            });
        }
        let mut started = turn.clone();
        started.status = DurableTurnStatus::InProgress;
        started.error = None;
        started.usage = None;
        self.begin_turn(thread_id, &started)?;
        self.finish_turn(thread_id, turn)
    }

    fn begin_turn(
        &mut self,
        thread_id: &ThreadId,
        turn: &DurableTurnSnapshot,
    ) -> Result<(), RolloutError> {
        self.ensure_available()?;
        if turn.status != DurableTurnStatus::InProgress
            || turn.context_compaction.as_ref().is_some_and(|compaction| {
                self.threads.get(thread_id).is_none_or(|thread| {
                    !crate::validate_context_compaction(&thread.snapshot.turns, compaction)
                })
            })
            || !valid_workspace_instructions_audit(turn.workspace_instructions.as_ref())
            || !super::valid_workspace_skills_audit(turn.workspace_skills.as_ref())
            || turn.error.is_some()
            || turn.usage.is_some()
        {
            return Err(RolloutError::InvalidRecord {
                kind: "invalidStartedTurn",
            });
        }
        if !super::super::valid_turn_items(&turn.items) {
            return Err(RolloutError::InvalidRecord {
                kind: "invalidStartedTurnItems",
            });
        }
        if self.pending_turns.contains_key(thread_id) {
            return Err(RolloutError::Collision { kind: "activeTurn" });
        }
        let thread = self
            .threads
            .get(thread_id)
            .ok_or(RolloutError::InvalidId { kind: "thread" })?;
        if thread.snapshot.lifecycle != DurableThreadLifecycle::Active {
            return Err(RolloutError::InvalidRecord {
                kind: "turnStartedWhileInactive",
            });
        }
        let turn_sequence = parse_canonical_id(turn.id.as_str(), "turn_", "turn")?;
        if turn_sequence <= self.sequences.turn {
            return Err(RolloutError::Collision { kind: "turn" });
        }
        let mut item_sequence = self.sequences.item;
        for item in &turn.items {
            let sequence = parse_canonical_id(item.id().as_str(), "item_", "item")?;
            if sequence <= item_sequence {
                return Err(RolloutError::Collision { kind: "item" });
            }
            item_sequence = sequence;
        }
        let record_sequence =
            thread
                .last_record_sequence
                .checked_add(1)
                .ok_or(RolloutError::InvalidRecord {
                    kind: "recordSequenceOverflow",
                })?;
        let next_file_record_count =
            usize::try_from(record_sequence).map_err(|_| RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "rolloutRecords",
            })?;
        let path = self.thread_path(thread_id)?;
        let bytes = encode_turn_started(record_sequence, thread_id, turn)?;
        self.append_record(&path, &bytes, false, next_file_record_count)?;
        self.threads
            .get_mut(thread_id)
            .expect("validated thread exists")
            .last_record_sequence = record_sequence;
        let initial_items = turn.items.clone();
        let mut pending = turn.clone();
        pending.items.clear();
        self.pending_turns.insert(thread_id.clone(), pending);
        self.sequences.turn = turn_sequence;
        let _ = self
            .projection
            .record_turn_completed(thread_id, record_sequence);
        let _ = self
            .search_projection
            .record_turn_started(thread_id, record_sequence);
        for item in initial_items {
            let started = match &item {
                DurableItemSnapshot::AgentMessage { id, .. } => DurableItemSnapshot::AgentMessage {
                    id: id.clone(),
                    text: String::new(),
                },
                _ => item.clone(),
            };
            self.append_turn_item(thread_id, &turn.id, &started)?;
            self.complete_turn_item(thread_id, &turn.id, &item)?;
        }
        debug_assert_eq!(self.sequences.item, item_sequence);
        Ok(())
    }

    fn append_turn_item(
        &mut self,
        thread_id: &ThreadId,
        turn_id: &sugarcode_protocol::TurnId,
        item: &DurableItemSnapshot,
    ) -> Result<(), RolloutError> {
        self.ensure_available()?;
        let pending = self
            .pending_turns
            .get(thread_id)
            .ok_or(RolloutError::InvalidRecord {
                kind: "turnNotActive",
            })?;
        if &pending.id != turn_id {
            return Err(RolloutError::InvalidRecord {
                kind: "turnIdMismatch",
            });
        }
        if let Err(kind) = super::super::valid_incremental_item(&pending.items, item) {
            return Err(RolloutError::InvalidRecord { kind });
        }
        if pending
            .items
            .iter()
            .any(|existing| existing.id() == item.id())
        {
            return Err(RolloutError::Collision { kind: "item" });
        }
        if matches!(item, DurableItemSnapshot::AgentMessage { text, .. } if !text.is_empty()) {
            return Err(RolloutError::InvalidRecord {
                kind: "invalidIncrementalItem",
            });
        }
        let item_sequence = parse_canonical_id(item.id().as_str(), "item_", "item")?;
        if item_sequence <= self.sequences.item {
            return Err(RolloutError::Collision { kind: "item" });
        }
        let thread = self
            .threads
            .get(thread_id)
            .ok_or(RolloutError::InvalidId { kind: "thread" })?;
        let record_sequence =
            thread
                .last_record_sequence
                .checked_add(1)
                .ok_or(RolloutError::InvalidRecord {
                    kind: "recordSequenceOverflow",
                })?;
        let next_file_record_count =
            usize::try_from(record_sequence).map_err(|_| RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "rolloutRecords",
            })?;
        let path = self.thread_path(thread_id)?;
        let bytes = encode_turn_item_added(record_sequence, thread_id, turn_id, item)?;
        self.append_record(&path, &bytes, false, next_file_record_count)?;
        self.pending_turns
            .get_mut(thread_id)
            .expect("validated pending turn")
            .items
            .push(item.clone());
        self.threads
            .get_mut(thread_id)
            .expect("validated thread exists")
            .last_record_sequence = record_sequence;
        self.sequences.item = item_sequence;
        let _ = self
            .projection
            .record_turn_completed(thread_id, record_sequence);
        let _ = self
            .search_projection
            .record_turn_started(thread_id, record_sequence);
        Ok(())
    }

    fn complete_turn_item(
        &mut self,
        thread_id: &ThreadId,
        turn_id: &sugarcode_protocol::TurnId,
        item: &DurableItemSnapshot,
    ) -> Result<(), RolloutError> {
        self.ensure_available()?;
        let pending = self
            .pending_turns
            .get(thread_id)
            .ok_or(RolloutError::InvalidRecord {
                kind: "turnNotActive",
            })?;
        if &pending.id != turn_id {
            return Err(RolloutError::InvalidRecord {
                kind: "turnIdMismatch",
            });
        }
        let Some(started) = pending
            .items
            .iter()
            .find(|started| started.id() == item.id())
        else {
            return Err(RolloutError::InvalidRecord {
                kind: "itemNotStarted",
            });
        };
        if !terminal_items_match(std::slice::from_ref(started), std::slice::from_ref(item)) {
            return Err(RolloutError::InvalidRecord {
                kind: "turnItemMismatch",
            });
        }
        let thread = self
            .threads
            .get(thread_id)
            .ok_or(RolloutError::InvalidId { kind: "thread" })?;
        let record_sequence =
            thread
                .last_record_sequence
                .checked_add(1)
                .ok_or(RolloutError::InvalidRecord {
                    kind: "recordSequenceOverflow",
                })?;
        let next_file_record_count =
            usize::try_from(record_sequence).map_err(|_| RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "rolloutRecords",
            })?;
        let path = self.thread_path(thread_id)?;
        let bytes = encode_turn_item_completed(record_sequence, thread_id, turn_id, item)?;
        self.append_record(&path, &bytes, false, next_file_record_count)?;
        let stored = self
            .pending_turns
            .get_mut(thread_id)
            .expect("validated pending turn")
            .items
            .iter_mut()
            .find(|stored| stored.id() == item.id())
            .expect("validated started item");
        *stored = item.clone();
        self.threads
            .get_mut(thread_id)
            .expect("validated thread exists")
            .last_record_sequence = record_sequence;
        let _ = self
            .projection
            .record_turn_completed(thread_id, record_sequence);
        let _ = self
            .search_projection
            .record_turn_started(thread_id, record_sequence);
        Ok(())
    }

    fn finish_turn(
        &mut self,
        thread_id: &ThreadId,
        turn: &DurableTurnSnapshot,
    ) -> Result<(), RolloutError> {
        self.ensure_available()?;
        let valid_terminal = match turn.status {
            DurableTurnStatus::InProgress => false,
            DurableTurnStatus::Completed => turn.error.is_none(),
            DurableTurnStatus::Failed => turn.error.is_some(),
            DurableTurnStatus::Interrupted => turn.error.is_none(),
        };
        if (turn.items.is_empty() && turn.status != DurableTurnStatus::Interrupted)
            || !valid_terminal
        {
            return Err(RolloutError::InvalidRecord {
                kind: "invalidTerminalTurn",
            });
        }
        let Some(pending) = self.pending_turns.get(thread_id) else {
            return Err(RolloutError::InvalidRecord {
                kind: "turnNotActive",
            });
        };
        if pending.id != turn.id
            || pending.context_compaction != turn.context_compaction
            || pending.workspace_instructions != turn.workspace_instructions
            || pending.workspace_skills != turn.workspace_skills
            || !terminal_items_match(&pending.items, &turn.items)
        {
            return Err(RolloutError::InvalidRecord {
                kind: "turnItemMismatch",
            });
        }
        let thread = self
            .threads
            .get(thread_id)
            .ok_or(RolloutError::InvalidId { kind: "thread" })?;
        let record_sequence =
            thread
                .last_record_sequence
                .checked_add(1)
                .ok_or(RolloutError::InvalidRecord {
                    kind: "recordSequenceOverflow",
                })?;
        let next_file_record_count =
            usize::try_from(record_sequence).map_err(|_| RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "rolloutRecords",
            })?;
        let path = self.thread_path(thread_id)?;
        let bytes = encode_turn_completed(record_sequence, thread_id, turn)?;
        self.append_record(&path, &bytes, false, next_file_record_count)?;
        let thread = self
            .threads
            .get_mut(thread_id)
            .expect("validated thread exists");
        thread.snapshot.turns.push(turn.clone());
        thread.turn_record_sequences.push(record_sequence);
        thread.last_record_sequence = record_sequence;
        self.pending_turns.remove(thread_id);
        let _ = self
            .projection
            .record_turn_completed(thread_id, record_sequence);
        let _ = self
            .search_projection
            .record_turn_completed(thread_id, record_sequence, turn);
        Ok(())
    }

    fn archive_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError> {
        self.ensure_available()?;
        if self.pending_turns.contains_key(thread_id) {
            return Err(RolloutError::InvalidRecord {
                kind: "threadLifecycleWhileTurnActive",
            });
        }
        let thread = self
            .threads
            .get(thread_id)
            .ok_or(RolloutError::InvalidId { kind: "thread" })?;
        if thread.snapshot.lifecycle == DurableThreadLifecycle::Archived {
            return Ok(());
        }
        if thread.snapshot.lifecycle == DurableThreadLifecycle::Deleted {
            return Err(RolloutError::InvalidRecord {
                kind: "recordAfterThreadDelete",
            });
        }
        let record_sequence =
            thread
                .last_record_sequence
                .checked_add(1)
                .ok_or(RolloutError::InvalidRecord {
                    kind: "recordSequenceOverflow",
                })?;
        let next_file_record_count =
            usize::try_from(record_sequence).map_err(|_| RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "rolloutRecords",
            })?;
        let path = self.thread_path(thread_id)?;
        let bytes = encode_thread_archived(record_sequence, thread_id)?;
        self.append_record(&path, &bytes, false, next_file_record_count)?;
        let thread = self
            .threads
            .get_mut(thread_id)
            .expect("validated thread exists");
        thread.snapshot.lifecycle = DurableThreadLifecycle::Archived;
        thread.last_record_sequence = record_sequence;
        let _ = self
            .projection
            .record_thread_archived(thread_id, record_sequence);
        let _ = self
            .search_projection
            .record_thread_archived(thread_id, record_sequence);
        Ok(())
    }

    fn unarchive_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError> {
        self.ensure_available()?;
        if self.pending_turns.contains_key(thread_id) {
            return Err(RolloutError::InvalidRecord {
                kind: "threadLifecycleWhileTurnActive",
            });
        }
        let thread = self
            .threads
            .get(thread_id)
            .ok_or(RolloutError::InvalidId { kind: "thread" })?;
        if thread.snapshot.lifecycle == DurableThreadLifecycle::Active {
            return Ok(());
        }
        if thread.snapshot.lifecycle == DurableThreadLifecycle::Deleted {
            return Err(RolloutError::InvalidRecord {
                kind: "recordAfterThreadDelete",
            });
        }
        let record_sequence =
            thread
                .last_record_sequence
                .checked_add(1)
                .ok_or(RolloutError::InvalidRecord {
                    kind: "recordSequenceOverflow",
                })?;
        let next_file_record_count =
            usize::try_from(record_sequence).map_err(|_| RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "rolloutRecords",
            })?;
        let path = self.thread_path(thread_id)?;
        let bytes = encode_thread_unarchived(record_sequence, thread_id)?;
        self.append_record(&path, &bytes, false, next_file_record_count)?;
        let thread = self
            .threads
            .get_mut(thread_id)
            .expect("validated thread exists");
        thread.snapshot.lifecycle = DurableThreadLifecycle::Active;
        thread.last_record_sequence = record_sequence;
        let _ = self
            .projection
            .record_thread_unarchived(thread_id, record_sequence);
        let _ = self
            .search_projection
            .record_thread_unarchived(thread_id, record_sequence);
        Ok(())
    }

    fn delete_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError> {
        self.ensure_available()?;
        if self.pending_turns.contains_key(thread_id) {
            return Err(RolloutError::InvalidRecord {
                kind: "threadLifecycleWhileTurnActive",
            });
        }
        let thread = self
            .threads
            .get(thread_id)
            .ok_or(RolloutError::InvalidId { kind: "thread" })?;
        if thread.snapshot.lifecycle == DurableThreadLifecycle::Deleted {
            return Ok(());
        }
        let record_sequence =
            thread
                .last_record_sequence
                .checked_add(1)
                .ok_or(RolloutError::InvalidRecord {
                    kind: "recordSequenceOverflow",
                })?;
        let next_file_record_count =
            usize::try_from(record_sequence).map_err(|_| RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "rolloutRecords",
            })?;
        let path = self.thread_path(thread_id)?;
        let bytes = encode_thread_deleted(record_sequence, thread_id)?;
        self.append_record(&path, &bytes, false, next_file_record_count)?;
        let thread = self
            .threads
            .get_mut(thread_id)
            .expect("validated thread exists");
        thread.snapshot.lifecycle = DurableThreadLifecycle::Deleted;
        thread.last_record_sequence = record_sequence;
        let _ = self
            .projection
            .record_thread_deleted(thread_id, record_sequence);
        let _ = self
            .search_projection
            .record_thread_deleted(thread_id, record_sequence);
        Ok(())
    }

    fn load_thread(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Option<DurableThreadSnapshot>, RolloutError> {
        self.ensure_available()?;
        parse_canonical_id(thread_id.as_str(), "thr_", "thread")?;
        Ok(self
            .threads
            .get(thread_id)
            .map(|thread| thread.snapshot.clone()))
    }

    fn list_descendants(
        &self,
        parent_thread_id: &ThreadId,
    ) -> Result<Vec<DurableThreadSnapshot>, RolloutError> {
        self.ensure_available()?;
        Ok(self
            .threads
            .values()
            .filter(|thread| {
                thread
                    .snapshot
                    .origin
                    .as_ref()
                    .is_some_and(|origin| &origin.parent_thread_id == parent_thread_id)
            })
            .map(|thread| thread.snapshot.clone())
            .collect())
    }

    fn list_threads(
        &mut self,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, RolloutError> {
        self.ensure_available()?;
        let mut matching = Vec::with_capacity(limit.saturating_add(1));
        let mut projection_cursor = cursor.cloned();
        loop {
            let page = self.projection.list_threads(
                &self.threads,
                self.total_records,
                projection_cursor.as_ref(),
                100,
            )?;
            matching.extend(
                page.data
                    .into_iter()
                    .filter(|thread| {
                        self.threads
                            .get(&thread.id)
                            .is_some_and(|state| state.snapshot.origin.is_none())
                    })
                    .take(limit.saturating_add(1).saturating_sub(matching.len())),
            );
            if matching.len() > limit || page.next_cursor.is_none() {
                break;
            }
            projection_cursor = page.next_cursor;
        }
        let has_more = matching.len() > limit;
        matching.truncate(limit);
        for summary in &mut matching {
            summary.title = self
                .threads
                .get(&summary.id)
                .and_then(|thread| derive_thread_title(&thread.snapshot));
        }
        let next_cursor = has_more
            .then(|| matching.last().map(|thread| thread.id.clone()))
            .flatten();
        Ok(DurableThreadPage {
            data: matching,
            next_cursor,
        })
    }

    fn search_threads(
        &mut self,
        query: &str,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, RolloutError> {
        self.ensure_available()?;
        let mut results = Vec::with_capacity(limit.saturating_add(1));
        let mut projection_cursor = cursor.cloned();
        loop {
            let page = self.search_projection.search_threads(
                &self.threads,
                self.total_records,
                query,
                projection_cursor.as_ref(),
                100,
            )?;
            results.extend(
                page.data
                    .into_iter()
                    .filter(|thread| {
                        self.threads
                            .get(&thread.id)
                            .is_some_and(|state| state.snapshot.origin.is_none())
                    })
                    .take(limit.saturating_add(1).saturating_sub(results.len())),
            );
            if results.len() > limit || page.next_cursor.is_none() {
                break;
            }
            projection_cursor = page.next_cursor;
        }
        let has_more = results.len() > limit;
        results.truncate(limit);
        for summary in &mut results {
            summary.title = self
                .threads
                .get(&summary.id)
                .and_then(|thread| derive_thread_title(&thread.snapshot));
        }
        let next_cursor = has_more
            .then(|| results.last().map(|thread| thread.id.clone()))
            .flatten();
        Ok(DurableThreadPage {
            data: results,
            next_cursor,
        })
    }
}
