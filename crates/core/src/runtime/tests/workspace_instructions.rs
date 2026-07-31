use super::*;

const INSTRUCTION: &str = "Keep this workspace instruction stable.";
const INSTRUCTION_SHA256: &str = "cea0809756ae1f03c2debecdca39ba8dd0d07454a23dd4d531ff920828691b2d";

#[tokio::test]
async fn one_workspace_snapshot_is_reused_across_all_provider_rounds_and_audited() {
    let directory = tempfile::tempdir().expect("workspace");
    std::fs::write(directory.path().join("README.txt"), "bounded context")
        .expect("workspace fixture");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([
            vec![
                Ok(model_event::tool_call(ModelToolCall {
                    id: "call_1".to_string(),
                    name: "workspace/read".to_string(),
                    arguments: serde_json::json!({ "path": "README.txt" }),
                })),
                Ok(model_event::COMPLETED),
            ],
            vec![
                Ok(model_event::text_delta("done".to_string())),
                Ok(model_event::COMPLETED),
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
    let (runtime, mut events) = CoreRuntime::new_with_workspace(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        Some(tool),
        None,
    );
    let mut runtime =
        runtime.with_workspace_instructions(Some(WorkspaceInstructionsSnapshot::Present {
            content: INSTRUCTION.to_string(),
            bytes: INSTRUCTION.len(),
            sha256: INSTRUCTION_SHA256.to_string(),
        }));
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Read the file".to_string()),
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
    let expected = vec![
        crate::agent_instructions::sugarcode_base_agent_instruction_v1(),
        ModelInstruction {
            source: ModelInstructionSource::WorkspaceRootAgentsV1,
            content: INSTRUCTION.to_string(),
        },
    ];
    assert_eq!(requests[0].instructions, expected);
    assert_eq!(requests[1].instructions, expected);
    drop(requests);

    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.id == turn_id)
        .expect("turn");
    assert_eq!(
        turn.workspace_instructions,
        Some(DurableWorkspaceInstructionsAudit {
            source: DurableWorkspaceInstructionsSource::RootAgentsMdV1,
            status: DurableWorkspaceInstructionsStatus::Present,
            bytes: Some(INSTRUCTION.len() as u64),
            sha256: Some(INSTRUCTION_SHA256.to_string()),
        })
    );
}

#[test]
fn workspace_instruction_bytes_share_the_provider_history_budget() {
    let mut core = Core::new();
    let started = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    let audit = DurableWorkspaceInstructionsAudit {
        source: DurableWorkspaceInstructionsSource::RootAgentsMdV1,
        status: DurableWorkspaceInstructionsStatus::Present,
        bytes: Some(1),
        sha256: Some("a".repeat(64)),
    };

    assert_eq!(
        core.prepare_text_turn_with_workspace_instructions(
            CoreRequestId::new(2),
            thread_id,
            Some("x".to_string()),
            Some(audit),
            crate::thread::MAX_PROVIDER_HISTORY_BYTES,
            0,
        ),
        Err(CoreError::ContextTooLarge)
    );
}

#[tokio::test]
async fn nested_workspace_hierarchy_is_one_ordered_instruction_and_one_aggregate_audit() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([vec![
            Ok(model_event::text_delta("done".to_string())),
            Ok(model_event::COMPLETED),
        ]])),
        requests: Arc::clone(&requests),
    };
    let mut core = Core::new();
    let started = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    let (runtime, mut events) =
        CoreRuntime::new(core, Arc::new(provider), "fixture-model".to_string());
    let mut runtime =
        runtime.with_workspace_instructions(Some(WorkspaceInstructionsSnapshot::Hierarchy {
            entries: vec![
                sugarcode_tools::WorkspaceInstructionEntry {
                    path: "AGENTS.md".to_string(),
                    content: "root rule".to_string(),
                },
                sugarcode_tools::WorkspaceInstructionEntry {
                    path: "projects/AGENTS.md".to_string(),
                    content: String::new(),
                },
                sugarcode_tools::WorkspaceInstructionEntry {
                    path: "projects/active/AGENTS.md".to_string(),
                    content: "deeper rule".to_string(),
                },
            ],
            present: true,
            bytes: "root ruledeeper rule".len(),
            sha256: "b".repeat(64),
        }));
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("apply instructions".to_string()),
        )
        .expect("start turn")
    else {
        panic!("asynchronous turn");
    };
    while !matches!(
        events.recv().await.expect("terminal event").kind,
        CoreEventKind::TurnCompleted { .. }
    ) {}

    let requests = requests.lock().expect("requests");
    assert_eq!(
        requests[0].instructions,
        vec![
            crate::agent_instructions::sugarcode_base_agent_instruction_v1(),
            ModelInstruction {
                source: ModelInstructionSource::WorkspaceAgentsHierarchyV1,
                content: concat!(
                    "--- AGENTS.md: AGENTS.md ---\n",
                    "root rule\n\n",
                    "--- AGENTS.md: projects/active/AGENTS.md ---\n",
                    "deeper rule"
                )
                .to_string(),
            },
        ]
    );
    drop(requests);

    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.id == turn_id)
        .expect("turn");
    assert_eq!(
        turn.workspace_instructions,
        Some(DurableWorkspaceInstructionsAudit {
            source: DurableWorkspaceInstructionsSource::RootToActiveScopeAgentsMdV1,
            status: DurableWorkspaceInstructionsStatus::Present,
            bytes: Some("root ruledeeper rule".len() as u64),
            sha256: Some("b".repeat(64)),
        })
    );
}
