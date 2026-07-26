use super::*;
use sugarcode_tools::WorkspaceListExecutor;
use sugarcode_tools::WorkspaceSearchExecutor;

struct BlockingWorkspaceSearch {
    entered: Mutex<Option<oneshot::Sender<()>>>,
}

impl fmt::Debug for BlockingWorkspaceSearch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BlockingWorkspaceSearch")
            .finish_non_exhaustive()
    }
}

impl WorkspaceSearchExecutor for BlockingWorkspaceSearch {
    fn search<'a>(
        &'a self,
        _arguments: &'a WorkspaceSearchArguments,
        cancellation: &'a CancellationToken,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = WorkspaceSearchOutcome> + Send + 'a>>
    {
        Box::pin(async move {
            if let Some(entered) = self.entered.lock().expect("entered").take() {
                let _ = entered.send(());
            }
            cancellation.cancelled().await;
            WorkspaceSearchOutcome::Error {
                kind: WorkspaceSearchErrorKind::Cancelled,
            }
        })
    }
}

#[test]
fn workspace_search_arguments_are_exact_and_do_not_relax_read_or_list() {
    let valid = workspace_tool_arguments(&ModelToolCall {
        id: "call_valid".to_string(),
        name: "workspace/search".to_string(),
        arguments: serde_json::json!({"path": "src", "query": "needle"}),
    })
    .expect("valid search arguments");
    assert_eq!(valid.path, "src");
    assert_eq!(valid.query.as_deref(), Some("needle"));

    for (name, arguments) in [
        (
            "workspace/search",
            serde_json::json!({"path": "src", "query": "needle", "extra": true}),
        ),
        ("workspace/search", serde_json::json!({"path": "src"})),
        (
            "workspace/search",
            serde_json::json!({"path": "src", "query": 1}),
        ),
        (
            "workspace/read",
            serde_json::json!({"path": "src/lib.rs", "query": "needle"}),
        ),
        (
            "workspace/list",
            serde_json::json!({"path": "src", "query": "needle"}),
        ),
    ] {
        assert!(
            workspace_tool_arguments(&ModelToolCall {
                id: "call_invalid".to_string(),
                name: name.to_string(),
                arguments,
            })
            .is_err(),
            "{name} must reject non-exact arguments"
        );
    }
}

#[tokio::test]
async fn workspace_search_persists_query_and_runs_one_bounded_tool_round() {
    let directory = tempfile::tempdir().expect("workspace");
    std::fs::create_dir(directory.path().join("src")).expect("src");
    std::fs::write(directory.path().join("src/lib.rs"), "first\nneedle here\n").expect("fixture");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([
            vec![
                Ok(ModelEvent::ToolCall(ModelToolCall {
                    id: "call_search".to_string(),
                    name: "workspace/search".to_string(),
                    arguments: serde_json::json!({
                        "path": "src",
                        "query": "needle",
                    }),
                })),
                Ok(ModelEvent::Completed),
            ],
            vec![
                Ok(ModelEvent::TextDelta("I found it.".to_string())),
                Ok(ModelEvent::Completed),
            ],
        ])),
        requests: Arc::clone(&requests),
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
    let workspace_list: Arc<dyn WorkspaceListExecutor> = tool.clone();
    let workspace_search: Arc<dyn WorkspaceSearchExecutor> = tool;
    let (mut runtime, mut events) = CoreRuntime::new_with_workspace_search(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        Some(workspace_read),
        Some(workspace_list),
        Some(workspace_search),
    );
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Search the workspace".to_string()),
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
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0]
            .tools
            .iter()
            .map(|definition| definition.name.as_str())
            .collect::<Vec<_>>(),
        vec!["workspace/read", "workspace/list", "workspace/search"]
    );
    assert!(requests[1].tools.is_empty());
    assert!(matches!(
        requests[1].messages.as_slice(),
        [
            ModelMessage::Text { .. },
            ModelMessage::ToolCall(ModelToolCall {
                name,
                arguments,
                ..
            }),
            ModelMessage::ToolResult { content, .. }
        ] if name == "workspace/search"
            && arguments == &serde_json::json!({"path": "src", "query": "needle"})
            && serde_json::from_str::<serde_json::Value>(content).expect("search result")
                == serde_json::json!({
                    "matches": [{"path": "src/lib.rs", "line": 2}],
                    "truncated": false
                })
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
            sugarcode_state::DurableItemSnapshot::ToolCall {
                name,
                path,
                query,
                ..
            },
            sugarcode_state::DurableItemSnapshot::ToolResult {
                result: sugarcode_state::DurableToolResult::Success { content, .. },
                ..
            },
            sugarcode_state::DurableItemSnapshot::AgentMessage { text, .. }
        ] if name == "workspace/search"
            && path == "src"
            && query.as_deref() == Some("needle")
            && serde_json::from_str::<serde_json::Value>(content).expect("durable search result")
                == serde_json::json!({
                    "matches": [{"path": "src/lib.rs", "line": 2}],
                    "truncated": false
                })
            && text == "I found it."
    ));
}

#[tokio::test]
async fn interrupting_workspace_search_keeps_only_the_durable_call() {
    let (entered_tx, entered_rx) = oneshot::channel();
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([vec![
            Ok(ModelEvent::ToolCall(ModelToolCall {
                id: "call_search_cancel".to_string(),
                name: "workspace/search".to_string(),
                arguments: serde_json::json!({"path": ".", "query": "needle"}),
            })),
            Ok(ModelEvent::Completed),
        ]])),
        requests: Arc::new(Mutex::new(Vec::new())),
    };
    let mut core = Core::new();
    let started = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    let search: Arc<dyn WorkspaceSearchExecutor> = Arc::new(BlockingWorkspaceSearch {
        entered: Mutex::new(Some(entered_tx)),
    });
    let (mut runtime, mut events) = CoreRuntime::new_with_workspace_search(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        None,
        None,
        Some(search),
    );
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Search it".to_string()),
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
    entered_rx.await.expect("search entered");
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
    assert!(matches!(
        turn.items.last(),
        Some(sugarcode_state::DurableItemSnapshot::ToolCall {
            query: Some(query),
            ..
        }) if query == "needle"
    ));
    assert!(!turn.items.iter().any(|item| matches!(
        item,
        sugarcode_state::DurableItemSnapshot::ToolResult { .. }
    )));
}
