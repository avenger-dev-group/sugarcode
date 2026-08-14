use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
#[cfg(windows)]
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CAPTURE_STDOUT_BYTES: usize = 256 * 1024;
const MAX_CAPTURE_STDERR_BYTES: usize = 32 * 1024;
const MAX_COMMAND_ENVIRONMENT_VARIABLES: usize = 256;
const MAX_COMMAND_ENVIRONMENT_BYTES: usize = 128 * 1024;
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandShellKind {
    Zsh,
    Bash,
    Fish,
    Posix,
    PowerShell,
    Cmd,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandShell {
    pub kind: CommandShellKind,
    pub executable: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandEnvironmentState {
    NotCaptured,
    Capturing,
    Ready,
    Degraded,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandEnvironmentSource {
    ShellProfile,
    ProcessFallback,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandEnvironmentStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
    pub state: CommandEnvironmentState,
    pub shell: CommandShell,
    pub source: CommandEnvironmentSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
    pub path_entries: Vec<String>,
    pub variable_count: usize,
    pub filtered_variable_count: usize,
    pub profile_loading_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Clone)]
pub struct CommandEnvironmentSnapshot {
    status: CommandEnvironmentStatus,
    variables: Arc<Vec<(String, String)>>,
}

impl std::fmt::Debug for CommandEnvironmentSnapshot {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CommandEnvironmentSnapshot")
            .field("status", &self.status)
            .finish_non_exhaustive()
    }
}

impl CommandEnvironmentSnapshot {
    pub fn process_fallback(profile_loading_enabled: bool) -> Self {
        snapshot_from_variables(
            next_snapshot_id(),
            detected_shell(),
            host_environment_variables(),
            CommandEnvironmentState::Ready,
            CommandEnvironmentSource::ProcessFallback,
            profile_loading_enabled,
            None,
        )
    }

    pub fn status(&self) -> &CommandEnvironmentStatus {
        &self.status
    }

    pub fn variables(&self) -> &[(String, String)] {
        &self.variables
    }

    fn with_last_error(&self, last_error: Option<String>) -> Self {
        let mut status = self.status.clone();
        status.last_error = last_error;
        Self {
            status,
            variables: Arc::clone(&self.variables),
        }
    }
}

#[derive(Debug)]
struct CommandEnvironmentManagerState {
    latest: Option<Arc<CommandEnvironmentSnapshot>>,
    bindings: HashMap<String, Arc<CommandEnvironmentSnapshot>>,
    profile_loading_enabled: bool,
    capturing: bool,
}

#[derive(Clone, Debug)]
pub struct CommandEnvironmentManager {
    state: Arc<Mutex<CommandEnvironmentManagerState>>,
    capture_lock: Arc<AsyncMutex<()>>,
}

impl Default for CommandEnvironmentManager {
    fn default() -> Self {
        Self::new()
    }
}

impl CommandEnvironmentManager {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(CommandEnvironmentManagerState {
                latest: None,
                bindings: HashMap::new(),
                profile_loading_enabled: true,
                capturing: false,
            })),
            capture_lock: Arc::new(AsyncMutex::new(())),
        }
    }

    pub fn inspect(&self, thread_id: Option<&str>) -> CommandEnvironmentStatus {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(snapshot) = thread_id
            .and_then(|thread_id| state.bindings.get(thread_id))
            .or(state.latest.as_ref())
        {
            return snapshot.status().clone();
        }
        CommandEnvironmentStatus {
            snapshot_id: None,
            state: if state.capturing {
                CommandEnvironmentState::Capturing
            } else {
                CommandEnvironmentState::NotCaptured
            },
            shell: detected_shell(),
            source: CommandEnvironmentSource::ProcessFallback,
            created_at: None,
            path_entries: Vec::new(),
            variable_count: 0,
            filtered_variable_count: 0,
            profile_loading_enabled: state.profile_loading_enabled,
            last_error: None,
        }
    }

    pub fn set_profile_loading_enabled(&self, enabled: bool) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.profile_loading_enabled == enabled {
            return false;
        }
        state.profile_loading_enabled = enabled;
        state.latest = None;
        true
    }

    pub fn evict_thread(&self, thread_id: &str) {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .bindings
            .remove(thread_id);
    }

    pub async fn environment_for_thread(&self, thread_id: &str) -> Arc<CommandEnvironmentSnapshot> {
        if let Some(snapshot) = self.bound_or_latest(thread_id) {
            return snapshot;
        }
        self.capture_and_bind(thread_id, false).await
    }

    pub async fn refresh_thread(&self, thread_id: &str) -> Arc<CommandEnvironmentSnapshot> {
        self.capture_and_bind(thread_id, true).await
    }

    fn bound_or_latest(&self, thread_id: &str) -> Option<Arc<CommandEnvironmentSnapshot>> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(snapshot) = state.bindings.get(thread_id) {
            return Some(Arc::clone(snapshot));
        }
        let snapshot = Arc::clone(state.latest.as_ref()?);
        state
            .bindings
            .insert(thread_id.to_owned(), Arc::clone(&snapshot));
        Some(snapshot)
    }

    async fn capture_and_bind(
        &self,
        thread_id: &str,
        refresh: bool,
    ) -> Arc<CommandEnvironmentSnapshot> {
        let observed_snapshot = self
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .latest
            .as_ref()
            .map(|snapshot| snapshot.status().snapshot_id.clone());
        let _capture = self.capture_lock.lock().await;
        {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            if !refresh {
                if let Some(snapshot) = state.bindings.get(thread_id) {
                    return Arc::clone(snapshot);
                }
                if let Some(snapshot) = state.latest.as_ref().map(Arc::clone) {
                    state
                        .bindings
                        .insert(thread_id.to_owned(), Arc::clone(&snapshot));
                    return snapshot;
                }
            } else if state
                .latest
                .as_ref()
                .map(|snapshot| snapshot.status().snapshot_id.clone())
                != observed_snapshot
            {
                let snapshot = Arc::clone(state.latest.as_ref().expect("latest snapshot"));
                state
                    .bindings
                    .insert(thread_id.to_owned(), Arc::clone(&snapshot));
                return snapshot;
            }
            state.capturing = true;
        }
        let profile_loading_enabled = self
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .profile_loading_enabled;
        let snapshot = Arc::new(capture_environment(profile_loading_enabled).await);
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.capturing = false;
        if refresh
            && snapshot.status().state == CommandEnvironmentState::Degraded
            && let Some(previous) = state
                .bindings
                .get(thread_id)
                .or(state.latest.as_ref())
                .map(Arc::clone)
        {
            return Arc::new(previous.with_last_error(snapshot.status().last_error.clone()));
        }
        state.latest = Some(Arc::clone(&snapshot));
        state
            .bindings
            .insert(thread_id.to_owned(), Arc::clone(&snapshot));
        snapshot
    }
}

async fn capture_environment(profile_loading_enabled: bool) -> CommandEnvironmentSnapshot {
    let shell = detected_shell();
    if !profile_loading_enabled || matches!(shell.kind, CommandShellKind::Cmd) {
        return snapshot_from_variables(
            next_snapshot_id(),
            shell,
            host_environment_variables(),
            CommandEnvironmentState::Ready,
            CommandEnvironmentSource::ProcessFallback,
            profile_loading_enabled,
            None,
        );
    }
    match capture_shell_environment(&shell).await {
        Ok(variables) => snapshot_from_variables(
            next_snapshot_id(),
            shell,
            variables,
            CommandEnvironmentState::Ready,
            CommandEnvironmentSource::ShellProfile,
            profile_loading_enabled,
            None,
        ),
        Err(error) => snapshot_from_variables(
            next_snapshot_id(),
            shell,
            host_environment_variables(),
            CommandEnvironmentState::Degraded,
            CommandEnvironmentSource::ProcessFallback,
            profile_loading_enabled,
            Some(error),
        ),
    }
}

fn snapshot_from_variables(
    snapshot_id: String,
    shell: CommandShell,
    variables: Vec<(String, String)>,
    state: CommandEnvironmentState,
    source: CommandEnvironmentSource,
    profile_loading_enabled: bool,
    last_error: Option<String>,
) -> CommandEnvironmentSnapshot {
    let observed = variables.len();
    let variables = filtered_command_environment(variables);
    let path = environment_value(&variables, "PATH").unwrap_or_default();
    let path_entries = std::env::split_paths(path)
        .map(|path| path.to_string_lossy().into_owned())
        .filter(|path| !path.is_empty())
        .collect();
    let filtered_variable_count = observed.saturating_sub(variables.len());
    CommandEnvironmentSnapshot {
        status: CommandEnvironmentStatus {
            snapshot_id: Some(snapshot_id),
            state,
            shell,
            source,
            created_at: Some(now_millis()),
            path_entries,
            variable_count: variables.len(),
            filtered_variable_count,
            profile_loading_enabled,
            last_error,
        },
        variables: Arc::new(variables),
    }
}

fn environment_value<'a>(variables: &'a [(String, String)], name: &str) -> Option<&'a str> {
    variables
        .iter()
        .find(|(candidate, _)| candidate.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn host_environment_variables() -> Vec<(String, String)> {
    std::env::vars_os()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
        .collect()
}

pub(crate) fn filtered_command_environment(
    variables: impl IntoIterator<Item = (String, String)>,
) -> Vec<(String, String)> {
    #[cfg(windows)]
    let mut original_names = HashMap::<String, String>::new();
    let mut candidates = BTreeMap::new();
    for (name, value) in variables {
        if !valid_environment_name(&name)
            || value.contains('\0')
            || sensitive_environment_name(&name)
        {
            continue;
        }
        #[cfg(windows)]
        {
            let key = name.to_ascii_uppercase();
            original_names.insert(key.clone(), name);
            candidates.insert(key, value);
        }
        #[cfg(not(windows))]
        candidates.insert(name, value);
    }
    insert_default_environment(&mut candidates, "LANG", "C");
    insert_default_environment(&mut candidates, "LC_ALL", "C");

    let mut ordered = Vec::with_capacity(candidates.len());
    for priority in PRIORITY_ENVIRONMENT_NAMES {
        let key = environment_key(priority);
        if let Some((key, value)) = candidates.remove_entry(&key) {
            #[cfg(windows)]
            let name = original_names
                .remove(&key)
                .unwrap_or_else(|| (*priority).to_owned());
            #[cfg(not(windows))]
            let name = key;
            ordered.push((name, value));
        }
    }
    for (key, value) in candidates {
        #[cfg(windows)]
        let name = original_names.remove(&key).unwrap_or(key);
        #[cfg(not(windows))]
        let name = key;
        ordered.push((name, value));
    }

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

fn insert_default_environment(candidates: &mut BTreeMap<String, String>, name: &str, value: &str) {
    candidates
        .entry(environment_key(name))
        .or_insert_with(|| value.to_owned());
}

fn environment_key(name: &str) -> String {
    #[cfg(windows)]
    return name.to_ascii_uppercase();
    #[cfg(not(windows))]
    name.to_owned()
}

pub(crate) fn valid_environment_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('=')
        && !name.contains('\0')
        && !name.chars().any(char::is_control)
}

pub(crate) fn sensitive_environment_name(name: &str) -> bool {
    let uppercase = name.to_ascii_uppercase();
    SENSITIVE_ENVIRONMENT_MARKERS
        .iter()
        .any(|marker| uppercase.contains(marker))
}

fn next_snapshot_id() -> String {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    format!("environment-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

fn detected_shell() -> CommandShell {
    #[cfg(windows)]
    return detected_windows_shell();
    #[cfg(unix)]
    return detected_unix_shell();
    #[allow(unreachable_code)]
    CommandShell {
        kind: CommandShellKind::Posix,
        executable: "/bin/sh".to_owned(),
    }
}

#[cfg(unix)]
fn detected_unix_shell() -> CommandShell {
    let executable = std::env::var("SHELL")
        .ok()
        .filter(|value| Path::new(value).is_absolute() && Path::new(value).is_file())
        .or_else(login_shell_from_passwd)
        .or_else(|| existing_absolute_path("/bin/zsh"))
        .or_else(|| existing_absolute_path("/bin/sh"))
        .unwrap_or_else(|| "/bin/sh".to_owned());
    let basename = Path::new(&executable)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let kind = match basename {
        "zsh" => CommandShellKind::Zsh,
        "bash" => CommandShellKind::Bash,
        "fish" => CommandShellKind::Fish,
        _ => CommandShellKind::Posix,
    };
    CommandShell { kind, executable }
}

#[cfg(unix)]
fn existing_absolute_path(value: &str) -> Option<String> {
    Path::new(value).is_file().then(|| value.to_owned())
}

#[cfg(unix)]
fn login_shell_from_passwd() -> Option<String> {
    unsafe {
        let uid = libc::getuid();
        let suggested = libc::sysconf(libc::_SC_GETPW_R_SIZE_MAX);
        let buffer_size = if suggested > 0 {
            usize::try_from(suggested).ok()?.min(1024 * 1024)
        } else {
            16 * 1024
        };
        let mut buffer = vec![0_u8; buffer_size];
        let mut entry: libc::passwd = std::mem::zeroed();
        let mut result = std::ptr::null_mut();
        if libc::getpwuid_r(
            uid,
            &mut entry,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        ) != 0
            || result.is_null()
            || entry.pw_shell.is_null()
        {
            return None;
        }
        let value = std::ffi::CStr::from_ptr(entry.pw_shell)
            .to_str()
            .ok()?
            .to_owned();
        (Path::new(&value).is_absolute() && Path::new(&value).is_file()).then_some(value)
    }
}

#[cfg(windows)]
fn detected_windows_shell() -> CommandShell {
    let mut candidates = Vec::new();
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        candidates.push(Path::new(&program_files).join("PowerShell/7/pwsh.exe"));
    }
    if let Some(path) = executable_on_path("pwsh.exe") {
        candidates.push(path);
    }
    if let Ok(system_root) = std::env::var("SYSTEMROOT") {
        candidates
            .push(Path::new(&system_root).join("System32/WindowsPowerShell/v1.0/powershell.exe"));
    }
    if let Some(path) = executable_on_path("powershell.exe") {
        candidates.push(path);
    }
    if let Some(executable) = candidates.into_iter().find(|path| path.is_file()) {
        return CommandShell {
            kind: CommandShellKind::PowerShell,
            executable: executable.to_string_lossy().into_owned(),
        };
    }
    let executable = std::env::var("COMSPEC")
        .ok()
        .filter(|value| Path::new(value).is_absolute() && Path::new(value).is_file())
        .unwrap_or_else(|| r"C:\Windows\System32\cmd.exe".to_owned());
    CommandShell {
        kind: CommandShellKind::Cmd,
        executable,
    }
}

#[cfg(windows)]
fn executable_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

async fn capture_shell_environment(shell: &CommandShell) -> Result<Vec<(String, String)>, String> {
    let nonce = Uuid::now_v7().simple().to_string();
    let begin = format!("__SUGARCODE_ENV_BEGIN_{nonce}__");
    let end = format!("__SUGARCODE_ENV_END_{nonce}__");
    let mut command = Command::new(&shell.executable);
    match shell.kind {
        CommandShellKind::Zsh | CommandShellKind::Bash | CommandShellKind::Posix => {
            let script = format!("printf '%s' '{begin}'; /usr/bin/env -0; printf '%s' '{end}'");
            command.args(["-ilc", &script]);
        }
        CommandShellKind::Fish => {
            let script = format!("printf '%s' '{begin}'; /usr/bin/env -0; printf '%s' '{end}'");
            command.args(["-lic", &script]);
        }
        CommandShellKind::PowerShell => {
            let script = format!(
                "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Out.Write('{begin}'); Get-ChildItem Env: | ForEach-Object {{ [Console]::Out.Write($_.Name + '=' + $_.Value + [char]0) }}; [Console]::Out.Write('{end}')"
            );
            command.args(["-NoLogo", "-NonInteractive", "-Command", &script]);
        }
        CommandShellKind::Cmd => return Err("cmd does not expose a profile environment".to_owned()),
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not start the login shell: {error}"))?;
    let capture_started = tokio::time::Instant::now();
    let capture_process_id = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "the login shell did not expose stdout".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "the login shell did not expose stderr".to_owned())?;
    let mut stdout_task = tokio::spawn(read_limited(stdout, MAX_CAPTURE_STDOUT_BYTES));
    let mut stderr_task = tokio::spawn(read_limited(stderr, MAX_CAPTURE_STDERR_BYTES));
    let status = match tokio::time::timeout(CAPTURE_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            stdout_task.abort();
            stderr_task.abort();
            return Err(format!("could not wait for the login shell: {error}"));
        }
        Err(_) => {
            terminate_capture_process(&mut child);
            let _ = child.wait().await;
            stdout_task.abort();
            stderr_task.abort();
            return Err("the login shell environment capture timed out".to_owned());
        }
    };
    let remaining = CAPTURE_TIMEOUT.saturating_sub(capture_started.elapsed());
    let readers = async {
        let stdout = (&mut stdout_task)
            .await
            .map_err(|_| "the environment reader stopped unexpectedly".to_owned())??;
        let stderr = (&mut stderr_task)
            .await
            .map_err(|_| "the environment error reader stopped unexpectedly".to_owned())??;
        Ok::<_, String>((stdout, stderr))
    };
    let (stdout, stderr) = match tokio::time::timeout(remaining, readers).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            terminate_capture_group(capture_process_id);
            stdout_task.abort();
            stderr_task.abort();
            return Err(error);
        }
        Err(_) => {
            terminate_capture_group(capture_process_id);
            stdout_task.abort();
            stderr_task.abort();
            return Err("the login shell environment capture timed out".to_owned());
        }
    };
    if shell.kind == CommandShellKind::PowerShell {
        let diagnostic = String::from_utf8_lossy(&stderr)
            .replace('\0', "")
            .to_ascii_lowercase();
        if diagnostic.contains("pssecurityexception")
            || diagnostic.contains("unauthorizedaccess")
            || diagnostic.contains("execution polic")
        {
            return Err("PowerShell profile loading was blocked by execution policy".to_owned());
        }
    }
    if !status.success() {
        return Err(format!("the login shell exited with {status}"));
    }
    let variables = parse_environment_output(&stdout, begin.as_bytes(), end.as_bytes())?;
    if environment_value(&variables, "PATH").is_none_or(str::is_empty) {
        return Err("the login shell returned an environment without PATH".to_owned());
    }
    Ok(variables)
}

async fn read_limited(
    mut reader: impl tokio::io::AsyncRead + Unpin,
    maximum: usize,
) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|error| format!("could not read shell output: {error}"))?;
        if read == 0 {
            return Ok(output);
        }
        if output.len().saturating_add(read) > maximum {
            return Err("the login shell environment output exceeded its limit".to_owned());
        }
        output.extend_from_slice(&buffer[..read]);
    }
}

fn parse_environment_output(
    output: &[u8],
    begin: &[u8],
    end: &[u8],
) -> Result<Vec<(String, String)>, String> {
    let start = find_bytes(output, begin)
        .map(|index| index + begin.len())
        .ok_or_else(|| "the login shell did not emit the environment marker".to_owned())?;
    let finish = find_bytes(&output[start..], end)
        .map(|index| start + index)
        .ok_or_else(|| "the login shell did not finish the environment marker".to_owned())?;
    let mut variables = Vec::new();
    for entry in output[start..finish].split(|byte| *byte == 0) {
        if entry.is_empty() {
            continue;
        }
        let Some(separator) = entry.iter().position(|byte| *byte == b'=') else {
            continue;
        };
        let Ok(name) = String::from_utf8(entry[..separator].to_vec()) else {
            continue;
        };
        let Ok(value) = String::from_utf8(entry[separator + 1..].to_vec()) else {
            continue;
        };
        variables.push((name, value));
    }
    if variables.is_empty() {
        return Err("the login shell returned an empty environment".to_owned());
    }
    Ok(variables)
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|candidate| candidate == needle)
}

#[cfg(unix)]
fn terminate_capture_process(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        unsafe {
            libc::killpg(pid as i32, libc::SIGKILL);
        }
    }
}

#[cfg(unix)]
fn terminate_capture_group(process_id: Option<u32>) {
    if let Some(process_id) = process_id {
        unsafe {
            libc::killpg(process_id as i32, libc::SIGKILL);
        }
    }
}

#[cfg(windows)]
fn terminate_capture_process(child: &mut tokio::process::Child) {
    let _ = child.start_kill();
}

#[cfg(windows)]
fn terminate_capture_group(_process_id: Option<u32>) {}

#[cfg(not(any(unix, windows)))]
fn terminate_capture_process(child: &mut tokio::process::Child) {
    let _ = child.start_kill();
}

#[cfg(not(any(unix, windows)))]
fn terminate_capture_group(_process_id: Option<u32>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn parser_ignores_profile_noise_and_keeps_nul_delimited_values() {
        let output = b"profile noise\nBEGINPATH=/custom/bin:/usr/bin\0VALUE=a=b\0ENDmore";
        assert_eq!(
            parse_environment_output(output, b"BEGIN", b"END").expect("environment"),
            vec![
                ("PATH".to_owned(), "/custom/bin:/usr/bin".to_owned()),
                ("VALUE".to_owned(), "a=b".to_owned()),
            ]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn capture_accepts_profile_noise_and_exported_unicode_values() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let executable = temporary.path().join("fixture shell");
        std::fs::write(
            &executable,
            "#!/bin/sh\nprintf 'profile noise\\n'\nexport SUGARCODE_CAPTURE_FIXTURE='path with spaces/中文'\nexec /bin/sh -c \"$2\"\n",
        )
        .expect("fixture shell");
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700))
            .expect("fixture permissions");
        let variables = capture_shell_environment(&CommandShell {
            kind: CommandShellKind::Posix,
            executable: executable.to_string_lossy().into_owned(),
        })
        .await
        .expect("captured environment");
        assert!(variables.iter().any(|(name, value)| {
            name == "SUGARCODE_CAPTURE_FIXTURE" && value == "path with spaces/中文"
        }));
    }

    #[test]
    fn filtering_removes_secret_values_without_dropping_path() {
        let variables = filtered_command_environment([
            ("SUGARCODE_TOKEN".to_owned(), "must-not-survive".to_owned()),
            ("PATH".to_owned(), "/custom/bin:/usr/bin".to_owned()),
            ("TOOL_HOME".to_owned(), "/custom/tool".to_owned()),
        ]);
        assert_eq!(
            environment_value(&variables, "PATH"),
            Some("/custom/bin:/usr/bin")
        );
        assert!(variables.iter().all(|(name, _)| name != "SUGARCODE_TOKEN"));
    }

    #[tokio::test]
    async fn manager_is_lazy_and_binds_snapshot_per_thread() {
        let manager = CommandEnvironmentManager::new();
        assert_eq!(
            manager.inspect(Some("thread-a")).state,
            CommandEnvironmentState::NotCaptured
        );
        manager.set_profile_loading_enabled(false);
        let first = manager.environment_for_thread("thread-a").await;
        let second = manager.environment_for_thread("thread-b").await;
        assert_eq!(first.status().snapshot_id, second.status().snapshot_id);
        let refreshed = manager.refresh_thread("thread-a").await;
        assert_ne!(first.status().snapshot_id, refreshed.status().snapshot_id);
        assert_eq!(
            manager.inspect(Some("thread-b")).snapshot_id,
            second.status().snapshot_id
        );
    }
}
