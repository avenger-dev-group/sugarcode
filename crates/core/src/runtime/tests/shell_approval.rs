use super::*;

#[derive(Debug)]
struct FixedApproval(CommandApprovalOutcome);

impl CommandApprovalRequester for FixedApproval {
    fn request(
        &self,
        _request: CommandApprovalRequest,
    ) -> futures_util::future::BoxFuture<'static, CommandApprovalOutcome> {
        let outcome = self.0;
        async move { outcome }.boxed()
    }
}

#[derive(Debug)]
struct PendingApproval;

impl CommandApprovalRequester for PendingApproval {
    fn request(
        &self,
        _request: CommandApprovalRequest,
    ) -> futures_util::future::BoxFuture<'static, CommandApprovalOutcome> {
        async move { std::future::pending::<CommandApprovalOutcome>().await }.boxed()
    }
}

#[derive(Debug)]
struct RecordedShell;

impl ShellCommandExecutor for RecordedShell {
    fn execute(
        &self,
        _arguments: ShellCommandArguments,
        _cancellation: CancellationToken,
    ) -> sugarcode_tools::ShellCommandFuture {
        Box::pin(async {
            ShellCommandExecution::Completed(sugarcode_tools::ShellCommandOutput {
                stdout: "approved output\n".to_string(),
                stderr: String::new(),
                stdout_bytes: 16,
                stderr_bytes: 0,
                stdout_truncated: false,
                stderr_truncated: false,
                duration_ms: 7,
                outcome: ShellCommandOutcome::ExitCode { code: 0 },
            })
        })
    }
}

#[tokio::test]
async fn approved_shell_command_is_audited_before_one_process_result() {
    let command = test_absolute_command();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([
            vec![
                Ok(ModelEvent::ToolCall(ModelToolCall {
                    id: "call_shell_1".to_string(),
                    name: "shell/exec".to_string(),
                    arguments: serde_json::json!({
                        "command": command,
                        "arguments": ["approved output"],
                        "cwd": "."
                    }),
                })),
                Ok(ModelEvent::Completed),
            ],
            vec![
                Ok(ModelEvent::TextDelta("Command completed.".to_string())),
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
    let directory = tempfile::tempdir().expect("workspace");
    let (mut runtime, mut events) = CoreRuntime::new_with_shell(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        None,
        None,
        None,
        Arc::new(RecordedShell),
        Arc::new(FixedApproval(CommandApprovalOutcome::Approved)),
        directory.path().to_path_buf(),
    );
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Run it".to_string()),
        )
        .expect("start shell turn")
    else {
        panic!("asynchronous turn");
    };

    while !matches!(
        events.recv().await.expect("core event").kind,
        CoreEventKind::TurnCompleted { .. }
    ) {}

    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| turn.id == turn_id)
        .expect("persisted shell turn");
    assert!(matches!(
        turn.items.as_slice(),
        [
            sugarcode_state::DurableItemSnapshot::UserMessage { .. },
            sugarcode_state::DurableItemSnapshot::ToolCall {
                command: Some(command),
                arguments: Some(arguments),
                ..
            },
            sugarcode_state::DurableItemSnapshot::CommandApprovalRequest { .. },
            sugarcode_state::DurableItemSnapshot::CommandApprovalDecision {
                decision,
                ..
            },
            sugarcode_state::DurableItemSnapshot::ToolResult {
                result: sugarcode_state::DurableToolResult::Process(_),
                ..
            },
            sugarcode_state::DurableItemSnapshot::AgentMessage { .. }
        ] if command == &test_absolute_command()
            && arguments == &["approved output".to_string()]
            && decision == "approved"
    ));
    let fork = runtime
        .fork_thread(&thread_id)
        .expect("fork completed shell turn");
    assert_ne!(fork.id, thread_id);
    assert!(matches!(
        fork.turns[0].items.as_slice(),
        [
            sugarcode_state::DurableItemSnapshot::UserMessage { .. },
            sugarcode_state::DurableItemSnapshot::ToolCall { .. },
            sugarcode_state::DurableItemSnapshot::CommandApprovalRequest {
                approval_id,
                ..
            },
            sugarcode_state::DurableItemSnapshot::CommandApprovalDecision { .. },
            sugarcode_state::DurableItemSnapshot::ToolResult {
                result: sugarcode_state::DurableToolResult::Process(_),
                ..
            },
            sugarcode_state::DurableItemSnapshot::AgentMessage { .. }
        ] if approval_id.contains("call_shell_1")
    ));
    let requests = requests.lock().expect("requests");
    assert_eq!(requests.len(), 2);
    assert!(
        requests[0]
            .tools
            .iter()
            .any(|tool| tool.name == "shell/exec")
    );
    assert!(requests[1].tools.is_empty());
}

#[tokio::test]
async fn denied_shell_command_persists_decision_without_running_process() {
    let command = test_absolute_command();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([
            vec![
                Ok(ModelEvent::ToolCall(ModelToolCall {
                    id: "call_shell_denied".to_string(),
                    name: "shell/exec".to_string(),
                    arguments: serde_json::json!({
                        "command": command,
                        "arguments": [],
                        "cwd": "."
                    }),
                })),
                Ok(ModelEvent::Completed),
            ],
            vec![
                Ok(ModelEvent::TextDelta("Command was denied.".to_string())),
                Ok(ModelEvent::Completed),
            ],
        ])),
        requests,
    };
    let mut core = Core::new();
    let started = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    let directory = tempfile::tempdir().expect("workspace");
    let (mut runtime, mut events) = CoreRuntime::new_with_shell(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        None,
        None,
        None,
        Arc::new(RecordedShell),
        Arc::new(FixedApproval(CommandApprovalOutcome::Denied)),
        directory.path().to_path_buf(),
    );
    runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Run it".to_string()),
        )
        .expect("start shell turn");
    while !matches!(
        events.recv().await.expect("core event").kind,
        CoreEventKind::TurnCompleted { .. }
    ) {}
    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    assert!(snapshot.turns[0].items.iter().any(|item| matches!(
        item,
        sugarcode_state::DurableItemSnapshot::ToolResult {
            result: sugarcode_state::DurableToolResult::Error { kind },
            ..
        } if kind == "approvalDenied"
    )));
}

#[tokio::test]
async fn interrupt_while_awaiting_approval_persists_cancelled_without_tool_result() {
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([vec![
            Ok(ModelEvent::ToolCall(ModelToolCall {
                id: "call_shell_interrupt".to_string(),
                name: "shell/exec".to_string(),
                arguments: serde_json::json!({
                    "command": test_absolute_command(),
                    "arguments": [],
                    "cwd": "."
                }),
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
    let directory = tempfile::tempdir().expect("workspace");
    let (mut runtime, mut events) = CoreRuntime::new_with_shell(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        None,
        None,
        None,
        Arc::new(RecordedShell),
        Arc::new(PendingApproval),
        directory.path().to_path_buf(),
    );
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Run it".to_string()),
        )
        .expect("start shell turn")
    else {
        panic!("asynchronous turn");
    };
    loop {
        let event = events.recv().await.expect("approval event");
        if matches!(
            event.kind,
            CoreEventKind::ItemCompleted {
                item: CoreItemSnapshot {
                    kind: CoreItemKind::CommandApprovalRequest { .. },
                    ..
                },
                ..
            }
        ) {
            break;
        }
    }
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
    let items = &snapshot.turns[0].items;
    assert!(items.iter().any(|item| matches!(
        item,
        sugarcode_state::DurableItemSnapshot::CommandApprovalDecision {
            decision,
            ..
        } if decision == "cancelled"
    )));
    assert!(!items.iter().any(|item| matches!(
        item,
        sugarcode_state::DurableItemSnapshot::ToolResult { .. }
    )));
}

#[cfg(unix)]
fn test_absolute_command() -> String {
    "/bin/echo".to_string()
}

#[cfg(windows)]
fn test_absolute_command() -> String {
    r"C:\Windows\System32\cmd.exe".to_string()
}
