use super::DurableThreadLifecycle;
use super::DurableThreadPage;
use super::DurableThreadSnapshot;
use super::DurableTurnSnapshot;
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
use super::ThreadRepository;
use super::format::encode_thread_archived;
use super::format::encode_thread_created;
use super::format::encode_thread_deleted;
use super::format::encode_thread_unarchived;
use super::format::encode_turn_completed;
use super::replay::parse_canonical_id;
use super::replay::replay_all;
use super::replay::sync_parent;
use super::replay::unavailable;
use crate::HomeSource;
use crate::SugarCodeHome;
use crate::thread_discovery::ThreadDiscoveryProjection;
use crate::thread_search::ThreadSearchProjection;
use std::collections::BTreeMap;
use std::fs;
use std::fs::File;
use std::fs::OpenOptions;
use std::fs::TryLockError;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use sugarcode_protocol::ThreadId;

const ROLLOUTS_DIRECTORY: &str = "rollouts";
const ROLLOUT_LAYOUT_DIRECTORY: &str = "v1";
const WRITER_LOCK_FILE: &str = ".writer.lock";

#[derive(Debug)]
pub struct RolloutRepository {
    root: PathBuf,
    _writer_lock: File,
    threads: BTreeMap<ThreadId, RolloutThreadState>,
    sequences: IdSequences,
    diagnostics: Vec<RolloutDiagnostic>,
    total_bytes: u64,
    total_records: usize,
    projection: ThreadDiscoveryProjection,
    search_projection: ThreadSearchProjection,
    poisoned: bool,
}

impl RolloutRepository {
    pub fn open(home: &SugarCodeHome) -> Result<Self, RolloutError> {
        ensure_home(home)?;
        let rollouts = checked_directory(&home.path().join(ROLLOUTS_DIRECTORY))?;
        let root = checked_directory(&rollouts.join(ROLLOUT_LAYOUT_DIRECTORY))?;
        let lock_path = root.join(WRITER_LOCK_FILE);
        reject_symlink_if_present(&lock_path)?;
        let writer_lock = open_lock_file(&lock_path)?;
        match writer_lock.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                return Err(RolloutError::Busy { path: lock_path });
            }
            Err(TryLockError::Error(error)) => {
                return Err(unavailable(&lock_path, error));
            }
        }
        let replay = replay_all(&root)?;
        let projection =
            ThreadDiscoveryProjection::open(home, &replay.threads, replay.record_count)?;
        let search_projection =
            ThreadSearchProjection::open(home, &replay.threads, replay.record_count);
        Ok(Self {
            root,
            _writer_lock: writer_lock,
            threads: replay.threads,
            sequences: replay.sequences,
            diagnostics: replay.diagnostics,
            total_bytes: replay.retained_bytes,
            total_records: replay.record_count,
            projection,
            search_projection,
            poisoned: false,
        })
    }

    pub fn diagnostics(&self) -> &[RolloutDiagnostic] {
        &self.diagnostics
    }

    pub fn projection_diagnostics(&self) -> &[super::ProjectionDiagnostic] {
        // Kept for compatibility with callers that report diagnostics at startup.
        // Search diagnostics are exposed separately because the projections have
        // independent availability and recovery.
        self.projection.diagnostics()
    }

    pub fn search_projection_diagnostics(&self) -> &[super::ProjectionDiagnostic] {
        self.search_projection.diagnostics()
    }

    fn ensure_available(&self) -> Result<(), RolloutError> {
        if self.poisoned {
            Err(RolloutError::Poisoned)
        } else {
            Ok(())
        }
    }

    fn thread_path(&self, thread_id: &ThreadId) -> Result<PathBuf, RolloutError> {
        parse_canonical_id(thread_id.as_str(), "thr_", "thread")?;
        Ok(self.root.join(format!("{}.jsonl", thread_id.as_str())))
    }

    fn fork_temp_path(&self, thread_id: &ThreadId) -> Result<PathBuf, RolloutError> {
        parse_canonical_id(thread_id.as_str(), "thr_", "thread")?;
        Ok(self.root.join(format!(".{}.fork.tmp", thread_id.as_str())))
    }

    fn append_record(
        &mut self,
        path: &Path,
        bytes: &[u8],
        create: bool,
        next_file_record_count: usize,
    ) -> Result<(), RolloutError> {
        if bytes.len() > MAX_ROLLOUT_RECORD_BYTES {
            return Err(RolloutError::LimitExceeded {
                path: path.to_path_buf(),
                kind: "rolloutRecordBytes",
            });
        }
        if next_file_record_count > MAX_ROLLOUT_RECORDS_PER_FILE {
            return Err(RolloutError::LimitExceeded {
                path: path.to_path_buf(),
                kind: "rolloutRecords",
            });
        }
        let added_bytes =
            u64::try_from(bytes.len() + 1).map_err(|_| RolloutError::LimitExceeded {
                path: path.to_path_buf(),
                kind: "rolloutFileBytes",
            })?;
        let existing_bytes = if create {
            0
        } else {
            let metadata = fs::symlink_metadata(path).map_err(|error| unavailable(path, error))?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(RolloutError::Unavailable {
                    path: path.to_path_buf(),
                    kind: std::io::ErrorKind::InvalidInput,
                });
            }
            metadata.len()
        };
        if existing_bytes
            .checked_add(added_bytes)
            .is_none_or(|size| size > MAX_ROLLOUT_FILE_BYTES)
        {
            return Err(RolloutError::LimitExceeded {
                path: path.to_path_buf(),
                kind: "rolloutFileBytes",
            });
        }
        if self
            .total_bytes
            .checked_add(added_bytes)
            .is_none_or(|size| size > MAX_TOTAL_REPLAY_BYTES)
        {
            return Err(RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "totalReplayBytes",
            });
        }
        if self.total_records >= MAX_TOTAL_REPLAY_RECORDS {
            return Err(RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "totalReplayRecords",
            });
        }
        let result = (|| {
            let mut options = OpenOptions::new();
            options.write(true);
            if create {
                options.create_new(true);
            } else {
                options.append(true);
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(path)
                .map_err(|error| unavailable(path, error))?;
            file.write_all(bytes)
                .map_err(|error| unavailable(path, error))?;
            file.write_all(b"\n")
                .map_err(|error| unavailable(path, error))?;
            file.flush().map_err(|error| unavailable(path, error))?;
            file.sync_all().map_err(|error| unavailable(path, error))?;
            if create {
                sync_parent(path)?;
            }
            Ok(())
        })();
        if result.is_err() {
            self.poisoned = true;
        } else {
            self.total_bytes += added_bytes;
            self.total_records += 1;
        }
        result
    }

    fn create_snapshot_file(
        &mut self,
        path: &Path,
        temp_path: &Path,
        records: &[Vec<u8>],
        added_bytes: u64,
    ) -> Result<(), RolloutError> {
        reject_symlink_if_present(path)?;
        match fs::symlink_metadata(path) {
            Ok(_) => return Err(RolloutError::Collision { kind: "thread" }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(unavailable(path, error)),
        }
        reject_symlink_if_present(temp_path)?;
        match fs::symlink_metadata(temp_path) {
            Ok(_) => {
                self.poisoned = true;
                return Err(RolloutError::Collision {
                    kind: "forkCreateArtifact",
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(unavailable(temp_path, error)),
        }

        let result = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(temp_path)
                .map_err(|error| unavailable(temp_path, error))?;
            for record in records {
                file.write_all(record)
                    .map_err(|error| unavailable(temp_path, error))?;
                file.write_all(b"\n")
                    .map_err(|error| unavailable(temp_path, error))?;
            }
            file.flush()
                .map_err(|error| unavailable(temp_path, error))?;
            file.sync_all()
                .map_err(|error| unavailable(temp_path, error))?;
            drop(file);

            match fs::symlink_metadata(path) {
                Ok(_) => {
                    return Err(RolloutError::Collision { kind: "thread" });
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(unavailable(path, error)),
            }
            fs::rename(temp_path, path).map_err(|error| unavailable(path, error))?;
            sync_parent(path)?;
            Ok(())
        })();

        if result.is_err() {
            self.poisoned = true;
            return result;
        }
        self.total_bytes += added_bytes;
        self.total_records += records.len();
        Ok(())
    }
}

impl ThreadRepository for RolloutRepository {
    fn id_sequences(&self) -> IdSequences {
        self.sequences
    }

    fn create_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError> {
        self.ensure_available()?;
        let thread_sequence = parse_canonical_id(thread_id.as_str(), "thr_", "thread")?;
        if self.threads.contains_key(thread_id) || thread_sequence <= self.sequences.thread {
            return Err(RolloutError::Collision { kind: "thread" });
        }
        if self.threads.len() >= MAX_ROLLOUT_FILES {
            return Err(RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "rolloutFiles",
            });
        }
        let path = self.thread_path(thread_id)?;
        let bytes = encode_thread_created(1, thread_id)?;
        self.append_record(&path, &bytes, true, 1)?;
        self.threads.insert(
            thread_id.clone(),
            RolloutThreadState {
                snapshot: DurableThreadSnapshot {
                    id: thread_id.clone(),
                    turns: Vec::new(),
                    lifecycle: DurableThreadLifecycle::Active,
                },
                last_record_sequence: 1,
                turn_record_sequences: Vec::new(),
            },
        );
        self.sequences.thread = thread_sequence;
        let _ = self.projection.record_thread_created(thread_id);
        let _ = self.search_projection.record_thread_created(thread_id);
        Ok(())
    }

    fn create_thread_snapshot(
        &mut self,
        snapshot: &DurableThreadSnapshot,
    ) -> Result<(), RolloutError> {
        self.ensure_available()?;
        if snapshot.lifecycle != DurableThreadLifecycle::Active {
            return Err(RolloutError::InvalidRecord {
                kind: "materializedThreadNotActive",
            });
        }
        let thread_sequence = parse_canonical_id(snapshot.id.as_str(), "thr_", "thread")?;
        if self.threads.contains_key(&snapshot.id) || thread_sequence <= self.sequences.thread {
            return Err(RolloutError::Collision { kind: "thread" });
        }
        if self.threads.len() >= MAX_ROLLOUT_FILES {
            return Err(RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "rolloutFiles",
            });
        }

        let record_count =
            snapshot
                .turns
                .len()
                .checked_add(1)
                .ok_or_else(|| RolloutError::LimitExceeded {
                    path: self.root.clone(),
                    kind: "rolloutRecords",
                })?;
        if record_count > MAX_ROLLOUT_RECORDS_PER_FILE {
            return Err(RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "rolloutRecords",
            });
        }
        if self
            .total_records
            .checked_add(record_count)
            .is_none_or(|count| count > MAX_TOTAL_REPLAY_RECORDS)
        {
            return Err(RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "totalReplayRecords",
            });
        }

        let mut records = Vec::with_capacity(record_count);
        records.push(encode_thread_created(1, &snapshot.id)?);
        let mut turn_sequence = self.sequences.turn;
        let mut item_sequence = self.sequences.item;
        for (index, turn) in snapshot.turns.iter().enumerate() {
            if turn.items.is_empty() {
                return Err(RolloutError::InvalidRecord {
                    kind: "completedTurnWithoutItems",
                });
            }
            let sequence = parse_canonical_id(turn.id.as_str(), "turn_", "turn")?;
            if sequence <= turn_sequence {
                return Err(RolloutError::Collision { kind: "turn" });
            }
            turn_sequence = sequence;
            for item in &turn.items {
                let sequence = parse_canonical_id(item.id().as_str(), "item_", "item")?;
                if sequence <= item_sequence {
                    return Err(RolloutError::Collision { kind: "item" });
                }
                item_sequence = sequence;
            }
            let record_sequence =
                u64::try_from(index + 2).map_err(|_| RolloutError::InvalidRecord {
                    kind: "recordSequenceOverflow",
                })?;
            records.push(encode_turn_completed(record_sequence, &snapshot.id, turn)?);
        }

        let mut added_bytes = 0u64;
        for record in &records {
            if record.len() > MAX_ROLLOUT_RECORD_BYTES {
                return Err(RolloutError::LimitExceeded {
                    path: self.root.clone(),
                    kind: "rolloutRecordBytes",
                });
            }
            let record_bytes =
                u64::try_from(record.len() + 1).map_err(|_| RolloutError::LimitExceeded {
                    path: self.root.clone(),
                    kind: "rolloutFileBytes",
                })?;
            added_bytes = added_bytes.checked_add(record_bytes).ok_or_else(|| {
                RolloutError::LimitExceeded {
                    path: self.root.clone(),
                    kind: "rolloutFileBytes",
                }
            })?;
        }
        if added_bytes > MAX_ROLLOUT_FILE_BYTES {
            return Err(RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "rolloutFileBytes",
            });
        }
        if self
            .total_bytes
            .checked_add(added_bytes)
            .is_none_or(|bytes| bytes > MAX_TOTAL_REPLAY_BYTES)
        {
            return Err(RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "totalReplayBytes",
            });
        }

        let path = self.thread_path(&snapshot.id)?;
        let temp_path = self.fork_temp_path(&snapshot.id)?;
        self.create_snapshot_file(&path, &temp_path, &records, added_bytes)?;

        let last_record_sequence =
            u64::try_from(record_count).map_err(|_| RolloutError::InvalidRecord {
                kind: "recordSequenceOverflow",
            })?;
        let state = RolloutThreadState {
            snapshot: snapshot.clone(),
            last_record_sequence,
            turn_record_sequences: (2..=last_record_sequence).collect(),
        };
        self.threads.insert(snapshot.id.clone(), state.clone());
        self.sequences.thread = thread_sequence;
        self.sequences.turn = turn_sequence;
        self.sequences.item = item_sequence;
        let _ = self.projection.record_thread_snapshot(&state);
        let _ = self.search_projection.record_thread_snapshot(&state);
        Ok(())
    }

    fn append_completed_turn(
        &mut self,
        thread_id: &ThreadId,
        turn: &DurableTurnSnapshot,
    ) -> Result<(), RolloutError> {
        self.ensure_available()?;
        if turn.items.is_empty() {
            return Err(RolloutError::InvalidRecord {
                kind: "completedTurnWithoutItems",
            });
        }
        if let Some(thread) = self.threads.get(thread_id)
            && thread.snapshot.lifecycle != DurableThreadLifecycle::Active
        {
            return Err(RolloutError::InvalidRecord {
                kind: if thread.snapshot.lifecycle == DurableThreadLifecycle::Deleted {
                    "recordAfterThreadDelete"
                } else {
                    "recordAfterThreadArchive"
                },
            });
        }
        let turn_sequence = parse_canonical_id(turn.id.as_str(), "turn_", "turn")?;
        if turn_sequence <= self.sequences.turn {
            return Err(RolloutError::Collision { kind: "turn" });
        }
        let mut item_sequence = self.sequences.item;
        for item in &turn.items {
            let sequence = parse_canonical_id(item.id().as_str(), "item_", "item")?;
            if sequence <= item_sequence {
                return Err(RolloutError::Collision { kind: "item" });
            }
            item_sequence = sequence;
        }
        let record_sequence = self
            .threads
            .get(thread_id)
            .ok_or(RolloutError::InvalidId { kind: "thread" })?
            .last_record_sequence
            .checked_add(1)
            .ok_or(RolloutError::InvalidRecord {
                kind: "recordSequenceOverflow",
            })?;
        let next_file_record_count =
            usize::try_from(record_sequence).map_err(|_| RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "rolloutRecords",
            })?;
        let path = self.thread_path(thread_id)?;
        let bytes = encode_turn_completed(record_sequence, thread_id, turn)?;
        self.append_record(&path, &bytes, false, next_file_record_count)?;
        let thread = self
            .threads
            .get_mut(thread_id)
            .expect("validated thread exists");
        thread.snapshot.turns.push(turn.clone());
        thread.turn_record_sequences.push(record_sequence);
        thread.last_record_sequence = record_sequence;
        self.sequences.turn = turn_sequence;
        self.sequences.item = item_sequence;
        let _ = self
            .projection
            .record_turn_completed(thread_id, record_sequence);
        let _ = self
            .search_projection
            .record_turn_completed(thread_id, record_sequence, turn);
        Ok(())
    }

    fn archive_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError> {
        self.ensure_available()?;
        let thread = self
            .threads
            .get(thread_id)
            .ok_or(RolloutError::InvalidId { kind: "thread" })?;
        if thread.snapshot.lifecycle == DurableThreadLifecycle::Archived {
            return Ok(());
        }
        if thread.snapshot.lifecycle == DurableThreadLifecycle::Deleted {
            return Err(RolloutError::InvalidRecord {
                kind: "recordAfterThreadDelete",
            });
        }
        let record_sequence =
            thread
                .last_record_sequence
                .checked_add(1)
                .ok_or(RolloutError::InvalidRecord {
                    kind: "recordSequenceOverflow",
                })?;
        let next_file_record_count =
            usize::try_from(record_sequence).map_err(|_| RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "rolloutRecords",
            })?;
        let path = self.thread_path(thread_id)?;
        let bytes = encode_thread_archived(record_sequence, thread_id)?;
        self.append_record(&path, &bytes, false, next_file_record_count)?;
        let thread = self
            .threads
            .get_mut(thread_id)
            .expect("validated thread exists");
        thread.snapshot.lifecycle = DurableThreadLifecycle::Archived;
        thread.last_record_sequence = record_sequence;
        let _ = self
            .projection
            .record_thread_archived(thread_id, record_sequence);
        let _ = self
            .search_projection
            .record_thread_archived(thread_id, record_sequence);
        Ok(())
    }

    fn unarchive_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError> {
        self.ensure_available()?;
        let thread = self
            .threads
            .get(thread_id)
            .ok_or(RolloutError::InvalidId { kind: "thread" })?;
        if thread.snapshot.lifecycle == DurableThreadLifecycle::Active {
            return Ok(());
        }
        if thread.snapshot.lifecycle == DurableThreadLifecycle::Deleted {
            return Err(RolloutError::InvalidRecord {
                kind: "recordAfterThreadDelete",
            });
        }
        let record_sequence =
            thread
                .last_record_sequence
                .checked_add(1)
                .ok_or(RolloutError::InvalidRecord {
                    kind: "recordSequenceOverflow",
                })?;
        let next_file_record_count =
            usize::try_from(record_sequence).map_err(|_| RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "rolloutRecords",
            })?;
        let path = self.thread_path(thread_id)?;
        let bytes = encode_thread_unarchived(record_sequence, thread_id)?;
        self.append_record(&path, &bytes, false, next_file_record_count)?;
        let thread = self
            .threads
            .get_mut(thread_id)
            .expect("validated thread exists");
        thread.snapshot.lifecycle = DurableThreadLifecycle::Active;
        thread.last_record_sequence = record_sequence;
        let _ = self
            .projection
            .record_thread_unarchived(thread_id, record_sequence);
        let _ = self
            .search_projection
            .record_thread_unarchived(thread_id, record_sequence);
        Ok(())
    }

    fn delete_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError> {
        self.ensure_available()?;
        let thread = self
            .threads
            .get(thread_id)
            .ok_or(RolloutError::InvalidId { kind: "thread" })?;
        if thread.snapshot.lifecycle == DurableThreadLifecycle::Deleted {
            return Ok(());
        }
        let record_sequence =
            thread
                .last_record_sequence
                .checked_add(1)
                .ok_or(RolloutError::InvalidRecord {
                    kind: "recordSequenceOverflow",
                })?;
        let next_file_record_count =
            usize::try_from(record_sequence).map_err(|_| RolloutError::LimitExceeded {
                path: self.root.clone(),
                kind: "rolloutRecords",
            })?;
        let path = self.thread_path(thread_id)?;
        let bytes = encode_thread_deleted(record_sequence, thread_id)?;
        self.append_record(&path, &bytes, false, next_file_record_count)?;
        let thread = self
            .threads
            .get_mut(thread_id)
            .expect("validated thread exists");
        thread.snapshot.lifecycle = DurableThreadLifecycle::Deleted;
        thread.last_record_sequence = record_sequence;
        let _ = self
            .projection
            .record_thread_deleted(thread_id, record_sequence);
        let _ = self
            .search_projection
            .record_thread_deleted(thread_id, record_sequence);
        Ok(())
    }

    fn load_thread(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Option<DurableThreadSnapshot>, RolloutError> {
        self.ensure_available()?;
        parse_canonical_id(thread_id.as_str(), "thr_", "thread")?;
        Ok(self
            .threads
            .get(thread_id)
            .map(|thread| thread.snapshot.clone()))
    }

    fn list_threads(
        &mut self,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, RolloutError> {
        self.ensure_available()?;
        self.projection
            .list_threads(&self.threads, self.total_records, cursor, limit)
    }

    fn search_threads(
        &mut self,
        query: &str,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, RolloutError> {
        self.ensure_available()?;
        self.search_projection.search_threads(
            &self.threads,
            self.total_records,
            query,
            cursor,
            limit,
        )
    }
}

fn ensure_home(home: &SugarCodeHome) -> Result<(), RolloutError> {
    match fs::symlink_metadata(home.path()) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err(RolloutError::Unavailable {
                path: home.path().to_path_buf(),
                kind: std::io::ErrorKind::NotADirectory,
            })
        }
        Ok(_) => Ok(()),
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && home.source() == HomeSource::Default =>
        {
            create_directory(home.path())
        }
        Err(error) => Err(unavailable(home.path(), error)),
    }
}

fn checked_directory(path: &Path) -> Result<PathBuf, RolloutError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err(RolloutError::Unavailable {
                path: path.to_path_buf(),
                kind: std::io::ErrorKind::NotADirectory,
            })
        }
        Ok(_) => Ok(path.to_path_buf()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            create_directory(path)?;
            Ok(path.to_path_buf())
        }
        Err(error) => Err(unavailable(path, error)),
    }
}

fn create_directory(path: &Path) -> Result<(), RolloutError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        builder
            .create(path)
            .map_err(|error| unavailable(path, error))?;
    }
    #[cfg(not(unix))]
    fs::create_dir(path).map_err(|error| unavailable(path, error))?;
    sync_parent(path)
}

fn reject_symlink_if_present(path: &Path) -> Result<(), RolloutError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(RolloutError::Unavailable {
                path: path.to_path_buf(),
                kind: std::io::ErrorKind::InvalidInput,
            })
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(unavailable(path, error)),
    }
}

fn open_lock_file(path: &Path) -> Result<File, RolloutError> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|error| unavailable(path, error))
}
