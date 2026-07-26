use std::ffi::OsString;
use std::io;
use std::io::Read;
use std::path::PathBuf;
use std::process::ExitStatus;
use std::process::Stdio;
#[cfg(unix)]
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

#[cfg(unix)]
const TERMINATE_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    pub command: String,
    pub arguments: Vec<String>,
    pub cwd: PathBuf,
    pub environment: Vec<(OsString, OsString)>,
}

#[cfg(not(windows))]
pub struct SupervisedChild {
    child: std::process::Child,
}

#[cfg(windows)]
pub struct SupervisedChild {
    child: WindowsProcess,
}

#[cfg(windows)]
enum WindowsProcess {
    Standard(std::process::Child),
    Restricted(crate::windows::WindowsChild),
}

impl SupervisedChild {
    pub fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
        #[cfg(not(windows))]
        {
            self.child
                .stdout
                .take()
                .map(|stdout| Box::new(stdout) as Box<dyn Read + Send>)
        }
        #[cfg(windows)]
        {
            match &mut self.child {
                WindowsProcess::Standard(child) => child
                    .stdout
                    .take()
                    .map(|stdout| Box::new(stdout) as Box<dyn Read + Send>),
                WindowsProcess::Restricted(child) => child.take_stdout(),
            }
        }
    }

    pub fn take_stderr(&mut self) -> Option<Box<dyn Read + Send>> {
        #[cfg(not(windows))]
        {
            self.child
                .stderr
                .take()
                .map(|stderr| Box::new(stderr) as Box<dyn Read + Send>)
        }
        #[cfg(windows)]
        {
            match &mut self.child {
                WindowsProcess::Standard(child) => child
                    .stderr
                    .take()
                    .map(|stderr| Box::new(stderr) as Box<dyn Read + Send>),
                WindowsProcess::Restricted(child) => child.take_stderr(),
            }
        }
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        #[cfg(not(windows))]
        {
            self.child.try_wait()
        }
        #[cfg(windows)]
        {
            match &mut self.child {
                WindowsProcess::Standard(child) => child.try_wait(),
                WindowsProcess::Restricted(child) => child.try_wait(),
            }
        }
    }

    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        #[cfg(not(windows))]
        {
            self.child.wait()
        }
        #[cfg(windows)]
        {
            match &mut self.child {
                WindowsProcess::Standard(child) => child.wait(),
                WindowsProcess::Restricted(child) => child.wait(),
            }
        }
    }

    pub fn terminate_tree(&mut self) {
        #[cfg(not(windows))]
        terminate_process_tree(&mut self.child);
        #[cfg(windows)]
        match &mut self.child {
            WindowsProcess::Standard(child) => terminate_process_tree(child),
            WindowsProcess::Restricted(child) => child.terminate_tree(),
        }
    }

    #[cfg(windows)]
    pub(crate) fn from_restricted_windows(child: crate::windows::WindowsChild) -> Self {
        Self {
            child: WindowsProcess::Restricted(child),
        }
    }
}

pub fn spawn_supervised(spec: CommandSpec) -> io::Result<SupervisedChild> {
    let mut command = std::process::Command::new(spec.command);
    command
        .args(spec.arguments)
        .current_dir(spec.cwd)
        .env_clear()
        .envs(spec.environment)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    command.spawn().map(|child| SupervisedChild {
        #[cfg(not(windows))]
        child,
        #[cfg(windows)]
        child: WindowsProcess::Standard(child),
    })
}

#[cfg(unix)]
fn configure_process_group(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            #[cfg(target_os = "linux")]
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) == -1 {
                return Err(io::Error::last_os_error());
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
        if !group_exists && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
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
