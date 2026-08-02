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
    assert!(!format!("{:?}", CommandEnvironment(environment)).contains("model-secret"));
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
