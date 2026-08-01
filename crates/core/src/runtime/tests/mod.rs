use super::*;
use futures_util::FutureExt;
use futures_util::StreamExt;
use futures_util::stream;
use std::collections::VecDeque;
use std::sync::atomic::AtomicUsize;
use sugarcode_model_provider::BoxModelFuture;
use sugarcode_tools::WorkspaceTool;
use tokio::sync::oneshot;

mod model_event {
    use super::*;

    pub const COMPLETED: ModelEvent = ModelEvent::ResponseCompleted(ModelResponse {
        output: Vec::new(),
        usage: None,
    });

    pub fn text_delta(delta: String) -> ModelEvent {
        ModelEvent::OutputTextDelta {
            output_index: 0,
            delta,
        }
    }

    pub fn commentary(text: String) -> ModelEvent {
        text_delta(text)
    }

    pub fn final_response(text: impl Into<String>) -> ModelEvent {
        ModelEvent::ResponseCompleted(ModelResponse {
            output: vec![sugarcode_model_provider::ModelOutputItem {
                output_index: 0,
                kind: ModelOutputItemKind::AssistantText {
                    phase: ModelTextPhase::Final,
                    text: text.into(),
                },
            }],
            usage: None,
        })
    }

    pub fn tool_call(call: ModelToolCall) -> ModelEvent {
        ModelEvent::ResponseCompleted(ModelResponse {
            output: vec![sugarcode_model_provider::ModelOutputItem {
                output_index: 0,
                kind: ModelOutputItemKind::ToolCall(call),
            }],
            usage: None,
        })
    }

    pub fn tool_call_batch(calls: Vec<ModelToolCall>) -> ModelEvent {
        ModelEvent::ResponseCompleted(ModelResponse {
            output: calls
                .into_iter()
                .enumerate()
                .map(|(index, call)| sugarcode_model_provider::ModelOutputItem {
                    output_index: u32::try_from(index).expect("test output index"),
                    kind: ModelOutputItemKind::ToolCall(call),
                })
                .collect(),
            usage: None,
        })
    }

    pub fn usage(usage: ModelUsage) -> ModelEvent {
        ModelEvent::ResponseCompleted(ModelResponse {
            output: Vec::new(),
            usage: Some(usage),
        })
    }
}

fn normalize_model_events(
    events: Vec<Result<ModelEvent, ModelError>>,
) -> Vec<Result<ModelEvent, ModelError>> {
    let mut normalized = Vec::with_capacity(events.len());
    let mut preview = String::new();
    let mut response = None::<ModelResponse>;
    let mut usage = None;
    for event in events {
        match event {
            Ok(ModelEvent::OutputTextDelta {
                output_index,
                delta,
            }) => {
                if output_index == 0 {
                    preview.push_str(&delta);
                }
                normalized.push(Ok(ModelEvent::OutputTextDelta {
                    output_index,
                    delta,
                }));
            }
            Ok(ModelEvent::ResponseCompleted(mut completed)) if completed.output.is_empty() => {
                if let Some(value) = completed.usage.take() {
                    usage = Some(value);
                    continue;
                }
                if let Some(mut pending) = response.take() {
                    if !preview.is_empty() {
                        for item in &mut pending.output {
                            item.output_index += 1;
                        }
                        pending.output.insert(
                            0,
                            sugarcode_model_provider::ModelOutputItem {
                                output_index: 0,
                                kind: ModelOutputItemKind::AssistantText {
                                    phase: ModelTextPhase::Commentary,
                                    text: std::mem::take(&mut preview),
                                },
                            },
                        );
                    }
                    pending.usage = usage.take();
                    normalized.push(Ok(ModelEvent::ResponseCompleted(pending)));
                } else if !preview.is_empty() {
                    normalized.push(Ok(ModelEvent::ResponseCompleted(ModelResponse {
                        output: vec![sugarcode_model_provider::ModelOutputItem {
                            output_index: 0,
                            kind: ModelOutputItemKind::AssistantText {
                                phase: ModelTextPhase::Final,
                                text: std::mem::take(&mut preview),
                            },
                        }],
                        usage: usage.take(),
                    })));
                } else {
                    normalized.push(Ok(ModelEvent::ResponseCompleted(ModelResponse {
                        output: Vec::new(),
                        usage: usage.take(),
                    })));
                }
            }
            Ok(ModelEvent::ResponseCompleted(completed)) => {
                if let Some(previous) = response.replace(completed) {
                    normalized.push(Ok(ModelEvent::ResponseCompleted(previous)));
                }
            }
            Err(error) => normalized.push(Err(error)),
        }
    }
    if let Some(mut pending) = response {
        if !preview.is_empty() {
            for item in &mut pending.output {
                item.output_index += 1;
            }
            pending.output.insert(
                0,
                sugarcode_model_provider::ModelOutputItem {
                    output_index: 0,
                    kind: ModelOutputItemKind::AssistantText {
                        phase: ModelTextPhase::Commentary,
                        text: preview,
                    },
                },
            );
        }
        pending.usage = usage;
        normalized.push(Ok(ModelEvent::ResponseCompleted(pending)));
    }
    normalized
}

#[derive(Debug)]
struct RecordedProvider {
    events: Vec<Result<ModelEvent, ModelError>>,
    stay_open: bool,
}

impl ModelProvider for RecordedProvider {
    fn stream(&self, _request: ModelRequest) -> BoxModelFuture<'_> {
        let events = normalize_model_events(self.events.clone());
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
        let events = normalize_model_events(
            self.rounds
                .lock()
                .expect("rounds")
                .pop_front()
                .expect("recorded round"),
        );
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
                Ok(stream::iter(vec![Ok(model_event::tool_call(ModelToolCall {
                    id: "call_second_round".to_string(),
                    name: "workspace/read".to_string(),
                    arguments: serde_json::json!({ "path": "README.txt" }),
                }))])
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
    let (runtime, events) = CoreRuntime::new(core, Arc::new(provider), "fixture-model".to_string());
    (runtime, events, thread_id)
}

#[test]
fn model_capabilities_derive_context_reserve_and_absolute_byte_cap() {
    let default = ModelCapabilities::new(131_072, true, true);
    assert_eq!(default.output_reserve_tokens, 16_384);
    assert_eq!(default.input_compaction_target_tokens(), 114_688);
    assert_eq!(default.input_compaction_target_bytes(), 344_064);

    let small = ModelCapabilities::new(8_192, false, false);
    assert_eq!(small.output_reserve_tokens, 4_096);
    assert_eq!(small.input_compaction_target_tokens(), 4_096);

    let maximum = ModelCapabilities::new(2_097_152, false, false);
    assert_eq!(
        maximum.input_compaction_target_bytes(),
        crate::context::MAX_PROVIDER_CONTEXT_BYTES
    );
}

mod agent_instructions;
mod collaboration;
mod interruption;
mod lifecycle;
mod mcp_tools;
mod shell_approval;
mod workspace_instructions;
mod workspace_patch;
mod workspace_search;
mod workspace_skills;
mod workspace_tools;
