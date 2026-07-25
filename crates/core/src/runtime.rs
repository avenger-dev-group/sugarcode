use crate::Core;
use crate::CoreApi;
use crate::CoreError;
use crate::PreparedMessageRole;
use crate::TurnInterruptOutcome;
use crate::TurnStartOutcome;
use futures_util::StreamExt;
use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;
use std::sync::Mutex;
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
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const CORE_EVENT_CAPACITY: usize = 64;

#[derive(Clone)]
pub struct CoreRuntime {
    core: Arc<Mutex<Core>>,
    provider: Arc<dyn ModelProvider>,
    model: Arc<str>,
    event_tx: mpsc::Sender<CoreEvent>,
    active: Arc<Mutex<BTreeMap<ThreadId, ActiveTurn>>>,
}

#[derive(Clone)]
struct ActiveTurn {
    turn_id: TurnId,
    cancellation: CancellationToken,
}

impl fmt::Debug for CoreRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CoreRuntime")
            .field("model", &"<redacted>")
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
                provider,
                model: Arc::from(model),
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
        self.lock_core()?.archive_thread(thread_id)
    }

    fn unarchive_thread(&mut self, thread_id: &ThreadId) -> Result<(), CoreError> {
        self.lock_core()?.unarchive_thread(thread_id)
    }

    fn delete_thread(&mut self, thread_id: &ThreadId) -> Result<(), CoreError> {
        self.lock_core()?.delete_thread(thread_id)
    }

    fn fork_thread(&mut self, thread_id: &ThreadId) -> Result<DurableThreadSnapshot, CoreError> {
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
        input: String,
    ) -> Result<TurnStartOutcome, CoreError> {
        let prepared = self
            .lock_core()?
            .prepare_text_turn(request_id, thread_id.clone(), input)?;
        let cancellation = CancellationToken::new();
        self.active
            .lock()
            .map_err(|_| CoreError::Internal("active turn lock is unavailable".to_string()))?
            .insert(
                thread_id,
                ActiveTurn {
                    turn_id: prepared.turn_id.clone(),
                    cancellation: cancellation.clone(),
                },
            );
        let runtime = self.clone();
        let turn_id = prepared.turn_id.clone();
        tokio::spawn(async move {
            run_turn(runtime, prepared, cancellation).await;
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
        match active.get(thread_id) {
            Some(active) if &active.turn_id == turn_id => {
                active.cancellation.cancel();
                Ok(TurnInterruptOutcome::Accepted)
            }
            Some(_) => Err(CoreError::NoActiveTurn(thread_id.clone())),
            None if self.lock_core()?.contains_turn(thread_id, turn_id) => {
                Ok(TurnInterruptOutcome::AlreadyTerminal)
            }
            None => Err(CoreError::NoActiveTurn(thread_id.clone())),
        }
    }
}

async fn run_turn(
    runtime: CoreRuntime,
    prepared: crate::PreparedTextTurn,
    cancellation: CancellationToken,
) {
    let request_id = prepared.request_id;
    let thread_id = prepared.thread_id.clone();
    let turn_id = prepared.turn_id.clone();
    let agent_item = prepared.agent_item.clone();
    let opening = [
        CoreEventKind::TurnStarted {
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
        },
        CoreEventKind::ItemStarted {
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            item: agent_item.clone(),
        },
    ];
    for kind in opening {
        if runtime
            .event_tx
            .send(CoreEvent { request_id, kind })
            .await
            .is_err()
        {
            finish_interrupted(&runtime, &prepared).await;
            clear_active(&runtime, &thread_id, &turn_id);
            return;
        }
    }

    let request = ModelRequest {
        model: runtime.model.to_string(),
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
            finish_interrupted_and_emit(&runtime, &prepared).await;
            clear_active(&runtime, &thread_id, &turn_id);
            return;
        }
        result = runtime.provider.stream(request) => result,
    };
    let mut stream = match stream {
        Ok(stream) => stream,
        Err(error) => {
            finish_failed_and_emit(&runtime, &prepared, error).await;
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
                break Terminal::Failed(ModelError::new(ModelErrorKind::Transport, true));
            }
        }
    };
    match terminal {
        Terminal::Completed => finish_completed_and_emit(&runtime, &prepared, usage).await,
        Terminal::Failed(error) => finish_failed_and_emit(&runtime, &prepared, error).await,
        Terminal::Interrupted => finish_interrupted_and_emit(&runtime, &prepared).await,
        Terminal::StateUnavailable => {
            finish_state_unavailable_and_emit(&runtime, &prepared).await;
        }
    }
    clear_active(&runtime, &thread_id, &turn_id);
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
        Err(_) => finish_state_unavailable_and_emit(runtime, prepared).await,
    }
}

async fn finish_failed_and_emit(
    runtime: &CoreRuntime,
    prepared: &crate::PreparedTextTurn,
    error: ModelError,
) {
    let core_error = map_model_error(error);
    let durable_error = map_durable_error(core_error);
    if let Ok(item) = finish(
        runtime,
        prepared,
        DurableTurnStatus::Failed,
        Some(durable_error),
        None,
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
    }
}

async fn finish_interrupted_and_emit(runtime: &CoreRuntime, prepared: &crate::PreparedTextTurn) {
    if let Some(item) = finish_interrupted(runtime, prepared).await {
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
    }
}

async fn finish_interrupted(
    runtime: &CoreRuntime,
    prepared: &crate::PreparedTextTurn,
) -> Option<CoreItemSnapshot> {
    finish(
        runtime,
        prepared,
        DurableTurnStatus::Interrupted,
        None,
        None,
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
    }
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
    {
        active.remove(thread_id);
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
                "Hello".to_string(),
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
            1
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
    async fn interrupt_cancels_a_pending_stream_and_emits_one_interrupted_terminal() {
        let (mut runtime, mut events, thread_id) = runtime(RecordedProvider {
            events: vec![Ok(ModelEvent::TextDelta("partial".to_string()))],
            stay_open: true,
        });
        let TurnStartOutcome::Accepted { turn_id } = runtime
            .start_text_turn(
                CoreRequestId::new(2),
                thread_id.clone(),
                "Hello".to_string(),
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
}
