use super::*;

pub(super) fn claim_terminal(terminal_state: &Mutex<TurnPhase>, terminal: Terminal) -> Terminal {
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

pub(super) enum Terminal {
    Completed,
    Failed(ModelError),
    Interrupted,
    StateUnavailable,
}

pub(super) async fn finish_completed_and_emit(
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

pub(super) async fn finish_failed_and_emit(
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

pub(super) async fn finish_interrupted_and_emit(
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

pub(super) async fn finish_interrupted(
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

pub(super) async fn finish_state_unavailable_and_emit(
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

pub(super) async fn send_event(
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

pub(super) fn clear_active(runtime: &CoreRuntime, thread_id: &ThreadId, turn_id: &TurnId) {
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
