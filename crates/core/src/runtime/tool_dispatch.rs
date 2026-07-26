use super::*;

pub(super) fn workspace_tool_definitions(runtime: &CoreRuntime) -> Vec<ModelToolDefinition> {
    let mut definitions = Vec::with_capacity(3);
    if runtime.workspace_read.is_some() {
        definitions.push(ModelToolDefinition {
            name: "workspace/read".to_string(),
            description: "Read one UTF-8 text file inside the configured workspace.".to_string(),
            parameters: workspace_path_parameters(),
        });
    }
    if runtime.workspace_list.is_some() {
        definitions.push(ModelToolDefinition {
            name: "workspace/list".to_string(),
            description:
                "List one directory non-recursively inside the configured workspace. Use '.' for the workspace root."
                    .to_string(),
            parameters: workspace_path_parameters(),
        });
    }
    if runtime.workspace_search.is_some() {
        definitions.push(ModelToolDefinition {
            name: "workspace/search".to_string(),
            description:
                "Search UTF-8 text file contents recursively inside one workspace directory. Returns workspace-relative paths and 1-based line numbers."
                    .to_string(),
            parameters: workspace_search_parameters(),
        });
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
}

pub(super) fn workspace_tool_arguments(
    call: &ModelToolCall,
) -> Result<WorkspaceToolArguments, ModelError> {
    if !matches!(
        call.name.as_str(),
        "workspace/read" | "workspace/list" | "workspace/search"
    ) {
        return Err(ModelError::new(ModelErrorKind::UnsupportedOutput, false));
    }
    let Some(arguments) = call.arguments.as_object() else {
        return Err(ModelError::new(ModelErrorKind::Protocol, false));
    };
    let expected_len = if call.name == "workspace/search" {
        2
    } else {
        1
    };
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
    Ok(WorkspaceToolArguments { path, query })
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

pub(super) fn serialized_tool_call_bytes(
    call: &ModelToolCall,
    arguments: &WorkspaceToolArguments,
) -> usize {
    let mut value = serde_json::json!({
        "type": "toolCall",
        "callId": call.id,
        "name": call.name,
        "path": arguments.path,
    });
    if let Some(query) = &arguments.query {
        value
            .as_object_mut()
            .expect("tool call serialization value is an object")
            .insert(
                "query".to_string(),
                serde_json::Value::String(query.clone()),
            );
    }
    serde_json::to_vec(&value).map_or(usize::MAX, |bytes| bytes.len())
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
    };
    serde_json::to_vec(&value).map_or(usize::MAX, |bytes| bytes.len())
}

pub(super) async fn append_completed_tool_item(
    runtime: &CoreRuntime,
    prepared: &crate::PreparedTextTurn,
    kind: CoreItemKind,
) -> Option<CoreItemSnapshot> {
    let item = runtime
        .lock_core()
        .and_then(|mut core| {
            core.append_completed_item(&prepared.thread_id, &prepared.turn_id, kind)
        })
        .ok()?;
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
        return None;
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
        return None;
    }
    Some(item)
}
