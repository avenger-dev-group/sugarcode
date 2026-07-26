use super::*;
use sugarcode_tools::WorkspacePatchExecutor;

struct RecordedPatchExecutor {
    commit_entered: Mutex<Option<oneshot::Sender<()>>>,
    release_commit: Mutex<Option<oneshot::Receiver<()>>>,
}

impl fmt::Debug for RecordedPatchExecutor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RecordedPatchExecutor")
            .finish_non_exhaustive()
    }
}

impl WorkspacePatchExecutor for RecordedPatchExecutor {
    fn prepare<'a>(
        &'a self,
        arguments: &'a sugarcode_tools::WorkspacePatchArguments,
        _cancellation: &'a CancellationToken,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = sugarcode_tools::WorkspacePatchPrepareOutcome>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            sugarcode_tools::WorkspacePatchPrepareOutcome::Prepared(Box::new(
                sugarcode_tools::WorkspacePatchPrepared::recorded(
                    arguments.path.clone(),
                    "--- a/notes.txt\n+++ b/notes.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n".to_string(),
                    sugarcode_tools::WorkspaceNewlineStyle::Lf,
                    true,
                    "a".repeat(64),
                    "b".repeat(64),
                    4,
                    4,
                ),
            ))
        })
    }

    fn commit<'a>(
        &'a self,
        _prepared: sugarcode_tools::WorkspacePatchPrepared,
        cancellation: &'a CancellationToken,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = sugarcode_tools::WorkspacePatchCommitOutcome>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            assert!(
                !cancellation.is_cancelled(),
                "commit barrier token stays live"
            );
            if let Some(entered) = self.commit_entered.lock().expect("entered").take() {
                let _ = entered.send(());
            }
            let release = self
                .release_commit
                .lock()
                .expect("release")
                .take()
                .expect("release receiver");
            let _ = release.await;
            sugarcode_tools::WorkspacePatchCommitOutcome::Applied {
                path: "notes.txt".to_string(),
                before_sha256: "a".repeat(64),
                after_sha256: "b".repeat(64),
                before_bytes: 4,
                after_bytes: 4,
            }
        })
    }
}

#[tokio::test]
async fn workspace_patch_persists_review_before_result_and_finishes_model_round() {
    let directory = tempfile::tempdir().expect("workspace");
    let target = directory.path().join("notes.txt");
    std::fs::write(&target, "one\ntwo\nthree\n").expect("workspace fixture");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([
            vec![
                Ok(ModelEvent::ToolCall(ModelToolCall {
                    id: "call_patch".to_string(),
                    name: "workspace/apply-patch".to_string(),
                    arguments: serde_json::json!({
                        "path": "notes.txt",
                        "patch": "@@ -1,3 +1,3 @@\n one\n-two\n+second\n three\n"
                    }),
                })),
                Ok(ModelEvent::Completed),
            ],
            vec![
                Ok(ModelEvent::TextDelta("Updated it.".to_string())),
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
    let workspace_patch: Arc<dyn WorkspacePatchExecutor> = tool;
    let (runtime, mut events) = CoreRuntime::new_with_workspace(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        None,
        None,
    );
    let mut runtime = runtime.with_workspace_patch(Some(workspace_patch));
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Update the file".to_string()),
        )
        .expect("start tool turn")
    else {
        panic!("asynchronous turn");
    };

    let mut completed_kinds = Vec::new();
    loop {
        let event = events.recv().await.expect("core event");
        if let CoreEventKind::ItemCompleted { item, .. } = &event.kind {
            completed_kinds.push(item.kind.clone());
        }
        if matches!(event.kind, CoreEventKind::TurnCompleted { .. }) {
            break;
        }
    }
    assert!(matches!(
        completed_kinds.as_slice(),
        [
            CoreItemKind::UserMessage { .. },
            CoreItemKind::ToolCall { patch: Some(_), .. },
            CoreItemKind::FileChange { diff, .. },
            CoreItemKind::ToolResult { result: CoreToolResult::Success { .. }, .. },
            CoreItemKind::AgentMessage { .. }
        ] if diff.contains("-two\n+second")
    ));
    assert_eq!(
        std::fs::read_to_string(target).expect("updated file"),
        "one\nsecond\nthree\n"
    );
    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.id == turn_id)
        .expect("persisted patch turn");
    assert!(matches!(
        turn.items.as_slice(),
        [
            sugarcode_state::DurableItemSnapshot::UserMessage { .. },
            sugarcode_state::DurableItemSnapshot::ToolCall { patch: Some(_), .. },
            sugarcode_state::DurableItemSnapshot::FileChange { kind, .. },
            sugarcode_state::DurableItemSnapshot::ToolResult { .. },
            sugarcode_state::DurableItemSnapshot::AgentMessage { .. }
        ] if kind == "update"
    ));
    let requests = requests.lock().expect("requests");
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0]
            .tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        vec!["workspace/apply-patch"]
    );
}

#[tokio::test]
async fn interruption_after_commit_barrier_records_result_before_interrupted_terminal() {
    let provider = RecordedProvider {
        events: vec![
            Ok(ModelEvent::ToolCall(ModelToolCall {
                id: "call_patch".to_string(),
                name: "workspace/apply-patch".to_string(),
                arguments: serde_json::json!({
                    "path": "notes.txt",
                    "patch": "@@ -1,1 +1,1 @@\n-old\n+new\n"
                }),
            })),
            Ok(ModelEvent::Completed),
        ],
        stay_open: false,
    };
    let (entered_tx, entered_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let executor: Arc<dyn WorkspacePatchExecutor> = Arc::new(RecordedPatchExecutor {
        commit_entered: Mutex::new(Some(entered_tx)),
        release_commit: Mutex::new(Some(release_rx)),
    });
    let mut core = Core::new();
    let CoreEventKind::ThreadStarted { thread_id } = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread")
        .kind
    else {
        panic!("thread event");
    };
    let (runtime, mut events) =
        CoreRuntime::new(core, Arc::new(provider), "fixture-model".to_string());
    let mut runtime = runtime.with_workspace_patch(Some(executor));
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Update".to_string()),
        )
        .expect("start turn")
    else {
        panic!("async turn");
    };
    entered_rx.await.expect("commit entered");
    assert_eq!(
        runtime
            .interrupt_turn(&thread_id, &turn_id)
            .expect("interrupt"),
        TurnInterruptOutcome::Accepted
    );
    release_tx.send(()).expect("release commit");
    while !matches!(
        events.recv().await.expect("terminal event").kind,
        CoreEventKind::TurnInterrupted { .. }
    ) {}
    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot.turns.last().expect("turn");
    assert_eq!(turn.status, DurableTurnStatus::Interrupted);
    assert!(matches!(
        turn.items.as_slice(),
        [
            sugarcode_state::DurableItemSnapshot::UserMessage { .. },
            sugarcode_state::DurableItemSnapshot::ToolCall { .. },
            sugarcode_state::DurableItemSnapshot::FileChange { .. },
            sugarcode_state::DurableItemSnapshot::ToolResult {
                result: sugarcode_state::DurableToolResult::Success { .. },
                ..
            }
        ]
    ));
}
