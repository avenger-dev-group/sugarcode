use cap_fs_ext::DirExt;
use cap_fs_ext::FollowSymlinks;
use cap_fs_ext::OpenOptionsFollowExt;
use cap_std::fs::Dir;
use cap_std::fs::OpenOptions;
use std::fmt;
use std::fs::File;
use std::future::Future;
use std::io::Read;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::pin::Pin;
use tokio_util::sync::CancellationToken;

pub const MAX_WORKSPACE_RELATIVE_PATH_BYTES: usize = 1024;
pub const MAX_WORKSPACE_READ_BYTES: usize = 256 * 1024;
const READ_CHUNK_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceReadArguments {
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceReadErrorKind {
    InvalidPath,
    NotFound,
    AccessDenied,
    PathNotAllowed,
    NotRegularFile,
    FileTooLarge,
    BinaryFile,
    ChangedDuringRead,
    Cancelled,
    Unavailable,
}

#[derive(Clone, PartialEq, Eq)]
pub enum WorkspaceReadOutcome {
    Content { content: String, bytes: usize },
    Error { kind: WorkspaceReadErrorKind },
}

pub trait WorkspaceReadExecutor: fmt::Debug + Send + Sync {
    fn read<'a>(
        &'a self,
        arguments: &'a WorkspaceReadArguments,
        cancellation: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = WorkspaceReadOutcome> + Send + 'a>>;
}

impl fmt::Debug for WorkspaceReadOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Content { bytes, .. } => formatter
                .debug_struct("Content")
                .field("content", &"<redacted>")
                .field("bytes", bytes)
                .finish(),
            Self::Error { kind } => formatter.debug_struct("Error").field("kind", kind).finish(),
        }
    }
}

pub struct WorkspaceTool {
    pub(crate) root_path: PathBuf,
    pub(crate) root: Dir,
}

impl fmt::Debug for WorkspaceTool {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkspaceTool")
            .field("root", &"<redacted>")
            .finish()
    }
}

impl WorkspaceTool {
    pub fn open(root: &Path) -> Result<Self, WorkspaceReadErrorKind> {
        if !root.is_absolute() {
            return Err(WorkspaceReadErrorKind::InvalidPath);
        }
        let root_path = root.to_path_buf();
        let root = open_root_nofollow(root)?;
        Ok(Self { root_path, root })
    }

    pub fn root_path(&self) -> &Path {
        &self.root_path
    }

    pub async fn read(
        &self,
        arguments: &WorkspaceReadArguments,
        cancellation: &CancellationToken,
    ) -> WorkspaceReadOutcome {
        self.read_with_before_identity_check(arguments, cancellation, || {})
            .await
    }

    async fn read_with_before_identity_check<F>(
        &self,
        arguments: &WorkspaceReadArguments,
        cancellation: &CancellationToken,
        before_identity_check: F,
    ) -> WorkspaceReadOutcome
    where
        F: FnOnce(),
    {
        if cancellation.is_cancelled() {
            return error(WorkspaceReadErrorKind::Cancelled);
        }
        let components = match validate_relative_path(&arguments.path) {
            Ok(components) => components,
            Err(kind) => return error(kind),
        };
        let (file_name, parents) = match components.split_last() {
            Some(parts) => parts,
            None => return error(WorkspaceReadErrorKind::InvalidPath),
        };
        let mut directory = match self.root.try_clone() {
            Ok(directory) => directory,
            Err(error_value) => return error(map_io_error(&error_value)),
        };
        for component in parents {
            if cancellation.is_cancelled() {
                return error(WorkspaceReadErrorKind::Cancelled);
            }
            directory = match directory.open_dir_nofollow(component) {
                Ok(next) => next,
                Err(error_value) => {
                    return error(classify_component_open_error(
                        &directory,
                        component,
                        &error_value,
                    ));
                }
            };
            if let Err(kind) = validate_directory_handle(&directory) {
                return error(kind);
            }
        }

        let (mut file, opened_snapshot) = match open_regular_file_nofollow(&directory, file_name) {
            Ok(opened) => opened,
            Err(kind) => return error(kind),
        };

        let mut bytes = Vec::with_capacity(opened_snapshot.len as usize);
        let mut buffer = [0u8; READ_CHUNK_BYTES];
        loop {
            if cancellation.is_cancelled() {
                return error(WorkspaceReadErrorKind::Cancelled);
            }
            let count = match file.read(&mut buffer) {
                Ok(count) => count,
                Err(error_value) => return error(map_io_error(&error_value)),
            };
            if count == 0 {
                break;
            }
            if bytes
                .len()
                .checked_add(count)
                .is_none_or(|length| length > MAX_WORKSPACE_READ_BYTES)
            {
                return error(WorkspaceReadErrorKind::FileTooLarge);
            }
            bytes.extend_from_slice(&buffer[..count]);
            tokio::task::yield_now().await;
        }
        let final_metadata = match file.metadata() {
            Ok(metadata) => metadata,
            Err(error_value) => return error(map_io_error(&error_value)),
        };
        let final_snapshot = match FileSnapshot::from_file(&file, &final_metadata) {
            Ok(snapshot) => snapshot,
            Err(kind) => return error(kind),
        };
        if final_snapshot != opened_snapshot || bytes.len() as u64 != final_metadata.len() {
            return error(WorkspaceReadErrorKind::ChangedDuringRead);
        }
        before_identity_check();
        let reopened_snapshot = match open_regular_file_nofollow(&directory, file_name) {
            Ok((_, snapshot)) => snapshot,
            Err(_) => return error(WorkspaceReadErrorKind::ChangedDuringRead),
        };
        if reopened_snapshot != opened_snapshot {
            return error(WorkspaceReadErrorKind::ChangedDuringRead);
        }
        if bytes.contains(&0) {
            return error(WorkspaceReadErrorKind::BinaryFile);
        }
        match String::from_utf8(bytes) {
            Ok(content) => WorkspaceReadOutcome::Content {
                bytes: content.len(),
                content,
            },
            Err(_) => error(WorkspaceReadErrorKind::BinaryFile),
        }
    }
}

impl WorkspaceReadExecutor for WorkspaceTool {
    fn read<'a>(
        &'a self,
        arguments: &'a WorkspaceReadArguments,
        cancellation: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = WorkspaceReadOutcome> + Send + 'a>> {
        Box::pin(WorkspaceTool::read(self, arguments, cancellation))
    }
}

fn open_regular_file_nofollow(
    directory: &Dir,
    file_name: &Path,
) -> Result<(File, FileSnapshot), WorkspaceReadErrorKind> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_fs_ext::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = match directory.open_with(file_name, &options) {
        Ok(file) => file.into_std(),
        Err(error_value) => {
            return Err(classify_component_open_error(
                directory,
                file_name,
                &error_value,
            ));
        }
    };
    let metadata = file.metadata().map_err(|error| map_io_error(&error))?;
    if is_reparse_point(&metadata) {
        return Err(WorkspaceReadErrorKind::PathNotAllowed);
    }
    if !metadata.is_file() {
        return Err(WorkspaceReadErrorKind::NotRegularFile);
    }
    if metadata.len() > MAX_WORKSPACE_READ_BYTES as u64 {
        return Err(WorkspaceReadErrorKind::FileTooLarge);
    }
    let snapshot = FileSnapshot::from_file(&file, &metadata)?;
    Ok((file, snapshot))
}

pub(crate) fn classify_component_open_error(
    directory: &Dir,
    path: &Path,
    error_value: &std::io::Error,
) -> WorkspaceReadErrorKind {
    match directory.symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => WorkspaceReadErrorKind::PathNotAllowed,
        Ok(metadata) if !metadata.is_dir() && !metadata.is_file() => {
            WorkspaceReadErrorKind::NotRegularFile
        }
        Ok(_) if is_nofollow_error(error_value) => WorkspaceReadErrorKind::PathNotAllowed,
        _ => map_io_error(error_value),
    }
}

pub(crate) fn validate_directory_handle(directory: &Dir) -> Result<(), WorkspaceReadErrorKind> {
    let file = directory
        .try_clone()
        .map_err(|error| map_io_error(&error))?
        .into_std_file();
    let metadata = file.metadata().map_err(|error| map_io_error(&error))?;
    if is_reparse_point(&metadata) {
        return Err(WorkspaceReadErrorKind::PathNotAllowed);
    }
    if !metadata.is_dir() {
        return Err(WorkspaceReadErrorKind::NotRegularFile);
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FileSnapshot {
    identity: FileIdentity,
    len: u64,
    modified: u128,
    changed: u128,
}

impl FileSnapshot {
    fn from_file(
        file: &File,
        metadata: &std::fs::Metadata,
    ) -> Result<Self, WorkspaceReadErrorKind> {
        Ok(Self {
            identity: FileIdentity::from_file(file, metadata)?,
            len: metadata.len(),
            modified: modified_marker(metadata),
            changed: changed_marker(file, metadata)?,
        })
    }

    pub(crate) fn from_directory(directory: &Dir) -> Result<Self, WorkspaceReadErrorKind> {
        let file = directory
            .try_clone()
            .map_err(|error| map_io_error(&error))?
            .into_std_file();
        let metadata = file.metadata().map_err(|error| map_io_error(&error))?;
        if is_reparse_point(&metadata) {
            return Err(WorkspaceReadErrorKind::PathNotAllowed);
        }
        if !metadata.is_dir() {
            return Err(WorkspaceReadErrorKind::NotRegularFile);
        }
        Self::from_file(&file, &metadata)
    }
}

#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

#[cfg(unix)]
impl FileIdentity {
    fn from_file(
        _file: &File,
        metadata: &std::fs::Metadata,
    ) -> Result<Self, WorkspaceReadErrorKind> {
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    volume: u32,
    index: u64,
}

#[cfg(windows)]
impl FileIdentity {
    fn from_file(
        file: &File,
        _metadata: &std::fs::Metadata,
    ) -> Result<Self, WorkspaceReadErrorKind> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION;
        use windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandle;
        let mut information = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
        // SAFETY: the handle belongs to `file` and `information` points to a
        // writable value for the duration of the call.
        let result =
            unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) };
        if result == 0 {
            return Err(map_io_error(&std::io::Error::last_os_error()));
        }
        Ok(Self {
            volume: information.dwVolumeSerialNumber,
            index: (u64::from(information.nFileIndexHigh) << 32)
                | u64::from(information.nFileIndexLow),
        })
    }
}

#[cfg(not(any(unix, windows)))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    len: u64,
}

#[cfg(not(any(unix, windows)))]
impl FileIdentity {
    fn from_file(
        _file: &File,
        metadata: &std::fs::Metadata,
    ) -> Result<Self, WorkspaceReadErrorKind> {
        Ok(Self {
            len: metadata.len(),
        })
    }
}

#[cfg(unix)]
fn modified_marker(metadata: &std::fs::Metadata) -> u128 {
    use std::os::unix::fs::MetadataExt;
    ((metadata.mtime() as u128) << 64) | metadata.mtime_nsec() as u128
}

#[cfg(unix)]
fn changed_marker(
    _file: &File,
    metadata: &std::fs::Metadata,
) -> Result<u128, WorkspaceReadErrorKind> {
    use std::os::unix::fs::MetadataExt;
    Ok(((metadata.ctime() as u128) << 64) | metadata.ctime_nsec() as u128)
}

#[cfg(windows)]
fn changed_marker(
    file: &File,
    _metadata: &std::fs::Metadata,
) -> Result<u128, WorkspaceReadErrorKind> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::FILE_BASIC_INFO;
    use windows_sys::Win32::Storage::FileSystem::FileBasicInfo;
    use windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandleEx;

    let mut information = FILE_BASIC_INFO::default();
    // SAFETY: the handle belongs to `file`; `information` is writable and the
    // buffer size matches FILE_BASIC_INFO for the duration of the call.
    let result = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle() as _,
            FileBasicInfo,
            std::ptr::from_mut(&mut information).cast(),
            std::mem::size_of::<FILE_BASIC_INFO>() as u32,
        )
    };
    if result == 0 {
        return Err(map_io_error(&std::io::Error::last_os_error()));
    }
    Ok(information.ChangeTime as u64 as u128)
}

#[cfg(not(any(unix, windows)))]
fn changed_marker(
    _file: &File,
    metadata: &std::fs::Metadata,
) -> Result<u128, WorkspaceReadErrorKind> {
    Ok(modified_marker(metadata))
}

#[cfg(windows)]
fn modified_marker(metadata: &std::fs::Metadata) -> u128 {
    use std::os::windows::fs::MetadataExt;
    metadata.last_write_time() as u128
}

#[cfg(not(any(unix, windows)))]
fn modified_marker(metadata: &std::fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos())
}

#[cfg(windows)]
pub(crate) fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
pub(crate) fn is_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
pub(crate) fn open_root_nofollow(root: &Path) -> Result<Dir, WorkspaceReadErrorKind> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(root)
        .map_err(|error| map_root_open_error(root, &error))?;
    let metadata = file.metadata().map_err(|error| map_io_error(&error))?;
    if !metadata.is_dir() {
        return Err(WorkspaceReadErrorKind::NotRegularFile);
    }
    Ok(Dir::from_std_file(file))
}

#[cfg(windows)]
pub(crate) fn open_root_nofollow(root: &Path) -> Result<Dir, WorkspaceReadErrorKind> {
    use std::os::windows::fs::MetadataExt;
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_WRITE;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(root)
        .map_err(|error| map_root_open_error(root, &error))?;
    let metadata = file.metadata().map_err(|error| map_io_error(&error))?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(WorkspaceReadErrorKind::PathNotAllowed);
    }
    if !metadata.is_dir() {
        return Err(WorkspaceReadErrorKind::NotRegularFile);
    }
    Ok(Dir::from_std_file(file))
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn open_root_nofollow(root: &Path) -> Result<Dir, WorkspaceReadErrorKind> {
    let metadata = std::fs::symlink_metadata(root).map_err(|error| map_io_error(&error))?;
    if metadata.file_type().is_symlink() {
        return Err(WorkspaceReadErrorKind::PathNotAllowed);
    }
    if !metadata.is_dir() {
        return Err(WorkspaceReadErrorKind::NotRegularFile);
    }
    Dir::open_ambient_dir(root, cap_std::ambient_authority()).map_err(|error| map_io_error(&error))
}

#[cfg(unix)]
pub(crate) fn is_nofollow_error(error_value: &std::io::Error) -> bool {
    error_value.raw_os_error() == Some(libc::ELOOP)
}

#[cfg(windows)]
pub(crate) fn is_nofollow_error(error_value: &std::io::Error) -> bool {
    matches!(
        error_value.raw_os_error(),
        Some(681 | 1920 | 1921 | 4392 | 4393 | 4394)
    )
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn is_nofollow_error(_error_value: &std::io::Error) -> bool {
    false
}

pub(crate) fn validate_relative_path(path: &str) -> Result<Vec<PathBuf>, WorkspaceReadErrorKind> {
    if path.is_empty()
        || path.len() > MAX_WORKSPACE_RELATIVE_PATH_BYTES
        || has_current_or_parent_component(path)
        || path
            .chars()
            .any(|character| character == '\0' || character.is_control())
    {
        return Err(WorkspaceReadErrorKind::InvalidPath);
    }
    let path = Path::new(path);
    if path.is_absolute() {
        return Err(WorkspaceReadErrorKind::InvalidPath);
    }
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => components.push(PathBuf::from(value)),
            Component::Prefix(_)
            | Component::RootDir
            | Component::CurDir
            | Component::ParentDir => return Err(WorkspaceReadErrorKind::InvalidPath),
        }
    }
    if components.is_empty() {
        Err(WorkspaceReadErrorKind::InvalidPath)
    } else {
        Ok(components)
    }
}

#[cfg(windows)]
fn has_current_or_parent_component(path: &str) -> bool {
    path.split(['/', '\\'])
        .any(|component| matches!(component, "." | ".."))
}

#[cfg(not(windows))]
fn has_current_or_parent_component(path: &str) -> bool {
    path.split('/')
        .any(|component| matches!(component, "." | ".."))
}

pub(crate) fn map_io_error(error_value: &std::io::Error) -> WorkspaceReadErrorKind {
    match error_value.kind() {
        std::io::ErrorKind::NotFound => WorkspaceReadErrorKind::NotFound,
        std::io::ErrorKind::PermissionDenied => WorkspaceReadErrorKind::AccessDenied,
        std::io::ErrorKind::InvalidInput => WorkspaceReadErrorKind::InvalidPath,
        _ => WorkspaceReadErrorKind::Unavailable,
    }
}

fn map_root_open_error(root: &Path, error_value: &std::io::Error) -> WorkspaceReadErrorKind {
    if std::fs::symlink_metadata(root)
        .is_ok_and(|metadata| metadata.file_type().is_symlink() || is_reparse_point(&metadata))
        || is_nofollow_error(error_value)
    {
        WorkspaceReadErrorKind::PathNotAllowed
    } else {
        map_io_error(error_value)
    }
}

fn error(kind: WorkspaceReadErrorKind) -> WorkspaceReadOutcome {
    WorkspaceReadOutcome::Error { kind }
}

#[cfg(test)]
#[path = "workspace_read/tests/mod.rs"]
mod tests;
