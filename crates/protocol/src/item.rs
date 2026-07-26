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
pub enum CoreItemKind {
    UserMessage {
        text: String,
    },
    AgentMessage {
        text: String,
    },
    ToolCall {
        call_id: String,
        name: String,
        path: String,
        query: Option<String>,
        command: Option<String>,
        arguments: Option<Vec<String>>,
    },
    CommandApprovalRequest {
        approval_id: String,
        call_id: String,
        command: String,
        arguments: Vec<String>,
        cwd: String,
        environment_policy: String,
        sandboxed: bool,
    },
    CommandApprovalDecision {
        approval_id: String,
        decision: CoreCommandApprovalDecision,
    },
    ToolResult {
        call_id: String,
        name: String,
        result: CoreToolResult,
    },
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
    InvalidName,
    TooManyEntries,
    ChangedDuringRead,
    ChangedDuringList,
    SearchLimitExceeded,
    SearchTimedOut,
    ChangedDuringSearch,
    ResultTooLarge,
    ApprovalUnsupported,
    ApprovalDenied,
    ApprovalTimedOut,
    CommandNotFound,
    SpawnFailed,
    ProcessControlUnavailable,
    Unavailable,
}

impl fmt::Display for CoreToolErrorKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
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
            Self::InvalidName => "invalidName",
            Self::TooManyEntries => "tooManyEntries",
            Self::ChangedDuringRead => "changedDuringRead",
            Self::ChangedDuringList => "changedDuringList",
            Self::SearchLimitExceeded => "searchLimitExceeded",
            Self::SearchTimedOut => "searchTimedOut",
            Self::ChangedDuringSearch => "changedDuringSearch",
            Self::ResultTooLarge => "resultTooLarge",
            Self::ApprovalUnsupported => "approvalUnsupported",
            Self::ApprovalDenied => "approvalDenied",
            Self::ApprovalTimedOut => "approvalTimedOut",
            Self::CommandNotFound => "commandNotFound",
            Self::SpawnFailed => "spawnFailed",
            Self::ProcessControlUnavailable => "processControlUnavailable",
            Self::Unavailable => "unavailable",
        })
    }
}
