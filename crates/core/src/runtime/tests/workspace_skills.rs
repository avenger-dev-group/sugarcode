use super::*;

fn write_skill(root: &std::path::Path, name: &str, description: &str, body: &str) {
    let path = root.join(format!(".agents/skills/{name}/SKILL.md"));
    std::fs::create_dir_all(path.parent().expect("skill parent")).expect("skill directory");
    std::fs::write(
        path,
        format!("---\nname: {name}\ndescription: {description}\n---\n{body}\n"),
    )
    .expect("skill");
}

#[tokio::test]
async fn inventory_and_selected_skill_are_ordered_reused_and_audited_without_content() {
    let workspace = tempfile::tempdir().expect("workspace");
    write_skill(
        workspace.path(),
        "review",
        "Review changes",
        "private review workflow",
    );
    let tool = WorkspaceTool::open(workspace.path()).expect("workspace tool");
    let (_, instructions, skills) = tool.derive_scope_with_context(".").expect("context");
    let manifest = skills.manifest_sha256().to_string();

    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([vec![
            Ok(ModelEvent::TextDelta("done".to_string())),
            Ok(ModelEvent::Completed),
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
    let mut runtime = runtime
        .with_workspace_instructions(Some(instructions))
        .with_workspace_skills(Some(skills));
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Use $review now".to_string()),
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
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0]
            .instructions
            .iter()
            .map(|instruction| instruction.source)
            .collect::<Vec<_>>(),
        vec![
            ModelInstructionSource::WorkspaceSkillsInventoryV1,
            ModelInstructionSource::SelectedWorkspaceSkillsV1,
        ]
    );
    assert!(requests[0].instructions[0].content.contains("$review"));
    assert!(
        requests[0].instructions[1]
            .content
            .contains("private review workflow")
    );
    drop(requests);

    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.id == turn_id)
        .expect("turn");
    let audit = turn.workspace_skills.as_ref().expect("skills audit");
    assert_eq!(
        audit.source,
        DurableWorkspaceSkillsSource::RootToActiveScopeAgentsSkillsV1
    );
    assert_eq!(audit.status, DurableWorkspaceSkillsStatus::Present);
    assert_eq!(audit.discovered_count, 1);
    assert_eq!(audit.effective_count, 1);
    assert_eq!(audit.selected_count, 1);
    assert_eq!(audit.manifest_sha256, manifest);
    assert!(audit.selection_sha256.is_some());
    assert!(!format!("{audit:?}").contains("private review workflow"));
}

#[tokio::test]
async fn selection_limit_failure_is_atomic_before_turn_id_allocation() {
    let workspace = tempfile::tempdir().expect("workspace");
    for name in ["one", "two", "three", "four", "five"] {
        write_skill(workspace.path(), name, name, "body");
    }
    let tool = WorkspaceTool::open(workspace.path()).expect("workspace tool");
    let (_, _, skills) = tool.derive_scope_with_context(".").expect("context");
    let (mut runtime, _events, thread_id) = runtime(RecordedProvider {
        events: vec![
            Ok(ModelEvent::TextDelta("done".to_string())),
            Ok(ModelEvent::Completed),
        ],
        stay_open: false,
    });
    runtime = runtime.with_workspace_skills(Some(skills));

    assert_eq!(
        runtime.start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("$one $two $three $four $five".to_string()),
        ),
        Err(CoreError::ContextTooLarge)
    );
    assert_eq!(
        runtime
            .resume_thread(&thread_id)
            .expect("resume after rejection")
            .turns,
        Vec::new()
    );
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(CoreRequestId::new(3), thread_id, Some("$one".to_string()))
        .expect("valid turn")
    else {
        panic!("asynchronous turn");
    };
    assert_eq!(turn_id.as_str(), "turn_0000000000000001");
}
