use crate::Core;
use crate::CoreApi;
use crate::CoreError;
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
use sugarcode_model_provider::ModelUsage;
use sugarcode_protocol::CoreEvent;
use sugarcode_protocol::CoreEventKind;
use sugarcode_protocol::CoreItemSnapshot;
use sugarcode_protocol::CoreRequestId;
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
use tokio::sync::Notify;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const CORE_EVENT_CAPACITY: usize = 64;

#[derive(Clone)]
pub struct CoreRuntime {
    core: Arc<Mutex<Core>>,
    model_gateway: Option<ModelGateway>,
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
        let (event_tx, event_rx) = mpsc::channel(CORE_EVENT_CAPACITY);
        (
            Self {
                core: Arc::new(Mutex::new(core)),
                model_gateway: Some(ModelGateway {
                    provider,
                    model: Arc::from(model),
                }),
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
    let agent_item = prepared.agent_item.clone();
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
    opening.push(CoreEventKind::ItemStarted {
        thread_id: thread_id.clone(),
        turn_id: turn_id.clone(),
        item: agent_item.clone(),
    });
    for kind in opening {
        if runtime
            .event_tx
            .send(CoreEvent { request_id, kind })
            .await
            .is_err()
        {
            finish_interrupted(&runtime, &prepared, None).await;
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
    let request = ModelRequest {
        model: model_gateway.model.to_string(),
        messages: prepared
            .history
            .iter()
            .map(|message| ModelMessage {
                role: match message.role {
                    PreparedMessageRole::User => ModelRole::User,
                    PreparedMessageRole::Assistant => ModelRole::Assistant,
                },
                text: message.text.clone(),
            })
            .collect(),
    };
    let stream = tokio::select! {
        biased;
        _ = cancellation.cancelled() => {
            finish_interrupted_and_emit(&runtime, &prepared, None).await;
            clear_active(&runtime, &thread_id, &turn_id);
            return;
        }
        result = model_gateway.provider.stream(request) => result,
    };
    let mut stream = match stream {
        Ok(stream) => stream,
        Err(error) => {
            match claim_terminal(&terminal_state, Terminal::Failed(error)) {
                Terminal::Failed(error) => {
                    finish_failed_and_emit(&runtime, &prepared, error, None).await;
                }
                Terminal::Interrupted => {
                    finish_interrupted_and_emit(&runtime, &prepared, None).await;
                }
                Terminal::Completed | Terminal::StateUnavailable => unreachable!(),
            }
            clear_active(&runtime, &thread_id, &turn_id);
            return;
        }
    };
    let mut usage = None;
    let terminal = loop {
        let next = tokio::select! {
            biased;
            _ = cancellation.cancelled() => break Terminal::Interrupted,
            next = stream.next() => next,
        };
        match next {
            Some(Ok(ModelEvent::TextDelta(delta))) if !delta.is_empty() => {
                let phase = match terminal_state.lock() {
                    Ok(phase) if *phase == TurnPhase::Running => phase,
                    Ok(_) => break Terminal::Interrupted,
                    Err(_) => break Terminal::StateUnavailable,
                };
                let snapshot = match runtime
                    .lock_core()
                    .and_then(|mut core| core.append_text_delta(&thread_id, &turn_id, &delta))
                {
                    Ok(snapshot) => snapshot,
                    Err(CoreError::OutputTooLarge) => {
                        break Terminal::Failed(ModelError::new(
                            ModelErrorKind::OutputTooLarge,
                            false,
                        ));
                    }
                    Err(_) => break Terminal::StateUnavailable,
                };
                drop(phase);
                let _ = snapshot;
                if !send_event(
                    &runtime,
                    &cancellation,
                    request_id,
                    CoreEventKind::AgentMessageDelta {
                        thread_id: thread_id.clone(),
                        turn_id: turn_id.clone(),
                        item_id: agent_item.id.clone(),
                        delta,
                    },
                )
                .await
                {
                    break Terminal::Interrupted;
                }
            }
            Some(Ok(ModelEvent::TextDelta(_))) => {}
            Some(Ok(ModelEvent::Usage(value))) => usage = Some(value),
            Some(Ok(ModelEvent::Completed)) => break Terminal::Completed,
            Some(Err(error)) => break Terminal::Failed(error),
            None => {
                break Terminal::Failed(ModelError::new(ModelErrorKind::Disconnected, true));
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
    if let Some(item) = finish_interrupted(runtime, prepared, usage).await {
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
) -> Option<CoreItemSnapshot> {
    finish(
        runtime,
        prepared,
        DurableTurnStatus::Interrupted,
        None,
        usage.map(map_usage),
    )
    .ok()
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
) -> Result<CoreItemSnapshot, CoreError> {
    runtime.lock_core()?.finish_text_turn(
        &prepared.thread_id,
        &prepared.turn_id,
        status,
        error,
        usage,
    )
}

async fn emit_terminal(
    runtime: &CoreRuntime,
    prepared: &crate::PreparedTextTurn,
    item: CoreItemSnapshot,
    terminal: CoreEventKind,
) {
    let cancellation = CancellationToken::new();
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
    use sugarcode_model_provider::BoxModelFuture;

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
