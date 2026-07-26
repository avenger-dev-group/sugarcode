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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreToolErrorKind {
    InvalidPath,
    NotFound,
    AccessDenied,
    PathNotAllowed,
    NotRegularFile,
    FileTooLarge,
    BinaryFile,
    ChangedDuringRead,
    ResultTooLarge,
    Unavailable,
}

impl fmt::Display for CoreToolErrorKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidPath => "invalidPath",
            Self::NotFound => "notFound",
            Self::AccessDenied => "accessDenied",
            Self::PathNotAllowed => "pathNotAllowed",
            Self::NotRegularFile => "notRegularFile",
            Self::FileTooLarge => "fileTooLarge",
            Self::BinaryFile => "binaryFile",
            Self::ChangedDuringRead => "changedDuringRead",
            Self::ResultTooLarge => "resultTooLarge",
            Self::Unavailable => "unavailable",
        })
    }
}
