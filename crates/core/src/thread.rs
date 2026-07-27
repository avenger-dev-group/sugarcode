use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use std::cmp::Reverse;
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;
use sugarcode_protocol::CoreEvent;
use sugarcode_protocol::CoreEventKind;
use sugarcode_protocol::CoreItemKind;
use sugarcode_protocol::CoreItemSnapshot;
use sugarcode_protocol::CoreRequestId;
use sugarcode_protocol::CoreToolResult;
use sugarcode_protocol::ItemId;
use sugarcode_protocol::ThreadId;
use sugarcode_protocol::TurnId;
use sugarcode_state::DurableItemSnapshot;
use sugarcode_state::DurableThreadLifecycle;
use sugarcode_state::DurableThreadPage;
use sugarcode_state::DurableThreadSnapshot;
use sugarcode_state::DurableThreadSummary;
use sugarcode_state::DurableToolResult;
use sugarcode_state::DurableTurnError;
use sugarcode_state::DurableTurnErrorKind;
use sugarcode_state::DurableTurnSnapshot;
use sugarcode_state::DurableTurnStatus;
use sugarcode_state::DurableUsage;
use sugarcode_state::IdSequences;
use sugarcode_state::RolloutError;
use sugarcode_state::ThreadRepository;
use sugarcode_state::terminal_turn_record_fits;

mod api;
mod memory_repository;
mod snapshots;

use memory_repository::MemoryThreadRepository;
use snapshots::{
    core_tool_result, durable_item_snapshot, durable_thread_snapshot, item_from_snapshot,
    map_repository_error, tool_result_content,
};

const DETERMINISTIC_AGENT_MESSAGE: &str = "SugarCode deterministic response.";
pub const MAX_AGENT_MESSAGE_BYTES: usize = 512 * 1024;
pub const MAX_PROVIDER_HISTORY_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_USER_MESSAGE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedTextTurn {
    pub request_id: CoreRequestId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub user_item: Option<CoreItemSnapshot>,
    pub history: Vec<PreparedMessage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreparedMessage {
    Text {
        role: PreparedMessageRole,
        text: String,
    },
    ToolCall {
        call_id: String,
        name: String,
        path: String,
        query: Option<String>,
        patch: Option<String>,
        command: Option<String>,
        arguments: Option<Vec<String>>,
    },
    ToolResult {
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
        patch: Option<String>,
        command: Option<String>,
        arguments: Option<Vec<String>>,
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
        network_policy: Option<sugarcode_protocol::CoreCommandNetworkPolicy>,
    },
    CommandApprovalDecision {
        approval_id: String,
        decision: sugarcode_protocol::CoreCommandApprovalDecision,
    },
    CommandExecutionAttempt {
        approval_id: String,
        call_id: String,
    },
    ToolResult {
        call_id: String,
        name: String,
        result: CoreToolResult,
    },
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
            ItemKind::ToolCall { .. }
            | ItemKind::FileChange { .. }
            | ItemKind::CommandApprovalRequest { .. }
            | ItemKind::CommandApprovalDecision { .. }
            | ItemKind::CommandExecutionAttempt { .. }
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
            ItemKind::UserMessage { text } => CoreItemKind::UserMessage { text: text.clone() },
            ItemKind::AgentMessage { text } => CoreItemKind::AgentMessage { text: text.clone() },
            ItemKind::ToolCall {
                call_id,
                name,
                path,
                query,
                patch,
                command,
                arguments,
            } => CoreItemKind::ToolCall {
                call_id: call_id.clone(),
                name: name.clone(),
                path: path.clone(),
                query: query.clone(),
                patch: patch.clone(),
                command: command.clone(),
                arguments: arguments.clone(),
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
                network_policy: *network_policy,
            },
            ItemKind::CommandApprovalDecision {
                approval_id,
                decision,
            } => CoreItemKind::CommandApprovalDecision {
                approval_id: approval_id.clone(),
                decision: *decision,
            },
            ItemKind::CommandExecutionAttempt {
                approval_id,
                call_id,
            } => CoreItemKind::CommandExecutionAttempt {
                approval_id: approval_id.clone(),
                call_id: call_id.clone(),
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
    last_thread_sequence: u64,
    last_turn_sequence: u64,
    last_item_sequence: u64,
    repository: Box<dyn ThreadRepository>,
}

impl Core {
    pub fn new() -> Self {
        Self::with_repository(Box::new(MemoryThreadRepository::default()))
    }

    pub fn with_repository(repository: Box<dyn ThreadRepository>) -> Self {
        let sequences = repository.id_sequences();
        Self {
            threads: BTreeMap::new(),
            last_thread_sequence: sequences.thread,
            last_turn_sequence: sequences.turn,
            last_item_sequence: sequences.item,
            repository,
        }
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
                    DurableItemSnapshot::UserMessage { id, text } => Item {
                        id: id.clone(),
                        state: ItemState::Completed,
                        kind: ItemKind::UserMessage { text: text.clone() },
                    },
                    DurableItemSnapshot::AgentMessage { id, text } => Item {
                        id: id.clone(),
                        state: ItemState::Completed,
                        kind: ItemKind::AgentMessage { text: text.clone() },
                    },
                    DurableItemSnapshot::ToolCall {
                        id,
                        call_id,
                        name,
                        path,
                        query,
                        patch,
                        command,
                        arguments,
                    } => Item {
                        id: id.clone(),
                        state: ItemState::Completed,
                        kind: ItemKind::ToolCall {
                            call_id: call_id.clone(),
                            name: name.clone(),
                            path: path.clone(),
                            query: query.clone(),
                            patch: patch.clone(),
                            command: command.clone(),
                            arguments: arguments.clone(),
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
                            network_policy: command_network_policy(network_policy.as_deref()),
                        },
                    },
                    DurableItemSnapshot::CommandApprovalDecision {
                        id,
                        approval_id,
                        decision,
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
                error: durable_turn.error.clone(),
                usage: durable_turn.usage.clone(),
            };
            turns.insert(turn.id.clone(), turn);
        }
        self.threads.insert(
            snapshot.id.clone(),
            Thread {
                id: snapshot.id.clone(),
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
        if input
            .as_ref()
            .is_some_and(|input| input.trim().is_empty() || input.len() > MAX_USER_MESSAGE_BYTES)
        {
            return Err(CoreError::InvalidInput);
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

        let mut history = thread
            .turns
            .values()
            .filter(|turn| turn.state == TurnState::Completed)
            .flat_map(|turn| {
                turn.items.values().filter_map(|item| match &item.kind {
                    ItemKind::UserMessage { text } => Some(PreparedMessage::Text {
                        role: PreparedMessageRole::User,
                        text: text.clone(),
                    }),
                    ItemKind::AgentMessage { text } if !text.is_empty() => {
                        Some(PreparedMessage::Text {
                            role: PreparedMessageRole::Assistant,
                            text: text.clone(),
                        })
                    }
                    ItemKind::AgentMessage { .. } => None,
                    ItemKind::ToolCall {
                        call_id,
                        name,
                        path,
                        query,
                        patch,
                        command,
                        arguments,
                    } => Some(PreparedMessage::ToolCall {
                        call_id: call_id.clone(),
                        name: name.clone(),
                        path: path.clone(),
                        query: query.clone(),
                        patch: patch.clone(),
                        command: command.clone(),
                        arguments: arguments.clone(),
                    }),
                    ItemKind::CommandApprovalRequest { .. }
                    | ItemKind::CommandApprovalDecision { .. }
                    | ItemKind::CommandExecutionAttempt { .. }
                    | ItemKind::FileChange { .. } => None,
                    ItemKind::ToolResult {
                        call_id,
                        name,
                        result,
                    } => Some(PreparedMessage::ToolResult {
                        call_id: call_id.clone(),
                        content: tool_result_content(name, result),
                    }),
                })
            })
            .collect::<Vec<_>>();
        if let Some(input) = input.as_ref() {
            history.push(PreparedMessage::Text {
                role: PreparedMessageRole::User,
                text: input.clone(),
            });
        } else if history.is_empty() {
            return Err(CoreError::InvalidInput);
        }
        let history_bytes = history.iter().try_fold(0usize, |total, message| {
            total.checked_add(match message {
                PreparedMessage::Text { text, .. } => text.len(),
                PreparedMessage::ToolCall {
                    call_id,
                    name,
                    path,
                    query,
                    patch,
                    command,
                    arguments,
                } => {
                    call_id.len()
                        + name.len()
                        + path.len()
                        + query.as_ref().map_or(0, String::len)
                        + patch.as_ref().map_or(0, String::len)
                        + command.as_ref().map_or(0, String::len)
                        + arguments
                            .as_ref()
                            .map_or(0, |values| values.iter().map(String::len).sum())
                }
                PreparedMessage::ToolResult { call_id, content } => call_id.len() + content.len(),
            })
        });
        if history_bytes.is_none_or(|bytes| bytes > MAX_PROVIDER_HISTORY_BYTES) {
            return Err(CoreError::ContextTooLarge);
        }

        let turn_sequence = self
            .last_turn_sequence
            .checked_add(1)
            .ok_or(CoreError::TurnIdExhausted)?;
        let turn_id = TurnId::new(format!("turn_{turn_sequence:016}"));
        let user_item_sequence = if input.is_some() {
            Some(
                self.last_item_sequence
                    .checked_add(1)
                    .ok_or(CoreError::ItemIdExhausted)?,
            )
        } else {
            None
        };
        let user_item_id =
            user_item_sequence.map(|sequence| ItemId::new(format!("item_{sequence:016}")));
        let user_item = input
            .as_ref()
            .zip(user_item_id.as_ref())
            .map(|(input, user_item_id)| CoreItemSnapshot {
                id: user_item_id.clone(),
                kind: CoreItemKind::UserMessage {
                    text: input.clone(),
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
                        text: match &user_item.kind {
                            CoreItemKind::UserMessage { text } => text.clone(),
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
            error: None,
            usage: None,
        };
        let thread = self
            .threads
            .get_mut(&thread_id)
            .ok_or_else(|| CoreError::ThreadNotFound(thread_id.clone()))?;
        thread.active_turn_id = Some(turn_id.clone());
        thread.turns.insert(turn_id.clone(), turn);
        self.last_turn_sequence = turn_sequence;
        if let Some(sequence) = user_item_sequence {
            self.last_item_sequence = sequence;
        }

        Ok(PreparedTextTurn {
            request_id,
            thread_id,
            turn_id,
            user_item,
            history,
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
        let sequence = self
            .last_item_sequence
            .checked_add(1)
            .ok_or(CoreError::ItemIdExhausted)?;
        let item_id = ItemId::new(format!("item_{sequence:016}"));
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
        self.last_item_sequence = sequence;
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
            CoreItemKind::ToolCall { .. }
                | CoreItemKind::FileChange { .. }
                | CoreItemKind::CommandApprovalRequest { .. }
                | CoreItemKind::CommandApprovalDecision { .. }
                | CoreItemKind::CommandExecutionAttempt { .. }
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
        let sequence = self
            .last_item_sequence
            .checked_add(1)
            .ok_or(CoreError::ItemIdExhausted)?;
        let snapshot = CoreItemSnapshot {
            id: ItemId::new(format!("item_{sequence:016}")),
            kind,
        };
        self.repository
            .append_turn_item(thread_id, turn_id, &durable_item_snapshot(&snapshot))
            .map_err(map_repository_error)?;
        let item = item_from_snapshot(&snapshot, ItemState::Completed);
        let turn = self
            .threads
            .get_mut(thread_id)
            .and_then(|thread| thread.turns.get_mut(turn_id))
            .ok_or_else(|| CoreError::NoActiveTurn(thread_id.clone()))?;
        turn.items.insert(item.id.clone(), item);
        self.last_item_sequence = sequence;
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
            | ItemKind::ToolCall { .. }
            | ItemKind::FileChange { .. }
            | ItemKind::CommandApprovalRequest { .. }
            | ItemKind::CommandApprovalDecision { .. }
            | ItemKind::CommandExecutionAttempt { .. }
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
            error: Some(DurableTurnError {
                kind: DurableTurnErrorKind::OutputTooLarge,
                retryable: false,
            }),
            usage: Some(DurableUsage {
                input_tokens: Some(u64::MAX),
                cached_input_tokens: Some(u64::MAX),
                output_tokens: Some(u64::MAX),
                reasoning_tokens: Some(u64::MAX),
                total_tokens: Some(u64::MAX),
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
        let durable_turn = DurableTurnSnapshot {
            id: turn_id.clone(),
            status,
            items: turn
                .items
                .values()
                .map(|item| durable_item_snapshot(&item.snapshot()))
                .collect(),
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

#[cfg(test)]
#[path = "thread/tests/mod.rs"]
mod tests;
