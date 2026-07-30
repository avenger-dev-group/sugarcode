use super::*;
use sugarcode_state::ThreadRepository;

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
    fn sandbox_policy(&self) -> sugarcode_tools::CommandSandboxPolicy {
        sugarcode_tools::CommandSandboxPolicy::FILESYSTEM_READ_ONLY_NETWORK_DENIED_V1
    }

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
                sandbox_policy:
                    sugarcode_tools::CommandSandboxPolicy::FILESYSTEM_READ_ONLY_NETWORK_DENIED_V1,
            })
        })
    }
}

#[derive(Debug)]
struct RecordedWorkspaceWriteShell;

impl ShellCommandExecutor for RecordedWorkspaceWriteShell {
    fn sandbox_policy(&self) -> sugarcode_tools::CommandSandboxPolicy {
        sugarcode_tools::CommandSandboxPolicy::FILESYSTEM_READ_ONLY_COMMAND_WORKSPACE_WRITE_NETWORK_DENIED_V1
    }

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
                sandbox_policy:
                    sugarcode_tools::CommandSandboxPolicy::FILESYSTEM_READ_ONLY_COMMAND_WORKSPACE_WRITE_NETWORK_DENIED_V1,
            })
        })
    }
}

#[derive(Debug)]
struct CountingShell(Arc<AtomicUsize>);

impl ShellCommandExecutor for CountingShell {
    fn sandbox_policy(&self) -> sugarcode_tools::CommandSandboxPolicy {
        sugarcode_tools::CommandSandboxPolicy::FILESYSTEM_READ_ONLY_NETWORK_DENIED_V1
    }

    fn execute(
        &self,
        _arguments: ShellCommandArguments,
        _cancellation: CancellationToken,
    ) -> sugarcode_tools::ShellCommandFuture {
        self.0.fetch_add(1, Ordering::AcqRel);
        Box::pin(async { ShellCommandExecution::Error(ShellCommandErrorKind::Unavailable) })
    }
}

#[derive(Debug)]
struct FailOnAttemptRepository {
    inner: sugarcode_state::RolloutRepository,
    attempt_failure: Mutex<Option<oneshot::Sender<()>>>,
}

impl sugarcode_state::ThreadRepository for FailOnAttemptRepository {
    fn id_sequences(&self) -> sugarcode_state::IdSequences {
        self.inner.id_sequences()
    }

    fn create_thread(&mut self, thread_id: &ThreadId) -> Result<(), sugarcode_state::RolloutError> {
        self.inner.create_thread(thread_id)
    }

    fn create_thread_snapshot(
        &mut self,
        snapshot: &sugarcode_state::DurableThreadSnapshot,
    ) -> Result<(), sugarcode_state::RolloutError> {
        self.inner.create_thread_snapshot(snapshot)
    }

    fn append_completed_turn(
        &mut self,
        thread_id: &ThreadId,
        turn: &sugarcode_state::DurableTurnSnapshot,
    ) -> Result<(), sugarcode_state::RolloutError> {
        self.inner.append_completed_turn(thread_id, turn)
    }

    fn begin_turn(
        &mut self,
        thread_id: &ThreadId,
        turn: &sugarcode_state::DurableTurnSnapshot,
    ) -> Result<(), sugarcode_state::RolloutError> {
        self.inner.begin_turn(thread_id, turn)
    }

    fn finish_turn(
        &mut self,
        thread_id: &ThreadId,
        turn: &sugarcode_state::DurableTurnSnapshot,
    ) -> Result<(), sugarcode_state::RolloutError> {
        self.inner.finish_turn(thread_id, turn)
    }

    fn append_turn_item(
        &mut self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        item: &sugarcode_state::DurableItemSnapshot,
    ) -> Result<(), sugarcode_state::RolloutError> {
        if matches!(
            item,
            sugarcode_state::DurableItemSnapshot::CommandExecutionAttempt { .. }
        ) {
            if let Some(sender) = self.attempt_failure.lock().expect("attempt failure").take() {
                let _ = sender.send(());
            }
            return Err(sugarcode_state::RolloutError::Poisoned);
        }
        self.inner.append_turn_item(thread_id, turn_id, item)
    }

    fn complete_turn_item(
        &mut self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        item: &sugarcode_state::DurableItemSnapshot,
    ) -> Result<(), sugarcode_state::RolloutError> {
        self.inner.complete_turn_item(thread_id, turn_id, item)
    }

    fn archive_thread(
        &mut self,
        thread_id: &ThreadId,
    ) -> Result<(), sugarcode_state::RolloutError> {
        self.inner.archive_thread(thread_id)
    }

    fn unarchive_thread(
        &mut self,
        thread_id: &ThreadId,
    ) -> Result<(), sugarcode_state::RolloutError> {
        self.inner.unarchive_thread(thread_id)
    }

    fn delete_thread(&mut self, thread_id: &ThreadId) -> Result<(), sugarcode_state::RolloutError> {
        self.inner.delete_thread(thread_id)
    }

    fn load_thread(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Option<sugarcode_state::DurableThreadSnapshot>, sugarcode_state::RolloutError> {
        self.inner.load_thread(thread_id)
    }

    fn list_threads(
        &mut self,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<sugarcode_state::DurableThreadPage, sugarcode_state::RolloutError> {
        self.inner.list_threads(cursor, limit)
    }

    fn search_threads(
        &mut self,
        query: &str,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<sugarcode_state::DurableThreadPage, sugarcode_state::RolloutError> {
        self.inner.search_threads(query, cursor, limit)
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
    let (mut runtime, mut events) = CoreRuntime::new_with_shell(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        None,
        None,
        None,
        Arc::new(RecordedWorkspaceWriteShell),
        Arc::new(FixedApproval(CommandApprovalOutcome::Approved)),
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
            sugarcode_state::DurableItemSnapshot::CommandApprovalRequest {
                sandboxed: true,
                sandbox_policy: Some(sandbox_policy),
                workspace_write_policy: Some(workspace_write_policy),
                workspace_write_risk: Some(workspace_write_risk),
                network_policy: Some(network_policy),
                ..
            },
            sugarcode_state::DurableItemSnapshot::CommandApprovalDecision {
                decision,
                approval_id,
                workspace_write_risk_acknowledgement:
                    Some(workspace_write_risk_acknowledgement),
                ..
            },
            sugarcode_state::DurableItemSnapshot::CommandExecutionAttempt {
                approval_id: attempt_approval_id,
                call_id,
                ..
            },
            sugarcode_state::DurableItemSnapshot::ToolResult {
                result: sugarcode_state::DurableToolResult::Process(process),
                ..
            },
            sugarcode_state::DurableItemSnapshot::AgentMessage { .. }
        ] if command == &test_absolute_command()
            && arguments == &["approved output".to_string()]
            && sandbox_policy == "filesystemReadOnlyV1"
            && workspace_write_policy == "commandWorkspaceWriteV1"
            && workspace_write_risk == "nonTransactionalWorkspaceTreeV1"
            && workspace_write_risk_acknowledgement
                == "nonTransactionalWorkspaceTreeV1"
            && network_policy == "networkDeniedV1"
            && process.sandbox_policy.as_deref() == Some("filesystemReadOnlyV1")
            && process.workspace_write_policy.as_deref() == Some("commandWorkspaceWriteV1")
            && process.network_policy.as_deref() == Some("networkDeniedV1")
            && decision == "approved"
            && attempt_approval_id == approval_id
            && call_id == "call_shell_1"
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
            sugarcode_state::DurableItemSnapshot::CommandExecutionAttempt {
                approval_id: attempt_approval_id,
                call_id,
                ..
            },
            sugarcode_state::DurableItemSnapshot::ToolResult {
                result: sugarcode_state::DurableToolResult::Process(_),
                ..
            },
            sugarcode_state::DurableItemSnapshot::AgentMessage { .. }
        ] if approval_id.contains("call_shell_1")
            && attempt_approval_id == approval_id
            && call_id == "call_shell_1"
    ));
    let requests = requests.lock().expect("requests");
    assert_eq!(requests.len(), 2);
    assert!(
        requests[0]
            .tools
            .iter()
            .any(|tool| tool.name == "shell/exec")
    );
    assert!(requests[0].tools.iter().any(|tool| {
        tool.name == "shell/exec"
            && tool
                .description
                .contains("writes inside the active workspace scope")
            && tool.description.contains("network access is denied")
    }));
    assert!(
        requests[1]
            .tools
            .iter()
            .any(|tool| tool.name == "shell/exec")
    );
}

#[tokio::test]
async fn failed_attempt_audit_never_calls_the_shell_executor() {
    let home_directory = tempfile::tempdir().expect("home");
    let home = sugarcode_state::resolve_sugarcode_home(sugarcode_state::HomeResolutionInputs {
        cli_override: Some(home_directory.path().to_path_buf()),
        ..Default::default()
    })
    .expect("resolved home");
    let repository = sugarcode_state::RolloutRepository::open(&home).expect("repository");
    let (attempt_failure_tx, attempt_failure_rx) = oneshot::channel();
    let mut core = Core::with_repository(Box::new(FailOnAttemptRepository {
        inner: repository,
        attempt_failure: Mutex::new(Some(attempt_failure_tx)),
    }));
    let started = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    let provider = SequencedProvider {
        rounds: Mutex::new(VecDeque::from([vec![
            Ok(ModelEvent::ToolCall(ModelToolCall {
                id: "call_shell_attempt_failure".to_string(),
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
    let executions = Arc::new(AtomicUsize::new(0));
    let (mut runtime, _events) = CoreRuntime::new_with_shell(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        None,
        None,
        None,
        Arc::new(CountingShell(executions.clone())),
        Arc::new(FixedApproval(CommandApprovalOutcome::Approved)),
    );
    runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Run it".to_string()),
        )
        .expect("start turn");
    attempt_failure_rx.await.expect("attempt append reached");
    assert_eq!(executions.load(Ordering::Acquire), 0);
    drop(runtime);

    let repository = sugarcode_state::RolloutRepository::open(&home).expect("recover");
    let snapshot = repository
        .load_thread(&thread_id)
        .expect("load")
        .expect("thread");
    let items = &snapshot.turns[0].items;
    assert!(items.iter().any(|item| matches!(
        item,
        sugarcode_state::DurableItemSnapshot::CommandApprovalDecision {
            decision,
            ..
        } if decision == "approved"
    )));
    assert!(!items.iter().any(|item| matches!(
        item,
        sugarcode_state::DurableItemSnapshot::CommandExecutionAttempt { .. }
    )));
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
    let (mut runtime, mut events) = CoreRuntime::new_with_shell(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        None,
        None,
        None,
        Arc::new(RecordedShell),
        Arc::new(FixedApproval(CommandApprovalOutcome::Denied)),
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
    assert!(has_requested_command_policy(&snapshot.turns[0].items));
    assert!(snapshot.turns[0].items.iter().any(|item| matches!(
        item,
        sugarcode_state::DurableItemSnapshot::ToolResult {
            result: sugarcode_state::DurableToolResult::Error { kind },
            ..
        } if kind == "approvalDenied"
    )));
    assert!(!snapshot.turns[0].items.iter().any(|item| matches!(
        item,
        sugarcode_state::DurableItemSnapshot::CommandExecutionAttempt { .. }
    )));
}

#[tokio::test]
async fn three_consecutive_explicit_denials_interrupt_the_turn() {
    let command = test_absolute_command();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let rounds = (1..=3)
        .map(|ordinal| {
            vec![
                Ok(ModelEvent::ToolCall(ModelToolCall {
                    id: format!("call_shell_denied_{ordinal}"),
                    name: "shell/exec".to_string(),
                    arguments: serde_json::json!({
                        "command": command,
                        "arguments": [],
                        "cwd": "."
                    }),
                })),
                Ok(ModelEvent::Completed),
            ]
        })
        .collect::<VecDeque<_>>();
    let provider = SequencedProvider {
        rounds: Mutex::new(rounds),
        requests: requests.clone(),
    };
    let mut core = Core::new();
    let started = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    let (mut runtime, mut events) = CoreRuntime::new_with_shell(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        None,
        None,
        None,
        Arc::new(RecordedShell),
        Arc::new(FixedApproval(CommandApprovalOutcome::Denied)),
    );
    runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Keep trying the denied command".to_string()),
        )
        .expect("start shell turn");
    while !matches!(
        events.recv().await.expect("core event").kind,
        CoreEventKind::TurnInterrupted { .. }
    ) {}

    let snapshot = runtime.resume_thread(&thread_id).expect("resume");
    assert_eq!(
        snapshot.turns[0]
            .items
            .iter()
            .filter(|item| matches!(
                item,
                sugarcode_state::DurableItemSnapshot::CommandApprovalDecision {
                    decision,
                    ..
                } if decision == "denied"
            ))
            .count(),
        3
    );
    assert_eq!(requests.lock().expect("requests").len(), 3);
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
    let (mut runtime, mut events) = CoreRuntime::new_with_shell(
        core,
        Arc::new(provider),
        "fixture-model".to_string(),
        None,
        None,
        None,
        Arc::new(RecordedShell),
        Arc::new(PendingApproval),
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
    assert!(has_requested_command_policy(items));
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
    assert!(!items.iter().any(|item| matches!(
        item,
        sugarcode_state::DurableItemSnapshot::CommandExecutionAttempt { .. }
    )));
}

#[test]
fn timed_out_process_result_retains_the_applied_command_policy() {
    let execution = ShellCommandExecution::Completed(sugarcode_tools::ShellCommandOutput {
        stdout: String::new(),
        stderr: String::new(),
        stdout_bytes: 0,
        stderr_bytes: 0,
        stdout_truncated: false,
        stderr_truncated: false,
        duration_ms: 30_000,
        outcome: ShellCommandOutcome::TimedOut,
        sandbox_policy:
            sugarcode_tools::CommandSandboxPolicy::FILESYSTEM_READ_ONLY_NETWORK_DENIED_V1,
    });
    let (result, _) = shell_execution_result(execution).expect("timed-out process result");
    assert!(matches!(
        result,
        CoreToolResult::Process(sugarcode_protocol::CoreProcessResult {
            outcome: sugarcode_protocol::CoreProcessOutcome::TimedOut,
            sandbox_policy: Some(
                sugarcode_protocol::CoreCommandSandboxPolicy::FilesystemReadOnlyV1
            ),
            network_policy: Some(sugarcode_protocol::CoreCommandNetworkPolicy::NetworkDeniedV1),
            ..
        })
    ));
}

fn has_requested_command_policy(items: &[sugarcode_state::DurableItemSnapshot]) -> bool {
    items.iter().any(|item| {
        matches!(
            item,
            sugarcode_state::DurableItemSnapshot::CommandApprovalRequest {
                sandbox_policy: Some(sandbox_policy),
                network_policy: Some(network_policy),
                ..
            } if sandbox_policy == "filesystemReadOnlyV1"
                && network_policy == "networkDeniedV1"
        )
    })
}

#[cfg(unix)]
fn test_absolute_command() -> String {
    "/bin/echo".to_string()
}

#[cfg(windows)]
fn test_absolute_command() -> String {
    r"C:\Windows\System32\cmd.exe".to_string()
}
