use crate::DiscoveryError;
use crate::DiscoveryErrorKind;
use crate::MAX_STDERR_BYTES;
use crate::inventory::StdioServerSpec;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Child;
use tokio::process::ChildStderr;
use tokio::process::ChildStdin;
use tokio::process::ChildStdout;
use tokio::process::Command;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

const SHUTDOWN_GRACE: Duration = Duration::from_secs(1);

pub(crate) struct ManagedProcess {
    server_id: String,
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Option<ChildStdout>,
    stderr_task: JoinHandle<()>,
    stderr_too_large: Arc<AtomicBool>,
    stderr_signal: Arc<Notify>,
    tree: ProcessTree,
}

impl ManagedProcess {
    pub(crate) fn spawn(spec: &StdioServerSpec) -> Result<Self, DiscoveryError> {
        let mut command = Command::new(&spec.executable);
        command
            .args(&spec.argv)
            .current_dir(&spec.cwd)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        configure_minimal_environment(&mut command);
        configure_process_group(&mut command)
            .map_err(|_| error(spec, DiscoveryErrorKind::ProcessControlUnavailable))?;
        let mut child = command
            .spawn()
            .map_err(|_| error(spec, DiscoveryErrorKind::SpawnFailed))?;
        let tree = match ProcessTree::attach(&child) {
            Ok(tree) => tree,
            Err(()) => {
                let _ = child.start_kill();
                return Err(error(spec, DiscoveryErrorKind::ProcessControlUnavailable));
            }
        };
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| error(spec, DiscoveryErrorKind::SpawnFailed))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| error(spec, DiscoveryErrorKind::SpawnFailed))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| error(spec, DiscoveryErrorKind::SpawnFailed))?;
        let stderr_too_large = Arc::new(AtomicBool::new(false));
        let stderr_signal = Arc::new(Notify::new());
        let stderr_task = tokio::spawn(drain_stderr(
            stderr,
            Arc::clone(&stderr_too_large),
            Arc::clone(&stderr_signal),
        ));

        Ok(Self {
            server_id: spec.id.clone(),
            child,
            stdin: Some(stdin),
            stdout: Some(stdout),
            stderr_task,
            stderr_too_large,
            stderr_signal,
            tree,
        })
    }

    pub(crate) fn take_stdin(&mut self) -> ChildStdin {
        self.stdin.take().expect("stdin is taken once")
    }

    pub(crate) fn take_stdout(&mut self) -> ChildStdout {
        self.stdout.take().expect("stdout is taken once")
    }

    pub(crate) fn stderr_exceeded(&self) -> bool {
        self.stderr_too_large.load(Ordering::Relaxed)
    }

    pub(crate) fn stderr_signal(&self) -> Arc<Notify> {
        Arc::clone(&self.stderr_signal)
    }

    pub(crate) fn try_status_error(&mut self) -> Option<DiscoveryError> {
        match self.child.try_wait() {
            Ok(Some(status)) if status.success() => Some(DiscoveryError::new(
                &self.server_id,
                DiscoveryErrorKind::UnexpectedEof,
            )),
            Ok(Some(_)) => Some(DiscoveryError::new(
                &self.server_id,
                DiscoveryErrorKind::AbnormalExit,
            )),
            Ok(None) => None,
            Err(_) => Some(DiscoveryError::new(
                &self.server_id,
                DiscoveryErrorKind::AbnormalExit,
            )),
        }
    }

    pub(crate) async fn shutdown(mut self) -> Result<(), DiscoveryError> {
        self.stdin.take();
        if wait_for_exit(&mut self.child).await {
            self.tree.kill();
            self.tree.disarm();
            self.stderr_task.abort();
            return Ok(());
        }
        self.tree.terminate();
        if wait_for_exit(&mut self.child).await {
            self.tree.kill();
            self.tree.disarm();
            self.stderr_task.abort();
            return Ok(());
        }
        self.tree.kill();
        let waited = tokio::time::timeout(SHUTDOWN_GRACE, self.child.wait())
            .await
            .is_ok();
        if waited {
            self.tree.disarm();
            self.stderr_task.abort();
            Ok(())
        } else {
            Err(DiscoveryError::new(
                &self.server_id,
                DiscoveryErrorKind::ShutdownFailed,
            ))
        }
    }
}

async fn wait_for_exit(child: &mut Child) -> bool {
    matches!(
        tokio::time::timeout(SHUTDOWN_GRACE, child.wait()).await,
        Ok(Ok(_))
    )
}

async fn drain_stderr(mut stderr: ChildStderr, exceeded: Arc<AtomicBool>, signal: Arc<Notify>) {
    let total = AtomicUsize::new(0);
    let mut buffer = [0_u8; 8192];
    loop {
        match stderr.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(read) => {
                let observed = total
                    .fetch_add(read, Ordering::Relaxed)
                    .saturating_add(read);
                if observed > MAX_STDERR_BYTES {
                    exceeded.store(true, Ordering::Relaxed);
                    signal.notify_one();
                    return;
                }
            }
        }
    }
}

fn configure_minimal_environment(command: &mut Command) {
    #[cfg(unix)]
    command.env("LANG", "C").env("LC_ALL", "C");
    #[cfg(windows)]
    for name in ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) -> std::io::Result<()> {
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
    Ok(())
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) -> std::io::Result<()> {
    Ok(())
}

fn error(spec: &StdioServerSpec, kind: DiscoveryErrorKind) -> DiscoveryError {
    DiscoveryError::new(&spec.id, kind)
}

#[cfg(unix)]
struct ProcessTree {
    process_group: i32,
    armed: bool,
}

#[cfg(unix)]
impl ProcessTree {
    fn attach(child: &Child) -> Result<Self, ()> {
        let process_group = i32::try_from(child.id().ok_or(())?).map_err(|_| ())?;
        Ok(Self {
            process_group,
            armed: true,
        })
    }

    fn terminate(&self) {
        if self.armed {
            unsafe {
                libc::killpg(self.process_group, libc::SIGTERM);
            }
        }
    }

    fn kill(&self) {
        if self.armed {
            unsafe {
                libc::killpg(self.process_group, libc::SIGKILL);
            }
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

#[cfg(unix)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        self.kill();
    }
}

#[cfg(windows)]
struct ProcessTree {
    job: windows_job::Job,
    armed: bool,
}

#[cfg(windows)]
impl ProcessTree {
    fn attach(child: &Child) -> Result<Self, ()> {
        Ok(Self {
            job: windows_job::Job::assign(child)?,
            armed: true,
        })
    }

    fn terminate(&self) {
        if self.armed {
            self.job.terminate();
        }
    }

    fn kill(&self) {
        self.terminate();
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

#[cfg(not(any(unix, windows)))]
struct ProcessTree;

#[cfg(not(any(unix, windows)))]
impl ProcessTree {
    fn attach(_child: &Child) -> Result<Self, ()> {
        Err(())
    }
    fn terminate(&self) {}
    fn kill(&self) {}
    fn disarm(&mut self) {}
}

#[cfg(windows)]
mod windows_job {
    use std::mem::size_of;
    use tokio::process::Child;
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
        pub(super) fn assign(child: &Child) -> Result<Self, ()> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return Err(());
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
                let process = child.raw_handle().ok_or(())? as HANDLE;
                if configured == 0 || AssignProcessToJobObject(handle, process) == 0 {
                    CloseHandle(handle);
                    return Err(());
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
