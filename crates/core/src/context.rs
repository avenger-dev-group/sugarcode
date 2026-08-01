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
        PreparedMessage::UserContent { content } => content
            .iter()
            .map(|part| match part {
                sugarcode_protocol::CoreUserContentPart::Text { text } => text.len(),
                sugarcode_protocol::CoreUserContentPart::Image { asset }
                | sugarcode_protocol::CoreUserContentPart::Document { asset } => {
                    usize::try_from(asset.size_bytes).unwrap_or(usize::MAX)
                }
            })
            .fold(0usize, usize::saturating_add),
        PreparedMessage::Text { text, .. } => text.len(),
        PreparedMessage::Commentary { text } => text.len(),
        PreparedMessage::ContextCompaction { content } => content.len(),
        PreparedMessage::ToolCall {
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

#[cfg(test)]
#[path = "tests/context.rs"]
mod tests;
