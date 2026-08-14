use super::*;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use crate::WorkspaceTool;
use crate::command_environment::filtered_command_environment;

#[test]
fn rejects_relative_commands_and_oversized_arguments() {
    let relative = ShellCommandArguments {
        command: "echo".to_string(),
        arguments: Vec::new(),
    };
    assert_eq!(
        validate_arguments(&relative),
        Err(ShellCommandErrorKind::InvalidArguments)
    );

    let oversized = ShellCommandArguments {
        command: if cfg!(windows) {
            r"C:\Windows\System32\cmd.exe".to_string()
        } else {
            "/bin/echo".to_string()
        },
        arguments: vec!["x".repeat(MAX_SHELL_ARGUMENT_BYTES + 1)],
    };
    assert_eq!(
        validate_arguments(&oversized),
        Err(ShellCommandErrorKind::InvalidArguments)
    );
}

#[test]
fn bounded_reader_keeps_prefix_and_observed_byte_count() {
    let bytes = vec![b'x'; MAX_SHELL_OUTPUT_BYTES + 17];
    let output = read_bounded(bytes.as_slice());
    assert_eq!(output.retained.len(), MAX_SHELL_OUTPUT_BYTES);
    assert_eq!(
        output.observed,
        u64::try_from(MAX_SHELL_OUTPUT_BYTES + 17).expect("observed byte count")
    );
    assert!(output.truncated);
}

#[test]
fn sandbox_unavailable_is_a_stable_supervisor_error() {
    assert_eq!(
        serde_json::to_string(&ShellCommandErrorKind::SandboxUnavailable)
            .expect("serialize sandbox error"),
        r#""sandboxUnavailable""#
    );
    assert_eq!(
        ShellCommandErrorKind::SandboxUnavailable.to_string(),
        "sandboxUnavailable"
    );
}

#[test]
fn command_environment_preserves_host_toolchains_without_credentials() {
    let environment = filtered_command_environment([
        ("PATH".to_string(), "/host/bin:/usr/bin".to_string()),
        ("HOME".to_string(), "/host/home".to_string()),
        ("JAVA_HOME".to_string(), "/host/java".to_string()),
        ("NVM_BIN".to_string(), "/host/node/bin".to_string()),
        ("PNPM_HOME".to_string(), "/host/pnpm".to_string()),
        ("OPENAI_API_KEY".to_string(), "model-secret".to_string()),
        ("GITHUB_TOKEN".to_string(), "git-secret".to_string()),
        (
            "REGISTRY_PASSWORD".to_string(),
            "registry-secret".to_string(),
        ),
    ]);

    assert!(environment.contains(&("PATH".to_string(), "/host/bin:/usr/bin".to_string())));
    assert!(environment.contains(&("HOME".to_string(), "/host/home".to_string())));
    assert!(environment.contains(&("JAVA_HOME".to_string(), "/host/java".to_string())));
    assert!(environment.contains(&("NVM_BIN".to_string(), "/host/node/bin".to_string())));
    assert!(environment.contains(&("PNPM_HOME".to_string(), "/host/pnpm".to_string())));
    assert!(environment.contains(&("LANG".to_string(), "C".to_string())));
    assert!(environment.contains(&("LC_ALL".to_string(), "C".to_string())));
    assert!(!environment.iter().any(|(name, _)| matches!(
        name.as_str(),
        "OPENAI_API_KEY" | "GITHUB_TOKEN" | "REGISTRY_PASSWORD"
    )));
    assert!(
        !format!("{:?}", CommandEnvironmentSnapshot::process_fallback(true))
            .contains("model-secret")
    );
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn full_access_shell_executes_pipeline_redirection_and_streams_output() {
    let directory = tempfile::tempdir().expect("workspace");
    let workspace = WorkspaceTool::open(directory.path()).expect("workspace tool");
    let workspace_root =
        Arc::new(CommandWorkspaceRoot::from_workspace(&workspace).expect("command workspace root"));
    let environment = Arc::new(CommandEnvironmentSnapshot::process_fallback(true));
    let (output_tx, mut output_rx) = tokio::sync::mpsc::unbounded_channel();
    let execution = execute_full_access_shell(
        FullAccessShellArguments {
            command:
                "printf 'sugar code\\n' | tr '[:lower:]' '[:upper:]' > result.txt && cat result.txt"
                    .to_string(),
            cwd: directory.path().to_string_lossy().into_owned(),
            timeout_ms: 5_000,
            output_tx: Some(output_tx),
        },
        workspace_root,
        environment,
        CancellationToken::new(),
    )
    .await;

    let ShellCommandExecution::FullAccessCompleted(output) = execution else {
        panic!("full access execution: {execution:?}");
    };
    assert_eq!(output.stdout, "SUGAR CODE\n");
    assert_eq!(
        std::fs::read_to_string(directory.path().join("result.txt")).expect("redirected file"),
        "SUGAR CODE\n"
    );
    let mut streamed = String::new();
    while let Ok(chunk) = output_rx.try_recv() {
        assert_eq!(chunk.stream, ShellOutputStream::Stdout);
        streamed.push_str(&chunk.content);
    }
    assert_eq!(streamed, "SUGAR CODE\n");
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn full_access_shell_rejects_a_non_authoritative_absolute_cwd() {
    let directory = tempfile::tempdir().expect("workspace");
    let other = tempfile::tempdir().expect("other directory");
    let workspace = WorkspaceTool::open(directory.path()).expect("workspace tool");
    let workspace_root =
        Arc::new(CommandWorkspaceRoot::from_workspace(&workspace).expect("command workspace root"));
    let execution = execute_full_access_shell(
        FullAccessShellArguments {
            command: "pwd".to_string(),
            cwd: other.path().to_string_lossy().into_owned(),
            timeout_ms: 5_000,
            output_tx: None,
        },
        workspace_root,
        Arc::new(CommandEnvironmentSnapshot::process_fallback(true)),
        CancellationToken::new(),
    )
    .await;

    assert_eq!(
        execution,
        ShellCommandExecution::Error(ShellCommandErrorKind::InvalidArguments)
    );
}

#[test]
fn supervisor_rejects_sensitive_or_malformed_environment_entries() {
    assert_eq!(
        validate_command_environment(&[("API_TOKEN".to_string(), "secret".to_string())]),
        Err(ShellCommandErrorKind::InvalidArguments)
    );
    assert_eq!(
        validate_command_environment(&[("BAD=NAME".to_string(), "value".to_string())]),
        Err(ShellCommandErrorKind::InvalidArguments)
    );
}

#[test]
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn startup_probe_fails_closed_when_the_supervisor_cannot_spawn() {
    let directory = tempfile::tempdir().expect("workspace");
    let workspace = WorkspaceTool::open(directory.path()).expect("open workspace");
    let command_root = workspace
        .command_workspace_root()
        .expect("bind command workspace root");
    let error = NativeShellCommandExecutor::new(
        PathBuf::from("/sugarcode-test/nonexistent-command-supervisor"),
        command_root,
    )
    .expect_err("missing supervisor must fail the command sandbox probe");
    assert_eq!(
        error.kind(),
        sugarcode_sandbox::SandboxErrorKind::Unavailable
    );
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[tokio::test]
async fn embedded_executor_uses_the_capability_root_without_a_cli_supervisor() {
    let directory = tempfile::tempdir().expect("workspace");
    let workspace = WorkspaceTool::open(directory.path()).expect("open workspace");
    let executor = EmbeddedShellCommandExecutor::new(
        workspace
            .command_workspace_root()
            .expect("bind command workspace root"),
    )
    .expect("embedded executor");
    let execution = executor
        .execute(
            ShellCommandArguments {
                command: "/bin/pwd".to_owned(),
                arguments: Vec::new(),
            },
            CancellationToken::new(),
        )
        .await;
    let ShellCommandExecution::Completed(output) = execution else {
        panic!("embedded command failed: {execution:?}");
    };
    assert_eq!(
        std::fs::canonicalize(output.stdout.trim()).expect("command cwd"),
        std::fs::canonicalize(directory.path()).expect("workspace cwd"),
    );
    assert!(matches!(
        output.outcome,
        ShellCommandOutcome::ExitCode { code: 0 }
    ));
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn embedded_executor_keeps_the_read_only_filesystem_policy() {
    let directory = tempfile::tempdir().expect("workspace");
    let workspace = WorkspaceTool::open(directory.path()).expect("open workspace");
    let executor = EmbeddedShellCommandExecutor::new(
        workspace
            .command_workspace_root()
            .expect("bind command workspace root"),
    )
    .expect("embedded executor");
    let execution = executor
        .execute(
            ShellCommandArguments {
                command: "/usr/bin/touch".to_owned(),
                arguments: vec!["blocked.txt".to_owned()],
            },
            CancellationToken::new(),
        )
        .await;
    let ShellCommandExecution::Completed(output) = execution else {
        panic!("embedded command failed: {execution:?}");
    };
    assert!(!matches!(
        output.outcome,
        ShellCommandOutcome::ExitCode { code: 0 }
    ));
    assert!(!directory.path().join("blocked.txt").exists());
}
