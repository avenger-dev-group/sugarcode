use std::path::PathBuf;
use sugarcode_tools::NativeShellCommandExecutor;
use sugarcode_tools::ShellCommandArguments;
use sugarcode_tools::ShellCommandExecution;
use sugarcode_tools::ShellCommandExecutor;
use sugarcode_tools::ShellCommandOutcome;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn hidden_supervisor_executes_one_absolute_argv_command() {
    let executor = NativeShellCommandExecutor::new(PathBuf::from(env!("CARGO_BIN_EXE_sugarcode")));
    let execution = executor
        .execute(test_command(), CancellationToken::new())
        .await;
    let ShellCommandExecution::Completed(output) = execution else {
        panic!("expected completed command, got {execution:?}");
    };
    assert!(output.stdout.contains("supervisor-ok"));
    assert_eq!(output.stderr, "");
    assert!(!output.stdout_truncated);
    assert!(matches!(
        output.outcome,
        ShellCommandOutcome::ExitCode { code: 0 }
    ));
}

#[cfg(unix)]
fn test_command() -> ShellCommandArguments {
    ShellCommandArguments {
        command: "/bin/echo".to_string(),
        arguments: vec!["supervisor-ok".to_string()],
        cwd: std::env::current_dir().expect("current directory"),
    }
}

#[cfg(windows)]
fn test_command() -> ShellCommandArguments {
    let system_root = std::env::var_os("SYSTEMROOT")
        .map(PathBuf::from)
        .expect("SYSTEMROOT is available");
    ShellCommandArguments {
        command: system_root
            .join("System32")
            .join("cmd.exe")
            .to_string_lossy()
            .into_owned(),
        arguments: vec![
            "/D".to_string(),
            "/C".to_string(),
            "echo supervisor-ok".to_string(),
        ],
        cwd: std::env::current_dir().expect("current directory"),
    }
}
