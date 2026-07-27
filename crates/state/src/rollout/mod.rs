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
    pub lifecycle: DurableThreadLifecycle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RolloutThreadState {
    pub snapshot: DurableThreadSnapshot,
    pub last_record_sequence: u64,
    pub turn_record_sequences: Vec<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurableThreadLifecycle {
    Active,
    Archived,
    Deleted,
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
    pub status: DurableTurnStatus,
    pub items: Vec<DurableItemSnapshot>,
    pub context_compaction: Option<DurableContextCompaction>,
    pub workspace_instructions: Option<DurableWorkspaceInstructionsAudit>,
    pub error: Option<DurableTurnError>,
    pub usage: Option<DurableUsage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableContextCompaction {
    pub strategy: DurableContextCompactionStrategy,
    pub through_turn_id: TurnId,
    pub source_turns: u64,
    pub source_messages: u64,
    pub source_bytes: u64,
    pub source_sha256: String,
    pub message_bytes: u64,
    pub message_sha256: String,
    pub message: String,
    pub pre_context_bytes: u64,
    pub post_context_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurableContextCompactionStrategy {
    DeterministicExtractiveV1,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableWorkspaceInstructionsAudit {
    pub source: DurableWorkspaceInstructionsSource,
    pub status: DurableWorkspaceInstructionsStatus,
    pub bytes: Option<u64>,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurableWorkspaceInstructionsSource {
    RootAgentsMdV1,
    RootToActiveScopeAgentsMdV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurableWorkspaceInstructionsStatus {
    Absent,
    Present,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurableTurnStatus {
    InProgress,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurableTurnErrorKind {
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableTurnError {
    pub kind: DurableTurnErrorKind,
    pub retryable: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DurableUsage {
    pub input_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DurableItemSnapshot {
    UserMessage {
        id: ItemId,
        text: String,
    },
    AgentMessage {
        id: ItemId,
        text: String,
    },
    ToolCall {
        id: ItemId,
        call_id: String,
        name: String,
        path: String,
        query: Option<String>,
        patch: Option<String>,
        command: Option<String>,
        arguments: Option<Vec<String>>,
    },
    FileChange {
        id: ItemId,
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
        id: ItemId,
        approval_id: String,
        call_id: String,
        command: String,
        arguments: Vec<String>,
        cwd: String,
        environment_policy: String,
        sandboxed: bool,
        sandbox_policy: Option<String>,
        workspace_write_policy: Option<String>,
        workspace_write_risk: Option<String>,
        network_policy: Option<String>,
    },
    CommandApprovalDecision {
        id: ItemId,
        approval_id: String,
        decision: String,
        workspace_write_risk_acknowledgement: Option<String>,
    },
    CommandExecutionAttempt {
        id: ItemId,
        approval_id: String,
        call_id: String,
    },
    ToolResult {
        id: ItemId,
        call_id: String,
        name: String,
        result: DurableToolResult,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DurableToolResult {
    Success { content: String, bytes: u64 },
    Error { kind: String },
    Process(DurableProcessResult),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableProcessResult {
    pub stdout: String,
    pub stderr: String,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub encoding: String,
    pub duration_ms: u64,
    pub outcome: DurableProcessOutcome,
    pub sandbox_policy: Option<String>,
    pub workspace_write_policy: Option<String>,
    pub network_policy: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DurableProcessOutcome {
    ExitCode { code: i64 },
    Signal { signal: i32 },
    TimedOut,
}

pub fn terminal_turn_record_fits(thread_id: &ThreadId, turn: &DurableTurnSnapshot) -> bool {
    format::encode_turn_completed(u64::MAX, thread_id, turn)
        .is_ok_and(|bytes| bytes.len() <= MAX_ROLLOUT_RECORD_BYTES)
}

impl DurableItemSnapshot {
    pub fn id(&self) -> &ItemId {
        match self {
            Self::UserMessage { id, .. }
            | Self::AgentMessage { id, .. }
            | Self::ToolCall { id, .. }
            | Self::FileChange { id, .. }
            | Self::CommandApprovalRequest { id, .. }
            | Self::CommandApprovalDecision { id, .. }
            | Self::CommandExecutionAttempt { id, .. }
            | Self::ToolResult { id, .. } => id,
        }
    }
}

pub(crate) fn valid_incremental_item(
    existing: &[DurableItemSnapshot],
    item: &DurableItemSnapshot,
) -> Result<(), &'static str> {
    if !valid_file_change_item(item) {
        return Err("invalidFileChangeItem");
    }
    if let DurableItemSnapshot::CommandApprovalRequest {
        workspace_write_policy,
        workspace_write_risk,
        ..
    } = item
    {
        if !matches!(
            workspace_write_policy.as_deref(),
            None | Some("commandWorkspaceWriteV1")
        ) || !matches!(
            workspace_write_risk.as_deref(),
            None | Some("nonTransactionalWorkspaceTreeV1")
        ) || (workspace_write_policy.is_none() && workspace_write_risk.is_some())
        {
            return Err("invalidCommandApprovalRisk");
        }
        return Ok(());
    }
    if let DurableItemSnapshot::CommandApprovalDecision {
        approval_id,
        decision,
        workspace_write_risk_acknowledgement,
        ..
    } = item
    {
        if !matches!(
            workspace_write_risk_acknowledgement.as_deref(),
            None | Some("nonTransactionalWorkspaceTreeV1")
        ) {
            return Err("invalidCommandApprovalRisk");
        }
        let mut matching_risk = None;
        let mut found_request = false;
        for existing_item in existing {
            if let DurableItemSnapshot::CommandApprovalRequest {
                approval_id: existing_approval_id,
                workspace_write_risk,
                ..
            } = existing_item
                && existing_approval_id == approval_id
            {
                if found_request {
                    return Err("invalidCommandApprovalRisk");
                }
                found_request = true;
                matching_risk = workspace_write_risk.as_deref();
            }
        }
        if !found_request
            || (decision == "approved"
                && workspace_write_risk_acknowledgement.as_deref() != matching_risk)
            || (decision != "approved" && workspace_write_risk_acknowledgement.is_some())
        {
            return Err("invalidCommandApprovalRisk");
        }
        return Ok(());
    }
    let DurableItemSnapshot::CommandExecutionAttempt {
        approval_id,
        call_id,
        ..
    } = item
    else {
        return Ok(());
    };
    let mut matching_call = None;
    let mut matching_request = None;
    let mut matching_decision = None;
    for existing_item in existing {
        match existing_item {
            DurableItemSnapshot::ToolCall {
                call_id: existing_call_id,
                name,
                path,
                command,
                arguments,
                ..
            } if existing_call_id == call_id && name == "shell/exec" => {
                if matching_call.is_some() {
                    return Err("invalidCommandExecutionAttempt");
                }
                matching_call = Some((path, command, arguments));
            }
            DurableItemSnapshot::CommandApprovalRequest {
                approval_id: existing_approval_id,
                call_id: existing_call_id,
                command,
                arguments,
                cwd,
                environment_policy,
                sandboxed,
                sandbox_policy,
                workspace_write_policy,
                workspace_write_risk,
                network_policy,
                ..
            } if existing_approval_id == approval_id && existing_call_id == call_id => {
                if matching_request.is_some() {
                    return Err("invalidCommandExecutionAttempt");
                }
                matching_request = Some((
                    command,
                    arguments,
                    cwd,
                    environment_policy,
                    sandboxed,
                    sandbox_policy,
                    workspace_write_policy,
                    workspace_write_risk,
                    network_policy,
                ));
            }
            DurableItemSnapshot::CommandApprovalDecision {
                approval_id: existing_approval_id,
                decision,
                workspace_write_risk_acknowledgement,
                ..
            } if existing_approval_id == approval_id => {
                if matching_decision.is_some() {
                    return Err("invalidCommandExecutionAttempt");
                }
                matching_decision = Some((decision, workspace_write_risk_acknowledgement));
            }
            DurableItemSnapshot::CommandExecutionAttempt {
                approval_id: existing_approval_id,
                call_id: existing_call_id,
                ..
            } if existing_approval_id == approval_id || existing_call_id == call_id => {
                return Err("invalidCommandExecutionAttempt");
            }
            DurableItemSnapshot::ToolResult {
                call_id: existing_call_id,
                ..
            } if existing_call_id == call_id => {
                return Err("invalidCommandExecutionAttempt");
            }
            _ => {}
        }
    }
    let Some((path, call_command, call_arguments)) = matching_call else {
        return Err("invalidCommandExecutionAttempt");
    };
    let Some((
        request_command,
        request_arguments,
        cwd,
        environment_policy,
        sandboxed,
        sandbox_policy,
        workspace_write_policy,
        workspace_write_risk,
        network_policy,
    )) = matching_request
    else {
        return Err("invalidCommandExecutionAttempt");
    };
    if call_command.as_ref() != Some(request_command)
        || call_arguments.as_ref() != Some(request_arguments)
        || path != cwd
        || environment_policy != "minimalV1"
        || !sandboxed
        || sandbox_policy.as_deref() != Some("filesystemReadOnlyV1")
        || !matches!(
            workspace_write_policy.as_deref(),
            None | Some("commandWorkspaceWriteV1")
        )
        || network_policy.as_deref() != Some("networkDeniedV1")
        || matching_decision.is_none_or(|(decision, acknowledgement)| {
            decision != "approved" || acknowledgement != workspace_write_risk
        })
    {
        return Err("invalidCommandExecutionAttempt");
    }
    Ok(())
}

pub(crate) fn valid_turn_items(items: &[DurableItemSnapshot]) -> bool {
    items
        .iter()
        .enumerate()
        .all(|(index, item)| valid_incremental_item(&items[..index], item).is_ok())
}

pub(crate) fn valid_workspace_instructions_audit(
    audit: Option<&DurableWorkspaceInstructionsAudit>,
) -> bool {
    let Some(audit) = audit else {
        return true;
    };
    match audit.source {
        DurableWorkspaceInstructionsSource::RootAgentsMdV1 => match audit.status {
            DurableWorkspaceInstructionsStatus::Absent => {
                audit.bytes.is_none() && audit.sha256.is_none()
            }
            DurableWorkspaceInstructionsStatus::Present => {
                audit.bytes.is_some_and(|bytes| bytes <= 32 * 1024)
                    && audit.sha256.as_deref().is_some_and(valid_sha256)
            }
        },
        DurableWorkspaceInstructionsSource::RootToActiveScopeAgentsMdV1 => {
            let status_is_valid = match audit.status {
                DurableWorkspaceInstructionsStatus::Absent => audit.bytes.is_none(),
                DurableWorkspaceInstructionsStatus::Present => {
                    audit.bytes.is_some_and(|bytes| bytes <= 32 * 1024)
                }
            };
            status_is_valid && audit.sha256.as_deref().is_some_and(valid_sha256)
        }
    }
}

pub(crate) fn valid_file_change_item(item: &DurableItemSnapshot) -> bool {
    match item {
        DurableItemSnapshot::ToolCall {
            name, path, patch, ..
        } => match patch {
            Some(patch) => {
                name == "workspace/apply-patch"
                    && valid_patch_path(path)
                    && !patch.is_empty()
                    && patch.len() <= 96 * 1024
            }
            None => name != "workspace/apply-patch",
        },
        DurableItemSnapshot::FileChange {
            path,
            kind,
            diff,
            before_sha256,
            after_sha256,
            before_bytes,
            after_bytes,
            newline_style,
            ..
        } => {
            kind == "update"
                && matches!(newline_style.as_str(), "lf" | "crLf")
                && valid_patch_path(path)
                && valid_sha256(before_sha256)
                && valid_sha256(after_sha256)
                && *before_bytes <= 256 * 1024
                && *after_bytes <= 256 * 1024
                && !diff.is_empty()
                && diff.len() <= 192 * 1024
                && diff.lines().count() <= 5_000
                && diff.starts_with(&format!("--- a/{path}\n+++ b/{path}\n"))
        }
        _ => true,
    }
}

fn valid_patch_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1_024
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && !path.chars().any(char::is_control)
        && !path
            .split(['/', '\\'])
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

pub trait ThreadRepository: fmt::Debug + Send {
    fn id_sequences(&self) -> IdSequences;
    fn create_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError>;
    fn create_thread_snapshot(
        &mut self,
        snapshot: &DurableThreadSnapshot,
    ) -> Result<(), RolloutError>;
    fn append_completed_turn(
        &mut self,
        thread_id: &ThreadId,
        turn: &DurableTurnSnapshot,
    ) -> Result<(), RolloutError>;
    fn begin_turn(
        &mut self,
        _thread_id: &ThreadId,
        _turn: &DurableTurnSnapshot,
    ) -> Result<(), RolloutError> {
        Err(RolloutError::InvalidRecord {
            kind: "asynchronousTurnsUnsupported",
        })
    }
    fn finish_turn(
        &mut self,
        thread_id: &ThreadId,
        turn: &DurableTurnSnapshot,
    ) -> Result<(), RolloutError> {
        self.append_completed_turn(thread_id, turn)
    }
    fn append_turn_item(
        &mut self,
        _thread_id: &ThreadId,
        _turn_id: &TurnId,
        _item: &DurableItemSnapshot,
    ) -> Result<(), RolloutError> {
        Err(RolloutError::InvalidRecord {
            kind: "incrementalItemsUnsupported",
        })
    }
    fn archive_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError>;
    fn unarchive_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError>;
    fn delete_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError>;
    fn load_thread(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Option<DurableThreadSnapshot>, RolloutError>;
    fn list_threads(
        &mut self,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, RolloutError>;
    fn search_threads(
        &mut self,
        query: &str,
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
        let projection = self
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| name.contains("thread-search"))
            .map_or("thread discovery", |_| "thread search");
        write!(
            formatter,
            "{}: {projection} {} ({})",
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
