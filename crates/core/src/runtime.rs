use crate::CommandApprovalOutcome;
use crate::CommandApprovalRequest;
use crate::CommandApprovalRequester;
use crate::Core;
use crate::CoreApi;
use crate::CoreError;
use crate::McpToolApprovalOutcome;
use crate::McpToolApprovalRequest;
use crate::McpToolApprovalRequester;
use crate::McpToolCapability;
use crate::McpToolExecutionOutcome;
use crate::McpToolExecutor;
use crate::McpToolPrepareError;
use crate::PreparedMessage;
use crate::PreparedMessageRole;
use crate::PreparedTextTurn;
use crate::TurnInterruptOutcome;
use crate::TurnStartOutcome;
use futures_util::FutureExt;
use futures_util::StreamExt;
use futures_util::stream;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU8;
use std::sync::atomic::Ordering;
use sugarcode_model_provider::ModelError;
use sugarcode_model_provider::ModelErrorKind;
use sugarcode_model_provider::ModelEvent;
use sugarcode_model_provider::ModelInstruction;
use sugarcode_model_provider::ModelInstructionSource;
use sugarcode_model_provider::ModelMessage;
use sugarcode_model_provider::ModelOutputItemKind;
use sugarcode_model_provider::ModelProvider;
use sugarcode_model_provider::ModelRequest;
use sugarcode_model_provider::ModelResponse;
use sugarcode_model_provider::ModelRole;
use sugarcode_model_provider::ModelTextPhase;
use sugarcode_model_provider::ModelToolCall;
use sugarcode_model_provider::ModelToolDefinition;
use sugarcode_model_provider::ModelUsage;
use sugarcode_protocol::CoreAgentOutputRef;
use sugarcode_protocol::CoreContextCompactionOutcome;
use sugarcode_protocol::CoreContextCompactionStrategy;
use sugarcode_protocol::CoreEvent;
use sugarcode_protocol::CoreEventKind;
use sugarcode_protocol::CoreFileChangeKind;
use sugarcode_protocol::CoreFileChangeNewlineStyle;
use sugarcode_protocol::CoreItemKind;
use sugarcode_protocol::CoreItemSnapshot;
use sugarcode_protocol::CoreMcpToolResult;
use sugarcode_protocol::CoreRequestId;
use sugarcode_protocol::CoreToolErrorKind;
use sugarcode_protocol::CoreToolResult;
use sugarcode_protocol::CoreTurnError;
use sugarcode_protocol::CoreTurnErrorKind;
use sugarcode_protocol::ThreadId;
use sugarcode_protocol::TurnId;
use sugarcode_state::DurableModelSelectionSnapshot;
use sugarcode_state::DurableThreadOrigin;
use sugarcode_state::DurableThreadPage;
use sugarcode_state::DurableThreadSnapshot;
use sugarcode_state::DurableTurnError;
use sugarcode_state::DurableTurnErrorKind;
use sugarcode_state::DurableTurnStatus;
use sugarcode_state::DurableUsage;
use sugarcode_state::DurableWorkspaceInstructionsAudit;
use sugarcode_state::DurableWorkspaceInstructionsSource;
use sugarcode_state::DurableWorkspaceInstructionsStatus;
use sugarcode_state::DurableWorkspaceSkillsAudit;
use sugarcode_state::DurableWorkspaceSkillsSource;
use sugarcode_state::DurableWorkspaceSkillsStatus;
use sugarcode_tools::ShellCommandArguments;
use sugarcode_tools::ShellCommandErrorKind;
use sugarcode_tools::ShellCommandExecution;
use sugarcode_tools::ShellCommandExecutor;
use sugarcode_tools::ShellCommandOutcome;
use sugarcode_tools::WorkspaceInstructionsSnapshot;
use sugarcode_tools::WorkspaceListArguments;
use sugarcode_tools::WorkspaceListErrorKind;
use sugarcode_tools::WorkspaceListExecutor;
use sugarcode_tools::WorkspaceListOutcome;
use sugarcode_tools::WorkspacePatchArguments;
use sugarcode_tools::WorkspacePatchCommitOutcome;
use sugarcode_tools::WorkspacePatchErrorKind;
use sugarcode_tools::WorkspacePatchExecutor;
use sugarcode_tools::WorkspacePatchPrepareOutcome;
use sugarcode_tools::WorkspaceReadArguments;
use sugarcode_tools::WorkspaceReadErrorKind;
use sugarcode_tools::WorkspaceReadExecutor;
use sugarcode_tools::WorkspaceReadOutcome;
use sugarcode_tools::WorkspaceSearchArguments;
use sugarcode_tools::WorkspaceSearchErrorKind;
use sugarcode_tools::WorkspaceSearchExecutor;
use sugarcode_tools::WorkspaceSearchOutcome;
use sugarcode_tools::WorkspaceSkillsSnapshot;
use tokio::sync::Notify;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

mod agent_loop;
mod collaboration;
mod terminal;
mod tool_dispatch;

use agent_loop::AgentLoopState;
use collaboration::AgentAccess;
use collaboration::CollaborationCoordinator;
use terminal::Terminal;
use terminal::claim_terminal;
use terminal::clear_active;
use terminal::finish_completed_and_emit;
use terminal::finish_failed_and_emit;
use terminal::finish_interrupted;
use terminal::finish_interrupted_and_emit;
use terminal::finish_state_unavailable_and_emit;
use terminal::send_event;
use tool_dispatch::append_completed_agent_output_item;
use tool_dispatch::append_completed_tool_item;
use tool_dispatch::map_workspace_list_outcome;
use tool_dispatch::map_workspace_patch_error;
use tool_dispatch::map_workspace_read_outcome;
use tool_dispatch::map_workspace_search_outcome;
use tool_dispatch::serialized_file_change_bytes;
use tool_dispatch::serialized_tool_result_bytes;
use tool_dispatch::shell_tool_arguments;
use tool_dispatch::workspace_tool_arguments;
use tool_dispatch::workspace_tool_definitions;

use crate::agent_instructions::sugarcode_active_turn_compaction_instruction_v1;
use crate::agent_instructions::sugarcode_base_agent_instruction_v1;

const TURN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);
pub const MAX_SERIALIZED_TOOL_RESULT_BYTES: usize = 384 * 1024;
const MAX_ACTIVE_TURN_COMPACTION_BYTES: usize = 32 * 1024;
const READ_ONLY_TOOL_CONCURRENCY: usize = 4;
const MAX_AMBIGUOUS_CONTEXT_RECOVERIES: usize = 1;
const MAX_EXPLICIT_CONTEXT_RECOVERIES: usize = 2;

const CORE_EVENT_CAPACITY: usize = 64;

#[derive(Clone)]
pub struct CoreRuntime {
    core: Arc<Mutex<Core>>,
    model_gateway: Option<ModelGatewaySource>,
    workspace_read: Option<Arc<dyn WorkspaceReadExecutor>>,
    workspace_list: Option<Arc<dyn WorkspaceListExecutor>>,
    workspace_search: Option<Arc<dyn WorkspaceSearchExecutor>>,
    workspace_patch: Option<Arc<dyn WorkspacePatchExecutor>>,
    workspace_instructions: Option<Arc<WorkspaceInstructionsSnapshot>>,
    workspace_skills: Option<Arc<WorkspaceSkillsSnapshot>>,
    shell_executor: Option<Arc<dyn ShellCommandExecutor>>,
    approval_requester: Option<Arc<dyn CommandApprovalRequester>>,
    mcp_executor: Option<Arc<dyn McpToolExecutor>>,
    mcp_approval_requester: Option<Arc<dyn McpToolApprovalRequester>>,
    mcp_capability: McpToolCapability,
    mcp_execution_lease: Arc<tokio::sync::Semaphore>,
    collaboration: Arc<CollaborationCoordinator>,
    event_tx: mpsc::Sender<CoreEvent>,
    active: Arc<Mutex<BTreeMap<ThreadId, ActiveTurn>>>,
}

pub struct ResolvedModel {
    pub provider: Arc<dyn ModelProvider>,
    pub model: String,
    pub profile_id: String,
    pub provider_kind: String,
    pub display_name: String,
    pub capabilities: ModelCapabilities,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelCapabilities {
    pub context_window_tokens: u32,
    pub output_reserve_tokens: u32,
    pub strict_tool_schema: bool,
    pub parallel_tool_calls: bool,
}

impl ModelCapabilities {
    pub fn new(
        context_window_tokens: u32,
        strict_tool_schema: bool,
        parallel_tool_calls: bool,
    ) -> Self {
        let output_reserve_tokens = 16_384_u32.min(4_096_u32.max(context_window_tokens / 4));
        Self {
            context_window_tokens,
            output_reserve_tokens,
            strict_tool_schema,
            parallel_tool_calls,
        }
    }

    pub fn input_compaction_target_tokens(self) -> u32 {
        self.context_window_tokens
            .saturating_sub(self.output_reserve_tokens)
    }

    fn input_compaction_target_bytes(self) -> usize {
        usize::try_from(self.input_compaction_target_tokens())
            .unwrap_or(usize::MAX)
            .saturating_mul(3)
            .min(crate::context::MAX_PROVIDER_CONTEXT_BYTES)
    }
}

pub trait ModelResolver: Send + Sync {
    fn resolve(&self, profile_id: Option<&str>) -> Result<ResolvedModel, ModelError>;
}

#[derive(Clone)]
enum ModelGatewaySource {
    Fixed(ModelGateway),
    Resolver(Arc<dyn ModelResolver>),
}

impl ModelGatewaySource {
    fn resolve(&self, profile_id: Option<&str>) -> Result<ModelGateway, ModelError> {
        match self {
            Self::Fixed(gateway) => Ok(gateway.clone()),
            Self::Resolver(resolver) => {
                let resolved = resolver.resolve(profile_id)?;
                Ok(ModelGateway {
                    provider: resolved.provider,
                    model: Arc::from(resolved.model),
                    profile_id: Arc::from(resolved.profile_id),
                    provider_kind: Arc::from(resolved.provider_kind),
                    display_name: Arc::from(resolved.display_name),
                    capabilities: resolved.capabilities,
                })
            }
        }
    }
}

#[derive(Clone)]
struct ModelGateway {
    provider: Arc<dyn ModelProvider>,
    model: Arc<str>,
    profile_id: Arc<str>,
    provider_kind: Arc<str>,
    display_name: Arc<str>,
    capabilities: ModelCapabilities,
}

impl fmt::Debug for ModelGateway {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ModelGateway")
            .field("model", &self.model)
            .field("profile_id", &self.profile_id)
            .field("provider_kind", &self.provider_kind)
            .field("display_name", &self.display_name)
            .field("capabilities", &self.capabilities)
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
struct ActiveTurn {
    turn_id: TurnId,
    cancellation: CancellationToken,
    terminal_state: Arc<Mutex<TurnPhase>>,
    done: Arc<TurnDone>,
}

#[derive(Default)]
struct TurnDone {
    complete: AtomicU8,
    notify: Notify,
}

impl TurnDone {
    async fn wait(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.complete.load(Ordering::Acquire) != 0 {
                return;
            }
            notified.await;
        }
    }

    fn finish(&self) {
        self.complete.store(1, Ordering::Release);
        self.notify.notify_waiters();
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TurnPhase {
    Running,
    InterruptRequested,
    TerminalClaimed,
}

impl fmt::Debug for CoreRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CoreRuntime")
            .field("model_available", &self.model_gateway.is_some())
            .finish_non_exhaustive()
    }
}

impl CoreRuntime {
    pub fn new(
        core: Core,
        provider: Arc<dyn ModelProvider>,
        model: String,
    ) -> (Self, mpsc::Receiver<CoreEvent>) {
        Self::new_with_workspace(core, provider, model, None, None)
    }

    pub fn new_with_workspace(
        core: Core,
        provider: Arc<dyn ModelProvider>,
        model: String,
        workspace_read: Option<Arc<dyn WorkspaceReadExecutor>>,
        workspace_list: Option<Arc<dyn WorkspaceListExecutor>>,
    ) -> (Self, mpsc::Receiver<CoreEvent>) {
        Self::new_with_workspace_search(core, provider, model, workspace_read, workspace_list, None)
    }

    pub fn new_with_workspace_search(
        core: Core,
        provider: Arc<dyn ModelProvider>,
        model: String,
        workspace_read: Option<Arc<dyn WorkspaceReadExecutor>>,
        workspace_list: Option<Arc<dyn WorkspaceListExecutor>>,
        workspace_search: Option<Arc<dyn WorkspaceSearchExecutor>>,
    ) -> (Self, mpsc::Receiver<CoreEvent>) {
        let (event_tx, event_rx) = mpsc::channel(CORE_EVENT_CAPACITY);
        (
            Self {
                core: Arc::new(Mutex::new(core)),
                model_gateway: Some(ModelGatewaySource::Fixed(ModelGateway {
                    provider,
                    model: Arc::from(model),
                    profile_id: Arc::from("fixed"),
                    provider_kind: Arc::from("fixed"),
                    display_name: Arc::from("Fixed model"),
                    capabilities: ModelCapabilities::new(131_072, false, false),
                })),
                workspace_read,
                workspace_list,
                workspace_search,
                workspace_patch: None,
                workspace_instructions: None,
                workspace_skills: None,
                shell_executor: None,
                approval_requester: None,
                mcp_executor: None,
                mcp_approval_requester: None,
                mcp_capability: McpToolCapability::default(),
                mcp_execution_lease: Arc::new(tokio::sync::Semaphore::new(1)),
                collaboration: Arc::new(CollaborationCoordinator::default()),
                event_tx,
                active: Arc::new(Mutex::new(BTreeMap::new())),
            },
            event_rx,
        )
    }

    pub fn new_with_model_resolver(
        core: Core,
        resolver: Arc<dyn ModelResolver>,
        workspace_read: Option<Arc<dyn WorkspaceReadExecutor>>,
        workspace_list: Option<Arc<dyn WorkspaceListExecutor>>,
        workspace_search: Option<Arc<dyn WorkspaceSearchExecutor>>,
    ) -> (Self, mpsc::Receiver<CoreEvent>) {
        let (event_tx, event_rx) = mpsc::channel(CORE_EVENT_CAPACITY);
        (
            Self {
                core: Arc::new(Mutex::new(core)),
                model_gateway: Some(ModelGatewaySource::Resolver(resolver)),
                workspace_read,
                workspace_list,
                workspace_search,
                workspace_patch: None,
                workspace_instructions: None,
                workspace_skills: None,
                shell_executor: None,
                approval_requester: None,
                mcp_executor: None,
                mcp_approval_requester: None,
                mcp_capability: McpToolCapability::default(),
                mcp_execution_lease: Arc::new(tokio::sync::Semaphore::new(1)),
                collaboration: Arc::new(CollaborationCoordinator::default()),
                event_tx,
                active: Arc::new(Mutex::new(BTreeMap::new())),
            },
            event_rx,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn new_with_shell(
        core: Core,
        provider: Arc<dyn ModelProvider>,
        model: String,
        workspace_read: Option<Arc<dyn WorkspaceReadExecutor>>,
        workspace_list: Option<Arc<dyn WorkspaceListExecutor>>,
        workspace_search: Option<Arc<dyn WorkspaceSearchExecutor>>,
        shell_executor: Arc<dyn ShellCommandExecutor>,
        approval_requester: Arc<dyn CommandApprovalRequester>,
    ) -> (Self, mpsc::Receiver<CoreEvent>) {
        let (mut runtime, events) = Self::new_with_workspace_search(
            core,
            provider,
            model,
            workspace_read,
            workspace_list,
            workspace_search,
        );
        runtime.shell_executor = Some(shell_executor);
        runtime.approval_requester = Some(approval_requester);
        (runtime, events)
    }

    pub fn with_workspace_patch(
        mut self,
        workspace_patch: Option<Arc<dyn WorkspacePatchExecutor>>,
    ) -> Self {
        self.workspace_patch = workspace_patch;
        self
    }

    pub fn with_shell_capability(
        mut self,
        shell_executor: Arc<dyn ShellCommandExecutor>,
        approval_requester: Arc<dyn CommandApprovalRequester>,
    ) -> Self {
        self.shell_executor = Some(shell_executor);
        self.approval_requester = Some(approval_requester);
        self
    }

    pub fn with_workspace_instructions(
        mut self,
        workspace_instructions: Option<WorkspaceInstructionsSnapshot>,
    ) -> Self {
        self.workspace_instructions = workspace_instructions.map(Arc::new);
        self
    }

    pub fn with_workspace_skills(
        mut self,
        workspace_skills: Option<WorkspaceSkillsSnapshot>,
    ) -> Self {
        self.workspace_skills = workspace_skills.map(Arc::new);
        self
    }

    pub fn with_mcp(
        mut self,
        executor: Arc<dyn McpToolExecutor>,
        approval_requester: Arc<dyn McpToolApprovalRequester>,
        capability: McpToolCapability,
    ) -> Self {
        self.mcp_executor = Some(executor);
        self.mcp_approval_requester = Some(approval_requester);
        self.mcp_capability = capability;
        self
    }

    pub fn without_model(core: Core) -> (Self, mpsc::Receiver<CoreEvent>) {
        let (event_tx, event_rx) = mpsc::channel(CORE_EVENT_CAPACITY);
        (
            Self {
                core: Arc::new(Mutex::new(core)),
                model_gateway: None,
                workspace_read: None,
                workspace_list: None,
                workspace_search: None,
                workspace_patch: None,
                workspace_instructions: None,
                workspace_skills: None,
                shell_executor: None,
                approval_requester: None,
                mcp_executor: None,
                mcp_approval_requester: None,
                mcp_capability: McpToolCapability::default(),
                mcp_execution_lease: Arc::new(tokio::sync::Semaphore::new(1)),
                collaboration: Arc::new(CollaborationCoordinator::default()),
                event_tx,
                active: Arc::new(Mutex::new(BTreeMap::new())),
            },
            event_rx,
        )
    }

    fn lock_core(&self) -> Result<std::sync::MutexGuard<'_, Core>, CoreError> {
        self.core
            .lock()
            .map_err(|_| CoreError::Internal("core state lock is unavailable".to_string()))
    }
}

impl CoreApi for CoreRuntime {
    fn start_thread(&mut self, request_id: CoreRequestId) -> Result<CoreEvent, CoreError> {
        self.lock_core()?.start_thread(request_id)
    }

    fn contains_thread(&self, thread_id: &ThreadId) -> bool {
        self.lock_core()
            .is_ok_and(|core| core.contains_thread(thread_id))
    }

    fn list_threads(
        &mut self,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, CoreError> {
        self.lock_core()?.list_threads(cursor, limit)
    }

    fn search_threads(
        &mut self,
        query: &str,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, CoreError> {
        self.lock_core()?.search_threads(query, cursor, limit)
    }

    fn archive_thread(&mut self, thread_id: &ThreadId) -> Result<(), CoreError> {
        self.reject_active_turn(thread_id)?;
        self.lock_core()?.archive_thread(thread_id)
    }

    fn unarchive_thread(&mut self, thread_id: &ThreadId) -> Result<(), CoreError> {
        self.reject_active_turn(thread_id)?;
        self.lock_core()?.unarchive_thread(thread_id)
    }

    fn delete_thread(&mut self, thread_id: &ThreadId) -> Result<(), CoreError> {
        self.reject_active_turn(thread_id)?;
        self.lock_core()?.delete_thread(thread_id)
    }

    fn fork_thread(&mut self, thread_id: &ThreadId) -> Result<DurableThreadSnapshot, CoreError> {
        self.reject_active_turn(thread_id)?;
        self.lock_core()?.fork_thread(thread_id)
    }

    fn resume_thread(&mut self, thread_id: &ThreadId) -> Result<DurableThreadSnapshot, CoreError> {
        self.lock_core()?.resume_thread(thread_id)
    }

    fn list_descendants(
        &mut self,
        thread_id: &ThreadId,
    ) -> Result<Vec<DurableThreadSnapshot>, CoreError> {
        self.lock_core()?.list_descendants(thread_id)
    }

    fn start_turn(
        &mut self,
        _request_id: CoreRequestId,
        _thread_id: ThreadId,
    ) -> Result<Vec<CoreEvent>, CoreError> {
        Err(CoreError::Internal(
            "production runtime requires text input".to_string(),
        ))
    }

    fn start_text_turn(
        &mut self,
        request_id: CoreRequestId,
        thread_id: ThreadId,
        input: Option<String>,
    ) -> Result<TurnStartOutcome, CoreError> {
        self.start_text_turn_with_model(request_id, thread_id, input, None)
    }

    fn start_text_turn_with_model(
        &mut self,
        request_id: CoreRequestId,
        thread_id: ThreadId,
        input: Option<String>,
        model_profile_id: Option<String>,
    ) -> Result<TurnStartOutcome, CoreError> {
        let selected_profile_id = match model_profile_id {
            Some(profile_id) => Some(profile_id),
            None => self.lock_core()?.latest_model_profile_id(&thread_id),
        };
        let model_gateway = self
            .model_gateway
            .as_ref()
            .ok_or(CoreError::ModelUnavailable)?
            .resolve(selected_profile_id.as_deref())
            .map_err(|_| CoreError::ModelUnavailable)?;
        let workspace_instructions = self
            .workspace_instructions
            .as_deref()
            .map(workspace_instructions_audit);
        let selection = self
            .workspace_skills
            .as_deref()
            .map(|skills| skills.select(input.as_deref()))
            .transpose()
            .map_err(|_| CoreError::ContextTooLarge)?;
        let workspace_skills = self
            .workspace_skills
            .as_deref()
            .map(|skills| workspace_skills_audit(skills, selection.as_ref()));
        let mut instructions = vec![sugarcode_base_agent_instruction_v1()];
        instructions.extend(workspace_model_instructions(self));
        if let Some(skills) = self.workspace_skills.as_deref()
            && !skills.inventory().is_empty()
        {
            instructions.push(ModelInstruction {
                source: ModelInstructionSource::WorkspaceSkillsInventoryV1,
                content: skills.inventory().to_string(),
            });
        }
        if let Some(content) = selection.and_then(|selection| selection.content) {
            instructions.push(ModelInstruction {
                source: ModelInstructionSource::SelectedWorkspaceSkillsV1,
                content,
            });
        }
        let instruction_context_bytes = instructions
            .iter()
            .map(ModelInstruction::context_bytes)
            .try_fold(0usize, usize::checked_add)
            .ok_or(CoreError::ContextTooLarge)?;
        let tool_context_bytes = AgentLoopState::default()
            .tools_for_round(self, &thread_id)
            .iter()
            .map(sugarcode_model_provider::ModelToolDefinition::context_bytes)
            .try_fold(0usize, usize::checked_add)
            .ok_or(CoreError::ContextTooLarge)?;
        let model_snapshot = DurableModelSelectionSnapshot {
            profile_id: model_gateway.profile_id.to_string(),
            provider_kind: model_gateway.provider_kind.to_string(),
            model_id: model_gateway.model.to_string(),
            display_name: model_gateway.display_name.to_string(),
            context_window_tokens: model_gateway.capabilities.context_window_tokens,
        };
        let mut prepared = self.lock_core()?.prepare_text_turn_with_model_context(
            request_id,
            thread_id.clone(),
            input,
            workspace_instructions,
            workspace_skills,
            instruction_context_bytes,
            tool_context_bytes,
            Some(model_snapshot),
            model_gateway.capabilities.input_compaction_target_bytes(),
        )?;
        prepared.instructions = instructions;
        let cancellation = CancellationToken::new();
        let terminal_state = Arc::new(Mutex::new(TurnPhase::Running));
        let done = Arc::new(TurnDone::default());
        self.active
            .lock()
            .map_err(|_| CoreError::Internal("active turn lock is unavailable".to_string()))?
            .insert(
                thread_id,
                ActiveTurn {
                    turn_id: prepared.turn_id.clone(),
                    cancellation: cancellation.clone(),
                    terminal_state: terminal_state.clone(),
                    done,
                },
            );
        let runtime = self.clone();
        let turn_id = prepared.turn_id.clone();
        tokio::spawn(async move {
            let timeout_runtime = runtime.clone();
            let timeout_prepared = prepared.clone();
            let timeout_cancellation = cancellation.clone();
            let timeout_terminal_state = terminal_state.clone();
            if tokio::time::timeout(
                TURN_TIMEOUT,
                run_turn(
                    runtime,
                    prepared,
                    model_gateway,
                    cancellation,
                    terminal_state,
                ),
            )
            .await
            .is_err()
            {
                timeout_cancellation.cancel();
                let terminal = claim_terminal(
                    &timeout_terminal_state,
                    Terminal::Failed(ModelError::new(ModelErrorKind::Timeout, false)),
                );
                match terminal {
                    Terminal::Interrupted => {
                        finish_interrupted_and_emit(&timeout_runtime, &timeout_prepared, None)
                            .await;
                    }
                    Terminal::Failed(error) => {
                        finish_failed_and_emit(&timeout_runtime, &timeout_prepared, error, None)
                            .await;
                    }
                    Terminal::Completed | Terminal::StateUnavailable => {
                        finish_state_unavailable_and_emit(&timeout_runtime, &timeout_prepared)
                            .await;
                    }
                }
                clear_active(
                    &timeout_runtime,
                    &timeout_prepared.thread_id,
                    &timeout_prepared.turn_id,
                );
            }
        });
        Ok(TurnStartOutcome::Accepted { turn_id })
    }

    fn interrupt_turn(
        &mut self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
    ) -> Result<TurnInterruptOutcome, CoreError> {
        let descendants = self.collaboration.cancel_descendants(thread_id, turn_id);
        if let Ok(active) = self.active.lock() {
            for child_thread_id in descendants {
                if let Some(child) = active.get(&child_thread_id) {
                    child.cancellation.cancel();
                }
            }
        }
        let active = self
            .active
            .lock()
            .map_err(|_| CoreError::Internal("active turn lock is unavailable".to_string()))?;
        match active.get(thread_id).cloned() {
            Some(active) if &active.turn_id == turn_id => {
                let mut phase = active.terminal_state.lock().map_err(|_| {
                    CoreError::Internal("turn phase lock is unavailable".to_string())
                })?;
                if *phase == TurnPhase::Running {
                    *phase = TurnPhase::InterruptRequested;
                    drop(phase);
                    active.cancellation.cancel();
                    Ok(TurnInterruptOutcome::Accepted)
                } else {
                    Ok(TurnInterruptOutcome::AlreadyTerminal)
                }
            }
            Some(_) => Err(CoreError::NoActiveTurn(thread_id.clone())),
            None if self.lock_core()?.contains_turn(thread_id, turn_id) => {
                Ok(TurnInterruptOutcome::AlreadyTerminal)
            }
            None => Err(CoreError::NoActiveTurn(thread_id.clone())),
        }
    }

    fn shutdown(&mut self) -> futures_util::future::BoxFuture<'static, Result<(), CoreError>> {
        let active = match self.active.lock() {
            Ok(active) => active.values().cloned().collect::<Vec<_>>(),
            Err(_) => {
                return async {
                    Err(CoreError::Internal(
                        "active turn lock is unavailable".to_string(),
                    ))
                }
                .boxed();
            }
        };
        for turn in &active {
            if let Ok(mut phase) = turn.terminal_state.lock()
                && *phase == TurnPhase::Running
            {
                *phase = TurnPhase::InterruptRequested;
            }
            turn.cancellation.cancel();
        }
        async move {
            for turn in active {
                turn.done.wait().await;
            }
            Ok(())
        }
        .boxed()
    }
}

impl CoreRuntime {
    fn reject_active_turn(&self, thread_id: &ThreadId) -> Result<(), CoreError> {
        let active = self
            .active
            .lock()
            .map_err(|_| CoreError::Internal("active turn lock is unavailable".to_string()))?;
        if let Some(turn) = active.get(thread_id) {
            Err(CoreError::TurnAlreadyActive {
                thread_id: thread_id.clone(),
                turn_id: turn.turn_id.clone(),
            })
        } else {
            Ok(())
        }
    }
}

async fn run_turn(
    runtime: CoreRuntime,
    prepared: crate::PreparedTextTurn,
    model_gateway: ModelGateway,
    cancellation: CancellationToken,
    terminal_state: Arc<Mutex<TurnPhase>>,
) {
    let request_id = prepared.request_id;
    let thread_id = prepared.thread_id.clone();
    let turn_id = prepared.turn_id.clone();
    let _workspace_collaboration_permit =
        if let Some(access) = runtime.collaboration.access_for_child(&thread_id) {
            Some(runtime.collaboration.acquire_workspace(access).await)
        } else {
            None
        };
    let mut opening = vec![CoreEventKind::TurnStarted {
        thread_id: thread_id.clone(),
        turn_id: turn_id.clone(),
    }];
    if let Some(user_item) = prepared.user_item.as_ref() {
        opening.push(CoreEventKind::ItemStarted {
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            item: user_item.clone(),
        });
        opening.push(CoreEventKind::ItemCompleted {
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            item: user_item.clone(),
        });
    }
    for kind in opening {
        if runtime
            .event_tx
            .send(CoreEvent { request_id, kind })
            .await
            .is_err()
        {
            let _ = finish_interrupted(&runtime, &prepared, None).await;
            clear_active(&runtime, &thread_id, &turn_id);
            return;
        }
    }

    let mut messages = prepared
        .history
        .iter()
        .map(prepared_model_message)
        .collect::<Vec<_>>();
    let mut usage = None;
    let mut agent_loop = AgentLoopState::default();
    let mut compaction_ordinal = 0u64;
    let mut response_ordinal = 0u64;
    let mut context_recovery_attempts = 0usize;
    let mut last_successful_request_bytes = None::<usize>;
    let terminal = 'rounds: loop {
        messages.extend(
            runtime
                .collaboration
                .take_amendments(&thread_id)
                .into_iter()
                .map(|amendment| ModelMessage::Text {
                    role: ModelRole::User,
                    text: format!("# Task amendment\n\n{amendment}"),
                }),
        );
        let tools = agent_loop.tools_for_round(&runtime, &thread_id);
        let initial_request = ModelRequest {
            model: model_gateway.model.to_string(),
            instructions: prepared.instructions.clone(),
            messages: messages.clone(),
            tools: tools.clone(),
        };
        if initial_request.context_bytes()
            > model_gateway.capabilities.input_compaction_target_bytes()
        {
            compaction_ordinal = match compaction_ordinal.checked_add(1) {
                Some(value) => value,
                None => {
                    break Terminal::Failed(ModelError::new(ModelErrorKind::OutputTooLarge, false));
                }
            };
            match compact_active_turn(
                &runtime,
                &prepared,
                &model_gateway,
                &messages,
                &tools,
                compaction_ordinal,
                &cancellation,
                &mut usage,
            )
            .await
            {
                Ok(compacted) => messages = compacted,
                Err(terminal) => break terminal,
            }
        }
        let request = ModelRequest {
            model: model_gateway.model.to_string(),
            instructions: prepared.instructions.clone(),
            messages: messages.clone(),
            tools: tools.clone(),
        };
        if request.context_bytes() > model_gateway.capabilities.input_compaction_target_bytes() {
            break Terminal::Failed(ModelError::new(ModelErrorKind::OutputTooLarge, false));
        }
        let request_context_bytes = request.context_bytes();
        let stream = tokio::select! {
            biased;
            _ = cancellation.cancelled() => break 'rounds Terminal::Interrupted,
            result = model_gateway.provider.stream(request) => result,
        };
        let mut stream = match stream {
            Ok(stream) => stream,
            Err(error) => {
                let should_recover = match error.kind() {
                    ModelErrorKind::ContextLengthExceeded => {
                        context_recovery_attempts < MAX_EXPLICIT_CONTEXT_RECOVERIES
                    }
                    ModelErrorKind::InvalidRequest => {
                        context_recovery_attempts < MAX_AMBIGUOUS_CONTEXT_RECOVERIES
                            && last_successful_request_bytes
                                .is_some_and(|bytes| request_context_bytes > bytes)
                    }
                    _ => false,
                };
                if !should_recover {
                    break 'rounds Terminal::Failed(error);
                }
                compaction_ordinal = match compaction_ordinal.checked_add(1) {
                    Some(value) => value,
                    None => break 'rounds Terminal::Failed(output_too_large_error()),
                };
                match compact_active_turn(
                    &runtime,
                    &prepared,
                    &model_gateway,
                    &messages,
                    &tools,
                    compaction_ordinal,
                    &cancellation,
                    &mut usage,
                )
                .await
                {
                    Ok(compacted) => {
                        messages = compacted;
                        context_recovery_attempts += 1;
                        continue 'rounds;
                    }
                    Err(terminal) => break 'rounds terminal,
                }
            }
        };
        response_ordinal = match response_ordinal.checked_add(1) {
            Some(value) => value,
            None => break Terminal::Failed(output_too_large_error()),
        };
        let mut preview_text = BTreeMap::<u32, String>::new();
        loop {
            let next = tokio::select! {
                biased;
                _ = cancellation.cancelled() => break 'rounds Terminal::Interrupted,
                next = stream.next() => next,
            };
            match next {
                Some(Ok(ModelEvent::OutputTextDelta {
                    output_index,
                    delta,
                })) if !delta.is_empty() => {
                    let preview = preview_text.entry(output_index).or_default();
                    if preview
                        .len()
                        .checked_add(delta.len())
                        .is_none_or(|bytes| bytes > crate::thread::MAX_AGENT_MESSAGE_BYTES)
                    {
                        break 'rounds Terminal::Failed(output_too_large_error());
                    }
                    preview.push_str(&delta);
                    if !send_event(
                        &runtime,
                        &cancellation,
                        request_id,
                        CoreEventKind::AgentOutputDelta {
                            thread_id: thread_id.clone(),
                            turn_id: turn_id.clone(),
                            output: CoreAgentOutputRef {
                                response_ordinal,
                                output_index,
                            },
                            delta,
                        },
                    )
                    .await
                    {
                        break 'rounds Terminal::Interrupted;
                    }
                }
                Some(Ok(ModelEvent::OutputTextDelta { .. })) => {}
                Some(Ok(ModelEvent::ResponseCompleted(response))) => {
                    let trailing = tokio::select! {
                        biased;
                        _ = cancellation.cancelled() => break 'rounds Terminal::Interrupted,
                        trailing = stream.next() => trailing,
                    };
                    if trailing.is_some() {
                        break 'rounds Terminal::Failed(ModelError::new(
                            ModelErrorKind::Protocol,
                            false,
                        ));
                    }
                    last_successful_request_bytes = Some(request_context_bytes);
                    if let Some(value) = response.usage
                        && !accumulate_usage(&mut usage, value)
                    {
                        break 'rounds Terminal::Failed(output_too_large_error());
                    }
                    let round_output = match classify_model_response(response, &preview_text) {
                        Ok(output) => output,
                        Err(error) => break 'rounds Terminal::Failed(error),
                    };
                    let mut tool_calls = match round_output {
                        CompletedRoundOutput::Final { output_index, text } => {
                            let item = match runtime
                                .lock_core()
                                .and_then(|mut core| core.start_agent_message(&thread_id, &turn_id))
                            {
                                Ok(item) => item,
                                Err(_) => break 'rounds Terminal::StateUnavailable,
                            };
                            let durable_event = CancellationToken::new();
                            if !send_event(
                                &runtime,
                                &durable_event,
                                request_id,
                                CoreEventKind::AgentOutputResolved {
                                    thread_id: thread_id.clone(),
                                    turn_id: turn_id.clone(),
                                    output: CoreAgentOutputRef {
                                        response_ordinal,
                                        output_index,
                                    },
                                    item: item.clone(),
                                },
                            )
                            .await
                            {
                                break 'rounds Terminal::StateUnavailable;
                            }
                            match runtime.lock_core().and_then(|mut core| {
                                core.append_text_delta(&thread_id, &turn_id, &text)
                            }) {
                                Ok(_) => {}
                                Err(CoreError::OutputTooLarge) => {
                                    break 'rounds Terminal::Failed(output_too_large_error());
                                }
                                Err(_) => break 'rounds Terminal::StateUnavailable,
                            }
                            if !send_event(
                                &runtime,
                                &cancellation,
                                request_id,
                                CoreEventKind::AgentMessageDelta {
                                    thread_id: thread_id.clone(),
                                    turn_id: turn_id.clone(),
                                    item_id: item.id,
                                    delta: text,
                                },
                            )
                            .await
                            {
                                break 'rounds Terminal::Interrupted;
                            }
                            Vec::new()
                        }
                        CompletedRoundOutput::ToolUse { commentary, calls } => {
                            if let Some((output_index, text)) = commentary {
                                if let Err(error) = append_completed_agent_output_item(
                                    &runtime,
                                    &prepared,
                                    CoreAgentOutputRef {
                                        response_ordinal,
                                        output_index,
                                    },
                                    CoreItemKind::AgentCommentary { text: text.clone() },
                                )
                                .await
                                {
                                    break 'rounds error;
                                }
                                messages.push(ModelMessage::Commentary { text });
                            }
                            calls
                        }
                    };
                    if tool_calls.is_empty() {
                        if !runtime
                            .collaboration
                            .parent_can_complete(&thread_id, &turn_id)
                        {
                            break 'rounds Terminal::Failed(ModelError::new(
                                ModelErrorKind::Incomplete,
                                false,
                            ));
                        }
                        break 'rounds Terminal::Completed;
                    }
                    if tool_calls.iter().any(|call| !agent_loop.observe_call(call)) {
                        break 'rounds Terminal::Failed(ModelError::new(
                            ModelErrorKind::UnsupportedOutput,
                            false,
                        ));
                    }
                    match validate_tool_call_batch(&runtime, &tool_calls) {
                        Ok(()) => agent_loop.reset_tool_argument_errors(),
                        Err(ToolBatchValidationFailure::Fatal(error)) => {
                            break 'rounds Terminal::Failed(error);
                        }
                        Err(ToolBatchValidationFailure::Rejected(rejection)) => {
                            let repeated = agent_loop
                                .record_tool_argument_error(rejection.fingerprint.clone());
                            if let Err(error) = record_rejected_tool_batch(
                                &runtime,
                                &prepared,
                                &mut messages,
                                &tool_calls,
                                &rejection,
                            )
                            .await
                            {
                                break 'rounds error;
                            }
                            if repeated {
                                break 'rounds Terminal::Failed(ModelError::new(
                                    ModelErrorKind::UnsupportedToolArguments,
                                    false,
                                ));
                            }
                            continue 'rounds;
                        }
                    }
                    if tool_calls.len() > 1
                        && tool_calls.iter().all(|call| {
                            matches!(
                                call.name.as_str(),
                                "workspace/read" | "workspace/list" | "workspace/search"
                            )
                        })
                    {
                        let contents = match execute_read_only_tool_batch(
                            &runtime,
                            &prepared,
                            &tool_calls,
                            &cancellation,
                        )
                        .await
                        {
                            Ok(contents) => contents,
                            Err(error) => break 'rounds error,
                        };
                        messages.push(ModelMessage::ToolCallBatch(tool_calls.clone()));
                        messages.extend(tool_calls.drain(..).zip(contents).map(
                            |(call, content)| ModelMessage::ToolResult {
                                call_id: call.id,
                                content,
                            },
                        ));
                        continue 'rounds;
                    }
                    let batch_calls_persisted = tool_calls.len() > 1;
                    if batch_calls_persisted
                        && let Err(error) =
                            persist_mixed_batch_calls(&runtime, &prepared, &tool_calls).await
                    {
                        break 'rounds error;
                    }
                    let mut batch_results = Vec::new();
                    let mut pending_calls =
                        std::collections::VecDeque::from(std::mem::take(&mut tool_calls));
                    'tool_batch: while let Some(call) = pending_calls.pop_front() {
                        let tool_available = match call.name.as_str() {
                            name if name.starts_with("collaboration/") => {
                                !runtime.collaboration.is_child_thread(&thread_id)
                            }
                            "workspace/read" => runtime.workspace_read.is_some(),
                            "workspace/list" => runtime.workspace_list.is_some(),
                            "workspace/search" => runtime.workspace_search.is_some(),
                            "workspace/apply-patch" => runtime.workspace_patch.is_some(),
                            "shell/exec" => {
                                runtime.shell_executor.is_some()
                                    && runtime.approval_requester.is_some()
                            }
                            name if name.starts_with("mcp__") => {
                                runtime.mcp_capability.is_enabled()
                                    && runtime.mcp_approval_requester.is_some()
                                    && runtime.mcp_executor.as_ref().is_some_and(|executor| {
                                        executor
                                            .definitions()
                                            .iter()
                                            .any(|definition| definition.name == name)
                                    })
                            }
                            _ => false,
                        };
                        if !tool_available {
                            break 'rounds Terminal::Failed(ModelError::new(
                                ModelErrorKind::UnsupportedOutput,
                                false,
                            ));
                        }
                        if call.name != "workspace/apply-patch" {
                            agent_loop.reset_tool_execution_errors();
                        }
                        if call.name.starts_with("collaboration/") {
                            if !batch_calls_persisted
                                && let Err(error) = append_completed_tool_item(
                                    &runtime,
                                    &prepared,
                                    CoreItemKind::ToolCall {
                                        call_id: call.id.clone(),
                                        name: call.name.clone(),
                                        path: String::new(),
                                        query: None,
                                        patch: None,
                                        command: None,
                                        arguments: None,
                                    },
                                )
                                .await
                            {
                                break 'rounds error;
                            }
                            let coordinator = runtime.collaboration.clone();
                            let content = match call.name.as_str() {
                                "collaboration/dispatch" => {
                                    coordinator
                                        .dispatch(&runtime, &prepared, &model_gateway, &call)
                                        .await
                                }
                                "collaboration/amend" => {
                                    coordinator.amend(&runtime, &prepared, &call).await
                                }
                                "collaboration/wait" => {
                                    coordinator
                                        .wait(&runtime, &prepared, &call, &cancellation)
                                        .await
                                }
                                "collaboration/interrupt" => {
                                    coordinator.interrupt(&runtime, &prepared, &call)
                                }
                                _ => Err(Terminal::Failed(ModelError::new(
                                    ModelErrorKind::UnsupportedOutput,
                                    false,
                                ))),
                            };
                            let content = match content {
                                Ok(content) => content,
                                Err(error) => break 'rounds error,
                            };
                            let result = CoreToolResult::Success {
                                bytes: u64::try_from(content.len()).unwrap_or(u64::MAX),
                                content: content.clone(),
                            };
                            if serialized_tool_result_bytes(&result)
                                > MAX_SERIALIZED_TOOL_RESULT_BYTES
                            {
                                break 'rounds Terminal::Failed(ModelError::new(
                                    ModelErrorKind::OutputTooLarge,
                                    false,
                                ));
                            }
                            if let Err(error) = append_completed_tool_item(
                                &runtime,
                                &prepared,
                                CoreItemKind::ToolResult {
                                    call_id: call.id.clone(),
                                    name: call.name.clone(),
                                    result,
                                },
                            )
                            .await
                            {
                                break 'rounds error;
                            }
                            if record_executed_tool_call(
                                &mut messages,
                                &mut batch_results,
                                batch_calls_persisted,
                                call,
                                content,
                                pending_calls.is_empty(),
                            ) {
                                continue 'rounds;
                            }
                            continue 'tool_batch;
                        }
                        if call.name.starts_with("mcp__") {
                            let prepared_call = match runtime
                                .mcp_executor
                                .as_ref()
                                .expect("validated MCP executor")
                                .prepare(&call.name, call.arguments.clone())
                            {
                                Ok(call) => call,
                                Err(McpToolPrepareError::ArgumentTooLarge) => {
                                    break 'rounds Terminal::Failed(ModelError::new(
                                        ModelErrorKind::OutputTooLarge,
                                        false,
                                    ));
                                }
                                Err(
                                    McpToolPrepareError::InvalidArguments
                                    | McpToolPrepareError::ValueTooComplex
                                    | McpToolPrepareError::InputSchemaMismatch,
                                ) => {
                                    break 'rounds Terminal::Failed(ModelError::new(
                                        ModelErrorKind::InvalidRequest,
                                        false,
                                    ));
                                }
                                Err(McpToolPrepareError::Unavailable) => {
                                    break 'rounds Terminal::Failed(ModelError::new(
                                        ModelErrorKind::UnsupportedOutput,
                                        false,
                                    ));
                                }
                            };
                            if !batch_calls_persisted
                                && let Err(error) = append_completed_tool_item(
                                    &runtime,
                                    &prepared,
                                    CoreItemKind::McpToolCall {
                                        call_id: call.id.clone(),
                                        name: call.name.clone(),
                                        arguments: prepared_call.arguments.clone(),
                                        arguments_bytes: prepared_call.arguments_bytes,
                                        arguments_sha256: prepared_call.arguments_sha256.clone(),
                                        inventory_sha256: prepared_call.inventory_sha256.clone(),
                                    },
                                )
                                .await
                            {
                                break 'rounds error;
                            }
                            let approval_id =
                                format!("approval/{}/{}/{}", thread_id, turn_id, call.id);
                            if let Err(error) = append_completed_tool_item(
                                &runtime,
                                &prepared,
                                CoreItemKind::McpToolCallApprovalRequest {
                                    approval_id: approval_id.clone(),
                                    call_id: call.id.clone(),
                                    name: call.name.clone(),
                                    arguments: prepared_call.arguments.clone(),
                                    arguments_bytes: prepared_call.arguments_bytes,
                                    arguments_sha256: prepared_call.arguments_sha256.clone(),
                                    inventory_sha256: prepared_call.inventory_sha256.clone(),
                                },
                            )
                            .await
                            {
                                break 'rounds error;
                            }
                            let approval = runtime
                                .mcp_approval_requester
                                .as_ref()
                                .expect("validated MCP approval requester")
                                .request(McpToolApprovalRequest {
                                    approval_id: approval_id.clone(),
                                    thread_id: thread_id.clone(),
                                    turn_id: turn_id.clone(),
                                    call_id: call.id.clone(),
                                    name: call.name.clone(),
                                    arguments: prepared_call.arguments.clone(),
                                    arguments_bytes: prepared_call.arguments_bytes,
                                    arguments_sha256: prepared_call.arguments_sha256.clone(),
                                    inventory_sha256: prepared_call.inventory_sha256.clone(),
                                });
                            let approval = tokio::select! {
                                biased;
                                _ = cancellation.cancelled() => None,
                                result = tokio::time::timeout(
                                    std::time::Duration::from_secs(120),
                                    approval,
                                ) => Some(result.unwrap_or(McpToolApprovalOutcome::TimedOut)),
                            };
                            let decision = match approval {
                            Some(McpToolApprovalOutcome::Approved) => {
                                sugarcode_protocol::CoreCommandApprovalDecision::Approved
                            }
                            Some(McpToolApprovalOutcome::Denied) => {
                                sugarcode_protocol::CoreCommandApprovalDecision::Denied
                            }
                            Some(McpToolApprovalOutcome::TimedOut) => {
                                sugarcode_protocol::CoreCommandApprovalDecision::TimedOut
                            }
                            Some(McpToolApprovalOutcome::Unsupported) => {
                                sugarcode_protocol::CoreCommandApprovalDecision::Unsupported
                            }
                            Some(McpToolApprovalOutcome::ClientDisconnected) => {
                                sugarcode_protocol::CoreCommandApprovalDecision::ClientDisconnected
                            }
                            None => sugarcode_protocol::CoreCommandApprovalDecision::Cancelled,
                        };
                            if let Err(error) = append_completed_tool_item(
                                &runtime,
                                &prepared,
                                CoreItemKind::McpToolCallApprovalDecision {
                                    approval_id: approval_id.clone(),
                                    decision,
                                },
                            )
                            .await
                            {
                                break 'rounds error;
                            }
                            let (mut result, mut content, interrupted) = match approval {
                                Some(McpToolApprovalOutcome::Approved) => {
                                    agent_loop.reset_approval_denials();
                                    match runtime.mcp_execution_lease.clone().try_acquire_owned() {
                                        Ok(_lease) => {
                                            if let Err(error) = append_completed_tool_item(
                                                &runtime,
                                                &prepared,
                                                CoreItemKind::McpToolExecutionAttempt {
                                                    approval_id,
                                                    call_id: call.id.clone(),
                                                    inventory_sha256: prepared_call
                                                        .inventory_sha256
                                                        .clone(),
                                                },
                                            )
                                            .await
                                            {
                                                break 'rounds error;
                                            }
                                            let outcome = runtime
                                                .mcp_executor
                                                .as_ref()
                                                .expect("validated MCP executor")
                                                .execute(
                                                    prepared_call.clone(),
                                                    cancellation.clone(),
                                                )
                                                .await;
                                            mcp_execution_result(outcome)
                                        }
                                        Err(_) => {
                                            mcp_error_result("concurrencyDenied", "notSent", false)
                                        }
                                    }
                                }
                                Some(McpToolApprovalOutcome::Denied) => {
                                    mcp_error_result("approvalDenied", "notSent", false)
                                }
                                Some(McpToolApprovalOutcome::TimedOut) => {
                                    mcp_error_result("approvalTimedOut", "notSent", false)
                                }
                                Some(McpToolApprovalOutcome::Unsupported) => {
                                    mcp_error_result("approvalUnsupported", "notSent", false)
                                }
                                Some(McpToolApprovalOutcome::ClientDisconnected) => {
                                    mcp_error_result("clientDisconnected", "notSent", true)
                                }
                                None => mcp_error_result("cancelled", "notSent", true),
                            };
                            fit_mcp_result_to_budget(
                                &mut result,
                                &mut content,
                                MAX_SERIALIZED_TOOL_RESULT_BYTES,
                            );
                            let result_bytes = serialized_mcp_result_bytes(&result);
                            if result_bytes > MAX_SERIALIZED_TOOL_RESULT_BYTES {
                                break 'rounds Terminal::Failed(ModelError::new(
                                    ModelErrorKind::OutputTooLarge,
                                    false,
                                ));
                            }
                            if let Err(error) = append_completed_tool_item(
                                &runtime,
                                &prepared,
                                CoreItemKind::McpToolResult {
                                    call_id: call.id.clone(),
                                    name: call.name.clone(),
                                    result,
                                },
                            )
                            .await
                            {
                                break 'rounds error;
                            }
                            if interrupted {
                                break 'rounds Terminal::Interrupted;
                            }
                            if matches!(approval, Some(McpToolApprovalOutcome::Denied))
                                && agent_loop.record_approval_denied()
                            {
                                break 'rounds Terminal::Interrupted;
                            }
                            if record_executed_tool_call(
                                &mut messages,
                                &mut batch_results,
                                batch_calls_persisted,
                                call,
                                content,
                                pending_calls.is_empty(),
                            ) {
                                continue 'rounds;
                            }
                            continue 'tool_batch;
                        }
                        if call.name == "shell/exec" {
                            let arguments = match shell_tool_arguments(&call) {
                                Ok(arguments) => arguments,
                                Err(error) => break 'rounds Terminal::Failed(error),
                            };
                            let command_policy = runtime
                                .shell_executor
                                .as_ref()
                                .expect("validated shell executor")
                                .sandbox_policy();
                            let _root_workspace_permit =
                                if runtime.collaboration.access_for_child(&thread_id).is_none() {
                                    Some(
                                        runtime
                                            .collaboration
                                            .acquire_workspace(
                                                if command_policy.workspace_write.is_some() {
                                                    AgentAccess::WorkspaceWrite
                                                } else {
                                                    AgentAccess::ReadOnly
                                                },
                                            )
                                            .await,
                                    )
                                } else {
                                    None
                                };
                            if !batch_calls_persisted
                                && let Err(error) = append_completed_tool_item(
                                    &runtime,
                                    &prepared,
                                    CoreItemKind::ToolCall {
                                        call_id: call.id.clone(),
                                        name: call.name.clone(),
                                        path: arguments.cwd.clone(),
                                        query: None,
                                        patch: None,
                                        command: Some(arguments.command.clone()),
                                        arguments: Some(arguments.arguments.clone()),
                                    },
                                )
                                .await
                            {
                                break 'rounds error;
                            }
                            let filesystem_policy =
                                core_filesystem_policy(command_policy.filesystem);
                            let workspace_write_policy = command_policy
                                .workspace_write
                                .map(core_workspace_write_policy);
                            let workspace_write_risk = workspace_write_policy.map(|_| {
                            sugarcode_protocol::CoreCommandWorkspaceWriteRisk::NonTransactionalWorkspaceTreeV1
                        });
                            let network_policy = core_network_policy(command_policy.network);
                            let approval_id =
                                format!("approval/{}/{}/{}", thread_id, turn_id, call.id);
                            if let Err(error) = append_completed_tool_item(
                                &runtime,
                                &prepared,
                                CoreItemKind::CommandApprovalRequest {
                                    approval_id: approval_id.clone(),
                                    call_id: call.id.clone(),
                                    command: arguments.command.clone(),
                                    arguments: arguments.arguments.clone(),
                                    cwd: arguments.cwd.clone(),
                                    environment_policy: "minimalV1".to_string(),
                                    sandboxed: true,
                                    sandbox_policy: Some(filesystem_policy),
                                    workspace_write_policy,
                                    workspace_write_risk,
                                    network_policy: Some(network_policy),
                                },
                            )
                            .await
                            {
                                break 'rounds error;
                            }
                            let approval = runtime
                                .approval_requester
                                .as_ref()
                                .expect("validated approval requester")
                                .request(CommandApprovalRequest {
                                    approval_id: approval_id.clone(),
                                    thread_id: thread_id.clone(),
                                    turn_id: turn_id.clone(),
                                    call_id: call.id.clone(),
                                    description: arguments.description.clone(),
                                    command: arguments.command.clone(),
                                    arguments: arguments.arguments.clone(),
                                    cwd: arguments.cwd.clone(),
                                    environment_policy: "minimalV1".to_string(),
                                    sandboxed: true,
                                    sandbox_policy: filesystem_policy,
                                    workspace_write_policy,
                                    workspace_write_risk,
                                    network_policy,
                                });
                            let approval = tokio::select! {
                                biased;
                                _ = cancellation.cancelled() => None,
                                result = tokio::time::timeout(
                                    std::time::Duration::from_secs(120),
                                    approval,
                                ) => Some(result.unwrap_or(CommandApprovalOutcome::TimedOut)),
                            };
                            let decision = match approval {
                            Some(CommandApprovalOutcome::Approved) => {
                                sugarcode_protocol::CoreCommandApprovalDecision::Approved
                            }
                            Some(CommandApprovalOutcome::Denied) => {
                                sugarcode_protocol::CoreCommandApprovalDecision::Denied
                            }
                            Some(CommandApprovalOutcome::TimedOut) => {
                                sugarcode_protocol::CoreCommandApprovalDecision::TimedOut
                            }
                            Some(CommandApprovalOutcome::Unsupported) => {
                                sugarcode_protocol::CoreCommandApprovalDecision::Unsupported
                            }
                            Some(CommandApprovalOutcome::ClientDisconnected) => {
                                sugarcode_protocol::CoreCommandApprovalDecision::ClientDisconnected
                            }
                            None => sugarcode_protocol::CoreCommandApprovalDecision::Cancelled,
                        };
                            if let Err(error) = append_completed_tool_item(
                                &runtime,
                                &prepared,
                                CoreItemKind::CommandApprovalDecision {
                                    approval_id: approval_id.clone(),
                                    decision,
                                    workspace_write_risk_acknowledgement: matches!(
                                        decision,
                                        sugarcode_protocol::CoreCommandApprovalDecision::Approved
                                    )
                                    .then_some(workspace_write_risk)
                                    .flatten(),
                                },
                            )
                            .await
                            {
                                break 'rounds error;
                            }
                            let (mut result, mut content) = match approval {
                                None | Some(CommandApprovalOutcome::ClientDisconnected) => {
                                    break 'rounds Terminal::Interrupted;
                                }
                                Some(CommandApprovalOutcome::Denied) => {
                                    let result = CoreToolResult::Error {
                                        kind: CoreToolErrorKind::ApprovalDenied,
                                    };
                                    let content = "shell/exec error: approvalDenied".to_string();
                                    (result, content)
                                }
                                Some(CommandApprovalOutcome::TimedOut) => {
                                    let result = CoreToolResult::Error {
                                        kind: CoreToolErrorKind::ApprovalTimedOut,
                                    };
                                    let content = "shell/exec error: approvalTimedOut".to_string();
                                    (result, content)
                                }
                                Some(CommandApprovalOutcome::Unsupported) => {
                                    let result = CoreToolResult::Error {
                                        kind: CoreToolErrorKind::ApprovalUnsupported,
                                    };
                                    let content =
                                        "shell/exec error: approvalUnsupported".to_string();
                                    (result, content)
                                }
                                Some(CommandApprovalOutcome::Approved) => {
                                    agent_loop.reset_approval_denials();
                                    if let Err(error) = append_completed_tool_item(
                                        &runtime,
                                        &prepared,
                                        CoreItemKind::CommandExecutionAttempt {
                                            approval_id: approval_id.clone(),
                                            call_id: call.id.clone(),
                                        },
                                    )
                                    .await
                                    {
                                        break 'rounds error;
                                    }
                                    let execution = runtime
                                        .shell_executor
                                        .as_ref()
                                        .expect("validated shell executor")
                                        .execute(
                                            ShellCommandArguments {
                                                command: arguments.command.clone(),
                                                arguments: arguments.arguments.clone(),
                                            },
                                            cancellation.clone(),
                                        )
                                        .await;
                                    match shell_execution_result(execution) {
                                        Some(result) => result,
                                        None => break 'rounds Terminal::Interrupted,
                                    }
                                }
                            };
                            let mut result_bytes = serialized_tool_result_bytes(&result);
                            if result_bytes > MAX_SERIALIZED_TOOL_RESULT_BYTES {
                                result = CoreToolResult::Error {
                                    kind: CoreToolErrorKind::ResultTooLarge,
                                };
                                content = "shell/exec error: resultTooLarge".to_string();
                                result_bytes = serialized_tool_result_bytes(&result);
                            }
                            debug_assert!(result_bytes <= MAX_SERIALIZED_TOOL_RESULT_BYTES);
                            if let Err(error) = append_completed_tool_item(
                                &runtime,
                                &prepared,
                                CoreItemKind::ToolResult {
                                    call_id: call.id.clone(),
                                    name: call.name.clone(),
                                    result,
                                },
                            )
                            .await
                            {
                                break 'rounds error;
                            }
                            if matches!(approval, Some(CommandApprovalOutcome::Denied))
                                && agent_loop.record_approval_denied()
                            {
                                break 'rounds Terminal::Interrupted;
                            }
                            if record_executed_tool_call(
                                &mut messages,
                                &mut batch_results,
                                batch_calls_persisted,
                                call,
                                content,
                                pending_calls.is_empty(),
                            ) {
                                continue 'rounds;
                            }
                            continue 'tool_batch;
                        }
                        let arguments = match workspace_tool_arguments(&call) {
                            Ok(arguments) => arguments,
                            Err(error) => break 'rounds Terminal::Failed(error),
                        };
                        let _root_workspace_permit =
                            if runtime.collaboration.access_for_child(&thread_id).is_none() {
                                Some(
                                    runtime
                                        .collaboration
                                        .acquire_workspace(
                                            if call.name == "workspace/apply-patch" {
                                                AgentAccess::WorkspaceWrite
                                            } else {
                                                AgentAccess::ReadOnly
                                            },
                                        )
                                        .await,
                                )
                            } else {
                                None
                            };
                        agent_loop.reset_approval_denials();
                        if !batch_calls_persisted
                            && let Err(error) = append_completed_tool_item(
                                &runtime,
                                &prepared,
                                CoreItemKind::ToolCall {
                                    call_id: call.id.clone(),
                                    name: call.name.clone(),
                                    path: arguments.path.clone(),
                                    query: arguments.query.clone(),
                                    patch: arguments.patch.clone(),
                                    command: None,
                                    arguments: None,
                                },
                            )
                            .await
                        {
                            break 'rounds error;
                        }
                        if call.name == "workspace/apply-patch" {
                            let prepare_outcome = runtime
                                .workspace_patch
                                .as_ref()
                                .expect("validated workspace/apply-patch executor")
                                .prepare(
                                    &WorkspacePatchArguments {
                                        path: arguments.path.clone(),
                                        patch: arguments
                                            .patch
                                            .clone()
                                            .expect("validated workspace/apply-patch input"),
                                    },
                                    &cancellation,
                                )
                                .await;
                            let (mut result, mut content, interrupted_after_commit) =
                                match prepare_outcome {
                                    WorkspacePatchPrepareOutcome::Error {
                                        kind: WorkspacePatchErrorKind::Cancelled,
                                    } => break 'rounds Terminal::Interrupted,
                                    WorkspacePatchPrepareOutcome::Error { kind } => {
                                        let kind = map_workspace_patch_error(kind);
                                        (
                                            CoreToolResult::Error { kind },
                                            format!("workspace/apply-patch error: {kind}"),
                                            false,
                                        )
                                    }
                                    WorkspacePatchPrepareOutcome::Prepared(proposal) => {
                                        let file_change = CoreItemKind::FileChange {
                                            call_id: call.id.clone(),
                                            path: proposal.path().to_string(),
                                            kind: CoreFileChangeKind::Update,
                                            diff: proposal.diff().to_string(),
                                            before_sha256: proposal.before_sha256().to_string(),
                                            after_sha256: proposal.after_sha256().to_string(),
                                            before_bytes: proposal.before_bytes(),
                                            after_bytes: proposal.after_bytes(),
                                            newline_style: match proposal.newline() {
                                                sugarcode_tools::WorkspaceNewlineStyle::Lf => {
                                                    CoreFileChangeNewlineStyle::Lf
                                                }
                                                sugarcode_tools::WorkspaceNewlineStyle::CrLf => {
                                                    CoreFileChangeNewlineStyle::CrLf
                                                }
                                            },
                                            final_newline: proposal.final_newline(),
                                        };
                                        let change_bytes =
                                            serialized_file_change_bytes(&file_change);
                                        if change_bytes <= MAX_SERIALIZED_TOOL_RESULT_BYTES {
                                            if let Err(error) = append_completed_tool_item(
                                                &runtime,
                                                &prepared,
                                                file_change,
                                            )
                                            .await
                                            {
                                                break 'rounds error;
                                            }
                                            if cancellation.is_cancelled() {
                                                break 'rounds Terminal::Interrupted;
                                            }
                                            // Crossing this barrier means cancellation may no longer abandon
                                            // the filesystem commit. The durable result is recorded first.
                                            let outcome = runtime
                                                .workspace_patch
                                                .as_ref()
                                                .expect("validated workspace/apply-patch executor")
                                                .commit(*proposal, &CancellationToken::new())
                                                .await;
                                            let interrupted = cancellation.is_cancelled();
                                            match outcome {
                                                WorkspacePatchCommitOutcome::Applied {
                                                    path,
                                                    before_sha256,
                                                    after_sha256,
                                                    before_bytes,
                                                    after_bytes,
                                                } => {
                                                    let content = serde_json::to_string(
                                                        &serde_json::json!({
                                                            "path": path,
                                                            "kind": "update",
                                                            "beforeSha256": before_sha256,
                                                            "afterSha256": after_sha256,
                                                            "beforeBytes": before_bytes,
                                                            "afterBytes": after_bytes,
                                                        }),
                                                    )
                                                    .expect(
                                                        "workspace/apply-patch result serializes",
                                                    );
                                                    (
                                                        CoreToolResult::Success {
                                                            bytes: content.len() as u64,
                                                            content: content.clone(),
                                                        },
                                                        content,
                                                        interrupted,
                                                    )
                                                }
                                                WorkspacePatchCommitOutcome::Error { kind } => {
                                                    let kind = map_workspace_patch_error(kind);
                                                    (
                                                        CoreToolResult::Error { kind },
                                                        format!(
                                                            "workspace/apply-patch error: {kind}"
                                                        ),
                                                        interrupted,
                                                    )
                                                }
                                            }
                                        } else {
                                            (
                                                CoreToolResult::Error {
                                                    kind: CoreToolErrorKind::ResultTooLarge,
                                                },
                                                "workspace/apply-patch error: resultTooLarge"
                                                    .to_string(),
                                                false,
                                            )
                                        }
                                    }
                                };
                            let mut result_bytes = serialized_tool_result_bytes(&result);
                            if result_bytes > MAX_SERIALIZED_TOOL_RESULT_BYTES {
                                result = CoreToolResult::Error {
                                    kind: CoreToolErrorKind::ResultTooLarge,
                                };
                                content = "workspace/apply-patch error: resultTooLarge".to_string();
                                result_bytes = serialized_tool_result_bytes(&result);
                            }
                            debug_assert!(result_bytes <= MAX_SERIALIZED_TOOL_RESULT_BYTES);
                            let execution_error_signature = match &result {
                                CoreToolResult::Error {
                                    kind:
                                        kind @ (CoreToolErrorKind::InvalidPatch
                                        | CoreToolErrorKind::PatchDoesNotApply),
                                } => Some(format!("{}:{kind}", call.name)),
                                _ => None,
                            };
                            if let Err(error) = append_completed_tool_item(
                                &runtime,
                                &prepared,
                                CoreItemKind::ToolResult {
                                    call_id: call.id.clone(),
                                    name: call.name.clone(),
                                    result,
                                },
                            )
                            .await
                            {
                                break 'rounds error;
                            }
                            if let Some(signature) = execution_error_signature {
                                if agent_loop.record_tool_execution_error(signature) {
                                    break 'rounds Terminal::Failed(ModelError::new(
                                        ModelErrorKind::UnsupportedToolArguments,
                                        false,
                                    ));
                                }
                            } else {
                                agent_loop.reset_tool_execution_errors();
                            }
                            if interrupted_after_commit {
                                break 'rounds Terminal::Interrupted;
                            }
                            if record_executed_tool_call(
                                &mut messages,
                                &mut batch_results,
                                batch_calls_persisted,
                                call,
                                content,
                                pending_calls.is_empty(),
                            ) {
                                continue 'rounds;
                            }
                            continue 'tool_batch;
                        }
                        let (mut result, mut content) = match call.name.as_str() {
                            "workspace/read" => {
                                let outcome = runtime
                                    .workspace_read
                                    .as_ref()
                                    .expect("validated workspace/read executor")
                                    .read(
                                        &WorkspaceReadArguments {
                                            path: arguments.path.clone(),
                                        },
                                        &cancellation,
                                    )
                                    .await;
                                if matches!(
                                    outcome,
                                    WorkspaceReadOutcome::Error {
                                        kind: WorkspaceReadErrorKind::Cancelled
                                    }
                                ) {
                                    break 'rounds Terminal::Interrupted;
                                }
                                map_workspace_read_outcome(outcome)
                            }
                            "workspace/list" => {
                                let outcome = runtime
                                    .workspace_list
                                    .as_ref()
                                    .expect("validated workspace/list executor")
                                    .list(
                                        &WorkspaceListArguments {
                                            path: arguments.path.clone(),
                                        },
                                        &cancellation,
                                    )
                                    .await;
                                if matches!(
                                    outcome,
                                    WorkspaceListOutcome::Error {
                                        kind: WorkspaceListErrorKind::Cancelled
                                    }
                                ) {
                                    break 'rounds Terminal::Interrupted;
                                }
                                map_workspace_list_outcome(outcome)
                            }
                            "workspace/search" => {
                                let outcome = runtime
                                    .workspace_search
                                    .as_ref()
                                    .expect("validated workspace/search executor")
                                    .search(
                                        &WorkspaceSearchArguments {
                                            path: arguments.path.clone(),
                                            query: arguments
                                                .query
                                                .clone()
                                                .expect("validated workspace/search query"),
                                        },
                                        &cancellation,
                                    )
                                    .await;
                                if matches!(
                                    outcome,
                                    WorkspaceSearchOutcome::Error {
                                        kind: WorkspaceSearchErrorKind::Cancelled
                                    }
                                ) {
                                    break 'rounds Terminal::Interrupted;
                                }
                                map_workspace_search_outcome(outcome)
                            }
                            _ => unreachable!("tool availability was validated"),
                        };
                        let mut result_bytes = serialized_tool_result_bytes(&result);
                        if result_bytes > MAX_SERIALIZED_TOOL_RESULT_BYTES {
                            result = CoreToolResult::Error {
                                kind: CoreToolErrorKind::ResultTooLarge,
                            };
                            content = format!("{} error: resultTooLarge", call.name);
                            result_bytes = serialized_tool_result_bytes(&result);
                        }
                        debug_assert!(result_bytes <= MAX_SERIALIZED_TOOL_RESULT_BYTES);
                        if let Err(error) = append_completed_tool_item(
                            &runtime,
                            &prepared,
                            CoreItemKind::ToolResult {
                                call_id: call.id.clone(),
                                name: call.name.clone(),
                                result,
                            },
                        )
                        .await
                        {
                            break 'rounds error;
                        }
                        if record_executed_tool_call(
                            &mut messages,
                            &mut batch_results,
                            batch_calls_persisted,
                            call,
                            content,
                            pending_calls.is_empty(),
                        ) {
                            continue 'rounds;
                        }
                        continue 'tool_batch;
                    }
                }
                Some(Err(error)) => break 'rounds Terminal::Failed(error),
                None => {
                    break 'rounds Terminal::Failed(ModelError::new(
                        ModelErrorKind::Disconnected,
                        true,
                    ));
                }
            }
        }
    };
    let terminal = claim_terminal(&terminal_state, terminal);
    match terminal {
        Terminal::Completed => finish_completed_and_emit(&runtime, &prepared, usage).await,
        Terminal::Failed(error) => {
            finish_failed_and_emit(&runtime, &prepared, error, usage).await;
        }
        Terminal::Interrupted => finish_interrupted_and_emit(&runtime, &prepared, usage).await,
        Terminal::StateUnavailable => {
            finish_state_unavailable_and_emit(&runtime, &prepared).await;
        }
    }
    clear_active(&runtime, &thread_id, &turn_id);
}

fn validate_tool_call_batch(
    runtime: &CoreRuntime,
    calls: &[ModelToolCall],
) -> Result<(), ToolBatchValidationFailure> {
    let mut call_ids = std::collections::BTreeSet::new();
    let mut kinds = Vec::with_capacity(calls.len());
    for call in calls {
        if !call_ids.insert(call.id.as_str()) {
            return Err(ToolBatchValidationFailure::Fatal(ModelError::new(
                ModelErrorKind::Protocol,
                false,
            )));
        }
        let validation = match call.name.as_str() {
            name if name.starts_with("collaboration/") => runtime.collaboration.validate_call(call),
            "workspace/read" if runtime.workspace_read.is_some() => {
                workspace_tool_arguments(call).map(|_| ())
            }
            "workspace/list" if runtime.workspace_list.is_some() => {
                workspace_tool_arguments(call).map(|_| ())
            }
            "workspace/search" if runtime.workspace_search.is_some() => {
                workspace_tool_arguments(call).map(|_| ())
            }
            "workspace/apply-patch" if runtime.workspace_patch.is_some() => {
                workspace_tool_arguments(call).map(|_| ())
            }
            "shell/exec"
                if runtime.shell_executor.is_some() && runtime.approval_requester.is_some() =>
            {
                shell_tool_arguments(call).map(|_| ())
            }
            name if name.starts_with("mcp__")
                && runtime.mcp_capability.is_enabled()
                && runtime.mcp_approval_requester.is_some()
                && runtime.mcp_executor.as_ref().is_some_and(|executor| {
                    executor
                        .definitions()
                        .iter()
                        .any(|definition| definition.name == name)
                }) =>
            {
                runtime
                    .mcp_executor
                    .as_ref()
                    .expect("validated MCP executor")
                    .prepare(&call.name, call.arguments.clone())
                    .map(|_| ())
                    .map_err(|error| match error {
                        McpToolPrepareError::ArgumentTooLarge => {
                            ModelError::new(ModelErrorKind::OutputTooLarge, false)
                        }
                        McpToolPrepareError::InvalidArguments
                        | McpToolPrepareError::ValueTooComplex
                        | McpToolPrepareError::InputSchemaMismatch => {
                            ModelError::new(ModelErrorKind::InvalidRequest, false)
                        }
                        McpToolPrepareError::Unavailable => {
                            ModelError::new(ModelErrorKind::UnsupportedOutput, false)
                        }
                    })
            }
            _ => {
                kinds.push(Some(CoreToolErrorKind::UnknownTool));
                continue;
            }
        };
        kinds.push(
            validation
                .err()
                .map(|_| CoreToolErrorKind::InvalidArguments),
        );
    }
    if kinds.iter().all(Option::is_none) {
        return Ok(());
    }
    let mut hasher = Sha256::new();
    hasher.update(b"tool-validation-v1\0");
    for (call, kind) in calls.iter().zip(&kinds) {
        hasher.update(call.name.as_bytes());
        hasher.update(b"\0");
        if let Some(kind) = kind {
            hasher.update(kind.to_string().as_bytes());
        }
        hasher.update(b"\0");
    }
    Err(ToolBatchValidationFailure::Rejected(ToolBatchRejection {
        kinds,
        fingerprint: format!("{:x}", hasher.finalize()),
    }))
}

enum ToolBatchValidationFailure {
    Fatal(ModelError),
    Rejected(ToolBatchRejection),
}

struct ToolBatchRejection {
    kinds: Vec<Option<CoreToolErrorKind>>,
    fingerprint: String,
}

async fn record_rejected_tool_batch(
    runtime: &CoreRuntime,
    prepared: &crate::PreparedTextTurn,
    messages: &mut Vec<ModelMessage>,
    calls: &[ModelToolCall],
    rejection: &ToolBatchRejection,
) -> Result<(), Terminal> {
    let is_batch = calls.len() > 1;
    if is_batch {
        messages.push(ModelMessage::ToolCallBatch(calls.to_vec()));
    }
    for (call, validation_kind) in calls.iter().zip(&rejection.kinds) {
        let kind = validation_kind.unwrap_or(CoreToolErrorKind::BatchRejected);
        let arguments = serde_json::to_vec(&call.arguments).unwrap_or_default();
        let arguments_sha256 = sha256(&arguments);
        let content = format!(
            "{} error: {}; argumentsBytes={}; argumentsSha256={arguments_sha256}",
            call.name,
            kind,
            arguments.len(),
        );
        append_completed_tool_item(
            runtime,
            prepared,
            CoreItemKind::ToolCall {
                call_id: call.id.clone(),
                name: call.name.clone(),
                path: String::new(),
                query: None,
                patch: None,
                command: None,
                arguments: None,
            },
        )
        .await?;
        append_completed_tool_item(
            runtime,
            prepared,
            CoreItemKind::ToolResult {
                call_id: call.id.clone(),
                name: call.name.clone(),
                result: CoreToolResult::Error { kind },
            },
        )
        .await?;
        if !is_batch {
            messages.push(ModelMessage::ToolCall(call.clone()));
        }
        messages.push(ModelMessage::ToolResult {
            call_id: call.id.clone(),
            content,
        });
    }
    Ok(())
}

enum CompletedRoundOutput {
    Final {
        output_index: u32,
        text: String,
    },
    ToolUse {
        commentary: Option<(u32, String)>,
        calls: Vec<ModelToolCall>,
    },
}

fn classify_model_response(
    response: ModelResponse,
    preview_text: &BTreeMap<u32, String>,
) -> Result<CompletedRoundOutput, ModelError> {
    if response
        .output
        .iter()
        .enumerate()
        .any(|(index, item)| u32::try_from(index).ok() != Some(item.output_index))
    {
        return Err(ModelError::new(ModelErrorKind::Protocol, false));
    }
    let mut output = response.output.into_iter();
    let Some(first) = output.next() else {
        return Err(ModelError::new(ModelErrorKind::Incomplete, false));
    };
    match first.kind {
        ModelOutputItemKind::AssistantText {
            phase: ModelTextPhase::Final,
            text,
        } => {
            if output.next().is_some() {
                return Err(ModelError::new(ModelErrorKind::UnsupportedOutput, false));
            }
            validate_completed_text(
                first.output_index,
                &text,
                preview_text,
                crate::thread::MAX_AGENT_MESSAGE_BYTES,
            )?;
            if !text.chars().any(|character| !character.is_whitespace()) {
                return Err(ModelError::new(ModelErrorKind::Incomplete, false));
            }
            Ok(CompletedRoundOutput::Final {
                output_index: first.output_index,
                text,
            })
        }
        ModelOutputItemKind::AssistantText {
            phase: ModelTextPhase::Commentary,
            text,
        } => {
            validate_completed_text(
                first.output_index,
                &text,
                preview_text,
                crate::thread::MAX_AGENT_COMMENTARY_BYTES,
            )?;
            if text.is_empty() {
                return Err(ModelError::new(ModelErrorKind::UnsupportedOutput, false));
            }
            let calls = output
                .map(|item| match item.kind {
                    ModelOutputItemKind::ToolCall(call) => Ok(call),
                    ModelOutputItemKind::AssistantText { .. } => {
                        Err(ModelError::new(ModelErrorKind::UnsupportedOutput, false))
                    }
                })
                .collect::<Result<Vec<_>, _>>()?;
            validate_completed_tool_calls(&calls)?;
            Ok(CompletedRoundOutput::ToolUse {
                commentary: Some((first.output_index, text)),
                calls,
            })
        }
        ModelOutputItemKind::ToolCall(call) => {
            if !preview_text.is_empty() {
                return Err(ModelError::new(ModelErrorKind::Protocol, false));
            }
            let mut calls = vec![call];
            for item in output {
                let ModelOutputItemKind::ToolCall(call) = item.kind else {
                    return Err(ModelError::new(ModelErrorKind::UnsupportedOutput, false));
                };
                calls.push(call);
            }
            validate_completed_tool_calls(&calls)?;
            Ok(CompletedRoundOutput::ToolUse {
                commentary: None,
                calls,
            })
        }
    }
}

fn validate_completed_text(
    output_index: u32,
    text: &str,
    preview_text: &BTreeMap<u32, String>,
    max_bytes: usize,
) -> Result<(), ModelError> {
    if text.len() > max_bytes {
        return Err(output_too_large_error());
    }
    if !preview_text.is_empty()
        && (preview_text.len() != 1
            || preview_text.get(&output_index).map(String::as_str) != Some(text))
    {
        return Err(ModelError::new(ModelErrorKind::Protocol, false));
    }
    Ok(())
}

fn validate_completed_tool_calls(calls: &[ModelToolCall]) -> Result<(), ModelError> {
    if calls.is_empty() {
        Err(ModelError::new(ModelErrorKind::UnsupportedOutput, false))
    } else {
        Ok(())
    }
}

async fn execute_read_only_tool_batch(
    runtime: &CoreRuntime,
    prepared: &PreparedTextTurn,
    calls: &[ModelToolCall],
    cancellation: &CancellationToken,
) -> Result<Vec<String>, Terminal> {
    let _root_workspace_permit = if runtime
        .collaboration
        .access_for_child(&prepared.thread_id)
        .is_none()
    {
        Some(
            runtime
                .collaboration
                .acquire_workspace(AgentAccess::ReadOnly)
                .await,
        )
    } else {
        None
    };
    let arguments = calls
        .iter()
        .map(workspace_tool_arguments)
        .collect::<Result<Vec<_>, _>>()
        .map_err(Terminal::Failed)?;
    for (call, arguments) in calls.iter().zip(&arguments) {
        append_completed_tool_item(
            runtime,
            prepared,
            CoreItemKind::ToolCall {
                call_id: call.id.clone(),
                name: call.name.clone(),
                path: arguments.path.clone(),
                query: arguments.query.clone(),
                patch: None,
                command: None,
                arguments: None,
            },
        )
        .await?;
    }

    let executions = calls
        .iter()
        .cloned()
        .zip(arguments)
        .map(|(call, arguments)| {
            let runtime = runtime.clone();
            let cancellation = cancellation.clone();
            async move {
                let (mut result, mut content, interrupted) = match call.name.as_str() {
                    "workspace/read" => {
                        let outcome = runtime
                            .workspace_read
                            .as_ref()
                            .expect("validated workspace/read executor")
                            .read(
                                &WorkspaceReadArguments {
                                    path: arguments.path,
                                },
                                &cancellation,
                            )
                            .await;
                        let interrupted = matches!(
                            outcome,
                            WorkspaceReadOutcome::Error {
                                kind: WorkspaceReadErrorKind::Cancelled
                            }
                        );
                        let (result, content) = map_workspace_read_outcome(outcome);
                        (result, content, interrupted)
                    }
                    "workspace/list" => {
                        let outcome = runtime
                            .workspace_list
                            .as_ref()
                            .expect("validated workspace/list executor")
                            .list(
                                &WorkspaceListArguments {
                                    path: arguments.path,
                                },
                                &cancellation,
                            )
                            .await;
                        let interrupted = matches!(
                            outcome,
                            WorkspaceListOutcome::Error {
                                kind: WorkspaceListErrorKind::Cancelled
                            }
                        );
                        let (result, content) = map_workspace_list_outcome(outcome);
                        (result, content, interrupted)
                    }
                    "workspace/search" => {
                        let outcome = runtime
                            .workspace_search
                            .as_ref()
                            .expect("validated workspace/search executor")
                            .search(
                                &WorkspaceSearchArguments {
                                    path: arguments.path,
                                    query: arguments
                                        .query
                                        .expect("validated workspace/search query"),
                                },
                                &cancellation,
                            )
                            .await;
                        let interrupted = matches!(
                            outcome,
                            WorkspaceSearchOutcome::Error {
                                kind: WorkspaceSearchErrorKind::Cancelled
                            }
                        );
                        let (result, content) = map_workspace_search_outcome(outcome);
                        (result, content, interrupted)
                    }
                    _ => unreachable!("read-only batch was validated"),
                };
                if serialized_tool_result_bytes(&result) > MAX_SERIALIZED_TOOL_RESULT_BYTES {
                    result = CoreToolResult::Error {
                        kind: CoreToolErrorKind::ResultTooLarge,
                    };
                    content = format!("{} error: resultTooLarge", call.name);
                }
                (call, result, content, interrupted)
            }
        });
    let outcomes = stream::iter(executions)
        .buffered(READ_ONLY_TOOL_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    if outcomes.iter().any(|(_, _, _, interrupted)| *interrupted) {
        return Err(Terminal::Interrupted);
    }

    let mut contents = Vec::with_capacity(outcomes.len());
    for (call, result, content, _) in outcomes {
        append_completed_tool_item(
            runtime,
            prepared,
            CoreItemKind::ToolResult {
                call_id: call.id,
                name: call.name,
                result,
            },
        )
        .await?;
        contents.push(content);
    }
    Ok(contents)
}

async fn persist_mixed_batch_calls(
    runtime: &CoreRuntime,
    prepared: &PreparedTextTurn,
    calls: &[ModelToolCall],
) -> Result<(), Terminal> {
    for call in calls {
        let item = if call.name.starts_with("collaboration/") {
            CoreItemKind::ToolCall {
                call_id: call.id.clone(),
                name: call.name.clone(),
                path: String::new(),
                query: None,
                patch: None,
                command: None,
                arguments: None,
            }
        } else if call.name.starts_with("mcp__") {
            let prepared_call = runtime
                .mcp_executor
                .as_ref()
                .expect("validated MCP executor")
                .prepare(&call.name, call.arguments.clone())
                .map_err(|error| {
                    Terminal::Failed(match error {
                        McpToolPrepareError::ArgumentTooLarge => {
                            ModelError::new(ModelErrorKind::OutputTooLarge, false)
                        }
                        McpToolPrepareError::InvalidArguments
                        | McpToolPrepareError::ValueTooComplex
                        | McpToolPrepareError::InputSchemaMismatch => {
                            ModelError::new(ModelErrorKind::InvalidRequest, false)
                        }
                        McpToolPrepareError::Unavailable => {
                            ModelError::new(ModelErrorKind::UnsupportedOutput, false)
                        }
                    })
                })?;
            CoreItemKind::McpToolCall {
                call_id: call.id.clone(),
                name: call.name.clone(),
                arguments: prepared_call.arguments,
                arguments_bytes: prepared_call.arguments_bytes,
                arguments_sha256: prepared_call.arguments_sha256,
                inventory_sha256: prepared_call.inventory_sha256,
            }
        } else if call.name == "shell/exec" {
            let arguments = shell_tool_arguments(call).map_err(Terminal::Failed)?;
            CoreItemKind::ToolCall {
                call_id: call.id.clone(),
                name: call.name.clone(),
                path: arguments.cwd,
                query: None,
                patch: None,
                command: Some(arguments.command),
                arguments: Some(arguments.arguments),
            }
        } else {
            let arguments = workspace_tool_arguments(call).map_err(Terminal::Failed)?;
            CoreItemKind::ToolCall {
                call_id: call.id.clone(),
                name: call.name.clone(),
                path: arguments.path,
                query: arguments.query,
                patch: arguments.patch,
                command: None,
                arguments: None,
            }
        };
        append_completed_tool_item(runtime, prepared, item).await?;
    }
    Ok(())
}

fn record_executed_tool_call(
    messages: &mut Vec<ModelMessage>,
    batch_results: &mut Vec<(ModelToolCall, String)>,
    is_batch: bool,
    call: ModelToolCall,
    content: String,
    is_last: bool,
) -> bool {
    if !is_batch {
        messages.push(ModelMessage::ToolCall(call.clone()));
        messages.push(ModelMessage::ToolResult {
            call_id: call.id,
            content,
        });
        return is_last;
    }
    batch_results.push((call, content));
    if !is_last {
        return false;
    }
    messages.push(ModelMessage::ToolCallBatch(
        batch_results.iter().map(|(call, _)| call.clone()).collect(),
    ));
    messages.extend(
        batch_results
            .drain(..)
            .map(|(call, content)| ModelMessage::ToolResult {
                call_id: call.id,
                content,
            }),
    );
    true
}

#[allow(clippy::too_many_arguments)]
async fn compact_active_turn(
    runtime: &CoreRuntime,
    prepared: &crate::PreparedTextTurn,
    model_gateway: &ModelGateway,
    messages: &[ModelMessage],
    tools: &[ModelToolDefinition],
    ordinal: u64,
    cancellation: &CancellationToken,
    usage: &mut Option<ModelUsage>,
) -> Result<Vec<ModelMessage>, Terminal> {
    let instruction_bytes = prepared
        .instructions
        .iter()
        .map(ModelInstruction::context_bytes)
        .try_fold(0usize, usize::checked_add)
        .ok_or_else(output_too_large)?;
    let tool_bytes = tools
        .iter()
        .map(ModelToolDefinition::context_bytes)
        .try_fold(0usize, usize::checked_add)
        .ok_or_else(output_too_large)?;
    let fixed_post_bytes = instruction_bytes
        .checked_add(tool_bytes)
        .and_then(|bytes| bytes.checked_add(MAX_ACTIVE_TURN_COMPACTION_BYTES))
        .ok_or_else(output_too_large)?;
    if fixed_post_bytes > model_gateway.capabilities.input_compaction_target_bytes() {
        return Err(output_too_large());
    }

    let mut tail_start = recent_complete_tool_pair_start(messages, 2);
    while tail_start < messages.len() {
        let tail_bytes = messages[tail_start..]
            .iter()
            .map(ModelMessage::context_bytes)
            .try_fold(0usize, usize::checked_add)
            .ok_or_else(output_too_large)?;
        if fixed_post_bytes
            .checked_add(tail_bytes)
            .is_some_and(|bytes| {
                bytes <= model_gateway.capabilities.input_compaction_target_bytes()
            })
        {
            break;
        }
        tail_start = drop_oldest_complete_tool_pair(messages, tail_start);
    }
    if tail_start == 0 {
        return Err(output_too_large());
    }

    let source = &messages[..tail_start];
    let source_bytes = source
        .iter()
        .map(ModelMessage::context_bytes)
        .try_fold(0usize, usize::checked_add)
        .ok_or_else(output_too_large)?;
    let source_sha256 = model_messages_sha256(source);
    let pre_context_bytes = ModelRequest {
        model: model_gateway.model.to_string(),
        instructions: prepared.instructions.clone(),
        messages: messages.to_vec(),
        tools: tools.to_vec(),
    }
    .context_bytes();
    let started = runtime
        .lock_core()
        .and_then(|mut core| {
            core.append_completed_item(
                &prepared.thread_id,
                &prepared.turn_id,
                CoreItemKind::ContextCompaction {
                    strategy: CoreContextCompactionStrategy::ModelGeneratedActiveTurnV1,
                    ordinal,
                    pre_context_bytes: pre_context_bytes as u64,
                    source_messages: source.len() as u64,
                    source_bytes: source_bytes as u64,
                    source_sha256: source_sha256.clone(),
                    outcome: None,
                },
            )
        })
        .map_err(|_| Terminal::StateUnavailable)?;
    if !send_event(
        runtime,
        &CancellationToken::new(),
        prepared.request_id,
        CoreEventKind::ItemStarted {
            thread_id: prepared.thread_id.clone(),
            turn_id: prepared.turn_id.clone(),
            item: started.clone(),
        },
    )
    .await
    {
        return Err(Terminal::StateUnavailable);
    }

    let mut compaction_instructions = prepared.instructions.clone();
    compaction_instructions.push(sugarcode_active_turn_compaction_instruction_v1());
    let compaction_request = ModelRequest {
        model: model_gateway.model.to_string(),
        instructions: compaction_instructions,
        messages: source.to_vec(),
        tools: Vec::new(),
    };
    if compaction_request.context_bytes() > crate::context::MAX_PROVIDER_CONTEXT_BYTES {
        complete_compaction_item(
            runtime,
            prepared,
            &started,
            CoreContextCompactionOutcome::Failed {
                kind: "outputTooLarge".to_string(),
            },
            None,
        )
        .await?;
        return Err(output_too_large());
    }

    let stream = tokio::select! {
        biased;
        _ = cancellation.cancelled() => {
            complete_compaction_item(
                runtime,
                prepared,
                &started,
                CoreContextCompactionOutcome::Interrupted,
                None,
            ).await?;
            return Err(Terminal::Interrupted);
        }
        result = model_gateway.provider.stream(compaction_request) => result,
    };
    let mut stream = match stream {
        Ok(stream) => stream,
        Err(error) => {
            complete_compaction_item(
                runtime,
                prepared,
                &started,
                CoreContextCompactionOutcome::Failed {
                    kind: model_error_kind_name(error.kind()).to_string(),
                },
                None,
            )
            .await?;
            return Err(Terminal::Failed(error));
        }
    };
    let mut preview_text = BTreeMap::<u32, String>::new();
    let summary = loop {
        let event = tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                complete_compaction_item(
                    runtime,
                    prepared,
                    &started,
                    CoreContextCompactionOutcome::Interrupted,
                    None,
                ).await?;
                return Err(Terminal::Interrupted);
            }
            event = stream.next() => event,
        };
        match event {
            Some(Ok(ModelEvent::OutputTextDelta {
                output_index,
                delta,
            })) => {
                let preview = preview_text.entry(output_index).or_default();
                if preview
                    .len()
                    .checked_add(delta.len())
                    .is_none_or(|bytes| bytes > MAX_ACTIVE_TURN_COMPACTION_BYTES)
                {
                    complete_compaction_item(
                        runtime,
                        prepared,
                        &started,
                        CoreContextCompactionOutcome::Failed {
                            kind: "outputTooLarge".to_string(),
                        },
                        None,
                    )
                    .await?;
                    return Err(output_too_large());
                }
                preview.push_str(&delta);
            }
            Some(Ok(ModelEvent::ResponseCompleted(response))) => {
                let trailing = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => {
                        complete_compaction_item(
                            runtime,
                            prepared,
                            &started,
                            CoreContextCompactionOutcome::Interrupted,
                            None,
                        ).await?;
                        return Err(Terminal::Interrupted);
                    }
                    trailing = stream.next() => trailing,
                };
                if trailing.is_some() {
                    let error = ModelError::new(ModelErrorKind::Protocol, false);
                    complete_compaction_item(
                        runtime,
                        prepared,
                        &started,
                        CoreContextCompactionOutcome::Failed {
                            kind: "protocol".to_string(),
                        },
                        None,
                    )
                    .await?;
                    return Err(Terminal::Failed(error));
                }
                if let Some(value) = response.usage
                    && !accumulate_usage(usage, value)
                {
                    complete_compaction_item(
                        runtime,
                        prepared,
                        &started,
                        CoreContextCompactionOutcome::Failed {
                            kind: "outputTooLarge".to_string(),
                        },
                        None,
                    )
                    .await?;
                    return Err(output_too_large());
                }
                match classify_model_response(response, &preview_text) {
                    Ok(CompletedRoundOutput::Final { text, .. })
                        if text.len() <= MAX_ACTIVE_TURN_COMPACTION_BYTES =>
                    {
                        break text;
                    }
                    Ok(CompletedRoundOutput::Final { .. }) => {
                        complete_compaction_item(
                            runtime,
                            prepared,
                            &started,
                            CoreContextCompactionOutcome::Failed {
                                kind: "outputTooLarge".to_string(),
                            },
                            None,
                        )
                        .await?;
                        return Err(output_too_large());
                    }
                    Ok(CompletedRoundOutput::ToolUse { .. }) => {
                        let error = ModelError::new(ModelErrorKind::UnsupportedOutput, false);
                        complete_compaction_item(
                            runtime,
                            prepared,
                            &started,
                            CoreContextCompactionOutcome::Failed {
                                kind: "unsupportedOutput".to_string(),
                            },
                            None,
                        )
                        .await?;
                        return Err(Terminal::Failed(error));
                    }
                    Err(error) => {
                        complete_compaction_item(
                            runtime,
                            prepared,
                            &started,
                            CoreContextCompactionOutcome::Failed {
                                kind: model_error_kind_name(error.kind()).to_string(),
                            },
                            None,
                        )
                        .await?;
                        return Err(Terminal::Failed(error));
                    }
                }
            }
            Some(Err(error)) => {
                complete_compaction_item(
                    runtime,
                    prepared,
                    &started,
                    CoreContextCompactionOutcome::Failed {
                        kind: model_error_kind_name(error.kind()).to_string(),
                    },
                    None,
                )
                .await?;
                return Err(Terminal::Failed(error));
            }
            None => {
                complete_compaction_item(
                    runtime,
                    prepared,
                    &started,
                    CoreContextCompactionOutcome::Failed {
                        kind: "disconnected".to_string(),
                    },
                    None,
                )
                .await?;
                return Err(Terminal::Failed(ModelError::new(
                    ModelErrorKind::Disconnected,
                    true,
                )));
            }
        }
    };

    let summary_sha256 = sha256(summary.as_bytes());
    let mut compacted = Vec::with_capacity(1 + messages.len() - tail_start);
    compacted.push(ModelMessage::ContextCompaction {
        content: summary.clone(),
    });
    compacted.extend_from_slice(&messages[tail_start..]);
    let post_context_bytes = ModelRequest {
        model: model_gateway.model.to_string(),
        instructions: prepared.instructions.clone(),
        messages: compacted.clone(),
        tools: tools.to_vec(),
    }
    .context_bytes();
    if post_context_bytes > model_gateway.capabilities.input_compaction_target_bytes() {
        complete_compaction_item(
            runtime,
            prepared,
            &started,
            CoreContextCompactionOutcome::Failed {
                kind: "outputTooLarge".to_string(),
            },
            None,
        )
        .await?;
        return Err(output_too_large());
    }
    complete_compaction_item(
        runtime,
        prepared,
        &started,
        CoreContextCompactionOutcome::Completed {
            post_context_bytes: post_context_bytes as u64,
            summary_bytes: summary.len() as u64,
            summary_sha256,
        },
        Some(summary),
    )
    .await?;
    Ok(compacted)
}

async fn complete_compaction_item(
    runtime: &CoreRuntime,
    prepared: &crate::PreparedTextTurn,
    started: &CoreItemSnapshot,
    outcome: CoreContextCompactionOutcome,
    summary: Option<String>,
) -> Result<(), Terminal> {
    let completed = runtime
        .lock_core()
        .and_then(|mut core| {
            core.complete_context_compaction_item(
                &prepared.thread_id,
                &prepared.turn_id,
                &started.id,
                outcome,
                summary,
            )
        })
        .map_err(|_| Terminal::StateUnavailable)?;
    if !send_event(
        runtime,
        &CancellationToken::new(),
        prepared.request_id,
        CoreEventKind::ItemCompleted {
            thread_id: prepared.thread_id.clone(),
            turn_id: prepared.turn_id.clone(),
            item: completed,
        },
    )
    .await
    {
        return Err(Terminal::StateUnavailable);
    }
    Ok(())
}

fn recent_complete_tool_pair_start(messages: &[ModelMessage], maximum_pairs: usize) -> usize {
    let mut index = messages.len();
    let mut pairs = 0usize;
    while pairs < maximum_pairs && index >= 2 {
        let (ModelMessage::ToolCall(call), ModelMessage::ToolResult { call_id, .. }) =
            (&messages[index - 2], &messages[index - 1])
        else {
            break;
        };
        if &call.id != call_id {
            break;
        }
        index -= 2;
        pairs += 1;
    }
    index
}

fn drop_oldest_complete_tool_pair(messages: &[ModelMessage], tail_start: usize) -> usize {
    if tail_start + 1 < messages.len()
        && matches!(messages[tail_start], ModelMessage::ToolCall(_))
        && matches!(messages[tail_start + 1], ModelMessage::ToolResult { .. })
    {
        tail_start + 2
    } else {
        messages.len()
    }
}

fn model_messages_sha256(messages: &[ModelMessage]) -> String {
    let mut hasher = Sha256::new();
    for message in messages {
        match message {
            ModelMessage::Text { role, text } => {
                hasher.update(match role {
                    ModelRole::User => b"user".as_slice(),
                    ModelRole::Assistant => b"assistant".as_slice(),
                });
                hasher.update(text.as_bytes());
            }
            ModelMessage::Commentary { text } => {
                hasher.update(b"commentary");
                hasher.update(text.as_bytes());
            }
            ModelMessage::ContextCompaction { content } => {
                hasher.update(b"contextCompaction");
                hasher.update(content.as_bytes());
            }
            ModelMessage::ToolCall(call) => {
                hasher.update(b"toolCall");
                hasher.update(call.id.as_bytes());
                hasher.update(call.name.as_bytes());
                if let Ok(arguments) = serde_json::to_vec(&call.arguments) {
                    hasher.update(arguments);
                }
            }
            ModelMessage::ToolCallBatch(calls) => {
                hasher.update(b"toolCallBatch");
                for call in calls {
                    hasher.update(call.id.as_bytes());
                    hasher.update(call.name.as_bytes());
                    if let Ok(arguments) = serde_json::to_vec(&call.arguments) {
                        hasher.update(arguments);
                    }
                    hasher.update(b"\0");
                }
            }
            ModelMessage::ToolResult { call_id, content } => {
                hasher.update(b"toolResult");
                hasher.update(call_id.as_bytes());
                hasher.update(content.as_bytes());
            }
        }
        hasher.update(b"\n");
    }
    format!("{:x}", hasher.finalize())
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn output_too_large() -> Terminal {
    Terminal::Failed(output_too_large_error())
}

fn output_too_large_error() -> ModelError {
    ModelError::new(ModelErrorKind::OutputTooLarge, false)
}

fn model_error_kind_name(kind: ModelErrorKind) -> &'static str {
    match kind {
        ModelErrorKind::Authentication => "authentication",
        ModelErrorKind::ContextLengthExceeded => "contextLengthExceeded",
        ModelErrorKind::InvalidRequest => "invalidRequest",
        ModelErrorKind::RateLimited => "rateLimited",
        ModelErrorKind::Timeout => "timeout",
        ModelErrorKind::Transport => "transport",
        ModelErrorKind::Disconnected => "disconnected",
        ModelErrorKind::Server => "server",
        ModelErrorKind::Protocol => "protocol",
        ModelErrorKind::Incomplete => "incomplete",
        ModelErrorKind::Filtered => "filtered",
        ModelErrorKind::UnsupportedOutput => "unsupportedOutput",
        ModelErrorKind::UnsupportedToolArguments => "unsupportedToolArguments",
        ModelErrorKind::OutputTooLarge => "outputTooLarge",
    }
}

fn workspace_instructions_audit(
    snapshot: &WorkspaceInstructionsSnapshot,
) -> DurableWorkspaceInstructionsAudit {
    match snapshot {
        WorkspaceInstructionsSnapshot::Absent => DurableWorkspaceInstructionsAudit {
            source: DurableWorkspaceInstructionsSource::RootAgentsMdV1,
            status: DurableWorkspaceInstructionsStatus::Absent,
            bytes: None,
            sha256: None,
        },
        WorkspaceInstructionsSnapshot::Present { bytes, sha256, .. } => {
            DurableWorkspaceInstructionsAudit {
                source: DurableWorkspaceInstructionsSource::RootAgentsMdV1,
                status: DurableWorkspaceInstructionsStatus::Present,
                bytes: Some(*bytes as u64),
                sha256: Some(sha256.clone()),
            }
        }
        WorkspaceInstructionsSnapshot::Hierarchy {
            present,
            bytes,
            sha256,
            ..
        } => DurableWorkspaceInstructionsAudit {
            source: DurableWorkspaceInstructionsSource::RootToActiveScopeAgentsMdV1,
            status: if *present {
                DurableWorkspaceInstructionsStatus::Present
            } else {
                DurableWorkspaceInstructionsStatus::Absent
            },
            bytes: present.then_some(*bytes as u64),
            sha256: Some(sha256.clone()),
        },
    }
}

fn workspace_skills_audit(
    snapshot: &WorkspaceSkillsSnapshot,
    selection: Option<&sugarcode_tools::WorkspaceSkillSelection>,
) -> DurableWorkspaceSkillsAudit {
    let selection = selection
        .cloned()
        .unwrap_or(sugarcode_tools::WorkspaceSkillSelection {
            content: None,
            selected_count: 0,
            selected_bytes: 0,
            sha256: None,
        });
    DurableWorkspaceSkillsAudit {
        source: DurableWorkspaceSkillsSource::RootToActiveScopeAgentsSkillsV1,
        status: if snapshot.effective_count() == 0 {
            DurableWorkspaceSkillsStatus::Absent
        } else {
            DurableWorkspaceSkillsStatus::Present
        },
        discovered_count: snapshot.discovered_count() as u64,
        effective_count: snapshot.effective_count() as u64,
        selected_count: selection.selected_count as u64,
        source_bytes: snapshot.source_bytes() as u64,
        inventory_bytes: snapshot.inventory().len() as u64,
        selected_bytes: selection.selected_bytes as u64,
        manifest_sha256: snapshot.manifest_sha256().to_string(),
        selection_sha256: selection.sha256,
    }
}

fn workspace_model_instructions(runtime: &CoreRuntime) -> Vec<ModelInstruction> {
    runtime
        .workspace_instructions
        .as_deref()
        .map_or_else(Vec::new, model_instructions_for_snapshot)
}

fn model_instructions_for_snapshot(
    snapshot: &WorkspaceInstructionsSnapshot,
) -> Vec<ModelInstruction> {
    match snapshot {
        WorkspaceInstructionsSnapshot::Present { content, .. } if !content.is_empty() => {
            vec![ModelInstruction {
                source: ModelInstructionSource::WorkspaceRootAgentsV1,
                content: content.clone(),
            }]
        }
        WorkspaceInstructionsSnapshot::Hierarchy { entries, .. } => {
            let mut content = String::new();
            for entry in entries.iter().filter(|entry| !entry.content.is_empty()) {
                if !content.is_empty() {
                    content.push_str("\n\n");
                }
                content.push_str("--- AGENTS.md: ");
                content.push_str(&entry.path);
                content.push_str(" ---\n");
                content.push_str(&entry.content);
            }
            if content.is_empty() {
                Vec::new()
            } else {
                vec![ModelInstruction {
                    source: ModelInstructionSource::WorkspaceAgentsHierarchyV1,
                    content,
                }]
            }
        }
        WorkspaceInstructionsSnapshot::Absent | WorkspaceInstructionsSnapshot::Present { .. } => {
            Vec::new()
        }
    }
}

fn shell_execution_result(execution: ShellCommandExecution) -> Option<(CoreToolResult, String)> {
    let result = match execution {
        ShellCommandExecution::Cancelled => return None,
        ShellCommandExecution::Error(kind) => CoreToolResult::Error {
            kind: match kind {
                ShellCommandErrorKind::InvalidArguments => CoreToolErrorKind::Unavailable,
                ShellCommandErrorKind::CommandNotFound => CoreToolErrorKind::CommandNotFound,
                ShellCommandErrorKind::AccessDenied => CoreToolErrorKind::AccessDenied,
                ShellCommandErrorKind::SpawnFailed => CoreToolErrorKind::SpawnFailed,
                ShellCommandErrorKind::ProcessControlUnavailable => {
                    CoreToolErrorKind::ProcessControlUnavailable
                }
                ShellCommandErrorKind::SandboxUnavailable => CoreToolErrorKind::SandboxUnavailable,
                ShellCommandErrorKind::Unavailable => CoreToolErrorKind::Unavailable,
            },
        },
        ShellCommandExecution::Completed(output) => {
            CoreToolResult::Process(sugarcode_protocol::CoreProcessResult {
                stdout: output.stdout,
                stderr: output.stderr,
                stdout_bytes: output.stdout_bytes,
                stderr_bytes: output.stderr_bytes,
                stdout_truncated: output.stdout_truncated,
                stderr_truncated: output.stderr_truncated,
                encoding: "utf8Lossy".to_string(),
                duration_ms: output.duration_ms,
                outcome: match output.outcome {
                    ShellCommandOutcome::ExitCode { code } => {
                        sugarcode_protocol::CoreProcessOutcome::ExitCode { code }
                    }
                    ShellCommandOutcome::Signal { signal } => {
                        sugarcode_protocol::CoreProcessOutcome::Signal { signal }
                    }
                    ShellCommandOutcome::TimedOut => {
                        sugarcode_protocol::CoreProcessOutcome::TimedOut
                    }
                },
                sandbox_policy: Some(core_filesystem_policy(output.sandbox_policy.filesystem)),
                workspace_write_policy: output
                    .sandbox_policy
                    .workspace_write
                    .map(core_workspace_write_policy),
                network_policy: Some(core_network_policy(output.sandbox_policy.network)),
            })
        }
    };
    let content = match &result {
        CoreToolResult::Error { kind } => format!("shell/exec error: {kind}"),
        CoreToolResult::Process(process) => serde_json::to_string(&serde_json::json!({
            "stdout": process.stdout,
            "stderr": process.stderr,
            "stdoutBytes": process.stdout_bytes,
            "stderrBytes": process.stderr_bytes,
            "stdoutTruncated": process.stdout_truncated,
            "stderrTruncated": process.stderr_truncated,
            "encoding": process.encoding,
            "durationMs": process.duration_ms,
            "outcome": match process.outcome {
                sugarcode_protocol::CoreProcessOutcome::ExitCode { code } =>
                    serde_json::json!({"type": "exitCode", "code": code}),
                sugarcode_protocol::CoreProcessOutcome::Signal { signal } =>
                    serde_json::json!({"type": "signal", "signal": signal}),
                sugarcode_protocol::CoreProcessOutcome::TimedOut =>
                    serde_json::json!({"type": "timedOut"}),
            },
        }))
        .expect("shell result must serialize"),
        CoreToolResult::Success { .. } => unreachable!("shell execution is process or error"),
    };
    Some((result, content))
}

fn mcp_execution_result(outcome: McpToolExecutionOutcome) -> (CoreMcpToolResult, String, bool) {
    match outcome {
        McpToolExecutionOutcome::Completed(result) => {
            let (content, truncated) =
                if result.content.len() > MAX_SERIALIZED_TOOL_RESULT_BYTES.saturating_sub(1024) {
                    (
                        serde_json::to_string(&serde_json::json!({
                            "isError": result.is_error,
                            "truncated": true,
                            "canonicalBytes": result.canonical_bytes,
                            "sha256": result.sha256,
                            "contentBlocks": result.content_blocks,
                            "structuredContent": result.structured_content,
                        }))
                        .expect("MCP truncation receipt serializes"),
                        true,
                    )
                } else {
                    (result.content, false)
                };
            let retained_bytes = u64::try_from(content.len()).unwrap_or(u64::MAX);
            (
                CoreMcpToolResult::Completed {
                    content: content.clone(),
                    is_error: result.is_error,
                    observed_bytes: result.observed_bytes,
                    canonical_bytes: result.canonical_bytes,
                    retained_bytes,
                    truncated,
                    sha256: result.sha256,
                    content_blocks: result.content_blocks,
                    structured_content: result.structured_content,
                },
                content,
                false,
            )
        }
        McpToolExecutionOutcome::Error {
            kind,
            request_state,
        } => {
            let interrupted = matches!(kind, crate::McpToolExecutionError::Cancelled);
            mcp_error_result(&kind.to_string(), &request_state.to_string(), interrupted)
        }
    }
}

fn mcp_error_result(
    kind: &str,
    request_state: &str,
    interrupted: bool,
) -> (CoreMcpToolResult, String, bool) {
    (
        CoreMcpToolResult::Error {
            kind: kind.to_owned(),
            request_state: request_state.to_owned(),
        },
        format!("MCP tool error: {kind}"),
        interrupted,
    )
}

fn fit_mcp_result_to_budget(
    result: &mut CoreMcpToolResult,
    provider_content: &mut String,
    available_bytes: usize,
) {
    if serialized_mcp_result_bytes(result) <= available_bytes {
        return;
    }
    let CoreMcpToolResult::Completed {
        content,
        is_error,
        canonical_bytes,
        retained_bytes,
        truncated,
        sha256,
        content_blocks,
        structured_content,
        ..
    } = result
    else {
        return;
    };
    let receipt = serde_json::to_string(&serde_json::json!({
        "isError": *is_error,
        "truncated": true,
        "canonicalBytes": *canonical_bytes,
        "sha256": sha256,
        "contentBlocks": *content_blocks,
        "structuredContent": *structured_content,
    }))
    .expect("MCP aggregate-budget receipt serializes");
    *retained_bytes = u64::try_from(receipt.len()).unwrap_or(u64::MAX);
    *truncated = true;
    *content = receipt.clone();
    *provider_content = receipt;
}

fn serialized_mcp_result_bytes(result: &CoreMcpToolResult) -> usize {
    match result {
        CoreMcpToolResult::Completed {
            content, sha256, ..
        } => content
            .len()
            .checked_add(sha256.len())
            .and_then(|bytes| bytes.checked_add(256))
            .unwrap_or(usize::MAX),
        CoreMcpToolResult::Error {
            kind,
            request_state,
        } => kind
            .len()
            .checked_add(request_state.len())
            .and_then(|bytes| bytes.checked_add(64))
            .unwrap_or(usize::MAX),
    }
}

fn core_filesystem_policy(
    policy: sugarcode_tools::SandboxPolicy,
) -> sugarcode_protocol::CoreCommandSandboxPolicy {
    match policy {
        sugarcode_tools::SandboxPolicy::FilesystemReadOnlyV1 => {
            sugarcode_protocol::CoreCommandSandboxPolicy::FilesystemReadOnlyV1
        }
    }
}

fn core_workspace_write_policy(
    policy: sugarcode_tools::WorkspaceWritePolicy,
) -> sugarcode_protocol::CoreCommandWorkspaceWritePolicy {
    match policy {
        sugarcode_tools::WorkspaceWritePolicy::CommandWorkspaceWriteV1 => {
            sugarcode_protocol::CoreCommandWorkspaceWritePolicy::CommandWorkspaceWriteV1
        }
    }
}

fn core_network_policy(
    policy: sugarcode_tools::NetworkPolicy,
) -> sugarcode_protocol::CoreCommandNetworkPolicy {
    match policy {
        sugarcode_tools::NetworkPolicy::NetworkDeniedV1 => {
            sugarcode_protocol::CoreCommandNetworkPolicy::NetworkDeniedV1
        }
    }
}

fn prepared_model_message(message: &PreparedMessage) -> ModelMessage {
    match message {
        PreparedMessage::Text { role, text } => ModelMessage::Text {
            role: match role {
                PreparedMessageRole::User => ModelRole::User,
                PreparedMessageRole::Assistant => ModelRole::Assistant,
            },
            text: text.clone(),
        },
        PreparedMessage::Commentary { text } => ModelMessage::Commentary { text: text.clone() },
        PreparedMessage::ContextCompaction { content } => ModelMessage::ContextCompaction {
            content: content.clone(),
        },
        PreparedMessage::ToolCall {
            call_id,
            name,
            path,
            query,
            patch,
            command,
            arguments,
        } => ModelMessage::ToolCall(ModelToolCall {
            id: call_id.clone(),
            name: name.clone(),
            arguments: crate::context::prepared_tool_arguments(
                path, query, patch, command, arguments,
            ),
        }),
        PreparedMessage::ToolResult { call_id, content } => ModelMessage::ToolResult {
            call_id: call_id.clone(),
            content: content.clone(),
        },
        PreparedMessage::McpToolCall {
            call_id,
            name,
            arguments,
        } => ModelMessage::ToolCall(ModelToolCall {
            id: call_id.clone(),
            name: name.clone(),
            arguments: arguments.clone(),
        }),
        PreparedMessage::McpToolResult { call_id, content } => ModelMessage::ToolResult {
            call_id: call_id.clone(),
            content: content.clone(),
        },
    }
}

fn accumulate_usage(total: &mut Option<ModelUsage>, next: ModelUsage) -> bool {
    let Some(current) = total.as_mut() else {
        *total = Some(next);
        return true;
    };

    let Some(input_tokens) = add_optional_usage(current.input_tokens, next.input_tokens) else {
        return false;
    };
    let Some(cached_input_tokens) =
        add_optional_usage(current.cached_input_tokens, next.cached_input_tokens)
    else {
        return false;
    };
    let Some(output_tokens) = add_optional_usage(current.output_tokens, next.output_tokens) else {
        return false;
    };
    let Some(reasoning_output_tokens) = add_optional_usage(
        current.reasoning_output_tokens,
        next.reasoning_output_tokens,
    ) else {
        return false;
    };
    let Some(total_tokens) = add_optional_usage(current.total_tokens, next.total_tokens) else {
        return false;
    };
    *current = ModelUsage {
        input_tokens,
        cached_input_tokens,
        output_tokens,
        reasoning_output_tokens,
        total_tokens,
    };
    true
}

fn add_optional_usage(left: Option<u64>, right: Option<u64>) -> Option<Option<u64>> {
    match (left, right) {
        (Some(left), Some(right)) => left.checked_add(right).map(Some),
        (Some(value), None) | (None, Some(value)) => Some(Some(value)),
        (None, None) => Some(None),
    }
}

#[cfg(test)]
#[path = "runtime/tests/mod.rs"]
mod tests;
