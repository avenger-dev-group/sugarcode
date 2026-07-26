use super::DurableThreadLifecycle;
use super::DurableThreadSnapshot;
use super::IdSequences;
use super::MAX_ROLLOUT_FILE_BYTES;
use super::MAX_ROLLOUT_FILES;
use super::MAX_ROLLOUT_RECORD_BYTES;
use super::MAX_ROLLOUT_RECORDS_PER_FILE;
use super::MAX_TOTAL_REPLAY_BYTES;
use super::MAX_TOTAL_REPLAY_RECORDS;
use super::RolloutDiagnostic;
use super::RolloutError;
use super::RolloutThreadState;
use super::format::DecodedRecord;
use super::format::decode_record;
use super::format::empty_thread;
use super::format::encode_turn_completed;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::io::Write;
use std::path::Path;
use sugarcode_protocol::ThreadId;
use sugarcode_protocol::TurnId;

#[derive(Debug)]
pub(super) struct ReplayResult {
    pub threads: BTreeMap<ThreadId, RolloutThreadState>,
    pub sequences: IdSequences,
    pub diagnostics: Vec<RolloutDiagnostic>,
    pub retained_bytes: u64,
    pub record_count: usize,
}

pub(super) fn replay_all(root: &Path) -> Result<ReplayResult, RolloutError> {
    let mut paths = Vec::new();
    let mut diagnostics = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| unavailable(root, error))? {
        let entry = entry.map_err(|error| unavailable(root, error))?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| unavailable(&path, error))?;
        if path.file_name().and_then(|name| name.to_str()) == Some(".writer.lock") {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(corrupt(&path, 0, "invalidStateEntry"));
            }
            continue;
        }
        if is_fork_create_artifact(&path) {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(corrupt(&path, 0, "invalidStateEntry"));
            }
            fs::remove_file(&path).map_err(|error| unavailable(&path, error))?;
            sync_parent(&path)?;
            diagnostics.push(RolloutDiagnostic {
                path,
                offset: 0,
                kind: "forkCreateArtifactRecovered",
            });
            continue;
        }
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || path.extension().and_then(|extension| extension.to_str()) != Some("jsonl")
        {
            return Err(corrupt(&path, 0, "invalidStateEntry"));
        }
        paths.push(path);
    }
    paths.sort();
    if paths.len() > MAX_ROLLOUT_FILES {
        return Err(RolloutError::LimitExceeded {
            path: root.to_path_buf(),
            kind: "rolloutFiles",
        });
    }

    let mut threads = BTreeMap::new();
    let mut sequences = IdSequences::default();
    let mut total_bytes = 0u64;
    let mut retained_bytes = 0u64;
    let mut total_records = 0usize;
    let mut turn_ids = BTreeSet::new();
    let mut item_ids = BTreeSet::new();

    for path in paths {
        let metadata = fs::metadata(&path).map_err(|error| unavailable(&path, error))?;
        if metadata.len() > MAX_ROLLOUT_FILE_BYTES {
            return Err(RolloutError::LimitExceeded {
                path,
                kind: "rolloutFileBytes",
            });
        }
        total_bytes =
            total_bytes
                .checked_add(metadata.len())
                .ok_or_else(|| RolloutError::LimitExceeded {
                    path: root.to_path_buf(),
                    kind: "totalReplayBytes",
                })?;
        if total_bytes > MAX_TOTAL_REPLAY_BYTES {
            return Err(RolloutError::LimitExceeded {
                path: root.to_path_buf(),
                kind: "totalReplayBytes",
            });
        }

        let mut bytes = fs::read(&path).map_err(|error| unavailable(&path, error))?;
        if bytes.is_empty() {
            fs::remove_file(&path).map_err(|error| unavailable(&path, error))?;
            sync_parent(&path)?;
            diagnostics.push(RolloutDiagnostic {
                path,
                offset: 0,
                kind: "emptyCreateArtifactRecovered",
            });
            continue;
        }
        let truncated_tail_offset = if bytes.last() != Some(&b'\n') {
            let verified_len = bytes
                .iter()
                .rposition(|byte| *byte == b'\n')
                .map_or(0, |position| position + 1);
            if verified_len == 0 {
                fs::remove_file(&path).map_err(|error| unavailable(&path, error))?;
                sync_parent(&path)?;
                diagnostics.push(RolloutDiagnostic {
                    path: path.clone(),
                    offset: 0,
                    kind: "truncatedTailRecovered",
                });
                continue;
            }
            bytes.truncate(verified_len);
            Some(verified_len)
        } else {
            None
        };

        let expected_thread_id = thread_id_from_path(&path)?;
        sequences.thread = sequences.thread.max(
            parse_canonical_id(expected_thread_id.as_str(), "thr_", "thread")
                .map_err(|_| corrupt(&path, 0, "invalidThreadId"))?,
        );
        let mut snapshot: Option<DurableThreadSnapshot> = None;
        let mut turn_record_sequences = Vec::new();
        let mut expected_sequence = 1u64;
        let mut offset = 0usize;
        let mut record_count = 0usize;
        let mut pending_turn_id: Option<TurnId> = None;

        while offset < bytes.len() {
            let relative_end = bytes[offset..]
                .iter()
                .position(|byte| *byte == b'\n')
                .expect("recovered rollout is newline terminated");
            let end = offset + relative_end;
            let record_bytes = &bytes[offset..end];
            if record_bytes.len() > MAX_ROLLOUT_RECORD_BYTES {
                return Err(RolloutError::LimitExceeded {
                    path,
                    kind: "rolloutRecordBytes",
                });
            }
            record_count += 1;
            total_records += 1;
            if record_count > MAX_ROLLOUT_RECORDS_PER_FILE {
                return Err(RolloutError::LimitExceeded {
                    path,
                    kind: "rolloutRecords",
                });
            }
            if total_records > MAX_TOTAL_REPLAY_RECORDS {
                return Err(RolloutError::LimitExceeded {
                    path: root.to_path_buf(),
                    kind: "totalReplayRecords",
                });
            }

            let record = decode_record(record_bytes, &path, offset as u64)?;
            if record.sequence() != expected_sequence {
                return Err(corrupt(&path, offset as u64, "invalidSequence"));
            }
            match record {
                DecodedRecord::ThreadCreated {
                    thread_id,
                    sequence: _,
                } => {
                    if expected_sequence != 1
                        || thread_id != expected_thread_id
                        || snapshot.is_some()
                    {
                        return Err(corrupt(&path, offset as u64, "invalidThreadCreated"));
                    }
                    snapshot = Some(empty_thread(thread_id));
                }
                DecodedRecord::TurnStarted {
                    thread_id,
                    mut turn,
                    sequence,
                } => {
                    if pending_turn_id.is_some() {
                        return Err(corrupt(&path, offset as u64, "duplicateTurnStarted"));
                    }
                    let thread = snapshot
                        .as_mut()
                        .ok_or_else(|| corrupt(&path, offset as u64, "missingThreadCreated"))?;
                    if thread_id != expected_thread_id {
                        return Err(corrupt(&path, offset as u64, "threadIdMismatch"));
                    }
                    if thread.lifecycle != DurableThreadLifecycle::Active {
                        return Err(corrupt(&path, offset as u64, "turnStartedWhileInactive"));
                    }
                    if !valid_started_items(&turn.items) {
                        return Err(corrupt(&path, offset as u64, "invalidStartedTurnItems"));
                    }
                    validate_new_turn(
                        &turn,
                        &path,
                        offset as u64,
                        &mut turn_ids,
                        &mut item_ids,
                        &mut sequences,
                    )?;
                    turn.status = super::DurableTurnStatus::Interrupted;
                    pending_turn_id = Some(turn.id.clone());
                    thread.turns.push(turn);
                    turn_record_sequences.push(sequence);
                }
                DecodedRecord::TurnItemAdded {
                    thread_id,
                    turn_id,
                    item,
                    sequence: _,
                } => {
                    let thread = snapshot
                        .as_mut()
                        .ok_or_else(|| corrupt(&path, offset as u64, "missingThreadCreated"))?;
                    if thread_id != expected_thread_id {
                        return Err(corrupt(&path, offset as u64, "threadIdMismatch"));
                    }
                    if pending_turn_id.as_ref() != Some(&turn_id) {
                        return Err(corrupt(&path, offset as u64, "turnItemAddedWhileInactive"));
                    }
                    if matches!(item, super::DurableItemSnapshot::UserMessage { .. })
                        || matches!(
                            item,
                            super::DurableItemSnapshot::AgentMessage { ref text, .. }
                                if !text.is_empty()
                        )
                    {
                        return Err(corrupt(&path, offset as u64, "invalidIncrementalItem"));
                    }
                    let item_sequence = parse_canonical_id(item.id().as_str(), "item_", "item")
                        .map_err(|_| corrupt(&path, offset as u64, "invalidItemId"))?;
                    if item_sequence <= sequences.item || !item_ids.insert(item.id().clone()) {
                        return Err(corrupt(&path, offset as u64, "duplicateItemId"));
                    }
                    sequences.item = item_sequence;
                    thread
                        .turns
                        .last_mut()
                        .ok_or_else(|| corrupt(&path, offset as u64, "missingStartedTurn"))?
                        .items
                        .push(item);
                }
                DecodedRecord::TurnCompleted {
                    thread_id,
                    turn,
                    sequence,
                } => {
                    let thread = snapshot
                        .as_mut()
                        .ok_or_else(|| corrupt(&path, offset as u64, "missingThreadCreated"))?;
                    if thread_id != expected_thread_id {
                        return Err(corrupt(&path, offset as u64, "threadIdMismatch"));
                    }
                    if thread.lifecycle != DurableThreadLifecycle::Active {
                        let kind = if thread.lifecycle == DurableThreadLifecycle::Deleted {
                            "recordAfterThreadDelete"
                        } else {
                            "recordAfterThreadArchive"
                        };
                        return Err(corrupt(&path, offset as u64, kind));
                    }
                    validate_terminal_turn(&turn, &path, offset as u64)?;
                    if pending_turn_id.as_ref() == Some(&turn.id) {
                        let pending = thread
                            .turns
                            .last_mut()
                            .ok_or_else(|| corrupt(&path, offset as u64, "missingStartedTurn"))?;
                        if !terminal_items_match(&pending.items, &turn.items) {
                            return Err(corrupt(&path, offset as u64, "turnItemMismatch"));
                        }
                        *pending = turn;
                        *turn_record_sequences
                            .last_mut()
                            .ok_or_else(|| corrupt(&path, offset as u64, "missingStartedTurn"))? =
                            sequence;
                        pending_turn_id = None;
                    } else if pending_turn_id.is_some() {
                        return Err(corrupt(
                            &path,
                            offset as u64,
                            "turnCompletedWhileAnotherTurnPending",
                        ));
                    } else {
                        if turn.status != super::DurableTurnStatus::Completed {
                            return Err(corrupt(&path, offset as u64, "legacyTurnMustBeCompleted"));
                        }
                        validate_new_turn(
                            &turn,
                            &path,
                            offset as u64,
                            &mut turn_ids,
                            &mut item_ids,
                            &mut sequences,
                        )?;
                        thread.turns.push(turn);
                        turn_record_sequences.push(sequence);
                    }
                }
                DecodedRecord::ThreadArchived {
                    thread_id,
                    sequence: _,
                } => {
                    if pending_turn_id.is_some() {
                        return Err(corrupt(
                            &path,
                            offset as u64,
                            "threadLifecycleWhileTurnPending",
                        ));
                    }
                    let thread = snapshot
                        .as_mut()
                        .ok_or_else(|| corrupt(&path, offset as u64, "missingThreadCreated"))?;
                    if thread_id != expected_thread_id {
                        return Err(corrupt(&path, offset as u64, "threadIdMismatch"));
                    }
                    match thread.lifecycle {
                        DurableThreadLifecycle::Active => {
                            thread.lifecycle = DurableThreadLifecycle::Archived;
                        }
                        DurableThreadLifecycle::Archived => {
                            return Err(corrupt(&path, offset as u64, "duplicateThreadArchive"));
                        }
                        DurableThreadLifecycle::Deleted => {
                            return Err(corrupt(&path, offset as u64, "recordAfterThreadDelete"));
                        }
                    }
                }
                DecodedRecord::ThreadUnarchived {
                    thread_id,
                    sequence: _,
                } => {
                    if pending_turn_id.is_some() {
                        return Err(corrupt(
                            &path,
                            offset as u64,
                            "threadLifecycleWhileTurnPending",
                        ));
                    }
                    let thread = snapshot
                        .as_mut()
                        .ok_or_else(|| corrupt(&path, offset as u64, "missingThreadCreated"))?;
                    if thread_id != expected_thread_id {
                        return Err(corrupt(&path, offset as u64, "threadIdMismatch"));
                    }
                    match thread.lifecycle {
                        DurableThreadLifecycle::Active => {
                            return Err(corrupt(
                                &path,
                                offset as u64,
                                "threadUnarchiveWhileActive",
                            ));
                        }
                        DurableThreadLifecycle::Archived => {
                            thread.lifecycle = DurableThreadLifecycle::Active;
                        }
                        DurableThreadLifecycle::Deleted => {
                            return Err(corrupt(&path, offset as u64, "recordAfterThreadDelete"));
                        }
                    }
                }
                DecodedRecord::ThreadDeleted {
                    thread_id,
                    sequence: _,
                } => {
                    if pending_turn_id.is_some() {
                        return Err(corrupt(
                            &path,
                            offset as u64,
                            "threadLifecycleWhileTurnPending",
                        ));
                    }
                    let thread = snapshot
                        .as_mut()
                        .ok_or_else(|| corrupt(&path, offset as u64, "missingThreadCreated"))?;
                    if thread_id != expected_thread_id {
                        return Err(corrupt(&path, offset as u64, "threadIdMismatch"));
                    }
                    if thread.lifecycle == DurableThreadLifecycle::Deleted {
                        return Err(corrupt(&path, offset as u64, "duplicateThreadDelete"));
                    }
                    thread.lifecycle = DurableThreadLifecycle::Deleted;
                }
            }
            expected_sequence = expected_sequence
                .checked_add(1)
                .ok_or_else(|| corrupt(&path, offset as u64, "invalidSequence"))?;
            offset = end + 1;
        }

        let snapshot = snapshot.ok_or_else(|| corrupt(&path, 0, "missingThreadCreated"))?;
        if let Some(verified_len) = truncated_tail_offset {
            let file = fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .map_err(|error| unavailable(&path, error))?;
            file.set_len(verified_len as u64)
                .map_err(|error| unavailable(&path, error))?;
            file.sync_all().map_err(|error| unavailable(&path, error))?;
            diagnostics.push(RolloutDiagnostic {
                path: path.clone(),
                offset: verified_len as u64,
                kind: "truncatedTailRecovered",
            });
        }
        let recovery_bytes = if pending_turn_id.is_some() {
            let interrupted = snapshot
                .turns
                .last()
                .ok_or_else(|| corrupt(&path, 0, "missingStartedTurn"))?;
            let encoded = encode_turn_completed(expected_sequence, &snapshot.id, interrupted)?;
            if encoded.len() > MAX_ROLLOUT_RECORD_BYTES {
                return Err(RolloutError::LimitExceeded {
                    path,
                    kind: "rolloutRecordBytes",
                });
            }
            let added_bytes =
                u64::try_from(encoded.len() + 1).map_err(|_| RolloutError::LimitExceeded {
                    path: path.clone(),
                    kind: "rolloutFileBytes",
                })?;
            let retained_file_bytes = u64::try_from(bytes.len())
                .ok()
                .and_then(|length| length.checked_add(added_bytes));
            if retained_file_bytes.is_none_or(|length| length > MAX_ROLLOUT_FILE_BYTES)
                || record_count >= MAX_ROLLOUT_RECORDS_PER_FILE
                || total_records >= MAX_TOTAL_REPLAY_RECORDS
            {
                return Err(RolloutError::LimitExceeded {
                    path: path.clone(),
                    kind: "recoveredTerminalRecord",
                });
            }
            let mut file = fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .map_err(|error| unavailable(&path, error))?;
            file.write_all(&encoded)
                .and_then(|()| file.write_all(b"\n"))
                .and_then(|()| file.flush())
                .and_then(|()| file.sync_all())
                .map_err(|error| unavailable(&path, error))?;
            *turn_record_sequences
                .last_mut()
                .ok_or_else(|| corrupt(&path, 0, "missingStartedTurn"))? = expected_sequence;
            expected_sequence = expected_sequence
                .checked_add(1)
                .ok_or_else(|| corrupt(&path, 0, "invalidSequence"))?;
            total_records += 1;
            diagnostics.push(RolloutDiagnostic {
                path: path.clone(),
                offset: bytes.len() as u64,
                kind: "danglingTurnRecovered",
            });
            added_bytes
        } else {
            0
        };
        retained_bytes = retained_bytes
            .checked_add(bytes.len() as u64)
            .and_then(|bytes| bytes.checked_add(recovery_bytes))
            .ok_or_else(|| RolloutError::LimitExceeded {
                path: root.to_path_buf(),
                kind: "totalReplayBytes",
            })?;
        if retained_bytes > MAX_TOTAL_REPLAY_BYTES {
            return Err(RolloutError::LimitExceeded {
                path: root.to_path_buf(),
                kind: "totalReplayBytes",
            });
        }
        let thread_id = snapshot.id.clone();
        let state = RolloutThreadState {
            snapshot,
            last_record_sequence: expected_sequence - 1,
            turn_record_sequences,
        };
        if threads.insert(thread_id, state).is_some() {
            return Err(corrupt(&path, 0, "duplicateThreadId"));
        }
    }

    Ok(ReplayResult {
        threads,
        sequences,
        diagnostics,
        retained_bytes,
        record_count: total_records,
    })
}

fn terminal_items_match(
    started: &[super::DurableItemSnapshot],
    terminal: &[super::DurableItemSnapshot],
) -> bool {
    started.len() == terminal.len()
        && started
            .iter()
            .zip(terminal)
            .all(|(started, terminal)| match (started, terminal) {
                (
                    super::DurableItemSnapshot::UserMessage {
                        id: started_id,
                        text: started_text,
                    },
                    super::DurableItemSnapshot::UserMessage {
                        id: terminal_id,
                        text: terminal_text,
                    },
                ) => started_id == terminal_id && started_text == terminal_text,
                (
                    super::DurableItemSnapshot::AgentMessage { id: started_id, .. },
                    super::DurableItemSnapshot::AgentMessage {
                        id: terminal_id, ..
                    },
                ) => started_id == terminal_id,
                (
                    super::DurableItemSnapshot::ToolCall { .. },
                    super::DurableItemSnapshot::ToolCall { .. },
                )
                | (
                    super::DurableItemSnapshot::ToolResult { .. },
                    super::DurableItemSnapshot::ToolResult { .. },
                )
                | (
                    super::DurableItemSnapshot::CommandApprovalRequest { .. },
                    super::DurableItemSnapshot::CommandApprovalRequest { .. },
                )
                | (
                    super::DurableItemSnapshot::CommandApprovalDecision { .. },
                    super::DurableItemSnapshot::CommandApprovalDecision { .. },
                ) => started == terminal,
                _ => false,
            })
}

fn valid_started_items(items: &[super::DurableItemSnapshot]) -> bool {
    match items {
        [] | [super::DurableItemSnapshot::UserMessage { .. }] => true,
        [super::DurableItemSnapshot::AgentMessage { text, .. }] => text.is_empty(),
        [
            super::DurableItemSnapshot::UserMessage { .. },
            super::DurableItemSnapshot::AgentMessage { text, .. },
        ] => text.is_empty(),
        _ => false,
    }
}

fn validate_terminal_turn(
    turn: &super::DurableTurnSnapshot,
    path: &Path,
    offset: u64,
) -> Result<(), RolloutError> {
    let valid = match turn.status {
        super::DurableTurnStatus::InProgress => false,
        super::DurableTurnStatus::Completed => !turn.items.is_empty() && turn.error.is_none(),
        super::DurableTurnStatus::Failed => !turn.items.is_empty() && turn.error.is_some(),
        super::DurableTurnStatus::Interrupted => turn.error.is_none(),
    };
    if valid {
        Ok(())
    } else {
        Err(corrupt(path, offset, "invalidTerminalTurn"))
    }
}

fn validate_new_turn(
    turn: &super::DurableTurnSnapshot,
    path: &Path,
    offset: u64,
    turn_ids: &mut BTreeSet<TurnId>,
    item_ids: &mut BTreeSet<sugarcode_protocol::ItemId>,
    sequences: &mut IdSequences,
) -> Result<(), RolloutError> {
    let turn_sequence = parse_canonical_id(turn.id.as_str(), "turn_", "turn")
        .map_err(|_| corrupt(path, offset, "invalidTurnId"))?;
    if !turn_ids.insert(turn.id.clone()) {
        return Err(corrupt(path, offset, "duplicateTurnId"));
    }
    sequences.turn = sequences.turn.max(turn_sequence);
    if turn.items.is_empty() && turn.status != super::DurableTurnStatus::InProgress {
        return Err(corrupt(path, offset, "emptyCompletedTurn"));
    }
    for item in &turn.items {
        let item_sequence = parse_canonical_id(item.id().as_str(), "item_", "item")
            .map_err(|_| corrupt(path, offset, "invalidItemId"))?;
        if !item_ids.insert(item.id().clone()) {
            return Err(corrupt(path, offset, "duplicateItemId"));
        }
        sequences.item = sequences.item.max(item_sequence);
    }
    Ok(())
}

fn is_fork_create_artifact(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some(thread_id) = name
        .strip_prefix('.')
        .and_then(|name| name.strip_suffix(".fork.tmp"))
    else {
        return false;
    };
    parse_canonical_id(thread_id, "thr_", "thread").is_ok()
}

pub(crate) fn parse_canonical_id(
    value: &str,
    prefix: &str,
    kind: &'static str,
) -> Result<u64, RolloutError> {
    let digits = value
        .strip_prefix(prefix)
        .ok_or(RolloutError::InvalidId { kind })?;
    if digits.len() < 16 || digits.len() > 20 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(RolloutError::InvalidId { kind });
    }
    let sequence = digits
        .parse::<u64>()
        .map_err(|_| RolloutError::InvalidId { kind })?;
    if format!("{sequence:016}") != digits {
        return Err(RolloutError::InvalidId { kind });
    }
    Ok(sequence)
}

fn thread_id_from_path(path: &Path) -> Result<ThreadId, RolloutError> {
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or(RolloutError::InvalidId { kind: "thread" })?;
    parse_canonical_id(stem, "thr_", "thread").map_err(|_| corrupt(path, 0, "invalidThreadId"))?;
    Ok(ThreadId::new(stem))
}

pub(super) fn unavailable(path: &Path, error: io::Error) -> RolloutError {
    RolloutError::Unavailable {
        path: path.to_path_buf(),
        kind: error.kind(),
    }
}

pub(super) fn corrupt(path: &Path, offset: u64, kind: &'static str) -> RolloutError {
    RolloutError::Corrupt(RolloutDiagnostic {
        path: path.to_path_buf(),
        offset,
        kind,
    })
}

pub(super) fn sync_parent(_path: &Path) -> Result<(), RolloutError> {
    #[cfg(unix)]
    {
        let path = _path;
        let parent = path
            .parent()
            .ok_or_else(|| unavailable(path, io::Error::other("no parent")))?;
        let directory = fs::File::open(parent).map_err(|error| unavailable(parent, error))?;
        directory
            .sync_all()
            .map_err(|error| unavailable(parent, error))?;
    }
    Ok(())
}
