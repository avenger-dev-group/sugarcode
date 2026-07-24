mod format;
mod replay;
mod repository;

pub(crate) use replay::parse_canonical_id;
pub use repository::RolloutRepository;

use std::error::Error;
use std::fmt;
use std::path::PathBuf;
use sugarcode_protocol::ItemId;
use sugarcode_protocol::ThreadId;
use sugarcode_protocol::TurnId;

pub const CURRENT_ROLLOUT_SCHEMA_VERSION: u32 = 1;
pub const MAX_ROLLOUT_FILES: usize = 10_000;
pub const MAX_ROLLOUT_FILE_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_ROLLOUT_RECORD_BYTES: usize = 1024 * 1024;
pub const MAX_ROLLOUT_RECORDS_PER_FILE: usize = 100_000;
pub const MAX_TOTAL_REPLAY_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_TOTAL_REPLAY_RECORDS: usize = 1_000_000;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IdSequences {
    pub thread: u64,
    pub turn: u64,
    pub item: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableThreadSnapshot {
    pub id: ThreadId,
    pub turns: Vec<DurableTurnSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableThreadSummary {
    pub id: ThreadId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableThreadPage {
    pub data: Vec<DurableThreadSummary>,
    pub next_cursor: Option<ThreadId>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableTurnSnapshot {
    pub id: TurnId,
    pub items: Vec<DurableItemSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DurableItemSnapshot {
    AgentMessage { id: ItemId, text: String },
}

impl DurableItemSnapshot {
    pub fn id(&self) -> &ItemId {
        match self {
            Self::AgentMessage { id, .. } => id,
        }
    }
}

pub trait ThreadRepository: fmt::Debug + Send {
    fn id_sequences(&self) -> IdSequences;
    fn create_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError>;
    fn append_completed_turn(
        &mut self,
        thread_id: &ThreadId,
        turn: &DurableTurnSnapshot,
    ) -> Result<(), RolloutError>;
    fn load_thread(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Option<DurableThreadSnapshot>, RolloutError>;
    fn list_threads(
        &mut self,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, RolloutError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RolloutDiagnostic {
    pub path: PathBuf,
    pub offset: u64,
    pub kind: &'static str,
}

impl fmt::Display for RolloutDiagnostic {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}: rollout {} at byte {}",
            self.path.display(),
            self.kind,
            self.offset
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectionDiagnostic {
    pub path: PathBuf,
    pub operation: &'static str,
    pub kind: &'static str,
}

impl fmt::Display for ProjectionDiagnostic {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}: thread discovery {} ({})",
            self.path.display(),
            self.operation,
            self.kind
        )
    }
}

#[derive(Debug)]
pub enum RolloutError {
    Busy {
        path: PathBuf,
    },
    Unavailable {
        path: PathBuf,
        kind: std::io::ErrorKind,
    },
    Corrupt(RolloutDiagnostic),
    LimitExceeded {
        path: PathBuf,
        kind: &'static str,
    },
    InvalidId {
        kind: &'static str,
    },
    InvalidRecord {
        kind: &'static str,
    },
    Collision {
        kind: &'static str,
    },
    Projection(ProjectionDiagnostic),
    Poisoned,
}

impl fmt::Display for RolloutError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Busy { path } => write!(formatter, "{}: rollout writer is busy", path.display()),
            Self::Unavailable { path, kind } => {
                write!(
                    formatter,
                    "{}: rollout state is unavailable ({kind:?})",
                    path.display()
                )
            }
            Self::Corrupt(diagnostic) => diagnostic.fmt(formatter),
            Self::LimitExceeded { path, kind } => {
                write!(
                    formatter,
                    "{}: rollout limit exceeded ({kind})",
                    path.display()
                )
            }
            Self::InvalidId { kind } => write!(formatter, "invalid {kind} ID"),
            Self::InvalidRecord { kind } => write!(formatter, "invalid rollout record ({kind})"),
            Self::Collision { kind } => write!(formatter, "duplicate {kind} ID"),
            Self::Projection(diagnostic) => diagnostic.fmt(formatter),
            Self::Poisoned => formatter.write_str("rollout state is unavailable"),
        }
    }
}

impl Error for RolloutError {}
