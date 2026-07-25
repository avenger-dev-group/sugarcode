use super::CURRENT_ROLLOUT_SCHEMA_VERSION;
use super::DurableItemSnapshot;
use super::DurableThreadSnapshot;
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
    UserMessage { id: &'a str, text: &'a str },
    AgentMessage { id: &'a str, text: &'a str },
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
            items: turn
                .items
                .iter()
                .map(|item| match item {
                    DurableItemSnapshot::UserMessage { id, text } => StoredItemRef::UserMessage {
                        id: id.as_str(),
                        text,
                    },
                    DurableItemSnapshot::AgentMessage { id, text } => StoredItemRef::AgentMessage {
                        id: id.as_str(),
                        text,
                    },
                })
                .collect(),
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredItem {
    #[serde(rename = "type")]
    item_type: StoredItemType,
    id: String,
    text: String,
}

#[derive(Debug, Deserialize)]
enum StoredItemType {
    #[serde(rename = "userMessage")]
    UserMessage,
    #[serde(rename = "agentMessage")]
    AgentMessage,
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
    items
        .into_iter()
        .map(|item| match item {
            StoredItem {
                item_type: StoredItemType::UserMessage,
                id,
                text,
            } => DurableItemSnapshot::UserMessage {
                id: ItemId::new(id),
                text,
            },
            StoredItem {
                item_type: StoredItemType::AgentMessage,
                id,
                text,
            } => DurableItemSnapshot::AgentMessage {
                id: ItemId::new(id),
                text,
            },
        })
        .collect()
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
