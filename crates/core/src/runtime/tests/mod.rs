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
    let (runtime, events) = CoreRuntime::new(core, Arc::new(provider), "fixture-model".to_string());
    (runtime, events, thread_id)
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
