use super::CURRENT_ROLLOUT_SCHEMA_VERSION;
use super::DurableItemSnapshot;
use super::DurableThreadSnapshot;
use super::DurableTurnSnapshot;
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
pub(super) struct StoredTurnRef<'a> {
    pub id: &'a str,
    pub status: &'static str,
    pub items: Vec<StoredItemRef<'a>>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(super) enum StoredItemRef<'a> {
    AgentMessage { id: &'a str, text: &'a str },
}

impl<'a> From<&'a DurableTurnSnapshot> for StoredTurnRef<'a> {
    fn from(turn: &'a DurableTurnSnapshot) -> Self {
        Self {
            id: turn.id.as_str(),
            status: "completed",
            items: turn
                .items
                .iter()
                .map(|item| match item {
                    DurableItemSnapshot::AgentMessage { id, text } => StoredItemRef::AgentMessage {
                        id: id.as_str(),
                        text,
                    },
                })
                .collect(),
        }
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
enum TurnCompletedType {
    #[serde(rename = "turnCompleted")]
    TurnCompleted,
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredTurn {
    id: String,
    status: StoredTurnStatus,
    items: Vec<StoredItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum StoredTurnStatus {
    Completed,
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
    #[serde(rename = "agentMessage")]
    AgentMessage,
}

pub(super) enum DecodedRecord {
    ThreadCreated {
        sequence: u64,
        thread_id: ThreadId,
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
}

impl DecodedRecord {
    pub fn sequence(&self) -> u64 {
        match self {
            Self::ThreadCreated { sequence, .. }
            | Self::TurnCompleted { sequence, .. }
            | Self::ThreadArchived { sequence, .. }
            | Self::ThreadUnarchived { sequence, .. } => *sequence,
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
        "threadCreated" | "turnCompleted" | "threadArchived" | "threadUnarchived"
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
                status: StoredTurnStatus::Completed,
                items,
            } = turn;
            let items = items
                .into_iter()
                .map(|item| {
                    let StoredItem {
                        item_type: StoredItemType::AgentMessage,
                        id,
                        text,
                    } = item;
                    DurableItemSnapshot::AgentMessage {
                        id: ItemId::new(id),
                        text,
                    }
                })
                .collect();
            Ok(DecodedRecord::TurnCompleted {
                sequence,
                thread_id: ThreadId::new(thread_id),
                turn: DurableTurnSnapshot {
                    id: TurnId::new(id),
                    items,
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
        _ => unreachable!("record type checked above"),
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

pub(super) fn empty_thread(thread_id: ThreadId) -> DurableThreadSnapshot {
    DurableThreadSnapshot {
        id: thread_id,
        turns: Vec::new(),
        lifecycle: super::DurableThreadLifecycle::Active,
    }
}
