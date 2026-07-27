use std::path::Path;

use crate::CommandSandboxPolicy;
use crate::CommandSpec;
use crate::NetworkPolicy;
use crate::SandboxError;
use crate::SandboxPolicy;
use crate::SandboxSpawnError;
use crate::SupervisedChild;
use crate::WorkspaceWritePolicy;

const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";
const FILESYSTEM_READ_ONLY_V1_PROFILE: &str = "(version 1)\n(allow default)\n(deny file-write*)";
const FILESYSTEM_READ_ONLY_NETWORK_DENIED_V1_PROFILE: &str = concat!(
    "(version 1)\n",
    "(allow default)\n",
    "(deny file-write*)\n",
    "(deny network*)\n",
    "(allow system-socket (socket-domain AF_UNIX))",
);

pub(crate) fn probe(policy: SandboxPolicy) -> Result<(), SandboxError> {
    match policy {
        SandboxPolicy::FilesystemReadOnlyV1 => probe_sandbox_exec(),
    }
}

pub(crate) fn spawn(
    policy: SandboxPolicy,
    spec: CommandSpec,
) -> Result<SupervisedChild, SandboxSpawnError> {
    let profile = match policy {
        SandboxPolicy::FilesystemReadOnlyV1 => FILESYSTEM_READ_ONLY_V1_PROFILE,
    };
    spawn_with_profile(profile, spec, false)
}

pub(crate) fn probe_command(policy: CommandSandboxPolicy) -> Result<(), SandboxError> {
    match (policy.filesystem, policy.workspace_write, policy.network) {
        (SandboxPolicy::FilesystemReadOnlyV1, None, NetworkPolicy::NetworkDeniedV1) => {
            probe_profile(FILESYSTEM_READ_ONLY_NETWORK_DENIED_V1_PROFILE)
        }
        (
            SandboxPolicy::FilesystemReadOnlyV1,
            Some(WorkspaceWritePolicy::CommandWorkspaceWriteV1),
            NetworkPolicy::NetworkDeniedV1,
        ) => Err(SandboxError::unavailable(
            "commandWorkspaceWriteV1 is unavailable on macOS",
        )),
    }
}

pub(crate) fn spawn_command(
    policy: CommandSandboxPolicy,
    spec: CommandSpec,
) -> Result<SupervisedChild, SandboxSpawnError> {
    let profile = match (policy.filesystem, policy.workspace_write, policy.network) {
        (SandboxPolicy::FilesystemReadOnlyV1, None, NetworkPolicy::NetworkDeniedV1) => {
            FILESYSTEM_READ_ONLY_NETWORK_DENIED_V1_PROFILE
        }
        (
            SandboxPolicy::FilesystemReadOnlyV1,
            Some(WorkspaceWritePolicy::CommandWorkspaceWriteV1),
            NetworkPolicy::NetworkDeniedV1,
        ) => {
            return Err(SandboxSpawnError::Sandbox(SandboxError::unavailable(
                "commandWorkspaceWriteV1 is unavailable on macOS",
            )));
        }
    };
    spawn_with_profile(profile, spec, true)
}

fn spawn_with_profile(
    profile: &'static str,
    spec: CommandSpec,
    sanitize_descriptors: bool,
) -> Result<SupervisedChild, SandboxSpawnError> {
    let mut arguments = Vec::with_capacity(spec.arguments.len() + 4);
    arguments.push("-p".to_owned());
    arguments.push(profile.to_owned());
    arguments.push("--".to_owned());
    arguments.push(spec.command);
    arguments.extend(spec.arguments);
    let spec = CommandSpec {
        command: SANDBOX_EXEC.to_owned(),
        arguments,
        working_directory: spec.working_directory,
        environment: spec.environment,
    };
    if sanitize_descriptors {
        crate::process::spawn_supervised_sanitized(spec).map_err(|error| match error {
            SandboxSpawnError::Sandbox(error) => SandboxSpawnError::Sandbox(error),
            SandboxSpawnError::Process(error) => SandboxSpawnError::Sandbox(
                SandboxError::unavailable(format!("failed to launch {SANDBOX_EXEC}: {error}")),
            ),
        })
    } else {
        crate::spawn_supervised(spec).map_err(|error| {
            SandboxSpawnError::Sandbox(SandboxError::unavailable(format!(
                "failed to launch {SANDBOX_EXEC}: {error}"
            )))
        })
    }
}

fn probe_sandbox_exec() -> Result<(), SandboxError> {
    probe_profile(FILESYSTEM_READ_ONLY_V1_PROFILE)
}

fn probe_profile(profile: &'static str) -> Result<(), SandboxError> {
    let metadata = std::fs::metadata(SANDBOX_EXEC).map_err(|error| {
        SandboxError::unavailable(format!("required {SANDBOX_EXEC} is unavailable: {error}"))
    })?;
    if !metadata.is_file() || !Path::new(SANDBOX_EXEC).is_absolute() {
        return Err(SandboxError::unavailable(format!(
            "required {SANDBOX_EXEC} is not a regular absolute executable"
        )));
    }
    let status = std::process::Command::new(SANDBOX_EXEC)
        .args(["-p", profile, "--", "/usr/bin/true"])
        .env_clear()
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|error| {
            SandboxError::unavailable(format!("failed to probe {SANDBOX_EXEC}: {error}"))
        })?;
    if !status.success() {
        return Err(SandboxError::unavailable(format!(
            "{SANDBOX_EXEC} rejected the requested sandbox profile"
        )));
    }
    Ok(())
}
