use serde::Deserialize;
use serde::Serialize;
use std::fmt;
use std::future::Future;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::ExitStatus;
use std::process::Stdio;
use std::sync::mpsc as std_mpsc;
use std::time::Duration;
use std::time::Instant;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

pub const MAX_SHELL_COMMAND_BYTES: usize = 1_024;
pub const MAX_SHELL_ARGUMENT_COUNT: usize = 64;
pub const MAX_SHELL_ARGUMENT_BYTES: usize = 8 * 1_024;
pub const MAX_SHELL_TOTAL_ARGUMENT_BYTES: usize = 32 * 1_024;
pub const MAX_SHELL_OUTPUT_BYTES: usize = 24 * 1_024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const SUPERVISOR_WATCHDOG_TIMEOUT: Duration = Duration::from_secs(35);
#[cfg(unix)]
const TERMINATE_GRACE: Duration = Duration::from_secs(2);
const SUPERVISOR_RESULT_BYTES: usize = 2 * MAX_SHELL_OUTPUT_BYTES + 16 * 1_024;

pub type ShellCommandFuture = Pin<Box<dyn Future<Output = ShellCommandExecution> + Send + 'static>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellCommandArguments {
    pub command: String,
    pub arguments: Vec<String>,
    pub cwd: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellCommandExecution {
    Completed(ShellCommandOutput),
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
            Self::Unavailable => "unavailable",
        })
    }
}

pub trait ShellCommandExecutor: fmt::Debug + Send + Sync {
    fn execute(
        &self,
        arguments: ShellCommandArguments,
        cancellation: CancellationToken,
    ) -> ShellCommandFuture;
}

#[derive(Debug, Clone)]
pub struct NativeShellCommandExecutor {
    supervisor_executable: PathBuf,
}

impl NativeShellCommandExecutor {
    pub fn new(supervisor_executable: PathBuf) -> Self {
        Self {
            supervisor_executable,
        }
    }
}

impl ShellCommandExecutor for NativeShellCommandExecutor {
    fn execute(
        &self,
        arguments: ShellCommandArguments,
        cancellation: CancellationToken,
    ) -> ShellCommandFuture {
        let executable = self.supervisor_executable.clone();
        Box::pin(async move {
            if validate_arguments(&arguments).is_err() {
                return ShellCommandExecution::Error(ShellCommandErrorKind::InvalidArguments);
            }
            let request = SupervisorRequest {
                command: arguments.command,
                arguments: arguments.arguments,
                cwd: arguments.cwd,
            };
            run_native(executable, request, cancellation).await
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupervisorRequest {
    command: String,
    arguments: Vec<String>,
    cwd: PathBuf,
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
    cancellation: CancellationToken,
) -> ShellCommandExecution {
    let mut command = Command::new(executable);
    command
        .arg("__command-supervisor")
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    configure_minimal_environment_tokio(&mut command);
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
            return ShellCommandExecution::Completed(ShellCommandOutput {
                stdout: String::new(),
                stderr: String::new(),
                stdout_bytes: 0,
                stderr_bytes: 0,
                stdout_truncated: false,
                stderr_truncated: false,
                duration_ms: u64::try_from(SUPERVISOR_WATCHDOG_TIMEOUT.as_millis())
                    .unwrap_or(u64::MAX),
                outcome: ShellCommandOutcome::TimedOut,
            });
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
        Ok(SupervisorResponse::Completed(output)) => ShellCommandExecution::Completed(output),
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

fn execute_supervised(
    request: SupervisorRequest,
    cancel_rx: std_mpsc::Receiver<()>,
) -> Result<ShellCommandOutput, ShellCommandErrorKind> {
    let mut command = std::process::Command::new(&request.command);
    command
        .args(&request.arguments)
        .current_dir(&request.cwd)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_minimal_environment_std(&mut command);
    configure_process_group(&mut command);
    let started = Instant::now();
    let mut child = command.spawn().map_err(|error| map_spawn_error(&error))?;
    let stdout = child
        .stdout
        .take()
        .ok_or(ShellCommandErrorKind::Unavailable)?;
    let stderr = child
        .stderr
        .take()
        .ok_or(ShellCommandErrorKind::Unavailable)?;
    let stdout_reader = std::thread::spawn(move || read_bounded(stdout));
    let stderr_reader = std::thread::spawn(move || read_bounded(stderr));

    let mut timed_out = false;
    let status = loop {
        if cancel_rx.try_recv().is_ok() {
            terminate_process_tree(&mut child);
            let _ = child.wait();
            return Err(ShellCommandErrorKind::Unavailable);
        }
        if started.elapsed() >= COMMAND_TIMEOUT {
            timed_out = true;
            terminate_process_tree(&mut child);
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
    let request = SupervisorRequest {
        command: arguments.command.clone(),
        arguments: arguments.arguments.clone(),
        cwd: arguments.cwd.clone(),
    };
    validate_request(&request)
}

fn validate_request(request: &SupervisorRequest) -> Result<(), ShellCommandErrorKind> {
    if request.command.is_empty()
        || request.command.len() > MAX_SHELL_COMMAND_BYTES
        || !Path::new(&request.command).is_absolute()
        || invalid_text(&request.command)
        || request.arguments.len() > MAX_SHELL_ARGUMENT_COUNT
        || request
            .arguments
            .iter()
            .any(|argument| argument.len() > MAX_SHELL_ARGUMENT_BYTES || invalid_text(argument))
        || request
            .arguments
            .iter()
            .try_fold(request.command.len(), |total, argument| {
                total.checked_add(argument.len())
            })
            .is_none_or(|total| total > MAX_SHELL_TOTAL_ARGUMENT_BYTES)
        || !request.cwd.is_absolute()
    {
        return Err(ShellCommandErrorKind::InvalidArguments);
    }
    #[cfg(windows)]
    if request.command.starts_with(r"\\")
        || request.command.starts_with(r"\\?\")
        || request.command.starts_with(r"\\.\")
    {
        return Err(ShellCommandErrorKind::InvalidArguments);
    }
    Ok(())
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

fn exit_outcome(status: ExitStatus) -> ShellCommandOutcome {
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

fn configure_minimal_environment_std(command: &mut std::process::Command) {
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
fn configure_process_group(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            #[cfg(target_os = "linux")]
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut std::process::Command) {}

#[cfg(unix)]
fn terminate_process_tree(child: &mut std::process::Child) {
    let process_group = match i32::try_from(child.id()) {
        Ok(process_group) => process_group,
        Err(_) => {
            let _ = child.kill();
            return;
        }
    };
    unsafe {
        libc::killpg(process_group, libc::SIGTERM);
    }
    let deadline = Instant::now() + TERMINATE_GRACE;
    while Instant::now() < deadline {
        let group_exists = unsafe { libc::killpg(process_group, 0) == 0 };
        if !group_exists && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    unsafe {
        libc::killpg(process_group, libc::SIGKILL);
    }
}

#[cfg(windows)]
fn terminate_process_tree(child: &mut std::process::Child) {
    let _ = child.kill();
}

#[cfg(not(any(unix, windows)))]
fn terminate_process_tree(child: &mut std::process::Child) {
    let _ = child.kill();
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
