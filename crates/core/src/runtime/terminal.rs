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
    usage: Option<DurableUsage>,
) {
    match finish(runtime, prepared, DurableTurnStatus::Completed, None, usage) {
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
    usage: Option<DurableUsage>,
) {
    let core_error = map_model_error(error);
    let durable_error = map_durable_error(core_error.clone());
    if let Ok(item) = finish(
        runtime,
        prepared,
        DurableTurnStatus::Failed,
        Some(durable_error),
        usage,
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
    usage: Option<DurableUsage>,
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
    usage: Option<DurableUsage>,
) -> Result<Option<CoreItemSnapshot>, CoreError> {
    finish(
        runtime,
        prepared,
        DurableTurnStatus::Interrupted,
        None,
        usage,
    )
}

pub(super) async fn finish_state_unavailable_and_emit(
    runtime: &CoreRuntime,
    prepared: &crate::PreparedTextTurn,
) {
    let error = CoreTurnError {
        kind: CoreTurnErrorKind::StateUnavailable,
        retryable: false,
        provider: None,
        protocol: None,
        tool_schema: None,
    };
    if let Ok(item) = finish(
        runtime,
        prepared,
        DurableTurnStatus::Failed,
        Some(map_durable_error(error.clone())),
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
    let provider = error
        .http_status()
        .map(|http_status| CoreProviderErrorMetadata {
            http_status,
            code: error.provider_code().map(ToOwned::to_owned),
            request_id: error.provider_request_id().map(ToOwned::to_owned),
            retry_after: error.retry_after().map(ToOwned::to_owned),
        });
    let tool_schema = error
        .tool_name()
        .zip(error.schema_reason())
        .map(|(tool_name, reason)| CoreToolSchemaError {
            tool_name: tool_name.to_owned(),
            reason: reason.to_owned(),
        });
    let protocol = error
        .protocol_diagnostic()
        .map(|diagnostic| CoreModelProtocolDiagnostic {
            stage: map_protocol_stage(diagnostic.stage()),
            code: map_protocol_code(diagnostic.code()),
            event_type: diagnostic.event_type().map(ToOwned::to_owned),
            shape_sha256: diagnostic.shape_sha256().to_owned(),
        });
    CoreTurnError {
        kind: match error.kind() {
            ModelErrorKind::Authentication => CoreTurnErrorKind::Authentication,
            ModelErrorKind::ContextLengthExceeded => CoreTurnErrorKind::ContextWindowExceeded,
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
            ModelErrorKind::UnsupportedToolArguments => CoreTurnErrorKind::UnsupportedToolArguments,
            ModelErrorKind::ProviderRequestTooLarge => CoreTurnErrorKind::ProviderRequestTooLarge,
            ModelErrorKind::ProviderResponseTooLarge => CoreTurnErrorKind::ProviderResponseTooLarge,
            ModelErrorKind::OutputTooLarge => CoreTurnErrorKind::OutputTooLarge,
        },
        retryable: error.retryable(),
        provider,
        protocol,
        tool_schema,
    }
}

fn map_durable_error(error: CoreTurnError) -> DurableTurnError {
    let CoreTurnError {
        kind,
        retryable,
        provider,
        protocol,
        tool_schema,
    } = error;
    DurableTurnError {
        kind: match kind {
            CoreTurnErrorKind::Authentication => DurableTurnErrorKind::Authentication,
            CoreTurnErrorKind::ContextWindowExceeded => DurableTurnErrorKind::ContextWindowExceeded,
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
            CoreTurnErrorKind::UnsupportedToolArguments => {
                DurableTurnErrorKind::UnsupportedToolArguments
            }
            CoreTurnErrorKind::ProviderRequestTooLarge => {
                DurableTurnErrorKind::ProviderRequestTooLarge
            }
            CoreTurnErrorKind::ProviderResponseTooLarge => {
                DurableTurnErrorKind::ProviderResponseTooLarge
            }
            CoreTurnErrorKind::OutputTooLarge => DurableTurnErrorKind::OutputTooLarge,
            CoreTurnErrorKind::StateUnavailable => DurableTurnErrorKind::StateUnavailable,
        },
        retryable,
        provider: provider.map(|provider| DurableProviderErrorMetadata {
            http_status: provider.http_status,
            code: provider.code,
            request_id: provider.request_id,
            retry_after: provider.retry_after,
        }),
        protocol: protocol.map(|diagnostic| DurableModelProtocolDiagnostic {
            stage: match diagnostic.stage {
                CoreModelProtocolStage::StreamEvent => DurableModelProtocolStage::StreamEvent,
                CoreModelProtocolStage::ResponseAssembly => {
                    DurableModelProtocolStage::ResponseAssembly
                }
                CoreModelProtocolStage::OutputNormalization => {
                    DurableModelProtocolStage::OutputNormalization
                }
                CoreModelProtocolStage::RuntimeClassification => {
                    DurableModelProtocolStage::RuntimeClassification
                }
            },
            code: match diagnostic.code {
                CoreModelProtocolCode::WireMismatch => DurableModelProtocolCode::WireMismatch,
                CoreModelProtocolCode::InvalidEventShape => {
                    DurableModelProtocolCode::InvalidEventShape
                }
                CoreModelProtocolCode::AmbiguousOutputReconciliation => {
                    DurableModelProtocolCode::AmbiguousOutputReconciliation
                }
                CoreModelProtocolCode::MalformedToolCall => {
                    DurableModelProtocolCode::MalformedToolCall
                }
                CoreModelProtocolCode::TerminalLifecycleViolation => {
                    DurableModelProtocolCode::TerminalLifecycleViolation
                }
                CoreModelProtocolCode::ContinuationOutputMismatch => {
                    DurableModelProtocolCode::ContinuationOutputMismatch
                }
                CoreModelProtocolCode::OutputIndexMismatch => {
                    DurableModelProtocolCode::OutputIndexMismatch
                }
            },
            event_type: diagnostic.event_type,
            shape_sha256: diagnostic.shape_sha256,
        }),
        tool_schema: tool_schema.map(|error| DurableToolSchemaError {
            tool_name: error.tool_name,
            reason: error.reason,
        }),
    }
}

fn map_protocol_stage(stage: ModelProtocolStage) -> CoreModelProtocolStage {
    match stage {
        ModelProtocolStage::StreamEvent => CoreModelProtocolStage::StreamEvent,
        ModelProtocolStage::ResponseAssembly => CoreModelProtocolStage::ResponseAssembly,
        ModelProtocolStage::OutputNormalization => CoreModelProtocolStage::OutputNormalization,
        ModelProtocolStage::RuntimeClassification => CoreModelProtocolStage::RuntimeClassification,
    }
}

fn map_protocol_code(code: ModelProtocolCode) -> CoreModelProtocolCode {
    match code {
        ModelProtocolCode::WireMismatch => CoreModelProtocolCode::WireMismatch,
        ModelProtocolCode::InvalidEventShape => CoreModelProtocolCode::InvalidEventShape,
        ModelProtocolCode::AmbiguousOutputReconciliation => {
            CoreModelProtocolCode::AmbiguousOutputReconciliation
        }
        ModelProtocolCode::MalformedToolCall => CoreModelProtocolCode::MalformedToolCall,
        ModelProtocolCode::TerminalLifecycleViolation => {
            CoreModelProtocolCode::TerminalLifecycleViolation
        }
        ModelProtocolCode::ContinuationOutputMismatch => {
            CoreModelProtocolCode::ContinuationOutputMismatch
        }
        ModelProtocolCode::OutputIndexMismatch => CoreModelProtocolCode::OutputIndexMismatch,
    }
}
