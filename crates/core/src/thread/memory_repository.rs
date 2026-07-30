use super::*;

#[derive(Debug, Default)]
pub(super) struct MemoryThreadRepository {
    threads: BTreeMap<ThreadId, DurableThreadSnapshot>,
    sequences: IdSequences,
}

impl ThreadRepository for MemoryThreadRepository {
    fn id_sequences(&self) -> IdSequences {
        self.sequences
    }

    fn create_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError> {
        let sequence = thread_id
            .as_str()
            .strip_prefix("thr_")
            .and_then(|digits| digits.parse::<u64>().ok())
            .ok_or(RolloutError::InvalidId { kind: "thread" })?;
        if self.threads.contains_key(thread_id) {
            return Err(RolloutError::Collision { kind: "thread" });
        }
        self.threads.insert(
            thread_id.clone(),
            DurableThreadSnapshot {
                id: thread_id.clone(),
                turns: Vec::new(),
                lifecycle: DurableThreadLifecycle::Active,
            },
        );
        self.sequences.thread = sequence;
        Ok(())
    }

    fn create_thread_snapshot(
        &mut self,
        snapshot: &DurableThreadSnapshot,
    ) -> Result<(), RolloutError> {
        if snapshot.lifecycle != DurableThreadLifecycle::Active
            || self.threads.contains_key(&snapshot.id)
            || snapshot
                .turns
                .iter()
                .any(|turn| turn.status == DurableTurnStatus::InProgress)
        {
            return Err(RolloutError::Collision { kind: "thread" });
        }
        let thread_sequence = parse_thread_sequence(&snapshot.id)?;
        let mut turn_sequence = self.sequences.turn;
        let mut item_sequence = self.sequences.item;
        for turn in &snapshot.turns {
            turn_sequence = turn
                .id
                .as_str()
                .strip_prefix("turn_")
                .and_then(|digits| digits.parse().ok())
                .ok_or(RolloutError::InvalidId { kind: "turn" })?;
            for item in &turn.items {
                item_sequence = item
                    .id()
                    .as_str()
                    .strip_prefix("item_")
                    .and_then(|digits| digits.parse().ok())
                    .ok_or(RolloutError::InvalidId { kind: "item" })?;
            }
        }
        self.threads.insert(snapshot.id.clone(), snapshot.clone());
        self.sequences = IdSequences {
            thread: thread_sequence,
            turn: turn_sequence,
            item: item_sequence,
        };
        Ok(())
    }

    fn append_completed_turn(
        &mut self,
        thread_id: &ThreadId,
        turn: &DurableTurnSnapshot,
    ) -> Result<(), RolloutError> {
        let thread = self
            .threads
            .get_mut(thread_id)
            .ok_or(RolloutError::InvalidId { kind: "thread" })?;
        if thread.lifecycle != DurableThreadLifecycle::Active {
            return Err(RolloutError::InvalidRecord {
                kind: if thread.lifecycle == DurableThreadLifecycle::Deleted {
                    "recordAfterThreadDelete"
                } else {
                    "recordAfterThreadArchive"
                },
            });
        }
        thread.turns.push(turn.clone());
        self.sequences.turn = turn
            .id
            .as_str()
            .strip_prefix("turn_")
            .and_then(|digits| digits.parse().ok())
            .ok_or(RolloutError::InvalidId { kind: "turn" })?;
        if let Some(item) = turn.items.last() {
            self.sequences.item = item
                .id()
                .as_str()
                .strip_prefix("item_")
                .and_then(|digits| digits.parse().ok())
                .ok_or(RolloutError::InvalidId { kind: "item" })?;
        }
        Ok(())
    }

    fn begin_turn(
        &mut self,
        thread_id: &ThreadId,
        turn: &DurableTurnSnapshot,
    ) -> Result<(), RolloutError> {
        self.append_completed_turn(thread_id, turn)
    }

    fn finish_turn(
        &mut self,
        thread_id: &ThreadId,
        turn: &DurableTurnSnapshot,
    ) -> Result<(), RolloutError> {
        let thread = self
            .threads
            .get_mut(thread_id)
            .ok_or(RolloutError::InvalidId { kind: "thread" })?;
        let stored = thread
            .turns
            .last_mut()
            .filter(|stored| stored.id == turn.id)
            .ok_or(RolloutError::InvalidRecord {
                kind: "turnNotActive",
            })?;
        *stored = turn.clone();
        Ok(())
    }

    fn append_turn_item(
        &mut self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        item: &DurableItemSnapshot,
    ) -> Result<(), RolloutError> {
        let thread = self
            .threads
            .get_mut(thread_id)
            .ok_or(RolloutError::InvalidId { kind: "thread" })?;
        let turn = thread
            .turns
            .last_mut()
            .filter(|turn| &turn.id == turn_id && turn.status == DurableTurnStatus::InProgress)
            .ok_or(RolloutError::InvalidRecord {
                kind: "turnNotActive",
            })?;
        turn.items.push(item.clone());
        self.sequences.item = item
            .id()
            .as_str()
            .strip_prefix("item_")
            .and_then(|digits| digits.parse().ok())
            .ok_or(RolloutError::InvalidId { kind: "item" })?;
        Ok(())
    }

    fn complete_turn_item(
        &mut self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        item: &DurableItemSnapshot,
    ) -> Result<(), RolloutError> {
        let turn = self
            .threads
            .get_mut(thread_id)
            .and_then(|thread| thread.turns.last_mut())
            .filter(|turn| &turn.id == turn_id && turn.status == DurableTurnStatus::InProgress)
            .ok_or(RolloutError::InvalidRecord {
                kind: "turnNotActive",
            })?;
        let stored = turn
            .items
            .iter_mut()
            .find(|stored| stored.id() == item.id())
            .ok_or(RolloutError::InvalidRecord {
                kind: "itemNotStarted",
            })?;
        *stored = item.clone();
        Ok(())
    }

    fn load_thread(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Option<DurableThreadSnapshot>, RolloutError> {
        Ok(self.threads.get(thread_id).cloned())
    }

    fn archive_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError> {
        let thread = self
            .threads
            .get_mut(thread_id)
            .ok_or(RolloutError::InvalidId { kind: "thread" })?;
        if thread
            .turns
            .last()
            .is_some_and(|turn| turn.status == DurableTurnStatus::InProgress)
        {
            return Err(RolloutError::InvalidRecord {
                kind: "threadLifecycleWhileTurnActive",
            });
        }
        thread.lifecycle = DurableThreadLifecycle::Archived;
        Ok(())
    }

    fn unarchive_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError> {
        let thread = self
            .threads
            .get_mut(thread_id)
            .ok_or(RolloutError::InvalidId { kind: "thread" })?;
        if thread
            .turns
            .last()
            .is_some_and(|turn| turn.status == DurableTurnStatus::InProgress)
        {
            return Err(RolloutError::InvalidRecord {
                kind: "threadLifecycleWhileTurnActive",
            });
        }
        thread.lifecycle = DurableThreadLifecycle::Active;
        Ok(())
    }

    fn delete_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError> {
        let thread = self
            .threads
            .get_mut(thread_id)
            .ok_or(RolloutError::InvalidId { kind: "thread" })?;
        if thread
            .turns
            .last()
            .is_some_and(|turn| turn.status == DurableTurnStatus::InProgress)
        {
            return Err(RolloutError::InvalidRecord {
                kind: "threadLifecycleWhileTurnActive",
            });
        }
        thread.lifecycle = DurableThreadLifecycle::Deleted;
        Ok(())
    }

    fn list_threads(
        &mut self,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, RolloutError> {
        let cursor_sequence = cursor.map(parse_thread_sequence).transpose()?;
        let mut threads = self
            .threads
            .values()
            .filter(|thread| thread.lifecycle == DurableThreadLifecycle::Active)
            .map(|thread| Ok((parse_thread_sequence(&thread.id)?, thread.id.clone())))
            .collect::<Result<Vec<_>, RolloutError>>()?;
        threads.sort_unstable_by_key(|thread| Reverse(thread.0));
        let mut ids = threads
            .into_iter()
            .filter(|(sequence, _)| cursor_sequence.is_none_or(|cursor| *sequence < cursor))
            .map(|(_, id)| id)
            .take(limit + 1)
            .collect::<Vec<_>>();
        let has_more = ids.len() > limit;
        ids.truncate(limit);
        Ok(DurableThreadPage {
            next_cursor: has_more.then(|| ids.last().cloned()).flatten(),
            data: ids
                .into_iter()
                .map(|id| DurableThreadSummary { id })
                .collect(),
        })
    }

    fn search_threads(
        &mut self,
        query: &str,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, RolloutError> {
        if limit == 0 || limit > 100 {
            return Err(RolloutError::InvalidRecord {
                kind: "threadSearchLimit",
            });
        }
        let terms = validate_search_query(query)?;
        let cursor_sequence = cursor.map(parse_thread_sequence).transpose()?;
        let mut matches = self
            .threads
            .values()
            .filter(|thread| thread.lifecycle == DurableThreadLifecycle::Active)
            .filter(|thread| {
                thread
                    .turns
                    .iter()
                    .filter(|turn| turn.status == DurableTurnStatus::Completed)
                    .flat_map(|turn| &turn.items)
                    .any(|item| match item {
                        DurableItemSnapshot::AgentMessage { text, .. } => {
                            let text = text.to_lowercase();
                            terms.iter().all(|term| text.contains(term))
                        }
                        DurableItemSnapshot::UserMessage { .. } => false,
                        DurableItemSnapshot::ContextCompaction { .. }
                        | DurableItemSnapshot::ToolCall { .. }
                        | DurableItemSnapshot::FileChange { .. }
                        | DurableItemSnapshot::CommandApprovalRequest { .. }
                        | DurableItemSnapshot::CommandApprovalDecision { .. }
                        | DurableItemSnapshot::CommandExecutionAttempt { .. }
                        | DurableItemSnapshot::McpToolCall { .. }
                        | DurableItemSnapshot::McpToolCallApprovalRequest { .. }
                        | DurableItemSnapshot::McpToolCallApprovalDecision { .. }
                        | DurableItemSnapshot::McpToolExecutionAttempt { .. }
                        | DurableItemSnapshot::McpToolResult { .. }
                        | DurableItemSnapshot::ToolResult { .. } => false,
                    })
            })
            .map(|thread| {
                Ok((
                    parse_thread_sequence(&thread.id)?,
                    DurableThreadSummary {
                        id: thread.id.clone(),
                    },
                ))
            })
            .collect::<Result<Vec<_>, RolloutError>>()?;
        matches.sort_unstable_by_key(|(sequence, _)| Reverse(*sequence));
        let mut data = matches
            .into_iter()
            .filter(|(sequence, _)| cursor_sequence.is_none_or(|cursor| *sequence < cursor))
            .map(|(_, summary)| summary)
            .take(limit + 1)
            .collect::<Vec<_>>();
        let has_more = data.len() > limit;
        data.truncate(limit);
        Ok(DurableThreadPage {
            next_cursor: has_more
                .then(|| data.last().map(|thread| thread.id.clone()))
                .flatten(),
            data,
        })
    }
}

fn validate_search_query(query: &str) -> Result<Vec<String>, RolloutError> {
    if query.chars().any(char::is_control) {
        return Err(RolloutError::InvalidRecord {
            kind: "threadSearchQuery",
        });
    }
    let query = query.trim();
    let terms = query.split_whitespace().collect::<Vec<_>>();
    if query.is_empty() || query.len() > 256 || terms.len() > 16 {
        return Err(RolloutError::InvalidRecord {
            kind: "threadSearchQuery",
        });
    }
    Ok(terms.into_iter().map(str::to_lowercase).collect())
}

fn parse_thread_sequence(thread_id: &ThreadId) -> Result<u64, RolloutError> {
    thread_id
        .as_str()
        .strip_prefix("thr_")
        .and_then(|digits| digits.parse::<u64>().ok())
        .filter(|sequence| format!("{sequence:016}") == thread_id.as_str()[4..])
        .ok_or(RolloutError::InvalidId { kind: "thread" })
}
