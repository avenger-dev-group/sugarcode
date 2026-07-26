use std::ffi::OsStr;
use std::fs::File;
use std::io;
use std::io::Read;
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;
use std::os::windows::io::RawHandle;
use std::process::ExitStatus;
use std::ptr::null;
use std::ptr::null_mut;

use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::Foundation::ERROR_FILE_NOT_FOUND;
use windows_sys::Win32::Foundation::ERROR_PATH_NOT_FOUND;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::HANDLE_FLAG_INHERIT;
use windows_sys::Win32::Foundation::SetHandleInformation;
use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
use windows_sys::Win32::Security::CreateRestrictedToken;
use windows_sys::Win32::Security::CreateWellKnownSid;
use windows_sys::Win32::Security::DISABLE_MAX_PRIVILEGE;
use windows_sys::Win32::Security::LUA_TOKEN;
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Security::SID_AND_ATTRIBUTES;
use windows_sys::Win32::Security::TOKEN_ASSIGN_PRIMARY;
use windows_sys::Win32::Security::TOKEN_DUPLICATE;
use windows_sys::Win32::Security::TOKEN_QUERY;
use windows_sys::Win32::Security::WRITE_RESTRICTED;
use windows_sys::Win32::Security::WinNullSid;
use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
use windows_sys::Win32::System::JobObjects::JOBOBJECT_EXTENDED_LIMIT_INFORMATION;
use windows_sys::Win32::System::JobObjects::JobObjectExtendedLimitInformation;
use windows_sys::Win32::System::JobObjects::SetInformationJobObject;
use windows_sys::Win32::System::JobObjects::TerminateJobObject;
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;
use windows_sys::Win32::System::Threading::CREATE_UNICODE_ENVIRONMENT;
use windows_sys::Win32::System::Threading::CreateProcessAsUserW;
use windows_sys::Win32::System::Threading::DeleteProcThreadAttributeList;
use windows_sys::Win32::System::Threading::EXTENDED_STARTUPINFO_PRESENT;
use windows_sys::Win32::System::Threading::GetCurrentProcess;
use windows_sys::Win32::System::Threading::GetExitCodeProcess;
use windows_sys::Win32::System::Threading::InitializeProcThreadAttributeList;
use windows_sys::Win32::System::Threading::OpenProcessToken;
use windows_sys::Win32::System::Threading::PROC_THREAD_ATTRIBUTE_HANDLE_LIST;
use windows_sys::Win32::System::Threading::PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY;
use windows_sys::Win32::System::Threading::PROCESS_INFORMATION;
use windows_sys::Win32::System::Threading::ResumeThread;
use windows_sys::Win32::System::Threading::STARTF_USESTDHANDLES;
use windows_sys::Win32::System::Threading::STARTUPINFOEXW;
use windows_sys::Win32::System::Threading::TerminateProcess;
use windows_sys::Win32::System::Threading::UpdateProcThreadAttribute;
use windows_sys::Win32::System::Threading::WaitForSingleObject;

use crate::CommandSpec;
use crate::SandboxError;
use crate::SandboxPolicy;
use crate::SandboxSpawnError;
use crate::SupervisedChild;

#[cfg(test)]
#[path = "tests/windows.rs"]
mod tests;

const PROCESS_CREATION_MITIGATION_POLICY_WIN32K_SYSTEM_CALL_DISABLE_ALWAYS_ON: u64 = 1_u64 << 28;
const INFINITE: u32 = u32::MAX;

pub(crate) fn probe(policy: SandboxPolicy) -> Result<(), SandboxError> {
    match policy {
        SandboxPolicy::FilesystemReadOnlyV1 => probe_filesystem_read_only(),
    }
}

pub(crate) fn spawn(
    policy: SandboxPolicy,
    spec: CommandSpec,
) -> Result<SupervisedChild, SandboxSpawnError> {
    match policy {
        SandboxPolicy::FilesystemReadOnlyV1 => spawn_filesystem_read_only(spec),
    }
}

pub(crate) struct WindowsChild {
    process: OwnedHandle,
    job: OwnedHandle,
    stdout: Option<File>,
    stderr: Option<File>,
}

impl WindowsChild {
    pub(crate) fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
        self.stdout
            .take()
            .map(|stdout| Box::new(stdout) as Box<dyn Read + Send>)
    }

    pub(crate) fn take_stderr(&mut self) -> Option<Box<dyn Read + Send>> {
        self.stderr
            .take()
            .map(|stderr| Box::new(stderr) as Box<dyn Read + Send>)
    }

    pub(crate) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        match unsafe { WaitForSingleObject(self.process.raw(), 0) } {
            WAIT_OBJECT_0 => self.exit_status().map(Some),
            WAIT_TIMEOUT => Ok(None),
            _ => Err(io::Error::last_os_error()),
        }
    }

    pub(crate) fn wait(&mut self) -> io::Result<ExitStatus> {
        if unsafe { WaitForSingleObject(self.process.raw(), INFINITE) } != WAIT_OBJECT_0 {
            return Err(io::Error::last_os_error());
        }
        self.exit_status()
    }

    pub(crate) fn terminate_tree(&mut self) {
        unsafe {
            TerminateJobObject(self.job.raw(), 1);
        }
    }

    fn exit_status(&self) -> io::Result<ExitStatus> {
        use std::os::windows::process::ExitStatusExt;

        let mut code = 0;
        if unsafe { GetExitCodeProcess(self.process.raw(), &mut code) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(ExitStatus::from_raw(code))
    }
}

fn spawn_filesystem_read_only(spec: CommandSpec) -> Result<SupervisedChild, SandboxSpawnError> {
    let token = RestrictedToken::new().map_err(sandbox_setup_error)?;
    let stdin = ChildPipe::stdin().map_err(sandbox_setup_error)?;
    let stdout = ChildPipe::output().map_err(sandbox_setup_error)?;
    let stderr = ChildPipe::output().map_err(sandbox_setup_error)?;
    let inherited_handles = [stdin.child.raw(), stdout.child.raw(), stderr.child.raw()];
    let mut attributes =
        ProcThreadAttributes::new(&inherited_handles).map_err(sandbox_setup_error)?;
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = u32::try_from(size_of::<STARTUPINFOEXW>()).unwrap_or(u32::MAX);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdin.child.raw();
    startup.StartupInfo.hStdOutput = stdout.child.raw();
    startup.StartupInfo.hStdError = stderr.child.raw();
    startup.lpAttributeList = attributes.as_mut_ptr();

    let application = wide_nul(OsStr::new(&spec.command));
    let mut command_line = command_line(&spec.command, &spec.arguments);
    let current_directory = wide_nul(spec.cwd.as_os_str());
    let environment = environment_block(spec.environment);
    let mut process = PROCESS_INFORMATION::default();
    let created = unsafe {
        CreateProcessAsUserW(
            token.raw(),
            application.as_ptr(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT
                | CREATE_UNICODE_ENVIRONMENT
                | CREATE_NO_WINDOW
                | CREATE_SUSPENDED,
            environment.as_ptr().cast(),
            current_directory.as_ptr(),
            &startup.StartupInfo,
            &mut process,
        )
    };
    if created == 0 {
        let error = io::Error::last_os_error();
        return Err(match error.raw_os_error().map(|code| code as u32) {
            Some(ERROR_FILE_NOT_FOUND) | Some(ERROR_PATH_NOT_FOUND) => {
                SandboxSpawnError::Process(error)
            }
            _ => sandbox_setup_error(error),
        });
    }
    let process_handle = OwnedHandle::new(process.hProcess);
    let thread_handle = OwnedHandle::new(process.hThread);
    let job = match kill_on_close_job(&process_handle) {
        Ok(job) => job,
        Err(error) => {
            unsafe {
                TerminateProcess(process_handle.raw(), 1);
            }
            return Err(sandbox_setup_error(error));
        }
    };
    if unsafe { ResumeThread(thread_handle.raw()) } == u32::MAX {
        unsafe {
            TerminateJobObject(job.raw(), 1);
        }
        return Err(sandbox_setup_error(io::Error::last_os_error()));
    }
    drop(thread_handle);
    drop(stdin);
    Ok(SupervisedChild::from_restricted_windows(WindowsChild {
        process: process_handle,
        job,
        stdout: stdout.into_parent_file(),
        stderr: stderr.into_parent_file(),
    }))
}

fn probe_filesystem_read_only() -> Result<(), SandboxError> {
    let system_root = std::env::var_os("SYSTEMROOT")
        .ok_or_else(|| SandboxError::unavailable("Windows SYSTEMROOT is unavailable"))?;
    let command = std::path::PathBuf::from(&system_root)
        .join("System32")
        .join("cmd.exe")
        .to_string_lossy()
        .into_owned();
    let cwd = std::env::current_dir().map_err(|error| {
        SandboxError::unavailable(format!("Windows sandbox probe cwd unavailable: {error}"))
    })?;
    let environment = ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"]
        .into_iter()
        .filter_map(|name| {
            std::env::var_os(name).map(|value| (std::ffi::OsString::from(name), value))
        })
        .collect();
    let mut child = spawn_filesystem_read_only(CommandSpec {
        command,
        arguments: vec!["/D".to_owned(), "/C".to_owned(), "exit 0".to_owned()],
        cwd,
        environment,
    })
    .map_err(|error| SandboxError::unavailable(format!("Windows sandbox unavailable: {error}")))?;
    let status = child.wait().map_err(|error| {
        SandboxError::unavailable(format!("Windows sandbox probe failed: {error}"))
    })?;
    if !status.success() {
        return Err(SandboxError::unavailable(
            "Windows sandbox probe process failed",
        ));
    }
    Ok(())
}

fn sandbox_setup_error(error: io::Error) -> SandboxSpawnError {
    SandboxSpawnError::Sandbox(SandboxError::unavailable(format!(
        "Windows sandbox setup failed: {error}"
    )))
}

struct RestrictedToken(OwnedHandle);

impl RestrictedToken {
    fn new() -> io::Result<Self> {
        let mut source = null_mut();
        if unsafe {
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY,
                &mut source,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let source = OwnedHandle::new(source);
        let mut sid_size = 0;
        unsafe {
            CreateWellKnownSid(WinNullSid, null_mut(), null_mut(), &mut sid_size);
        }
        if sid_size == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut sid = vec![0u8; usize::try_from(sid_size).unwrap_or(0)];
        if unsafe {
            CreateWellKnownSid(
                WinNullSid,
                null_mut(),
                sid.as_mut_ptr().cast(),
                &mut sid_size,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let restricting_sid = SID_AND_ATTRIBUTES {
            Sid: sid.as_mut_ptr().cast(),
            Attributes: 0,
        };
        let mut restricted = null_mut();
        if unsafe {
            CreateRestrictedToken(
                source.raw(),
                DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
                0,
                null(),
                0,
                null(),
                1,
                &restricting_sid,
                &mut restricted,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(OwnedHandle::new(restricted)))
    }

    fn raw(&self) -> HANDLE {
        self.0.raw()
    }
}

struct ChildPipe {
    child: OwnedHandle,
    parent: Option<OwnedHandle>,
}

impl ChildPipe {
    fn stdin() -> io::Result<Self> {
        let (read, write) = create_inheritable_pipe()?;
        drop(write);
        Ok(Self {
            child: read,
            parent: None,
        })
    }

    fn output() -> io::Result<Self> {
        let (read, write) = create_inheritable_pipe()?;
        if unsafe { SetHandleInformation(read.raw(), HANDLE_FLAG_INHERIT, 0) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            child: write,
            parent: Some(read),
        })
    }

    fn into_parent_file(mut self) -> Option<File> {
        self.parent.take().map(|handle| {
            let raw = handle.into_raw();
            unsafe { File::from_raw_handle(raw as RawHandle) }
        })
    }
}

fn create_inheritable_pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>()).unwrap_or(u32::MAX),
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let mut read = null_mut();
    let mut write = null_mut();
    if unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((OwnedHandle::new(read), OwnedHandle::new(write)))
}

struct ProcThreadAttributes {
    storage: Vec<usize>,
    initialized: bool,
}

impl ProcThreadAttributes {
    fn new(handles: &[HANDLE]) -> io::Result<Self> {
        let mut byte_size = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut byte_size);
        }
        if byte_size == 0 {
            return Err(io::Error::last_os_error());
        }
        let words = byte_size.div_ceil(size_of::<usize>());
        let mut attributes = Self {
            storage: vec![0; words],
            initialized: false,
        };
        if unsafe {
            InitializeProcThreadAttributeList(attributes.as_mut_ptr(), 2, 0, &mut byte_size)
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        attributes.initialized = true;
        if unsafe {
            UpdateProcThreadAttribute(
                attributes.as_mut_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr().cast(),
                size_of_val(handles),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let mitigation = PROCESS_CREATION_MITIGATION_POLICY_WIN32K_SYSTEM_CALL_DISABLE_ALWAYS_ON;
        if unsafe {
            UpdateProcThreadAttribute(
                attributes.as_mut_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY as usize,
                (&mitigation as *const u64).cast(),
                size_of::<u64>(),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(attributes)
    }

    fn as_mut_ptr(
        &mut self,
    ) -> windows_sys::Win32::System::Threading::LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_mut_ptr().cast()
    }
}

impl Drop for ProcThreadAttributes {
    fn drop(&mut self) {
        if self.initialized {
            unsafe {
                DeleteProcThreadAttributeList(self.as_mut_ptr());
            }
        }
    }
}

fn kill_on_close_job(process: &OwnedHandle) -> io::Result<OwnedHandle> {
    let job = OwnedHandle::new(unsafe { CreateJobObjectW(null(), null()) });
    if job.raw().is_null() {
        return Err(io::Error::last_os_error());
    }
    let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.raw(),
            JobObjectExtendedLimitInformation,
            (&information as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()).unwrap_or(u32::MAX),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if unsafe { AssignProcessToJobObject(job.raw(), process.raw()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(job)
}

fn command_line(command: &str, arguments: &[String]) -> Vec<u16> {
    let mut value = quote_windows_argument(command);
    for argument in arguments {
        value.push(' ');
        value.push_str(&quote_windows_argument(argument));
    }
    wide_nul(OsStr::new(&value))
}

fn quote_windows_argument(value: &str) -> String {
    let mut quoted = String::from("\"");
    let mut backslashes = 0;
    for character in value.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                quoted.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.extend(std::iter::repeat_n('\\', backslashes));
                quoted.push(character);
                backslashes = 0;
            }
        }
    }
    quoted.extend(std::iter::repeat_n('\\', backslashes * 2));
    quoted.push('"');
    quoted
}

fn environment_block(environment: Vec<(std::ffi::OsString, std::ffi::OsString)>) -> Vec<u16> {
    let mut entries = environment
        .into_iter()
        .map(|(name, value)| {
            let mut entry: Vec<u16> = name.encode_wide().collect();
            entry.push('=' as u16);
            entry.extend(value.encode_wide());
            entry
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| String::from_utf16_lossy(entry).to_uppercase());
    let mut block = Vec::new();
    for entry in entries {
        block.extend(entry);
        block.push(0);
    }
    block.push(0);
    block
}

fn wide_nul(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

struct OwnedHandle(HANDLE);

impl OwnedHandle {
    fn new(handle: HANDLE) -> Self {
        Self(handle)
    }

    fn raw(&self) -> HANDLE {
        self.0
    }

    fn into_raw(mut self) -> HANDLE {
        let handle = self.0;
        self.0 = null_mut();
        handle
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
