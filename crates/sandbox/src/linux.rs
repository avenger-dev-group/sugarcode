use landlock::ABI;
use landlock::AccessFs;
use landlock::CompatLevel;
use landlock::Compatible;
use landlock::Ruleset;
use landlock::RulesetAttr;
use landlock::RulesetStatus;

use crate::CommandSpec;
use crate::SandboxError;
use crate::SandboxPolicy;
use crate::SandboxSpawnError;
use crate::SupervisedChild;

const REQUIRED_ABI: ABI = ABI::V3;

pub(crate) fn probe(policy: SandboxPolicy) -> Result<(), SandboxError> {
    match policy {
        SandboxPolicy::FilesystemReadOnlyV1 => build_ruleset().map(|_| ()),
    }
}

pub(crate) fn spawn(
    policy: SandboxPolicy,
    spec: CommandSpec,
) -> Result<SupervisedChild, SandboxSpawnError> {
    match policy {
        SandboxPolicy::FilesystemReadOnlyV1 => enforce_filesystem_read_only()?,
    }
    crate::spawn_supervised(spec).map_err(SandboxSpawnError::Process)
}

fn build_ruleset() -> Result<landlock::RulesetCreated, SandboxError> {
    Ruleset::default()
        .set_compatibility(CompatLevel::HardRequirement)
        .handle_access(AccessFs::from_write(REQUIRED_ABI))
        .and_then(Ruleset::create)
        .map_err(|error| SandboxError::unavailable(format!("Landlock ABI v3 unavailable: {error}")))
}

fn enforce_filesystem_read_only() -> Result<(), SandboxSpawnError> {
    let status = build_ruleset()
        .and_then(|ruleset| {
            ruleset.restrict_self().map_err(|error| {
                SandboxError::unavailable(format!("Landlock restriction failed: {error}"))
            })
        })
        .map_err(SandboxSpawnError::Sandbox)?;
    if status.ruleset != RulesetStatus::FullyEnforced || !status.no_new_privs {
        return Err(SandboxSpawnError::Sandbox(SandboxError::unavailable(
            "Landlock did not fully enforce filesystemReadOnlyV1",
        )));
    }
    Ok(())
}
