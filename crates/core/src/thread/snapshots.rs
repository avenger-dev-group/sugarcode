use super::*;

pub(super) fn durable_item_snapshot(item: &CoreItemSnapshot) -> DurableItemSnapshot {
    match &item.kind {
        CoreItemKind::UserMessage { content } => DurableItemSnapshot::UserMessage {
            id: item.id.clone(),
            content: content.iter().map(durable_user_content_part).collect(),
        },
        CoreItemKind::AgentMessage { text } => DurableItemSnapshot::AgentMessage {
            id: item.id.clone(),
            text: text.clone(),
        },
        CoreItemKind::AgentCommentary { text } => DurableItemSnapshot::AgentCommentary {
            id: item.id.clone(),
            text: text.clone(),
        },
        CoreItemKind::AgentTask {
            orchestration_id,
            task_id,
            client_task_key,
            child_thread_id,
            title,
            role,
            access,
            depends_on,
            task_markdown,
        } => DurableItemSnapshot::AgentTask {
            id: item.id.clone(),
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
        CoreItemKind::AgentTaskAmendment {
            orchestration_id,
            task_id,
            amendment_markdown,
        } => DurableItemSnapshot::AgentTaskAmendment {
            id: item.id.clone(),
            orchestration_id: orchestration_id.clone(),
            task_id: task_id.clone(),
            amendment_markdown: amendment_markdown.clone(),
        },
        CoreItemKind::AgentTaskResult {
            orchestration_id,
            task_id,
            status,
            summary_markdown,
            duration_ms,
        } => DurableItemSnapshot::AgentTaskResult {
            id: item.id.clone(),
            orchestration_id: orchestration_id.clone(),
            task_id: task_id.clone(),
            status: status.clone(),
            summary_markdown: summary_markdown.clone(),
            duration_ms: *duration_ms,
        },
        CoreItemKind::ContextCompaction {
            strategy,
            ordinal,
            pre_context_bytes,
            source_messages,
            source_bytes,
            source_sha256,
            outcome,
        } => DurableItemSnapshot::ContextCompaction {
            id: item.id.clone(),
            strategy: match strategy {
                sugarcode_protocol::CoreContextCompactionStrategy::ModelGeneratedActiveTurnV1 => {
                    "modelGeneratedActiveTurnV1".to_string()
                }
            },
            ordinal: *ordinal,
            pre_context_bytes: *pre_context_bytes,
            source_messages: *source_messages,
            source_bytes: *source_bytes,
            source_sha256: source_sha256.clone(),
            outcome: outcome.as_ref().map(durable_context_compaction_outcome),
            summary: None,
        },
        CoreItemKind::ToolCall {
            call_id,
            name,
            arguments,
        } => DurableItemSnapshot::ToolCall {
            id: item.id.clone(),
            call_id: call_id.clone(),
            name: name.clone(),
            arguments: arguments.clone(),
        },
        CoreItemKind::ToolValidationRejected {
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
        } => DurableItemSnapshot::ToolValidationRejected {
            id: item.id.clone(),
            call_id: call_id.clone(),
            name: name.clone(),
            kind: kind.to_string(),
            arguments_bytes: *arguments_bytes,
            arguments_sha256: arguments_sha256.clone(),
            edit_index: *edit_index,
            hunk_index: *hunk_index,
            line: *line,
            expected_summary: expected_summary.clone(),
            actual_summary: actual_summary.clone(),
            suggested_action: suggested_action.clone(),
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
        CoreItemKind::McpToolCall {
            call_id,
            name,
            arguments,
            arguments_bytes,
            arguments_sha256,
            inventory_sha256,
        } => DurableItemSnapshot::McpToolCall {
            id: item.id.clone(),
            call_id: call_id.clone(),
            name: name.clone(),
            arguments: arguments.clone(),
            arguments_bytes: *arguments_bytes,
            arguments_sha256: arguments_sha256.clone(),
            inventory_sha256: inventory_sha256.clone(),
        },
        CoreItemKind::McpToolCallApprovalRequest {
            approval_id,
            call_id,
            name,
            arguments,
            arguments_bytes,
            arguments_sha256,
            inventory_sha256,
        } => DurableItemSnapshot::McpToolCallApprovalRequest {
            id: item.id.clone(),
            approval_id: approval_id.clone(),
            call_id: call_id.clone(),
            name: name.clone(),
            arguments: arguments.clone(),
            arguments_bytes: *arguments_bytes,
            arguments_sha256: arguments_sha256.clone(),
            inventory_sha256: inventory_sha256.clone(),
        },
        CoreItemKind::McpToolCallApprovalDecision {
            approval_id,
            decision,
        } => DurableItemSnapshot::McpToolCallApprovalDecision {
            id: item.id.clone(),
            approval_id: approval_id.clone(),
            decision: decision.to_string(),
        },
        CoreItemKind::McpToolExecutionAttempt {
            approval_id,
            call_id,
            inventory_sha256,
        } => DurableItemSnapshot::McpToolExecutionAttempt {
            id: item.id.clone(),
            approval_id: approval_id.clone(),
            call_id: call_id.clone(),
            inventory_sha256: inventory_sha256.clone(),
        },
        CoreItemKind::McpToolResult {
            call_id,
            name,
            result,
        } => DurableItemSnapshot::McpToolResult {
            id: item.id.clone(),
            call_id: call_id.clone(),
            name: name.clone(),
            result: durable_mcp_tool_result(result),
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
        CoreItemKind::UserMessage { content } => ItemKind::UserMessage {
            content: content.clone(),
        },
        CoreItemKind::AgentMessage { text } => ItemKind::AgentMessage { text: text.clone() },
        CoreItemKind::AgentCommentary { text } => ItemKind::AgentCommentary { text: text.clone() },
        CoreItemKind::AgentTask {
            orchestration_id,
            task_id,
            client_task_key,
            child_thread_id,
            title,
            role,
            access,
            depends_on,
            task_markdown,
        } => ItemKind::AgentTask {
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
        CoreItemKind::AgentTaskAmendment {
            orchestration_id,
            task_id,
            amendment_markdown,
        } => ItemKind::AgentTaskAmendment {
            orchestration_id: orchestration_id.clone(),
            task_id: task_id.clone(),
            amendment_markdown: amendment_markdown.clone(),
        },
        CoreItemKind::AgentTaskResult {
            orchestration_id,
            task_id,
            status,
            summary_markdown,
            duration_ms,
        } => ItemKind::AgentTaskResult {
            orchestration_id: orchestration_id.clone(),
            task_id: task_id.clone(),
            status: status.clone(),
            summary_markdown: summary_markdown.clone(),
            duration_ms: *duration_ms,
        },
        CoreItemKind::ContextCompaction {
            strategy,
            ordinal,
            pre_context_bytes,
            source_messages,
            source_bytes,
            source_sha256,
            outcome,
        } => ItemKind::ContextCompaction {
            strategy: *strategy,
            ordinal: *ordinal,
            pre_context_bytes: *pre_context_bytes,
            source_messages: *source_messages,
            source_bytes: *source_bytes,
            source_sha256: source_sha256.clone(),
            outcome: outcome.clone(),
            summary: None,
        },
        CoreItemKind::ToolCall {
            call_id,
            name,
            arguments,
        } => ItemKind::ToolCall {
            call_id: call_id.clone(),
            name: name.clone(),
            arguments: arguments.clone(),
        },
        CoreItemKind::ToolValidationRejected {
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
        } => ItemKind::ToolValidationRejected {
            call_id: call_id.clone(),
            name: name.clone(),
            kind: *kind,
            arguments_bytes: *arguments_bytes,
            arguments_sha256: arguments_sha256.clone(),
            edit_index: *edit_index,
            hunk_index: *hunk_index,
            line: *line,
            expected_summary: expected_summary.clone(),
            actual_summary: actual_summary.clone(),
            suggested_action: suggested_action.clone(),
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
        CoreItemKind::McpToolCall {
            call_id,
            name,
            arguments,
            arguments_bytes,
            arguments_sha256,
            inventory_sha256,
        } => ItemKind::McpToolCall {
            call_id: call_id.clone(),
            name: name.clone(),
            arguments: arguments.clone(),
            arguments_bytes: *arguments_bytes,
            arguments_sha256: arguments_sha256.clone(),
            inventory_sha256: inventory_sha256.clone(),
        },
        CoreItemKind::McpToolCallApprovalRequest {
            approval_id,
            call_id,
            name,
            arguments,
            arguments_bytes,
            arguments_sha256,
            inventory_sha256,
        } => ItemKind::McpToolCallApprovalRequest {
            approval_id: approval_id.clone(),
            call_id: call_id.clone(),
            name: name.clone(),
            arguments: arguments.clone(),
            arguments_bytes: *arguments_bytes,
            arguments_sha256: arguments_sha256.clone(),
            inventory_sha256: inventory_sha256.clone(),
        },
        CoreItemKind::McpToolCallApprovalDecision {
            approval_id,
            decision,
        } => ItemKind::McpToolCallApprovalDecision {
            approval_id: approval_id.clone(),
            decision: *decision,
        },
        CoreItemKind::McpToolExecutionAttempt {
            approval_id,
            call_id,
            inventory_sha256,
        } => ItemKind::McpToolExecutionAttempt {
            approval_id: approval_id.clone(),
            call_id: call_id.clone(),
            inventory_sha256: inventory_sha256.clone(),
        },
        CoreItemKind::McpToolResult {
            call_id,
            name,
            result,
        } => ItemKind::McpToolResult {
            call_id: call_id.clone(),
            name: name.clone(),
            result: result.clone(),
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

fn durable_user_content_part(
    part: &sugarcode_protocol::CoreUserContentPart,
) -> sugarcode_state::DurableUserContentPart {
    match part {
        sugarcode_protocol::CoreUserContentPart::Text { text } => {
            sugarcode_state::DurableUserContentPart::Text { text: text.clone() }
        }
        sugarcode_protocol::CoreUserContentPart::Image { asset } => {
            sugarcode_state::DurableUserContentPart::Image {
                asset: durable_content_asset(asset),
            }
        }
        sugarcode_protocol::CoreUserContentPart::Document { asset } => {
            sugarcode_state::DurableUserContentPart::Document {
                asset: durable_content_asset(asset),
            }
        }
    }
}

fn durable_content_asset(
    asset: &sugarcode_protocol::CoreContentAsset,
) -> sugarcode_state::DurableContentAsset {
    sugarcode_state::DurableContentAsset {
        asset_id: asset.asset_id.clone(),
        sha256: asset.sha256.clone(),
        media_type: asset.media_type.clone(),
        original_name: asset.original_name.clone(),
        size_bytes: asset.size_bytes,
    }
}

fn durable_context_compaction_outcome(
    outcome: &sugarcode_protocol::CoreContextCompactionOutcome,
) -> sugarcode_state::DurableActiveTurnCompactionOutcome {
    match outcome {
        sugarcode_protocol::CoreContextCompactionOutcome::Completed {
            post_context_bytes,
            summary_bytes,
            summary_sha256,
        } => sugarcode_state::DurableActiveTurnCompactionOutcome::Completed {
            post_context_bytes: *post_context_bytes,
            summary_bytes: *summary_bytes,
            summary_sha256: summary_sha256.clone(),
        },
        sugarcode_protocol::CoreContextCompactionOutcome::Failed { kind } => {
            sugarcode_state::DurableActiveTurnCompactionOutcome::Failed { kind: kind.clone() }
        }
        sugarcode_protocol::CoreContextCompactionOutcome::Interrupted => {
            sugarcode_state::DurableActiveTurnCompactionOutcome::Interrupted
        }
    }
}

fn durable_mcp_tool_result(
    result: &sugarcode_protocol::CoreMcpToolResult,
) -> sugarcode_state::DurableMcpToolResult {
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
        } => sugarcode_state::DurableMcpToolResult::Completed {
            content: content.clone(),
            is_error: *is_error,
            observed_bytes: *observed_bytes,
            canonical_bytes: *canonical_bytes,
            retained_bytes: *retained_bytes,
            truncated: *truncated,
            sha256: sha256.clone(),
            content_blocks: *content_blocks,
            structured_content: *structured_content,
        },
        sugarcode_protocol::CoreMcpToolResult::Error {
            kind,
            request_state,
        } => sugarcode_state::DurableMcpToolResult::Error {
            kind: kind.clone(),
            request_state: request_state.clone(),
        },
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
        "invalidArguments" => CoreToolErrorKind::InvalidArguments,
        "unknownTool" => CoreToolErrorKind::UnknownTool,
        "batchRejected" => CoreToolErrorKind::BatchRejected,
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
        "headerCountMismatch" => CoreToolErrorKind::HeaderCountMismatch,
        "rangeOutOfBounds" => CoreToolErrorKind::RangeOutOfBounds,
        "expectedMismatch" => CoreToolErrorKind::ExpectedMismatch,
        "baseRevisionMismatch" => CoreToolErrorKind::BaseRevisionMismatch,
        "unsupportedDiffFeature" => CoreToolErrorKind::UnsupportedDiffFeature,
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
        title: thread.title.clone(),
        lifecycle: thread.lifecycle,
        origin: thread.origin.clone(),
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
                items: turn.items.values().map(durable_item_from_item).collect(),
                model: turn.model.clone(),
                context_compaction: turn.context_compaction.clone(),
                workspace_instructions: turn.workspace_instructions.clone(),
                workspace_skills: turn.workspace_skills.clone(),
                error: turn.error.clone(),
                usage: turn.usage.clone(),
            })
            .collect(),
    }
}

pub(super) fn map_repository_error(_error: RolloutError) -> CoreError {
    CoreError::StateUnavailable
}
