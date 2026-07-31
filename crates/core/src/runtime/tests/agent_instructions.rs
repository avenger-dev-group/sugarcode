use super::*;

#[tokio::test]
async fn base_agent_instruction_is_the_only_instruction_without_workspace_context() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([vec![
            Ok(model_event::text_delta("done".to_string())),
            Ok(model_event::COMPLETED),
        ]])),
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
    let (mut runtime, mut events) =
        CoreRuntime::new(core, Arc::new(provider), "fixture-model".to_string());

    let TurnStartOutcome::Accepted { .. } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id,
            Some("Explain the project".to_string()),
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
        requests[0].instructions,
        vec![crate::agent_instructions::sugarcode_base_agent_instruction_v1()]
    );
}
