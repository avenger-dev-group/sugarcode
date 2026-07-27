use super::*;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use crate::WorkspaceTool;

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
