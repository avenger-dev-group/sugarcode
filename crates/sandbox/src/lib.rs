#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod process;
#[cfg(windows)]
mod windows;

pub use process::CommandSpec;
pub use process::SupervisedChild;
pub use process::spawn_supervised;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxPolicy {
    FilesystemReadOnlyV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxErrorKind {
    UnsupportedPlatform,
    Unavailable,
}

#[derive(Debug)]
pub struct SandboxError {
    kind: SandboxErrorKind,
    message: String,
}

impl SandboxError {
    pub fn kind(&self) -> SandboxErrorKind {
        self.kind
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            kind: SandboxErrorKind::Unavailable,
            message: message.into(),
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    fn unsupported() -> Self {
        Self {
            kind: SandboxErrorKind::UnsupportedPlatform,
            message: "filesystemReadOnlyV1 is unsupported on this platform".to_owned(),
        }
    }
}

impl std::fmt::Display for SandboxError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for SandboxError {}

#[derive(Debug)]
pub enum SandboxSpawnError {
    Sandbox(SandboxError),
    Process(std::io::Error),
}

impl std::fmt::Display for SandboxSpawnError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sandbox(error) => error.fmt(formatter),
            Self::Process(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for SandboxSpawnError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Sandbox(error) => Some(error),
            Self::Process(error) => Some(error),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SandboxAdapter {
    policy: SandboxPolicy,
}

impl SandboxAdapter {
    pub fn probe(policy: SandboxPolicy) -> Result<Self, SandboxError> {
        platform_probe(policy)?;
        Ok(Self { policy })
    }

    pub fn policy(&self) -> SandboxPolicy {
        self.policy
    }

    pub fn spawn(&self, spec: CommandSpec) -> Result<SupervisedChild, SandboxSpawnError> {
        platform_spawn(self.policy, spec)
    }
}

#[cfg(target_os = "linux")]
fn platform_probe(policy: SandboxPolicy) -> Result<(), SandboxError> {
    linux::probe(policy)
}

#[cfg(target_os = "linux")]
fn platform_spawn(
    policy: SandboxPolicy,
    spec: CommandSpec,
) -> Result<SupervisedChild, SandboxSpawnError> {
    linux::spawn(policy, spec)
}

#[cfg(target_os = "macos")]
fn platform_probe(policy: SandboxPolicy) -> Result<(), SandboxError> {
    macos::probe(policy)
}

#[cfg(target_os = "macos")]
fn platform_spawn(
    policy: SandboxPolicy,
    spec: CommandSpec,
) -> Result<SupervisedChild, SandboxSpawnError> {
    macos::spawn(policy, spec)
}

#[cfg(windows)]
fn platform_probe(policy: SandboxPolicy) -> Result<(), SandboxError> {
    windows::probe(policy)
}

#[cfg(windows)]
fn platform_spawn(
    policy: SandboxPolicy,
    spec: CommandSpec,
) -> Result<SupervisedChild, SandboxSpawnError> {
    windows::spawn(policy, spec)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn platform_probe(_policy: SandboxPolicy) -> Result<(), SandboxError> {
    Err(SandboxError::unsupported())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn platform_spawn(
    _policy: SandboxPolicy,
    _spec: CommandSpec,
) -> Result<SupervisedChild, SandboxSpawnError> {
    Err(SandboxSpawnError::Sandbox(SandboxError::unsupported()))
}
