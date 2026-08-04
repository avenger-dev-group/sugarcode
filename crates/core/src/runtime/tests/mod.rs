use super::*;
use futures_util::FutureExt;
use futures_util::StreamExt;
use futures_util::stream;
use std::collections::VecDeque;
use std::sync::atomic::AtomicUsize;
use sugarcode_model_provider::BoxModelFuture;
use sugarcode_model_provider::ModelTerminalMetadata;
use sugarcode_tools::WorkspaceTool;
use tokio::sync::oneshot;

mod model_event {
    use super::*;

    pub const COMPLETED: ModelEvent = ModelEvent::ResponseCompleted(ModelResponse {
        output: Vec::new(),
        usage: None,
        terminal: ModelTerminalMetadata {
            finish_reason: ModelFinishReason::Stop,
            provider_request_id: None,
            continuation: ModelContinuation::Complete,
        },
        provider_context: None,
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
            terminal: ModelTerminalMetadata::completed(ModelContinuation::Complete),
            provider_context: None,
        })
    }

    pub fn tool_call(call: ModelToolCall) -> ModelEvent {
        ModelEvent::ResponseCompleted(ModelResponse {
            output: vec![sugarcode_model_provider::ModelOutputItem {
                output_index: 0,
                kind: ModelOutputItemKind::ToolCall(call),
            }],
            usage: None,
            terminal: ModelTerminalMetadata::completed(ModelContinuation::ToolCalls),
            provider_context: None,
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
            terminal: ModelTerminalMetadata::completed(ModelContinuation::ToolCalls),
            provider_context: None,
        })
    }

    pub fn usage(usage: ModelUsage) -> ModelEvent {
        ModelEvent::ResponseCompleted(ModelResponse {
            output: Vec::new(),
            usage: Some(usage),
            terminal: ModelTerminalMetadata::completed(ModelContinuation::Complete),
            provider_context: None,
        })
    }
}

fn message_texts(message: &ModelMessage) -> Vec<&str> {
    message
        .content
        .iter()
        .filter_map(|part| match part {
            ModelContentPart::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn message_tool_calls(message: &ModelMessage) -> Vec<&ModelToolCall> {
    message
        .content
        .iter()
        .filter_map(|part| match part {
            ModelContentPart::ToolCall { call } => Some(call),
            _ => None,
        })
        .collect()
}

fn message_tool_results(message: &ModelMessage) -> Vec<&ModelToolResult> {
    message
        .content
        .iter()
        .filter_map(|part| match part {
            ModelContentPart::ToolResult { result } => Some(result),
            _ => None,
        })
        .collect()
}

fn tool_result_serialized(result: &ModelToolResult) -> String {
    match &result.content {
        ModelToolResultContent::Json(value) => value.to_string(),
        ModelToolResultContent::Text(text) => text.clone(),
        ModelToolResultContent::Error { kind, message } => {
            serde_json::json!({"error": {"kind": kind, "message": message}}).to_string()
        }
    }
}

fn message_compaction(message: &ModelMessage) -> Option<&str> {
    message.content.iter().find_map(|part| match part {
        ModelContentPart::ContextCompaction { content } => Some(content.as_str()),
        _ => None,
    })
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
                        terminal: ModelTerminalMetadata::completed(ModelContinuation::Complete),
                        provider_context: None,
                    })));
                } else {
                    normalized.push(Ok(ModelEvent::ResponseCompleted(ModelResponse {
                        output: Vec::new(),
                        usage: usage.take(),
                        terminal: ModelTerminalMetadata::completed(ModelContinuation::Complete),
                        provider_context: None,
                    })));
                }
            }
            Ok(ModelEvent::ResponseCompleted(completed)) => {
                if let Some(previous) = response.replace(completed) {
                    normalized.push(Ok(ModelEvent::ResponseCompleted(previous)));
                }
            }
            Ok(ModelEvent::Warning { code }) => {
                normalized.push(Ok(ModelEvent::Warning { code }));
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
fn model_capabilities_derive_token_reserves() {
    let default = ModelCapabilities::new(131_072, true, true, true, true, true);
    assert_eq!(default.output_reserve_tokens, 16_384);
    assert_eq!(default.input_compaction_target_tokens(), 114_688);
    assert_eq!(default.input_compaction_target_bytes(), 344_064);
    assert_eq!(default.active_turn_compaction_target_tokens(), 98_304);

    let small = ModelCapabilities::new(8_192, true, false, false, true, false);
    assert_eq!(small.output_reserve_tokens, 4_096);
    assert_eq!(small.input_compaction_target_tokens(), 4_096);
    assert_eq!(small.active_turn_compaction_target_tokens(), 2_048);
}

#[test]
fn active_turn_checkpoint_preserves_the_original_user_task() {
    let messages = vec![
        ModelMessage::context_compaction("older history".to_string()),
        ModelMessage::user_text(
            "Fix the sidebar, then run the focused tests before replying.".to_string(),
        ),
        ModelMessage::tool_calls(vec![ModelToolCall {
            id: "call_1".to_string(),
            name: "workspace/read".to_string(),
            arguments: serde_json::json!({"path": "sidebar.tsx"}),
        }]),
        ModelMessage::tool_results(vec![ModelToolResult::from_serialized(
            "call_1".to_string(),
            "read complete".to_string(),
        )]),
    ];

    let anchor = active_turn_task_anchor(&messages).expect("task anchor");
    let checkpoint = active_turn_checkpoint(
        "The sidebar source was inspected. The edit and tests remain.",
        Some(&anchor),
    );

    assert!(checkpoint.contains("Fix the sidebar"));
    assert!(checkpoint.contains("The edit and tests remain"));
    assert!(checkpoint.contains("Continue executing the same user task"));
    assert!(checkpoint.len() <= MAX_ACTIVE_TURN_COMPACTION_BYTES);
}

#[test]
fn active_turn_task_anchor_is_utf8_safe_and_bounded() {
    let task = format!("开始目标：{}：验收标准", "修复上下文连续性".repeat(1_000));
    let messages = vec![ModelMessage::user_text(task)];

    let anchor = active_turn_task_anchor(&messages).expect("task anchor");

    assert!(anchor.len() <= MAX_ACTIVE_TURN_TASK_ANCHOR_BYTES);
    assert!(anchor.starts_with("# Active user task anchor"));
    assert!(anchor.contains("middle omitted by context compaction"));
    assert!(anchor.ends_with("：验收标准"));
}

mod agent_instructions;
mod collaboration;
mod interruption;
mod lifecycle;
mod mcp_tools;
mod shell_approval;
mod thread_title;
mod workspace_instructions;
mod workspace_patch;
mod workspace_search;
mod workspace_skills;
mod workspace_tools;
