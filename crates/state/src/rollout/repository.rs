use super::DurableItemSnapshot;
use super::DurableThreadLifecycle;
use super::DurableThreadOrigin;
use super::DurableThreadPage;
use super::DurableThreadSnapshot;
use super::DurableThreadSummary;
use super::DurableTurnSnapshot;
use super::DurableTurnStatus;
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
use super::format::encode_turn_item_added;
use super::format::encode_turn_item_completed;
use super::format::encode_turn_started;
use super::replay::parse_canonical_id;
use super::replay::replay_all;
use super::replay::sync_parent;
use super::replay::unavailable;
use super::valid_workspace_instructions_audit;
use super::valid_workspace_skills_audit;
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

mod thread_repository;

const ROLLOUTS_DIRECTORY: &str = "rollouts";
const ROLLOUT_LAYOUT_DIRECTORY: &str = "v1";
const WRITER_LOCK_FILE: &str = ".writer.lock";

#[derive(Debug)]
pub struct RolloutRepository {
    root: PathBuf,
    _writer_lock: File,
    threads: BTreeMap<ThreadId, RolloutThreadState>,
    pending_turns: BTreeMap<ThreadId, DurableTurnSnapshot>,
    sequences: IdSequences,
    diagnostics: Vec<RolloutDiagnostic>,
    total_bytes: u64,
    total_records: usize,
    projection: ThreadDiscoveryProjection,
    search_projection: ThreadSearchProjection,
    poisoned: bool,
    active_workspace_binding_id: Option<String>,
}

impl RolloutRepository {
    pub fn open(home: &SugarCodeHome) -> Result<Self, RolloutError> {
        Self::open_with_workspace_binding(home, None)
    }

    pub fn open_with_workspace_binding(
        home: &SugarCodeHome,
        active_workspace_binding_id: Option<&str>,
    ) -> Result<Self, RolloutError> {
        if active_workspace_binding_id.is_some_and(|binding_id| {
            binding_id.len() != 64
                || !binding_id
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        }) {
            return Err(RolloutError::InvalidRecord {
                kind: "invalidWorkspaceBinding",
            });
        }
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
        let mut replay = replay_all(&root)?;
        let projection =
            ThreadDiscoveryProjection::open(home, &replay.threads, replay.record_count)?;
        let search_projection =
            ThreadSearchProjection::open(home, &replay.threads, replay.record_count);
        if let Some(binding_id) = active_workspace_binding_id {
            replay
                .threads
                .retain(|_, thread| thread.workspace_binding_id.as_deref() == Some(binding_id));
        }
        Ok(Self {
            root,
            _writer_lock: writer_lock,
            threads: replay.threads,
            pending_turns: BTreeMap::new(),
            sequences: replay.sequences,
            diagnostics: replay.diagnostics,
            total_bytes: replay.retained_bytes,
            total_records: replay.record_count,
            projection,
            search_projection,
            poisoned: false,
            active_workspace_binding_id: active_workspace_binding_id.map(str::to_owned),
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

fn terminal_items_match(started: &[DurableItemSnapshot], terminal: &[DurableItemSnapshot]) -> bool {
    started.len() == terminal.len()
        && started
            .iter()
            .zip(terminal)
            .all(|(started, terminal)| match (started, terminal) {
                (
                    DurableItemSnapshot::UserMessage {
                        id: started_id,
                        text: started_text,
                    },
                    DurableItemSnapshot::UserMessage {
                        id: terminal_id,
                        text: terminal_text,
                    },
                ) => started_id == terminal_id && started_text == terminal_text,
                (
                    DurableItemSnapshot::AgentMessage { id: started_id, .. },
                    DurableItemSnapshot::AgentMessage {
                        id: terminal_id, ..
                    },
                ) => started_id == terminal_id,
                (
                    DurableItemSnapshot::AgentCommentary { .. },
                    DurableItemSnapshot::AgentCommentary { .. },
                ) => started == terminal,
                (
                    DurableItemSnapshot::ContextCompaction { id: started_id, .. },
                    DurableItemSnapshot::ContextCompaction {
                        id: terminal_id, ..
                    },
                ) => started_id == terminal_id,
                (DurableItemSnapshot::ToolCall { .. }, DurableItemSnapshot::ToolCall { .. })
                | (
                    DurableItemSnapshot::ToolResult { .. },
                    DurableItemSnapshot::ToolResult { .. },
                )
                | (
                    DurableItemSnapshot::CommandApprovalRequest { .. },
                    DurableItemSnapshot::CommandApprovalRequest { .. },
                )
                | (
                    DurableItemSnapshot::CommandApprovalDecision { .. },
                    DurableItemSnapshot::CommandApprovalDecision { .. },
                )
                | (
                    DurableItemSnapshot::CommandExecutionAttempt { .. },
                    DurableItemSnapshot::CommandExecutionAttempt { .. },
                )
                | (
                    DurableItemSnapshot::McpToolCall { .. },
                    DurableItemSnapshot::McpToolCall { .. },
                )
                | (
                    DurableItemSnapshot::McpToolCallApprovalRequest { .. },
                    DurableItemSnapshot::McpToolCallApprovalRequest { .. },
                )
                | (
                    DurableItemSnapshot::McpToolCallApprovalDecision { .. },
                    DurableItemSnapshot::McpToolCallApprovalDecision { .. },
                )
                | (
                    DurableItemSnapshot::McpToolExecutionAttempt { .. },
                    DurableItemSnapshot::McpToolExecutionAttempt { .. },
                )
                | (
                    DurableItemSnapshot::McpToolResult { .. },
                    DurableItemSnapshot::McpToolResult { .. },
                )
                | (
                    DurableItemSnapshot::FileChange { .. },
                    DurableItemSnapshot::FileChange { .. },
                ) => started == terminal,
                _ => false,
            })
}

fn valid_terminal_turn(turn: &DurableTurnSnapshot) -> bool {
    !turn.items.is_empty()
        && super::valid_turn_items(&turn.items)
        && super::valid_workspace_instructions_audit(turn.workspace_instructions.as_ref())
        && super::valid_workspace_skills_audit(turn.workspace_skills.as_ref())
        && match turn.status {
            DurableTurnStatus::InProgress => false,
            DurableTurnStatus::Completed => turn.error.is_none(),
            DurableTurnStatus::Failed => turn.error.is_some(),
            DurableTurnStatus::Interrupted => turn.error.is_none(),
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
