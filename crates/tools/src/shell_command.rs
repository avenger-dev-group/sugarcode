use crate::CommandWorkspaceRoot;
#[cfg(unix)]
use crate::workspace_command_root::CommandWorkspaceRootIdentity;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt;
use std::future::Future;
use std::io::Read;
use std::io::Write;
#[cfg(target_os = "macos")]
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::mpsc as std_mpsc;
use std::time::Duration;
use std::time::Instant;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

pub const MAX_SHELL_COMMAND_BYTES: usize = 32 * 1_024;
pub const MAX_SHELL_ARGUMENT_COUNT: usize = 64;
pub const MAX_SHELL_ARGUMENT_BYTES: usize = 8 * 1_024;
pub const MAX_SHELL_TOTAL_ARGUMENT_BYTES: usize = 32 * 1_024;
pub const MAX_SHELL_OUTPUT_BYTES: usize = 32 * 1_024;
pub const DEFAULT_FULL_ACCESS_SHELL_TIMEOUT_MS: u64 = 300_000;
pub const MAX_FULL_ACCESS_SHELL_TIMEOUT_MS: u64 = 600_000;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const SUPERVISOR_WATCHDOG_TIMEOUT: Duration = Duration::from_secs(35);
#[cfg(unix)]
const SUPERVISOR_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const SUPERVISOR_RESULT_BYTES: usize = 2 * MAX_SHELL_OUTPUT_BYTES + 16 * 1_024;
const SANDBOX_PROBE_SENTINEL: &str = "sugarcode-command-sandbox-probe-ok";
const MAX_COMMAND_ENVIRONMENT_VARIABLES: usize = 256;
const MAX_COMMAND_ENVIRONMENT_BYTES: usize = 128 * 1_024;
const SENSITIVE_ENVIRONMENT_MARKERS: &[&str] = &[
    "KEY",
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSWD",
    "CREDENTIAL",
    "AUTH",
    "COOKIE",
];
const PRIORITY_ENVIRONMENT_NAMES: &[&str] = &[
    "PATH",
    "PATHEXT",
    "HOME",
    "USERPROFILE",
    "SYSTEMROOT",
    "WINDIR",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOGNAME",
    "USER",
    "USERNAME",
    "JAVA_HOME",
    "NVM_BIN",
    "NVM_DIR",
    "PNPM_HOME",
    "VOLTA_HOME",
    "ASDF_DATA_DIR",
    "MISE_DATA_DIR",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "GOPATH",
    "GOROOT",
    "VIRTUAL_ENV",
    "CONDA_PREFIX",
    "BUN_INSTALL",
    "DENO_INSTALL",
    "SDKMAN_DIR",
    "HOMEBREW_PREFIX",
];

pub type ShellCommandFuture = Pin<Box<dyn Future<Output = ShellCommandExecution> + Send + 'static>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellCommandArguments {
    pub command: String,
    pub arguments: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct FullAccessShellArguments {
    pub command: String,
    pub cwd: String,
    pub timeout_ms: u64,
    pub output_tx: Option<tokio::sync::mpsc::UnboundedSender<ShellOutputChunk>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellOutputStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellOutputChunk {
    pub stream: ShellOutputStream,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellCommandExecution {
    Completed(ShellCommandOutput),
    FullAccessCompleted(ShellCommandOutput),
    Error(ShellCommandErrorKind),
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellCommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub duration_ms: u64,
    pub outcome: ShellCommandOutcome,
    pub sandbox_policy: sugarcode_sandbox::CommandSandboxPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ShellCommandOutcome {
    ExitCode { code: i64 },
    Signal { signal: i32 },
    TimedOut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShellCommandErrorKind {
    InvalidArguments,
    CommandNotFound,
    AccessDenied,
    SpawnFailed,
    ProcessControlUnavailable,
    SandboxUnavailable,
    Unavailable,
}

impl fmt::Display for ShellCommandErrorKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidArguments => "invalidArguments",
            Self::CommandNotFound => "commandNotFound",
            Self::AccessDenied => "accessDenied",
            Self::SpawnFailed => "spawnFailed",
            Self::ProcessControlUnavailable => "processControlUnavailable",
            Self::SandboxUnavailable => "sandboxUnavailable",
            Self::Unavailable => "unavailable",
        })
    }
}

pub trait ShellCommandExecutor: fmt::Debug + Send + Sync {
    fn sandbox_policy(&self) -> sugarcode_sandbox::CommandSandboxPolicy;

    fn workspace_root_path(&self) -> Option<&Path> {
        None
    }

    fn execute(
        &self,
        arguments: ShellCommandArguments,
        cancellation: CancellationToken,
    ) -> ShellCommandFuture;

    fn execute_full_access(
        &self,
        arguments: FullAccessShellArguments,
        cancellation: CancellationToken,
    ) -> ShellCommandFuture {
        let _ = (arguments, cancellation);
        Box::pin(async { ShellCommandExecution::Error(ShellCommandErrorKind::Unavailable) })
    }
}

#[derive(Debug, Clone)]
pub struct NativeShellCommandExecutor {
    supervisor_executable: PathBuf,
    sandbox_policy: sugarcode_sandbox::CommandSandboxPolicy,
    workspace_root: Arc<CommandWorkspaceRoot>,
    environment: Arc<CommandEnvironment>,
}

#[derive(Debug, Clone)]
pub struct EmbeddedShellCommandExecutor {
    sandbox_policy: sugarcode_sandbox::CommandSandboxPolicy,
    workspace_root: Arc<CommandWorkspaceRoot>,
    environment: Arc<CommandEnvironment>,
}

impl EmbeddedShellCommandExecutor {
    pub fn new(
        workspace_root: CommandWorkspaceRoot,
    ) -> Result<Self, sugarcode_sandbox::SandboxError> {
        Self::new_with_policy(
            workspace_root,
            sugarcode_sandbox::CommandSandboxPolicy::FILESYSTEM_READ_ONLY_NETWORK_DENIED_V1,
        )
    }

    pub fn new_with_policy(
        workspace_root: CommandWorkspaceRoot,
        sandbox_policy: sugarcode_sandbox::CommandSandboxPolicy,
    ) -> Result<Self, sugarcode_sandbox::SandboxError> {
        #[cfg(unix)]
        sugarcode_sandbox::CommandSandboxAdapter::probe(sandbox_policy)?;
        #[cfg(not(any(unix, windows)))]
        return Err(sugarcode_sandbox::SandboxError::unavailable(
            "native command execution is unavailable on this platform",
        ));
        Ok(Self {
            sandbox_policy,
            workspace_root: Arc::new(workspace_root),
            environment: Arc::new(CommandEnvironment(host_command_environment())),
        })
    }
}

#[derive(Clone)]
struct CommandEnvironment(Vec<(String, String)>);

impl fmt::Debug for CommandEnvironment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CommandEnvironment")
            .field("variable_count", &self.0.len())
            .finish()
    }
}

impl NativeShellCommandExecutor {
    pub fn new(
        supervisor_executable: PathBuf,
        workspace_root: CommandWorkspaceRoot,
    ) -> Result<Self, sugarcode_sandbox::SandboxError> {
        Self::new_with_policy(
            supervisor_executable,
            workspace_root,
            sugarcode_sandbox::CommandSandboxPolicy::FILESYSTEM_READ_ONLY_NETWORK_DENIED_V1,
        )
    }

    pub fn new_with_policy(
        supervisor_executable: PathBuf,
        workspace_root: CommandWorkspaceRoot,
        sandbox_policy: sugarcode_sandbox::CommandSandboxPolicy,
    ) -> Result<Self, sugarcode_sandbox::SandboxError> {
        let environment = Arc::new(CommandEnvironment(host_command_environment()));
        #[cfg(unix)]
        let sandbox_policy = {
            let adapter = sugarcode_sandbox::CommandSandboxAdapter::probe(sandbox_policy)?;
            probe_native_supervisor(
                &supervisor_executable,
                adapter.policy(),
                &workspace_root,
                &environment.0,
            )
            .map_err(|error| {
                sugarcode_sandbox::SandboxError::unavailable(format!(
                    "command sandbox supervisor probe failed: {error}"
                ))
            })?;
            adapter.policy()
        };
        // Windows currently has no read-only command sandbox supervisor, but it
        // does support the separately approved Full Access shell executor.
        // Retain the configured policy so direct calls still fail closed at
        // execution time instead of disabling the whole executor at startup.
        #[cfg(not(any(unix, windows)))]
        return Err(sugarcode_sandbox::SandboxError::unavailable(
            "native command execution is unavailable on this platform",
        ));
        Ok(Self {
            supervisor_executable,
            sandbox_policy,
            workspace_root: Arc::new(workspace_root),
            environment,
        })
    }
}

#[cfg(unix)]
fn probe_native_supervisor(
    executable: &Path,
    sandbox_policy: sugarcode_sandbox::CommandSandboxPolicy,
    workspace_root: &CommandWorkspaceRoot,
    environment: &[(String, String)],
) -> Result<(), ShellCommandErrorKind> {
    let directory = workspace_root
        .try_clone_directory()
        .map_err(|_| ShellCommandErrorKind::SandboxUnavailable)?;
    use std::os::fd::AsRawFd;
    let workspace_root_fd = directory.as_raw_fd();
    let request = SupervisorRequest {
        command: executable.to_string_lossy().into_owned(),
        arguments: vec!["__command-sandbox-probe".to_owned()],
        environment: environment.to_vec(),
        sandbox_policy,
        workspace_root_fd,
        workspace_root_identity: workspace_root.identity(),
    };
    let mut command = std::process::Command::new(executable);
    command
        .arg("__command-supervisor")
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    configure_minimal_environment_std(&mut command);
    configure_workspace_root_inheritance_std(&mut command, workspace_root_fd)?;
    let mut child = command
        .spawn()
        .map_err(|_| ShellCommandErrorKind::SandboxUnavailable)?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or(ShellCommandErrorKind::SandboxUnavailable)?;
    let mut encoded =
        serde_json::to_vec(&request).map_err(|_| ShellCommandErrorKind::SandboxUnavailable)?;
    encoded.push(b'\n');
    stdin
        .write_all(&encoded)
        .and_then(|()| stdin.flush())
        .map_err(|_| ShellCommandErrorKind::SandboxUnavailable)?;

    let deadline = Instant::now() + SUPERVISOR_PROBE_TIMEOUT;
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| ShellCommandErrorKind::SandboxUnavailable)?
        {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = stdin.write_all(b"{\"type\":\"cancel\"}\n");
            let _ = stdin.flush();
            let _ = child.kill();
            let _ = child.wait();
            return Err(ShellCommandErrorKind::SandboxUnavailable);
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    drop(stdin);
    let mut response = Vec::new();
    child
        .stdout
        .take()
        .ok_or(ShellCommandErrorKind::SandboxUnavailable)?
        .take(u64::try_from(SUPERVISOR_RESULT_BYTES).unwrap_or(u64::MAX))
        .read_to_end(&mut response)
        .map_err(|_| ShellCommandErrorKind::SandboxUnavailable)?;
    if !status.success() {
        return Err(ShellCommandErrorKind::SandboxUnavailable);
    }
    match serde_json::from_slice::<SupervisorResponse>(&response) {
        Ok(SupervisorResponse::Completed(output))
            if output.sandbox_policy == sandbox_policy
                && matches!(output.outcome, ShellCommandOutcome::ExitCode { code: 0 })
                && output.stdout.contains(SANDBOX_PROBE_SENTINEL) =>
        {
            Ok(())
        }
        Ok(SupervisorResponse::Completed(_)) | Ok(SupervisorResponse::Error(_)) | Err(_) => {
            Err(ShellCommandErrorKind::SandboxUnavailable)
        }
    }
}

#[cfg(not(any(unix, windows)))]
fn probe_native_supervisor(
    _executable: &Path,
    _sandbox_policy: sugarcode_sandbox::CommandSandboxPolicy,
    _workspace_root: &CommandWorkspaceRoot,
    _environment: &[(String, String)],
) -> Result<(), ShellCommandErrorKind> {
    Err(ShellCommandErrorKind::SandboxUnavailable)
}

impl ShellCommandExecutor for NativeShellCommandExecutor {
    fn sandbox_policy(&self) -> sugarcode_sandbox::CommandSandboxPolicy {
        self.sandbox_policy
    }

    fn workspace_root_path(&self) -> Option<&Path> {
        Some(self.workspace_root.ambient_path())
    }

    fn execute(
        &self,
        arguments: ShellCommandArguments,
        cancellation: CancellationToken,
    ) -> ShellCommandFuture {
        let executable = self.supervisor_executable.clone();
        let sandbox_policy = self.sandbox_policy;
        let workspace_root = Arc::clone(&self.workspace_root);
        let environment = Arc::clone(&self.environment);
        Box::pin(async move {
            if validate_arguments(&arguments).is_err() {
                return ShellCommandExecution::Error(ShellCommandErrorKind::InvalidArguments);
            }
            let request = SupervisorRequest {
                command: arguments.command,
                arguments: arguments.arguments,
                environment: environment.0.clone(),
                sandbox_policy,
                #[cfg(unix)]
                workspace_root_fd: -1,
                #[cfg(unix)]
                workspace_root_identity: workspace_root.identity(),
            };
            let _write_permit = if sandbox_policy
                == sugarcode_sandbox::CommandSandboxPolicy::FILESYSTEM_READ_ONLY_COMMAND_WORKSPACE_WRITE_NETWORK_DENIED_V1
            {
                Some(workspace_root.acquire_write().await)
            } else {
                None
            };
            run_native(executable, request, workspace_root, cancellation).await
        })
    }

    fn execute_full_access(
        &self,
        arguments: FullAccessShellArguments,
        cancellation: CancellationToken,
    ) -> ShellCommandFuture {
        let workspace_root = Arc::clone(&self.workspace_root);
        let environment = Arc::clone(&self.environment);
        Box::pin(async move {
            execute_full_access_shell(arguments, workspace_root, environment, cancellation).await
        })
    }
}

impl ShellCommandExecutor for EmbeddedShellCommandExecutor {
    fn sandbox_policy(&self) -> sugarcode_sandbox::CommandSandboxPolicy {
        self.sandbox_policy
    }

    fn workspace_root_path(&self) -> Option<&Path> {
        Some(self.workspace_root.ambient_path())
    }

    fn execute(
        &self,
        arguments: ShellCommandArguments,
        cancellation: CancellationToken,
    ) -> ShellCommandFuture {
        let sandbox_policy = self.sandbox_policy;
        let workspace_root = Arc::clone(&self.workspace_root);
        let environment = Arc::clone(&self.environment);
        Box::pin(async move {
            if validate_arguments(&arguments).is_err() {
                return ShellCommandExecution::Error(ShellCommandErrorKind::InvalidArguments);
            }
            #[cfg(unix)]
            let request = {
                use std::os::fd::IntoRawFd;

                let directory = match workspace_root.try_clone_directory() {
                    Ok(directory) => directory,
                    Err(_) => {
                        return ShellCommandExecution::Error(
                            ShellCommandErrorKind::SandboxUnavailable,
                        );
                    }
                };
                SupervisorRequest {
                    command: arguments.command,
                    arguments: arguments.arguments,
                    environment: environment.0.clone(),
                    sandbox_policy,
                    workspace_root_fd: directory.into_raw_fd(),
                    workspace_root_identity: workspace_root.identity(),
                }
            };
            #[cfg(windows)]
            {
                let _ = (
                    arguments,
                    sandbox_policy,
                    workspace_root,
                    environment,
                    cancellation,
                );
                ShellCommandExecution::Error(ShellCommandErrorKind::SandboxUnavailable)
            }
            #[cfg(unix)]
            {
                let _write_permit = if sandbox_policy
                    == sugarcode_sandbox::CommandSandboxPolicy::FILESYSTEM_READ_ONLY_COMMAND_WORKSPACE_WRITE_NETWORK_DENIED_V1
                {
                    Some(workspace_root.acquire_write().await)
                } else {
                    None
                };
                let (cancel_tx, cancel_rx) = std_mpsc::channel();
                let cancellation_wait = cancellation.clone();
                let cancel_task = tokio::spawn(async move {
                    cancellation_wait.cancelled().await;
                    let _ = cancel_tx.send(());
                });
                let execution =
                    tokio::task::spawn_blocking(move || execute_supervised(request, cancel_rx))
                        .await;
                cancel_task.abort();
                if cancellation.is_cancelled() {
                    return ShellCommandExecution::Cancelled;
                }
                match execution {
                    Ok(Ok(output)) => ShellCommandExecution::Completed(output),
                    Ok(Err(kind)) => ShellCommandExecution::Error(kind),
                    Err(_) => ShellCommandExecution::Error(ShellCommandErrorKind::Unavailable),
                }
            }
        })
    }

    fn execute_full_access(
        &self,
        arguments: FullAccessShellArguments,
        cancellation: CancellationToken,
    ) -> ShellCommandFuture {
        let workspace_root = Arc::clone(&self.workspace_root);
        let environment = Arc::clone(&self.environment);
        Box::pin(async move {
            execute_full_access_shell(arguments, workspace_root, environment, cancellation).await
        })
    }
}

async fn execute_full_access_shell(
    arguments: FullAccessShellArguments,
    workspace_root: Arc<CommandWorkspaceRoot>,
    environment: Arc<CommandEnvironment>,
    cancellation: CancellationToken,
) -> ShellCommandExecution {
    if arguments.command.is_empty()
        || arguments.command.len() > MAX_SHELL_COMMAND_BYTES
        || arguments.command.contains('\0')
        || arguments.timeout_ms == 0
        || arguments.timeout_ms > MAX_FULL_ACCESS_SHELL_TIMEOUT_MS
    {
        return ShellCommandExecution::Error(ShellCommandErrorKind::InvalidArguments);
    }
    let cwd = if arguments.cwd == "." {
        workspace_root.ambient_path().to_path_buf()
    } else {
        let path = Path::new(&arguments.cwd);
        if path.is_absolute() {
            if path != workspace_root.ambient_path() {
                return ShellCommandExecution::Error(ShellCommandErrorKind::InvalidArguments);
            }
            workspace_root.ambient_path().to_path_buf()
        } else if path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
        {
            return ShellCommandExecution::Error(ShellCommandErrorKind::InvalidArguments);
        } else {
            workspace_root.ambient_path().join(path)
        }
    };

    #[cfg(target_os = "macos")]
    let (shell, shell_arguments) = {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|shell| Path::new(shell).is_absolute())
            .unwrap_or_else(|| "/bin/zsh".to_string());
        (shell, vec!["-lc".to_string(), arguments.command])
    };
    #[cfg(windows)]
    let (shell, shell_arguments) = {
        let shell = std::env::var("COMSPEC")
            .ok()
            .filter(|shell| Path::new(shell).is_absolute())
            .unwrap_or_else(|| r"C:\Windows\System32\cmd.exe".to_string());
        (shell, vec!["/C".to_string(), arguments.command])
    };
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (cwd, workspace_root, environment, cancellation);
        return ShellCommandExecution::Error(ShellCommandErrorKind::Unavailable);
    }
    #[cfg(any(target_os = "macos", windows))]
    {
        let started = Instant::now();
        let mut command = Command::new(shell);
        command
            .args(shell_arguments)
            .current_dir(cwd)
            .env_clear()
            .envs(environment.0.iter().cloned())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(target_os = "macos")]
        unsafe {
            command.as_std_mut().pre_exec(|| {
                if libc::setpgid(0, 0) == 0 {
                    Ok(())
                } else {
                    Err(std::io::Error::last_os_error())
                }
            });
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => return ShellCommandExecution::Error(map_spawn_error(&error)),
        };
        #[cfg(windows)]
        let job = match windows_job::Job::assign(&child) {
            Ok(job) => Some(job),
            Err(kind) => {
                let _ = child.kill().await;
                return ShellCommandExecution::Error(kind);
            }
        };
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => return ShellCommandExecution::Error(ShellCommandErrorKind::Unavailable),
        };
        let stderr = match child.stderr.take() {
            Some(stderr) => stderr,
            None => return ShellCommandExecution::Error(ShellCommandErrorKind::Unavailable),
        };
        let stdout_reader = tokio::spawn(read_bounded_async(
            stdout,
            ShellOutputStream::Stdout,
            arguments.output_tx.clone(),
        ));
        let stderr_reader = tokio::spawn(read_bounded_async(
            stderr,
            ShellOutputStream::Stderr,
            arguments.output_tx,
        ));
        let timeout = Duration::from_millis(arguments.timeout_ms);
        let (status, timed_out) = tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                terminate_full_access_tree(&mut child);
                let _ = child.wait().await;
                stdout_reader.abort();
                stderr_reader.abort();
                return ShellCommandExecution::Cancelled;
            }
            _ = tokio::time::sleep(timeout) => {
                terminate_full_access_tree(&mut child);
                (child.wait().await.ok(), true)
            }
            status = child.wait() => (status.ok(), false),
        };
        #[cfg(windows)]
        drop(job);
        let stdout = match stdout_reader.await {
            Ok(output) => output,
            Err(_) => return ShellCommandExecution::Error(ShellCommandErrorKind::Unavailable),
        };
        let stderr = match stderr_reader.await {
            Ok(output) => output,
            Err(_) => return ShellCommandExecution::Error(ShellCommandErrorKind::Unavailable),
        };
        let outcome = if timed_out {
            ShellCommandOutcome::TimedOut
        } else if let Some(status) = status {
            exit_outcome(status)
        } else {
            return ShellCommandExecution::Error(ShellCommandErrorKind::Unavailable);
        };
        ShellCommandExecution::FullAccessCompleted(ShellCommandOutput {
            stdout: String::from_utf8_lossy(&stdout.retained).into_owned(),
            stderr: String::from_utf8_lossy(&stderr.retained).into_owned(),
            stdout_bytes: stdout.observed,
            stderr_bytes: stderr.observed,
            stdout_truncated: stdout.truncated,
            stderr_truncated: stderr.truncated,
            duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            outcome,
            sandbox_policy:
                sugarcode_sandbox::CommandSandboxPolicy::FILESYSTEM_READ_ONLY_NETWORK_DENIED_V1,
        })
    }
}

#[cfg(any(target_os = "macos", windows))]
async fn read_bounded_async(
    mut reader: impl tokio::io::AsyncRead + Unpin,
    stream: ShellOutputStream,
    output_tx: Option<tokio::sync::mpsc::UnboundedSender<ShellOutputChunk>>,
) -> BoundedOutput {
    let mut retained = Vec::with_capacity(MAX_SHELL_OUTPUT_BYTES);
    let mut observed = 0u64;
    let mut buffer = [0u8; 8 * 1_024];
    loop {
        let read = match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        observed = observed.saturating_add(u64::try_from(read).unwrap_or(u64::MAX));
        let remaining = MAX_SHELL_OUTPUT_BYTES.saturating_sub(retained.len());
        let emitted = read.min(remaining);
        retained.extend_from_slice(&buffer[..emitted]);
        if emitted > 0
            && let Some(output_tx) = output_tx.as_ref()
        {
            let _ = output_tx.send(ShellOutputChunk {
                stream,
                content: String::from_utf8_lossy(&buffer[..emitted]).into_owned(),
            });
        }
    }
    BoundedOutput {
        truncated: observed > u64::try_from(retained.len()).unwrap_or(u64::MAX),
        retained,
        observed,
    }
}

#[cfg(target_os = "macos")]
fn terminate_full_access_tree(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        // SAFETY: the child starts a dedicated process group with its pid as pgid.
        unsafe {
            libc::killpg(pid as i32, libc::SIGKILL);
        }
    }
}

#[cfg(windows)]
fn terminate_full_access_tree(child: &mut tokio::process::Child) {
    let _ = child.start_kill();
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupervisorRequest {
    command: String,
    arguments: Vec<String>,
    environment: Vec<(String, String)>,
    sandbox_policy: sugarcode_sandbox::CommandSandboxPolicy,
    #[cfg(unix)]
    workspace_root_fd: i32,
    #[cfg(unix)]
    workspace_root_identity: CommandWorkspaceRootIdentity,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
enum SupervisorResponse {
    Completed(ShellCommandOutput),
    Error(ShellCommandErrorKind),
}

async fn run_native(
    executable: PathBuf,
    request: SupervisorRequest,
    workspace_root: Arc<CommandWorkspaceRoot>,
    cancellation: CancellationToken,
) -> ShellCommandExecution {
    #[cfg(unix)]
    let (request, directory) = {
        let mut request = request;
        let directory = match workspace_root.try_clone_directory() {
            Ok(directory) => directory,
            Err(_) => {
                return ShellCommandExecution::Error(ShellCommandErrorKind::SandboxUnavailable);
            }
        };
        {
            use std::os::fd::AsRawFd;
            request.workspace_root_fd = directory.as_raw_fd();
        }
        (request, directory)
    };
    #[cfg(not(unix))]
    drop(workspace_root);
    let requested_policy = request.sandbox_policy;
    let mut command = Command::new(executable);
    command
        .arg("__command-supervisor")
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    configure_minimal_environment_tokio(&mut command);
    #[cfg(unix)]
    if configure_workspace_root_inheritance_tokio(&mut command, request.workspace_root_fd).is_err()
    {
        return ShellCommandExecution::Error(ShellCommandErrorKind::SandboxUnavailable);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return ShellCommandExecution::Error(map_spawn_error(&error)),
    };
    #[cfg(unix)]
    drop(directory);

    #[cfg(windows)]
    let job = match windows_job::Job::assign(&child) {
        Ok(job) => Some(job),
        Err(kind) => {
            let _ = child.kill().await;
            return ShellCommandExecution::Error(kind);
        }
    };

    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill().await;
        return ShellCommandExecution::Error(ShellCommandErrorKind::Unavailable);
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill().await;
        return ShellCommandExecution::Error(ShellCommandErrorKind::Unavailable);
    };
    let mut encoded = match serde_json::to_vec(&request) {
        Ok(encoded) => encoded,
        Err(_) => {
            let _ = child.kill().await;
            return ShellCommandExecution::Error(ShellCommandErrorKind::InvalidArguments);
        }
    };
    encoded.push(b'\n');
    if stdin.write_all(&encoded).await.is_err() || stdin.flush().await.is_err() {
        let _ = child.kill().await;
        return ShellCommandExecution::Error(ShellCommandErrorKind::Unavailable);
    }

    let mut read_response = tokio::spawn(async move {
        let mut response = Vec::new();
        let result = stdout
            .take(u64::try_from(SUPERVISOR_RESULT_BYTES).unwrap_or(u64::MAX))
            .read_to_end(&mut response)
            .await;
        (result, response)
    });
    let (result, response) = tokio::select! {
        biased;
        _ = cancellation.cancelled() => {
            let _ = stdin.write_all(b"{\"type\":\"cancel\"}\n").await;
            let _ = stdin.flush().await;
            drop(stdin);
            #[cfg(windows)]
            if let Some(job) = &job {
                job.terminate();
            }
            if tokio::time::timeout(Duration::from_secs(5), child.wait()).await.is_err() {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
            read_response.abort();
            return ShellCommandExecution::Cancelled;
        }
        _ = tokio::time::sleep(SUPERVISOR_WATCHDOG_TIMEOUT) => {
            let _ = stdin.write_all(b"{\"type\":\"cancel\"}\n").await;
            let _ = stdin.flush().await;
            drop(stdin);
            #[cfg(windows)]
            if let Some(job) = &job {
                job.terminate();
            }
            if tokio::time::timeout(Duration::from_secs(5), child.wait()).await.is_err() {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
            read_response.abort();
            return ShellCommandExecution::Error(ShellCommandErrorKind::SandboxUnavailable);
        }
        result = &mut read_response => match result {
            Ok(result) => result,
            Err(_) => {
                let _ = child.kill().await;
                return ShellCommandExecution::Error(ShellCommandErrorKind::Unavailable);
            }
        },
    };
    if result.is_err() {
        let _ = child.kill().await;
        return ShellCommandExecution::Error(ShellCommandErrorKind::Unavailable);
    }
    let status = match child.wait().await {
        Ok(status) => status,
        Err(_) => return ShellCommandExecution::Error(ShellCommandErrorKind::Unavailable),
    };
    if !status.success() && response.is_empty() {
        return ShellCommandExecution::Error(ShellCommandErrorKind::Unavailable);
    }
    match serde_json::from_slice::<SupervisorResponse>(&response) {
        Ok(SupervisorResponse::Completed(output)) if output.sandbox_policy == requested_policy => {
            ShellCommandExecution::Completed(output)
        }
        Ok(SupervisorResponse::Completed(_)) => {
            ShellCommandExecution::Error(ShellCommandErrorKind::SandboxUnavailable)
        }
        Ok(SupervisorResponse::Error(kind)) => ShellCommandExecution::Error(kind),
        Err(_) => ShellCommandExecution::Error(ShellCommandErrorKind::Unavailable),
    }
}

pub fn run_shell_command_supervisor() -> Result<(), ShellCommandErrorKind> {
    let mut request_line = String::new();
    std::io::stdin()
        .read_line(&mut request_line)
        .map_err(|_| ShellCommandErrorKind::Unavailable)?;
    let request: SupervisorRequest =
        serde_json::from_str(&request_line).map_err(|_| ShellCommandErrorKind::InvalidArguments)?;
    validate_request(&request)?;

    let (cancel_tx, cancel_rx) = std_mpsc::channel();
    std::thread::spawn(move || {
        let mut control = String::new();
        let _ = std::io::stdin().read_line(&mut control);
        let _ = cancel_tx.send(());
    });
    let response = match execute_supervised(request, cancel_rx) {
        Ok(output) => SupervisorResponse::Completed(output),
        Err(kind) => SupervisorResponse::Error(kind),
    };
    serde_json::to_writer(std::io::stdout().lock(), &response)
        .map_err(|_| ShellCommandErrorKind::Unavailable)?;
    std::io::stdout()
        .lock()
        .flush()
        .map_err(|_| ShellCommandErrorKind::Unavailable)
}

pub fn run_shell_command_sandbox_probe() -> Result<(), ShellCommandErrorKind> {
    if network_bind_is_denied()? && unix_socketpair_is_allowed()? {
        println!("{SANDBOX_PROBE_SENTINEL}");
        return Ok(());
    }
    Err(ShellCommandErrorKind::SandboxUnavailable)
}

#[cfg(unix)]
fn network_bind_is_denied() -> Result<bool, ShellCommandErrorKind> {
    match std::net::TcpListener::bind(("127.0.0.1", 0)) {
        Ok(_) => Ok(false),
        Err(error) if matches!(error.raw_os_error(), Some(libc::EPERM) | Some(libc::EACCES)) => {
            Ok(true)
        }
        Err(_) => Err(ShellCommandErrorKind::SandboxUnavailable),
    }
}

#[cfg(windows)]
fn network_bind_is_denied() -> Result<bool, ShellCommandErrorKind> {
    Err(ShellCommandErrorKind::SandboxUnavailable)
}

#[cfg(unix)]
fn unix_socketpair_is_allowed() -> Result<bool, ShellCommandErrorKind> {
    let mut descriptors = [-1; 2];
    let result = unsafe {
        libc::socketpair(
            libc::AF_UNIX,
            libc::SOCK_STREAM,
            0,
            descriptors.as_mut_ptr(),
        )
    };
    if result == -1 {
        return Err(ShellCommandErrorKind::SandboxUnavailable);
    }
    unsafe {
        libc::close(descriptors[0]);
        libc::close(descriptors[1]);
    }
    Ok(true)
}

#[cfg(windows)]
fn unix_socketpair_is_allowed() -> Result<bool, ShellCommandErrorKind> {
    Err(ShellCommandErrorKind::SandboxUnavailable)
}

fn execute_supervised(
    request: SupervisorRequest,
    cancel_rx: std_mpsc::Receiver<()>,
) -> Result<ShellCommandOutput, ShellCommandErrorKind> {
    let working_directory = inherited_working_directory(&request)?;
    let environment = request
        .environment
        .into_iter()
        .map(|(name, value)| (OsString::from(name), OsString::from(value)))
        .collect();
    let started = Instant::now();
    let adapter = sugarcode_sandbox::CommandSandboxAdapter::probe(request.sandbox_policy)
        .map_err(|_| ShellCommandErrorKind::SandboxUnavailable)?;
    let mut child = adapter
        .spawn(sugarcode_sandbox::CommandSpec {
            command: request.command,
            arguments: request.arguments,
            working_directory,
            environment,
        })
        .map_err(map_sandbox_spawn_error)?;
    let stdout = child
        .take_stdout()
        .ok_or(ShellCommandErrorKind::Unavailable)?;
    let stderr = child
        .take_stderr()
        .ok_or(ShellCommandErrorKind::Unavailable)?;
    let stdout_reader = std::thread::spawn(move || read_bounded(stdout));
    let stderr_reader = std::thread::spawn(move || read_bounded(stderr));

    let mut timed_out = false;
    let status = loop {
        if cancel_rx.try_recv().is_ok() {
            child.terminate_tree();
            let _ = child.wait();
            return Err(ShellCommandErrorKind::Unavailable);
        }
        if started.elapsed() >= COMMAND_TIMEOUT {
            timed_out = true;
            child.terminate_tree();
            break child
                .wait()
                .map_err(|_| ShellCommandErrorKind::Unavailable)?;
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|_| ShellCommandErrorKind::Unavailable)?
        {
            break status;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| ShellCommandErrorKind::Unavailable)?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| ShellCommandErrorKind::Unavailable)?;
    let outcome = if timed_out {
        ShellCommandOutcome::TimedOut
    } else {
        exit_outcome(status)
    };
    Ok(ShellCommandOutput {
        stdout: String::from_utf8_lossy(&stdout.retained).into_owned(),
        stderr: String::from_utf8_lossy(&stderr.retained).into_owned(),
        stdout_bytes: stdout.observed,
        stderr_bytes: stderr.observed,
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
        duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        outcome,
        sandbox_policy: adapter.policy(),
    })
}

struct BoundedOutput {
    retained: Vec<u8>,
    observed: u64,
    truncated: bool,
}

fn read_bounded(mut reader: impl Read) -> BoundedOutput {
    let mut retained = Vec::with_capacity(MAX_SHELL_OUTPUT_BYTES);
    let mut observed = 0u64;
    let mut buffer = [0u8; 8 * 1_024];
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        observed = observed.saturating_add(u64::try_from(read).unwrap_or(u64::MAX));
        let remaining = MAX_SHELL_OUTPUT_BYTES.saturating_sub(retained.len());
        retained.extend_from_slice(&buffer[..read.min(remaining)]);
    }
    BoundedOutput {
        truncated: observed > u64::try_from(retained.len()).unwrap_or(u64::MAX),
        retained,
        observed,
    }
}

fn validate_arguments(arguments: &ShellCommandArguments) -> Result<(), ShellCommandErrorKind> {
    validate_command(&arguments.command, &arguments.arguments)
}

fn validate_request(request: &SupervisorRequest) -> Result<(), ShellCommandErrorKind> {
    validate_command(&request.command, &request.arguments)?;
    validate_command_environment(&request.environment)?;
    #[cfg(unix)]
    if request.workspace_root_fd < 3 {
        return Err(ShellCommandErrorKind::InvalidArguments);
    }
    Ok(())
}

fn validate_command(command: &str, arguments: &[String]) -> Result<(), ShellCommandErrorKind> {
    if command.is_empty()
        || command.len() > MAX_SHELL_COMMAND_BYTES
        || !Path::new(command).is_absolute()
        || invalid_text(command)
        || arguments.len() > MAX_SHELL_ARGUMENT_COUNT
        || arguments
            .iter()
            .any(|argument| argument.len() > MAX_SHELL_ARGUMENT_BYTES || invalid_text(argument))
        || arguments
            .iter()
            .try_fold(command.len(), |total, argument| {
                total.checked_add(argument.len())
            })
            .is_none_or(|total| total > MAX_SHELL_TOTAL_ARGUMENT_BYTES)
    {
        return Err(ShellCommandErrorKind::InvalidArguments);
    }
    #[cfg(windows)]
    if command.starts_with(r"\\") || command.starts_with(r"\\?\") || command.starts_with(r"\\.\") {
        return Err(ShellCommandErrorKind::InvalidArguments);
    }
    Ok(())
}

#[cfg(unix)]
fn inherited_working_directory(
    request: &SupervisorRequest,
) -> Result<sugarcode_sandbox::CommandWorkingDirectory, ShellCommandErrorKind> {
    use std::os::fd::FromRawFd;

    let directory = unsafe { std::fs::File::from_raw_fd(request.workspace_root_fd) };
    let matches = request
        .workspace_root_identity
        .matches(&directory)
        .map_err(|_| ShellCommandErrorKind::SandboxUnavailable)?;
    if !matches {
        return Err(ShellCommandErrorKind::SandboxUnavailable);
    }
    sugarcode_sandbox::CommandWorkingDirectory::from_directory(directory)
        .map_err(|_| ShellCommandErrorKind::SandboxUnavailable)
}

#[cfg(not(unix))]
fn inherited_working_directory(
    _request: &SupervisorRequest,
) -> Result<sugarcode_sandbox::CommandWorkingDirectory, ShellCommandErrorKind> {
    Err(ShellCommandErrorKind::SandboxUnavailable)
}

fn invalid_text(value: &str) -> bool {
    value
        .chars()
        .any(|character| character == '\0' || character.is_control())
}

fn map_spawn_error(error: &std::io::Error) -> ShellCommandErrorKind {
    match error.kind() {
        std::io::ErrorKind::NotFound => ShellCommandErrorKind::CommandNotFound,
        std::io::ErrorKind::PermissionDenied => ShellCommandErrorKind::AccessDenied,
        _ => ShellCommandErrorKind::SpawnFailed,
    }
}

fn map_sandbox_spawn_error(error: sugarcode_sandbox::SandboxSpawnError) -> ShellCommandErrorKind {
    match error {
        sugarcode_sandbox::SandboxSpawnError::Sandbox(_) => {
            ShellCommandErrorKind::SandboxUnavailable
        }
        sugarcode_sandbox::SandboxSpawnError::Process(error) => map_spawn_error(&error),
    }
}

fn host_command_environment() -> Vec<(String, String)> {
    filtered_command_environment(
        std::env::vars_os().filter_map(|(name, value)| {
            Some((name.into_string().ok()?, value.into_string().ok()?))
        }),
    )
}

fn filtered_command_environment(
    variables: impl IntoIterator<Item = (String, String)>,
) -> Vec<(String, String)> {
    let mut candidates = variables
        .into_iter()
        .filter(|(name, value)| {
            valid_environment_name(name)
                && !value.contains('\0')
                && !sensitive_environment_name(name)
        })
        .collect::<BTreeMap<_, _>>();
    if !candidates.contains_key("LANG") {
        candidates.insert("LANG".to_string(), "C".to_string());
    }
    if !candidates.contains_key("LC_ALL") {
        candidates.insert("LC_ALL".to_string(), "C".to_string());
    }

    let mut ordered = Vec::with_capacity(candidates.len());
    for priority in PRIORITY_ENVIRONMENT_NAMES {
        if let Some((name, value)) = candidates.remove_entry(*priority) {
            ordered.push((name, value));
        }
    }
    ordered.extend(candidates);

    let mut retained = Vec::new();
    let mut retained_bytes = 0usize;
    for (name, value) in ordered {
        let Some(variable_bytes) = name.len().checked_add(value.len()) else {
            continue;
        };
        let Some(next_bytes) = retained_bytes.checked_add(variable_bytes) else {
            continue;
        };
        if retained.len() >= MAX_COMMAND_ENVIRONMENT_VARIABLES
            || next_bytes > MAX_COMMAND_ENVIRONMENT_BYTES
        {
            continue;
        }
        retained_bytes = next_bytes;
        retained.push((name, value));
    }
    retained
}

fn validate_command_environment(
    environment: &[(String, String)],
) -> Result<(), ShellCommandErrorKind> {
    if environment.len() > MAX_COMMAND_ENVIRONMENT_VARIABLES {
        return Err(ShellCommandErrorKind::InvalidArguments);
    }
    let mut total = 0usize;
    for (name, value) in environment {
        if !valid_environment_name(name) || value.contains('\0') || sensitive_environment_name(name)
        {
            return Err(ShellCommandErrorKind::InvalidArguments);
        }
        total = total
            .checked_add(name.len())
            .and_then(|total| total.checked_add(value.len()))
            .ok_or(ShellCommandErrorKind::InvalidArguments)?;
        if total > MAX_COMMAND_ENVIRONMENT_BYTES {
            return Err(ShellCommandErrorKind::InvalidArguments);
        }
    }
    Ok(())
}

fn valid_environment_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('=')
        && !name.contains('\0')
        && !name.chars().any(char::is_control)
}

fn sensitive_environment_name(name: &str) -> bool {
    let uppercase = name.to_ascii_uppercase();
    SENSITIVE_ENVIRONMENT_MARKERS
        .iter()
        .any(|marker| uppercase.contains(marker))
}

fn exit_outcome(status: std::process::ExitStatus) -> ShellCommandOutcome {
    if let Some(code) = status.code() {
        return ShellCommandOutcome::ExitCode {
            code: i64::from(code),
        };
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        ShellCommandOutcome::Signal {
            signal: status.signal().unwrap_or_default(),
        }
    }
    #[cfg(not(unix))]
    {
        ShellCommandOutcome::ExitCode { code: -1 }
    }
}

fn configure_minimal_environment_tokio(command: &mut Command) {
    #[cfg(unix)]
    {
        command.env("LANG", "C").env("LC_ALL", "C");
    }
    #[cfg(windows)]
    {
        for name in ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
    }
}

#[cfg(unix)]
fn configure_minimal_environment_std(command: &mut std::process::Command) {
    command.env("LANG", "C").env("LC_ALL", "C");
}

#[cfg(unix)]
fn configure_workspace_root_inheritance_std(
    command: &mut std::process::Command,
    descriptor: std::os::fd::RawFd,
) -> Result<(), ShellCommandErrorKind> {
    use std::os::unix::process::CommandExt;

    unsafe {
        command.pre_exec(move || clear_close_on_exec(descriptor));
    }
    Ok(())
}

#[cfg(unix)]
fn configure_workspace_root_inheritance_tokio(
    command: &mut Command,
    descriptor: std::os::fd::RawFd,
) -> Result<(), ShellCommandErrorKind> {
    unsafe {
        command.pre_exec(move || clear_close_on_exec(descriptor));
    }
    Ok(())
}

#[cfg(unix)]
fn clear_close_on_exec(descriptor: std::os::fd::RawFd) -> std::io::Result<()> {
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
    if flags == -1 {
        return Err(std::io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags & !libc::FD_CLOEXEC) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(windows)]
mod windows_job {
    use super::*;
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
    use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
    use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    use windows_sys::Win32::System::JobObjects::JOBOBJECT_EXTENDED_LIMIT_INFORMATION;
    use windows_sys::Win32::System::JobObjects::JobObjectExtendedLimitInformation;
    use windows_sys::Win32::System::JobObjects::SetInformationJobObject;
    use windows_sys::Win32::System::JobObjects::TerminateJobObject;

    pub(super) struct Job(HANDLE);

    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub(super) fn assign(child: &tokio::process::Child) -> Result<Self, ShellCommandErrorKind> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return Err(ShellCommandErrorKind::ProcessControlUnavailable);
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let configured = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    (&raw const info).cast(),
                    u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
                        .unwrap_or(u32::MAX),
                );
                let process = child
                    .raw_handle()
                    .ok_or(ShellCommandErrorKind::ProcessControlUnavailable)?
                    as HANDLE;
                if configured == 0 || AssignProcessToJobObject(handle, process) == 0 {
                    CloseHandle(handle);
                    return Err(ShellCommandErrorKind::ProcessControlUnavailable);
                }
                Ok(Self(handle))
            }
        }

        pub(super) fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(test)]
#[path = "tests/shell_command.rs"]
mod tests;
