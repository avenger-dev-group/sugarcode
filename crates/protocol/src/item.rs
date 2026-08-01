use crate::ThreadId;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ItemId(String);

impl ItemId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

impl fmt::Display for ItemId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreItemSnapshot {
    pub id: ItemId,
    pub kind: CoreItemKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreContentAsset {
    pub asset_id: String,
    pub sha256: String,
    pub media_type: String,
    pub original_name: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreUserContentPart {
    Text { text: String },
    Image { asset: CoreContentAsset },
    Document { asset: CoreContentAsset },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreItemKind {
    UserMessage {
        content: Vec<CoreUserContentPart>,
    },
    AgentMessage {
        text: String,
    },
    AgentCommentary {
        text: String,
    },
    AgentTask {
        orchestration_id: String,
        task_id: String,
        client_task_key: String,
        child_thread_id: ThreadId,
        title: String,
        role: String,
        access: String,
        depends_on: Vec<String>,
        task_markdown: String,
    },
    AgentTaskAmendment {
        orchestration_id: String,
        task_id: String,
        amendment_markdown: String,
    },
    AgentTaskResult {
        orchestration_id: String,
        task_id: String,
        status: String,
        summary_markdown: String,
        duration_ms: u64,
    },
    ContextCompaction {
        strategy: CoreContextCompactionStrategy,
        ordinal: u64,
        pre_context_bytes: u64,
        source_messages: u64,
        source_bytes: u64,
        source_sha256: String,
        outcome: Option<CoreContextCompactionOutcome>,
    },
    ToolCall {
        call_id: String,
        name: String,
        arguments: serde_json::Value,
    },
    ToolValidationRejected {
        call_id: String,
        name: String,
        kind: CoreToolErrorKind,
        arguments_bytes: u64,
        arguments_sha256: String,
        edit_index: Option<u32>,
        hunk_index: Option<u32>,
        line: Option<u32>,
        expected_summary: Option<String>,
        actual_summary: Option<String>,
        suggested_action: String,
    },
    FileChange {
        call_id: String,
        path: String,
        kind: CoreFileChangeKind,
        diff: String,
        before_sha256: String,
        after_sha256: String,
        before_bytes: u64,
        after_bytes: u64,
        newline_style: CoreFileChangeNewlineStyle,
        final_newline: bool,
    },
    CommandApprovalRequest {
        approval_id: String,
        call_id: String,
        command: String,
        arguments: Vec<String>,
        cwd: String,
        environment_policy: String,
        sandboxed: bool,
        sandbox_policy: Option<CoreCommandSandboxPolicy>,
        workspace_write_policy: Option<CoreCommandWorkspaceWritePolicy>,
        workspace_write_risk: Option<CoreCommandWorkspaceWriteRisk>,
        network_policy: Option<CoreCommandNetworkPolicy>,
    },
    CommandApprovalDecision {
        approval_id: String,
        decision: CoreCommandApprovalDecision,
        workspace_write_risk_acknowledgement: Option<CoreCommandWorkspaceWriteRisk>,
    },
    CommandExecutionAttempt {
        approval_id: String,
        call_id: String,
    },
    McpToolCall {
        call_id: String,
        name: String,
        arguments: serde_json::Value,
        arguments_bytes: u64,
        arguments_sha256: String,
        inventory_sha256: String,
    },
    McpToolCallApprovalRequest {
        approval_id: String,
        call_id: String,
        name: String,
        arguments: serde_json::Value,
        arguments_bytes: u64,
        arguments_sha256: String,
        inventory_sha256: String,
    },
    McpToolCallApprovalDecision {
        approval_id: String,
        decision: CoreCommandApprovalDecision,
    },
    McpToolExecutionAttempt {
        approval_id: String,
        call_id: String,
        inventory_sha256: String,
    },
    McpToolResult {
        call_id: String,
        name: String,
        result: CoreMcpToolResult,
    },
    ToolResult {
        call_id: String,
        name: String,
        result: CoreToolResult,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreContextCompactionStrategy {
    ModelGeneratedActiveTurnV1,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreContextCompactionOutcome {
    Completed {
        post_context_bytes: u64,
        summary_bytes: u64,
        summary_sha256: String,
    },
    Failed {
        kind: String,
    },
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreMcpToolResult {
    Completed {
        content: String,
        is_error: bool,
        observed_bytes: u64,
        canonical_bytes: u64,
        retained_bytes: u64,
        truncated: bool,
        sha256: String,
        content_blocks: u64,
        structured_content: bool,
    },
    Error {
        kind: String,
        request_state: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreFileChangeKind {
    Update,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreFileChangeNewlineStyle {
    Lf,
    CrLf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreToolResult {
    Success { content: String, bytes: u64 },
    Error { kind: CoreToolErrorKind },
    Process(CoreProcessResult),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreProcessResult {
    pub stdout: String,
    pub stderr: String,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub encoding: String,
    pub duration_ms: u64,
    pub outcome: CoreProcessOutcome,
    pub sandbox_policy: Option<CoreCommandSandboxPolicy>,
    pub workspace_write_policy: Option<CoreCommandWorkspaceWritePolicy>,
    pub network_policy: Option<CoreCommandNetworkPolicy>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreProcessOutcome {
    ExitCode { code: i64 },
    Signal { signal: i32 },
    TimedOut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreCommandApprovalDecision {
    Approved,
    Denied,
    TimedOut,
    Unsupported,
    Cancelled,
    ClientDisconnected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreCommandSandboxPolicy {
    FilesystemReadOnlyV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreCommandNetworkPolicy {
    NetworkDeniedV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreCommandWorkspaceWritePolicy {
    CommandWorkspaceWriteV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreCommandWorkspaceWriteRisk {
    NonTransactionalWorkspaceTreeV1,
}

impl fmt::Display for CoreCommandSandboxPolicy {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::FilesystemReadOnlyV1 => "filesystemReadOnlyV1",
        })
    }
}

impl fmt::Display for CoreCommandNetworkPolicy {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::NetworkDeniedV1 => "networkDeniedV1",
        })
    }
}

impl fmt::Display for CoreCommandWorkspaceWritePolicy {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::CommandWorkspaceWriteV1 => "commandWorkspaceWriteV1",
        })
    }
}

impl fmt::Display for CoreCommandWorkspaceWriteRisk {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::NonTransactionalWorkspaceTreeV1 => "nonTransactionalWorkspaceTreeV1",
        })
    }
}

impl fmt::Display for CoreCommandApprovalDecision {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Approved => "approved",
            Self::Denied => "denied",
            Self::TimedOut => "timedOut",
            Self::Unsupported => "unsupported",
            Self::Cancelled => "cancelled",
            Self::ClientDisconnected => "clientDisconnected",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreToolErrorKind {
    InvalidArguments,
    UnknownTool,
    BatchRejected,
    InvalidPath,
    InvalidQuery,
    NotFound,
    AccessDenied,
    PathNotAllowed,
    NotRegularFile,
    NotDirectory,
    FileTooLarge,
    BinaryFile,
    InvalidEncoding,
    InvalidNewline,
    InvalidName,
    TooManyEntries,
    ChangedDuringRead,
    ChangedDuringList,
    SearchLimitExceeded,
    SearchTimedOut,
    ChangedDuringSearch,
    ResultTooLarge,
    HeaderCountMismatch,
    RangeOutOfBounds,
    ExpectedMismatch,
    BaseRevisionMismatch,
    UnsupportedDiffFeature,
    TooManyLines,
    LineTooLong,
    HardLinkNotAllowed,
    CrossDeviceNotAllowed,
    Conflict,
    AtomicReplaceUnavailable,
    ApprovalUnsupported,
    ApprovalDenied,
    ApprovalTimedOut,
    CommandNotFound,
    SpawnFailed,
    ProcessControlUnavailable,
    SandboxUnavailable,
    Unavailable,
}

impl fmt::Display for CoreToolErrorKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidArguments => "invalidArguments",
            Self::UnknownTool => "unknownTool",
            Self::BatchRejected => "batchRejected",
            Self::InvalidPath => "invalidPath",
            Self::InvalidQuery => "invalidQuery",
            Self::NotFound => "notFound",
            Self::AccessDenied => "accessDenied",
            Self::PathNotAllowed => "pathNotAllowed",
            Self::NotRegularFile => "notRegularFile",
            Self::NotDirectory => "notDirectory",
            Self::FileTooLarge => "fileTooLarge",
            Self::BinaryFile => "binaryFile",
            Self::InvalidEncoding => "invalidEncoding",
            Self::InvalidNewline => "invalidNewline",
            Self::InvalidName => "invalidName",
            Self::TooManyEntries => "tooManyEntries",
            Self::ChangedDuringRead => "changedDuringRead",
            Self::ChangedDuringList => "changedDuringList",
            Self::SearchLimitExceeded => "searchLimitExceeded",
            Self::SearchTimedOut => "searchTimedOut",
            Self::ChangedDuringSearch => "changedDuringSearch",
            Self::ResultTooLarge => "resultTooLarge",
            Self::HeaderCountMismatch => "headerCountMismatch",
            Self::RangeOutOfBounds => "rangeOutOfBounds",
            Self::ExpectedMismatch => "expectedMismatch",
            Self::BaseRevisionMismatch => "baseRevisionMismatch",
            Self::UnsupportedDiffFeature => "unsupportedDiffFeature",
            Self::TooManyLines => "tooManyLines",
            Self::LineTooLong => "lineTooLong",
            Self::HardLinkNotAllowed => "hardLinkNotAllowed",
            Self::CrossDeviceNotAllowed => "crossDeviceNotAllowed",
            Self::Conflict => "conflict",
            Self::AtomicReplaceUnavailable => "atomicReplaceUnavailable",
            Self::ApprovalUnsupported => "approvalUnsupported",
            Self::ApprovalDenied => "approvalDenied",
            Self::ApprovalTimedOut => "approvalTimedOut",
            Self::CommandNotFound => "commandNotFound",
            Self::SpawnFailed => "spawnFailed",
            Self::ProcessControlUnavailable => "processControlUnavailable",
            Self::SandboxUnavailable => "sandboxUnavailable",
            Self::Unavailable => "unavailable",
        })
    }
}
