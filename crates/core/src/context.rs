use crate::PreparedMessage;

pub const MAX_PROVIDER_CONTEXT_BYTES: usize = 4 * 1024 * 1024;
pub const DEFAULT_PROVIDER_CONTEXT_TOKENS: usize = 128 * 1024;
pub const PROVIDER_OUTPUT_RESERVE_TOKENS: usize = 16 * 1024;
const CONSERVATIVE_UTF8_BYTES_PER_TOKEN: usize = 3;
// OpenAI-compatible endpoints do not expose one portable tokenizer or context
// metadata contract. Use a conservative provider-neutral estimate and compact
// before the 128K window so the model retains a 16K response allowance.
pub const COMPACTION_TARGET_BYTES: usize = (DEFAULT_PROVIDER_CONTEXT_TOKENS
    - PROVIDER_OUTPUT_RESERVE_TOKENS)
    * CONSERVATIVE_UTF8_BYTES_PER_TOKEN;

pub(crate) fn prepared_message_bytes(message: &PreparedMessage) -> usize {
    match message {
        PreparedMessage::Text { text, .. } => text.len(),
        PreparedMessage::Commentary { text } => text.len(),
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
        PreparedMessage::McpToolCall {
            call_id,
            name,
            arguments,
        } => serde_json::to_vec(arguments)
            .ok()
            .and_then(|arguments| {
                call_id
                    .len()
                    .checked_add(name.len())
                    .and_then(|total| total.checked_add(arguments.len()))
            })
            .unwrap_or(usize::MAX),
        PreparedMessage::McpToolResult { call_id, content } => {
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

#[cfg(test)]
#[path = "tests/context.rs"]
mod tests;
