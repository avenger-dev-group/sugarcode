use super::*;
use sugarcode_tools::WorkspacePatchExecutor;

fn update_patch(before: &str, after: &str) -> String {
    format!("*** Begin Patch\n*** Update File: notes.txt\n@@\n-{before}\n+{after}\n*** End Patch")
}

async fn runtime_with_patch_rounds(
    directory: &std::path::Path,
    rounds: VecDeque<Vec<Result<ModelEvent, ModelError>>>,
) -> (
    CoreRuntime,
    tokio::sync::mpsc::Receiver<CoreEvent>,
    ThreadId,
    Arc<Mutex<Vec<ModelRequest>>>,
) {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = SequencedProvider {
        rounds: Mutex::new(rounds),
        requests: Arc::clone(&requests),
    };
    let mut core = Core::new();
    let CoreEventKind::ThreadStarted { thread_id } = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread")
        .kind
    else {
        panic!("thread event");
    };
    let tool = Arc::new(WorkspaceTool::open(directory).expect("workspace tool"));
    let workspace_patch: Arc<dyn WorkspacePatchExecutor> = tool;
    let (runtime, events) = CoreRuntime::new_with_workspace(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        None,
        None,
    );
    (
        runtime.with_workspace_patch(Some(workspace_patch)),
        events,
        thread_id,
        requests,
    )
}

#[tokio::test]
async fn workspace_apply_patch_is_the_only_workspace_write_tool_and_accepts_raw_text() {
    let directory = tempfile::tempdir().expect("workspace");
    let target = directory.path().join("notes.txt");
    std::fs::write(&target, "old\n").expect("workspace fixture");
    let patch = update_patch("old", "new");
    let (mut runtime, mut events, thread_id, requests) = runtime_with_patch_rounds(
        directory.path(),
        VecDeque::from([
            vec![Ok(model_event::tool_call(ModelToolCall {
                id: "call_freeform".to_string(),
                name: "workspace/apply-patch".to_string(),
                arguments: serde_json::Value::String(patch.clone()),
            }))],
            vec![Ok(model_event::final_response("Applied."))],
        ]),
    )
    .await;
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Apply the patch".to_string()),
        )
        .expect("start turn")
    else {
        panic!("async turn");
    };
    while !matches!(
        events.recv().await.expect("terminal").kind,
        CoreEventKind::TurnCompleted { .. }
    ) {}

    assert_eq!(
        std::fs::read_to_string(target).expect("patched file"),
        "new\n"
    );
    let requests = requests.lock().expect("requests");
    assert_eq!(
        requests[0]
            .tools
            .iter()
            .filter(|tool| is_workspace_write_tool(&tool.name))
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        vec!["workspace/apply-patch"]
    );
    assert!(
        requests[0]
            .tools
            .iter()
            .find(|tool| tool.name == "workspace/apply-patch")
            .expect("freeform definition")
            .freeform
            .is_some()
    );
    drop(requests);
    let turn = runtime
        .resume_thread(&thread_id)
        .expect("resume")
        .turns
        .into_iter()
        .find(|turn| turn.id == turn_id)
        .expect("turn");
    assert!(turn.items.iter().any(|item| matches!(
        item,
        sugarcode_state::DurableItemSnapshot::ToolCall { name, arguments, .. }
            if name == "workspace/apply-patch" && arguments.as_str() == Some(patch.as_str())
    )));
    assert!(turn.items.iter().any(|item| matches!(
        item,
        sugarcode_state::DurableItemSnapshot::FileChange { kind, .. } if kind == "update"
    )));
}

#[tokio::test]
async fn corrected_apply_patch_clears_the_argument_recovery_gate() {
    let directory = tempfile::tempdir().expect("workspace");
    let target = directory.path().join("notes.txt");
    std::fs::write(&target, "old\n").expect("workspace fixture");
    let patch = update_patch("old", "new");
    let (mut runtime, mut events, thread_id, requests) = runtime_with_patch_rounds(
        directory.path(),
        VecDeque::from([
            vec![Ok(model_event::tool_call(ModelToolCall {
                id: "call_invalid".to_string(),
                name: "workspace/apply-patch".to_string(),
                arguments: serde_json::Value::String("not a patch".to_string()),
            }))],
            vec![Ok(model_event::tool_call(ModelToolCall {
                id: "call_corrected".to_string(),
                name: "workspace/apply-patch".to_string(),
                arguments: serde_json::Value::String(patch),
            }))],
            vec![Ok(model_event::final_response("Applied."))],
        ]),
    )
    .await;
    let TurnStartOutcome::Accepted { .. } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id,
            Some("Apply the patch".to_string()),
        )
        .expect("start turn")
    else {
        panic!("async turn");
    };
    while !matches!(
        events.recv().await.expect("terminal").kind,
        CoreEventKind::TurnCompleted { .. }
    ) {}

    assert_eq!(
        std::fs::read_to_string(target).expect("patched file"),
        "new\n"
    );
    let requests = requests.lock().expect("requests");
    let rejection = message_tool_results(requests[1].messages.last().expect("result message"));
    assert_eq!(rejection.len(), 1);
    assert!(tool_result_serialized(rejection[0]).contains("invalidArguments"));
}

#[tokio::test]
async fn three_invalid_apply_patches_end_with_explicit_terminal_kind() {
    let directory = tempfile::tempdir().expect("workspace");
    std::fs::write(directory.path().join("notes.txt"), "old\n").expect("workspace fixture");
    let invalid_round = |id: &str, patch: &str| {
        vec![Ok(model_event::tool_call(ModelToolCall {
            id: id.to_string(),
            name: "workspace/apply-patch".to_string(),
            arguments: serde_json::Value::String(patch.to_string()),
        }))]
    };
    let (mut runtime, mut events, thread_id, requests) = runtime_with_patch_rounds(
        directory.path(),
        VecDeque::from([
            invalid_round("call_invalid_1", "not a patch"),
            invalid_round("call_invalid_2", "*** Begin Patch\n*** End Patch"),
            invalid_round("call_invalid_3", "*** Begin Patch\nno file\n*** End Patch"),
        ]),
    )
    .await;
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Apply the patch".to_string()),
        )
        .expect("start turn")
    else {
        panic!("async turn");
    };
    while !matches!(
        events.recv().await.expect("terminal").kind,
        CoreEventKind::TurnFailed { .. }
    ) {}

    assert_eq!(requests.lock().expect("requests").len(), 3);
    let turn = runtime
        .resume_thread(&thread_id)
        .expect("resume")
        .turns
        .into_iter()
        .find(|turn| turn.id == turn_id)
        .expect("turn");
    assert_eq!(
        turn.error.map(|error| error.kind),
        Some(DurableTurnErrorKind::UnsupportedToolArguments)
    );
}
