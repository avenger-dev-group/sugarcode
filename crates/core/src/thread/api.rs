use super::*;

impl Core {
    pub fn start_subagent_thread(
        &mut self,
        request_id: CoreRequestId,
        origin: DurableThreadOrigin,
    ) -> Result<CoreEvent, CoreError> {
        self.start_thread_with_origin(request_id, Some(origin))
    }

    fn start_thread_with_origin(
        &mut self,
        request_id: CoreRequestId,
        origin: Option<DurableThreadOrigin>,
    ) -> Result<CoreEvent, CoreError> {
        let sequence = self.reserve_ids(1, 0, 0)?.thread;
        let thread_id = ThreadId::new(format!("thr_{sequence:016}"));
        let thread = Thread {
            id: thread_id.clone(),
            origin: origin.clone(),
            turns: BTreeMap::new(),
            active_turn_id: None,
            lifecycle: DurableThreadLifecycle::Active,
        };

        match origin.as_ref() {
            Some(origin) => self
                .repository
                .create_thread_with_origin(&thread_id, origin),
            None => self.repository.create_thread(&thread_id),
        }
        .map_err(map_repository_error)?;
        self.threads.insert(thread_id.clone(), thread);
        self.last_thread_sequence = sequence;

        Ok(CoreEvent {
            request_id,
            kind: CoreEventKind::ThreadStarted { thread_id },
        })
    }
}

impl CoreApi for Core {
    fn start_thread(&mut self, request_id: CoreRequestId) -> Result<CoreEvent, CoreError> {
        self.start_thread_with_origin(request_id, None)
    }

    fn contains_thread(&self, thread_id: &ThreadId) -> bool {
        Self::contains_thread(self, thread_id)
    }

    fn list_threads(
        &mut self,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, CoreError> {
        self.repository
            .list_threads(cursor, limit)
            .map_err(map_repository_error)
    }

    fn search_threads(
        &mut self,
        query: &str,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, CoreError> {
        self.repository
            .search_threads(query, cursor, limit)
            .map_err(map_repository_error)
    }

    fn archive_thread(&mut self, thread_id: &ThreadId) -> Result<(), CoreError> {
        if let Some(turn_id) = self
            .threads
            .get(thread_id)
            .and_then(|thread| thread.active_turn_id.clone())
        {
            return Err(CoreError::TurnAlreadyActive {
                thread_id: thread_id.clone(),
                turn_id,
            });
        }
        let lifecycle = match self.threads.get(thread_id) {
            Some(thread) => thread.lifecycle,
            None => {
                self.repository
                    .load_thread(thread_id)
                    .map_err(map_repository_error)?
                    .ok_or_else(|| CoreError::ThreadNotFound(thread_id.clone()))?
                    .lifecycle
            }
        };
        if lifecycle == DurableThreadLifecycle::Archived {
            return Ok(());
        }
        if lifecycle == DurableThreadLifecycle::Deleted {
            return Err(CoreError::ThreadNotFound(thread_id.clone()));
        }
        self.repository
            .archive_thread(thread_id)
            .map_err(map_repository_error)?;
        if let Some(thread) = self.threads.get_mut(thread_id) {
            thread.lifecycle = DurableThreadLifecycle::Archived;
        }
        Ok(())
    }

    fn unarchive_thread(&mut self, thread_id: &ThreadId) -> Result<(), CoreError> {
        if let Some(turn_id) = self
            .threads
            .get(thread_id)
            .and_then(|thread| thread.active_turn_id.clone())
        {
            return Err(CoreError::TurnAlreadyActive {
                thread_id: thread_id.clone(),
                turn_id,
            });
        }
        let mut snapshot = match self.threads.get(thread_id) {
            Some(thread) => durable_thread_snapshot(thread),
            None => self
                .repository
                .load_thread(thread_id)
                .map_err(map_repository_error)?
                .ok_or_else(|| CoreError::ThreadNotFound(thread_id.clone()))?,
        };
        if snapshot.lifecycle == DurableThreadLifecycle::Deleted {
            return Err(CoreError::ThreadNotFound(thread_id.clone()));
        }
        if snapshot.lifecycle == DurableThreadLifecycle::Archived {
            self.repository
                .unarchive_thread(thread_id)
                .map_err(map_repository_error)?;
            snapshot.lifecycle = DurableThreadLifecycle::Active;
        }
        self.materialize_snapshot(&snapshot);
        Ok(())
    }

    fn delete_thread(&mut self, thread_id: &ThreadId) -> Result<(), CoreError> {
        if let Some(turn_id) = self
            .threads
            .get(thread_id)
            .and_then(|thread| thread.active_turn_id.clone())
        {
            return Err(CoreError::TurnAlreadyActive {
                thread_id: thread_id.clone(),
                turn_id,
            });
        }
        let lifecycle = match self.threads.get(thread_id) {
            Some(thread) => thread.lifecycle,
            None => {
                self.repository
                    .load_thread(thread_id)
                    .map_err(map_repository_error)?
                    .ok_or_else(|| CoreError::ThreadNotFound(thread_id.clone()))?
                    .lifecycle
            }
        };
        if lifecycle == DurableThreadLifecycle::Deleted {
            return Ok(());
        }
        self.repository
            .delete_thread(thread_id)
            .map_err(map_repository_error)?;
        if let Some(thread) = self.threads.get_mut(thread_id) {
            thread.lifecycle = DurableThreadLifecycle::Deleted;
        }
        Ok(())
    }

    fn fork_thread(&mut self, thread_id: &ThreadId) -> Result<DurableThreadSnapshot, CoreError> {
        if let Some(turn_id) = self
            .threads
            .get(thread_id)
            .and_then(|thread| thread.active_turn_id.clone())
        {
            return Err(CoreError::TurnAlreadyActive {
                thread_id: thread_id.clone(),
                turn_id,
            });
        }
        let source = match self.threads.get(thread_id) {
            Some(thread) => durable_thread_snapshot(thread),
            None => self
                .repository
                .load_thread(thread_id)
                .map_err(map_repository_error)?
                .ok_or_else(|| CoreError::ThreadNotFound(thread_id.clone()))?,
        };
        if source.lifecycle != DurableThreadLifecycle::Active {
            return Err(CoreError::ThreadNotFound(thread_id.clone()));
        }

        let completed_turns = source
            .turns
            .iter()
            .filter(|turn| turn.status == DurableTurnStatus::Completed)
            .collect::<Vec<_>>();
        let turn_count =
            u64::try_from(completed_turns.len()).map_err(|_| CoreError::TurnIdExhausted)?;
        let item_count = completed_turns.iter().try_fold(0u64, |count, turn| {
            u64::try_from(turn.items.len())
                .ok()
                .and_then(|items| count.checked_add(items))
                .ok_or(CoreError::ItemIdExhausted)
        })?;
        let reserved = self.reserve_ids(1, turn_count, item_count)?;
        let thread_sequence = reserved.thread;
        let mut turn_sequence = reserved.turn - turn_count;
        let mut item_sequence = reserved.item - item_count;
        let mut turns = Vec::new();
        let mut remapped_turn_ids = BTreeMap::new();
        for source_turn in completed_turns {
            turn_sequence = turn_sequence
                .checked_add(1)
                .ok_or(CoreError::TurnIdExhausted)?;
            let remapped_turn_id = TurnId::new(format!("turn_{turn_sequence:016}"));
            let context_compaction = source_turn
                .context_compaction
                .as_ref()
                .map(|compaction| {
                    let mut compaction = compaction.clone();
                    compaction.through_turn_id = remapped_turn_ids
                        .get(&compaction.through_turn_id)
                        .cloned()
                        .ok_or_else(|| {
                            CoreError::Internal(
                                "compaction boundary is absent from completed fork history"
                                    .to_string(),
                            )
                        })?;
                    Ok(compaction)
                })
                .transpose()?;
            let mut items = Vec::with_capacity(source_turn.items.len());
            for source_item in &source_turn.items {
                item_sequence = item_sequence
                    .checked_add(1)
                    .ok_or(CoreError::ItemIdExhausted)?;
                let item = match source_item {
                    DurableItemSnapshot::UserMessage { content, .. } => {
                        DurableItemSnapshot::UserMessage {
                            id: ItemId::new(format!("item_{item_sequence:016}")),
                            content: content.clone(),
                        }
                    }
                    DurableItemSnapshot::AgentMessage { text, .. } => {
                        DurableItemSnapshot::AgentMessage {
                            id: ItemId::new(format!("item_{item_sequence:016}")),
                            text: text.clone(),
                        }
                    }
                    DurableItemSnapshot::AgentCommentary { text, .. } => {
                        DurableItemSnapshot::AgentCommentary {
                            id: ItemId::new(format!("item_{item_sequence:016}")),
                            text: text.clone(),
                        }
                    }
                    DurableItemSnapshot::AgentTask {
                        orchestration_id,
                        task_id,
                        client_task_key,
                        child_thread_id,
                        title,
                        role,
                        access,
                        depends_on,
                        task_markdown,
                        ..
                    } => DurableItemSnapshot::AgentTask {
                        id: ItemId::new(format!("item_{item_sequence:016}")),
                        orchestration_id: orchestration_id.clone(),
                        task_id: task_id.clone(),
                        client_task_key: client_task_key.clone(),
                        child_thread_id: child_thread_id.clone(),
                        title: title.clone(),
                        role: role.clone(),
                        access: access.clone(),
                        depends_on: depends_on.clone(),
                        task_markdown: task_markdown.clone(),
                    },
                    DurableItemSnapshot::AgentTaskAmendment {
                        orchestration_id,
                        task_id,
                        amendment_markdown,
                        ..
                    } => DurableItemSnapshot::AgentTaskAmendment {
                        id: ItemId::new(format!("item_{item_sequence:016}")),
                        orchestration_id: orchestration_id.clone(),
                        task_id: task_id.clone(),
                        amendment_markdown: amendment_markdown.clone(),
                    },
                    DurableItemSnapshot::AgentTaskResult {
                        orchestration_id,
                        task_id,
                        status,
                        summary_markdown,
                        duration_ms,
                        ..
                    } => DurableItemSnapshot::AgentTaskResult {
                        id: ItemId::new(format!("item_{item_sequence:016}")),
                        orchestration_id: orchestration_id.clone(),
                        task_id: task_id.clone(),
                        status: status.clone(),
                        summary_markdown: summary_markdown.clone(),
                        duration_ms: *duration_ms,
                    },
                    DurableItemSnapshot::ContextCompaction {
                        strategy,
                        ordinal,
                        pre_context_bytes,
                        source_messages,
                        source_bytes,
                        source_sha256,
                        outcome,
                        summary,
                        ..
                    } => DurableItemSnapshot::ContextCompaction {
                        id: ItemId::new(format!("item_{item_sequence:016}")),
                        strategy: strategy.clone(),
                        ordinal: *ordinal,
                        pre_context_bytes: *pre_context_bytes,
                        source_messages: *source_messages,
                        source_bytes: *source_bytes,
                        source_sha256: source_sha256.clone(),
                        outcome: outcome.clone(),
                        summary: summary.clone(),
                    },
                    DurableItemSnapshot::ToolCall {
                        call_id,
                        name,
                        arguments,
                        ..
                    } => DurableItemSnapshot::ToolCall {
                        id: ItemId::new(format!("item_{item_sequence:016}")),
                        call_id: call_id.clone(),
                        name: name.clone(),
                        arguments: arguments.clone(),
                    },
                    DurableItemSnapshot::ToolValidationRejected {
                        call_id,
                        name,
                        kind,
                        arguments_bytes,
                        arguments_sha256,
                        edit_index,
                        hunk_index,
                        line,
                        expected_summary,
                        actual_summary,
                        suggested_action,
                        ..
                    } => DurableItemSnapshot::ToolValidationRejected {
                        id: ItemId::new(format!("item_{item_sequence:016}")),
                        call_id: call_id.clone(),
                        name: name.clone(),
                        kind: kind.clone(),
                        arguments_bytes: *arguments_bytes,
                        arguments_sha256: arguments_sha256.clone(),
                        edit_index: *edit_index,
                        hunk_index: *hunk_index,
                        line: *line,
                        expected_summary: expected_summary.clone(),
                        actual_summary: actual_summary.clone(),
                        suggested_action: suggested_action.clone(),
                    },
                    DurableItemSnapshot::FileChange {
                        call_id,
                        path,
                        kind,
                        diff,
                        before_sha256,
                        after_sha256,
                        before_bytes,
                        after_bytes,
                        newline_style,
                        final_newline,
                        ..
                    } => DurableItemSnapshot::FileChange {
                        id: ItemId::new(format!("item_{item_sequence:016}")),
                        call_id: call_id.clone(),
                        path: path.clone(),
                        kind: kind.clone(),
                        diff: diff.clone(),
                        before_sha256: before_sha256.clone(),
                        after_sha256: after_sha256.clone(),
                        before_bytes: *before_bytes,
                        after_bytes: *after_bytes,
                        newline_style: newline_style.clone(),
                        final_newline: *final_newline,
                    },
                    DurableItemSnapshot::CommandApprovalRequest {
                        approval_id,
                        call_id,
                        command,
                        arguments,
                        cwd,
                        environment_policy,
                        sandboxed,
                        sandbox_policy,
                        workspace_write_policy,
                        workspace_write_risk,
                        network_policy,
                        ..
                    } => DurableItemSnapshot::CommandApprovalRequest {
                        id: ItemId::new(format!("item_{item_sequence:016}")),
                        approval_id: approval_id.clone(),
                        call_id: call_id.clone(),
                        command: command.clone(),
                        arguments: arguments.clone(),
                        cwd: cwd.clone(),
                        environment_policy: environment_policy.clone(),
                        sandboxed: *sandboxed,
                        sandbox_policy: sandbox_policy.clone(),
                        workspace_write_policy: workspace_write_policy.clone(),
                        workspace_write_risk: workspace_write_risk.clone(),
                        network_policy: network_policy.clone(),
                    },
                    DurableItemSnapshot::CommandApprovalDecision {
                        approval_id,
                        decision,
                        workspace_write_risk_acknowledgement,
                        ..
                    } => DurableItemSnapshot::CommandApprovalDecision {
                        id: ItemId::new(format!("item_{item_sequence:016}")),
                        approval_id: approval_id.clone(),
                        decision: decision.clone(),
                        workspace_write_risk_acknowledgement: workspace_write_risk_acknowledgement
                            .clone(),
                    },
                    DurableItemSnapshot::CommandExecutionAttempt {
                        approval_id,
                        call_id,
                        ..
                    } => DurableItemSnapshot::CommandExecutionAttempt {
                        id: ItemId::new(format!("item_{item_sequence:016}")),
                        approval_id: approval_id.clone(),
                        call_id: call_id.clone(),
                    },
                    DurableItemSnapshot::McpToolCall {
                        call_id,
                        name,
                        arguments,
                        arguments_bytes,
                        arguments_sha256,
                        inventory_sha256,
                        ..
                    } => DurableItemSnapshot::McpToolCall {
                        id: ItemId::new(format!("item_{item_sequence:016}")),
                        call_id: call_id.clone(),
                        name: name.clone(),
                        arguments: arguments.clone(),
                        arguments_bytes: *arguments_bytes,
                        arguments_sha256: arguments_sha256.clone(),
                        inventory_sha256: inventory_sha256.clone(),
                    },
                    DurableItemSnapshot::McpToolCallApprovalRequest {
                        approval_id,
                        call_id,
                        name,
                        arguments,
                        arguments_bytes,
                        arguments_sha256,
                        inventory_sha256,
                        ..
                    } => DurableItemSnapshot::McpToolCallApprovalRequest {
                        id: ItemId::new(format!("item_{item_sequence:016}")),
                        approval_id: approval_id.clone(),
                        call_id: call_id.clone(),
                        name: name.clone(),
                        arguments: arguments.clone(),
                        arguments_bytes: *arguments_bytes,
                        arguments_sha256: arguments_sha256.clone(),
                        inventory_sha256: inventory_sha256.clone(),
                    },
                    DurableItemSnapshot::McpToolCallApprovalDecision {
                        approval_id,
                        decision,
                        ..
                    } => DurableItemSnapshot::McpToolCallApprovalDecision {
                        id: ItemId::new(format!("item_{item_sequence:016}")),
                        approval_id: approval_id.clone(),
                        decision: decision.clone(),
                    },
                    DurableItemSnapshot::McpToolExecutionAttempt {
                        approval_id,
                        call_id,
                        inventory_sha256,
                        ..
                    } => DurableItemSnapshot::McpToolExecutionAttempt {
                        id: ItemId::new(format!("item_{item_sequence:016}")),
                        approval_id: approval_id.clone(),
                        call_id: call_id.clone(),
                        inventory_sha256: inventory_sha256.clone(),
                    },
                    DurableItemSnapshot::McpToolResult {
                        call_id,
                        name,
                        result,
                        ..
                    } => DurableItemSnapshot::McpToolResult {
                        id: ItemId::new(format!("item_{item_sequence:016}")),
                        call_id: call_id.clone(),
                        name: name.clone(),
                        result: result.clone(),
                    },
                    DurableItemSnapshot::ToolResult {
                        call_id,
                        name,
                        result,
                        ..
                    } => DurableItemSnapshot::ToolResult {
                        id: ItemId::new(format!("item_{item_sequence:016}")),
                        call_id: call_id.clone(),
                        name: name.clone(),
                        result: result.clone(),
                    },
                };
                items.push(item);
            }
            turns.push(DurableTurnSnapshot {
                id: remapped_turn_id.clone(),
                status: source_turn.status,
                items,
                model: source_turn.model.clone(),
                context_compaction,
                workspace_instructions: source_turn.workspace_instructions.clone(),
                workspace_skills: source_turn.workspace_skills.clone(),
                error: source_turn.error.clone(),
                usage: source_turn.usage.clone(),
            });
            remapped_turn_ids.insert(source_turn.id.clone(), remapped_turn_id);
        }
        let snapshot = DurableThreadSnapshot {
            id: ThreadId::new(format!("thr_{thread_sequence:016}")),
            turns,
            lifecycle: DurableThreadLifecycle::Active,
            origin: None,
        };
        self.repository
            .create_thread_snapshot(&snapshot)
            .map_err(map_repository_error)?;
        self.materialize_snapshot(&snapshot);
        self.last_thread_sequence = thread_sequence;
        self.last_turn_sequence = turn_sequence;
        self.last_item_sequence = item_sequence;
        Ok(snapshot)
    }

    fn resume_thread(&mut self, thread_id: &ThreadId) -> Result<DurableThreadSnapshot, CoreError> {
        if let Some(thread) = self.threads.get(thread_id) {
            if thread.lifecycle != DurableThreadLifecycle::Active {
                return Err(CoreError::ThreadNotFound(thread_id.clone()));
            }
            return Ok(durable_thread_snapshot(thread));
        }
        let snapshot = self
            .repository
            .load_thread(thread_id)
            .map_err(map_repository_error)?
            .ok_or_else(|| CoreError::ThreadNotFound(thread_id.clone()))?;
        if snapshot.lifecycle != DurableThreadLifecycle::Active {
            return Err(CoreError::ThreadNotFound(thread_id.clone()));
        }
        self.materialize_snapshot(&snapshot);
        Ok(snapshot)
    }

    fn list_descendants(
        &mut self,
        thread_id: &ThreadId,
    ) -> Result<Vec<DurableThreadSnapshot>, CoreError> {
        self.repository
            .list_descendants(thread_id)
            .map_err(map_repository_error)
    }

    fn start_turn(
        &mut self,
        request_id: CoreRequestId,
        thread_id: ThreadId,
    ) -> Result<Vec<CoreEvent>, CoreError> {
        let thread = self
            .threads
            .get(&thread_id)
            .ok_or_else(|| CoreError::ThreadNotFound(thread_id.clone()))?;
        if thread.lifecycle != DurableThreadLifecycle::Active {
            return Err(CoreError::ThreadNotFound(thread_id));
        }
        if let Some(turn_id) = &thread.active_turn_id {
            return Err(CoreError::TurnAlreadyActive {
                thread_id,
                turn_id: turn_id.clone(),
            });
        }

        let reserved = self.reserve_ids(0, 1, 1)?;
        let turn_sequence = reserved.turn;
        let item_sequence = reserved.item;
        let turn_id = TurnId::new(format!("turn_{turn_sequence:016}"));
        let item_id = ItemId::new(format!("item_{item_sequence:016}"));

        let mut turn = Turn::new(turn_id.clone(), request_id);
        let mut item = Item::new_agent_message(item_id.clone());
        let item_started = item.snapshot();
        item.append_agent_message_delta(DETERMINISTIC_AGENT_MESSAGE)?;
        let delta = DETERMINISTIC_AGENT_MESSAGE.to_string();
        turn.add_item(item)?;
        let item_completed = turn.complete_active_item_and_turn()?;
        let durable_turn = DurableTurnSnapshot {
            id: turn_id.clone(),
            status: DurableTurnStatus::Completed,
            items: vec![durable_item_snapshot(&item_completed)],
            model: None,
            context_compaction: None,
            workspace_instructions: None,
            workspace_skills: None,
            error: None,
            usage: None,
        };
        self.repository
            .append_completed_turn(&thread_id, &durable_turn)
            .map_err(map_repository_error)?;

        self.threads
            .get_mut(&thread_id)
            .ok_or_else(|| CoreError::ThreadNotFound(thread_id.clone()))?
            .turns
            .insert(turn_id.clone(), turn);
        self.last_turn_sequence = turn_sequence;
        self.last_item_sequence = item_sequence;

        Ok(vec![
            CoreEvent {
                request_id,
                kind: CoreEventKind::TurnStarted {
                    thread_id: thread_id.clone(),
                    turn_id: turn_id.clone(),
                },
            },
            CoreEvent {
                request_id,
                kind: CoreEventKind::ItemStarted {
                    thread_id: thread_id.clone(),
                    turn_id: turn_id.clone(),
                    item: item_started,
                },
            },
            CoreEvent {
                request_id,
                kind: CoreEventKind::AgentMessageDelta {
                    thread_id: thread_id.clone(),
                    turn_id: turn_id.clone(),
                    item_id,
                    delta,
                },
            },
            CoreEvent {
                request_id,
                kind: CoreEventKind::ItemCompleted {
                    thread_id: thread_id.clone(),
                    turn_id: turn_id.clone(),
                    item: item_completed,
                },
            },
            CoreEvent {
                request_id,
                kind: CoreEventKind::TurnCompleted {
                    thread_id: thread_id.clone(),
                    turn_id,
                },
            },
        ])
    }
}
