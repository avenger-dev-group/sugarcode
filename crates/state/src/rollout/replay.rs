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
use super::format::DecodedRecord;
use super::format::decode_record;
use super::format::empty_thread;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::Path;
use sugarcode_protocol::ThreadId;

#[derive(Debug)]
pub(super) struct ReplayResult {
    pub threads: BTreeMap<ThreadId, DurableThreadSnapshot>,
    pub sequences: IdSequences,
    pub diagnostics: Vec<RolloutDiagnostic>,
    pub retained_bytes: u64,
    pub record_count: usize,
}

pub(super) fn replay_all(root: &Path) -> Result<ReplayResult, RolloutError> {
    let mut paths = Vec::new();
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
    let mut diagnostics = Vec::new();
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
        let mut expected_sequence = 1u64;
        let mut offset = 0usize;
        let mut record_count = 0usize;

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
                DecodedRecord::TurnCompleted {
                    thread_id,
                    turn,
                    sequence: _,
                } => {
                    let thread = snapshot
                        .as_mut()
                        .ok_or_else(|| corrupt(&path, offset as u64, "missingThreadCreated"))?;
                    if thread_id != expected_thread_id {
                        return Err(corrupt(&path, offset as u64, "threadIdMismatch"));
                    }
                    let turn_sequence = parse_canonical_id(turn.id.as_str(), "turn_", "turn")
                        .map_err(|_| corrupt(&path, offset as u64, "invalidTurnId"))?;
                    if !turn_ids.insert(turn.id.clone()) {
                        return Err(corrupt(&path, offset as u64, "duplicateTurnId"));
                    }
                    sequences.turn = sequences.turn.max(turn_sequence);
                    if turn.items.is_empty() {
                        return Err(corrupt(&path, offset as u64, "emptyCompletedTurn"));
                    }
                    for item in &turn.items {
                        let item_sequence = parse_canonical_id(item.id().as_str(), "item_", "item")
                            .map_err(|_| corrupt(&path, offset as u64, "invalidItemId"))?;
                        if !item_ids.insert(item.id().clone()) {
                            return Err(corrupt(&path, offset as u64, "duplicateItemId"));
                        }
                        sequences.item = sequences.item.max(item_sequence);
                    }
                    thread.turns.push(turn);
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
        retained_bytes = retained_bytes
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| RolloutError::LimitExceeded {
                path: root.to_path_buf(),
                kind: "totalReplayBytes",
            })?;
        if threads.insert(snapshot.id.clone(), snapshot).is_some() {
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

pub(super) fn sync_parent(path: &Path) -> Result<(), RolloutError> {
    #[cfg(unix)]
    {
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
