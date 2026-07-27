use crate::CommandApprovalOutcome;
use crate::CommandApprovalRequest;
use crate::CommandApprovalRequester;
use crate::Core;
use crate::CoreApi;
use crate::CoreError;
use crate::PreparedMessage;
use crate::PreparedMessageRole;
use crate::TurnInterruptOutcome;
use crate::TurnStartOutcome;
use futures_util::FutureExt;
use futures_util::StreamExt;
use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU8;
use std::sync::atomic::Ordering;
use sugarcode_model_provider::ModelError;
use sugarcode_model_provider::ModelErrorKind;
use sugarcode_model_provider::ModelEvent;
use sugarcode_model_provider::ModelMessage;
use sugarcode_model_provider::ModelProvider;
use sugarcode_model_provider::ModelRequest;
use sugarcode_model_provider::ModelRole;
use sugarcode_model_provider::ModelToolCall;
use sugarcode_model_provider::ModelToolDefinition;
use sugarcode_model_provider::ModelUsage;
use sugarcode_protocol::CoreEvent;
use sugarcode_protocol::CoreEventKind;
use sugarcode_protocol::CoreFileChangeKind;
use sugarcode_protocol::CoreFileChangeNewlineStyle;
use sugarcode_protocol::CoreItemKind;
use sugarcode_protocol::CoreItemSnapshot;
use sugarcode_protocol::CoreRequestId;
use sugarcode_protocol::CoreToolErrorKind;
use sugarcode_protocol::CoreToolResult;
use sugarcode_protocol::CoreTurnError;
use sugarcode_protocol::CoreTurnErrorKind;
use sugarcode_protocol::ThreadId;
use sugarcode_protocol::TurnId;
use sugarcode_state::DurableThreadPage;
use sugarcode_state::DurableThreadSnapshot;
use sugarcode_state::DurableTurnError;
use sugarcode_state::DurableTurnErrorKind;
use sugarcode_state::DurableTurnStatus;
use sugarcode_state::DurableUsage;
use sugarcode_tools::ShellCommandArguments;
use sugarcode_tools::ShellCommandErrorKind;
use sugarcode_tools::ShellCommandExecution;
use sugarcode_tools::ShellCommandExecutor;
use sugarcode_tools::ShellCommandOutcome;
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
use tokio::sync::Notify;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

mod terminal;
mod tool_dispatch;

use terminal::Terminal;
use terminal::claim_terminal;
use terminal::clear_active;
use terminal::finish_completed_and_emit;
use terminal::finish_failed_and_emit;
use terminal::finish_interrupted;
use terminal::finish_interrupted_and_emit;
use terminal::finish_state_unavailable_and_emit;
use terminal::send_event;
use tool_dispatch::append_completed_tool_item;
use tool_dispatch::map_workspace_list_outcome;
use tool_dispatch::map_workspace_patch_error;
use tool_dispatch::map_workspace_read_outcome;
use tool_dispatch::map_workspace_search_outcome;
use tool_dispatch::serialized_file_change_bytes;
use tool_dispatch::serialized_shell_tool_call_bytes;
use tool_dispatch::serialized_tool_call_bytes;
use tool_dispatch::serialized_tool_result_bytes;
use tool_dispatch::shell_tool_arguments;
use tool_dispatch::workspace_tool_arguments;
use tool_dispatch::workspace_tool_definitions;

const MAX_PROVIDER_ROUNDS: u8 = 2;
const MAX_TOOL_CALLS_PER_TURN: usize = 1;
const TURN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
pub const MAX_SERIALIZED_TOOL_RESULT_BYTES: usize = 384 * 1024;
pub const MAX_TURN_TOOL_BYTES: usize = 400 * 1024;

const CORE_EVENT_CAPACITY: usize = 64;

#[derive(Clone)]
pub struct CoreRuntime {
    core: Arc<Mutex<Core>>,
    model_gateway: Option<ModelGateway>,
    workspace_read: Option<Arc<dyn WorkspaceReadExecutor>>,
    workspace_list: Option<Arc<dyn WorkspaceListExecutor>>,
    workspace_search: Option<Arc<dyn WorkspaceSearchExecutor>>,
    workspace_patch: Option<Arc<dyn WorkspacePatchExecutor>>,
    shell_executor: Option<Arc<dyn ShellCommandExecutor>>,
    approval_requester: Option<Arc<dyn CommandApprovalRequester>>,
    event_tx: mpsc::Sender<CoreEvent>,
    active: Arc<Mutex<BTreeMap<ThreadId, ActiveTurn>>>,
}

#[derive(Clone)]
struct ModelGateway {
    provider: Arc<dyn ModelProvider>,
    model: Arc<str>,
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
                model_gateway: Some(ModelGateway {
                    provider,
                    model: Arc::from(model),
                }),
                workspace_read,
                workspace_list,
                workspace_search,
                workspace_patch: None,
                shell_executor: None,
                approval_requester: None,
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
                shell_executor: None,
                approval_requester: None,
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
        if self.model_gateway.is_none() {
            return Err(CoreError::ModelUnavailable);
        }
        let prepared = self
            .lock_core()?
            .prepare_text_turn(request_id, thread_id.clone(), input)?;
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
                run_turn(runtime, prepared, cancellation, terminal_state),
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
    cancellation: CancellationToken,
    terminal_state: Arc<Mutex<TurnPhase>>,
) {
    let request_id = prepared.request_id;
    let thread_id = prepared.thread_id.clone();
    let turn_id = prepared.turn_id.clone();
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

    let Some(model_gateway) = runtime.model_gateway.as_ref() else {
        finish_failed_and_emit(
            &runtime,
            &prepared,
            ModelError::new(ModelErrorKind::InvalidRequest, false),
            None,
        )
        .await;
        clear_active(&runtime, &thread_id, &turn_id);
        return;
    };
    let mut messages = prepared
        .history
        .iter()
        .map(prepared_model_message)
        .collect::<Vec<_>>();
    let mut usage = None;
    let mut round = 0u8;
    let mut agent_item: Option<CoreItemSnapshot> = None;
    let mut pending_tool_call = false;
    let mut patch_commit_interrupted = false;
    let mut non_whitespace_text_seen = false;
    let mut tool_call_count = 0usize;
    let mut turn_tool_bytes = 0usize;
    let mut terminal = 'rounds: loop {
        if round >= MAX_PROVIDER_ROUNDS {
            break Terminal::Failed(ModelError::new(ModelErrorKind::UnsupportedOutput, false));
        }
        let request = ModelRequest {
            model: model_gateway.model.to_string(),
            messages: messages.clone(),
            tools: if round == 0 {
                workspace_tool_definitions(&runtime)
            } else {
                Vec::new()
            },
        };
        let stream = tokio::select! {
            biased;
            _ = cancellation.cancelled() => break 'rounds Terminal::Interrupted,
            result = model_gateway.provider.stream(request) => result,
        };
        let mut stream = match stream {
            Ok(stream) => stream,
            Err(error) => break 'rounds Terminal::Failed(error),
        };
        let mut tool_call = None;
        loop {
            let next = tokio::select! {
                biased;
                _ = cancellation.cancelled() => break 'rounds Terminal::Interrupted,
                next = stream.next() => next,
            };
            match next {
                Some(Ok(ModelEvent::TextDelta(delta))) if !delta.is_empty() => {
                    non_whitespace_text_seen |=
                        delta.chars().any(|character| !character.is_whitespace());
                    if agent_item.is_none() {
                        let item = match runtime
                            .lock_core()
                            .and_then(|mut core| core.start_agent_message(&thread_id, &turn_id))
                        {
                            Ok(item) => item,
                            Err(_) => break 'rounds Terminal::StateUnavailable,
                        };
                        agent_item = Some(item.clone());
                        let durable_event = CancellationToken::new();
                        if !send_event(
                            &runtime,
                            &durable_event,
                            request_id,
                            CoreEventKind::ItemStarted {
                                thread_id: thread_id.clone(),
                                turn_id: turn_id.clone(),
                                item: item.clone(),
                            },
                        )
                        .await
                        {
                            break 'rounds Terminal::StateUnavailable;
                        }
                    }
                    let item_id = agent_item.as_ref().expect("agent item started").id.clone();
                    match runtime
                        .lock_core()
                        .and_then(|mut core| core.append_text_delta(&thread_id, &turn_id, &delta))
                    {
                        Ok(_) => {}
                        Err(CoreError::OutputTooLarge) => {
                            break 'rounds Terminal::Failed(ModelError::new(
                                ModelErrorKind::OutputTooLarge,
                                false,
                            ));
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
                            item_id,
                            delta,
                        },
                    )
                    .await
                    {
                        break 'rounds Terminal::Interrupted;
                    }
                }
                Some(Ok(ModelEvent::TextDelta(_))) => {}
                Some(Ok(ModelEvent::ToolCall(call))) => {
                    if round != 0
                        || agent_item.is_some()
                        || tool_call_count >= MAX_TOOL_CALLS_PER_TURN
                        || tool_call.replace(call).is_some()
                    {
                        break 'rounds Terminal::Failed(ModelError::new(
                            ModelErrorKind::UnsupportedOutput,
                            false,
                        ));
                    }
                    tool_call_count += 1;
                }
                Some(Ok(ModelEvent::Usage(value))) => {
                    if !accumulate_usage(&mut usage, value) {
                        break 'rounds Terminal::Failed(ModelError::new(
                            ModelErrorKind::OutputTooLarge,
                            false,
                        ));
                    }
                }
                Some(Ok(ModelEvent::Completed)) => {
                    let Some(call) = tool_call else {
                        if !non_whitespace_text_seen {
                            break 'rounds Terminal::Failed(ModelError::new(
                                ModelErrorKind::Incomplete,
                                false,
                            ));
                        }
                        break 'rounds Terminal::Completed;
                    };
                    let tool_available = match call.name.as_str() {
                        "workspace/read" => runtime.workspace_read.is_some(),
                        "workspace/list" => runtime.workspace_list.is_some(),
                        "workspace/search" => runtime.workspace_search.is_some(),
                        "workspace/apply-patch" => runtime.workspace_patch.is_some(),
                        "shell/exec" => {
                            runtime.shell_executor.is_some() && runtime.approval_requester.is_some()
                        }
                        _ => false,
                    };
                    if !tool_available {
                        break 'rounds Terminal::Failed(ModelError::new(
                            ModelErrorKind::UnsupportedOutput,
                            false,
                        ));
                    }
                    if call.name == "shell/exec" {
                        let arguments = match shell_tool_arguments(&call) {
                            Ok(arguments) => arguments,
                            Err(error) => break 'rounds Terminal::Failed(error),
                        };
                        let call_bytes = serialized_shell_tool_call_bytes(&call, &arguments);
                        if turn_tool_bytes
                            .checked_add(call_bytes)
                            .is_none_or(|bytes| bytes > MAX_TURN_TOOL_BYTES)
                        {
                            break 'rounds Terminal::Failed(ModelError::new(
                                ModelErrorKind::OutputTooLarge,
                                false,
                            ));
                        }
                        turn_tool_bytes += call_bytes;
                        if append_completed_tool_item(
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
                        .is_none()
                        {
                            break 'rounds Terminal::StateUnavailable;
                        }
                        pending_tool_call = true;
                        let command_policy = runtime
                            .shell_executor
                            .as_ref()
                            .expect("validated shell executor")
                            .sandbox_policy();
                        let filesystem_policy = core_filesystem_policy(command_policy.filesystem);
                        let workspace_write_policy = command_policy
                            .workspace_write
                            .map(core_workspace_write_policy);
                        let workspace_write_risk = workspace_write_policy.map(|_| {
                            sugarcode_protocol::CoreCommandWorkspaceWriteRisk::NonTransactionalWorkspaceTreeV1
                        });
                        let network_policy = core_network_policy(command_policy.network);
                        let approval_id = format!("approval/{}/{}/{}", thread_id, turn_id, call.id);
                        if append_completed_tool_item(
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
                        .is_none()
                        {
                            break 'rounds Terminal::StateUnavailable;
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
                        if append_completed_tool_item(
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
                        .is_none()
                        {
                            break 'rounds Terminal::StateUnavailable;
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
                                let content = "shell/exec error: approvalUnsupported".to_string();
                                (result, content)
                            }
                            Some(CommandApprovalOutcome::Approved) => {
                                if append_completed_tool_item(
                                    &runtime,
                                    &prepared,
                                    CoreItemKind::CommandExecutionAttempt {
                                        approval_id: approval_id.clone(),
                                        call_id: call.id.clone(),
                                    },
                                )
                                .await
                                .is_none()
                                {
                                    break 'rounds Terminal::StateUnavailable;
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
                        if result_bytes > MAX_SERIALIZED_TOOL_RESULT_BYTES
                            || turn_tool_bytes
                                .checked_add(result_bytes)
                                .is_none_or(|bytes| bytes > MAX_TURN_TOOL_BYTES)
                        {
                            result = CoreToolResult::Error {
                                kind: CoreToolErrorKind::ResultTooLarge,
                            };
                            content = "shell/exec error: resultTooLarge".to_string();
                            result_bytes = serialized_tool_result_bytes(&result);
                        }
                        turn_tool_bytes += result_bytes;
                        if append_completed_tool_item(
                            &runtime,
                            &prepared,
                            CoreItemKind::ToolResult {
                                call_id: call.id.clone(),
                                name: call.name.clone(),
                                result,
                            },
                        )
                        .await
                        .is_none()
                        {
                            break 'rounds Terminal::StateUnavailable;
                        }
                        pending_tool_call = false;
                        messages.push(ModelMessage::ToolCall(call.clone()));
                        messages.push(ModelMessage::ToolResult {
                            call_id: call.id,
                            content,
                        });
                        round = 1;
                        continue 'rounds;
                    }
                    let arguments = match workspace_tool_arguments(&call) {
                        Ok(arguments) => arguments,
                        Err(error) => break 'rounds Terminal::Failed(error),
                    };
                    let call_bytes = serialized_tool_call_bytes(&call, &arguments);
                    if turn_tool_bytes
                        .checked_add(call_bytes)
                        .is_none_or(|bytes| bytes > MAX_TURN_TOOL_BYTES)
                    {
                        break 'rounds Terminal::Failed(ModelError::new(
                            ModelErrorKind::OutputTooLarge,
                            false,
                        ));
                    }
                    turn_tool_bytes += call_bytes;
                    if append_completed_tool_item(
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
                    .is_none()
                    {
                        break 'rounds Terminal::StateUnavailable;
                    }
                    pending_tool_call = true;
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
                                    let change_bytes = serialized_file_change_bytes(&file_change);
                                    if turn_tool_bytes
                                        .checked_add(change_bytes)
                                        .is_none_or(|bytes| bytes > MAX_TURN_TOOL_BYTES)
                                    {
                                        (
                                            CoreToolResult::Error {
                                                kind: CoreToolErrorKind::ResultTooLarge,
                                            },
                                            "workspace/apply-patch error: resultTooLarge"
                                                .to_string(),
                                            false,
                                        )
                                    } else {
                                        turn_tool_bytes += change_bytes;
                                        if append_completed_tool_item(
                                            &runtime,
                                            &prepared,
                                            file_change,
                                        )
                                        .await
                                        .is_none()
                                        {
                                            break 'rounds Terminal::StateUnavailable;
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
                                                let content =
                                                    serde_json::to_string(&serde_json::json!({
                                                        "path": path,
                                                        "kind": "update",
                                                        "beforeSha256": before_sha256,
                                                        "afterSha256": after_sha256,
                                                        "beforeBytes": before_bytes,
                                                        "afterBytes": after_bytes,
                                                    }))
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
                                                    format!("workspace/apply-patch error: {kind}"),
                                                    interrupted,
                                                )
                                            }
                                        }
                                    }
                                }
                            };
                        let mut result_bytes = serialized_tool_result_bytes(&result);
                        if result_bytes > MAX_SERIALIZED_TOOL_RESULT_BYTES
                            || turn_tool_bytes
                                .checked_add(result_bytes)
                                .is_none_or(|bytes| bytes > MAX_TURN_TOOL_BYTES)
                        {
                            result = CoreToolResult::Error {
                                kind: CoreToolErrorKind::ResultTooLarge,
                            };
                            content = "workspace/apply-patch error: resultTooLarge".to_string();
                            result_bytes = serialized_tool_result_bytes(&result);
                        }
                        turn_tool_bytes += result_bytes;
                        if append_completed_tool_item(
                            &runtime,
                            &prepared,
                            CoreItemKind::ToolResult {
                                call_id: call.id.clone(),
                                name: call.name.clone(),
                                result,
                            },
                        )
                        .await
                        .is_none()
                        {
                            break 'rounds Terminal::StateUnavailable;
                        }
                        pending_tool_call = false;
                        if interrupted_after_commit {
                            patch_commit_interrupted = true;
                            break 'rounds Terminal::Interrupted;
                        }
                        messages.push(ModelMessage::ToolCall(call.clone()));
                        messages.push(ModelMessage::ToolResult {
                            call_id: call.id,
                            content,
                        });
                        round = 1;
                        continue 'rounds;
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
                    if result_bytes > MAX_SERIALIZED_TOOL_RESULT_BYTES
                        || turn_tool_bytes
                            .checked_add(result_bytes)
                            .is_none_or(|bytes| bytes > MAX_TURN_TOOL_BYTES)
                    {
                        result = CoreToolResult::Error {
                            kind: CoreToolErrorKind::ResultTooLarge,
                        };
                        content = format!("{} error: resultTooLarge", call.name);
                        result_bytes = serialized_tool_result_bytes(&result);
                    }
                    turn_tool_bytes += result_bytes;
                    if append_completed_tool_item(
                        &runtime,
                        &prepared,
                        CoreItemKind::ToolResult {
                            call_id: call.id.clone(),
                            name: call.name.clone(),
                            result,
                        },
                    )
                    .await
                    .is_none()
                    {
                        break 'rounds Terminal::StateUnavailable;
                    }
                    pending_tool_call = false;
                    messages.push(ModelMessage::ToolCall(call.clone()));
                    messages.push(ModelMessage::ToolResult {
                        call_id: call.id,
                        content,
                    });
                    round = 1;
                    continue 'rounds;
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
    if agent_item.is_none() && !pending_tool_call && !patch_commit_interrupted {
        match runtime
            .lock_core()
            .and_then(|mut core| core.start_agent_message(&thread_id, &turn_id))
        {
            Ok(item) => {
                if runtime
                    .event_tx
                    .send(CoreEvent {
                        request_id,
                        kind: CoreEventKind::ItemStarted {
                            thread_id: thread_id.clone(),
                            turn_id: turn_id.clone(),
                            item: item.clone(),
                        },
                    })
                    .await
                    .is_err()
                {
                    terminal = Terminal::Interrupted;
                }
            }
            Err(_) => terminal = Terminal::StateUnavailable,
        }
    }
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
            arguments: match (command, arguments, query, patch) {
                (Some(command), Some(arguments), _, _) => serde_json::json!({
                    "command": command,
                    "arguments": arguments,
                    "cwd": path,
                }),
                (_, _, Some(query), _) => serde_json::json!({ "path": path, "query": query }),
                (_, _, _, Some(patch)) => serde_json::json!({ "path": path, "patch": patch }),
                _ => serde_json::json!({ "path": path }),
            },
        }),
        PreparedMessage::ToolResult { call_id, content } => ModelMessage::ToolResult {
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
