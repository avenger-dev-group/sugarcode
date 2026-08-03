use super::*;

#[derive(Debug, Default)]
pub(super) struct MemoryThreadRepository {
    threads: BTreeMap<ThreadId, DurableThreadSnapshot>,
}

impl ThreadRepository for MemoryThreadRepository {
    fn create_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError> {
        if self.threads.contains_key(thread_id) {
            return Err(RolloutError::Collision { kind: "thread" });
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

    fn create_thread_with_origin(
        &mut self,
        thread_id: &ThreadId,
        origin: &sugarcode_state::DurableThreadOrigin,
    ) -> Result<(), RolloutError> {
        self.create_thread(thread_id)?;
        self.threads
            .get_mut(thread_id)
            .expect("created thread")
            .origin = Some(origin.clone());
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
        self.threads.insert(snapshot.id.clone(), snapshot.clone());
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

    fn list_descendants(
        &self,
        parent_thread_id: &ThreadId,
    ) -> Result<Vec<DurableThreadSnapshot>, RolloutError> {
        Ok(self
            .threads
            .values()
            .filter(|thread| {
                thread
                    .origin
                    .as_ref()
                    .is_some_and(|origin| &origin.parent_thread_id == parent_thread_id)
            })
            .cloned()
            .collect())
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
        let mut threads = self
            .threads
            .values()
            .filter(|thread| {
                thread.lifecycle == DurableThreadLifecycle::Active && thread.origin.is_none()
            })
            .map(|thread| thread.id.clone())
            .collect::<Vec<_>>();
        threads.sort_unstable_by(|left, right| right.cmp(left));
        let mut ids = threads
            .into_iter()
            .filter(|thread_id| cursor.is_none_or(|cursor| thread_id < cursor))
            .take(limit + 1)
            .collect::<Vec<_>>();
        let has_more = ids.len() > limit;
        ids.truncate(limit);
        Ok(DurableThreadPage {
            next_cursor: has_more.then(|| ids.last().cloned()).flatten(),
            data: ids
                .into_iter()
                .map(|id| DurableThreadSummary {
                    title: self
                        .threads
                        .get(&id)
                        .and_then(sugarcode_state::derive_thread_title),
                    id,
                })
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
        let mut matches = self
            .threads
            .values()
            .filter(|thread| {
                thread.lifecycle == DurableThreadLifecycle::Active && thread.origin.is_none()
            })
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
                        DurableItemSnapshot::UserMessage { .. }
                        | DurableItemSnapshot::AgentCommentary { .. } => false,
                        DurableItemSnapshot::ContextCompaction { .. }
                        | DurableItemSnapshot::AgentTask { .. }
                        | DurableItemSnapshot::AgentTaskAmendment { .. }
                        | DurableItemSnapshot::AgentTaskResult { .. }
                        | DurableItemSnapshot::ToolCall { .. }
                        | DurableItemSnapshot::ToolValidationRejected { .. }
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
            .map(|thread| DurableThreadSummary {
                id: thread.id.clone(),
                title: sugarcode_state::derive_thread_title(thread),
            })
            .collect::<Vec<_>>();
        matches.sort_unstable_by(|left, right| right.id.cmp(&left.id));
        let mut data = matches
            .into_iter()
            .filter(|summary| cursor.is_none_or(|cursor| summary.id < *cursor))
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
