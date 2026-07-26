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
use sugarcode_tools::WorkspaceListArguments;
use sugarcode_tools::WorkspaceListErrorKind;
use sugarcode_tools::WorkspaceListExecutor;
use sugarcode_tools::WorkspaceListOutcome;
use sugarcode_tools::WorkspaceReadArguments;
use sugarcode_tools::WorkspaceReadErrorKind;
use sugarcode_tools::WorkspaceReadExecutor;
use sugarcode_tools::WorkspaceReadOutcome;
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
use tool_dispatch::map_workspace_read_outcome;
use tool_dispatch::serialized_tool_call_bytes;
use tool_dispatch::serialized_tool_result_bytes;
use tool_dispatch::workspace_tool_definitions;
use tool_dispatch::workspace_tool_path;

const MAX_PROVIDER_ROUNDS: u8 = 2;
const MAX_TOOL_CALLS_PER_TURN: usize = 1;
pub const MAX_SERIALIZED_TOOL_RESULT_BYTES: usize = 384 * 1024;
pub const MAX_TURN_TOOL_BYTES: usize = 400 * 1024;

const CORE_EVENT_CAPACITY: usize = 64;

#[derive(Clone)]
pub struct CoreRuntime {
    core: Arc<Mutex<Core>>,
    model_gateway: Option<ModelGateway>,
    workspace_read: Option<Arc<dyn WorkspaceReadExecutor>>,
    workspace_list: Option<Arc<dyn WorkspaceListExecutor>>,
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
                event_tx,
                active: Arc::new(Mutex::new(BTreeMap::new())),
            },
            event_rx,
        )
    }

    pub fn without_model(core: Core) -> (Self, mpsc::Receiver<CoreEvent>) {
        let (event_tx, event_rx) = mpsc::channel(CORE_EVENT_CAPACITY);
        (
            Self {
                core: Arc::new(Mutex::new(core)),
                model_gateway: None,
                workspace_read: None,
                workspace_list: None,
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
            run_turn(runtime, prepared, cancellation, terminal_state).await;
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
                        _ => false,
                    };
                    if !tool_available {
                        break 'rounds Terminal::Failed(ModelError::new(
                            ModelErrorKind::UnsupportedOutput,
                            false,
                        ));
                    }
                    let path = match workspace_tool_path(&call) {
                        Ok(path) => path,
                        Err(error) => break 'rounds Terminal::Failed(error),
                    };
                    let call_bytes = serialized_tool_call_bytes(&call, &path);
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
                            path: path.clone(),
                        },
                    )
                    .await
                    .is_none()
                    {
                        break 'rounds Terminal::StateUnavailable;
                    }
                    pending_tool_call = true;
                    let (mut result, mut content) = match call.name.as_str() {
                        "workspace/read" => {
                            let outcome = runtime
                                .workspace_read
                                .as_ref()
                                .expect("validated workspace/read executor")
                                .read(
                                    &WorkspaceReadArguments { path: path.clone() },
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
                                    &WorkspaceListArguments { path: path.clone() },
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
    if agent_item.is_none() && !pending_tool_call {
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
        } => ModelMessage::ToolCall(ModelToolCall {
            id: call_id.clone(),
            name: name.clone(),
            arguments: serde_json::json!({ "path": path }),
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
