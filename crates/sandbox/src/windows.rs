use std::ffi::OsStr;
use std::ffi::c_void;
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
use windows_sys::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
use windows_sys::Win32::Foundation::ERROR_INVALID_PARAMETER;
use windows_sys::Win32::Foundation::ERROR_PATH_NOT_FOUND;
use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::HANDLE_FLAG_INHERIT;
use windows_sys::Win32::Foundation::HLOCAL;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Foundation::SetHandleInformation;
use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
use windows_sys::Win32::Security::ACL;
use windows_sys::Win32::Security::Authorization::EXPLICIT_ACCESS_W;
use windows_sys::Win32::Security::Authorization::GRANT_ACCESS;
use windows_sys::Win32::Security::Authorization::SetEntriesInAclW;
use windows_sys::Win32::Security::Authorization::TRUSTEE_IS_SID;
use windows_sys::Win32::Security::Authorization::TRUSTEE_IS_UNKNOWN;
use windows_sys::Win32::Security::Authorization::TRUSTEE_W;
use windows_sys::Win32::Security::CopySid;
use windows_sys::Win32::Security::CreateRestrictedToken;
use windows_sys::Win32::Security::CreateWellKnownSid;
use windows_sys::Win32::Security::DISABLE_MAX_PRIVILEGE;
use windows_sys::Win32::Security::EqualSid;
use windows_sys::Win32::Security::GetLengthSid;
use windows_sys::Win32::Security::GetTokenInformation;
use windows_sys::Win32::Security::LUA_TOKEN;
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Security::SID_AND_ATTRIBUTES;
use windows_sys::Win32::Security::SetTokenInformation;
use windows_sys::Win32::Security::TOKEN_ADJUST_DEFAULT;
use windows_sys::Win32::Security::TOKEN_ASSIGN_PRIMARY;
use windows_sys::Win32::Security::TOKEN_DUPLICATE;
use windows_sys::Win32::Security::TOKEN_INFORMATION_CLASS;
use windows_sys::Win32::Security::TOKEN_MANDATORY_LABEL;
use windows_sys::Win32::Security::TOKEN_QUERY;
use windows_sys::Win32::Security::TokenDefaultDacl;
use windows_sys::Win32::Security::TokenGroups;
use windows_sys::Win32::Security::TokenIntegrityLevel;
use windows_sys::Win32::Security::TokenRestrictedSids;
use windows_sys::Win32::Security::WELL_KNOWN_SID_TYPE;
use windows_sys::Win32::Security::WRITE_RESTRICTED;
use windows_sys::Win32::Security::WinLowLabelSid;
use windows_sys::Win32::Security::WinWorldSid;
use windows_sys::Win32::Security::WinWriteRestrictedCodeSid;
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
use windows_sys::Win32::System::Threading::PROCESS_INFORMATION;
use windows_sys::Win32::System::Threading::ResumeThread;
use windows_sys::Win32::System::Threading::STARTF_USESTDHANDLES;
use windows_sys::Win32::System::Threading::STARTUPINFOEXW;
use windows_sys::Win32::System::Threading::TerminateProcess;
use windows_sys::Win32::System::Threading::UpdateProcThreadAttribute;
use windows_sys::Win32::System::Threading::WaitForSingleObject;

use crate::CommandSandboxPolicy;
use crate::CommandSpec;
use crate::SandboxError;
use crate::SandboxPolicy;
use crate::SandboxSpawnError;
use crate::SupervisedChild;

#[cfg(test)]
#[path = "tests/windows.rs"]
mod tests;

const FILESYSTEM_READ_ONLY_TOKEN_FLAGS: u32 = DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED;
const FILESYSTEM_READ_ONLY_COMPAT_TOKEN_FLAGS: u32 = DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED;
const FILESYSTEM_READ_ONLY_RESTRICTING_SID: WELL_KNOWN_SID_TYPE = WinWriteRestrictedCodeSid;
// Low remains below ordinary Medium filesystem objects. Untrusted prevents the
// bundled CLI runtime from completing DLL initialization on supported Windows.
const FILESYSTEM_READ_ONLY_INTEGRITY_SID: WELL_KNOWN_SID_TYPE = WinLowLabelSid;
const GENERIC_ALL: u32 = 0x1000_0000;
const INFINITE: u32 = u32::MAX;
const SE_GROUP_INTEGRITY: u32 = 0x0000_0020;
const SE_GROUP_LOGON_ID: u32 = 0xC000_0000;

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

pub(crate) fn probe_command(_policy: CommandSandboxPolicy) -> Result<(), SandboxError> {
    Err(SandboxError::unavailable(
        "networkDeniedV1 is unavailable on Windows",
    ))
}

pub(crate) fn spawn_command(
    _policy: CommandSandboxPolicy,
    _spec: CommandSpec,
) -> Result<SupervisedChild, SandboxSpawnError> {
    Err(SandboxSpawnError::Sandbox(SandboxError::unavailable(
        "networkDeniedV1 is unavailable on Windows",
    )))
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
    let CommandSpec {
        command,
        arguments,
        cwd,
        environment,
    } = spec;
    let application = wide_nul(OsStr::new(&command));
    let current_directory = wide_nul(cwd.as_os_str());
    let environment = environment_block(environment);
    let mut desktop = wide_nul(OsStr::new("Winsta0\\Default"));
    let mut attributes =
        ProcThreadAttributes::new(&inherited_handles).map_err(sandbox_setup_error)?;
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = u32::try_from(size_of::<STARTUPINFOEXW>()).unwrap_or(u32::MAX);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdin.child.raw();
    startup.StartupInfo.hStdOutput = stdout.child.raw();
    startup.StartupInfo.hStdError = stderr.child.raw();
    // Restricted-token processes such as cmd.exe and PowerShell can terminate
    // during DLL initialization when the desktop is left implicit.
    startup.StartupInfo.lpDesktop = desktop.as_mut_ptr();
    startup.lpAttributeList = attributes.as_mut_ptr();

    let mut command_line = command_line(&command, &arguments);
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
        return Err(map_create_process_error(io::Error::last_os_error()));
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
        return Err(sandbox_setup_error(setup_operation_error(
            "ResumeThread",
            io::Error::last_os_error(),
        )));
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
        return Err(SandboxError::unavailable(format!(
            "Windows sandbox probe process failed with {status}"
        )));
    }
    Ok(())
}

fn sandbox_setup_error(error: io::Error) -> SandboxSpawnError {
    SandboxSpawnError::Sandbox(SandboxError::unavailable(format!(
        "Windows sandbox setup failed: {error}"
    )))
}

fn setup_operation_error(operation: &str, error: io::Error) -> io::Error {
    io::Error::new(error.kind(), format!("{operation} failed: {error}"))
}

struct RestrictedToken(OwnedHandle);

impl RestrictedToken {
    fn new() -> io::Result<Self> {
        let mut source = null_mut();
        if unsafe {
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_ADJUST_DEFAULT | TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY,
                &mut source,
            )
        } == 0
        {
            return Err(setup_operation_error(
                "OpenProcessToken",
                io::Error::last_os_error(),
            ));
        }
        let source = OwnedHandle::new(source);
        let mut write_restricted_sid = well_known_sid(FILESYSTEM_READ_ONLY_RESTRICTING_SID)?;
        let mut world_sid = well_known_sid(WinWorldSid)?;
        let mut logon_sid = token_logon_sid(source.raw())?;
        let restricting_sids = [
            SID_AND_ATTRIBUTES {
                Sid: write_restricted_sid.as_mut_ptr().cast(),
                Attributes: 0,
            },
            SID_AND_ATTRIBUTES {
                Sid: logon_sid.as_mut_ptr().cast(),
                Attributes: 0,
            },
            SID_AND_ATTRIBUTES {
                Sid: world_sid.as_mut_ptr().cast(),
                Attributes: 0,
            },
        ];
        let restricted = match create_restricted_token(
            source.raw(),
            &restricting_sids,
            FILESYSTEM_READ_ONLY_TOKEN_FLAGS,
        ) {
            Ok(restricted) => restricted,
            Err(initial_error) if should_retry_without_lua(&initial_error) => {
                // Some filtered or policy-constrained hosts reject LUA_TOKEN with
                // ERROR_INVALID_PARAMETER. The compatibility attempt retains the
                // privilege removal and Write Restricted Code SID that enforce
                // filesystemReadOnlyV1; it is not an unsandboxed retry.
                create_restricted_token(
                    source.raw(),
                    &restricting_sids,
                    FILESYSTEM_READ_ONLY_COMPAT_TOKEN_FLAGS,
                )
                .map_err(|compat_error| {
                    io::Error::new(
                        compat_error.kind(),
                        format!(
                            "CreateRestrictedToken compatibility retry without LUA_TOKEN failed: \
                             initial error: {initial_error}; compatibility error: {compat_error}"
                        ),
                    )
                })?
            }
            Err(error) => return Err(setup_operation_error("CreateRestrictedToken", error)),
        };
        for expected_sid in &restricting_sids {
            if !token_has_restricting_sid(restricted.raw(), expected_sid.Sid)? {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "CreateRestrictedToken did not retain a required restricting SID",
                ));
            }
        }
        set_low_integrity(restricted.raw())?;
        set_default_dacl(
            restricted.raw(),
            &[
                world_sid.as_mut_ptr().cast(),
                logon_sid.as_mut_ptr().cast(),
                write_restricted_sid.as_mut_ptr().cast(),
            ],
        )?;
        Ok(Self(restricted))
    }

    fn raw(&self) -> HANDLE {
        self.0.raw()
    }
}

fn token_has_restricting_sid(token: HANDLE, expected_sid: *mut c_void) -> io::Result<bool> {
    let (storage, returned_size) = token_information(
        token,
        TokenRestrictedSids,
        "GetTokenInformation(TokenRestrictedSids)",
    )?;
    let groups_offset =
        size_of::<windows_sys::Win32::Security::TOKEN_GROUPS>() - size_of::<SID_AND_ATTRIBUTES>();
    if returned_size < groups_offset {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "TokenRestrictedSids buffer is smaller than its header",
        ));
    }
    let group_count = unsafe { std::ptr::read_unaligned(storage.as_ptr().cast::<u32>()) } as usize;
    let groups_size = group_count
        .checked_mul(size_of::<SID_AND_ATTRIBUTES>())
        .and_then(|size| groups_offset.checked_add(size))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "TokenRestrictedSids group count overflows its buffer size",
            )
        })?;
    if groups_size > returned_size {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "TokenRestrictedSids group count exceeds its buffer size",
        ));
    }
    let groups = unsafe {
        storage
            .as_ptr()
            .cast::<u8>()
            .add(groups_offset)
            .cast::<SID_AND_ATTRIBUTES>()
    };
    for index in 0..group_count {
        let group = unsafe { std::ptr::read_unaligned(groups.add(index)) };
        if unsafe { EqualSid(group.Sid, expected_sid) } != 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

fn token_logon_sid(token: HANDLE) -> io::Result<Vec<u8>> {
    let (storage, returned_size) =
        token_information(token, TokenGroups, "GetTokenInformation(TokenGroups)")?;
    let groups_offset =
        size_of::<windows_sys::Win32::Security::TOKEN_GROUPS>() - size_of::<SID_AND_ATTRIBUTES>();
    if returned_size < groups_offset {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "TokenGroups buffer is smaller than its header",
        ));
    }
    let group_count = unsafe { std::ptr::read_unaligned(storage.as_ptr().cast::<u32>()) } as usize;
    let groups_size = group_count
        .checked_mul(size_of::<SID_AND_ATTRIBUTES>())
        .and_then(|size| groups_offset.checked_add(size))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "TokenGroups group count overflows its buffer size",
            )
        })?;
    if groups_size > returned_size {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "TokenGroups group count exceeds its buffer size",
        ));
    }
    let groups = unsafe {
        storage
            .as_ptr()
            .cast::<u8>()
            .add(groups_offset)
            .cast::<SID_AND_ATTRIBUTES>()
    };
    for index in 0..group_count {
        let group = unsafe { std::ptr::read_unaligned(groups.add(index)) };
        if group.Attributes & SE_GROUP_LOGON_ID != SE_GROUP_LOGON_ID {
            continue;
        }
        let sid_size = unsafe { GetLengthSid(group.Sid) };
        if sid_size == 0 {
            return Err(setup_operation_error(
                "GetLengthSid(TokenGroups logon SID)",
                io::Error::last_os_error(),
            ));
        }
        let mut sid = vec![0u8; usize::try_from(sid_size).unwrap_or(0)];
        if unsafe { CopySid(sid_size, sid.as_mut_ptr().cast(), group.Sid) } == 0 {
            return Err(setup_operation_error(
                "CopySid(TokenGroups logon SID)",
                io::Error::last_os_error(),
            ));
        }
        return Ok(sid);
    }
    Err(io::Error::new(
        io::ErrorKind::PermissionDenied,
        "TokenGroups does not contain a logon SID",
    ))
}

fn set_low_integrity(token: HANDLE) -> io::Result<()> {
    let mut sid = well_known_sid(FILESYSTEM_READ_ONLY_INTEGRITY_SID)?;
    let label = TOKEN_MANDATORY_LABEL {
        Label: SID_AND_ATTRIBUTES {
            Sid: sid.as_mut_ptr().cast(),
            Attributes: SE_GROUP_INTEGRITY,
        },
    };
    let byte_size = size_of::<TOKEN_MANDATORY_LABEL>()
        .checked_add(sid.len())
        .and_then(|size| u32::try_from(size).ok())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "TokenIntegrityLevel buffer size does not fit u32",
            )
        })?;
    if unsafe {
        SetTokenInformation(
            token,
            TokenIntegrityLevel,
            (&label as *const TOKEN_MANDATORY_LABEL).cast(),
            byte_size,
        )
    } == 0
    {
        return Err(setup_operation_error(
            "SetTokenInformation(TokenIntegrityLevel)",
            io::Error::last_os_error(),
        ));
    }
    if !token_has_integrity_sid(token, label.Label.Sid)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "SetTokenInformation did not retain the low integrity SID",
        ));
    }
    Ok(())
}

fn token_has_integrity_sid(token: HANDLE, expected_sid: *mut c_void) -> io::Result<bool> {
    let (storage, returned_size) = token_information(
        token,
        TokenIntegrityLevel,
        "GetTokenInformation(TokenIntegrityLevel)",
    )?;
    if returned_size < size_of::<TOKEN_MANDATORY_LABEL>() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "TokenIntegrityLevel buffer is smaller than TOKEN_MANDATORY_LABEL",
        ));
    }
    let label =
        unsafe { std::ptr::read_unaligned(storage.as_ptr().cast::<TOKEN_MANDATORY_LABEL>()) };
    if label.Label.Sid.is_null() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "TokenIntegrityLevel returned a null integrity SID",
        ));
    }
    Ok(unsafe { EqualSid(label.Label.Sid, expected_sid) } != 0)
}

fn token_information(
    token: HANDLE,
    information_class: TOKEN_INFORMATION_CLASS,
    operation: &str,
) -> io::Result<(Vec<usize>, usize)> {
    let mut byte_size = 0;
    if unsafe { GetTokenInformation(token, information_class, null_mut(), 0, &mut byte_size) } == 0
    {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32) {
            return Err(setup_operation_error(
                &format!("{operation} size query"),
                error,
            ));
        }
    }
    if byte_size == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{operation} returned an empty buffer size"),
        ));
    }

    let byte_size = usize::try_from(byte_size).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{operation} buffer size does not fit usize"),
        )
    })?;
    let word_count = byte_size.div_ceil(size_of::<usize>());
    let mut storage = vec![0usize; word_count];
    let mut returned_size = u32::try_from(byte_size).unwrap_or(u32::MAX);
    if unsafe {
        GetTokenInformation(
            token,
            information_class,
            storage.as_mut_ptr().cast(),
            returned_size,
            &mut returned_size,
        )
    } == 0
    {
        return Err(setup_operation_error(operation, io::Error::last_os_error()));
    }
    let returned_size = usize::try_from(returned_size).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{operation} returned size does not fit usize"),
        )
    })?;
    if returned_size > byte_size {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{operation} returned size exceeds its allocated buffer"),
        ));
    }
    Ok((storage, returned_size))
}

fn should_retry_without_lua(error: &io::Error) -> bool {
    error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32)
}

fn map_create_process_error(error: io::Error) -> SandboxSpawnError {
    match error.raw_os_error().map(|code| code as u32) {
        Some(ERROR_FILE_NOT_FOUND) | Some(ERROR_PATH_NOT_FOUND) => {
            SandboxSpawnError::Process(error)
        }
        _ => sandbox_setup_error(setup_operation_error("CreateProcessAsUserW", error)),
    }
}

fn well_known_sid(kind: WELL_KNOWN_SID_TYPE) -> io::Result<Vec<u8>> {
    let mut sid_size = 0;
    unsafe {
        CreateWellKnownSid(kind, null_mut(), null_mut(), &mut sid_size);
    }
    if sid_size == 0 {
        return Err(setup_operation_error(
            "CreateWellKnownSid size query",
            io::Error::last_os_error(),
        ));
    }
    let mut sid = vec![0u8; usize::try_from(sid_size).unwrap_or(0)];
    if unsafe { CreateWellKnownSid(kind, null_mut(), sid.as_mut_ptr().cast(), &mut sid_size) } == 0
    {
        return Err(setup_operation_error(
            "CreateWellKnownSid",
            io::Error::last_os_error(),
        ));
    }
    Ok(sid)
}

#[repr(C)]
struct TokenDefaultDaclInfo {
    default_dacl: *mut ACL,
}

fn set_default_dacl(token: HANDLE, sids: &[*mut c_void]) -> io::Result<()> {
    let entries = sids
        .iter()
        .map(|sid| EXPLICIT_ACCESS_W {
            grfAccessPermissions: GENERIC_ALL,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: 0,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: (*sid).cast(),
            },
        })
        .collect::<Vec<_>>();
    let mut dacl = null_mut();
    let status = unsafe {
        SetEntriesInAclW(
            u32::try_from(entries.len()).unwrap_or(u32::MAX),
            entries.as_ptr(),
            null(),
            &mut dacl,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(setup_operation_error(
            "SetEntriesInAclW",
            io::Error::from_raw_os_error(status as i32),
        ));
    }
    let dacl = LocalAcl(dacl);
    let info = TokenDefaultDaclInfo {
        default_dacl: dacl.0,
    };
    if unsafe {
        SetTokenInformation(
            token,
            TokenDefaultDacl,
            (&info as *const TokenDefaultDaclInfo).cast(),
            u32::try_from(size_of::<TokenDefaultDaclInfo>()).unwrap_or(u32::MAX),
        )
    } == 0
    {
        return Err(setup_operation_error(
            "SetTokenInformation(TokenDefaultDacl)",
            io::Error::last_os_error(),
        ));
    }
    Ok(())
}

struct LocalAcl(*mut ACL);

impl Drop for LocalAcl {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0 as HLOCAL);
            }
        }
    }
}

fn create_restricted_token(
    source: HANDLE,
    restricting_sids: &[SID_AND_ATTRIBUTES],
    flags: u32,
) -> io::Result<OwnedHandle> {
    let mut restricted = null_mut();
    if unsafe {
        CreateRestrictedToken(
            source,
            flags,
            0,
            null(),
            0,
            null(),
            u32::try_from(restricting_sids.len()).unwrap_or(u32::MAX),
            restricting_sids.as_ptr(),
            &mut restricted,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(OwnedHandle::new(restricted))
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
            return Err(setup_operation_error(
                "SetHandleInformation",
                io::Error::last_os_error(),
            ));
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
        return Err(setup_operation_error(
            "CreatePipe",
            io::Error::last_os_error(),
        ));
    }
    Ok((OwnedHandle::new(read), OwnedHandle::new(write)))
}

struct ProcThreadAttributes {
    storage: Vec<usize>,
    initialized: bool,
}

impl ProcThreadAttributes {
    fn new(handles: &[HANDLE]) -> io::Result<Self> {
        let attribute_count = 1;
        let mut byte_size = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), attribute_count, 0, &mut byte_size);
        }
        if byte_size == 0 {
            return Err(setup_operation_error(
                "InitializeProcThreadAttributeList size query",
                io::Error::last_os_error(),
            ));
        }
        let words = byte_size.div_ceil(size_of::<usize>());
        let mut attributes = Self {
            storage: vec![0; words],
            initialized: false,
        };
        if unsafe {
            InitializeProcThreadAttributeList(
                attributes.as_mut_ptr(),
                attribute_count,
                0,
                &mut byte_size,
            )
        } == 0
        {
            return Err(setup_operation_error(
                "InitializeProcThreadAttributeList",
                io::Error::last_os_error(),
            ));
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
            return Err(setup_operation_error(
                "UpdateProcThreadAttribute handle list",
                io::Error::last_os_error(),
            ));
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
        return Err(setup_operation_error(
            "CreateJobObjectW",
            io::Error::last_os_error(),
        ));
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
        return Err(setup_operation_error(
            "SetInformationJobObject",
            io::Error::last_os_error(),
        ));
    }
    if unsafe { AssignProcessToJobObject(job.raw(), process.raw()) } == 0 {
        return Err(setup_operation_error(
            "AssignProcessToJobObject",
            io::Error::last_os_error(),
        ));
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
    let needs_quotes = value.is_empty()
        || value
            .chars()
            .any(|character| matches!(character, ' ' | '\t' | '\n' | '\r' | '"'));
    if !needs_quotes {
        return value.to_owned();
    }

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
