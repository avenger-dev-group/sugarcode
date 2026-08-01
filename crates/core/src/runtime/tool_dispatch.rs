use super::*;

pub(super) fn workspace_tool_definitions(runtime: &CoreRuntime) -> Vec<ModelToolDefinition> {
    let mut definitions = Vec::with_capacity(37);
    if runtime.workspace_read.is_some() {
        definitions.push(ModelToolDefinition {
            name: "workspace/read".to_string(),
            description: "Read one UTF-8 text file inside the active workspace scope.".to_string(),
            parameters: workspace_path_parameters(),
        });
    }
    if runtime.workspace_list.is_some() {
        definitions.push(ModelToolDefinition {
            name: "workspace/list".to_string(),
            description:
                "List one directory non-recursively inside the active workspace scope. Use '.' for the active workspace scope."
                    .to_string(),
            parameters: workspace_path_parameters(),
        });
    }
    if runtime.workspace_search.is_some() {
        definitions.push(ModelToolDefinition {
            name: "workspace/search".to_string(),
            description:
                "Search UTF-8 text file contents recursively inside one active workspace scope directory. Returns active-scope-relative paths and 1-based line numbers."
                    .to_string(),
            parameters: workspace_search_parameters(),
        });
    }
    if runtime.workspace_patch.is_some() {
        definitions.push(ModelToolDefinition {
            name: "workspace/apply-patch".to_string(),
            description:
                "Apply strict unified hunks to one existing UTF-8 regular file inside the active workspace scope. The write capability is explicit, bounded, conflict-checked, and not a sandbox or persistent permission."
                    .to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "path": { "type": "string" },
                    "patch": { "type": "string" }
                },
                "required": ["path", "patch"]
            }),
        });
    }
    if runtime.shell_executor.is_some() && runtime.approval_requester.is_some() {
        let description = if runtime
            .shell_executor
            .as_ref()
            .is_some_and(|executor| executor.sandbox_policy().workspace_write.is_some())
        {
            "Execute one exact absolute program and argv in the active workspace scope after per-command approval. This is not a shell. Filesystem reads and writes inside the active workspace scope are allowed, writes outside the active workspace scope are denied, and network access is denied."
        } else {
            "Execute one exact absolute program and argv in the active workspace scope after per-command approval. This is not a shell. Filesystem reads are allowed wherever the SugarCode process can read, filesystem writes are denied, and network access is denied."
        };
        definitions.push(ModelToolDefinition {
            name: "shell/exec".to_string(),
            description: description.to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "description": {
                        "type": "string",
                        "description": "A short plain-language explanation shown in the approval UI. Describe the user-visible action without executable paths, argv, cwd, or policy names."
                    },
                    "command": { "type": "string" },
                    "arguments": {
                        "type": "array",
                        "items": { "type": "string" }
                    },
                    "cwd": { "type": "string", "enum": ["."] }
                },
                "required": ["description", "command", "arguments", "cwd"]
            }),
        });
    }
    if runtime.mcp_capability.is_enabled()
        && let (Some(executor), Some(_)) = (
            runtime.mcp_executor.as_ref(),
            runtime.mcp_approval_requester.as_ref(),
        )
    {
        definitions.extend(executor.definitions());
    }
    definitions
}

fn workspace_path_parameters() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "path": { "type": "string" }
        },
        "required": ["path"]
    })
}

fn workspace_search_parameters() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "path": { "type": "string" },
            "query": { "type": "string" }
        },
        "required": ["path", "query"]
    })
}

pub(super) struct WorkspaceToolArguments {
    pub path: String,
    pub query: Option<String>,
    pub patch: Option<String>,
}

pub(super) struct ShellToolArguments {
    pub description: String,
    pub command: String,
    pub arguments: Vec<String>,
    pub cwd: String,
}

pub(super) fn shell_tool_arguments(call: &ModelToolCall) -> Result<ShellToolArguments, ModelError> {
    if call.name != "shell/exec" {
        return Err(ModelError::new(ModelErrorKind::UnsupportedOutput, false));
    }
    let Some(arguments) = call.arguments.as_object() else {
        return Err(ModelError::new(ModelErrorKind::Protocol, false));
    };
    if arguments.len() != 4 {
        return Err(ModelError::new(ModelErrorKind::InvalidRequest, false));
    }
    let description = arguments
        .get("description")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| ModelError::new(ModelErrorKind::InvalidRequest, false))?;
    let command = arguments
        .get("command")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| ModelError::new(ModelErrorKind::InvalidRequest, false))?;
    let values = arguments
        .get("arguments")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| ModelError::new(ModelErrorKind::InvalidRequest, false))?;
    let cwd = arguments
        .get("cwd")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| ModelError::new(ModelErrorKind::InvalidRequest, false))?;
    if description.is_empty()
        || description.len() > 512
        || invalid_command_text(description)
        || cwd != "."
        || command.is_empty()
        || command.len() > sugarcode_tools::MAX_SHELL_COMMAND_BYTES
        || !std::path::Path::new(command).is_absolute()
        || invalid_command_path(command)
        || invalid_command_text(command)
        || values.len() > sugarcode_tools::MAX_SHELL_ARGUMENT_COUNT
    {
        return Err(ModelError::new(ModelErrorKind::InvalidRequest, false));
    }
    let mut parsed = Vec::with_capacity(values.len());
    let mut total = command.len();
    for value in values {
        let value = value
            .as_str()
            .ok_or_else(|| ModelError::new(ModelErrorKind::InvalidRequest, false))?;
        total = total
            .checked_add(value.len())
            .ok_or_else(|| ModelError::new(ModelErrorKind::InvalidRequest, false))?;
        if value.len() > sugarcode_tools::MAX_SHELL_ARGUMENT_BYTES
            || invalid_command_text(value)
            || total > sugarcode_tools::MAX_SHELL_TOTAL_ARGUMENT_BYTES
        {
            return Err(ModelError::new(ModelErrorKind::InvalidRequest, false));
        }
        parsed.push(value.to_string());
    }
    Ok(ShellToolArguments {
        description: description.to_string(),
        command: command.to_string(),
        arguments: parsed,
        cwd: cwd.to_string(),
    })
}

fn invalid_command_text(value: &str) -> bool {
    value
        .chars()
        .any(|character| character == '\0' || character.is_control())
}

#[cfg(windows)]
fn invalid_command_path(value: &str) -> bool {
    value.starts_with(r"\\") || value.starts_with(r"\\?\") || value.starts_with(r"\\.\")
}

#[cfg(not(windows))]
fn invalid_command_path(_value: &str) -> bool {
    false
}

pub(super) fn workspace_tool_arguments(
    call: &ModelToolCall,
) -> Result<WorkspaceToolArguments, ModelError> {
    if !matches!(
        call.name.as_str(),
        "workspace/read" | "workspace/list" | "workspace/search" | "workspace/apply-patch"
    ) {
        return Err(ModelError::new(ModelErrorKind::UnsupportedOutput, false));
    }
    let Some(arguments) = call.arguments.as_object() else {
        return Err(ModelError::new(ModelErrorKind::Protocol, false));
    };
    let expected_len = usize::from(matches!(
        call.name.as_str(),
        "workspace/search" | "workspace/apply-patch"
    )) + 1;
    if arguments.len() != expected_len {
        return Err(ModelError::new(ModelErrorKind::InvalidRequest, false));
    }
    let path = arguments
        .get("path")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ModelError::new(ModelErrorKind::InvalidRequest, false))?;
    let query = if call.name == "workspace/search" {
        Some(
            arguments
                .get("query")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| ModelError::new(ModelErrorKind::InvalidRequest, false))?,
        )
    } else {
        None
    };
    let patch = if call.name == "workspace/apply-patch" {
        Some(
            arguments
                .get("patch")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| ModelError::new(ModelErrorKind::InvalidRequest, false))?,
        )
    } else {
        None
    };
    Ok(WorkspaceToolArguments { path, query, patch })
}

pub(super) fn map_workspace_read_outcome(
    outcome: WorkspaceReadOutcome,
) -> (CoreToolResult, String) {
    match outcome {
        WorkspaceReadOutcome::Content { content, bytes } => (
            CoreToolResult::Success {
                content: content.clone(),
                bytes: u64::try_from(bytes).unwrap_or(u64::MAX),
            },
            content,
        ),
        WorkspaceReadOutcome::Error { kind } => {
            let kind = match kind {
                WorkspaceReadErrorKind::InvalidPath => CoreToolErrorKind::InvalidPath,
                WorkspaceReadErrorKind::NotFound => CoreToolErrorKind::NotFound,
                WorkspaceReadErrorKind::AccessDenied => CoreToolErrorKind::AccessDenied,
                WorkspaceReadErrorKind::PathNotAllowed => CoreToolErrorKind::PathNotAllowed,
                WorkspaceReadErrorKind::NotRegularFile => CoreToolErrorKind::NotRegularFile,
                WorkspaceReadErrorKind::FileTooLarge => CoreToolErrorKind::FileTooLarge,
                WorkspaceReadErrorKind::BinaryFile => CoreToolErrorKind::BinaryFile,
                WorkspaceReadErrorKind::ChangedDuringRead => CoreToolErrorKind::ChangedDuringRead,
                WorkspaceReadErrorKind::Cancelled => CoreToolErrorKind::Unavailable,
                WorkspaceReadErrorKind::Unavailable => CoreToolErrorKind::Unavailable,
            };
            (
                CoreToolResult::Error { kind },
                format!("workspace/read error: {kind}"),
            )
        }
    }
}

pub(super) fn map_workspace_list_outcome(
    outcome: WorkspaceListOutcome,
) -> (CoreToolResult, String) {
    match outcome {
        WorkspaceListOutcome::Entries {
            entries,
            name_bytes: _,
        } => {
            let entries = entries
                .into_iter()
                .map(|entry| {
                    serde_json::json!({
                        "name": entry.name,
                        "kind": entry.kind.as_str(),
                    })
                })
                .collect::<Vec<_>>();
            let content = serde_json::to_string(&serde_json::json!({ "entries": entries }))
                .expect("workspace/list result must serialize");
            (
                CoreToolResult::Success {
                    bytes: u64::try_from(content.len()).unwrap_or(u64::MAX),
                    content: content.clone(),
                },
                content,
            )
        }
        WorkspaceListOutcome::Error { kind } => {
            let kind = match kind {
                WorkspaceListErrorKind::InvalidPath => CoreToolErrorKind::InvalidPath,
                WorkspaceListErrorKind::NotFound => CoreToolErrorKind::NotFound,
                WorkspaceListErrorKind::AccessDenied => CoreToolErrorKind::AccessDenied,
                WorkspaceListErrorKind::PathNotAllowed => CoreToolErrorKind::PathNotAllowed,
                WorkspaceListErrorKind::NotDirectory => CoreToolErrorKind::NotDirectory,
                WorkspaceListErrorKind::InvalidEncoding => CoreToolErrorKind::InvalidEncoding,
                WorkspaceListErrorKind::InvalidName => CoreToolErrorKind::InvalidName,
                WorkspaceListErrorKind::TooManyEntries => CoreToolErrorKind::TooManyEntries,
                WorkspaceListErrorKind::ChangedDuringList => CoreToolErrorKind::ChangedDuringList,
                WorkspaceListErrorKind::ResultTooLarge => CoreToolErrorKind::ResultTooLarge,
                WorkspaceListErrorKind::Cancelled => CoreToolErrorKind::Unavailable,
                WorkspaceListErrorKind::Unavailable => CoreToolErrorKind::Unavailable,
            };
            (
                CoreToolResult::Error { kind },
                format!("workspace/list error: {kind}"),
            )
        }
    }
}

pub(super) fn map_workspace_search_outcome(
    outcome: WorkspaceSearchOutcome,
) -> (CoreToolResult, String) {
    match outcome {
        WorkspaceSearchOutcome::Matches { matches, truncated } => {
            let matches = matches
                .into_iter()
                .map(|matched| {
                    serde_json::json!({
                        "path": matched.path,
                        "line": matched.line,
                    })
                })
                .collect::<Vec<_>>();
            let content = serde_json::to_string(&serde_json::json!({
                "matches": matches,
                "truncated": truncated,
            }))
            .expect("workspace/search result must serialize");
            (
                CoreToolResult::Success {
                    bytes: u64::try_from(content.len()).unwrap_or(u64::MAX),
                    content: content.clone(),
                },
                content,
            )
        }
        WorkspaceSearchOutcome::Error { kind } => {
            let kind = match kind {
                WorkspaceSearchErrorKind::InvalidPath => CoreToolErrorKind::InvalidPath,
                WorkspaceSearchErrorKind::InvalidQuery => CoreToolErrorKind::InvalidQuery,
                WorkspaceSearchErrorKind::NotFound => CoreToolErrorKind::NotFound,
                WorkspaceSearchErrorKind::AccessDenied => CoreToolErrorKind::AccessDenied,
                WorkspaceSearchErrorKind::PathNotAllowed => CoreToolErrorKind::PathNotAllowed,
                WorkspaceSearchErrorKind::NotDirectory => CoreToolErrorKind::NotDirectory,
                WorkspaceSearchErrorKind::InvalidEncoding => CoreToolErrorKind::InvalidEncoding,
                WorkspaceSearchErrorKind::InvalidName => CoreToolErrorKind::InvalidName,
                WorkspaceSearchErrorKind::TooManyEntries => CoreToolErrorKind::TooManyEntries,
                WorkspaceSearchErrorKind::SearchLimitExceeded => {
                    CoreToolErrorKind::SearchLimitExceeded
                }
                WorkspaceSearchErrorKind::SearchTimedOut => CoreToolErrorKind::SearchTimedOut,
                WorkspaceSearchErrorKind::ChangedDuringSearch => {
                    CoreToolErrorKind::ChangedDuringSearch
                }
                WorkspaceSearchErrorKind::ResultTooLarge => CoreToolErrorKind::ResultTooLarge,
                WorkspaceSearchErrorKind::Cancelled => CoreToolErrorKind::Unavailable,
                WorkspaceSearchErrorKind::Unavailable => CoreToolErrorKind::Unavailable,
            };
            (
                CoreToolResult::Error { kind },
                format!("workspace/search error: {kind}"),
            )
        }
    }
}

pub(super) fn map_workspace_patch_error(kind: WorkspacePatchErrorKind) -> CoreToolErrorKind {
    match kind {
        WorkspacePatchErrorKind::InvalidPath => CoreToolErrorKind::InvalidPath,
        WorkspacePatchErrorKind::NotFound => CoreToolErrorKind::NotFound,
        WorkspacePatchErrorKind::AccessDenied => CoreToolErrorKind::AccessDenied,
        WorkspacePatchErrorKind::PathNotAllowed => CoreToolErrorKind::PathNotAllowed,
        WorkspacePatchErrorKind::NotRegularFile => CoreToolErrorKind::NotRegularFile,
        WorkspacePatchErrorKind::FileTooLarge => CoreToolErrorKind::FileTooLarge,
        WorkspacePatchErrorKind::BinaryFile => CoreToolErrorKind::BinaryFile,
        WorkspacePatchErrorKind::InvalidEncoding => CoreToolErrorKind::InvalidEncoding,
        WorkspacePatchErrorKind::InvalidNewline => CoreToolErrorKind::InvalidNewline,
        WorkspacePatchErrorKind::InvalidPatch => CoreToolErrorKind::InvalidPatch,
        WorkspacePatchErrorKind::PatchDoesNotApply => CoreToolErrorKind::PatchDoesNotApply,
        WorkspacePatchErrorKind::TooManyLines => CoreToolErrorKind::TooManyLines,
        WorkspacePatchErrorKind::LineTooLong => CoreToolErrorKind::LineTooLong,
        WorkspacePatchErrorKind::ResultTooLarge => CoreToolErrorKind::ResultTooLarge,
        WorkspacePatchErrorKind::HardLinkNotAllowed => CoreToolErrorKind::HardLinkNotAllowed,
        WorkspacePatchErrorKind::CrossDeviceNotAllowed => CoreToolErrorKind::CrossDeviceNotAllowed,
        WorkspacePatchErrorKind::Conflict => CoreToolErrorKind::Conflict,
        WorkspacePatchErrorKind::AtomicReplaceUnavailable => {
            CoreToolErrorKind::AtomicReplaceUnavailable
        }
        WorkspacePatchErrorKind::Cancelled | WorkspacePatchErrorKind::Unavailable => {
            CoreToolErrorKind::Unavailable
        }
    }
}

pub(super) fn serialized_file_change_bytes(kind: &CoreItemKind) -> usize {
    let CoreItemKind::FileChange {
        call_id,
        path,
        diff,
        before_sha256,
        after_sha256,
        before_bytes,
        after_bytes,
        newline_style,
        final_newline,
        ..
    } = kind
    else {
        return usize::MAX;
    };
    serde_json::to_vec(&serde_json::json!({
        "type": "fileChange",
        "callId": call_id,
        "path": path,
        "kind": "update",
        "diff": diff,
        "beforeSha256": before_sha256,
        "afterSha256": after_sha256,
        "beforeBytes": before_bytes,
        "afterBytes": after_bytes,
        "newlineStyle": match newline_style {
            sugarcode_protocol::CoreFileChangeNewlineStyle::Lf => "lf",
            sugarcode_protocol::CoreFileChangeNewlineStyle::CrLf => "crLf",
        },
        "finalNewline": final_newline,
    }))
    .map_or(usize::MAX, |bytes| bytes.len())
}

pub(super) fn serialized_tool_result_bytes(result: &CoreToolResult) -> usize {
    let value = match result {
        CoreToolResult::Success { content, bytes } => serde_json::json!({
            "type": "success",
            "content": content,
            "bytes": bytes,
        }),
        CoreToolResult::Error { kind } => serde_json::json!({
            "type": "error",
            "kind": kind.to_string(),
        }),
        CoreToolResult::Process(process) => serde_json::json!({
            "type": "process",
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
        }),
    };
    serde_json::to_vec(&value).map_or(usize::MAX, |bytes| bytes.len())
}

pub(super) async fn append_completed_tool_item(
    runtime: &CoreRuntime,
    prepared: &crate::PreparedTextTurn,
    kind: CoreItemKind,
) -> Result<CoreItemSnapshot, Terminal> {
    let item = runtime
        .lock_core()
        .and_then(|mut core| {
            core.append_completed_item(&prepared.thread_id, &prepared.turn_id, kind)
        })
        .map_err(terminal_for_item_append)?;
    let durable_event = CancellationToken::new();
    if !send_event(
        runtime,
        &durable_event,
        prepared.request_id,
        CoreEventKind::ItemStarted {
            thread_id: prepared.thread_id.clone(),
            turn_id: prepared.turn_id.clone(),
            item: item.clone(),
        },
    )
    .await
    {
        return Err(Terminal::Interrupted);
    }
    if !send_event(
        runtime,
        &durable_event,
        prepared.request_id,
        CoreEventKind::ItemCompleted {
            thread_id: prepared.thread_id.clone(),
            turn_id: prepared.turn_id.clone(),
            item: item.clone(),
        },
    )
    .await
    {
        return Err(Terminal::Interrupted);
    }
    Ok(item)
}

pub(super) async fn append_completed_agent_output_item(
    runtime: &CoreRuntime,
    prepared: &crate::PreparedTextTurn,
    output: CoreAgentOutputRef,
    kind: CoreItemKind,
) -> Result<CoreItemSnapshot, Terminal> {
    let item = runtime
        .lock_core()
        .and_then(|mut core| {
            core.append_completed_item(&prepared.thread_id, &prepared.turn_id, kind)
        })
        .map_err(terminal_for_item_append)?;
    let durable_event = CancellationToken::new();
    if !send_event(
        runtime,
        &durable_event,
        prepared.request_id,
        CoreEventKind::AgentOutputResolved {
            thread_id: prepared.thread_id.clone(),
            turn_id: prepared.turn_id.clone(),
            output,
            item: item.clone(),
        },
    )
    .await
    {
        return Err(Terminal::Interrupted);
    }
    if !send_event(
        runtime,
        &durable_event,
        prepared.request_id,
        CoreEventKind::ItemCompleted {
            thread_id: prepared.thread_id.clone(),
            turn_id: prepared.turn_id.clone(),
            item: item.clone(),
        },
    )
    .await
    {
        return Err(Terminal::Interrupted);
    }
    Ok(item)
}

fn terminal_for_item_append(error: CoreError) -> Terminal {
    match error {
        CoreError::ContextTooLarge | CoreError::OutputTooLarge => {
            Terminal::Failed(output_too_large_error())
        }
        CoreError::ThreadIdExhausted
        | CoreError::TurnIdExhausted
        | CoreError::ItemIdExhausted
        | CoreError::ThreadNotFound(_)
        | CoreError::NoActiveTurn(_)
        | CoreError::TurnAlreadyActive { .. }
        | CoreError::TurnNotInProgress(_)
        | CoreError::ItemNotInProgress(_)
        | CoreError::InvalidInput
        | CoreError::ModelUnavailable
        | CoreError::StateUnavailable
        | CoreError::Internal(_) => Terminal::StateUnavailable,
    }
}
