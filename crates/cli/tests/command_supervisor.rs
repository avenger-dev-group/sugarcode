#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::path::Path;
use std::path::PathBuf;
use sugarcode_tools::NativeShellCommandExecutor;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use sugarcode_tools::ShellCommandArguments;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use sugarcode_tools::ShellCommandExecution;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use sugarcode_tools::ShellCommandExecutor;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use sugarcode_tools::ShellCommandOutcome;
use sugarcode_tools::WorkspaceTool;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use tokio_util::sync::CancellationToken;

#[tokio::test]
#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn hidden_supervisor_executes_one_absolute_argv_command() {
    let workspace = tempfile::tempdir().expect("workspace");
    let executor = native_executor(workspace.path());
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
    assert_eq!(
        output.sandbox_policy,
        sugarcode_tools::CommandSandboxPolicy::FILESYSTEM_READ_ONLY_NETWORK_DENIED_V1
    );
}

#[tokio::test]
#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn cancellation_terminates_a_descendant_that_holds_output_pipes() {
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_sugarcode"));
    let workspace = tempfile::tempdir().expect("workspace");
    let executor = native_executor(workspace.path());
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
#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn approved_command_cannot_write_workspace_files() {
    let workspace = tempfile::tempdir().expect("workspace");
    let target = workspace.path().join("target.txt");
    std::fs::write(&target, "original").expect("write fixture");
    let executor = native_executor(workspace.path());
    assert_write_denied(&executor, workspace.path(), &target).await;
}

#[tokio::test]
#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn approved_command_cannot_write_outside_workspace() {
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    let target = outside.path().join("target.txt");
    std::fs::write(&target, "original").expect("write fixture");
    let executor = native_executor(workspace.path());
    assert_write_denied(&executor, workspace.path(), &target).await;
}

#[tokio::test]
#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn command_root_binding_ignores_directory_replacement() {
    let parent = tempfile::tempdir().expect("workspace parent");
    let workspace = parent.path().join("workspace");
    let moved_workspace = parent.path().join("moved-workspace");
    std::fs::create_dir(&workspace).expect("create workspace");
    std::fs::write(workspace.join("marker.txt"), "original").expect("write original marker");
    let executor = native_executor(&workspace);

    std::fs::rename(&workspace, &moved_workspace).expect("move original workspace");
    std::fs::create_dir(&workspace).expect("create replacement workspace");
    std::fs::write(workspace.join("marker.txt"), "replacement").expect("write replacement marker");

    assert_bound_marker(&executor, "original").await;
}

#[tokio::test]
#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn command_root_binding_ignores_symlink_replacement() {
    let parent = tempfile::tempdir().expect("workspace parent");
    let workspace = parent.path().join("workspace");
    let moved_workspace = parent.path().join("moved-workspace");
    let replacement = parent.path().join("replacement");
    std::fs::create_dir(&workspace).expect("create workspace");
    std::fs::create_dir(&replacement).expect("create replacement");
    std::fs::write(workspace.join("marker.txt"), "original").expect("write original marker");
    std::fs::write(replacement.join("marker.txt"), "replacement")
        .expect("write replacement marker");
    let executor = native_executor(&workspace);

    std::fs::rename(&workspace, &moved_workspace).expect("move original workspace");
    std::os::unix::fs::symlink(&replacement, &workspace).expect("replace workspace with symlink");

    assert_bound_marker(&executor, "original").await;
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn assert_write_denied(
    executor: &NativeShellCommandExecutor,
    workspace: &Path,
    target: &Path,
) {
    let execution = executor
        .execute(write_command(workspace, target), CancellationToken::new())
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

#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn assert_bound_marker(executor: &NativeShellCommandExecutor, expected: &str) {
    let execution = executor
        .execute(
            ShellCommandArguments {
                command: "/bin/cat".to_string(),
                arguments: vec!["marker.txt".to_string()],
            },
            CancellationToken::new(),
        )
        .await;
    let ShellCommandExecution::Completed(output) = execution else {
        panic!("expected completed marker read, got {execution:?}");
    };
    assert_eq!(output.stdout, expected);
    assert!(matches!(
        output.outcome,
        ShellCommandOutcome::ExitCode { code: 0 }
    ));
}

#[test]
#[cfg(windows)]
fn native_shell_fails_closed_when_network_policy_is_unavailable() {
    let workspace = tempfile::tempdir().expect("workspace");
    let workspace = WorkspaceTool::open(workspace.path()).expect("open workspace");
    let command_root = workspace
        .command_workspace_root()
        .expect("bind command workspace root");
    let error = NativeShellCommandExecutor::new(
        PathBuf::from(env!("CARGO_BIN_EXE_sugarcode")),
        command_root,
    )
    .expect_err("networkDeniedV1 must fail closed on Windows");
    assert_eq!(error.kind(), sugarcode_tools::SandboxErrorKind::Unavailable);
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn write_command(_cwd: &Path, target: &Path) -> ShellCommandArguments {
    ShellCommandArguments {
        command: "/bin/sh".to_string(),
        arguments: vec![
            "-c".to_string(),
            "printf changed > \"$1\"".to_string(),
            "sugarcode-test".to_string(),
            target.to_string_lossy().into_owned(),
        ],
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn cancellation_tree_command(_executable: &Path) -> ShellCommandArguments {
    ShellCommandArguments {
        command: "/bin/sh".to_string(),
        arguments: vec![
            "-c".to_string(),
            "trap '' TERM; while :; do sleep 60; done".to_string(),
        ],
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn test_command() -> ShellCommandArguments {
    ShellCommandArguments {
        command: "/bin/echo".to_string(),
        arguments: vec!["supervisor-ok".to_string()],
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn native_executor(workspace_root: &Path) -> NativeShellCommandExecutor {
    let workspace = WorkspaceTool::open(workspace_root).expect("open workspace");
    let command_root = workspace
        .command_workspace_root()
        .expect("bind command workspace root");
    NativeShellCommandExecutor::new(PathBuf::from(env!("CARGO_BIN_EXE_sugarcode")), command_root)
        .expect("native read-only sandbox")
}
