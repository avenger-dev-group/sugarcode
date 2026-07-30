use serde_json::to_value;
use sugarcode_app_server_protocol::AgentMessageDeltaNotification;
use sugarcode_app_server_protocol::ContextCompactionOutcome as PublicContextCompactionOutcome;
use sugarcode_app_server_protocol::ContextCompactionStrategy as PublicContextCompactionStrategy;
use sugarcode_app_server_protocol::Item as PublicItem;
use sugarcode_app_server_protocol::ItemCompletedNotification;
use sugarcode_app_server_protocol::ItemStartedNotification;
use sugarcode_app_server_protocol::JsonRpcMessage;
use sugarcode_app_server_protocol::JsonRpcNotification;
use sugarcode_app_server_protocol::JsonRpcVersion;
use sugarcode_app_server_protocol::McpToolResult as PublicMcpToolResult;
use sugarcode_app_server_protocol::ThreadForkResponse;
use sugarcode_app_server_protocol::ThreadResumeResponse;
use sugarcode_app_server_protocol::ToolResult as PublicToolResult;
use sugarcode_app_server_protocol::Turn as PublicTurn;
use sugarcode_app_server_protocol::TurnCompletedNotification;
use sugarcode_app_server_protocol::TurnError;
use sugarcode_app_server_protocol::TurnErrorKind;
use sugarcode_app_server_protocol::TurnSnapshot;
use sugarcode_app_server_protocol::TurnSnapshotStatus;
use sugarcode_app_server_protocol::TurnStartedNotification;
use sugarcode_app_server_protocol::TurnStatus;
use sugarcode_protocol::CoreEvent;
use sugarcode_protocol::CoreEventKind;
use sugarcode_protocol::CoreItemKind;
use sugarcode_protocol::CoreRequestId;
use sugarcode_protocol::CoreTurnError;
use sugarcode_protocol::CoreTurnErrorKind;
use sugarcode_protocol::ThreadId;
use sugarcode_state::DurableItemSnapshot;
use sugarcode_state::DurableThreadSnapshot;
use sugarcode_state::DurableTurnError;
use sugarcode_state::DurableTurnErrorKind;
use sugarcode_state::DurableTurnStatus;

#[derive(Debug)]
pub(crate) struct EventMappingError;

pub(crate) struct MappedTurnLifecycle {
    pub(crate) turn: PublicTurn,
    pub(crate) notifications: Vec<JsonRpcMessage>,
}

pub(crate) fn map_turn_lifecycle(
    events: Vec<CoreEvent>,
    expected_request_id: CoreRequestId,
    expected_thread_id: &ThreadId,
) -> Result<MappedTurnLifecycle, EventMappingError> {
    let [
        turn_started,
        item_started,
        agent_message_delta,
        item_completed,
        turn_completed,
    ] = events.as_slice()
    else {
        return Err(EventMappingError);
    };
    if events
        .iter()
        .any(|event| event.request_id != expected_request_id)
    {
        return Err(EventMappingError);
    }

    let CoreEventKind::TurnStarted { thread_id, turn_id } = &turn_started.kind else {
        return Err(EventMappingError);
    };
    if thread_id != expected_thread_id {
        return Err(EventMappingError);
    }

    let CoreEventKind::ItemStarted {
        thread_id: started_thread_id,
        turn_id: started_turn_id,
        item: started_item,
    } = &item_started.kind
    else {
        return Err(EventMappingError);
    };
    let CoreItemKind::AgentMessage { text: started_text } = &started_item.kind else {
        return Err(EventMappingError);
    };
    if started_thread_id != thread_id || started_turn_id != turn_id || !started_text.is_empty() {
        return Err(EventMappingError);
    }

    let CoreEventKind::AgentMessageDelta {
        thread_id: delta_thread_id,
        turn_id: delta_turn_id,
        item_id,
        delta,
    } = &agent_message_delta.kind
    else {
        return Err(EventMappingError);
    };
    if delta_thread_id != thread_id
        || delta_turn_id != turn_id
        || item_id != &started_item.id
        || delta.is_empty()
    {
        return Err(EventMappingError);
    }

    let CoreEventKind::ItemCompleted {
        thread_id: completed_thread_id,
        turn_id: completed_turn_id,
        item: completed_item,
    } = &item_completed.kind
    else {
        return Err(EventMappingError);
    };
    let CoreItemKind::AgentMessage {
        text: completed_text,
    } = &completed_item.kind
    else {
        return Err(EventMappingError);
    };
    if completed_thread_id != thread_id
        || completed_turn_id != turn_id
        || completed_item.id != started_item.id
        || completed_text != &format!("{started_text}{delta}")
    {
        return Err(EventMappingError);
    }

    let CoreEventKind::TurnCompleted {
        thread_id: terminal_thread_id,
        turn_id: terminal_turn_id,
    } = &turn_completed.kind
    else {
        return Err(EventMappingError);
    };
    if terminal_thread_id != thread_id || terminal_turn_id != turn_id {
        return Err(EventMappingError);
    }

    let public_thread_id = thread_id.as_str().to_string();
    let public_turn_id = turn_id.as_str().to_string();
    let public_item_id = started_item.id.as_str().to_string();
    let turn = PublicTurn {
        id: public_turn_id.clone(),
        status: TurnStatus::InProgress,
        error: None,
    };
    let started_public_item = PublicItem::AgentMessage {
        id: public_item_id.clone(),
        text: started_text.clone(),
    };
    let completed_public_item = PublicItem::AgentMessage {
        id: public_item_id.clone(),
        text: completed_text.clone(),
    };

    let notifications = vec![
        notification(
            "turn/started",
            to_value(TurnStartedNotification {
                thread_id: public_thread_id.clone(),
                turn: turn.clone(),
            })
            .map_err(|_| EventMappingError)?,
        ),
        notification(
            "item/started",
            to_value(ItemStartedNotification {
                thread_id: public_thread_id.clone(),
                turn_id: public_turn_id.clone(),
                item: started_public_item,
            })
            .map_err(|_| EventMappingError)?,
        ),
        notification(
            "item/agentMessage/delta",
            to_value(AgentMessageDeltaNotification {
                thread_id: public_thread_id.clone(),
                turn_id: public_turn_id.clone(),
                item_id: public_item_id,
                delta: delta.clone(),
            })
            .map_err(|_| EventMappingError)?,
        ),
        notification(
            "item/completed",
            to_value(ItemCompletedNotification {
                thread_id: public_thread_id.clone(),
                turn_id: public_turn_id.clone(),
                item: completed_public_item,
            })
            .map_err(|_| EventMappingError)?,
        ),
        notification(
            "turn/completed",
            to_value(TurnCompletedNotification {
                thread_id: public_thread_id,
                turn: PublicTurn {
                    id: public_turn_id,
                    status: TurnStatus::Completed,
                    error: None,
                },
            })
            .map_err(|_| EventMappingError)?,
        ),
    ];

    Ok(MappedTurnLifecycle {
        turn,
        notifications,
    })
}

pub(crate) fn map_thread_snapshot(snapshot: DurableThreadSnapshot) -> ThreadResumeResponse {
    let (thread, turns) = map_snapshot_parts(snapshot);
    ThreadResumeResponse { thread, turns }
}

pub(crate) fn map_fork_snapshot(snapshot: DurableThreadSnapshot) -> ThreadForkResponse {
    let (thread, turns) = map_snapshot_parts(snapshot);
    ThreadForkResponse { thread, turns }
}

fn map_snapshot_parts(
    snapshot: DurableThreadSnapshot,
) -> (sugarcode_app_server_protocol::Thread, Vec<TurnSnapshot>) {
    (
        sugarcode_app_server_protocol::Thread {
            id: snapshot.id.into_string(),
        },
        snapshot
            .turns
            .into_iter()
            .map(|turn| TurnSnapshot {
                id: turn.id.into_string(),
                status: match turn.status {
                    DurableTurnStatus::InProgress => TurnSnapshotStatus::InProgress,
                    DurableTurnStatus::Completed => TurnSnapshotStatus::Completed,
                    DurableTurnStatus::Failed => TurnSnapshotStatus::Failed,
                    DurableTurnStatus::Interrupted => TurnSnapshotStatus::Interrupted,
                },
                items: turn
                    .items
                    .into_iter()
                    .map(|item| match item {
                        DurableItemSnapshot::UserMessage { id, text } => PublicItem::UserMessage {
                            id: id.into_string(),
                            text,
                        },
                        DurableItemSnapshot::AgentMessage { id, text } => {
                            PublicItem::AgentMessage {
                                id: id.into_string(),
                                text,
                            }
                        }
                        DurableItemSnapshot::ContextCompaction {
                            id,
                            ordinal,
                            pre_context_bytes,
                            source_messages,
                            source_bytes,
                            source_sha256,
                            outcome,
                            ..
                        } => PublicItem::ContextCompaction {
                            id: id.into_string(),
                            strategy: PublicContextCompactionStrategy::ModelGeneratedActiveTurnV1,
                            ordinal,
                            pre_context_bytes,
                            source_messages,
                            source_bytes,
                            source_sha256,
                            outcome: outcome.map(map_durable_compaction_outcome),
                        },
                        DurableItemSnapshot::ToolCall {
                            id,
                            call_id,
                            name,
                            path,
                            query,
                            patch: _,
                            command,
                            arguments,
                        } => PublicItem::ToolCall {
                            id: id.into_string(),
                            call_id,
                            name,
                            path,
                            query,
                            command,
                            arguments,
                        },
                        DurableItemSnapshot::FileChange {
                            id,
                            call_id,
                            path,
                            kind: _,
                            diff,
                            before_sha256,
                            after_sha256,
                            before_bytes,
                            after_bytes,
                            newline_style,
                            final_newline,
                        } => PublicItem::FileChange {
                            id: id.into_string(),
                            call_id,
                            path,
                            kind: sugarcode_app_server_protocol::FileChangeKind::Update,
                            diff,
                            before_sha256,
                            after_sha256,
                            before_bytes,
                            after_bytes,
                            newline_style: if newline_style == "crLf" {
                                sugarcode_app_server_protocol::FileChangeNewlineStyle::CrLf
                            } else {
                                sugarcode_app_server_protocol::FileChangeNewlineStyle::Lf
                            },
                            final_newline,
                        },
                        DurableItemSnapshot::CommandApprovalRequest {
                            id,
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
                        } => PublicItem::CommandApprovalRequest {
                            id: id.into_string(),
                            approval_id,
                            call_id,
                            command,
                            arguments,
                            cwd,
                            environment_policy,
                            sandboxed,
                            sandbox_policy: public_sandbox_policy(sandbox_policy.as_deref()),
                            workspace_write_policy: public_workspace_write_policy(
                                workspace_write_policy.as_deref(),
                            ),
                            workspace_write_risk: public_workspace_write_risk(
                                workspace_write_risk.as_deref(),
                            ),
                            network_policy: public_network_policy(network_policy.as_deref()),
                        },
                        DurableItemSnapshot::CommandApprovalDecision {
                            id,
                            approval_id,
                            decision,
                            workspace_write_risk_acknowledgement,
                        } => PublicItem::CommandApprovalDecision {
                            id: id.into_string(),
                            approval_id,
                            decision,
                            workspace_write_risk_acknowledgement: public_workspace_write_risk(
                                workspace_write_risk_acknowledgement.as_deref(),
                            ),
                        },
                        DurableItemSnapshot::CommandExecutionAttempt {
                            id,
                            approval_id,
                            call_id,
                        } => PublicItem::CommandExecutionAttempt {
                            id: id.into_string(),
                            approval_id,
                            call_id,
                        },
                        DurableItemSnapshot::McpToolCall {
                            id,
                            call_id,
                            name,
                            arguments,
                            arguments_bytes,
                            arguments_sha256,
                            inventory_sha256,
                        } => PublicItem::McpToolCall {
                            id: id.into_string(),
                            call_id,
                            name,
                            arguments,
                            arguments_bytes,
                            arguments_sha256,
                            inventory_sha256,
                        },
                        DurableItemSnapshot::McpToolCallApprovalRequest {
                            id,
                            approval_id,
                            call_id,
                            name,
                            arguments,
                            arguments_bytes,
                            arguments_sha256,
                            inventory_sha256,
                        } => PublicItem::McpToolCallApprovalRequest {
                            id: id.into_string(),
                            approval_id,
                            call_id,
                            name,
                            arguments,
                            arguments_bytes,
                            arguments_sha256,
                            inventory_sha256,
                        },
                        DurableItemSnapshot::McpToolCallApprovalDecision {
                            id,
                            approval_id,
                            decision,
                        } => PublicItem::McpToolCallApprovalDecision {
                            id: id.into_string(),
                            approval_id,
                            decision,
                        },
                        DurableItemSnapshot::McpToolExecutionAttempt {
                            id,
                            approval_id,
                            call_id,
                            inventory_sha256,
                        } => PublicItem::McpToolExecutionAttempt {
                            id: id.into_string(),
                            approval_id,
                            call_id,
                            inventory_sha256,
                        },
                        DurableItemSnapshot::McpToolResult {
                            id,
                            call_id,
                            name,
                            result,
                        } => PublicItem::McpToolResult {
                            id: id.into_string(),
                            call_id,
                            name,
                            result: map_durable_mcp_tool_result(result),
                        },
                        DurableItemSnapshot::ToolResult {
                            id,
                            call_id,
                            name,
                            result,
                        } => PublicItem::ToolResult {
                            id: id.into_string(),
                            call_id,
                            name,
                            result: map_durable_tool_result(result),
                        },
                    })
                    .collect(),
                error: turn.error.map(map_durable_error),
            })
            .collect(),
    )
}

pub(crate) fn map_core_event(event: CoreEvent) -> Result<JsonRpcMessage, EventMappingError> {
    let notification = match event.kind {
        CoreEventKind::TurnStarted { thread_id, turn_id } => notification(
            "turn/started",
            to_value(TurnStartedNotification {
                thread_id: thread_id.into_string(),
                turn: PublicTurn {
                    id: turn_id.into_string(),
                    status: TurnStatus::InProgress,
                    error: None,
                },
            })
            .map_err(|_| EventMappingError)?,
        ),
        CoreEventKind::ItemStarted {
            thread_id,
            turn_id,
            item,
        } => notification(
            "item/started",
            to_value(ItemStartedNotification {
                thread_id: thread_id.into_string(),
                turn_id: turn_id.into_string(),
                item: map_core_item(item),
            })
            .map_err(|_| EventMappingError)?,
        ),
        CoreEventKind::AgentMessageDelta {
            thread_id,
            turn_id,
            item_id,
            delta,
        } => notification(
            "item/agentMessage/delta",
            to_value(AgentMessageDeltaNotification {
                thread_id: thread_id.into_string(),
                turn_id: turn_id.into_string(),
                item_id: item_id.into_string(),
                delta,
            })
            .map_err(|_| EventMappingError)?,
        ),
        CoreEventKind::ItemCompleted {
            thread_id,
            turn_id,
            item,
        } => notification(
            "item/completed",
            to_value(ItemCompletedNotification {
                thread_id: thread_id.into_string(),
                turn_id: turn_id.into_string(),
                item: map_core_item(item),
            })
            .map_err(|_| EventMappingError)?,
        ),
        CoreEventKind::TurnCompleted { thread_id, turn_id } => {
            terminal_notification(thread_id, turn_id, TurnStatus::Completed, None)?
        }
        CoreEventKind::TurnFailed {
            thread_id,
            turn_id,
            error,
        } => terminal_notification(
            thread_id,
            turn_id,
            TurnStatus::Failed,
            Some(map_core_error(error)),
        )?,
        CoreEventKind::TurnInterrupted { thread_id, turn_id } => {
            terminal_notification(thread_id, turn_id, TurnStatus::Interrupted, None)?
        }
        CoreEventKind::ThreadStarted { .. } | CoreEventKind::RuntimeFailed => {
            return Err(EventMappingError);
        }
    };
    Ok(notification)
}

fn terminal_notification(
    thread_id: ThreadId,
    turn_id: sugarcode_protocol::TurnId,
    status: TurnStatus,
    error: Option<TurnError>,
) -> Result<JsonRpcMessage, EventMappingError> {
    Ok(notification(
        "turn/completed",
        to_value(TurnCompletedNotification {
            thread_id: thread_id.into_string(),
            turn: PublicTurn {
                id: turn_id.into_string(),
                status,
                error,
            },
        })
        .map_err(|_| EventMappingError)?,
    ))
}

fn map_core_item(item: sugarcode_protocol::CoreItemSnapshot) -> PublicItem {
    match item.kind {
        CoreItemKind::UserMessage { text } => PublicItem::UserMessage {
            id: item.id.into_string(),
            text,
        },
        CoreItemKind::AgentMessage { text } => PublicItem::AgentMessage {
            id: item.id.into_string(),
            text,
        },
        CoreItemKind::ContextCompaction {
            ordinal,
            pre_context_bytes,
            source_messages,
            source_bytes,
            source_sha256,
            outcome,
            ..
        } => PublicItem::ContextCompaction {
            id: item.id.into_string(),
            strategy: PublicContextCompactionStrategy::ModelGeneratedActiveTurnV1,
            ordinal,
            pre_context_bytes,
            source_messages,
            source_bytes,
            source_sha256,
            outcome: outcome.map(map_core_compaction_outcome),
        },
        CoreItemKind::ToolCall {
            call_id,
            name,
            path,
            query,
            patch: _,
            command,
            arguments,
        } => PublicItem::ToolCall {
            id: item.id.into_string(),
            call_id,
            name,
            path,
            query,
            command,
            arguments,
        },
        CoreItemKind::FileChange {
            call_id,
            path,
            kind: _,
            diff,
            before_sha256,
            after_sha256,
            before_bytes,
            after_bytes,
            newline_style,
            final_newline,
        } => PublicItem::FileChange {
            id: item.id.into_string(),
            call_id,
            path,
            kind: sugarcode_app_server_protocol::FileChangeKind::Update,
            diff,
            before_sha256,
            after_sha256,
            before_bytes,
            after_bytes,
            newline_style: match newline_style {
                sugarcode_protocol::CoreFileChangeNewlineStyle::Lf => {
                    sugarcode_app_server_protocol::FileChangeNewlineStyle::Lf
                }
                sugarcode_protocol::CoreFileChangeNewlineStyle::CrLf => {
                    sugarcode_app_server_protocol::FileChangeNewlineStyle::CrLf
                }
            },
            final_newline,
        },
        CoreItemKind::CommandApprovalRequest {
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
        } => PublicItem::CommandApprovalRequest {
            id: item.id.into_string(),
            approval_id,
            call_id,
            command,
            arguments,
            cwd,
            environment_policy,
            sandboxed,
            sandbox_policy: sandbox_policy.map(|policy| match policy {
                sugarcode_protocol::CoreCommandSandboxPolicy::FilesystemReadOnlyV1 => {
                    sugarcode_app_server_protocol::CommandSandboxPolicy::FilesystemReadOnlyV1
                }
            }),
            workspace_write_policy: workspace_write_policy.map(|policy| match policy {
                sugarcode_protocol::CoreCommandWorkspaceWritePolicy::CommandWorkspaceWriteV1 => {
                    sugarcode_app_server_protocol::CommandWorkspaceWritePolicy::CommandWorkspaceWriteV1
                }
            }),
            workspace_write_risk: workspace_write_risk.map(|risk| match risk {
                sugarcode_protocol::CoreCommandWorkspaceWriteRisk::NonTransactionalWorkspaceTreeV1 => {
                    sugarcode_app_server_protocol::CommandWorkspaceWriteRisk::NonTransactionalWorkspaceTreeV1
                }
            }),
            network_policy: network_policy.map(|policy| match policy {
                sugarcode_protocol::CoreCommandNetworkPolicy::NetworkDeniedV1 => {
                    sugarcode_app_server_protocol::CommandNetworkPolicy::NetworkDeniedV1
                }
            }),
        },
        CoreItemKind::CommandApprovalDecision {
            approval_id,
            decision,
            workspace_write_risk_acknowledgement,
        } => PublicItem::CommandApprovalDecision {
            id: item.id.into_string(),
            approval_id,
            decision: decision.to_string(),
            workspace_write_risk_acknowledgement:
                workspace_write_risk_acknowledgement.map(|risk| match risk {
                    sugarcode_protocol::CoreCommandWorkspaceWriteRisk::NonTransactionalWorkspaceTreeV1 => {
                        sugarcode_app_server_protocol::CommandWorkspaceWriteRisk::NonTransactionalWorkspaceTreeV1
                    }
                }),
        },
        CoreItemKind::CommandExecutionAttempt {
            approval_id,
            call_id,
        } => PublicItem::CommandExecutionAttempt {
            id: item.id.into_string(),
            approval_id,
            call_id,
        },
        CoreItemKind::McpToolCall {
            call_id,
            name,
            arguments,
            arguments_bytes,
            arguments_sha256,
            inventory_sha256,
        } => PublicItem::McpToolCall {
            id: item.id.into_string(),
            call_id,
            name,
            arguments,
            arguments_bytes,
            arguments_sha256,
            inventory_sha256,
        },
        CoreItemKind::McpToolCallApprovalRequest {
            approval_id,
            call_id,
            name,
            arguments,
            arguments_bytes,
            arguments_sha256,
            inventory_sha256,
        } => PublicItem::McpToolCallApprovalRequest {
            id: item.id.into_string(),
            approval_id,
            call_id,
            name,
            arguments,
            arguments_bytes,
            arguments_sha256,
            inventory_sha256,
        },
        CoreItemKind::McpToolCallApprovalDecision {
            approval_id,
            decision,
        } => PublicItem::McpToolCallApprovalDecision {
            id: item.id.into_string(),
            approval_id,
            decision: decision.to_string(),
        },
        CoreItemKind::McpToolExecutionAttempt {
            approval_id,
            call_id,
            inventory_sha256,
        } => PublicItem::McpToolExecutionAttempt {
            id: item.id.into_string(),
            approval_id,
            call_id,
            inventory_sha256,
        },
        CoreItemKind::McpToolResult {
            call_id,
            name,
            result,
        } => PublicItem::McpToolResult {
            id: item.id.into_string(),
            call_id,
            name,
            result: map_core_mcp_tool_result(result),
        },
        CoreItemKind::ToolResult {
            call_id,
            name,
            result,
        } => PublicItem::ToolResult {
            id: item.id.into_string(),
            call_id,
            name,
            result: match result {
                sugarcode_protocol::CoreToolResult::Success { content, bytes } => {
                    PublicToolResult::Success { content, bytes }
                }
                sugarcode_protocol::CoreToolResult::Error { kind } => PublicToolResult::Error {
                    kind: kind.to_string(),
                },
                sugarcode_protocol::CoreToolResult::Process(process) => PublicToolResult::Process {
                    stdout: process.stdout,
                    stderr: process.stderr,
                    stdout_bytes: process.stdout_bytes,
                    stderr_bytes: process.stderr_bytes,
                    stdout_truncated: process.stdout_truncated,
                    stderr_truncated: process.stderr_truncated,
                    encoding: process.encoding,
                    duration_ms: process.duration_ms,
                    outcome: match process.outcome {
                        sugarcode_protocol::CoreProcessOutcome::ExitCode { code } => {
                            sugarcode_app_server_protocol::ProcessOutcome::ExitCode { code }
                        }
                        sugarcode_protocol::CoreProcessOutcome::Signal { signal } => {
                            sugarcode_app_server_protocol::ProcessOutcome::Signal { signal }
                        }
                        sugarcode_protocol::CoreProcessOutcome::TimedOut => {
                            sugarcode_app_server_protocol::ProcessOutcome::TimedOut
                        }
                    },
                    sandbox_policy: process.sandbox_policy.map(|policy| match policy {
                        sugarcode_protocol::CoreCommandSandboxPolicy::FilesystemReadOnlyV1 => {
                            sugarcode_app_server_protocol::CommandSandboxPolicy::FilesystemReadOnlyV1
                        }
                    }),
                    workspace_write_policy: process.workspace_write_policy.map(|policy| {
                        match policy {
                            sugarcode_protocol::CoreCommandWorkspaceWritePolicy::CommandWorkspaceWriteV1 => {
                                sugarcode_app_server_protocol::CommandWorkspaceWritePolicy::CommandWorkspaceWriteV1
                            }
                        }
                    }),
                    network_policy: process.network_policy.map(|policy| match policy {
                        sugarcode_protocol::CoreCommandNetworkPolicy::NetworkDeniedV1 => {
                            sugarcode_app_server_protocol::CommandNetworkPolicy::NetworkDeniedV1
                        }
                    }),
                },
            },
        },
    }
}

fn map_durable_tool_result(result: sugarcode_state::DurableToolResult) -> PublicToolResult {
    match result {
        sugarcode_state::DurableToolResult::Success { content, bytes } => {
            PublicToolResult::Success { content, bytes }
        }
        sugarcode_state::DurableToolResult::Error { kind } => PublicToolResult::Error { kind },
        sugarcode_state::DurableToolResult::Process(process) => PublicToolResult::Process {
            stdout: process.stdout,
            stderr: process.stderr,
            stdout_bytes: process.stdout_bytes,
            stderr_bytes: process.stderr_bytes,
            stdout_truncated: process.stdout_truncated,
            stderr_truncated: process.stderr_truncated,
            encoding: process.encoding,
            duration_ms: process.duration_ms,
            outcome: match process.outcome {
                sugarcode_state::DurableProcessOutcome::ExitCode { code } => {
                    sugarcode_app_server_protocol::ProcessOutcome::ExitCode { code }
                }
                sugarcode_state::DurableProcessOutcome::Signal { signal } => {
                    sugarcode_app_server_protocol::ProcessOutcome::Signal { signal }
                }
                sugarcode_state::DurableProcessOutcome::TimedOut => {
                    sugarcode_app_server_protocol::ProcessOutcome::TimedOut
                }
            },
            sandbox_policy: public_sandbox_policy(process.sandbox_policy.as_deref()),
            workspace_write_policy: public_workspace_write_policy(
                process.workspace_write_policy.as_deref(),
            ),
            network_policy: public_network_policy(process.network_policy.as_deref()),
        },
    }
}

fn map_core_mcp_tool_result(result: sugarcode_protocol::CoreMcpToolResult) -> PublicMcpToolResult {
    match result {
        sugarcode_protocol::CoreMcpToolResult::Completed {
            content,
            is_error,
            observed_bytes,
            canonical_bytes,
            retained_bytes,
            truncated,
            sha256,
            content_blocks,
            structured_content,
        } => PublicMcpToolResult::Completed {
            content,
            is_error,
            observed_bytes,
            canonical_bytes,
            retained_bytes,
            truncated,
            sha256,
            content_blocks,
            structured_content,
        },
        sugarcode_protocol::CoreMcpToolResult::Error {
            kind,
            request_state,
        } => PublicMcpToolResult::Error {
            kind,
            request_state,
        },
    }
}

fn map_core_compaction_outcome(
    outcome: sugarcode_protocol::CoreContextCompactionOutcome,
) -> PublicContextCompactionOutcome {
    match outcome {
        sugarcode_protocol::CoreContextCompactionOutcome::Completed {
            post_context_bytes,
            summary_bytes,
            summary_sha256,
        } => PublicContextCompactionOutcome::Completed {
            post_context_bytes,
            summary_bytes,
            summary_sha256,
        },
        sugarcode_protocol::CoreContextCompactionOutcome::Failed { kind } => {
            PublicContextCompactionOutcome::Failed { kind }
        }
        sugarcode_protocol::CoreContextCompactionOutcome::Interrupted => {
            PublicContextCompactionOutcome::Interrupted
        }
    }
}

fn map_durable_compaction_outcome(
    outcome: sugarcode_state::DurableActiveTurnCompactionOutcome,
) -> PublicContextCompactionOutcome {
    match outcome {
        sugarcode_state::DurableActiveTurnCompactionOutcome::Completed {
            post_context_bytes,
            summary_bytes,
            summary_sha256,
        } => PublicContextCompactionOutcome::Completed {
            post_context_bytes,
            summary_bytes,
            summary_sha256,
        },
        sugarcode_state::DurableActiveTurnCompactionOutcome::Failed { kind } => {
            PublicContextCompactionOutcome::Failed { kind }
        }
        sugarcode_state::DurableActiveTurnCompactionOutcome::Interrupted => {
            PublicContextCompactionOutcome::Interrupted
        }
    }
}

fn map_durable_mcp_tool_result(
    result: sugarcode_state::DurableMcpToolResult,
) -> PublicMcpToolResult {
    match result {
        sugarcode_state::DurableMcpToolResult::Completed {
            content,
            is_error,
            observed_bytes,
            canonical_bytes,
            retained_bytes,
            truncated,
            sha256,
            content_blocks,
            structured_content,
        } => PublicMcpToolResult::Completed {
            content,
            is_error,
            observed_bytes,
            canonical_bytes,
            retained_bytes,
            truncated,
            sha256,
            content_blocks,
            structured_content,
        },
        sugarcode_state::DurableMcpToolResult::Error {
            kind,
            request_state,
        } => PublicMcpToolResult::Error {
            kind,
            request_state,
        },
    }
}

fn public_network_policy(
    policy: Option<&str>,
) -> Option<sugarcode_app_server_protocol::CommandNetworkPolicy> {
    match policy {
        Some("networkDeniedV1") => {
            Some(sugarcode_app_server_protocol::CommandNetworkPolicy::NetworkDeniedV1)
        }
        Some(_) | None => None,
    }
}

fn public_workspace_write_policy(
    policy: Option<&str>,
) -> Option<sugarcode_app_server_protocol::CommandWorkspaceWritePolicy> {
    match policy {
        Some("commandWorkspaceWriteV1") => Some(
            sugarcode_app_server_protocol::CommandWorkspaceWritePolicy::CommandWorkspaceWriteV1,
        ),
        Some(_) | None => None,
    }
}

fn public_workspace_write_risk(
    risk: Option<&str>,
) -> Option<sugarcode_app_server_protocol::CommandWorkspaceWriteRisk> {
    match risk {
        Some("nonTransactionalWorkspaceTreeV1") => Some(
            sugarcode_app_server_protocol::CommandWorkspaceWriteRisk::NonTransactionalWorkspaceTreeV1,
        ),
        Some(_) | None => None,
    }
}

fn public_sandbox_policy(
    policy: Option<&str>,
) -> Option<sugarcode_app_server_protocol::CommandSandboxPolicy> {
    match policy {
        Some("filesystemReadOnlyV1") => {
            Some(sugarcode_app_server_protocol::CommandSandboxPolicy::FilesystemReadOnlyV1)
        }
        Some(_) | None => None,
    }
}

fn map_core_error(error: CoreTurnError) -> TurnError {
    TurnError {
        kind: match error.kind {
            CoreTurnErrorKind::Authentication => TurnErrorKind::Authentication,
            CoreTurnErrorKind::InvalidRequest => TurnErrorKind::InvalidRequest,
            CoreTurnErrorKind::RateLimited => TurnErrorKind::RateLimited,
            CoreTurnErrorKind::Timeout => TurnErrorKind::Timeout,
            CoreTurnErrorKind::Transport => TurnErrorKind::Transport,
            CoreTurnErrorKind::Disconnected => TurnErrorKind::Disconnected,
            CoreTurnErrorKind::Server => TurnErrorKind::Server,
            CoreTurnErrorKind::Protocol => TurnErrorKind::Protocol,
            CoreTurnErrorKind::Incomplete => TurnErrorKind::Incomplete,
            CoreTurnErrorKind::Filtered => TurnErrorKind::Filtered,
            CoreTurnErrorKind::UnsupportedOutput => TurnErrorKind::UnsupportedOutput,
            CoreTurnErrorKind::OutputTooLarge => TurnErrorKind::OutputTooLarge,
            CoreTurnErrorKind::StateUnavailable => TurnErrorKind::StateUnavailable,
        },
        retryable: error.retryable,
    }
}

fn map_durable_error(error: DurableTurnError) -> TurnError {
    TurnError {
        kind: match error.kind {
            DurableTurnErrorKind::Authentication => TurnErrorKind::Authentication,
            DurableTurnErrorKind::InvalidRequest => TurnErrorKind::InvalidRequest,
            DurableTurnErrorKind::RateLimited => TurnErrorKind::RateLimited,
            DurableTurnErrorKind::Timeout => TurnErrorKind::Timeout,
            DurableTurnErrorKind::Transport => TurnErrorKind::Transport,
            DurableTurnErrorKind::Disconnected => TurnErrorKind::Disconnected,
            DurableTurnErrorKind::Server => TurnErrorKind::Server,
            DurableTurnErrorKind::Protocol => TurnErrorKind::Protocol,
            DurableTurnErrorKind::Incomplete => TurnErrorKind::Incomplete,
            DurableTurnErrorKind::Filtered => TurnErrorKind::Filtered,
            DurableTurnErrorKind::UnsupportedOutput => TurnErrorKind::UnsupportedOutput,
            DurableTurnErrorKind::OutputTooLarge => TurnErrorKind::OutputTooLarge,
            DurableTurnErrorKind::StateUnavailable => TurnErrorKind::StateUnavailable,
        },
        retryable: error.retryable,
    }
}

fn notification(method: &str, params: serde_json::Value) -> JsonRpcMessage {
    JsonRpcMessage::Notification(JsonRpcNotification {
        jsonrpc: JsonRpcVersion::V2,
        method: method.to_string(),
        params: Some(params),
    })
}
