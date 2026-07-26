use seccompiler::BpfProgram;
use seccompiler::SeccompAction;
use seccompiler::SeccompCmpArgLen;
use seccompiler::SeccompCmpOp;
use seccompiler::SeccompCondition;
use seccompiler::SeccompFilter;
use seccompiler::SeccompRule;
use seccompiler::TargetArch;
use seccompiler::apply_filter;
use std::collections::BTreeMap;

use landlock::ABI;
use landlock::AccessFs;
use landlock::CompatLevel;
use landlock::Compatible;
use landlock::Ruleset;
use landlock::RulesetAttr;
use landlock::RulesetStatus;

use crate::CommandSandboxPolicy;
use crate::CommandSpec;
use crate::NetworkPolicy;
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

pub(crate) fn probe_command(policy: CommandSandboxPolicy) -> Result<(), SandboxError> {
    match (policy.filesystem, policy.network) {
        (SandboxPolicy::FilesystemReadOnlyV1, NetworkPolicy::NetworkDeniedV1) => {
            build_ruleset()?;
            build_network_denied_filter().map(|_| ())
        }
    }
}

pub(crate) fn spawn_command(
    policy: CommandSandboxPolicy,
    spec: CommandSpec,
) -> Result<SupervisedChild, SandboxSpawnError> {
    match (policy.filesystem, policy.network) {
        (SandboxPolicy::FilesystemReadOnlyV1, NetworkPolicy::NetworkDeniedV1) => {
            enforce_filesystem_read_only()?;
            install_network_denied_filter()?;
        }
    }
    crate::process::spawn_supervised_sanitized(spec).map_err(SandboxSpawnError::Process)
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

fn build_network_denied_filter() -> Result<BpfProgram, SandboxError> {
    let mut rules = BTreeMap::new();
    for syscall in [
        libc::SYS_socket,
        libc::SYS_connect,
        libc::SYS_accept,
        libc::SYS_accept4,
        libc::SYS_bind,
        libc::SYS_listen,
        libc::SYS_getpeername,
        libc::SYS_getsockname,
        libc::SYS_shutdown,
        libc::SYS_sendto,
        libc::SYS_sendmmsg,
        libc::SYS_recvmmsg,
        libc::SYS_getsockopt,
        libc::SYS_setsockopt,
        libc::SYS_ptrace,
        libc::SYS_process_vm_readv,
        libc::SYS_process_vm_writev,
        libc::SYS_pidfd_getfd,
        libc::SYS_io_uring_setup,
        libc::SYS_io_uring_enter,
        libc::SYS_io_uring_register,
    ] {
        rules.insert(syscall, Vec::new());
    }
    let deny_non_unix_socketpair = SeccompRule::new(vec![
        SeccompCondition::new(
            0,
            SeccompCmpArgLen::Dword,
            SeccompCmpOp::Ne,
            libc::AF_UNIX as u64,
        )
        .map_err(seccomp_build_error)?,
    ])
    .map_err(seccomp_build_error)?;
    rules.insert(libc::SYS_socketpair, vec![deny_non_unix_socketpair]);

    let architecture = target_architecture()?;
    let filter = SeccompFilter::new(
        rules,
        SeccompAction::Allow,
        SeccompAction::Errno(libc::EPERM as u32),
        architecture,
    )
    .map_err(seccomp_build_error)?;
    filter.try_into().map_err(seccomp_build_error)
}

fn target_architecture() -> Result<TargetArch, SandboxError> {
    #[cfg(target_arch = "x86_64")]
    {
        Ok(TargetArch::x86_64)
    }
    #[cfg(target_arch = "aarch64")]
    {
        Ok(TargetArch::aarch64)
    }
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    {
        Err(SandboxError::unavailable(
            "networkDeniedV1 is unsupported on this Linux architecture",
        ))
    }
}

fn install_network_denied_filter() -> Result<(), SandboxSpawnError> {
    let filter = build_network_denied_filter().map_err(SandboxSpawnError::Sandbox)?;
    apply_filter(&filter).map_err(|error| {
        SandboxSpawnError::Sandbox(SandboxError::unavailable(format!(
            "seccomp restriction failed: {error}"
        )))
    })
}

fn seccomp_build_error(error: impl std::fmt::Display) -> SandboxError {
    SandboxError::unavailable(format!("seccomp filter unavailable: {error}"))
}
