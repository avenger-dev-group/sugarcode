use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::error::Error;
use std::fmt;
use sugarcode_model_provider::ModelInstruction;
use sugarcode_protocol::CoreContentAsset;
use sugarcode_protocol::CoreEvent;
use sugarcode_protocol::CoreEventKind;
use sugarcode_protocol::CoreItemKind;
use sugarcode_protocol::CoreItemSnapshot;
use sugarcode_protocol::CoreRequestId;
use sugarcode_protocol::CoreToolResult;
use sugarcode_protocol::CoreUserContentPart;
use sugarcode_protocol::ItemId;
use sugarcode_protocol::ThreadId;
use sugarcode_protocol::TurnId;
use sugarcode_state::DurableContextCompaction;
use sugarcode_state::DurableItemSnapshot;
use sugarcode_state::DurableModelSelectionSnapshot;
use sugarcode_state::DurableThreadLifecycle;
use sugarcode_state::DurableThreadOrigin;
use sugarcode_state::DurableThreadPage;
use sugarcode_state::DurableThreadSnapshot;
use sugarcode_state::DurableThreadSummary;
use sugarcode_state::DurableToolResult;
use sugarcode_state::DurableTurnError;
use sugarcode_state::DurableTurnErrorKind;
use sugarcode_state::DurableTurnSnapshot;
use sugarcode_state::DurableTurnStatus;
use sugarcode_state::DurableUsage;
use sugarcode_state::DurableWorkspaceInstructionsAudit;
use sugarcode_state::DurableWorkspaceSkillsAudit;
use sugarcode_state::RolloutError;
use sugarcode_state::ThreadRepository;
use sugarcode_state::terminal_turn_record_fits;

mod api;
mod memory_repository;
mod snapshots;

use memory_repository::MemoryThreadRepository;
use snapshots::{
    core_tool_error_kind, core_tool_result, durable_item_snapshot, durable_thread_snapshot,
    item_from_snapshot, map_repository_error, tool_result_content,
};

const DETERMINISTIC_AGENT_MESSAGE: &str = "SugarCode deterministic response.";
pub const MAX_AGENT_MESSAGE_BYTES: usize = 512 * 1024;
pub const MAX_AGENT_COMMENTARY_BYTES: usize = 512;
pub const MAX_PROVIDER_HISTORY_BYTES: usize = crate::context::MAX_PROVIDER_CONTEXT_BYTES;
pub const MAX_USER_MESSAGE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedTextTurn {
    pub request_id: CoreRequestId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub user_item: Option<CoreItemSnapshot>,
    pub model: Option<DurableModelSelectionSnapshot>,
    pub history: Vec<PreparedMessage>,
    pub current_input_index: Option<usize>,
    pub instructions: Vec<ModelInstruction>,
    pub workspace_instructions: Option<DurableWorkspaceInstructionsAudit>,
    pub workspace_skills: Option<DurableWorkspaceSkillsAudit>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreparedMessage {
    UserContent {
        content: Vec<CoreUserContentPart>,
    },
    Text {
        role: PreparedMessageRole,
        text: String,
    },
    Commentary {
        text: String,
    },
    ContextCompaction {
        content: String,
    },
    ToolCall {
        call_id: String,
        name: String,
        arguments: serde_json::Value,
    },
    ToolResult {
        call_id: String,
        content: String,
    },
    McpToolCall {
        call_id: String,
        name: String,
        arguments: serde_json::Value,
    },
    McpToolResult {
        call_id: String,
        content: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreparedMessageRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnStartOutcome {
    Immediate(Vec<CoreEvent>),
    Accepted { turn_id: TurnId },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnInterruptOutcome {
    Accepted,
    AlreadyTerminal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Thread {
    id: ThreadId,
    origin: Option<DurableThreadOrigin>,
    turns: BTreeMap<TurnId, Turn>,
    active_turn_id: Option<TurnId>,
    lifecycle: DurableThreadLifecycle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TurnState {
    InProgress,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Turn {
    id: TurnId,
    request_id: CoreRequestId,
    state: TurnState,
    items: BTreeMap<ItemId, Item>,
    active_item_id: Option<ItemId>,
    model: Option<DurableModelSelectionSnapshot>,
    context_compaction: Option<DurableContextCompaction>,
    workspace_instructions: Option<DurableWorkspaceInstructionsAudit>,
    workspace_skills: Option<DurableWorkspaceSkillsAudit>,
    error: Option<DurableTurnError>,
    usage: Option<DurableUsage>,
}

impl Turn {
    fn new(id: TurnId, request_id: CoreRequestId) -> Self {
        Self {
            id,
            request_id,
            state: TurnState::InProgress,
            items: BTreeMap::new(),
            active_item_id: None,
            model: None,
            context_compaction: None,
            workspace_instructions: None,
            workspace_skills: None,
            error: None,
            usage: None,
        }
    }

    fn add_item(&mut self, item: Item) -> Result<(), CoreError> {
        if self.state != TurnState::InProgress {
            return Err(CoreError::TurnNotInProgress(self.id.clone()));
        }
        if self.active_item_id.is_some() {
            return Err(CoreError::Internal(
                "cannot add an item while another item is active".to_string(),
            ));
        }
        self.active_item_id = Some(item.id.clone());
        self.items.insert(item.id.clone(), item);
        Ok(())
    }

    fn complete_active_item_and_turn(&mut self) -> Result<CoreItemSnapshot, CoreError> {
        if self.state != TurnState::InProgress {
            return Err(CoreError::TurnNotInProgress(self.id.clone()));
        }
        let item_id = self.active_item_id.clone().ok_or_else(|| {
            CoreError::Internal("cannot complete a turn without an active item".to_string())
        })?;
        let item = self.items.get_mut(&item_id).ok_or_else(|| {
            CoreError::Internal("active item is missing from its turn".to_string())
        })?;
        if item.state != ItemState::InProgress {
            return Err(CoreError::Internal(
                "active item is not in progress".to_string(),
            ));
        }

        item.complete()?;
        let snapshot = item.snapshot();
        self.active_item_id = None;
        self.state = TurnState::Completed;
        Ok(snapshot)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ItemState {
    InProgress,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Item {
    id: ItemId,
    state: ItemState,
    kind: ItemKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ItemKind {
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
        strategy: sugarcode_protocol::CoreContextCompactionStrategy,
        ordinal: u64,
        pre_context_bytes: u64,
        source_messages: u64,
        source_bytes: u64,
        source_sha256: String,
        outcome: Option<sugarcode_protocol::CoreContextCompactionOutcome>,
        summary: Option<PrivateCompactionSummary>,
    },
    ToolCall {
        call_id: String,
        name: String,
        arguments: serde_json::Value,
    },
    ToolValidationRejected {
        call_id: String,
        name: String,
        kind: sugarcode_protocol::CoreToolErrorKind,
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
        kind: sugarcode_protocol::CoreFileChangeKind,
        diff: String,
        before_sha256: String,
        after_sha256: String,
        before_bytes: u64,
        after_bytes: u64,
        newline_style: sugarcode_protocol::CoreFileChangeNewlineStyle,
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
        sandbox_policy: Option<sugarcode_protocol::CoreCommandSandboxPolicy>,
        workspace_write_policy: Option<sugarcode_protocol::CoreCommandWorkspaceWritePolicy>,
        workspace_write_risk: Option<sugarcode_protocol::CoreCommandWorkspaceWriteRisk>,
        network_policy: Option<sugarcode_protocol::CoreCommandNetworkPolicy>,
    },
    CommandApprovalDecision {
        approval_id: String,
        decision: sugarcode_protocol::CoreCommandApprovalDecision,
        workspace_write_risk_acknowledgement:
            Option<sugarcode_protocol::CoreCommandWorkspaceWriteRisk>,
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
        decision: sugarcode_protocol::CoreCommandApprovalDecision,
    },
    McpToolExecutionAttempt {
        approval_id: String,
        call_id: String,
        inventory_sha256: String,
    },
    McpToolResult {
        call_id: String,
        name: String,
        result: sugarcode_protocol::CoreMcpToolResult,
    },
    ToolResult {
        call_id: String,
        name: String,
        result: CoreToolResult,
    },
}

#[derive(Clone, PartialEq, Eq)]
struct PrivateCompactionSummary(String);

impl PrivateCompactionSummary {
    fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<String> for PrivateCompactionSummary {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl fmt::Debug for PrivateCompactionSummary {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PrivateCompactionSummary")
            .field("bytes", &self.0.len())
            .finish_non_exhaustive()
    }
}

impl Item {
    fn new_agent_message(id: ItemId) -> Self {
        Self {
            id,
            state: ItemState::InProgress,
            kind: ItemKind::AgentMessage {
                text: String::new(),
            },
        }
    }

    fn append_agent_message_delta(&mut self, delta: &str) -> Result<(), CoreError> {
        if self.state != ItemState::InProgress {
            return Err(CoreError::ItemNotInProgress(self.id.clone()));
        }
        match &mut self.kind {
            ItemKind::AgentMessage { text } => {
                text.push_str(delta);
                Ok(())
            }
            ItemKind::UserMessage { .. } => Err(CoreError::Internal(
                "cannot append an agent delta to a user message".to_string(),
            )),
            ItemKind::AgentCommentary { .. }
            | ItemKind::ContextCompaction { .. }
            | ItemKind::AgentTask { .. }
            | ItemKind::AgentTaskAmendment { .. }
            | ItemKind::AgentTaskResult { .. }
            | ItemKind::ToolCall { .. }
            | ItemKind::ToolValidationRejected { .. }
            | ItemKind::FileChange { .. }
            | ItemKind::CommandApprovalRequest { .. }
            | ItemKind::CommandApprovalDecision { .. }
            | ItemKind::CommandExecutionAttempt { .. }
            | ItemKind::McpToolCall { .. }
            | ItemKind::McpToolCallApprovalRequest { .. }
            | ItemKind::McpToolCallApprovalDecision { .. }
            | ItemKind::McpToolExecutionAttempt { .. }
            | ItemKind::McpToolResult { .. }
            | ItemKind::ToolResult { .. } => Err(CoreError::Internal(
                "cannot append an agent delta to a tool item".to_string(),
            )),
        }
    }

    fn complete(&mut self) -> Result<(), CoreError> {
        if self.state != ItemState::InProgress {
            return Err(CoreError::ItemNotInProgress(self.id.clone()));
        }
        self.state = ItemState::Completed;
        Ok(())
    }

    fn snapshot(&self) -> CoreItemSnapshot {
        let kind = match &self.kind {
            ItemKind::UserMessage { content } => CoreItemKind::UserMessage {
                content: content.clone(),
            },
            ItemKind::AgentMessage { text } => CoreItemKind::AgentMessage { text: text.clone() },
            ItemKind::AgentCommentary { text } => {
                CoreItemKind::AgentCommentary { text: text.clone() }
            }
            ItemKind::AgentTask {
                orchestration_id,
                task_id,
                client_task_key,
                child_thread_id,
                title,
                role,
                access,
                depends_on,
                task_markdown,
            } => CoreItemKind::AgentTask {
                orchestration_id: orchestration_id.clone(),
                task_id: task_id.clone(),
                client_task_key: client_task_key.clone(),
                child_thread_id: child_thread_id.clone(),
                title: title.clone(),
                role: role.clone(),
                access: access.clone(),
                depends_on: depends_on.clone(),
                task_markdown: task_markdown.clone(),
            },
            ItemKind::AgentTaskAmendment {
                orchestration_id,
                task_id,
                amendment_markdown,
            } => CoreItemKind::AgentTaskAmendment {
                orchestration_id: orchestration_id.clone(),
                task_id: task_id.clone(),
                amendment_markdown: amendment_markdown.clone(),
            },
            ItemKind::AgentTaskResult {
                orchestration_id,
                task_id,
                status,
                summary_markdown,
                duration_ms,
            } => CoreItemKind::AgentTaskResult {
                orchestration_id: orchestration_id.clone(),
                task_id: task_id.clone(),
                status: status.clone(),
                summary_markdown: summary_markdown.clone(),
                duration_ms: *duration_ms,
            },
            ItemKind::ContextCompaction {
                strategy,
                ordinal,
                pre_context_bytes,
                source_messages,
                source_bytes,
                source_sha256,
                outcome,
                ..
            } => CoreItemKind::ContextCompaction {
                strategy: *strategy,
                ordinal: *ordinal,
                pre_context_bytes: *pre_context_bytes,
                source_messages: *source_messages,
                source_bytes: *source_bytes,
                source_sha256: source_sha256.clone(),
                outcome: outcome.clone(),
            },
            ItemKind::ToolCall {
                call_id,
                name,
                arguments,
            } => CoreItemKind::ToolCall {
                call_id: call_id.clone(),
                name: name.clone(),
                arguments: arguments.clone(),
            },
            ItemKind::ToolValidationRejected {
                call_id,
                name,
                kind,
                arguments_bytes,
                arguments_sha256,
                edit_index,
                hunk_index,
                line,
                expected_summary,
                actual_summary,
                suggested_action,
            } => CoreItemKind::ToolValidationRejected {
                call_id: call_id.clone(),
                name: name.clone(),
                kind: *kind,
                arguments_bytes: *arguments_bytes,
                arguments_sha256: arguments_sha256.clone(),
                edit_index: *edit_index,
                hunk_index: *hunk_index,
                line: *line,
                expected_summary: expected_summary.clone(),
                actual_summary: actual_summary.clone(),
                suggested_action: suggested_action.clone(),
            },
            ItemKind::FileChange {
                call_id,
                path,
                kind,
                diff,
                before_sha256,
                after_sha256,
                before_bytes,
                after_bytes,
                newline_style,
                final_newline,
            } => CoreItemKind::FileChange {
                call_id: call_id.clone(),
                path: path.clone(),
                kind: *kind,
                diff: diff.clone(),
                before_sha256: before_sha256.clone(),
                after_sha256: after_sha256.clone(),
                before_bytes: *before_bytes,
                after_bytes: *after_bytes,
                newline_style: *newline_style,
                final_newline: *final_newline,
            },
            ItemKind::CommandApprovalRequest {
                approval_id,
                call_id,
                command,
                arguments,
                cwd,
                environment_policy,
                sandboxed,
                sandbox_policy,
                workspace_write_policy,
                workspace_write_risk,
                network_policy,
            } => CoreItemKind::CommandApprovalRequest {
                approval_id: approval_id.clone(),
                call_id: call_id.clone(),
                command: command.clone(),
                arguments: arguments.clone(),
                cwd: cwd.clone(),
                environment_policy: environment_policy.clone(),
                sandboxed: *sandboxed,
                sandbox_policy: *sandbox_policy,
                workspace_write_policy: *workspace_write_policy,
                workspace_write_risk: *workspace_write_risk,
                network_policy: *network_policy,
            },
            ItemKind::CommandApprovalDecision {
                approval_id,
                decision,
                workspace_write_risk_acknowledgement,
            } => CoreItemKind::CommandApprovalDecision {
                approval_id: approval_id.clone(),
                decision: *decision,
                workspace_write_risk_acknowledgement: *workspace_write_risk_acknowledgement,
            },
            ItemKind::CommandExecutionAttempt {
                approval_id,
                call_id,
            } => CoreItemKind::CommandExecutionAttempt {
                approval_id: approval_id.clone(),
                call_id: call_id.clone(),
            },
            ItemKind::McpToolCall {
                call_id,
                name,
                arguments,
                arguments_bytes,
                arguments_sha256,
                inventory_sha256,
            } => CoreItemKind::McpToolCall {
                call_id: call_id.clone(),
                name: name.clone(),
                arguments: arguments.clone(),
                arguments_bytes: *arguments_bytes,
                arguments_sha256: arguments_sha256.clone(),
                inventory_sha256: inventory_sha256.clone(),
            },
            ItemKind::McpToolCallApprovalRequest {
                approval_id,
                call_id,
                name,
                arguments,
                arguments_bytes,
                arguments_sha256,
                inventory_sha256,
            } => CoreItemKind::McpToolCallApprovalRequest {
                approval_id: approval_id.clone(),
                call_id: call_id.clone(),
                name: name.clone(),
                arguments: arguments.clone(),
                arguments_bytes: *arguments_bytes,
                arguments_sha256: arguments_sha256.clone(),
                inventory_sha256: inventory_sha256.clone(),
            },
            ItemKind::McpToolCallApprovalDecision {
                approval_id,
                decision,
            } => CoreItemKind::McpToolCallApprovalDecision {
                approval_id: approval_id.clone(),
                decision: *decision,
            },
            ItemKind::McpToolExecutionAttempt {
                approval_id,
                call_id,
                inventory_sha256,
            } => CoreItemKind::McpToolExecutionAttempt {
                approval_id: approval_id.clone(),
                call_id: call_id.clone(),
                inventory_sha256: inventory_sha256.clone(),
            },
            ItemKind::McpToolResult {
                call_id,
                name,
                result,
            } => CoreItemKind::McpToolResult {
                call_id: call_id.clone(),
                name: name.clone(),
                result: result.clone(),
            },
            ItemKind::ToolResult {
                call_id,
                name,
                result,
            } => CoreItemKind::ToolResult {
                call_id: call_id.clone(),
                name: name.clone(),
                result: result.clone(),
            },
        };
        CoreItemSnapshot {
            id: self.id.clone(),
            kind,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreError {
    ThreadIdExhausted,
    TurnIdExhausted,
    ItemIdExhausted,
    ThreadNotFound(ThreadId),
    NoActiveTurn(ThreadId),
    TurnAlreadyActive {
        thread_id: ThreadId,
        turn_id: TurnId,
    },
    TurnNotInProgress(TurnId),
    ItemNotInProgress(ItemId),
    InvalidInput,
    ContextTooLarge,
    ModelUnavailable,
    OutputTooLarge,
    StateUnavailable,
    Internal(String),
}

impl fmt::Display for CoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ThreadIdExhausted => formatter.write_str("thread ID sequence exhausted"),
            Self::TurnIdExhausted => formatter.write_str("turn ID sequence exhausted"),
            Self::ItemIdExhausted => formatter.write_str("item ID sequence exhausted"),
            Self::ThreadNotFound(thread_id) => write!(formatter, "thread not found: {thread_id}"),
            Self::NoActiveTurn(thread_id) => {
                write!(formatter, "thread has no active turn: {thread_id}")
            }
            Self::TurnAlreadyActive { thread_id, turn_id } => write!(
                formatter,
                "thread {thread_id} already has an active turn: {turn_id}"
            ),
            Self::TurnNotInProgress(turn_id) => {
                write!(formatter, "turn is not in progress: {turn_id}")
            }
            Self::ItemNotInProgress(item_id) => {
                write!(formatter, "item is not in progress: {item_id}")
            }
            Self::InvalidInput => formatter.write_str("invalid user input"),
            Self::ContextTooLarge => formatter.write_str("model context is too large"),
            Self::ModelUnavailable => formatter.write_str("model is unavailable"),
            Self::OutputTooLarge => formatter.write_str("model output is too large"),
            Self::StateUnavailable => formatter.write_str("durable state is unavailable"),
            Self::Internal(message) => formatter.write_str(message),
        }
    }
}

impl Error for CoreError {}

pub trait CoreApi {
    fn start_thread(&mut self, request_id: CoreRequestId) -> Result<CoreEvent, CoreError>;
    fn contains_thread(&self, thread_id: &ThreadId) -> bool;
    fn list_threads(
        &mut self,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, CoreError>;
    fn search_threads(
        &mut self,
        _query: &str,
        _cursor: Option<&ThreadId>,
        _limit: usize,
    ) -> Result<DurableThreadPage, CoreError> {
        Err(CoreError::StateUnavailable)
    }
    fn archive_thread(&mut self, _thread_id: &ThreadId) -> Result<(), CoreError> {
        Err(CoreError::StateUnavailable)
    }
    fn unarchive_thread(&mut self, _thread_id: &ThreadId) -> Result<(), CoreError> {
        Err(CoreError::StateUnavailable)
    }
    fn delete_thread(&mut self, _thread_id: &ThreadId) -> Result<(), CoreError> {
        Err(CoreError::StateUnavailable)
    }
    fn fork_thread(&mut self, _thread_id: &ThreadId) -> Result<DurableThreadSnapshot, CoreError> {
        Err(CoreError::StateUnavailable)
    }
    fn resume_thread(&mut self, thread_id: &ThreadId) -> Result<DurableThreadSnapshot, CoreError>;
    fn list_descendants(
        &mut self,
        _thread_id: &ThreadId,
    ) -> Result<Vec<DurableThreadSnapshot>, CoreError> {
        Err(CoreError::StateUnavailable)
    }
    fn start_turn(
        &mut self,
        request_id: CoreRequestId,
        thread_id: ThreadId,
    ) -> Result<Vec<CoreEvent>, CoreError>;
    fn start_text_turn(
        &mut self,
        request_id: CoreRequestId,
        thread_id: ThreadId,
        _input: Option<String>,
    ) -> Result<TurnStartOutcome, CoreError> {
        self.start_turn(request_id, thread_id)
            .map(TurnStartOutcome::Immediate)
    }
    fn start_text_turn_with_model(
        &mut self,
        request_id: CoreRequestId,
        thread_id: ThreadId,
        input: Option<String>,
        _model_profile_id: Option<String>,
    ) -> Result<TurnStartOutcome, CoreError> {
        self.start_text_turn(request_id, thread_id, input)
    }
    fn start_content_turn_with_model(
        &mut self,
        request_id: CoreRequestId,
        thread_id: ThreadId,
        input: Option<Vec<CoreUserContentPart>>,
        model_profile_id: Option<String>,
    ) -> Result<TurnStartOutcome, CoreError> {
        let text = match input {
            None => None,
            Some(content) => match content.as_slice() {
                [CoreUserContentPart::Text { text }] => Some(text.clone()),
                _ => return Err(CoreError::InvalidInput),
            },
        };
        self.start_text_turn_with_model(request_id, thread_id, text, model_profile_id)
    }
    fn interrupt_turn(
        &mut self,
        _thread_id: &ThreadId,
        _turn_id: &TurnId,
    ) -> Result<TurnInterruptOutcome, CoreError> {
        Ok(TurnInterruptOutcome::AlreadyTerminal)
    }
    fn shutdown(&mut self) -> BoxFuture<'static, Result<(), CoreError>> {
        async { Ok(()) }.boxed()
    }
}

#[derive(Debug)]
pub struct Core {
    threads: BTreeMap<ThreadId, Thread>,
    repository: Box<dyn ThreadRepository>,
}

impl Core {
    pub fn new() -> Self {
        Self::with_repository(Box::new(MemoryThreadRepository::default()))
    }

    pub fn with_repository(repository: Box<dyn ThreadRepository>) -> Self {
        Self {
            threads: BTreeMap::new(),
            repository,
        }
    }

    pub fn latest_model_profile_id(&self, thread_id: &ThreadId) -> Option<String> {
        self.latest_model_selection(thread_id)
            .map(|model| model.profile_id)
    }

    pub fn latest_model_selection(
        &self,
        thread_id: &ThreadId,
    ) -> Option<DurableModelSelectionSnapshot> {
        self.threads
            .get(thread_id)?
            .turns
            .values()
            .rev()
            .find_map(|turn| turn.model.clone())
    }

    pub fn thread_count(&self) -> usize {
        self.threads.len()
    }

    pub fn contains_thread(&self, thread_id: &ThreadId) -> bool {
        self.threads.get(thread_id).is_some_and(|thread| {
            &thread.id == thread_id && thread.lifecycle == DurableThreadLifecycle::Active
        })
    }

    pub fn turn_count(&self, thread_id: &ThreadId) -> usize {
        self.threads
            .get(thread_id)
            .map_or(0, |thread| thread.turns.len())
    }

    pub fn contains_turn(&self, thread_id: &ThreadId, turn_id: &TurnId) -> bool {
        self.threads
            .get(thread_id)
            .and_then(|thread| thread.turns.get(turn_id))
            .is_some_and(|turn| &turn.id == turn_id)
    }

    fn materialize_snapshot(&mut self, snapshot: &DurableThreadSnapshot) {
        let mut turns = BTreeMap::new();
        for durable_turn in &snapshot.turns {
            let mut items = BTreeMap::new();
            for durable_item in &durable_turn.items {
                let item = match durable_item {
                    DurableItemSnapshot::UserMessage { id, content } => Item {
                        id: id.clone(),
                        state: ItemState::Completed,
                        kind: ItemKind::UserMessage {
                            content: content.iter().map(core_user_content_part).collect(),
                        },
                    },
                    DurableItemSnapshot::AgentMessage { id, text } => Item {
                        id: id.clone(),
                        state: ItemState::Completed,
                        kind: ItemKind::AgentMessage { text: text.clone() },
                    },
                    DurableItemSnapshot::AgentCommentary { id, text } => Item {
                        id: id.clone(),
                        state: ItemState::Completed,
                        kind: ItemKind::AgentCommentary { text: text.clone() },
                    },
                    DurableItemSnapshot::AgentTask {
                        id,
                        orchestration_id,
                        task_id,
                        client_task_key,
                        child_thread_id,
                        title,
                        role,
                        access,
                        depends_on,
                        task_markdown,
                    } => Item {
                        id: id.clone(),
                        state: ItemState::Completed,
                        kind: ItemKind::AgentTask {
                            orchestration_id: orchestration_id.clone(),
                            task_id: task_id.clone(),
                            client_task_key: client_task_key.clone(),
                            child_thread_id: child_thread_id.clone(),
                            title: title.clone(),
                            role: role.clone(),
                            access: access.clone(),
                            depends_on: depends_on.clone(),
                            task_markdown: task_markdown.clone(),
                        },
                    },
                    DurableItemSnapshot::AgentTaskAmendment {
                        id,
                        orchestration_id,
                        task_id,
                        amendment_markdown,
                    } => Item {
                        id: id.clone(),
                        state: ItemState::Completed,
                        kind: ItemKind::AgentTaskAmendment {
                            orchestration_id: orchestration_id.clone(),
                            task_id: task_id.clone(),
                            amendment_markdown: amendment_markdown.clone(),
                        },
                    },
                    DurableItemSnapshot::AgentTaskResult {
                        id,
                        orchestration_id,
                        task_id,
                        status,
                        summary_markdown,
                        duration_ms,
                    } => Item {
                        id: id.clone(),
                        state: ItemState::Completed,
                        kind: ItemKind::AgentTaskResult {
                            orchestration_id: orchestration_id.clone(),
                            task_id: task_id.clone(),
                            status: status.clone(),
                            summary_markdown: summary_markdown.clone(),
                            duration_ms: *duration_ms,
                        },
                    },
                    DurableItemSnapshot::ContextCompaction {
                        id,
                        strategy,
                        ordinal,
                        pre_context_bytes,
                        source_messages,
                        source_bytes,
                        source_sha256,
                        outcome,
                        summary,
                    } => Item {
                        id: id.clone(),
                        state: ItemState::Completed,
                        kind: ItemKind::ContextCompaction {
                            strategy: match strategy.as_str() {
                                "modelGeneratedActiveTurnV1" => sugarcode_protocol::CoreContextCompactionStrategy::ModelGeneratedActiveTurnV1,
                                _ => continue,
                            },
                            ordinal: *ordinal,
                            pre_context_bytes: *pre_context_bytes,
                            source_messages: *source_messages,
                            source_bytes: *source_bytes,
                            source_sha256: source_sha256.clone(),
                            outcome: outcome.as_ref().map(core_context_compaction_outcome),
                            summary: summary
                                .as_ref()
                                .map(|summary| summary.as_str().to_string().into()),
                        },
                    },
                    DurableItemSnapshot::ToolCall {
                        id,
                        call_id,
                        name,
                        arguments,
                    } => Item {
                        id: id.clone(),
                        state: ItemState::Completed,
                        kind: ItemKind::ToolCall {
                            call_id: call_id.clone(),
                            name: name.clone(),
                            arguments: arguments.clone(),
                        },
                    },
                    DurableItemSnapshot::ToolValidationRejected {
                        id,
                        call_id,
                        name,
                        kind,
                        arguments_bytes,
                        arguments_sha256,
                        edit_index,
                        hunk_index,
                        line,
                        expected_summary,
                        actual_summary,
                        suggested_action,
                    } => Item {
                        id: id.clone(),
                        state: ItemState::Completed,
                        kind: ItemKind::ToolValidationRejected {
                            call_id: call_id.clone(),
                            name: name.clone(),
                            kind: core_tool_error_kind(kind),
                            arguments_bytes: *arguments_bytes,
                            arguments_sha256: arguments_sha256.clone(),
                            edit_index: *edit_index,
                            hunk_index: *hunk_index,
                            line: *line,
                            expected_summary: expected_summary.clone(),
                            actual_summary: actual_summary.clone(),
                            suggested_action: suggested_action.clone(),
                        },
                    },
                    DurableItemSnapshot::FileChange {
                        id,
                        call_id,
                        path,
                        kind,
                        diff,
                        before_sha256,
                        after_sha256,
                        before_bytes,
                        after_bytes,
                        newline_style,
                        final_newline,
                    } => Item {
                        id: id.clone(),
                        state: ItemState::Completed,
                        kind: ItemKind::FileChange {
                            call_id: call_id.clone(),
                            path: path.clone(),
                            kind: match kind.as_str() {
                                "update" => sugarcode_protocol::CoreFileChangeKind::Update,
                                _ => sugarcode_protocol::CoreFileChangeKind::Update,
                            },
                            diff: diff.clone(),
                            before_sha256: before_sha256.clone(),
                            after_sha256: after_sha256.clone(),
                            before_bytes: *before_bytes,
                            after_bytes: *after_bytes,
                            newline_style: match newline_style.as_str() {
                                "crLf" => sugarcode_protocol::CoreFileChangeNewlineStyle::CrLf,
                                _ => sugarcode_protocol::CoreFileChangeNewlineStyle::Lf,
                            },
                            final_newline: *final_newline,
                        },
                    },
                    DurableItemSnapshot::CommandApprovalRequest {
                        id,
                        approval_id,
                        call_id,
                        command,
                        arguments,
                        cwd,
                        environment_policy,
                        sandboxed,
                        sandbox_policy,
                        workspace_write_policy,
                        workspace_write_risk,
                        network_policy,
                    } => Item {
                        id: id.clone(),
                        state: ItemState::Completed,
                        kind: ItemKind::CommandApprovalRequest {
                            approval_id: approval_id.clone(),
                            call_id: call_id.clone(),
                            command: command.clone(),
                            arguments: arguments.clone(),
                            cwd: cwd.clone(),
                            environment_policy: environment_policy.clone(),
                            sandboxed: *sandboxed,
                            sandbox_policy: command_sandbox_policy(sandbox_policy.as_deref()),
                            workspace_write_policy: command_workspace_write_policy(
                                workspace_write_policy.as_deref(),
                            ),
                            workspace_write_risk: command_workspace_write_risk(
                                workspace_write_risk.as_deref(),
                            ),
                            network_policy: command_network_policy(network_policy.as_deref()),
                        },
                    },
                    DurableItemSnapshot::CommandApprovalDecision {
                        id,
                        approval_id,
                        decision,
                        workspace_write_risk_acknowledgement,
                    } => Item {
                        id: id.clone(),
                        state: ItemState::Completed,
                        kind: ItemKind::CommandApprovalDecision {
                            approval_id: approval_id.clone(),
                            decision: match decision.as_str() {
                                "approved" => {
                                    sugarcode_protocol::CoreCommandApprovalDecision::Approved
                                }
                                "denied" => {
                                    sugarcode_protocol::CoreCommandApprovalDecision::Denied
                                }
                                "timedOut" => {
                                    sugarcode_protocol::CoreCommandApprovalDecision::TimedOut
                                }
                                "unsupported" => {
                                    sugarcode_protocol::CoreCommandApprovalDecision::Unsupported
                                }
                                "cancelled" => {
                                    sugarcode_protocol::CoreCommandApprovalDecision::Cancelled
                                }
                                _ => sugarcode_protocol::CoreCommandApprovalDecision::ClientDisconnected,
                            },
                            workspace_write_risk_acknowledgement:
                                command_workspace_write_risk(
                                    workspace_write_risk_acknowledgement.as_deref(),
                                ),
                        },
                    },
                    DurableItemSnapshot::CommandExecutionAttempt {
                        id,
                        approval_id,
                        call_id,
                    } => Item {
                        id: id.clone(),
                        state: ItemState::Completed,
                        kind: ItemKind::CommandExecutionAttempt {
                            approval_id: approval_id.clone(),
                            call_id: call_id.clone(),
                        },
                    },
                    DurableItemSnapshot::McpToolCall {
                        id,
                        call_id,
                        name,
                        arguments,
                        arguments_bytes,
                        arguments_sha256,
                        inventory_sha256,
                    } => Item {
                        id: id.clone(),
                        state: ItemState::Completed,
                        kind: ItemKind::McpToolCall {
                            call_id: call_id.clone(),
                            name: name.clone(),
                            arguments: arguments.clone(),
                            arguments_bytes: *arguments_bytes,
                            arguments_sha256: arguments_sha256.clone(),
                            inventory_sha256: inventory_sha256.clone(),
                        },
                    },
                    DurableItemSnapshot::McpToolCallApprovalRequest {
                        id,
                        approval_id,
                        call_id,
                        name,
                        arguments,
                        arguments_bytes,
                        arguments_sha256,
                        inventory_sha256,
                    } => Item {
                        id: id.clone(),
                        state: ItemState::Completed,
                        kind: ItemKind::McpToolCallApprovalRequest {
                            approval_id: approval_id.clone(),
                            call_id: call_id.clone(),
                            name: name.clone(),
                            arguments: arguments.clone(),
                            arguments_bytes: *arguments_bytes,
                            arguments_sha256: arguments_sha256.clone(),
                            inventory_sha256: inventory_sha256.clone(),
                        },
                    },
                    DurableItemSnapshot::McpToolCallApprovalDecision {
                        id,
                        approval_id,
                        decision,
                    } => Item {
                        id: id.clone(),
                        state: ItemState::Completed,
                        kind: ItemKind::McpToolCallApprovalDecision {
                            approval_id: approval_id.clone(),
                            decision: core_approval_decision(decision),
                        },
                    },
                    DurableItemSnapshot::McpToolExecutionAttempt {
                        id,
                        approval_id,
                        call_id,
                        inventory_sha256,
                    } => Item {
                        id: id.clone(),
                        state: ItemState::Completed,
                        kind: ItemKind::McpToolExecutionAttempt {
                            approval_id: approval_id.clone(),
                            call_id: call_id.clone(),
                            inventory_sha256: inventory_sha256.clone(),
                        },
                    },
                    DurableItemSnapshot::McpToolResult {
                        id,
                        call_id,
                        name,
                        result,
                    } => Item {
                        id: id.clone(),
                        state: ItemState::Completed,
                        kind: ItemKind::McpToolResult {
                            call_id: call_id.clone(),
                            name: name.clone(),
                            result: core_mcp_tool_result(result),
                        },
                    },
                    DurableItemSnapshot::ToolResult {
                        id,
                        call_id,
                        name,
                        result,
                    } => Item {
                        id: id.clone(),
                        state: ItemState::Completed,
                        kind: ItemKind::ToolResult {
                            call_id: call_id.clone(),
                            name: name.clone(),
                            result: core_tool_result(result),
                        },
                    },
                };
                items.insert(item.id.clone(), item);
            }
            let turn = Turn {
                id: durable_turn.id.clone(),
                request_id: CoreRequestId::new(0),
                state: match durable_turn.status {
                    DurableTurnStatus::InProgress => TurnState::InProgress,
                    DurableTurnStatus::Completed => TurnState::Completed,
                    DurableTurnStatus::Failed => TurnState::Failed,
                    DurableTurnStatus::Interrupted => TurnState::Interrupted,
                },
                items,
                active_item_id: None,
                model: durable_turn.model.clone(),
                context_compaction: durable_turn.context_compaction.clone(),
                workspace_instructions: durable_turn.workspace_instructions.clone(),
                workspace_skills: durable_turn.workspace_skills.clone(),
                error: durable_turn.error.clone(),
                usage: durable_turn.usage.clone(),
            };
            turns.insert(turn.id.clone(), turn);
        }
        self.threads.insert(
            snapshot.id.clone(),
            Thread {
                id: snapshot.id.clone(),
                origin: snapshot.origin.clone(),
                turns,
                active_turn_id: None,
                lifecycle: snapshot.lifecycle,
            },
        );
    }

    pub fn prepare_text_turn(
        &mut self,
        request_id: CoreRequestId,
        thread_id: ThreadId,
        input: Option<String>,
    ) -> Result<PreparedTextTurn, CoreError> {
        self.prepare_text_turn_with_workspace_instructions(request_id, thread_id, input, None, 0, 0)
    }

    pub fn prepare_text_turn_with_workspace_instructions(
        &mut self,
        request_id: CoreRequestId,
        thread_id: ThreadId,
        input: Option<String>,
        workspace_instructions: Option<DurableWorkspaceInstructionsAudit>,
        instruction_context_bytes: usize,
        tool_context_bytes: usize,
    ) -> Result<PreparedTextTurn, CoreError> {
        self.prepare_text_turn_with_context(
            request_id,
            thread_id,
            input,
            workspace_instructions,
            None,
            instruction_context_bytes,
            tool_context_bytes,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn prepare_text_turn_with_context(
        &mut self,
        request_id: CoreRequestId,
        thread_id: ThreadId,
        input: Option<String>,
        workspace_instructions: Option<DurableWorkspaceInstructionsAudit>,
        workspace_skills: Option<DurableWorkspaceSkillsAudit>,
        instruction_context_bytes: usize,
        tool_context_bytes: usize,
    ) -> Result<PreparedTextTurn, CoreError> {
        self.prepare_text_turn_with_model_context(
            request_id,
            thread_id,
            input,
            workspace_instructions,
            workspace_skills,
            instruction_context_bytes,
            tool_context_bytes,
            None,
            crate::context::COMPACTION_TARGET_BYTES,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn prepare_text_turn_with_model_context(
        &mut self,
        request_id: CoreRequestId,
        thread_id: ThreadId,
        input: Option<String>,
        workspace_instructions: Option<DurableWorkspaceInstructionsAudit>,
        workspace_skills: Option<DurableWorkspaceSkillsAudit>,
        instruction_context_bytes: usize,
        tool_context_bytes: usize,
        model: Option<DurableModelSelectionSnapshot>,
        compaction_target_bytes: usize,
    ) -> Result<PreparedTextTurn, CoreError> {
        self.prepare_content_turn_with_model_context(
            request_id,
            thread_id,
            input.map(|text| vec![CoreUserContentPart::Text { text }]),
            workspace_instructions,
            workspace_skills,
            instruction_context_bytes,
            tool_context_bytes,
            model,
            compaction_target_bytes,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn prepare_content_turn_with_model_context(
        &mut self,
        request_id: CoreRequestId,
        thread_id: ThreadId,
        input: Option<Vec<CoreUserContentPart>>,
        workspace_instructions: Option<DurableWorkspaceInstructionsAudit>,
        workspace_skills: Option<DurableWorkspaceSkillsAudit>,
        instruction_context_bytes: usize,
        tool_context_bytes: usize,
        model: Option<DurableModelSelectionSnapshot>,
        compaction_target_bytes: usize,
    ) -> Result<PreparedTextTurn, CoreError> {
        if let Some(input) = input.as_ref() {
            validate_user_content(input)?;
        }
        let thread = self
            .threads
            .get(&thread_id)
            .ok_or_else(|| CoreError::ThreadNotFound(thread_id.clone()))?;
        if thread.lifecycle != DurableThreadLifecycle::Active {
            return Err(CoreError::ThreadNotFound(thread_id));
        }
        if let Some(turn_id) = &thread.active_turn_id {
            return Err(CoreError::TurnAlreadyActive {
                thread_id,
                turn_id: turn_id.clone(),
            });
        }

        let effective_turns = thread
            .turns
            .values()
            .filter(|turn| turn.state != TurnState::InProgress)
            .collect::<Vec<_>>();
        let latest_compaction = effective_turns
            .iter()
            .rev()
            .find(|turn| turn.state == TurnState::Completed)
            .and_then(|turn| turn.context_compaction.as_ref());
        let mut history = Vec::new();
        if let Some(compaction) = latest_compaction {
            history.push(PreparedMessage::ContextCompaction {
                content: compaction.message.clone(),
            });
            for turn in effective_turns
                .iter()
                .filter(|turn| turn.id > compaction.through_turn_id)
            {
                append_effective_turn(&mut history, turn);
            }
        } else {
            for turn in &effective_turns {
                append_effective_turn(&mut history, turn);
            }
        }
        let current_input_index = input.as_ref().map(|_| history.len());
        if let Some(content) = input.as_ref() {
            history.push(PreparedMessage::UserContent {
                content: content.clone(),
            });
        } else if history.is_empty() {
            return Err(CoreError::InvalidInput);
        }
        let fixed_context_bytes = instruction_context_bytes
            .checked_add(tool_context_bytes)
            .ok_or(CoreError::ContextTooLarge)?;
        let pre_context_bytes = crate::context::prepared_history_bytes(&history)
            .and_then(|bytes| bytes.checked_add(fixed_context_bytes))
            .ok_or(CoreError::ContextTooLarge)?;
        let mut context_compaction = None;
        if pre_context_bytes > compaction_target_bytes {
            let durable_effective_turns = effective_turns
                .iter()
                .map(|turn| durable_turn_snapshot(turn))
                .collect::<Vec<_>>();
            let provisional = sugarcode_state::build_context_compaction(
                &durable_effective_turns,
                u64::try_from(pre_context_bytes).map_err(|_| CoreError::ContextTooLarge)?,
                0,
            )
            .ok_or(CoreError::ContextTooLarge)?;
            let mut compacted_history = vec![PreparedMessage::ContextCompaction {
                content: provisional.message,
            }];
            if let Some(content) = input.as_ref() {
                compacted_history.push(PreparedMessage::UserContent {
                    content: content.clone(),
                });
            }
            let post_context_bytes = crate::context::prepared_history_bytes(&compacted_history)
                .and_then(|bytes| bytes.checked_add(fixed_context_bytes))
                .ok_or(CoreError::ContextTooLarge)?;
            if post_context_bytes > compaction_target_bytes {
                return Err(CoreError::ContextTooLarge);
            }
            let compaction = sugarcode_state::build_context_compaction(
                &durable_effective_turns,
                u64::try_from(pre_context_bytes).map_err(|_| CoreError::ContextTooLarge)?,
                u64::try_from(post_context_bytes).map_err(|_| CoreError::ContextTooLarge)?,
            )
            .ok_or(CoreError::ContextTooLarge)?;
            compacted_history[0] = PreparedMessage::ContextCompaction {
                content: compaction.message.clone(),
            };
            history = compacted_history;
            context_compaction = Some(compaction);
        } else if pre_context_bytes > MAX_PROVIDER_HISTORY_BYTES {
            return Err(CoreError::ContextTooLarge);
        }

        let turn_id = TurnId::new_v7();
        let user_item_id = input.is_some().then(ItemId::new_v7);
        let user_item = input
            .as_ref()
            .zip(user_item_id.as_ref())
            .map(|(content, user_item_id)| CoreItemSnapshot {
                id: user_item_id.clone(),
                kind: CoreItemKind::UserMessage {
                    content: content.clone(),
                },
            });
        let mut durable_items = Vec::with_capacity(usize::from(user_item.is_some()));
        if let Some(user_item) = user_item.as_ref() {
            durable_items.push(durable_item_snapshot(user_item));
        }
        let durable_turn = DurableTurnSnapshot {
            id: turn_id.clone(),
            status: DurableTurnStatus::InProgress,
            items: durable_items,
            model: model.clone(),
            context_compaction: context_compaction.clone(),
            workspace_instructions: workspace_instructions.clone(),
            workspace_skills: workspace_skills.clone(),
            error: None,
            usage: None,
        };
        self.repository
            .begin_turn(&thread_id, &durable_turn)
            .map_err(map_repository_error)?;

        let mut items = BTreeMap::new();
        if let (Some(user_item_id), Some(user_item)) = (user_item_id, user_item.as_ref()) {
            items.insert(
                user_item_id,
                Item {
                    id: user_item.id.clone(),
                    state: ItemState::Completed,
                    kind: ItemKind::UserMessage {
                        content: match &user_item.kind {
                            CoreItemKind::UserMessage { content } => content.clone(),
                            _ => unreachable!(),
                        },
                    },
                },
            );
        }
        let turn = Turn {
            id: turn_id.clone(),
            request_id,
            state: TurnState::InProgress,
            items,
            active_item_id: None,
            model: model.clone(),
            context_compaction,
            workspace_instructions: workspace_instructions.clone(),
            workspace_skills: workspace_skills.clone(),
            error: None,
            usage: None,
        };
        let thread = self
            .threads
            .get_mut(&thread_id)
            .ok_or_else(|| CoreError::ThreadNotFound(thread_id.clone()))?;
        thread.active_turn_id = Some(turn_id.clone());
        thread.turns.insert(turn_id.clone(), turn);
        Ok(PreparedTextTurn {
            request_id,
            thread_id,
            turn_id,
            user_item,
            model,
            history,
            current_input_index,
            instructions: Vec::new(),
            workspace_instructions,
            workspace_skills,
        })
    }

    pub fn start_agent_message(
        &mut self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
    ) -> Result<CoreItemSnapshot, CoreError> {
        let turn = self
            .threads
            .get(thread_id)
            .and_then(|thread| thread.turns.get(turn_id))
            .ok_or_else(|| CoreError::NoActiveTurn(thread_id.clone()))?;
        if turn.state != TurnState::InProgress || turn.active_item_id.is_some() {
            return Err(CoreError::TurnNotInProgress(turn_id.clone()));
        }
        let item_id = ItemId::new_v7();
        let snapshot = CoreItemSnapshot {
            id: item_id.clone(),
            kind: CoreItemKind::AgentMessage {
                text: String::new(),
            },
        };
        self.repository
            .append_turn_item(thread_id, turn_id, &durable_item_snapshot(&snapshot))
            .map_err(map_repository_error)?;
        let turn = self
            .threads
            .get_mut(thread_id)
            .and_then(|thread| thread.turns.get_mut(turn_id))
            .ok_or_else(|| CoreError::NoActiveTurn(thread_id.clone()))?;
        turn.add_item(Item::new_agent_message(item_id))?;
        Ok(snapshot)
    }

    pub fn append_completed_item(
        &mut self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        kind: CoreItemKind,
    ) -> Result<CoreItemSnapshot, CoreError> {
        if !matches!(
            kind,
            CoreItemKind::AgentCommentary { .. }
                | CoreItemKind::ContextCompaction { .. }
                | CoreItemKind::AgentTask { .. }
                | CoreItemKind::AgentTaskAmendment { .. }
                | CoreItemKind::AgentTaskResult { .. }
                | CoreItemKind::ToolCall { .. }
                | CoreItemKind::ToolValidationRejected { .. }
                | CoreItemKind::FileChange { .. }
                | CoreItemKind::CommandApprovalRequest { .. }
                | CoreItemKind::CommandApprovalDecision { .. }
                | CoreItemKind::CommandExecutionAttempt { .. }
                | CoreItemKind::McpToolCall { .. }
                | CoreItemKind::McpToolCallApprovalRequest { .. }
                | CoreItemKind::McpToolCallApprovalDecision { .. }
                | CoreItemKind::McpToolExecutionAttempt { .. }
                | CoreItemKind::McpToolResult { .. }
                | CoreItemKind::ToolResult { .. }
        ) {
            return Err(CoreError::Internal(
                "only completed tool items may be appended".to_string(),
            ));
        }
        let turn = self
            .threads
            .get(thread_id)
            .and_then(|thread| thread.turns.get(turn_id))
            .ok_or_else(|| CoreError::NoActiveTurn(thread_id.clone()))?;
        if turn.state != TurnState::InProgress || turn.active_item_id.is_some() {
            return Err(CoreError::TurnNotInProgress(turn_id.clone()));
        }
        let snapshot = CoreItemSnapshot {
            id: ItemId::new_v7(),
            kind,
        };
        self.repository
            .append_turn_item(thread_id, turn_id, &durable_item_snapshot(&snapshot))
            .map_err(map_repository_error)?;
        if !matches!(
            snapshot.kind,
            CoreItemKind::ContextCompaction { outcome: None, .. }
        ) {
            self.repository
                .complete_turn_item(thread_id, turn_id, &durable_item_snapshot(&snapshot))
                .map_err(map_repository_error)?;
        }
        let item = item_from_snapshot(&snapshot, ItemState::Completed);
        let turn = self
            .threads
            .get_mut(thread_id)
            .and_then(|thread| thread.turns.get_mut(turn_id))
            .ok_or_else(|| CoreError::NoActiveTurn(thread_id.clone()))?;
        turn.items.insert(item.id.clone(), item);
        Ok(snapshot)
    }

    pub fn complete_context_compaction_item(
        &mut self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        item_id: &ItemId,
        outcome: sugarcode_protocol::CoreContextCompactionOutcome,
        summary: Option<String>,
    ) -> Result<CoreItemSnapshot, CoreError> {
        let item = self
            .threads
            .get_mut(thread_id)
            .and_then(|thread| thread.turns.get_mut(turn_id))
            .and_then(|turn| turn.items.get_mut(item_id))
            .ok_or_else(|| CoreError::ItemNotInProgress(item_id.clone()))?;
        let ItemKind::ContextCompaction {
            outcome: current,
            summary: stored_summary,
            ..
        } = &mut item.kind
        else {
            return Err(CoreError::Internal(
                "item is not a context compaction".to_string(),
            ));
        };
        if current.is_some() {
            return Err(CoreError::ItemNotInProgress(item_id.clone()));
        }
        *current = Some(outcome);
        *stored_summary = summary.map(Into::into);
        let snapshot = item.snapshot();
        let durable = durable_item_from_item(item);
        self.repository
            .complete_turn_item(thread_id, turn_id, &durable)
            .map_err(map_repository_error)?;
        Ok(snapshot)
    }

    pub fn append_text_delta(
        &mut self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        delta: &str,
    ) -> Result<CoreItemSnapshot, CoreError> {
        let needs_item = self
            .threads
            .get(thread_id)
            .and_then(|thread| thread.turns.get(turn_id))
            .is_some_and(|turn| turn.active_item_id.is_none());
        if needs_item {
            self.start_agent_message(thread_id, turn_id)?;
        }
        let turn = self
            .threads
            .get_mut(thread_id)
            .and_then(|thread| thread.turns.get_mut(turn_id))
            .ok_or_else(|| CoreError::NoActiveTurn(thread_id.clone()))?;
        let item_id = turn
            .active_item_id
            .clone()
            .ok_or_else(|| CoreError::TurnNotInProgress(turn_id.clone()))?;
        let item = turn
            .items
            .get_mut(&item_id)
            .ok_or_else(|| CoreError::Internal("active item is missing".to_string()))?;
        let current_len = match &item.kind {
            ItemKind::AgentMessage { text } => text.len(),
            ItemKind::UserMessage { .. }
            | ItemKind::AgentCommentary { .. }
            | ItemKind::ContextCompaction { .. }
            | ItemKind::AgentTask { .. }
            | ItemKind::AgentTaskAmendment { .. }
            | ItemKind::AgentTaskResult { .. }
            | ItemKind::ToolCall { .. }
            | ItemKind::ToolValidationRejected { .. }
            | ItemKind::FileChange { .. }
            | ItemKind::CommandApprovalRequest { .. }
            | ItemKind::CommandApprovalDecision { .. }
            | ItemKind::CommandExecutionAttempt { .. }
            | ItemKind::McpToolCall { .. }
            | ItemKind::McpToolCallApprovalRequest { .. }
            | ItemKind::McpToolCallApprovalDecision { .. }
            | ItemKind::McpToolExecutionAttempt { .. }
            | ItemKind::McpToolResult { .. }
            | ItemKind::ToolResult { .. } => {
                return Err(CoreError::Internal(
                    "active item is not an agent message".to_string(),
                ));
            }
        };
        if current_len
            .checked_add(delta.len())
            .is_none_or(|length| length > MAX_AGENT_MESSAGE_BYTES)
        {
            return Err(CoreError::OutputTooLarge);
        }
        item.append_agent_message_delta(delta)?;
        let snapshot = item.snapshot();
        let terminal_budget = DurableTurnSnapshot {
            id: turn_id.clone(),
            status: DurableTurnStatus::Failed,
            items: turn
                .items
                .values()
                .map(|item| durable_item_snapshot(&item.snapshot()))
                .collect(),
            model: turn.model.clone(),
            context_compaction: turn.context_compaction.clone(),
            workspace_instructions: turn.workspace_instructions.clone(),
            workspace_skills: turn.workspace_skills.clone(),
            error: Some(DurableTurnError {
                kind: DurableTurnErrorKind::OutputTooLarge,
                retryable: false,
                provider: None,
                protocol: None,
                tool_schema: None,
            }),
            usage: Some(DurableUsage {
                input_tokens: Some(u64::MAX),
                cached_input_tokens: Some(u64::MAX),
                output_tokens: Some(u64::MAX),
                reasoning_tokens: Some(u64::MAX),
                total_tokens: Some(u64::MAX),
                ..DurableUsage::default()
            }),
        };
        if !terminal_turn_record_fits(thread_id, &terminal_budget) {
            let item = turn
                .items
                .get_mut(&item_id)
                .expect("validated active item exists");
            let ItemKind::AgentMessage { text } = &mut item.kind else {
                unreachable!("validated active item is an agent message");
            };
            text.truncate(current_len);
            return Err(CoreError::OutputTooLarge);
        }
        Ok(snapshot)
    }

    pub fn finish_text_turn(
        &mut self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        status: DurableTurnStatus,
        error: Option<DurableTurnError>,
        usage: Option<DurableUsage>,
    ) -> Result<CoreItemSnapshot, CoreError> {
        self.finish_turn(thread_id, turn_id, status, error, usage)?
            .ok_or_else(|| CoreError::Internal("turn has no active agent item".to_string()))
    }

    pub fn finish_turn(
        &mut self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        status: DurableTurnStatus,
        error: Option<DurableTurnError>,
        usage: Option<DurableUsage>,
    ) -> Result<Option<CoreItemSnapshot>, CoreError> {
        let thread = self
            .threads
            .get(thread_id)
            .ok_or_else(|| CoreError::ThreadNotFound(thread_id.clone()))?;
        if thread.active_turn_id.as_ref() != Some(turn_id) {
            return Err(CoreError::NoActiveTurn(thread_id.clone()));
        }
        let turn = thread
            .turns
            .get(turn_id)
            .ok_or_else(|| CoreError::NoActiveTurn(thread_id.clone()))?;
        let item_id = turn.active_item_id.clone();
        let completed_item = item_id
            .as_ref()
            .map(|item_id| {
                turn.items
                    .get(item_id)
                    .ok_or_else(|| CoreError::Internal("active item is missing".to_string()))
                    .map(Item::snapshot)
            })
            .transpose()?;
        if let Some(item_id) = item_id.as_ref() {
            let item = turn
                .items
                .get(item_id)
                .expect("validated active item exists");
            self.repository
                .complete_turn_item(thread_id, turn_id, &durable_item_from_item(item))
                .map_err(map_repository_error)?;
        }
        let durable_turn = DurableTurnSnapshot {
            id: turn_id.clone(),
            status,
            items: turn.items.values().map(durable_item_from_item).collect(),
            model: turn.model.clone(),
            context_compaction: turn.context_compaction.clone(),
            workspace_instructions: turn.workspace_instructions.clone(),
            workspace_skills: turn.workspace_skills.clone(),
            error: error.clone(),
            usage: usage.clone(),
        };
        self.repository
            .finish_turn(thread_id, &durable_turn)
            .map_err(map_repository_error)?;

        let thread = self
            .threads
            .get_mut(thread_id)
            .expect("validated thread exists");
        let turn = thread
            .turns
            .get_mut(turn_id)
            .expect("validated turn exists");
        if let Some(item_id) = item_id {
            turn.items
                .get_mut(&item_id)
                .expect("validated item exists")
                .complete()?;
        }
        turn.active_item_id = None;
        turn.state = match status {
            DurableTurnStatus::InProgress => unreachable!("repository rejected non-terminal turn"),
            DurableTurnStatus::Completed => TurnState::Completed,
            DurableTurnStatus::Failed => TurnState::Failed,
            DurableTurnStatus::Interrupted => TurnState::Interrupted,
        };
        turn.error = error;
        turn.usage = usage;
        thread.active_turn_id = None;
        Ok(completed_item)
    }
}

impl Default for Core {
    fn default() -> Self {
        Self::new()
    }
}

fn append_prepared_turn(history: &mut Vec<PreparedMessage>, turn: &Turn) {
    for item in turn.items.values() {
        if let ItemKind::ContextCompaction {
            source_messages,
            outcome: Some(sugarcode_protocol::CoreContextCompactionOutcome::Completed { .. }),
            summary: Some(summary),
            ..
        } = &item.kind
        {
            let Ok(source_messages) = usize::try_from(*source_messages) else {
                continue;
            };
            if source_messages > history.len() {
                continue;
            }
            let retained = history.split_off(source_messages);
            history.clear();
            history.push(PreparedMessage::ContextCompaction {
                content: summary.as_str().to_string(),
            });
            history.extend(retained);
            continue;
        }
        if let Some(message) = prepared_message_for_item(item) {
            history.push(message);
        }
    }
}

fn append_effective_turn(history: &mut Vec<PreparedMessage>, turn: &Turn) {
    if turn.state == TurnState::Completed {
        append_prepared_turn(history, turn);
        return;
    }

    let local_calls = turn
        .items
        .values()
        .filter_map(|item| match &item.kind {
            ItemKind::ToolCall { call_id, name, .. } => Some((call_id.clone(), name.clone())),
            _ => None,
        })
        .collect::<BTreeSet<_>>();
    let local_results = turn
        .items
        .values()
        .filter_map(|item| match &item.kind {
            ItemKind::ToolResult { call_id, name, .. } => Some((call_id.clone(), name.clone())),
            _ => None,
        })
        .collect::<BTreeSet<_>>();
    let mcp_calls = turn
        .items
        .values()
        .filter_map(|item| match &item.kind {
            ItemKind::McpToolCall { call_id, name, .. } => Some((call_id.clone(), name.clone())),
            _ => None,
        })
        .collect::<BTreeSet<_>>();
    let mcp_results = turn
        .items
        .values()
        .filter_map(|item| match &item.kind {
            ItemKind::McpToolResult { call_id, name, .. } => Some((call_id.clone(), name.clone())),
            _ => None,
        })
        .collect::<BTreeSet<_>>();

    for item in turn.items.values() {
        let safe = match &item.kind {
            ItemKind::ToolCall { call_id, name, .. } => {
                local_results.contains(&(call_id.clone(), name.clone()))
            }
            ItemKind::ToolResult { call_id, name, .. } => {
                local_calls.contains(&(call_id.clone(), name.clone()))
            }
            ItemKind::McpToolCall { call_id, name, .. } => {
                mcp_results.contains(&(call_id.clone(), name.clone()))
            }
            ItemKind::McpToolResult { call_id, name, .. } => {
                mcp_calls.contains(&(call_id.clone(), name.clone()))
            }
            ItemKind::AgentMessage { .. }
            | ItemKind::AgentCommentary { .. }
            | ItemKind::ContextCompaction { .. } => false,
            _ => true,
        };
        if safe && let Some(message) = prepared_message_for_item(item) {
            history.push(message);
        }
    }
}

fn prepared_message_for_item(item: &Item) -> Option<PreparedMessage> {
    match &item.kind {
        ItemKind::UserMessage { content } => Some(PreparedMessage::UserContent {
            content: content.clone(),
        }),
        ItemKind::AgentMessage { text } if !text.is_empty() => Some(PreparedMessage::Text {
            role: PreparedMessageRole::Assistant,
            text: text.clone(),
        }),
        ItemKind::AgentMessage { .. } => None,
        ItemKind::AgentCommentary { text } if !text.is_empty() => {
            Some(PreparedMessage::Commentary { text: text.clone() })
        }
        ItemKind::AgentCommentary { .. } => None,
        ItemKind::ContextCompaction { .. } => None,
        ItemKind::AgentTask { .. }
        | ItemKind::AgentTaskAmendment { .. }
        | ItemKind::AgentTaskResult { .. } => None,
        ItemKind::ToolCall {
            call_id,
            name,
            arguments,
        } => Some(PreparedMessage::ToolCall {
            call_id: call_id.clone(),
            name: name.clone(),
            arguments: arguments.clone(),
        }),
        ItemKind::ToolValidationRejected { .. } => None,
        ItemKind::CommandApprovalRequest { .. }
        | ItemKind::CommandApprovalDecision { .. }
        | ItemKind::CommandExecutionAttempt { .. }
        | ItemKind::McpToolCallApprovalRequest { .. }
        | ItemKind::McpToolCallApprovalDecision { .. }
        | ItemKind::McpToolExecutionAttempt { .. }
        | ItemKind::FileChange { .. } => None,
        ItemKind::McpToolCall {
            call_id,
            name,
            arguments,
            ..
        } => Some(PreparedMessage::McpToolCall {
            call_id: call_id.clone(),
            name: name.clone(),
            arguments: arguments.clone(),
        }),
        ItemKind::McpToolResult {
            call_id, result, ..
        } => Some(PreparedMessage::McpToolResult {
            call_id: call_id.clone(),
            content: match result {
                sugarcode_protocol::CoreMcpToolResult::Completed { content, .. } => content.clone(),
                sugarcode_protocol::CoreMcpToolResult::Error { kind, .. } => {
                    format!("MCP tool error: {kind}")
                }
            },
        }),
        ItemKind::ToolResult {
            call_id,
            name,
            result,
        } => Some(PreparedMessage::ToolResult {
            call_id: call_id.clone(),
            content: tool_result_content(name, result),
        }),
    }
}

fn validate_user_content(content: &[CoreUserContentPart]) -> Result<(), CoreError> {
    if content.is_empty() {
        return Err(CoreError::InvalidInput);
    }
    let mut text_bytes = 0usize;
    let mut has_non_blank_text = false;
    let mut attachment_count = 0usize;
    let mut attachment_bytes = 0u64;
    for part in content {
        match part {
            CoreUserContentPart::Text { text } => {
                text_bytes = text_bytes
                    .checked_add(text.len())
                    .ok_or(CoreError::InvalidInput)?;
                has_non_blank_text |= !text.trim().is_empty();
            }
            CoreUserContentPart::Image { asset } => {
                validate_content_asset(asset, true)?;
                attachment_count += 1;
                attachment_bytes = attachment_bytes
                    .checked_add(asset.size_bytes)
                    .ok_or(CoreError::InvalidInput)?;
            }
            CoreUserContentPart::Document { asset } => {
                validate_content_asset(asset, false)?;
                attachment_count += 1;
                attachment_bytes = attachment_bytes
                    .checked_add(asset.size_bytes)
                    .ok_or(CoreError::InvalidInput)?;
            }
        }
    }
    if text_bytes > MAX_USER_MESSAGE_BYTES
        || attachment_count > sugarcode_state::MAX_TURN_ATTACHMENTS
        || attachment_bytes > sugarcode_state::MAX_TURN_ATTACHMENT_BYTES
        || (attachment_count == 0 && !has_non_blank_text)
    {
        return Err(CoreError::InvalidInput);
    }
    Ok(())
}

fn validate_content_asset(asset: &CoreContentAsset, image: bool) -> Result<(), CoreError> {
    if asset.asset_id != format!("ast_{}", asset.sha256)
        || asset.sha256.len() != 64
        || !asset
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || asset.size_bytes == 0
        || asset.original_name.is_empty()
        || asset.original_name.len() > 255
        || asset.original_name.chars().any(char::is_control)
        || asset.original_name.contains(['/', '\\'])
    {
        return Err(CoreError::InvalidInput);
    }
    let media_type_valid = if image {
        matches!(
            asset.media_type.as_str(),
            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
        )
    } else {
        asset.media_type == "application/pdf" || asset.media_type.starts_with("text/")
    };
    if !media_type_valid {
        return Err(CoreError::InvalidInput);
    }
    Ok(())
}

fn core_user_content_part(part: &sugarcode_state::DurableUserContentPart) -> CoreUserContentPart {
    match part {
        sugarcode_state::DurableUserContentPart::Text { text } => {
            CoreUserContentPart::Text { text: text.clone() }
        }
        sugarcode_state::DurableUserContentPart::Image { asset } => CoreUserContentPart::Image {
            asset: core_content_asset(asset),
        },
        sugarcode_state::DurableUserContentPart::Document { asset } => {
            CoreUserContentPart::Document {
                asset: core_content_asset(asset),
            }
        }
    }
}

fn core_content_asset(asset: &sugarcode_state::DurableContentAsset) -> CoreContentAsset {
    CoreContentAsset {
        asset_id: asset.asset_id.clone(),
        sha256: asset.sha256.clone(),
        media_type: asset.media_type.clone(),
        original_name: asset.original_name.clone(),
        size_bytes: asset.size_bytes,
    }
}

fn durable_turn_snapshot(turn: &Turn) -> DurableTurnSnapshot {
    DurableTurnSnapshot {
        id: turn.id.clone(),
        status: match turn.state {
            TurnState::InProgress => DurableTurnStatus::InProgress,
            TurnState::Completed => DurableTurnStatus::Completed,
            TurnState::Failed => DurableTurnStatus::Failed,
            TurnState::Interrupted => DurableTurnStatus::Interrupted,
        },
        items: turn.items.values().map(durable_item_from_item).collect(),
        model: turn.model.clone(),
        context_compaction: turn.context_compaction.clone(),
        workspace_instructions: turn.workspace_instructions.clone(),
        workspace_skills: turn.workspace_skills.clone(),
        error: turn.error.clone(),
        usage: turn.usage.clone(),
    }
}

fn durable_item_from_item(item: &Item) -> DurableItemSnapshot {
    let mut snapshot = durable_item_snapshot(&item.snapshot());
    if let (
        ItemKind::ContextCompaction { summary, .. },
        DurableItemSnapshot::ContextCompaction {
            summary: durable_summary,
            ..
        },
    ) = (&item.kind, &mut snapshot)
    {
        *durable_summary = summary
            .as_ref()
            .map(|summary| summary.as_str().to_string().into());
    }
    snapshot
}

fn core_context_compaction_outcome(
    outcome: &sugarcode_state::DurableActiveTurnCompactionOutcome,
) -> sugarcode_protocol::CoreContextCompactionOutcome {
    match outcome {
        sugarcode_state::DurableActiveTurnCompactionOutcome::Completed {
            post_context_bytes,
            summary_bytes,
            summary_sha256,
        } => sugarcode_protocol::CoreContextCompactionOutcome::Completed {
            post_context_bytes: *post_context_bytes,
            summary_bytes: *summary_bytes,
            summary_sha256: summary_sha256.clone(),
        },
        sugarcode_state::DurableActiveTurnCompactionOutcome::Failed { kind } => {
            sugarcode_protocol::CoreContextCompactionOutcome::Failed { kind: kind.clone() }
        }
        sugarcode_state::DurableActiveTurnCompactionOutcome::Interrupted => {
            sugarcode_protocol::CoreContextCompactionOutcome::Interrupted
        }
    }
}

fn command_sandbox_policy(
    value: Option<&str>,
) -> Option<sugarcode_protocol::CoreCommandSandboxPolicy> {
    match value {
        Some("filesystemReadOnlyV1") => {
            Some(sugarcode_protocol::CoreCommandSandboxPolicy::FilesystemReadOnlyV1)
        }
        Some(_) | None => None,
    }
}

fn command_network_policy(
    value: Option<&str>,
) -> Option<sugarcode_protocol::CoreCommandNetworkPolicy> {
    match value {
        Some("networkDeniedV1") => {
            Some(sugarcode_protocol::CoreCommandNetworkPolicy::NetworkDeniedV1)
        }
        Some(_) | None => None,
    }
}

fn command_workspace_write_policy(
    value: Option<&str>,
) -> Option<sugarcode_protocol::CoreCommandWorkspaceWritePolicy> {
    match value {
        Some("commandWorkspaceWriteV1") => {
            Some(sugarcode_protocol::CoreCommandWorkspaceWritePolicy::CommandWorkspaceWriteV1)
        }
        Some(_) | None => None,
    }
}

fn command_workspace_write_risk(
    value: Option<&str>,
) -> Option<sugarcode_protocol::CoreCommandWorkspaceWriteRisk> {
    match value {
        Some("nonTransactionalWorkspaceTreeV1") => {
            Some(sugarcode_protocol::CoreCommandWorkspaceWriteRisk::NonTransactionalWorkspaceTreeV1)
        }
        Some(_) | None => None,
    }
}

fn core_approval_decision(value: &str) -> sugarcode_protocol::CoreCommandApprovalDecision {
    match value {
        "approved" => sugarcode_protocol::CoreCommandApprovalDecision::Approved,
        "denied" => sugarcode_protocol::CoreCommandApprovalDecision::Denied,
        "timedOut" => sugarcode_protocol::CoreCommandApprovalDecision::TimedOut,
        "unsupported" => sugarcode_protocol::CoreCommandApprovalDecision::Unsupported,
        "cancelled" => sugarcode_protocol::CoreCommandApprovalDecision::Cancelled,
        _ => sugarcode_protocol::CoreCommandApprovalDecision::ClientDisconnected,
    }
}

fn core_mcp_tool_result(
    result: &sugarcode_state::DurableMcpToolResult,
) -> sugarcode_protocol::CoreMcpToolResult {
    match result {
        sugarcode_state::DurableMcpToolResult::Completed {
            content,
            is_error,
            observed_bytes,
            canonical_bytes,
            retained_bytes,
            truncated,
            sha256,
            content_blocks,
            structured_content,
        } => sugarcode_protocol::CoreMcpToolResult::Completed {
            content: content.clone(),
            is_error: *is_error,
            observed_bytes: *observed_bytes,
            canonical_bytes: *canonical_bytes,
            retained_bytes: *retained_bytes,
            truncated: *truncated,
            sha256: sha256.clone(),
            content_blocks: *content_blocks,
            structured_content: *structured_content,
        },
        sugarcode_state::DurableMcpToolResult::Error {
            kind,
            request_state,
        } => sugarcode_protocol::CoreMcpToolResult::Error {
            kind: kind.clone(),
            request_state: request_state.clone(),
        },
    }
}

#[cfg(test)]
#[path = "thread/tests/mod.rs"]
mod tests;
