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
        } => DurableItemSnapshot::ToolCall {
            id: item.id.clone(),
            call_id: call_id.clone(),
            name: name.clone(),
            path: path.clone(),
            query: query.clone(),
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
        } => ItemKind::ToolCall {
            call_id: call_id.clone(),
            name: name.clone(),
            path: path.clone(),
            query: query.clone(),
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
        "invalidName" => CoreToolErrorKind::InvalidName,
        "tooManyEntries" => CoreToolErrorKind::TooManyEntries,
        "changedDuringRead" => CoreToolErrorKind::ChangedDuringRead,
        "changedDuringList" => CoreToolErrorKind::ChangedDuringList,
        "searchLimitExceeded" => CoreToolErrorKind::SearchLimitExceeded,
        "searchTimedOut" => CoreToolErrorKind::SearchTimedOut,
        "changedDuringSearch" => CoreToolErrorKind::ChangedDuringSearch,
        "resultTooLarge" => CoreToolErrorKind::ResultTooLarge,
        _ => CoreToolErrorKind::Unavailable,
    }
}

pub(super) fn tool_result_content(name: &str, result: &CoreToolResult) -> String {
    match result {
        CoreToolResult::Success { content, .. } => content.clone(),
        CoreToolResult::Error { kind } => format!("{name} error: {kind}"),
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
