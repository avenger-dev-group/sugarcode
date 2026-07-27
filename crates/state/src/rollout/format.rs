use super::CURRENT_ROLLOUT_SCHEMA_VERSION;
use super::DurableItemSnapshot;
use super::DurableThreadSnapshot;
use super::DurableToolResult;
use super::DurableTurnError;
use super::DurableTurnErrorKind;
use super::DurableTurnSnapshot;
use super::DurableTurnStatus;
use super::DurableUsage;
use super::RolloutDiagnostic;
use super::RolloutError;
use serde::Deserialize;
use serde::Serialize;
use sugarcode_protocol::ItemId;
use sugarcode_protocol::ThreadId;
use sugarcode_protocol::TurnId;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThreadCreatedRecord<'a> {
    pub schema_version: u32,
    pub sequence: u64,
    #[serde(rename = "type")]
    pub record_type: &'static str,
    pub thread_id: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TurnCompletedRecord<'a> {
    pub schema_version: u32,
    pub sequence: u64,
    #[serde(rename = "type")]
    pub record_type: &'static str,
    pub thread_id: &'a str,
    pub turn: StoredTurnRef<'a>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TurnStartedRecord<'a> {
    pub schema_version: u32,
    pub sequence: u64,
    #[serde(rename = "type")]
    pub record_type: &'static str,
    pub thread_id: &'a str,
    pub turn: StoredTurnRef<'a>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TurnItemAddedRecord<'a> {
    pub schema_version: u32,
    pub sequence: u64,
    #[serde(rename = "type")]
    pub record_type: &'static str,
    pub thread_id: &'a str,
    pub turn_id: &'a str,
    pub item: StoredItemRef<'a>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThreadArchivedRecord<'a> {
    pub schema_version: u32,
    pub sequence: u64,
    #[serde(rename = "type")]
    pub record_type: &'static str,
    pub thread_id: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThreadUnarchivedRecord<'a> {
    pub schema_version: u32,
    pub sequence: u64,
    #[serde(rename = "type")]
    pub record_type: &'static str,
    pub thread_id: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThreadDeletedRecord<'a> {
    pub schema_version: u32,
    pub sequence: u64,
    #[serde(rename = "type")]
    pub record_type: &'static str,
    pub thread_id: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoredTurnRef<'a> {
    pub id: &'a str,
    pub status: &'static str,
    pub items: Vec<StoredItemRef<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<StoredTurnErrorRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<StoredUsageRef>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(super) enum StoredItemRef<'a> {
    UserMessage {
        id: &'a str,
        text: &'a str,
    },
    AgentMessage {
        id: &'a str,
        text: &'a str,
    },
    ToolCall {
        id: &'a str,
        call_id: &'a str,
        name: &'a str,
        path: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        query: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        patch: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        command: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        arguments: Option<&'a [String]>,
    },
    FileChange {
        id: &'a str,
        call_id: &'a str,
        path: &'a str,
        kind: &'a str,
        diff: &'a str,
        before_sha256: &'a str,
        after_sha256: &'a str,
        before_bytes: u64,
        after_bytes: u64,
        newline_style: &'a str,
        final_newline: bool,
    },
    CommandApprovalRequest {
        id: &'a str,
        approval_id: &'a str,
        call_id: &'a str,
        command: &'a str,
        arguments: &'a [String],
        cwd: &'a str,
        environment_policy: &'a str,
        sandboxed: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        sandbox_policy: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace_write_policy: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace_write_risk: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        network_policy: Option<&'a str>,
    },
    CommandApprovalDecision {
        id: &'a str,
        approval_id: &'a str,
        decision: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace_write_risk_acknowledgement: Option<&'a str>,
    },
    CommandExecutionAttempt {
        id: &'a str,
        approval_id: &'a str,
        call_id: &'a str,
    },
    ToolResult {
        id: &'a str,
        call_id: &'a str,
        name: &'a str,
        result: StoredToolResultRef<'a>,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(super) enum StoredToolResultRef<'a> {
    Success {
        content: &'a str,
        bytes: u64,
    },
    Error {
        kind: &'a str,
    },
    Process {
        stdout: &'a str,
        stderr: &'a str,
        stdout_bytes: u64,
        stderr_bytes: u64,
        stdout_truncated: bool,
        stderr_truncated: bool,
        encoding: &'a str,
        duration_ms: u64,
        outcome: StoredProcessOutcomeRef,
        #[serde(skip_serializing_if = "Option::is_none")]
        sandbox_policy: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace_write_policy: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        network_policy: Option<&'a str>,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(super) enum StoredProcessOutcomeRef {
    ExitCode { code: i64 },
    Signal { signal: i32 },
    TimedOut,
}

impl<'a> From<&'a DurableItemSnapshot> for StoredItemRef<'a> {
    fn from(item: &'a DurableItemSnapshot) -> Self {
        match item {
            DurableItemSnapshot::UserMessage { id, text } => Self::UserMessage {
                id: id.as_str(),
                text,
            },
            DurableItemSnapshot::AgentMessage { id, text } => Self::AgentMessage {
                id: id.as_str(),
                text,
            },
            DurableItemSnapshot::ToolCall {
                id,
                call_id,
                name,
                path,
                query,
                patch,
                command,
                arguments,
            } => Self::ToolCall {
                id: id.as_str(),
                call_id,
                name,
                path,
                query: query.as_deref(),
                patch: patch.as_deref(),
                command: command.as_deref(),
                arguments: arguments.as_deref(),
            },
            DurableItemSnapshot::FileChange {
                id,
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
            } => Self::FileChange {
                id: id.as_str(),
                call_id,
                path,
                kind,
                diff,
                before_sha256,
                after_sha256,
                before_bytes: *before_bytes,
                after_bytes: *after_bytes,
                newline_style,
                final_newline: *final_newline,
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
            } => Self::CommandApprovalRequest {
                id: id.as_str(),
                approval_id,
                call_id,
                command,
                arguments,
                cwd,
                environment_policy,
                sandboxed: *sandboxed,
                sandbox_policy: sandbox_policy.as_deref(),
                workspace_write_policy: workspace_write_policy.as_deref(),
                workspace_write_risk: workspace_write_risk.as_deref(),
                network_policy: network_policy.as_deref(),
            },
            DurableItemSnapshot::CommandApprovalDecision {
                id,
                approval_id,
                decision,
                workspace_write_risk_acknowledgement,
            } => Self::CommandApprovalDecision {
                id: id.as_str(),
                approval_id,
                decision,
                workspace_write_risk_acknowledgement: workspace_write_risk_acknowledgement
                    .as_deref(),
            },
            DurableItemSnapshot::CommandExecutionAttempt {
                id,
                approval_id,
                call_id,
            } => Self::CommandExecutionAttempt {
                id: id.as_str(),
                approval_id,
                call_id,
            },
            DurableItemSnapshot::ToolResult {
                id,
                call_id,
                name,
                result,
            } => Self::ToolResult {
                id: id.as_str(),
                call_id,
                name,
                result: match result {
                    DurableToolResult::Success { content, bytes } => StoredToolResultRef::Success {
                        content,
                        bytes: *bytes,
                    },
                    DurableToolResult::Error { kind } => StoredToolResultRef::Error { kind },
                    DurableToolResult::Process(process) => StoredToolResultRef::Process {
                        stdout: &process.stdout,
                        stderr: &process.stderr,
                        stdout_bytes: process.stdout_bytes,
                        stderr_bytes: process.stderr_bytes,
                        stdout_truncated: process.stdout_truncated,
                        stderr_truncated: process.stderr_truncated,
                        encoding: &process.encoding,
                        duration_ms: process.duration_ms,
                        outcome: match process.outcome {
                            super::DurableProcessOutcome::ExitCode { code } => {
                                StoredProcessOutcomeRef::ExitCode { code }
                            }
                            super::DurableProcessOutcome::Signal { signal } => {
                                StoredProcessOutcomeRef::Signal { signal }
                            }
                            super::DurableProcessOutcome::TimedOut => {
                                StoredProcessOutcomeRef::TimedOut
                            }
                        },
                        sandbox_policy: process.sandbox_policy.as_deref(),
                        workspace_write_policy: process.workspace_write_policy.as_deref(),
                        network_policy: process.network_policy.as_deref(),
                    },
                },
            },
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoredTurnErrorRef {
    pub kind: &'static str,
    pub retryable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoredUsageRef {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
}

impl<'a> From<&'a DurableTurnSnapshot> for StoredTurnRef<'a> {
    fn from(turn: &'a DurableTurnSnapshot) -> Self {
        Self {
            id: turn.id.as_str(),
            status: match turn.status {
                DurableTurnStatus::InProgress => "inProgress",
                DurableTurnStatus::Completed => "completed",
                DurableTurnStatus::Failed => "failed",
                DurableTurnStatus::Interrupted => "interrupted",
            },
            items: turn.items.iter().map(StoredItemRef::from).collect(),
            error: turn.error.as_ref().map(|error| StoredTurnErrorRef {
                kind: stored_error_kind(error.kind),
                retryable: error.retryable,
            }),
            usage: turn.usage.as_ref().map(|usage| StoredUsageRef {
                input_tokens: usage.input_tokens,
                cached_input_tokens: usage.cached_input_tokens,
                output_tokens: usage.output_tokens,
                reasoning_tokens: usage.reasoning_tokens,
                total_tokens: usage.total_tokens,
            }),
        }
    }
}

fn stored_error_kind(kind: DurableTurnErrorKind) -> &'static str {
    match kind {
        DurableTurnErrorKind::Authentication => "authentication",
        DurableTurnErrorKind::InvalidRequest => "invalidRequest",
        DurableTurnErrorKind::RateLimited => "rateLimited",
        DurableTurnErrorKind::Timeout => "timeout",
        DurableTurnErrorKind::Transport => "transport",
        DurableTurnErrorKind::Disconnected => "disconnected",
        DurableTurnErrorKind::Server => "server",
        DurableTurnErrorKind::Protocol => "protocol",
        DurableTurnErrorKind::Incomplete => "incomplete",
        DurableTurnErrorKind::Filtered => "filtered",
        DurableTurnErrorKind::UnsupportedOutput => "unsupportedOutput",
        DurableTurnErrorKind::OutputTooLarge => "outputTooLarge",
        DurableTurnErrorKind::StateUnavailable => "stateUnavailable",
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredThreadCreated {
    schema_version: u32,
    sequence: u64,
    #[serde(rename = "type")]
    record_type: ThreadCreatedType,
    thread_id: String,
}

#[derive(Debug, Deserialize)]
enum ThreadCreatedType {
    #[serde(rename = "threadCreated")]
    ThreadCreated,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredTurnCompleted {
    schema_version: u32,
    sequence: u64,
    #[serde(rename = "type")]
    record_type: TurnCompletedType,
    thread_id: String,
    turn: StoredTurn,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredTurnStarted {
    schema_version: u32,
    sequence: u64,
    #[serde(rename = "type")]
    record_type: TurnStartedType,
    thread_id: String,
    turn: StoredTurn,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredTurnItemAdded {
    schema_version: u32,
    sequence: u64,
    #[serde(rename = "type")]
    record_type: TurnItemAddedType,
    thread_id: String,
    turn_id: String,
    item: StoredItem,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredThreadArchived {
    schema_version: u32,
    sequence: u64,
    #[serde(rename = "type")]
    record_type: ThreadArchivedType,
    thread_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredThreadUnarchived {
    schema_version: u32,
    sequence: u64,
    #[serde(rename = "type")]
    record_type: ThreadUnarchivedType,
    thread_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredThreadDeleted {
    schema_version: u32,
    sequence: u64,
    #[serde(rename = "type")]
    record_type: ThreadDeletedType,
    thread_id: String,
}

#[derive(Debug, Deserialize)]
enum TurnCompletedType {
    #[serde(rename = "turnCompleted")]
    TurnCompleted,
}

#[derive(Debug, Deserialize)]
enum TurnStartedType {
    #[serde(rename = "turnStarted")]
    TurnStarted,
}

#[derive(Debug, Deserialize)]
enum TurnItemAddedType {
    #[serde(rename = "turnItemAdded")]
    TurnItemAdded,
}

#[derive(Debug, Deserialize)]
enum ThreadArchivedType {
    #[serde(rename = "threadArchived")]
    ThreadArchived,
}

#[derive(Debug, Deserialize)]
enum ThreadUnarchivedType {
    #[serde(rename = "threadUnarchived")]
    ThreadUnarchived,
}

#[derive(Debug, Deserialize)]
enum ThreadDeletedType {
    #[serde(rename = "threadDeleted")]
    ThreadDeleted,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredTurn {
    id: String,
    status: StoredTurnStatus,
    items: Vec<StoredItem>,
    #[serde(default)]
    error: Option<StoredTurnError>,
    #[serde(default)]
    usage: Option<StoredUsage>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum StoredTurnStatus {
    InProgress,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum StoredItem {
    UserMessage {
        id: String,
        text: String,
    },
    AgentMessage {
        id: String,
        text: String,
    },
    ToolCall {
        id: String,
        call_id: String,
        name: String,
        path: String,
        #[serde(default)]
        query: Option<String>,
        #[serde(default)]
        patch: Option<String>,
        #[serde(default)]
        command: Option<String>,
        #[serde(default)]
        arguments: Option<Vec<String>>,
    },
    FileChange {
        id: String,
        call_id: String,
        path: String,
        kind: String,
        diff: String,
        before_sha256: String,
        after_sha256: String,
        before_bytes: u64,
        after_bytes: u64,
        newline_style: String,
        final_newline: bool,
    },
    CommandApprovalRequest {
        id: String,
        approval_id: String,
        call_id: String,
        command: String,
        arguments: Vec<String>,
        cwd: String,
        environment_policy: String,
        sandboxed: bool,
        #[serde(default)]
        sandbox_policy: Option<String>,
        #[serde(default)]
        workspace_write_policy: Option<String>,
        #[serde(default)]
        workspace_write_risk: Option<String>,
        #[serde(default)]
        network_policy: Option<String>,
    },
    CommandApprovalDecision {
        id: String,
        approval_id: String,
        decision: String,
        #[serde(default)]
        workspace_write_risk_acknowledgement: Option<String>,
    },
    CommandExecutionAttempt {
        id: String,
        approval_id: String,
        call_id: String,
    },
    ToolResult {
        id: String,
        call_id: String,
        name: String,
        result: StoredToolResult,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum StoredToolResult {
    Success {
        content: String,
        bytes: u64,
    },
    Error {
        kind: String,
    },
    Process {
        stdout: String,
        stderr: String,
        stdout_bytes: u64,
        stderr_bytes: u64,
        stdout_truncated: bool,
        stderr_truncated: bool,
        encoding: String,
        duration_ms: u64,
        outcome: StoredProcessOutcome,
        #[serde(default)]
        sandbox_policy: Option<String>,
        #[serde(default)]
        workspace_write_policy: Option<String>,
        #[serde(default)]
        network_policy: Option<String>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum StoredProcessOutcome {
    ExitCode { code: i64 },
    Signal { signal: i32 },
    TimedOut,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredTurnError {
    kind: StoredTurnErrorKind,
    retryable: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum StoredTurnErrorKind {
    Authentication,
    InvalidRequest,
    RateLimited,
    Timeout,
    Transport,
    Disconnected,
    Server,
    Protocol,
    Incomplete,
    Filtered,
    UnsupportedOutput,
    OutputTooLarge,
    StateUnavailable,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredUsage {
    #[serde(default)]
    input_tokens: Option<u64>,
    #[serde(default)]
    cached_input_tokens: Option<u64>,
    #[serde(default)]
    output_tokens: Option<u64>,
    #[serde(default)]
    reasoning_tokens: Option<u64>,
    #[serde(default)]
    total_tokens: Option<u64>,
}

pub(super) enum DecodedRecord {
    ThreadCreated {
        sequence: u64,
        thread_id: ThreadId,
    },
    TurnStarted {
        sequence: u64,
        thread_id: ThreadId,
        turn: DurableTurnSnapshot,
    },
    TurnItemAdded {
        sequence: u64,
        thread_id: ThreadId,
        turn_id: TurnId,
        item: DurableItemSnapshot,
    },
    TurnCompleted {
        sequence: u64,
        thread_id: ThreadId,
        turn: DurableTurnSnapshot,
    },
    ThreadArchived {
        sequence: u64,
        thread_id: ThreadId,
    },
    ThreadUnarchived {
        sequence: u64,
        thread_id: ThreadId,
    },
    ThreadDeleted {
        sequence: u64,
        thread_id: ThreadId,
    },
}

impl DecodedRecord {
    pub fn sequence(&self) -> u64 {
        match self {
            Self::ThreadCreated { sequence, .. }
            | Self::TurnStarted { sequence, .. }
            | Self::TurnItemAdded { sequence, .. }
            | Self::TurnCompleted { sequence, .. }
            | Self::ThreadArchived { sequence, .. }
            | Self::ThreadUnarchived { sequence, .. }
            | Self::ThreadDeleted { sequence, .. } => *sequence,
        }
    }
}

pub(super) fn decode_record(
    bytes: &[u8],
    path: &std::path::Path,
    offset: u64,
) -> Result<DecodedRecord, RolloutError> {
    let text = std::str::from_utf8(bytes).map_err(|_| {
        RolloutError::Corrupt(RolloutDiagnostic {
            path: path.to_path_buf(),
            offset,
            kind: "invalidUtf8",
        })
    })?;
    let value = serde_json::from_str::<serde_json::Value>(text).map_err(|_| {
        RolloutError::Corrupt(RolloutDiagnostic {
            path: path.to_path_buf(),
            offset,
            kind: "invalidJson",
        })
    })?;
    let object = value.as_object().ok_or_else(|| {
        RolloutError::Corrupt(RolloutDiagnostic {
            path: path.to_path_buf(),
            offset,
            kind: "invalidRecordShape",
        })
    })?;
    let version = object.get("schemaVersion").and_then(|value| value.as_u64());
    if version != Some(u64::from(CURRENT_ROLLOUT_SCHEMA_VERSION)) {
        return Err(RolloutError::Corrupt(RolloutDiagnostic {
            path: path.to_path_buf(),
            offset,
            kind: "unsupportedSchemaVersion",
        }));
    }
    let Some(record_type) = object.get("type").and_then(|value| value.as_str()) else {
        return Err(RolloutError::Corrupt(RolloutDiagnostic {
            path: path.to_path_buf(),
            offset,
            kind: "invalidRecordShape",
        }));
    };
    if !matches!(
        record_type,
        "threadCreated"
            | "turnStarted"
            | "turnItemAdded"
            | "turnCompleted"
            | "threadArchived"
            | "threadUnarchived"
            | "threadDeleted"
    ) {
        return Err(RolloutError::Corrupt(RolloutDiagnostic {
            path: path.to_path_buf(),
            offset,
            kind: "unknownRecordType",
        }));
    }
    match record_type {
        "threadCreated" => {
            let record = serde_json::from_value::<StoredThreadCreated>(value).map_err(|_| {
                RolloutError::Corrupt(RolloutDiagnostic {
                    path: path.to_path_buf(),
                    offset,
                    kind: "invalidRecordShape",
                })
            })?;
            let StoredThreadCreated {
                schema_version,
                sequence,
                thread_id,
                record_type: ThreadCreatedType::ThreadCreated,
            } = record;
            debug_assert_eq!(schema_version, CURRENT_ROLLOUT_SCHEMA_VERSION);
            Ok(DecodedRecord::ThreadCreated {
                sequence,
                thread_id: ThreadId::new(thread_id),
            })
        }
        "turnCompleted" => {
            let record = serde_json::from_value::<StoredTurnCompleted>(value).map_err(|_| {
                RolloutError::Corrupt(RolloutDiagnostic {
                    path: path.to_path_buf(),
                    offset,
                    kind: "invalidRecordShape",
                })
            })?;
            let StoredTurnCompleted {
                schema_version,
                sequence,
                thread_id,
                turn,
                record_type: TurnCompletedType::TurnCompleted,
            } = record;
            debug_assert_eq!(schema_version, CURRENT_ROLLOUT_SCHEMA_VERSION);
            let StoredTurn {
                id,
                status,
                items,
                error,
                usage,
            } = turn;
            let status = match status {
                StoredTurnStatus::Completed => DurableTurnStatus::Completed,
                StoredTurnStatus::Failed => DurableTurnStatus::Failed,
                StoredTurnStatus::Interrupted => DurableTurnStatus::Interrupted,
                StoredTurnStatus::InProgress => {
                    return Err(RolloutError::Corrupt(RolloutDiagnostic {
                        path: path.to_path_buf(),
                        offset,
                        kind: "invalidTerminalTurnStatus",
                    }));
                }
            };
            Ok(DecodedRecord::TurnCompleted {
                sequence,
                thread_id: ThreadId::new(thread_id),
                turn: DurableTurnSnapshot {
                    id: TurnId::new(id),
                    status,
                    items: decode_items(items),
                    error: error.map(decode_error),
                    usage: usage.map(decode_usage),
                },
            })
        }
        "turnStarted" => {
            let record = serde_json::from_value::<StoredTurnStarted>(value).map_err(|_| {
                RolloutError::Corrupt(RolloutDiagnostic {
                    path: path.to_path_buf(),
                    offset,
                    kind: "invalidRecordShape",
                })
            })?;
            let StoredTurnStarted {
                schema_version,
                sequence,
                thread_id,
                turn,
                record_type: TurnStartedType::TurnStarted,
            } = record;
            debug_assert_eq!(schema_version, CURRENT_ROLLOUT_SCHEMA_VERSION);
            let StoredTurn {
                id,
                status,
                items,
                error,
                usage,
            } = turn;
            if !matches!(status, StoredTurnStatus::InProgress) || error.is_some() || usage.is_some()
            {
                return Err(RolloutError::Corrupt(RolloutDiagnostic {
                    path: path.to_path_buf(),
                    offset,
                    kind: "invalidStartedTurn",
                }));
            }
            Ok(DecodedRecord::TurnStarted {
                sequence,
                thread_id: ThreadId::new(thread_id),
                turn: DurableTurnSnapshot {
                    id: TurnId::new(id),
                    status: DurableTurnStatus::InProgress,
                    items: decode_items(items),
                    error: None,
                    usage: None,
                },
            })
        }
        "turnItemAdded" => {
            let record = serde_json::from_value::<StoredTurnItemAdded>(value).map_err(|_| {
                RolloutError::Corrupt(RolloutDiagnostic {
                    path: path.to_path_buf(),
                    offset,
                    kind: "invalidRecordShape",
                })
            })?;
            let StoredTurnItemAdded {
                schema_version,
                sequence,
                thread_id,
                turn_id,
                item,
                record_type: TurnItemAddedType::TurnItemAdded,
            } = record;
            debug_assert_eq!(schema_version, CURRENT_ROLLOUT_SCHEMA_VERSION);
            Ok(DecodedRecord::TurnItemAdded {
                sequence,
                thread_id: ThreadId::new(thread_id),
                turn_id: TurnId::new(turn_id),
                item: decode_item(item),
            })
        }
        "threadArchived" => {
            let record = serde_json::from_value::<StoredThreadArchived>(value).map_err(|_| {
                RolloutError::Corrupt(RolloutDiagnostic {
                    path: path.to_path_buf(),
                    offset,
                    kind: "invalidRecordShape",
                })
            })?;
            let StoredThreadArchived {
                schema_version,
                sequence,
                thread_id,
                record_type: ThreadArchivedType::ThreadArchived,
            } = record;
            debug_assert_eq!(schema_version, CURRENT_ROLLOUT_SCHEMA_VERSION);
            Ok(DecodedRecord::ThreadArchived {
                sequence,
                thread_id: ThreadId::new(thread_id),
            })
        }
        "threadUnarchived" => {
            let record = serde_json::from_value::<StoredThreadUnarchived>(value).map_err(|_| {
                RolloutError::Corrupt(RolloutDiagnostic {
                    path: path.to_path_buf(),
                    offset,
                    kind: "invalidRecordShape",
                })
            })?;
            let StoredThreadUnarchived {
                schema_version,
                sequence,
                thread_id,
                record_type: ThreadUnarchivedType::ThreadUnarchived,
            } = record;
            debug_assert_eq!(schema_version, CURRENT_ROLLOUT_SCHEMA_VERSION);
            Ok(DecodedRecord::ThreadUnarchived {
                sequence,
                thread_id: ThreadId::new(thread_id),
            })
        }
        "threadDeleted" => {
            let record = serde_json::from_value::<StoredThreadDeleted>(value).map_err(|_| {
                RolloutError::Corrupt(RolloutDiagnostic {
                    path: path.to_path_buf(),
                    offset,
                    kind: "invalidRecordShape",
                })
            })?;
            let StoredThreadDeleted {
                schema_version,
                sequence,
                thread_id,
                record_type: ThreadDeletedType::ThreadDeleted,
            } = record;
            debug_assert_eq!(schema_version, CURRENT_ROLLOUT_SCHEMA_VERSION);
            Ok(DecodedRecord::ThreadDeleted {
                sequence,
                thread_id: ThreadId::new(thread_id),
            })
        }
        _ => unreachable!("record type checked above"),
    }
}

fn decode_items(items: Vec<StoredItem>) -> Vec<DurableItemSnapshot> {
    items.into_iter().map(decode_item).collect()
}

fn decode_item(item: StoredItem) -> DurableItemSnapshot {
    match item {
        StoredItem::UserMessage { id, text } => DurableItemSnapshot::UserMessage {
            id: ItemId::new(id),
            text,
        },
        StoredItem::AgentMessage { id, text } => DurableItemSnapshot::AgentMessage {
            id: ItemId::new(id),
            text,
        },
        StoredItem::ToolCall {
            id,
            call_id,
            name,
            path,
            query,
            patch,
            command,
            arguments,
        } => DurableItemSnapshot::ToolCall {
            id: ItemId::new(id),
            call_id,
            name,
            path,
            query,
            patch,
            command,
            arguments,
        },
        StoredItem::FileChange {
            id,
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
            id: ItemId::new(id),
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
        },
        StoredItem::CommandApprovalRequest {
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
        } => DurableItemSnapshot::CommandApprovalRequest {
            id: ItemId::new(id),
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
        },
        StoredItem::CommandApprovalDecision {
            id,
            approval_id,
            decision,
            workspace_write_risk_acknowledgement,
        } => DurableItemSnapshot::CommandApprovalDecision {
            id: ItemId::new(id),
            approval_id,
            decision,
            workspace_write_risk_acknowledgement,
        },
        StoredItem::CommandExecutionAttempt {
            id,
            approval_id,
            call_id,
        } => DurableItemSnapshot::CommandExecutionAttempt {
            id: ItemId::new(id),
            approval_id,
            call_id,
        },
        StoredItem::ToolResult {
            id,
            call_id,
            name,
            result,
        } => DurableItemSnapshot::ToolResult {
            id: ItemId::new(id),
            call_id,
            name,
            result: match result {
                StoredToolResult::Success { content, bytes } => {
                    DurableToolResult::Success { content, bytes }
                }
                StoredToolResult::Error { kind } => DurableToolResult::Error { kind },
                StoredToolResult::Process {
                    stdout,
                    stderr,
                    stdout_bytes,
                    stderr_bytes,
                    stdout_truncated,
                    stderr_truncated,
                    encoding,
                    duration_ms,
                    outcome,
                    sandbox_policy,
                    workspace_write_policy,
                    network_policy,
                } => DurableToolResult::Process(super::DurableProcessResult {
                    stdout,
                    stderr,
                    stdout_bytes,
                    stderr_bytes,
                    stdout_truncated,
                    stderr_truncated,
                    encoding,
                    duration_ms,
                    outcome: match outcome {
                        StoredProcessOutcome::ExitCode { code } => {
                            super::DurableProcessOutcome::ExitCode { code }
                        }
                        StoredProcessOutcome::Signal { signal } => {
                            super::DurableProcessOutcome::Signal { signal }
                        }
                        StoredProcessOutcome::TimedOut => super::DurableProcessOutcome::TimedOut,
                    },
                    sandbox_policy,
                    workspace_write_policy,
                    network_policy,
                }),
            },
        },
    }
}

fn decode_error(error: StoredTurnError) -> DurableTurnError {
    DurableTurnError {
        kind: match error.kind {
            StoredTurnErrorKind::Authentication => DurableTurnErrorKind::Authentication,
            StoredTurnErrorKind::InvalidRequest => DurableTurnErrorKind::InvalidRequest,
            StoredTurnErrorKind::RateLimited => DurableTurnErrorKind::RateLimited,
            StoredTurnErrorKind::Timeout => DurableTurnErrorKind::Timeout,
            StoredTurnErrorKind::Transport => DurableTurnErrorKind::Transport,
            StoredTurnErrorKind::Disconnected => DurableTurnErrorKind::Disconnected,
            StoredTurnErrorKind::Server => DurableTurnErrorKind::Server,
            StoredTurnErrorKind::Protocol => DurableTurnErrorKind::Protocol,
            StoredTurnErrorKind::Incomplete => DurableTurnErrorKind::Incomplete,
            StoredTurnErrorKind::Filtered => DurableTurnErrorKind::Filtered,
            StoredTurnErrorKind::UnsupportedOutput => DurableTurnErrorKind::UnsupportedOutput,
            StoredTurnErrorKind::OutputTooLarge => DurableTurnErrorKind::OutputTooLarge,
            StoredTurnErrorKind::StateUnavailable => DurableTurnErrorKind::StateUnavailable,
        },
        retryable: error.retryable,
    }
}

fn decode_usage(usage: StoredUsage) -> DurableUsage {
    DurableUsage {
        input_tokens: usage.input_tokens,
        cached_input_tokens: usage.cached_input_tokens,
        output_tokens: usage.output_tokens,
        reasoning_tokens: usage.reasoning_tokens,
        total_tokens: usage.total_tokens,
    }
}

pub(super) fn encode_thread_created(
    sequence: u64,
    thread_id: &ThreadId,
) -> Result<Vec<u8>, RolloutError> {
    serde_json::to_vec(&ThreadCreatedRecord {
        schema_version: CURRENT_ROLLOUT_SCHEMA_VERSION,
        sequence,
        record_type: "threadCreated",
        thread_id: thread_id.as_str(),
    })
    .map_err(|_| RolloutError::Poisoned)
}

pub(super) fn encode_turn_started(
    sequence: u64,
    thread_id: &ThreadId,
    turn: &DurableTurnSnapshot,
) -> Result<Vec<u8>, RolloutError> {
    let mut stored = StoredTurnRef::from(turn);
    stored.status = "inProgress";
    stored.error = None;
    stored.usage = None;
    serde_json::to_vec(&TurnStartedRecord {
        schema_version: CURRENT_ROLLOUT_SCHEMA_VERSION,
        sequence,
        record_type: "turnStarted",
        thread_id: thread_id.as_str(),
        turn: stored,
    })
    .map_err(|_| RolloutError::Poisoned)
}

pub(super) fn encode_turn_completed(
    sequence: u64,
    thread_id: &ThreadId,
    turn: &DurableTurnSnapshot,
) -> Result<Vec<u8>, RolloutError> {
    serde_json::to_vec(&TurnCompletedRecord {
        schema_version: CURRENT_ROLLOUT_SCHEMA_VERSION,
        sequence,
        record_type: "turnCompleted",
        thread_id: thread_id.as_str(),
        turn: turn.into(),
    })
    .map_err(|_| RolloutError::Poisoned)
}

pub(super) fn encode_turn_item_added(
    sequence: u64,
    thread_id: &ThreadId,
    turn_id: &TurnId,
    item: &DurableItemSnapshot,
) -> Result<Vec<u8>, RolloutError> {
    serde_json::to_vec(&TurnItemAddedRecord {
        schema_version: CURRENT_ROLLOUT_SCHEMA_VERSION,
        sequence,
        record_type: "turnItemAdded",
        thread_id: thread_id.as_str(),
        turn_id: turn_id.as_str(),
        item: item.into(),
    })
    .map_err(|_| RolloutError::Poisoned)
}

pub(super) fn encode_thread_archived(
    sequence: u64,
    thread_id: &ThreadId,
) -> Result<Vec<u8>, RolloutError> {
    serde_json::to_vec(&ThreadArchivedRecord {
        schema_version: CURRENT_ROLLOUT_SCHEMA_VERSION,
        sequence,
        record_type: "threadArchived",
        thread_id: thread_id.as_str(),
    })
    .map_err(|_| RolloutError::Poisoned)
}

pub(super) fn encode_thread_unarchived(
    sequence: u64,
    thread_id: &ThreadId,
) -> Result<Vec<u8>, RolloutError> {
    serde_json::to_vec(&ThreadUnarchivedRecord {
        schema_version: CURRENT_ROLLOUT_SCHEMA_VERSION,
        sequence,
        record_type: "threadUnarchived",
        thread_id: thread_id.as_str(),
    })
    .map_err(|_| RolloutError::Poisoned)
}

pub(super) fn encode_thread_deleted(
    sequence: u64,
    thread_id: &ThreadId,
) -> Result<Vec<u8>, RolloutError> {
    serde_json::to_vec(&ThreadDeletedRecord {
        schema_version: CURRENT_ROLLOUT_SCHEMA_VERSION,
        sequence,
        record_type: "threadDeleted",
        thread_id: thread_id.as_str(),
    })
    .map_err(|_| RolloutError::Poisoned)
}

pub(super) fn empty_thread(thread_id: ThreadId) -> DurableThreadSnapshot {
    DurableThreadSnapshot {
        id: thread_id,
        turns: Vec::new(),
        lifecycle: super::DurableThreadLifecycle::Active,
    }
}
