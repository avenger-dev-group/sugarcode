use super::*;

pub(super) fn durable_item_snapshot(item: &CoreItemSnapshot) -> DurableItemSnapshot {
    match &item.kind {
        CoreItemKind::UserMessage { text } => DurableItemSnapshot::UserMessage {
            id: item.id.clone(),
            text: text.clone(),
        },
        CoreItemKind::AgentMessage { text } => DurableItemSnapshot::AgentMessage {
            id: item.id.clone(),
            text: text.clone(),
        },
        CoreItemKind::ToolCall {
            call_id,
            name,
            path,
            query,
            patch,
            command,
            arguments,
        } => DurableItemSnapshot::ToolCall {
            id: item.id.clone(),
            call_id: call_id.clone(),
            name: name.clone(),
            path: path.clone(),
            query: query.clone(),
            patch: patch.clone(),
            command: command.clone(),
            arguments: arguments.clone(),
        },
        CoreItemKind::FileChange {
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
        } => DurableItemSnapshot::FileChange {
            id: item.id.clone(),
            call_id: call_id.clone(),
            path: path.clone(),
            kind: match kind {
                sugarcode_protocol::CoreFileChangeKind::Update => "update".to_string(),
            },
            diff: diff.clone(),
            before_sha256: before_sha256.clone(),
            after_sha256: after_sha256.clone(),
            before_bytes: *before_bytes,
            after_bytes: *after_bytes,
            newline_style: match newline_style {
                sugarcode_protocol::CoreFileChangeNewlineStyle::Lf => "lf".to_string(),
                sugarcode_protocol::CoreFileChangeNewlineStyle::CrLf => "crLf".to_string(),
            },
            final_newline: *final_newline,
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
        } => DurableItemSnapshot::CommandApprovalRequest {
            id: item.id.clone(),
            approval_id: approval_id.clone(),
            call_id: call_id.clone(),
            command: command.clone(),
            arguments: arguments.clone(),
            cwd: cwd.clone(),
            environment_policy: environment_policy.clone(),
            sandboxed: *sandboxed,
            sandbox_policy: sandbox_policy.map(|policy| policy.to_string()),
            workspace_write_policy: workspace_write_policy.map(|policy| policy.to_string()),
            workspace_write_risk: workspace_write_risk.map(|risk| risk.to_string()),
            network_policy: network_policy.map(|policy| policy.to_string()),
        },
        CoreItemKind::CommandApprovalDecision {
            approval_id,
            decision,
            workspace_write_risk_acknowledgement,
        } => DurableItemSnapshot::CommandApprovalDecision {
            id: item.id.clone(),
            approval_id: approval_id.clone(),
            decision: decision.to_string(),
            workspace_write_risk_acknowledgement: workspace_write_risk_acknowledgement
                .map(|risk| risk.to_string()),
        },
        CoreItemKind::CommandExecutionAttempt {
            approval_id,
            call_id,
        } => DurableItemSnapshot::CommandExecutionAttempt {
            id: item.id.clone(),
            approval_id: approval_id.clone(),
            call_id: call_id.clone(),
        },
        CoreItemKind::ToolResult {
            call_id,
            name,
            result,
        } => DurableItemSnapshot::ToolResult {
            id: item.id.clone(),
            call_id: call_id.clone(),
            name: name.clone(),
            result: durable_tool_result(result),
        },
    }
}

pub(super) fn item_from_snapshot(snapshot: &CoreItemSnapshot, state: ItemState) -> Item {
    let kind = match &snapshot.kind {
        CoreItemKind::UserMessage { text } => ItemKind::UserMessage { text: text.clone() },
        CoreItemKind::AgentMessage { text } => ItemKind::AgentMessage { text: text.clone() },
        CoreItemKind::ToolCall {
            call_id,
            name,
            path,
            query,
            patch,
            command,
            arguments,
        } => ItemKind::ToolCall {
            call_id: call_id.clone(),
            name: name.clone(),
            path: path.clone(),
            query: query.clone(),
            patch: patch.clone(),
            command: command.clone(),
            arguments: arguments.clone(),
        },
        CoreItemKind::FileChange {
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
        } => ItemKind::FileChange {
            call_id: call_id.clone(),
            path: path.clone(),
            kind: *kind,
            diff: diff.clone(),
            before_sha256: before_sha256.clone(),
            after_sha256: after_sha256.clone(),
            before_bytes: *before_bytes,
            after_bytes: *after_bytes,
            newline_style: *newline_style,
            final_newline: *final_newline,
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
        } => ItemKind::CommandApprovalRequest {
            approval_id: approval_id.clone(),
            call_id: call_id.clone(),
            command: command.clone(),
            arguments: arguments.clone(),
            cwd: cwd.clone(),
            environment_policy: environment_policy.clone(),
            sandboxed: *sandboxed,
            sandbox_policy: *sandbox_policy,
            workspace_write_policy: *workspace_write_policy,
            workspace_write_risk: *workspace_write_risk,
            network_policy: *network_policy,
        },
        CoreItemKind::CommandApprovalDecision {
            approval_id,
            decision,
            workspace_write_risk_acknowledgement,
        } => ItemKind::CommandApprovalDecision {
            approval_id: approval_id.clone(),
            decision: *decision,
            workspace_write_risk_acknowledgement: *workspace_write_risk_acknowledgement,
        },
        CoreItemKind::CommandExecutionAttempt {
            approval_id,
            call_id,
        } => ItemKind::CommandExecutionAttempt {
            approval_id: approval_id.clone(),
            call_id: call_id.clone(),
        },
        CoreItemKind::ToolResult {
            call_id,
            name,
            result,
        } => ItemKind::ToolResult {
            call_id: call_id.clone(),
            name: name.clone(),
            result: result.clone(),
        },
    };
    Item {
        id: snapshot.id.clone(),
        state,
        kind,
    }
}

pub(super) fn durable_tool_result(result: &CoreToolResult) -> DurableToolResult {
    match result {
        CoreToolResult::Success { content, bytes } => DurableToolResult::Success {
            content: content.clone(),
            bytes: *bytes,
        },
        CoreToolResult::Error { kind } => DurableToolResult::Error {
            kind: kind.to_string(),
        },
        CoreToolResult::Process(process) => {
            DurableToolResult::Process(sugarcode_state::DurableProcessResult {
                stdout: process.stdout.clone(),
                stderr: process.stderr.clone(),
                stdout_bytes: process.stdout_bytes,
                stderr_bytes: process.stderr_bytes,
                stdout_truncated: process.stdout_truncated,
                stderr_truncated: process.stderr_truncated,
                encoding: process.encoding.clone(),
                duration_ms: process.duration_ms,
                outcome: match process.outcome {
                    sugarcode_protocol::CoreProcessOutcome::ExitCode { code } => {
                        sugarcode_state::DurableProcessOutcome::ExitCode { code }
                    }
                    sugarcode_protocol::CoreProcessOutcome::Signal { signal } => {
                        sugarcode_state::DurableProcessOutcome::Signal { signal }
                    }
                    sugarcode_protocol::CoreProcessOutcome::TimedOut => {
                        sugarcode_state::DurableProcessOutcome::TimedOut
                    }
                },
                sandbox_policy: process.sandbox_policy.map(|policy| policy.to_string()),
                workspace_write_policy: process
                    .workspace_write_policy
                    .map(|policy| policy.to_string()),
                network_policy: process.network_policy.map(|policy| policy.to_string()),
            })
        }
    }
}

pub(super) fn core_tool_result(result: &DurableToolResult) -> CoreToolResult {
    match result {
        DurableToolResult::Success { content, bytes } => CoreToolResult::Success {
            content: content.clone(),
            bytes: *bytes,
        },
        DurableToolResult::Error { kind } => CoreToolResult::Error {
            kind: core_tool_error_kind(kind),
        },
        DurableToolResult::Process(process) => {
            CoreToolResult::Process(sugarcode_protocol::CoreProcessResult {
                stdout: process.stdout.clone(),
                stderr: process.stderr.clone(),
                stdout_bytes: process.stdout_bytes,
                stderr_bytes: process.stderr_bytes,
                stdout_truncated: process.stdout_truncated,
                stderr_truncated: process.stderr_truncated,
                encoding: process.encoding.clone(),
                duration_ms: process.duration_ms,
                outcome: match process.outcome {
                    sugarcode_state::DurableProcessOutcome::ExitCode { code } => {
                        sugarcode_protocol::CoreProcessOutcome::ExitCode { code }
                    }
                    sugarcode_state::DurableProcessOutcome::Signal { signal } => {
                        sugarcode_protocol::CoreProcessOutcome::Signal { signal }
                    }
                    sugarcode_state::DurableProcessOutcome::TimedOut => {
                        sugarcode_protocol::CoreProcessOutcome::TimedOut
                    }
                },
                sandbox_policy: process
                    .sandbox_policy
                    .as_deref()
                    .and_then(|policy| match policy {
                        "filesystemReadOnlyV1" => {
                            Some(sugarcode_protocol::CoreCommandSandboxPolicy::FilesystemReadOnlyV1)
                        }
                        _ => None,
                    }),
                workspace_write_policy: process
                    .workspace_write_policy
                    .as_deref()
                    .and_then(|policy| match policy {
                        "commandWorkspaceWriteV1" => Some(
                            sugarcode_protocol::CoreCommandWorkspaceWritePolicy::CommandWorkspaceWriteV1,
                        ),
                        _ => None,
                    }),
                network_policy: process
                    .network_policy
                    .as_deref()
                    .and_then(|policy| match policy {
                        "networkDeniedV1" => {
                            Some(sugarcode_protocol::CoreCommandNetworkPolicy::NetworkDeniedV1)
                        }
                        _ => None,
                    }),
            })
        }
    }
}

pub(super) fn core_tool_error_kind(kind: &str) -> sugarcode_protocol::CoreToolErrorKind {
    use sugarcode_protocol::CoreToolErrorKind;

    match kind {
        "invalidPath" => CoreToolErrorKind::InvalidPath,
        "invalidQuery" => CoreToolErrorKind::InvalidQuery,
        "notFound" => CoreToolErrorKind::NotFound,
        "accessDenied" => CoreToolErrorKind::AccessDenied,
        "pathNotAllowed" => CoreToolErrorKind::PathNotAllowed,
        "notRegularFile" => CoreToolErrorKind::NotRegularFile,
        "notDirectory" => CoreToolErrorKind::NotDirectory,
        "fileTooLarge" => CoreToolErrorKind::FileTooLarge,
        "binaryFile" => CoreToolErrorKind::BinaryFile,
        "invalidEncoding" => CoreToolErrorKind::InvalidEncoding,
        "invalidNewline" => CoreToolErrorKind::InvalidNewline,
        "invalidName" => CoreToolErrorKind::InvalidName,
        "tooManyEntries" => CoreToolErrorKind::TooManyEntries,
        "changedDuringRead" => CoreToolErrorKind::ChangedDuringRead,
        "changedDuringList" => CoreToolErrorKind::ChangedDuringList,
        "searchLimitExceeded" => CoreToolErrorKind::SearchLimitExceeded,
        "searchTimedOut" => CoreToolErrorKind::SearchTimedOut,
        "changedDuringSearch" => CoreToolErrorKind::ChangedDuringSearch,
        "resultTooLarge" => CoreToolErrorKind::ResultTooLarge,
        "invalidPatch" => CoreToolErrorKind::InvalidPatch,
        "patchDoesNotApply" => CoreToolErrorKind::PatchDoesNotApply,
        "tooManyLines" => CoreToolErrorKind::TooManyLines,
        "lineTooLong" => CoreToolErrorKind::LineTooLong,
        "hardLinkNotAllowed" => CoreToolErrorKind::HardLinkNotAllowed,
        "crossDeviceNotAllowed" => CoreToolErrorKind::CrossDeviceNotAllowed,
        "conflict" => CoreToolErrorKind::Conflict,
        "atomicReplaceUnavailable" => CoreToolErrorKind::AtomicReplaceUnavailable,
        "approvalUnsupported" => CoreToolErrorKind::ApprovalUnsupported,
        "approvalDenied" => CoreToolErrorKind::ApprovalDenied,
        "approvalTimedOut" => CoreToolErrorKind::ApprovalTimedOut,
        "commandNotFound" => CoreToolErrorKind::CommandNotFound,
        "spawnFailed" => CoreToolErrorKind::SpawnFailed,
        "processControlUnavailable" => CoreToolErrorKind::ProcessControlUnavailable,
        "sandboxUnavailable" => CoreToolErrorKind::SandboxUnavailable,
        _ => CoreToolErrorKind::Unavailable,
    }
}

pub(super) fn tool_result_content(name: &str, result: &CoreToolResult) -> String {
    match result {
        CoreToolResult::Success { content, .. } => content.clone(),
        CoreToolResult::Error { kind } => format!("{name} error: {kind}"),
        CoreToolResult::Process(process) => serde_json::to_string(&serde_json::json!({
            "stdout": process.stdout,
            "stderr": process.stderr,
            "stdoutBytes": process.stdout_bytes,
            "stderrBytes": process.stderr_bytes,
            "stdoutTruncated": process.stdout_truncated,
            "stderrTruncated": process.stderr_truncated,
            "encoding": process.encoding,
            "durationMs": process.duration_ms,
            "outcome": match process.outcome {
                sugarcode_protocol::CoreProcessOutcome::ExitCode { code } =>
                    serde_json::json!({"type": "exitCode", "code": code}),
                sugarcode_protocol::CoreProcessOutcome::Signal { signal } =>
                    serde_json::json!({"type": "signal", "signal": signal}),
                sugarcode_protocol::CoreProcessOutcome::TimedOut =>
                    serde_json::json!({"type": "timedOut"}),
            },
        }))
        .expect("process result must serialize"),
    }
}

pub(super) fn durable_thread_snapshot(thread: &Thread) -> DurableThreadSnapshot {
    DurableThreadSnapshot {
        id: thread.id.clone(),
        lifecycle: thread.lifecycle,
        turns: thread
            .turns
            .values()
            .map(|turn| DurableTurnSnapshot {
                id: turn.id.clone(),
                status: match turn.state {
                    TurnState::InProgress => DurableTurnStatus::InProgress,
                    TurnState::Interrupted => DurableTurnStatus::Interrupted,
                    TurnState::Completed => DurableTurnStatus::Completed,
                    TurnState::Failed => DurableTurnStatus::Failed,
                },
                items: turn
                    .items
                    .values()
                    .map(|item| durable_item_snapshot(&item.snapshot()))
                    .collect(),
                error: turn.error.clone(),
                usage: turn.usage.clone(),
            })
            .collect(),
    }
}

pub(super) fn map_repository_error(_error: RolloutError) -> CoreError {
    CoreError::StateUnavailable
}
