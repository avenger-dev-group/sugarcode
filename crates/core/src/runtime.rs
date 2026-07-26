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

fn workspace_tool_definitions(runtime: &CoreRuntime) -> Vec<ModelToolDefinition> {
    let mut definitions = Vec::with_capacity(2);
    if runtime.workspace_read.is_some() {
        definitions.push(ModelToolDefinition {
            name: "workspace/read".to_string(),
            description: "Read one UTF-8 text file inside the configured workspace.".to_string(),
            parameters: workspace_path_parameters(),
        });
    }
    if runtime.workspace_list.is_some() {
        definitions.push(ModelToolDefinition {
            name: "workspace/list".to_string(),
            description:
                "List one directory non-recursively inside the configured workspace. Use '.' for the workspace root."
                    .to_string(),
            parameters: workspace_path_parameters(),
        });
    }
    definitions
}

fn workspace_path_parameters() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "path": { "type": "string" }
        },
        "required": ["path"]
    })
}

fn workspace_tool_path(call: &ModelToolCall) -> Result<String, ModelError> {
    if !matches!(call.name.as_str(), "workspace/read" | "workspace/list") {
        return Err(ModelError::new(ModelErrorKind::UnsupportedOutput, false));
    }
    let Some(arguments) = call.arguments.as_object() else {
        return Err(ModelError::new(ModelErrorKind::Protocol, false));
    };
    if arguments.len() != 1 {
        return Err(ModelError::new(ModelErrorKind::InvalidRequest, false));
    }
    arguments
        .get("path")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ModelError::new(ModelErrorKind::InvalidRequest, false))
}

fn map_workspace_read_outcome(outcome: WorkspaceReadOutcome) -> (CoreToolResult, String) {
    match outcome {
        WorkspaceReadOutcome::Content { content, bytes } => (
            CoreToolResult::Success {
                content: content.clone(),
                bytes: u64::try_from(bytes).unwrap_or(u64::MAX),
            },
            content,
        ),
        WorkspaceReadOutcome::Error { kind } => {
            let kind = match kind {
                WorkspaceReadErrorKind::InvalidPath => CoreToolErrorKind::InvalidPath,
                WorkspaceReadErrorKind::NotFound => CoreToolErrorKind::NotFound,
                WorkspaceReadErrorKind::AccessDenied => CoreToolErrorKind::AccessDenied,
                WorkspaceReadErrorKind::PathNotAllowed => CoreToolErrorKind::PathNotAllowed,
                WorkspaceReadErrorKind::NotRegularFile => CoreToolErrorKind::NotRegularFile,
                WorkspaceReadErrorKind::FileTooLarge => CoreToolErrorKind::FileTooLarge,
                WorkspaceReadErrorKind::BinaryFile => CoreToolErrorKind::BinaryFile,
                WorkspaceReadErrorKind::ChangedDuringRead => CoreToolErrorKind::ChangedDuringRead,
                WorkspaceReadErrorKind::Cancelled => CoreToolErrorKind::Unavailable,
                WorkspaceReadErrorKind::Unavailable => CoreToolErrorKind::Unavailable,
            };
            (
                CoreToolResult::Error { kind },
                format!("workspace/read error: {kind}"),
            )
        }
    }
}

fn map_workspace_list_outcome(outcome: WorkspaceListOutcome) -> (CoreToolResult, String) {
    match outcome {
        WorkspaceListOutcome::Entries {
            entries,
            name_bytes: _,
        } => {
            let entries = entries
                .into_iter()
                .map(|entry| {
                    serde_json::json!({
                        "name": entry.name,
                        "kind": entry.kind.as_str(),
                    })
                })
                .collect::<Vec<_>>();
            let content = serde_json::to_string(&serde_json::json!({ "entries": entries }))
                .expect("workspace/list result must serialize");
            (
                CoreToolResult::Success {
                    bytes: u64::try_from(content.len()).unwrap_or(u64::MAX),
                    content: content.clone(),
                },
                content,
            )
        }
        WorkspaceListOutcome::Error { kind } => {
            let kind = match kind {
                WorkspaceListErrorKind::InvalidPath => CoreToolErrorKind::InvalidPath,
                WorkspaceListErrorKind::NotFound => CoreToolErrorKind::NotFound,
                WorkspaceListErrorKind::AccessDenied => CoreToolErrorKind::AccessDenied,
                WorkspaceListErrorKind::PathNotAllowed => CoreToolErrorKind::PathNotAllowed,
                WorkspaceListErrorKind::NotDirectory => CoreToolErrorKind::NotDirectory,
                WorkspaceListErrorKind::InvalidEncoding => CoreToolErrorKind::InvalidEncoding,
                WorkspaceListErrorKind::InvalidName => CoreToolErrorKind::InvalidName,
                WorkspaceListErrorKind::TooManyEntries => CoreToolErrorKind::TooManyEntries,
                WorkspaceListErrorKind::ChangedDuringList => CoreToolErrorKind::ChangedDuringList,
                WorkspaceListErrorKind::ResultTooLarge => CoreToolErrorKind::ResultTooLarge,
                WorkspaceListErrorKind::Cancelled => CoreToolErrorKind::Unavailable,
                WorkspaceListErrorKind::Unavailable => CoreToolErrorKind::Unavailable,
            };
            (
                CoreToolResult::Error { kind },
                format!("workspace/list error: {kind}"),
            )
        }
    }
}

fn serialized_tool_call_bytes(call: &ModelToolCall, path: &str) -> usize {
    serde_json::to_vec(&serde_json::json!({
        "type": "toolCall",
        "callId": call.id,
        "name": call.name,
        "path": path,
    }))
    .map_or(usize::MAX, |bytes| bytes.len())
}

fn serialized_tool_result_bytes(result: &CoreToolResult) -> usize {
    let value = match result {
        CoreToolResult::Success { content, bytes } => serde_json::json!({
            "type": "success",
            "content": content,
            "bytes": bytes,
        }),
        CoreToolResult::Error { kind } => serde_json::json!({
            "type": "error",
            "kind": kind.to_string(),
        }),
    };
    serde_json::to_vec(&value).map_or(usize::MAX, |bytes| bytes.len())
}

async fn append_completed_tool_item(
    runtime: &CoreRuntime,
    prepared: &crate::PreparedTextTurn,
    kind: CoreItemKind,
) -> Option<CoreItemSnapshot> {
    let item = runtime
        .lock_core()
        .and_then(|mut core| {
            core.append_completed_item(&prepared.thread_id, &prepared.turn_id, kind)
        })
        .ok()?;
    let durable_event = CancellationToken::new();
    if !send_event(
        runtime,
        &durable_event,
        prepared.request_id,
        CoreEventKind::ItemStarted {
            thread_id: prepared.thread_id.clone(),
            turn_id: prepared.turn_id.clone(),
            item: item.clone(),
        },
    )
    .await
    {
        return None;
    }
    if !send_event(
        runtime,
        &durable_event,
        prepared.request_id,
        CoreEventKind::ItemCompleted {
            thread_id: prepared.thread_id.clone(),
            turn_id: prepared.turn_id.clone(),
            item: item.clone(),
        },
    )
    .await
    {
        return None;
    }
    Some(item)
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

fn claim_terminal(terminal_state: &Mutex<TurnPhase>, terminal: Terminal) -> Terminal {
    let Ok(mut phase) = terminal_state.lock() else {
        return Terminal::StateUnavailable;
    };
    match terminal {
        Terminal::Interrupted => {
            *phase = TurnPhase::TerminalClaimed;
            Terminal::Interrupted
        }
        terminal => {
            if *phase == TurnPhase::Running {
                *phase = TurnPhase::TerminalClaimed;
                terminal
            } else {
                *phase = TurnPhase::TerminalClaimed;
                Terminal::Interrupted
            }
        }
    }
}

enum Terminal {
    Completed,
    Failed(ModelError),
    Interrupted,
    StateUnavailable,
}

async fn finish_completed_and_emit(
    runtime: &CoreRuntime,
    prepared: &crate::PreparedTextTurn,
    usage: Option<ModelUsage>,
) {
    let durable_usage = usage.map(map_usage);
    match finish(
        runtime,
        prepared,
        DurableTurnStatus::Completed,
        None,
        durable_usage,
    ) {
        Ok(item) => {
            emit_terminal(
                runtime,
                prepared,
                item,
                CoreEventKind::TurnCompleted {
                    thread_id: prepared.thread_id.clone(),
                    turn_id: prepared.turn_id.clone(),
                },
            )
            .await;
        }
        Err(_) => emit_runtime_failure(runtime, prepared.request_id).await,
    }
}

async fn finish_failed_and_emit(
    runtime: &CoreRuntime,
    prepared: &crate::PreparedTextTurn,
    error: ModelError,
    usage: Option<ModelUsage>,
) {
    let core_error = map_model_error(error);
    let durable_error = map_durable_error(core_error);
    if let Ok(item) = finish(
        runtime,
        prepared,
        DurableTurnStatus::Failed,
        Some(durable_error),
        usage.map(map_usage),
    ) {
        emit_terminal(
            runtime,
            prepared,
            item,
            CoreEventKind::TurnFailed {
                thread_id: prepared.thread_id.clone(),
                turn_id: prepared.turn_id.clone(),
                error: core_error,
            },
        )
        .await;
    } else {
        emit_runtime_failure(runtime, prepared.request_id).await;
    }
}

async fn finish_interrupted_and_emit(
    runtime: &CoreRuntime,
    prepared: &crate::PreparedTextTurn,
    usage: Option<ModelUsage>,
) {
    if let Ok(item) = finish_interrupted(runtime, prepared, usage).await {
        emit_terminal(
            runtime,
            prepared,
            item,
            CoreEventKind::TurnInterrupted {
                thread_id: prepared.thread_id.clone(),
                turn_id: prepared.turn_id.clone(),
            },
        )
        .await;
    } else {
        emit_runtime_failure(runtime, prepared.request_id).await;
    }
}

async fn finish_interrupted(
    runtime: &CoreRuntime,
    prepared: &crate::PreparedTextTurn,
    usage: Option<ModelUsage>,
) -> Result<Option<CoreItemSnapshot>, CoreError> {
    finish(
        runtime,
        prepared,
        DurableTurnStatus::Interrupted,
        None,
        usage.map(map_usage),
    )
}

async fn finish_state_unavailable_and_emit(
    runtime: &CoreRuntime,
    prepared: &crate::PreparedTextTurn,
) {
    let error = CoreTurnError {
        kind: CoreTurnErrorKind::StateUnavailable,
        retryable: false,
    };
    if let Ok(item) = finish(
        runtime,
        prepared,
        DurableTurnStatus::Failed,
        Some(map_durable_error(error)),
        None,
    ) {
        emit_terminal(
            runtime,
            prepared,
            item,
            CoreEventKind::TurnFailed {
                thread_id: prepared.thread_id.clone(),
                turn_id: prepared.turn_id.clone(),
                error,
            },
        )
        .await;
    } else {
        emit_runtime_failure(runtime, prepared.request_id).await;
    }
}

async fn emit_runtime_failure(runtime: &CoreRuntime, request_id: CoreRequestId) {
    let _ = runtime
        .event_tx
        .send(CoreEvent {
            request_id,
            kind: CoreEventKind::RuntimeFailed,
        })
        .await;
}

fn finish(
    runtime: &CoreRuntime,
    prepared: &crate::PreparedTextTurn,
    status: DurableTurnStatus,
    error: Option<DurableTurnError>,
    usage: Option<DurableUsage>,
) -> Result<Option<CoreItemSnapshot>, CoreError> {
    runtime
        .lock_core()?
        .finish_turn(&prepared.thread_id, &prepared.turn_id, status, error, usage)
}

async fn emit_terminal(
    runtime: &CoreRuntime,
    prepared: &crate::PreparedTextTurn,
    item: Option<CoreItemSnapshot>,
    terminal: CoreEventKind,
) {
    let cancellation = CancellationToken::new();
    if let Some(item) = item {
        let _ = send_event(
            runtime,
            &cancellation,
            prepared.request_id,
            CoreEventKind::ItemCompleted {
                thread_id: prepared.thread_id.clone(),
                turn_id: prepared.turn_id.clone(),
                item,
            },
        )
        .await;
    }
    let _ = send_event(runtime, &cancellation, prepared.request_id, terminal).await;
}

async fn send_event(
    runtime: &CoreRuntime,
    cancellation: &CancellationToken,
    request_id: CoreRequestId,
    kind: CoreEventKind,
) -> bool {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => false,
        result = runtime.event_tx.send(CoreEvent { request_id, kind }) => result.is_ok(),
    }
}

fn clear_active(runtime: &CoreRuntime, thread_id: &ThreadId, turn_id: &TurnId) {
    if let Ok(mut active) = runtime.active.lock()
        && active
            .get(thread_id)
            .is_some_and(|active| &active.turn_id == turn_id)
        && let Some(active) = active.remove(thread_id)
    {
        active.done.finish();
    }
}

fn map_model_error(error: ModelError) -> CoreTurnError {
    CoreTurnError {
        kind: match error.kind() {
            ModelErrorKind::Authentication => CoreTurnErrorKind::Authentication,
            ModelErrorKind::InvalidRequest => CoreTurnErrorKind::InvalidRequest,
            ModelErrorKind::RateLimited => CoreTurnErrorKind::RateLimited,
            ModelErrorKind::Timeout => CoreTurnErrorKind::Timeout,
            ModelErrorKind::Transport => CoreTurnErrorKind::Transport,
            ModelErrorKind::Disconnected => CoreTurnErrorKind::Disconnected,
            ModelErrorKind::Server => CoreTurnErrorKind::Server,
            ModelErrorKind::Protocol => CoreTurnErrorKind::Protocol,
            ModelErrorKind::Incomplete => CoreTurnErrorKind::Incomplete,
            ModelErrorKind::Filtered => CoreTurnErrorKind::Filtered,
            ModelErrorKind::UnsupportedOutput => CoreTurnErrorKind::UnsupportedOutput,
            ModelErrorKind::OutputTooLarge => CoreTurnErrorKind::OutputTooLarge,
        },
        retryable: error.retryable(),
    }
}

fn map_durable_error(error: CoreTurnError) -> DurableTurnError {
    DurableTurnError {
        kind: match error.kind {
            CoreTurnErrorKind::Authentication => DurableTurnErrorKind::Authentication,
            CoreTurnErrorKind::InvalidRequest => DurableTurnErrorKind::InvalidRequest,
            CoreTurnErrorKind::RateLimited => DurableTurnErrorKind::RateLimited,
            CoreTurnErrorKind::Timeout => DurableTurnErrorKind::Timeout,
            CoreTurnErrorKind::Transport => DurableTurnErrorKind::Transport,
            CoreTurnErrorKind::Disconnected => DurableTurnErrorKind::Disconnected,
            CoreTurnErrorKind::Server => DurableTurnErrorKind::Server,
            CoreTurnErrorKind::Protocol => DurableTurnErrorKind::Protocol,
            CoreTurnErrorKind::Incomplete => DurableTurnErrorKind::Incomplete,
            CoreTurnErrorKind::Filtered => DurableTurnErrorKind::Filtered,
            CoreTurnErrorKind::UnsupportedOutput => DurableTurnErrorKind::UnsupportedOutput,
            CoreTurnErrorKind::OutputTooLarge => DurableTurnErrorKind::OutputTooLarge,
            CoreTurnErrorKind::StateUnavailable => DurableTurnErrorKind::StateUnavailable,
        },
        retryable: error.retryable,
    }
}

fn map_usage(usage: ModelUsage) -> DurableUsage {
    DurableUsage {
        input_tokens: usage.input_tokens,
        cached_input_tokens: usage.cached_input_tokens,
        output_tokens: usage.output_tokens,
        reasoning_tokens: usage.reasoning_output_tokens,
        total_tokens: usage.total_tokens,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt;
    use futures_util::StreamExt;
    use futures_util::stream;
    use std::collections::VecDeque;
    use std::sync::atomic::AtomicUsize;
    use sugarcode_model_provider::BoxModelFuture;
    use sugarcode_tools::WorkspaceTool;
    use tokio::sync::oneshot;

    #[derive(Debug)]
    struct RecordedProvider {
        events: Vec<Result<ModelEvent, ModelError>>,
        stay_open: bool,
    }

    impl ModelProvider for RecordedProvider {
        fn stream(&self, _request: ModelRequest) -> BoxModelFuture<'_> {
            let events = self.events.clone();
            let stay_open = self.stay_open;
            async move {
                let stream = stream::iter(events);
                if stay_open {
                    Ok(stream.chain(stream::pending()).boxed())
                } else {
                    Ok(stream.boxed())
                }
            }
            .boxed()
        }
    }

    #[derive(Debug)]
    struct SequencedProvider {
        rounds: Mutex<VecDeque<Vec<Result<ModelEvent, ModelError>>>>,
        requests: Arc<Mutex<Vec<ModelRequest>>>,
    }

    impl ModelProvider for SequencedProvider {
        fn stream(&self, request: ModelRequest) -> BoxModelFuture<'_> {
            self.requests.lock().expect("requests").push(request);
            let events = self
                .rounds
                .lock()
                .expect("rounds")
                .pop_front()
                .expect("recorded round");
            async move { Ok(stream::iter(events).boxed()) }.boxed()
        }
    }

    struct BlockingWorkspaceRead {
        entered: Mutex<Option<oneshot::Sender<()>>>,
    }

    impl fmt::Debug for BlockingWorkspaceRead {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter
                .debug_struct("BlockingWorkspaceRead")
                .finish_non_exhaustive()
        }
    }

    impl WorkspaceReadExecutor for BlockingWorkspaceRead {
        fn read<'a>(
            &'a self,
            _arguments: &'a WorkspaceReadArguments,
            cancellation: &'a CancellationToken,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = WorkspaceReadOutcome> + Send + 'a>>
        {
            Box::pin(async move {
                if let Some(entered) = self.entered.lock().expect("entered").take() {
                    let _ = entered.send(());
                }
                cancellation.cancelled().await;
                WorkspaceReadOutcome::Error {
                    kind: WorkspaceReadErrorKind::Cancelled,
                }
            })
        }
    }

    struct BlockingSecondRoundProvider {
        calls: AtomicUsize,
        second_entered: Mutex<Option<oneshot::Sender<()>>>,
    }

    impl fmt::Debug for BlockingSecondRoundProvider {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter
                .debug_struct("BlockingSecondRoundProvider")
                .finish_non_exhaustive()
        }
    }

    impl ModelProvider for BlockingSecondRoundProvider {
        fn stream(&self, _request: ModelRequest) -> BoxModelFuture<'_> {
            if self.calls.fetch_add(1, Ordering::AcqRel) == 0 {
                return async move {
                    Ok(stream::iter(vec![
                        Ok(ModelEvent::ToolCall(ModelToolCall {
                            id: "call_second_round".to_string(),
                            name: "workspace/read".to_string(),
                            arguments: serde_json::json!({ "path": "README.txt" }),
                        })),
                        Ok(ModelEvent::Completed),
                    ])
                    .boxed())
                }
                .boxed();
            }
            if let Some(entered) = self.second_entered.lock().expect("second entered").take() {
                let _ = entered.send(());
            }
            async move {
                std::future::pending::<Result<sugarcode_model_provider::ModelStream, ModelError>>()
                    .await
            }
            .boxed()
        }
    }

    fn runtime(provider: RecordedProvider) -> (CoreRuntime, mpsc::Receiver<CoreEvent>, ThreadId) {
        let mut core = Core::new();
        let started = core
            .start_thread(CoreRequestId::new(1))
            .expect("start thread");
        let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
            panic!("thread event");
        };
        let (runtime, events) =
            CoreRuntime::new(core, Arc::new(provider), "fixture-model".to_string());
        (runtime, events, thread_id)
    }

    #[tokio::test]
    async fn successful_task_streams_and_persists_one_terminal_lifecycle() {
        let (mut runtime, mut events, thread_id) = runtime(RecordedProvider {
            events: vec![
                Ok(ModelEvent::TextDelta("hello ".to_string())),
                Ok(ModelEvent::TextDelta("world".to_string())),
                Ok(ModelEvent::Usage(ModelUsage {
                    input_tokens: Some(2),
                    output_tokens: Some(2),
                    total_tokens: Some(4),
                    ..Default::default()
                })),
                Ok(ModelEvent::Completed),
            ],
            stay_open: false,
        });
        let outcome = runtime
            .start_text_turn(
                CoreRequestId::new(2),
                thread_id.clone(),
                Some("Hello".to_string()),
            )
            .expect("start text turn");
        let TurnStartOutcome::Accepted { turn_id } = outcome else {
            panic!("asynchronous turn");
        };

        let mut lifecycle = Vec::new();
        while lifecycle.last().is_none_or(|event: &CoreEvent| {
            !matches!(event.kind, CoreEventKind::TurnCompleted { .. })
        }) {
            lifecycle.push(events.recv().await.expect("core event"));
        }
        assert_eq!(
            lifecycle
                .iter()
                .filter(|event| matches!(event.kind, CoreEventKind::ItemCompleted { .. }))
                .count(),
            2
        );
        assert_eq!(
            lifecycle
                .iter()
                .filter(|event| matches!(event.kind, CoreEventKind::TurnCompleted { .. }))
                .count(),
            1
        );
        let snapshot = runtime.resume_thread(&thread_id).expect("resume");
        let turn = snapshot
            .turns
            .iter()
            .find(|turn| turn.id == turn_id)
            .expect("persisted turn");
        assert_eq!(turn.status, DurableTurnStatus::Completed);
        assert_eq!(turn.items.len(), 2);
        assert_eq!(
            turn.usage.as_ref().and_then(|usage| usage.total_tokens),
            Some(4)
        );
    }

    #[tokio::test]
    async fn whitespace_only_final_response_fails_without_a_completed_empty_message() {
        let (mut runtime, mut events, thread_id) = runtime(RecordedProvider {
            events: vec![
                Ok(ModelEvent::TextDelta(" \n\t".to_string())),
                Ok(ModelEvent::Completed),
            ],
            stay_open: false,
        });
        let TurnStartOutcome::Accepted { turn_id } = runtime
            .start_text_turn(
                CoreRequestId::new(2),
                thread_id.clone(),
                Some("Hello".to_string()),
            )
            .expect("start text turn")
        else {
            panic!("asynchronous turn");
        };
        while !matches!(
            events.recv().await.expect("terminal event").kind,
            CoreEventKind::TurnCompleted { .. }
                | CoreEventKind::TurnFailed { .. }
                | CoreEventKind::TurnInterrupted { .. }
        ) {}
        let snapshot = runtime.resume_thread(&thread_id).expect("resume");
        let turn = snapshot
            .turns
            .iter()
            .find(|turn| turn.id == turn_id)
            .expect("persisted turn");
        assert_eq!(turn.status, DurableTurnStatus::Failed);
        assert_eq!(
            turn.error.as_ref().map(|error| error.kind),
            Some(DurableTurnErrorKind::Incomplete)
        );
    }

    #[tokio::test]
    async fn workspace_read_runs_one_durable_tool_round_before_the_final_answer() {
        let directory = tempfile::tempdir().expect("workspace");
        std::fs::write(directory.path().join("README.txt"), "bounded context")
            .expect("workspace fixture");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let provider = SequencedProvider {
            rounds: Mutex::new(VecDeque::from([
                vec![
                    Ok(ModelEvent::ToolCall(ModelToolCall {
                        id: "call_1".to_string(),
                        name: "workspace/read".to_string(),
                        arguments: serde_json::json!({ "path": "README.txt" }),
                    })),
                    Ok(ModelEvent::Usage(ModelUsage {
                        input_tokens: Some(3),
                        cached_input_tokens: Some(1),
                        output_tokens: Some(2),
                        reasoning_output_tokens: Some(1),
                        total_tokens: Some(5),
                    })),
                    Ok(ModelEvent::Completed),
                ],
                vec![
                    Ok(ModelEvent::TextDelta("I read it.".to_string())),
                    Ok(ModelEvent::Usage(ModelUsage {
                        input_tokens: Some(7),
                        cached_input_tokens: Some(2),
                        output_tokens: Some(4),
                        reasoning_output_tokens: Some(2),
                        total_tokens: Some(11),
                    })),
                    Ok(ModelEvent::Completed),
                ],
            ])),
            requests: requests.clone(),
        };
        let mut core = Core::new();
        let started = core
            .start_thread(CoreRequestId::new(1))
            .expect("start thread");
        let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
            panic!("thread event");
        };
        let tool = Arc::new(WorkspaceTool::open(directory.path()).expect("workspace tool"));
        let (mut runtime, mut events) = CoreRuntime::new_with_workspace(
            core,
            Arc::new(provider),
            "fixture-model".to_string(),
            Some(tool),
            None,
        );
        let TurnStartOutcome::Accepted { turn_id } = runtime
            .start_text_turn(
                CoreRequestId::new(2),
                thread_id.clone(),
                Some("Read the file".to_string()),
            )
            .expect("start tool turn")
        else {
            panic!("asynchronous turn");
        };

        let mut lifecycle = Vec::new();
        while lifecycle.last().is_none_or(|event: &CoreEvent| {
            !matches!(event.kind, CoreEventKind::TurnCompleted { .. })
        }) {
            lifecycle.push(events.recv().await.expect("core event"));
        }
        assert!(lifecycle.iter().any(|event| {
            matches!(
                &event.kind,
                CoreEventKind::ItemCompleted {
                    item: CoreItemSnapshot {
                        kind: CoreItemKind::ToolCall { path, .. },
                        ..
                    },
                    ..
                } if path == "README.txt"
            )
        }));
        assert!(lifecycle.iter().any(|event| {
            matches!(
                &event.kind,
                CoreEventKind::ItemCompleted {
                    item: CoreItemSnapshot {
                        kind: CoreItemKind::ToolResult {
                            result: CoreToolResult::Success { content, .. },
                            ..
                        },
                        ..
                    },
                    ..
                } if content == "bounded context"
            )
        }));

        let requests = requests.lock().expect("requests");
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].tools.len(), 1);
        assert!(requests[1].tools.is_empty());
        assert!(matches!(
            requests[1].messages.as_slice(),
            [
                ModelMessage::Text { .. },
                ModelMessage::ToolCall(_),
                ModelMessage::ToolResult { content, .. }
            ] if content == "bounded context"
        ));
        drop(requests);

        let snapshot = runtime.resume_thread(&thread_id).expect("resume");
        let turn = snapshot
            .turns
            .iter()
            .find(|turn| turn.id == turn_id)
            .expect("persisted tool turn");
        assert_eq!(turn.status, DurableTurnStatus::Completed);
        assert_eq!(
            turn.usage,
            Some(DurableUsage {
                input_tokens: Some(10),
                cached_input_tokens: Some(3),
                output_tokens: Some(6),
                reasoning_tokens: Some(3),
                total_tokens: Some(16),
            })
        );
        assert!(matches!(
            turn.items.as_slice(),
            [
                sugarcode_state::DurableItemSnapshot::UserMessage { .. },
                sugarcode_state::DurableItemSnapshot::ToolCall { .. },
                sugarcode_state::DurableItemSnapshot::ToolResult {
                    result: sugarcode_state::DurableToolResult::Success { content, .. },
                    ..
                },
                sugarcode_state::DurableItemSnapshot::AgentMessage { text, .. }
            ] if content == "bounded context" && text == "I read it."
        ));
    }

    #[tokio::test]
    async fn workspace_list_uses_the_shared_authority_and_one_durable_tool_round() {
        let directory = tempfile::tempdir().expect("workspace");
        std::fs::write(directory.path().join("zeta.txt"), "z").expect("zeta fixture");
        std::fs::write(directory.path().join("Alpha.txt"), "a").expect("alpha fixture");
        std::fs::create_dir(directory.path().join("src")).expect("directory fixture");
        std::fs::write(directory.path().join("src/nested.txt"), "nested").expect("nested fixture");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let provider = SequencedProvider {
            rounds: Mutex::new(VecDeque::from([
                vec![
                    Ok(ModelEvent::ToolCall(ModelToolCall {
                        id: "call_list".to_string(),
                        name: "workspace/list".to_string(),
                        arguments: serde_json::json!({ "path": "." }),
                    })),
                    Ok(ModelEvent::Completed),
                ],
                vec![
                    Ok(ModelEvent::TextDelta("I listed it.".to_string())),
                    Ok(ModelEvent::Completed),
                ],
            ])),
            requests: requests.clone(),
        };
        let mut core = Core::new();
        let started = core
            .start_thread(CoreRequestId::new(1))
            .expect("start thread");
        let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
            panic!("thread event");
        };
        let tool = Arc::new(WorkspaceTool::open(directory.path()).expect("workspace tool"));
        let workspace_read: Arc<dyn WorkspaceReadExecutor> = tool.clone();
        let workspace_list: Arc<dyn WorkspaceListExecutor> = tool;
        let (mut runtime, mut events) = CoreRuntime::new_with_workspace(
            core,
            Arc::new(provider),
            "fixture-model".to_string(),
            Some(workspace_read),
            Some(workspace_list),
        );
        let TurnStartOutcome::Accepted { turn_id } = runtime
            .start_text_turn(
                CoreRequestId::new(2),
                thread_id.clone(),
                Some("List the workspace".to_string()),
            )
            .expect("start tool turn")
        else {
            panic!("asynchronous turn");
        };

        while !matches!(
            events.recv().await.expect("terminal event").kind,
            CoreEventKind::TurnCompleted { .. }
        ) {}

        let expected = serde_json::json!({
            "entries": [
                { "name": "Alpha.txt", "kind": "file" },
                { "name": "src", "kind": "directory" },
                { "name": "zeta.txt", "kind": "file" }
            ]
        });
        let requests = requests.lock().expect("requests");
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0]
                .tools
                .iter()
                .map(|definition| definition.name.as_str())
                .collect::<Vec<_>>(),
            vec!["workspace/read", "workspace/list"]
        );
        assert!(requests[1].tools.is_empty());
        assert!(matches!(
            requests[1].messages.last(),
            Some(ModelMessage::ToolResult { content, .. })
                if serde_json::from_str::<serde_json::Value>(content).expect("list JSON") == expected
        ));
        drop(requests);

        let snapshot = runtime.resume_thread(&thread_id).expect("resume");
        let turn = snapshot
            .turns
            .iter()
            .find(|turn| turn.id == turn_id)
            .expect("persisted tool turn");
        assert_eq!(turn.status, DurableTurnStatus::Completed);
        assert!(matches!(
            turn.items.as_slice(),
            [
                sugarcode_state::DurableItemSnapshot::UserMessage { .. },
                sugarcode_state::DurableItemSnapshot::ToolCall { name, path, .. },
                sugarcode_state::DurableItemSnapshot::ToolResult {
                    result: sugarcode_state::DurableToolResult::Success { content, .. },
                    ..
                },
                sugarcode_state::DurableItemSnapshot::AgentMessage { text, .. }
            ] if name == "workspace/list"
                && path == "."
                && serde_json::from_str::<serde_json::Value>(content).expect("durable list JSON") == expected
                && text == "I listed it."
        ));
    }

    #[tokio::test]
    async fn serialized_tool_result_limit_becomes_one_durable_error_result() {
        let directory = tempfile::tempdir().expect("workspace");
        std::fs::write(
            directory.path().join("escaped.txt"),
            vec![1u8; sugarcode_tools::MAX_WORKSPACE_READ_BYTES],
        )
        .expect("workspace fixture");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let provider = SequencedProvider {
            rounds: Mutex::new(VecDeque::from([
                vec![
                    Ok(ModelEvent::ToolCall(ModelToolCall {
                        id: "call_escaped".to_string(),
                        name: "workspace/read".to_string(),
                        arguments: serde_json::json!({ "path": "escaped.txt" }),
                    })),
                    Ok(ModelEvent::Completed),
                ],
                vec![
                    Ok(ModelEvent::TextDelta("The result was bounded.".to_string())),
                    Ok(ModelEvent::Completed),
                ],
            ])),
            requests: requests.clone(),
        };
        let mut core = Core::new();
        let started = core
            .start_thread(CoreRequestId::new(1))
            .expect("start thread");
        let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
            panic!("thread event");
        };
        let tool = Arc::new(WorkspaceTool::open(directory.path()).expect("workspace tool"));
        let (mut runtime, mut events) = CoreRuntime::new_with_workspace(
            core,
            Arc::new(provider),
            "fixture-model".to_string(),
            Some(tool),
            None,
        );
        let TurnStartOutcome::Accepted { turn_id } = runtime
            .start_text_turn(
                CoreRequestId::new(2),
                thread_id.clone(),
                Some("Read the file".to_string()),
            )
            .expect("start tool turn")
        else {
            panic!("asynchronous turn");
        };
        while !matches!(
            events.recv().await.expect("terminal event").kind,
            CoreEventKind::TurnCompleted { .. }
        ) {}

        let requests = requests.lock().expect("requests");
        assert!(matches!(
            requests[1].messages.last(),
            Some(ModelMessage::ToolResult { content, .. })
                if content == "workspace/read error: resultTooLarge"
        ));
        drop(requests);
        let snapshot = runtime.resume_thread(&thread_id).expect("resume");
        let turn = snapshot
            .turns
            .iter()
            .find(|turn| turn.id == turn_id)
            .expect("persisted turn");
        assert!(turn.items.iter().any(|item| matches!(
            item,
            sugarcode_state::DurableItemSnapshot::ToolResult {
                result: sugarcode_state::DurableToolResult::Error {
                    kind,
                },
                ..
            } if kind == "resultTooLarge"
        )));
    }

    #[tokio::test]
    async fn unknown_and_second_round_tool_calls_fail_without_extra_execution() {
        for (rounds, expected_requests) in [
            (
                VecDeque::from([vec![
                    Ok(ModelEvent::ToolCall(ModelToolCall {
                        id: "call_unknown".to_string(),
                        name: "workspace/unknown".to_string(),
                        arguments: serde_json::json!({ "path": "README.txt" }),
                    })),
                    Ok(ModelEvent::Completed),
                ]]),
                1,
            ),
            (
                VecDeque::from([
                    vec![
                        Ok(ModelEvent::ToolCall(ModelToolCall {
                            id: "call_1".to_string(),
                            name: "workspace/read".to_string(),
                            arguments: serde_json::json!({ "path": "README.txt" }),
                        })),
                        Ok(ModelEvent::Completed),
                    ],
                    vec![
                        Ok(ModelEvent::ToolCall(ModelToolCall {
                            id: "call_2".to_string(),
                            name: "workspace/read".to_string(),
                            arguments: serde_json::json!({ "path": "README.txt" }),
                        })),
                        Ok(ModelEvent::Completed),
                    ],
                ]),
                2,
            ),
        ] {
            let directory = tempfile::tempdir().expect("workspace");
            std::fs::write(directory.path().join("README.txt"), "bounded context")
                .expect("workspace fixture");
            let requests = Arc::new(Mutex::new(Vec::new()));
            let provider = SequencedProvider {
                rounds: Mutex::new(rounds),
                requests: requests.clone(),
            };
            let mut core = Core::new();
            let started = core
                .start_thread(CoreRequestId::new(1))
                .expect("start thread");
            let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
                panic!("thread event");
            };
            let tool = Arc::new(WorkspaceTool::open(directory.path()).expect("workspace tool"));
            let (mut runtime, mut events) = CoreRuntime::new_with_workspace(
                core,
                Arc::new(provider),
                "fixture-model".to_string(),
                Some(tool),
                None,
            );
            let TurnStartOutcome::Accepted { turn_id } = runtime
                .start_text_turn(
                    CoreRequestId::new(2),
                    thread_id.clone(),
                    Some("Read it".to_string()),
                )
                .expect("start tool turn")
            else {
                panic!("asynchronous turn");
            };
            while !matches!(
                events.recv().await.expect("terminal event").kind,
                CoreEventKind::TurnFailed { .. }
            ) {}
            assert_eq!(requests.lock().expect("requests").len(), expected_requests);
            let snapshot = runtime.resume_thread(&thread_id).expect("resume");
            let turn = snapshot
                .turns
                .iter()
                .find(|turn| turn.id == turn_id)
                .expect("persisted turn");
            assert_eq!(turn.status, DurableTurnStatus::Failed);
            assert_eq!(
                turn.error.as_ref().map(|error| error.kind),
                Some(DurableTurnErrorKind::UnsupportedOutput)
            );
        }
    }

    #[tokio::test]
    async fn interrupt_after_tool_call_persists_no_tool_result() {
        let (entered_tx, entered_rx) = oneshot::channel();
        let provider = SequencedProvider {
            rounds: Mutex::new(VecDeque::from([
                vec![
                    Ok(ModelEvent::ToolCall(ModelToolCall {
                        id: "call_cancel".to_string(),
                        name: "workspace/read".to_string(),
                        arguments: serde_json::json!({ "path": "blocked.txt" }),
                    })),
                    Ok(ModelEvent::Completed),
                ],
                Vec::new(),
            ])),
            requests: Arc::new(Mutex::new(Vec::new())),
        };
        let mut core = Core::new();
        let started = core
            .start_thread(CoreRequestId::new(1))
            .expect("start thread");
        let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
            panic!("thread event");
        };
        let tool: Arc<dyn WorkspaceReadExecutor> = Arc::new(BlockingWorkspaceRead {
            entered: Mutex::new(Some(entered_tx)),
        });
        let (mut runtime, mut events) = CoreRuntime::new_with_workspace(
            core,
            Arc::new(provider),
            "fixture-model".to_string(),
            Some(tool),
            None,
        );
        let TurnStartOutcome::Accepted { turn_id } = runtime
            .start_text_turn(
                CoreRequestId::new(2),
                thread_id.clone(),
                Some("Read it".to_string()),
            )
            .expect("start tool turn")
        else {
            panic!("asynchronous turn");
        };
        loop {
            let event = events.recv().await.expect("tool call event");
            if matches!(
                event.kind,
                CoreEventKind::ItemCompleted {
                    item: CoreItemSnapshot {
                        kind: CoreItemKind::ToolCall { .. },
                        ..
                    },
                    ..
                }
            ) {
                break;
            }
        }
        entered_rx.await.expect("tool execution entered");
        assert_eq!(
            runtime
                .interrupt_turn(&thread_id, &turn_id)
                .expect("interrupt"),
            TurnInterruptOutcome::Accepted
        );
        loop {
            let event = events.recv().await.expect("terminal event");
            if matches!(event.kind, CoreEventKind::TurnInterrupted { .. }) {
                break;
            }
        }
        let snapshot = runtime.resume_thread(&thread_id).expect("resume");
        let turn = snapshot
            .turns
            .iter()
            .find(|turn| turn.id == turn_id)
            .expect("persisted turn");
        assert_eq!(turn.status, DurableTurnStatus::Interrupted);
        assert!(matches!(
            turn.items.last(),
            Some(sugarcode_state::DurableItemSnapshot::ToolCall { .. })
        ));
        assert!(!turn.items.iter().any(|item| matches!(
            item,
            sugarcode_state::DurableItemSnapshot::ToolResult { .. }
        )));
    }

    #[tokio::test]
    async fn interrupt_during_second_round_keeps_durable_tool_result_for_audit_only() {
        let directory = tempfile::tempdir().expect("workspace");
        std::fs::write(directory.path().join("README.txt"), "bounded context")
            .expect("workspace fixture");
        let (second_entered_tx, second_entered_rx) = oneshot::channel();
        let provider = BlockingSecondRoundProvider {
            calls: AtomicUsize::new(0),
            second_entered: Mutex::new(Some(second_entered_tx)),
        };
        let mut core = Core::new();
        let started = core
            .start_thread(CoreRequestId::new(1))
            .expect("start thread");
        let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
            panic!("thread event");
        };
        let tool = Arc::new(WorkspaceTool::open(directory.path()).expect("workspace tool"));
        let (mut runtime, mut events) = CoreRuntime::new_with_workspace(
            core,
            Arc::new(provider),
            "fixture-model".to_string(),
            Some(tool),
            None,
        );
        let TurnStartOutcome::Accepted { turn_id } = runtime
            .start_text_turn(
                CoreRequestId::new(2),
                thread_id.clone(),
                Some("Read it".to_string()),
            )
            .expect("start tool turn")
        else {
            panic!("asynchronous turn");
        };
        second_entered_rx.await.expect("second round entered");
        assert_eq!(
            runtime
                .interrupt_turn(&thread_id, &turn_id)
                .expect("interrupt"),
            TurnInterruptOutcome::Accepted
        );
        while !matches!(
            events.recv().await.expect("terminal event").kind,
            CoreEventKind::TurnInterrupted { .. }
        ) {}
        let snapshot = runtime.resume_thread(&thread_id).expect("resume");
        let turn = snapshot
            .turns
            .iter()
            .find(|turn| turn.id == turn_id)
            .expect("persisted turn");
        assert_eq!(turn.status, DurableTurnStatus::Interrupted);
        assert!(turn.items.iter().any(|item| matches!(
            item,
            sugarcode_state::DurableItemSnapshot::ToolResult { .. }
        )));
    }

    #[tokio::test]
    async fn output_limit_fails_once_without_committing_the_oversized_delta() {
        let oversized = "x".repeat(crate::thread::MAX_AGENT_MESSAGE_BYTES + 1);
        let (mut runtime, mut events, thread_id) = runtime(RecordedProvider {
            events: vec![
                Ok(ModelEvent::TextDelta(oversized)),
                Ok(ModelEvent::Completed),
            ],
            stay_open: false,
        });
        let TurnStartOutcome::Accepted { turn_id } = runtime
            .start_text_turn(
                CoreRequestId::new(2),
                thread_id.clone(),
                Some("Hello".to_string()),
            )
            .expect("start text turn")
        else {
            panic!("asynchronous turn");
        };

        let mut lifecycle = Vec::new();
        while lifecycle
            .last()
            .is_none_or(|event: &CoreEvent| !matches!(event.kind, CoreEventKind::TurnFailed { .. }))
        {
            lifecycle.push(events.recv().await.expect("core event"));
        }
        assert!(
            !lifecycle
                .iter()
                .any(|event| matches!(event.kind, CoreEventKind::AgentMessageDelta { .. }))
        );
        let CoreEventKind::TurnFailed { error, .. } =
            lifecycle.last().expect("failed terminal").kind.clone()
        else {
            panic!("failed terminal");
        };
        assert_eq!(error.kind, CoreTurnErrorKind::OutputTooLarge);
        assert!(!error.retryable);

        let snapshot = runtime.resume_thread(&thread_id).expect("resume");
        let turn = snapshot
            .turns
            .iter()
            .find(|turn| turn.id == turn_id)
            .expect("persisted turn");
        assert_eq!(turn.status, DurableTurnStatus::Failed);
        assert_eq!(
            turn.error.as_ref().map(|error| error.kind),
            Some(DurableTurnErrorKind::OutputTooLarge)
        );
        assert!(matches!(
            turn.items.last(),
            Some(sugarcode_state::DurableItemSnapshot::AgentMessage { text, .. })
                if text.is_empty()
        ));
    }

    #[tokio::test]
    async fn interrupt_cancels_a_pending_stream_and_emits_one_interrupted_terminal() {
        let (mut runtime, mut events, thread_id) = runtime(RecordedProvider {
            events: vec![Ok(ModelEvent::TextDelta("partial".to_string()))],
            stay_open: true,
        });
        let TurnStartOutcome::Accepted { turn_id } = runtime
            .start_text_turn(
                CoreRequestId::new(2),
                thread_id.clone(),
                Some("Hello".to_string()),
            )
            .expect("start text turn")
        else {
            panic!("asynchronous turn");
        };
        loop {
            let event = events.recv().await.expect("pre-interrupt event");
            if matches!(event.kind, CoreEventKind::AgentMessageDelta { .. }) {
                break;
            }
        }
        assert_eq!(
            runtime
                .interrupt_turn(&thread_id, &turn_id)
                .expect("interrupt"),
            TurnInterruptOutcome::Accepted
        );

        let mut terminals = Vec::new();
        while terminals.last().is_none_or(|event: &CoreEvent| {
            !matches!(event.kind, CoreEventKind::TurnInterrupted { .. })
        }) {
            terminals.push(events.recv().await.expect("terminal event"));
        }
        assert_eq!(
            terminals
                .iter()
                .filter(|event| matches!(event.kind, CoreEventKind::ItemCompleted { .. }))
                .count(),
            1
        );
        assert_eq!(
            terminals
                .iter()
                .filter(|event| matches!(event.kind, CoreEventKind::TurnInterrupted { .. }))
                .count(),
            1
        );
        assert_eq!(
            runtime
                .interrupt_turn(&thread_id, &turn_id)
                .expect("terminal interrupt is idempotent"),
            TurnInterruptOutcome::AlreadyTerminal
        );
        let snapshot = runtime.resume_thread(&thread_id).expect("resume");
        assert_eq!(
            snapshot
                .turns
                .iter()
                .find(|turn| turn.id == turn_id)
                .expect("persisted turn")
                .status,
            DurableTurnStatus::Interrupted
        );
    }

    #[tokio::test]
    async fn interrupt_after_durable_agent_start_preserves_one_item_lifecycle_and_terminal() {
        let (mut runtime, mut events, thread_id) = runtime(RecordedProvider {
            events: vec![Ok(ModelEvent::TextDelta("partial".to_string()))],
            stay_open: true,
        });
        for _ in 0..CORE_EVENT_CAPACITY - 3 {
            runtime
                .event_tx
                .send(CoreEvent {
                    request_id: CoreRequestId::new(999),
                    kind: CoreEventKind::RuntimeFailed,
                })
                .await
                .expect("seed event queue");
        }
        let TurnStartOutcome::Accepted { turn_id } = runtime
            .start_text_turn(
                CoreRequestId::new(2),
                thread_id.clone(),
                Some("Hello".to_string()),
            )
            .expect("start text turn")
        else {
            panic!("asynchronous turn");
        };

        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let snapshot = runtime.resume_thread(&thread_id).expect("resume");
                let turn = snapshot
                    .turns
                    .iter()
                    .find(|turn| turn.id == turn_id)
                    .expect("persisted turn");
                if turn.items.iter().any(|item| {
                    matches!(
                        item,
                        sugarcode_state::DurableItemSnapshot::AgentMessage { .. }
                    )
                }) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("durable agent item");
        assert_eq!(
            runtime
                .interrupt_turn(&thread_id, &turn_id)
                .expect("interrupt"),
            TurnInterruptOutcome::Accepted
        );

        let mut lifecycle = Vec::new();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let event = events.recv().await.expect("terminal event");
                if event.request_id == CoreRequestId::new(2) {
                    let interrupted = matches!(event.kind, CoreEventKind::TurnInterrupted { .. });
                    lifecycle.push(event);
                    if interrupted {
                        break;
                    }
                }
            }
        })
        .await
        .expect("interrupted lifecycle");
        assert_eq!(
            lifecycle
                .iter()
                .filter(|event| matches!(
                    event.kind,
                    CoreEventKind::ItemStarted {
                        item: CoreItemSnapshot {
                            kind: CoreItemKind::AgentMessage { .. },
                            ..
                        },
                        ..
                    }
                ))
                .count(),
            1
        );
        assert_eq!(
            lifecycle
                .iter()
                .filter(|event| matches!(
                    event.kind,
                    CoreEventKind::ItemCompleted {
                        item: CoreItemSnapshot {
                            kind: CoreItemKind::AgentMessage { .. },
                            ..
                        },
                        ..
                    }
                ))
                .count(),
            1
        );
        assert_eq!(
            lifecycle
                .iter()
                .filter(|event| matches!(event.kind, CoreEventKind::TurnInterrupted { .. }))
                .count(),
            1
        );
        let snapshot = runtime.resume_thread(&thread_id).expect("resume");
        let turn = snapshot
            .turns
            .iter()
            .find(|turn| turn.id == turn_id)
            .expect("persisted turn");
        assert_eq!(turn.status, DurableTurnStatus::Interrupted);
        assert_eq!(
            turn.items
                .iter()
                .filter(|item| matches!(
                    item,
                    sugarcode_state::DurableItemSnapshot::AgentMessage { .. }
                ))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn active_turn_rejects_thread_lifecycle_and_fork_until_terminal() {
        let (mut runtime, mut events, thread_id) = runtime(RecordedProvider {
            events: vec![Ok(ModelEvent::TextDelta("partial".to_string()))],
            stay_open: true,
        });
        let TurnStartOutcome::Accepted { turn_id } = runtime
            .start_text_turn(
                CoreRequestId::new(2),
                thread_id.clone(),
                Some("Hello".to_string()),
            )
            .expect("start text turn")
        else {
            panic!("asynchronous turn");
        };
        loop {
            if matches!(
                events.recv().await.expect("pre-lifecycle event").kind,
                CoreEventKind::AgentMessageDelta { .. }
            ) {
                break;
            }
        }

        for error in [
            runtime.archive_thread(&thread_id).expect_err("archive"),
            runtime.delete_thread(&thread_id).expect_err("delete"),
            runtime.fork_thread(&thread_id).expect_err("fork"),
        ] {
            assert!(matches!(
                error,
                CoreError::TurnAlreadyActive {
                    thread_id: ref active_thread,
                    turn_id: ref active_turn,
                } if active_thread == &thread_id && active_turn == &turn_id
            ));
        }

        assert_eq!(
            runtime
                .interrupt_turn(&thread_id, &turn_id)
                .expect("interrupt"),
            TurnInterruptOutcome::Accepted
        );
        loop {
            if matches!(
                events.recv().await.expect("terminal event").kind,
                CoreEventKind::TurnInterrupted { .. }
            ) {
                break;
            }
        }
        runtime.shutdown().await.expect("terminal cleanup");
        runtime
            .archive_thread(&thread_id)
            .expect("archive terminal thread");
    }

    #[tokio::test]
    async fn shutdown_waits_for_active_turn_to_persist_interrupted() {
        let (mut runtime, mut events, thread_id) = runtime(RecordedProvider {
            events: vec![Ok(ModelEvent::TextDelta("partial".to_string()))],
            stay_open: true,
        });
        let TurnStartOutcome::Accepted { turn_id } = runtime
            .start_text_turn(
                CoreRequestId::new(2),
                thread_id.clone(),
                Some("Hello".to_string()),
            )
            .expect("start text turn")
        else {
            panic!("asynchronous turn");
        };
        loop {
            if matches!(
                events.recv().await.expect("pre-shutdown event").kind,
                CoreEventKind::AgentMessageDelta { .. }
            ) {
                break;
            }
        }

        runtime.shutdown().await.expect("graceful shutdown");
        let mut interrupted = false;
        while let Ok(event) = events.try_recv() {
            interrupted |= matches!(event.kind, CoreEventKind::TurnInterrupted { .. });
        }
        assert!(interrupted);
        let snapshot = runtime.resume_thread(&thread_id).expect("resume");
        let turn = snapshot
            .turns
            .iter()
            .find(|turn| turn.id == turn_id)
            .expect("persisted turn");
        assert_eq!(turn.status, DurableTurnStatus::Interrupted);
    }
}
