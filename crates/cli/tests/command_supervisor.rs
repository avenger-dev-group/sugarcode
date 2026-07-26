use std::path::Path;
use std::path::PathBuf;
use sugarcode_tools::NativeShellCommandExecutor;
use sugarcode_tools::ShellCommandArguments;
use sugarcode_tools::ShellCommandExecution;
use sugarcode_tools::ShellCommandExecutor;
use sugarcode_tools::ShellCommandOutcome;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn hidden_supervisor_executes_one_absolute_argv_command() {
    let executor = NativeShellCommandExecutor::new(PathBuf::from(env!("CARGO_BIN_EXE_sugarcode")))
        .expect("native read-only sandbox");
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

#[tokio::test]
async fn cancellation_terminates_a_descendant_that_holds_output_pipes() {
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_sugarcode"));
    let executor =
        NativeShellCommandExecutor::new(executable.clone()).expect("native read-only sandbox");
    let cancellation = CancellationToken::new();
    let command = cancellation_tree_command(&executable);
    let execution = executor.execute(command, cancellation.clone());
    let task = tokio::spawn(execution);
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    cancellation.cancel();
    let execution = tokio::time::timeout(std::time::Duration::from_secs(10), task)
        .await
        .expect("complete process-tree cancellation")
        .expect("executor task");
    assert_eq!(execution, ShellCommandExecution::Cancelled);
}

#[tokio::test]
async fn approved_command_cannot_write_workspace_files() {
    let workspace = tempfile::tempdir().expect("workspace");
    let target = workspace.path().join("target.txt");
    std::fs::write(&target, "original").expect("write fixture");
    let executor = NativeShellCommandExecutor::new(PathBuf::from(env!("CARGO_BIN_EXE_sugarcode")))
        .expect("native read-only sandbox");
    let execution = executor
        .execute(
            write_command(workspace.path(), &target),
            CancellationToken::new(),
        )
        .await;
    let ShellCommandExecution::Completed(output) = execution else {
        panic!("expected completed denied write, got {execution:?}");
    };
    assert!(matches!(
        output.outcome,
        ShellCommandOutcome::ExitCode { code } if code != 0
    ));
    assert_eq!(
        std::fs::read_to_string(target).expect("read unchanged fixture"),
        "original"
    );
}

#[cfg(unix)]
fn write_command(cwd: &Path, target: &Path) -> ShellCommandArguments {
    ShellCommandArguments {
        command: "/bin/sh".to_string(),
        arguments: vec![
            "-c".to_string(),
            "printf changed > \"$1\"".to_string(),
            "sugarcode-test".to_string(),
            target.to_string_lossy().into_owned(),
        ],
        cwd: cwd.to_path_buf(),
    }
}

#[cfg(windows)]
fn write_command(cwd: &Path, target: &Path) -> ShellCommandArguments {
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
            format!("echo changed>\"{}\"", target.display()),
        ],
        cwd: cwd.to_path_buf(),
    }
}

#[cfg(unix)]
fn cancellation_tree_command(_executable: &Path) -> ShellCommandArguments {
    ShellCommandArguments {
        command: "/bin/sh".to_string(),
        arguments: vec![
            "-c".to_string(),
            "trap '' TERM; while :; do sleep 60; done".to_string(),
        ],
        cwd: std::env::current_dir().expect("current directory"),
    }
}

#[cfg(windows)]
fn cancellation_tree_command(executable: &Path) -> ShellCommandArguments {
    ShellCommandArguments {
        command: executable.to_string_lossy().into_owned(),
        arguments: vec!["__command-test-tree".to_string()],
        cwd: std::env::current_dir().expect("current directory"),
    }
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
