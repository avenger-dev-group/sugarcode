use crate::ModelError;
use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use std::fmt;

pub type ModelStream = BoxStream<'static, Result<ModelEvent, ModelError>>;
pub type BoxModelFuture<'a> = BoxFuture<'a, Result<ModelStream, ModelError>>;
pub const WORKSPACE_ROOT_AGENTS_INSTRUCTION_PREFIX: &str = "Workspace instructions from the opened workspace root AGENTS.md \
     (boundedWorkspaceInstructionsV1):\n\n";
pub const WORKSPACE_AGENTS_HIERARCHY_INSTRUCTION_PREFIX: &str = "Workspace instructions discovered from the opened workspace root to the active workspace \
     scope (boundedNestedWorkspaceInstructionsV1). All entries apply. If entries conflict, the \
     later, deeper entry overrides the earlier, shallower entry.\n\n";

#[derive(Clone, PartialEq, Eq)]
pub struct ModelRequest {
    pub model: String,
    pub instructions: Vec<ModelInstruction>,
    pub messages: Vec<ModelMessage>,
    pub tools: Vec<ModelToolDefinition>,
}

impl fmt::Debug for ModelRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ModelRequest")
            .field("model", &"<redacted>")
            .field("instruction_count", &self.instructions.len())
            .field("message_count", &self.messages.len())
            .field("tool_count", &self.tools.len())
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ModelInstruction {
    pub source: ModelInstructionSource,
    pub content: String,
}

impl ModelInstruction {
    pub fn rendered_content(&self) -> String {
        format!("{}{}", self.source.prefix(), self.content)
    }

    pub fn context_bytes(&self) -> usize {
        self.source.prefix().len() + self.content.len()
    }
}

impl fmt::Debug for ModelInstruction {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ModelInstruction")
            .field("source", &self.source)
            .field("content", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelInstructionSource {
    WorkspaceRootAgentsV1,
    WorkspaceAgentsHierarchyV1,
}

impl ModelInstructionSource {
    fn prefix(self) -> &'static str {
        match self {
            Self::WorkspaceRootAgentsV1 => WORKSPACE_ROOT_AGENTS_INSTRUCTION_PREFIX,
            Self::WorkspaceAgentsHierarchyV1 => WORKSPACE_AGENTS_HIERARCHY_INSTRUCTION_PREFIX,
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub enum ModelMessage {
    Text { role: ModelRole, text: String },
    ToolCall(ModelToolCall),
    ToolResult { call_id: String, content: String },
}

impl fmt::Debug for ModelMessage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Text { role, .. } => formatter
                .debug_struct("Text")
                .field("role", role)
                .field("text", &"<redacted>")
                .finish(),
            Self::ToolCall(call) => formatter.debug_tuple("ToolCall").field(call).finish(),
            Self::ToolResult { call_id, .. } => formatter
                .debug_struct("ToolResult")
                .field("call_id", call_id)
                .field("content", &"<redacted>")
                .finish(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelRole {
    User,
    Assistant,
}

#[derive(Clone, PartialEq, Eq)]
pub enum ModelEvent {
    TextDelta(String),
    ToolCall(ModelToolCall),
    Usage(ModelUsage),
    Completed,
}

impl fmt::Debug for ModelEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TextDelta(delta) => formatter
                .debug_tuple("TextDelta")
                .field(&format_args!("{} bytes", delta.len()))
                .finish(),
            Self::ToolCall(call) => formatter.debug_tuple("ToolCall").field(call).finish(),
            Self::Usage(usage) => formatter.debug_tuple("Usage").field(usage).finish(),
            Self::Completed => formatter.write_str("Completed"),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ModelToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

impl fmt::Debug for ModelToolDefinition {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ModelToolDefinition")
            .field("name", &self.name)
            .field("description", &"<redacted>")
            .field("parameters", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ModelToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

impl fmt::Debug for ModelToolCall {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ModelToolCall")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("arguments", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ModelUsage {
    pub input_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub reasoning_output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

pub trait ModelProvider: fmt::Debug + Send + Sync {
    fn stream(&self, request: ModelRequest) -> BoxModelFuture<'_>;
}
