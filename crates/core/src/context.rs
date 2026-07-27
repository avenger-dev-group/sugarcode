use crate::PreparedMessage;

pub const MAX_PROVIDER_CONTEXT_BYTES: usize = 4 * 1024 * 1024;
pub const COMPACTION_TARGET_BYTES: usize = 3 * 1024 * 1024;

pub(crate) fn prepared_message_bytes(message: &PreparedMessage) -> usize {
    match message {
        PreparedMessage::Text { text, .. } => text.len(),
        PreparedMessage::ContextCompaction { content } => content.len(),
        PreparedMessage::ToolCall {
            call_id,
            name,
            path,
            query,
            patch,
            command,
            arguments,
        } => serde_json::to_vec(&prepared_tool_arguments(
            path, query, patch, command, arguments,
        ))
        .ok()
        .and_then(|arguments| {
            call_id
                .len()
                .checked_add(name.len())
                .and_then(|total| total.checked_add(arguments.len()))
        })
        .unwrap_or(usize::MAX),
        PreparedMessage::ToolResult { call_id, content } => {
            call_id.len().saturating_add(content.len())
        }
    }
}

pub(crate) fn prepared_history_bytes(history: &[PreparedMessage]) -> Option<usize> {
    history
        .iter()
        .map(prepared_message_bytes)
        .try_fold(0usize, usize::checked_add)
}

pub(crate) fn prepared_tool_arguments(
    path: &str,
    query: &Option<String>,
    patch: &Option<String>,
    command: &Option<String>,
    arguments: &Option<Vec<String>>,
) -> serde_json::Value {
    match (command, arguments, query, patch) {
        (Some(command), Some(arguments), _, _) => serde_json::json!({
            "command": command,
            "arguments": arguments,
            "cwd": path,
        }),
        (_, _, Some(query), _) => serde_json::json!({ "path": path, "query": query }),
        (_, _, _, Some(patch)) => serde_json::json!({ "path": path, "patch": patch }),
        _ => serde_json::json!({ "path": path }),
    }
}
