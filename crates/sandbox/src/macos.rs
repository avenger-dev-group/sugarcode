use std::path::Path;

use crate::CommandSpec;
use crate::SandboxError;
use crate::SandboxPolicy;
use crate::SandboxSpawnError;
use crate::SupervisedChild;

const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";
const FILESYSTEM_READ_ONLY_V1_PROFILE: &str = "(version 1)\n(allow default)\n(deny file-write*)";

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
    let mut arguments = Vec::with_capacity(spec.arguments.len() + 4);
    arguments.push("-p".to_owned());
    arguments.push(profile.to_owned());
    arguments.push("--".to_owned());
    arguments.push(spec.command);
    arguments.extend(spec.arguments);
    crate::spawn_supervised(CommandSpec {
        command: SANDBOX_EXEC.to_owned(),
        arguments,
        cwd: spec.cwd,
        environment: spec.environment,
    })
    .map_err(|error| {
        SandboxSpawnError::Sandbox(SandboxError::unavailable(format!(
            "failed to launch {SANDBOX_EXEC}: {error}"
        )))
    })
}

fn probe_sandbox_exec() -> Result<(), SandboxError> {
    let metadata = std::fs::metadata(SANDBOX_EXEC).map_err(|error| {
        SandboxError::unavailable(format!("required {SANDBOX_EXEC} is unavailable: {error}"))
    })?;
    if !metadata.is_file() || !Path::new(SANDBOX_EXEC).is_absolute() {
        return Err(SandboxError::unavailable(format!(
            "required {SANDBOX_EXEC} is not a regular absolute executable"
        )));
    }
    let status = std::process::Command::new(SANDBOX_EXEC)
        .args(["-p", FILESYSTEM_READ_ONLY_V1_PROFILE, "--", "/usr/bin/true"])
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
            "{SANDBOX_EXEC} rejected filesystemReadOnlyV1"
        )));
    }
    Ok(())
}
