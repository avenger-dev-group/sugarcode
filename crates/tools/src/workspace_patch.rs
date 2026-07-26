use crate::workspace_read::FileSnapshot;
use crate::workspace_read::WorkspaceReadErrorKind;
use crate::workspace_read::WorkspaceTool;
use crate::workspace_read::classify_component_open_error;
use crate::workspace_read::map_io_error;
use crate::workspace_read::open_regular_file_nofollow;
use crate::workspace_read::validate_directory_handle;
use crate::workspace_read::validate_relative_path;
use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use cap_std::fs::OpenOptions;
use sha2::Digest;
use sha2::Sha256;
use std::fmt;
use std::fs::File;
use std::future::Future;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use tokio_util::sync::CancellationToken;

pub const MAX_WORKSPACE_PATCH_BYTES: usize = 96 * 1024;
pub const MAX_WORKSPACE_PATCH_HUNKS: usize = 128;
pub const MAX_WORKSPACE_PATCH_LINES: usize = 8_192;
pub const MAX_WORKSPACE_FILE_LINES: usize = 20_000;
pub const MAX_WORKSPACE_LINE_BYTES: usize = 16 * 1024;
pub const MAX_WORKSPACE_DIFF_BYTES: usize = 192 * 1024;
pub const MAX_WORKSPACE_DIFF_LINES: usize = 5_000;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspacePatchArguments {
    pub path: String,
    pub patch: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceNewlineStyle {
    Lf,
    CrLf,
}

impl WorkspaceNewlineStyle {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lf => "lf",
            Self::CrLf => "crLf",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspacePatchErrorKind {
    InvalidPath,
    NotFound,
    AccessDenied,
    PathNotAllowed,
    NotRegularFile,
    FileTooLarge,
    BinaryFile,
    InvalidEncoding,
    InvalidNewline,
    InvalidPatch,
    PatchDoesNotApply,
    TooManyLines,
    LineTooLong,
    ResultTooLarge,
    HardLinkNotAllowed,
    CrossDeviceNotAllowed,
    Conflict,
    Cancelled,
    AtomicReplaceUnavailable,
    Unavailable,
}

#[derive(Debug)]
pub enum WorkspacePatchPrepareOutcome {
    Prepared(Box<WorkspacePatchPrepared>),
    Error { kind: WorkspacePatchErrorKind },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspacePatchCommitOutcome {
    Applied {
        path: String,
        before_sha256: String,
        after_sha256: String,
        before_bytes: u64,
        after_bytes: u64,
    },
    Error {
        kind: WorkspacePatchErrorKind,
    },
}

pub struct WorkspacePatchPrepared {
    path: String,
    diff: String,
    newline: WorkspaceNewlineStyle,
    final_newline: bool,
    before_sha256: String,
    after_sha256: String,
    before_bytes: u64,
    after_bytes: u64,
    backing: PreparedBacking,
}

impl fmt::Debug for WorkspacePatchPrepared {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkspacePatchPrepared")
            .field("path", &self.path)
            .field("diff_bytes", &self.diff.len())
            .field("newline", &self.newline)
            .field("final_newline", &self.final_newline)
            .field("before_bytes", &self.before_bytes)
            .field("after_bytes", &self.after_bytes)
            .finish_non_exhaustive()
    }
}

impl WorkspacePatchPrepared {
    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn diff(&self) -> &str {
        &self.diff
    }

    pub fn newline(&self) -> WorkspaceNewlineStyle {
        self.newline
    }

    pub fn final_newline(&self) -> bool {
        self.final_newline
    }

    pub fn before_sha256(&self) -> &str {
        &self.before_sha256
    }

    pub fn after_sha256(&self) -> &str {
        &self.after_sha256
    }

    pub fn before_bytes(&self) -> u64 {
        self.before_bytes
    }

    pub fn after_bytes(&self) -> u64 {
        self.after_bytes
    }

    #[allow(clippy::too_many_arguments)]
    pub fn recorded(
        path: String,
        diff: String,
        newline: WorkspaceNewlineStyle,
        final_newline: bool,
        before_sha256: String,
        after_sha256: String,
        before_bytes: u64,
        after_bytes: u64,
    ) -> Self {
        Self {
            path,
            diff,
            newline,
            final_newline,
            before_sha256,
            after_sha256,
            before_bytes,
            after_bytes,
            backing: PreparedBacking::Recorded,
        }
    }
}

enum PreparedBacking {
    Native {
        parent: Dir,
        file_name: PathBuf,
        original: File,
        snapshot: FileSnapshot,
        after: Vec<u8>,
    },
    Recorded,
}

pub trait WorkspacePatchExecutor: fmt::Debug + Send + Sync {
    fn prepare<'a>(
        &'a self,
        arguments: &'a WorkspacePatchArguments,
        cancellation: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = WorkspacePatchPrepareOutcome> + Send + 'a>>;

    fn commit<'a>(
        &'a self,
        prepared: WorkspacePatchPrepared,
        cancellation: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = WorkspacePatchCommitOutcome> + Send + 'a>>;
}

impl WorkspacePatchExecutor for WorkspaceTool {
    fn prepare<'a>(
        &'a self,
        arguments: &'a WorkspacePatchArguments,
        cancellation: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = WorkspacePatchPrepareOutcome> + Send + 'a>> {
        Box::pin(WorkspaceTool::prepare_patch(self, arguments, cancellation))
    }

    fn commit<'a>(
        &'a self,
        prepared: WorkspacePatchPrepared,
        cancellation: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = WorkspacePatchCommitOutcome> + Send + 'a>> {
        Box::pin(WorkspaceTool::commit_patch(self, prepared, cancellation))
    }
}

impl WorkspaceTool {
    pub async fn prepare_patch(
        &self,
        arguments: &WorkspacePatchArguments,
        cancellation: &CancellationToken,
    ) -> WorkspacePatchPrepareOutcome {
        if cancellation.is_cancelled() {
            return prepare_error(WorkspacePatchErrorKind::Cancelled);
        }
        if arguments.patch.is_empty() || arguments.patch.len() > MAX_WORKSPACE_PATCH_BYTES {
            return prepare_error(WorkspacePatchErrorKind::InvalidPatch);
        }
        let components = match validate_relative_path(&arguments.path) {
            Ok(components) => components,
            Err(kind) => return prepare_error(map_read_error(kind)),
        };
        let (file_name, parents) = components.split_last().expect("validated path has a name");
        let parent = match resolve_parent(&self.root, parents, cancellation) {
            Ok(parent) => parent,
            Err(kind) => return prepare_error(kind),
        };
        let (mut original, snapshot) = match open_regular_file_nofollow(&parent, file_name) {
            Ok(opened) => opened,
            Err(kind) => return prepare_error(map_read_error(kind)),
        };
        if snapshot.links() != 1 {
            return prepare_error(WorkspacePatchErrorKind::HardLinkNotAllowed);
        }
        if !same_device(&self.root, &parent) {
            return prepare_error(WorkspacePatchErrorKind::CrossDeviceNotAllowed);
        }
        let mut before = Vec::with_capacity(snapshot.len() as usize);
        if original.read_to_end(&mut before).is_err() {
            return prepare_error(WorkspacePatchErrorKind::Unavailable);
        }
        if cancellation.is_cancelled() {
            return prepare_error(WorkspacePatchErrorKind::Cancelled);
        }
        let metadata = match original.metadata() {
            Ok(metadata) => metadata,
            Err(_) => return prepare_error(WorkspacePatchErrorKind::Unavailable),
        };
        let final_snapshot = match FileSnapshot::from_file(&original, &metadata) {
            Ok(value) => value,
            Err(_) => return prepare_error(WorkspacePatchErrorKind::Unavailable),
        };
        if final_snapshot != snapshot || before.len() as u64 != snapshot.len() {
            return prepare_error(WorkspacePatchErrorKind::Conflict);
        }
        let text = match TextFile::parse(&before) {
            Ok(text) => text,
            Err(kind) => return prepare_error(kind),
        };
        let patch = match parse_patch(&arguments.patch) {
            Ok(patch) => patch,
            Err(kind) => return prepare_error(kind),
        };
        let (after_lines, operations) = match apply_hunks(&text.lines, &patch) {
            Ok(value) => value,
            Err(kind) => return prepare_error(kind),
        };
        if after_lines.len() > MAX_WORKSPACE_FILE_LINES {
            return prepare_error(WorkspacePatchErrorKind::TooManyLines);
        }
        if after_lines
            .iter()
            .any(|line| line.len() > MAX_WORKSPACE_LINE_BYTES)
        {
            return prepare_error(WorkspacePatchErrorKind::LineTooLong);
        }
        let after = encode_text(&after_lines, text.newline, text.final_newline);
        if after.len() > crate::MAX_WORKSPACE_READ_BYTES {
            return prepare_error(WorkspacePatchErrorKind::FileTooLarge);
        }
        let path = components
            .iter()
            .map(|component| component.to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let diff = match render_diff(&path, &operations) {
            Ok(diff) => diff,
            Err(kind) => return prepare_error(kind),
        };
        let before_sha256 = sha256(&before);
        let after_sha256 = sha256(&after);
        WorkspacePatchPrepareOutcome::Prepared(Box::new(WorkspacePatchPrepared {
            path,
            diff,
            newline: text.newline,
            final_newline: text.final_newline,
            before_sha256,
            after_sha256,
            before_bytes: before.len() as u64,
            after_bytes: after.len() as u64,
            backing: PreparedBacking::Native {
                parent,
                file_name: file_name.clone(),
                original,
                snapshot,
                after,
            },
        }))
    }

    pub async fn commit_patch(
        &self,
        prepared: WorkspacePatchPrepared,
        cancellation: &CancellationToken,
    ) -> WorkspacePatchCommitOutcome {
        if cancellation.is_cancelled() {
            return commit_error(WorkspacePatchErrorKind::Cancelled);
        }
        let WorkspacePatchPrepared {
            path,
            before_sha256,
            after_sha256,
            before_bytes,
            after_bytes,
            backing,
            ..
        } = prepared;
        let PreparedBacking::Native {
            parent,
            file_name,
            mut original,
            snapshot,
            after,
        } = backing
        else {
            return commit_error(WorkspacePatchErrorKind::Unavailable);
        };
        if verify_original(&parent, &file_name, &mut original, snapshot, &before_sha256).is_err() {
            return commit_error(WorkspacePatchErrorKind::Conflict);
        }
        if cancellation.is_cancelled() {
            return commit_error(WorkspacePatchErrorKind::Cancelled);
        }
        let temp_name = match create_temp(&self.root, &after, &original) {
            Ok(name) => name,
            Err(kind) => return commit_error(kind),
        };
        let replaced = atomic_replace(&self.root, &temp_name, &parent, &file_name);
        if let Err(kind) = replaced {
            let _ = self.root.remove_file(&temp_name);
            if target_matches(&parent, &file_name, &after_sha256, after_bytes) {
                return WorkspacePatchCommitOutcome::Applied {
                    path,
                    before_sha256,
                    after_sha256,
                    before_bytes,
                    after_bytes,
                };
            }
            return commit_error(kind);
        }
        if !target_matches(&parent, &file_name, &after_sha256, after_bytes) {
            return commit_error(WorkspacePatchErrorKind::AtomicReplaceUnavailable);
        }
        WorkspacePatchCommitOutcome::Applied {
            path,
            before_sha256,
            after_sha256,
            before_bytes,
            after_bytes,
        }
    }
}

fn resolve_parent(
    root: &Dir,
    parents: &[PathBuf],
    cancellation: &CancellationToken,
) -> Result<Dir, WorkspacePatchErrorKind> {
    let mut directory = root
        .try_clone()
        .map_err(|_| WorkspacePatchErrorKind::Unavailable)?;
    for component in parents {
        if cancellation.is_cancelled() {
            return Err(WorkspacePatchErrorKind::Cancelled);
        }
        directory = directory.open_dir_nofollow(component).map_err(|error| {
            map_read_error(classify_component_open_error(&directory, component, &error))
        })?;
        validate_directory_handle(&directory).map_err(map_read_error)?;
    }
    Ok(directory)
}

fn verify_original(
    parent: &Dir,
    file_name: &Path,
    original: &mut File,
    snapshot: FileSnapshot,
    expected_hash: &str,
) -> Result<(), ()> {
    let metadata = original.metadata().map_err(|_| ())?;
    let now = FileSnapshot::from_file(original, &metadata).map_err(|_| ())?;
    if now != snapshot || now.links() != 1 {
        return Err(());
    }
    original.seek(SeekFrom::Start(0)).map_err(|_| ())?;
    let mut bytes = Vec::with_capacity(snapshot.len() as usize);
    original.read_to_end(&mut bytes).map_err(|_| ())?;
    if bytes.len() as u64 != snapshot.len() || sha256(&bytes) != expected_hash {
        return Err(());
    }
    let (_, reopened) = open_regular_file_nofollow(parent, file_name).map_err(|_| ())?;
    if reopened != snapshot || reopened.links() != 1 {
        return Err(());
    }
    Ok(())
}

fn create_temp(
    root: &Dir,
    bytes: &[u8],
    _original: &File,
) -> Result<PathBuf, WorkspacePatchErrorKind> {
    for _ in 0..32 {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let name = PathBuf::from(format!(
            ".sugarcode-apply-patch-{}-{sequence:016x}.tmp",
            std::process::id()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use cap_fs_ext::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = match root.open_with(&name, &options) {
            Ok(file) => file.into_std(),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(map_read_error(map_io_error(&error))),
        };
        if file.write_all(bytes).is_err() || file.sync_all().is_err() {
            let _ = root.remove_file(&name);
            return Err(WorkspacePatchErrorKind::Unavailable);
        }
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            use std::os::unix::fs::MetadataExt;
            use std::os::unix::fs::PermissionsExt;
            let metadata = _original
                .metadata()
                .map_err(|_| WorkspacePatchErrorKind::Unavailable)?;
            // SAFETY: the descriptor belongs to the open temporary file and
            // the uid/gid values came from the verified original metadata.
            if unsafe { libc::fchown(file.as_raw_fd(), metadata.uid(), metadata.gid()) } != 0 {
                let _ = root.remove_file(&name);
                return Err(WorkspacePatchErrorKind::Unavailable);
            }
            file.set_permissions(std::fs::Permissions::from_mode(metadata.mode()))
                .map_err(|_| WorkspacePatchErrorKind::Unavailable)?;
            file.sync_all()
                .map_err(|_| WorkspacePatchErrorKind::Unavailable)?;
        }
        return Ok(name);
    }
    Err(WorkspacePatchErrorKind::Unavailable)
}

fn target_matches(parent: &Dir, file_name: &Path, hash: &str, len: u64) -> bool {
    let Ok((mut file, snapshot)) = open_regular_file_nofollow(parent, file_name) else {
        return false;
    };
    if snapshot.len() != len || snapshot.links() != 1 {
        return false;
    }
    let mut bytes = Vec::with_capacity(len as usize);
    file.read_to_end(&mut bytes).is_ok()
        && bytes.len() as u64 == len
        && sha256(&bytes) == hash
        && file.sync_all().is_ok()
}

#[cfg(unix)]
fn same_device(root: &Dir, parent: &Dir) -> bool {
    use std::os::unix::fs::MetadataExt;
    let root = root.try_clone().ok().map(Dir::into_std_file);
    let parent = parent.try_clone().ok().map(Dir::into_std_file);
    matches!(
        (
            root.and_then(|file| file.metadata().ok()).map(|meta| meta.dev()),
            parent.and_then(|file| file.metadata().ok()).map(|meta| meta.dev()),
        ),
        (Some(root), Some(parent)) if root == parent
    )
}

#[cfg(windows)]
fn same_device(root: &Dir, parent: &Dir) -> bool {
    volume_serial(root) == volume_serial(parent)
}

#[cfg(not(any(unix, windows)))]
fn same_device(_root: &Dir, _parent: &Dir) -> bool {
    true
}

#[cfg(unix)]
fn atomic_replace(
    root: &Dir,
    temp_name: &Path,
    parent: &Dir,
    file_name: &Path,
) -> Result<(), WorkspacePatchErrorKind> {
    use std::ffi::CString;
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    let temp = CString::new(temp_name.as_os_str().as_bytes())
        .map_err(|_| WorkspacePatchErrorKind::InvalidPath)?;
    let target = CString::new(file_name.as_os_str().as_bytes())
        .map_err(|_| WorkspacePatchErrorKind::InvalidPath)?;
    // SAFETY: both directory descriptors and NUL-terminated relative names are valid.
    if unsafe {
        libc::renameat(
            root.as_raw_fd(),
            temp.as_ptr(),
            parent.as_raw_fd(),
            target.as_ptr(),
        )
    } != 0
    {
        return Err(WorkspacePatchErrorKind::AtomicReplaceUnavailable);
    }
    root.try_clone()
        .map(Dir::into_std_file)
        .and_then(|file| file.sync_all())
        .map_err(|_| WorkspacePatchErrorKind::AtomicReplaceUnavailable)?;
    parent
        .try_clone()
        .map(Dir::into_std_file)
        .and_then(|file| file.sync_all())
        .map_err(|_| WorkspacePatchErrorKind::AtomicReplaceUnavailable)
}

#[cfg(windows)]
fn atomic_replace(
    root: &Dir,
    temp_name: &Path,
    parent: &Dir,
    file_name: &Path,
) -> Result<(), WorkspacePatchErrorKind> {
    use windows_sys::Win32::Storage::FileSystem::REPLACEFILE_WRITE_THROUGH;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    let root_path = directory_final_path(root)?;
    let parent_path = directory_final_path(parent)?;
    let replacement = wide_path(&root_path.join(temp_name));
    let replaced = wide_path(&parent_path.join(file_name));
    // SAFETY: both path buffers are NUL-terminated for the duration of the call.
    let result = unsafe {
        ReplaceFileW(
            replaced.as_ptr(),
            replacement.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if result == 0 {
        Err(WorkspacePatchErrorKind::AtomicReplaceUnavailable)
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn volume_serial(directory: &Dir) -> Option<u32> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION;
    use windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandle;
    let file = directory.try_clone().ok()?.into_std_file();
    let mut information = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
    // SAFETY: the handle and output buffer are valid.
    let result = unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) };
    (result != 0).then_some(information.dwVolumeSerialNumber)
}

#[cfg(windows)]
fn directory_final_path(directory: &Dir) -> Result<PathBuf, WorkspacePatchErrorKind> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::FILE_NAME_NORMALIZED;
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    use windows_sys::Win32::Storage::FileSystem::VOLUME_NAME_DOS;
    let file = directory
        .try_clone()
        .map_err(|_| WorkspacePatchErrorKind::Unavailable)?
        .into_std_file();
    let flags = FILE_NAME_NORMALIZED | VOLUME_NAME_DOS;
    // SAFETY: querying the required buffer length uses a valid handle and null buffer.
    let length = unsafe {
        GetFinalPathNameByHandleW(file.as_raw_handle() as _, std::ptr::null_mut(), 0, flags)
    };
    if length == 0 {
        return Err(WorkspacePatchErrorKind::Unavailable);
    }
    let mut buffer = vec![0u16; length as usize + 1];
    // SAFETY: the buffer is writable and sized from the preceding query.
    let written = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle() as _,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            flags,
        )
    };
    if written == 0 || written as usize >= buffer.len() {
        return Err(WorkspacePatchErrorKind::Unavailable);
    }
    buffer.truncate(written as usize);
    Ok(PathBuf::from(std::ffi::OsString::from_wide(&buffer)))
}

#[cfg(windows)]
fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(not(any(unix, windows)))]
fn atomic_replace(
    root: &Dir,
    temp_name: &Path,
    parent: &Dir,
    file_name: &Path,
) -> Result<(), WorkspacePatchErrorKind> {
    root.rename(temp_name, parent, file_name)
        .map_err(|_| WorkspacePatchErrorKind::AtomicReplaceUnavailable)
}

struct TextFile {
    lines: Vec<String>,
    newline: WorkspaceNewlineStyle,
    final_newline: bool,
}

impl TextFile {
    fn parse(bytes: &[u8]) -> Result<Self, WorkspacePatchErrorKind> {
        if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
            return Err(WorkspacePatchErrorKind::InvalidEncoding);
        }
        if bytes.contains(&0) {
            return Err(WorkspacePatchErrorKind::BinaryFile);
        }
        let text =
            std::str::from_utf8(bytes).map_err(|_| WorkspacePatchErrorKind::InvalidEncoding)?;
        let has_crlf = text.contains("\r\n");
        let mut has_lf = false;
        let bytes_view = text.as_bytes();
        for (index, byte) in bytes_view.iter().enumerate() {
            if *byte == b'\r' && bytes_view.get(index + 1) != Some(&b'\n') {
                return Err(WorkspacePatchErrorKind::InvalidNewline);
            }
            if *byte == b'\n' && (index == 0 || bytes_view[index - 1] != b'\r') {
                has_lf = true;
            }
        }
        if has_crlf && has_lf {
            return Err(WorkspacePatchErrorKind::InvalidNewline);
        }
        let newline = if has_crlf {
            WorkspaceNewlineStyle::CrLf
        } else {
            WorkspaceNewlineStyle::Lf
        };
        let separator = match newline {
            WorkspaceNewlineStyle::Lf => "\n",
            WorkspaceNewlineStyle::CrLf => "\r\n",
        };
        let final_newline = !text.is_empty() && text.ends_with(separator);
        let body = if final_newline {
            &text[..text.len() - separator.len()]
        } else {
            text
        };
        let lines = if body.is_empty() {
            if final_newline {
                vec![String::new()]
            } else {
                Vec::new()
            }
        } else {
            body.split(separator)
                .map(str::to_string)
                .collect::<Vec<_>>()
        };
        if lines.len() > MAX_WORKSPACE_FILE_LINES {
            return Err(WorkspacePatchErrorKind::TooManyLines);
        }
        if lines
            .iter()
            .any(|line| line.len() > MAX_WORKSPACE_LINE_BYTES)
        {
            return Err(WorkspacePatchErrorKind::LineTooLong);
        }
        Ok(Self {
            lines,
            newline,
            final_newline,
        })
    }
}

fn encode_text(lines: &[String], newline: WorkspaceNewlineStyle, final_newline: bool) -> Vec<u8> {
    let separator = match newline {
        WorkspaceNewlineStyle::Lf => "\n",
        WorkspaceNewlineStyle::CrLf => "\r\n",
    };
    let mut text = lines.join(separator);
    if final_newline {
        text.push_str(separator);
    }
    text.into_bytes()
}

#[derive(Debug)]
struct Hunk {
    old_start: usize,
    old_count: usize,
    new_start: usize,
    new_count: usize,
    lines: Vec<PatchLine>,
}

#[derive(Debug, Clone)]
enum PatchLine {
    Context(String),
    Remove(String),
    Add(String),
}

fn parse_patch(patch: &str) -> Result<Vec<Hunk>, WorkspacePatchErrorKind> {
    if !patch.ends_with('\n') || patch.contains('\r') || patch.contains('\0') {
        return Err(WorkspacePatchErrorKind::InvalidPatch);
    }
    let raw_lines = patch[..patch.len() - 1].split('\n').collect::<Vec<_>>();
    if raw_lines.len() > MAX_WORKSPACE_PATCH_LINES {
        return Err(WorkspacePatchErrorKind::InvalidPatch);
    }
    let mut hunks = Vec::new();
    let mut index = 0;
    while index < raw_lines.len() {
        let (old_start, old_count, new_start, new_count) = parse_hunk_header(raw_lines[index])?;
        index += 1;
        let mut lines = Vec::new();
        let mut observed_old = 0usize;
        let mut observed_new = 0usize;
        while index < raw_lines.len() && !raw_lines[index].starts_with("@@") {
            let line = raw_lines[index];
            let (prefix, value) = line
                .split_at_checked(1)
                .ok_or(WorkspacePatchErrorKind::InvalidPatch)?;
            if value.len() > MAX_WORKSPACE_LINE_BYTES {
                return Err(WorkspacePatchErrorKind::LineTooLong);
            }
            match prefix {
                " " => {
                    observed_old += 1;
                    observed_new += 1;
                    lines.push(PatchLine::Context(value.to_string()));
                }
                "-" => {
                    observed_old += 1;
                    lines.push(PatchLine::Remove(value.to_string()));
                }
                "+" => {
                    observed_new += 1;
                    lines.push(PatchLine::Add(value.to_string()));
                }
                _ => return Err(WorkspacePatchErrorKind::InvalidPatch),
            }
            index += 1;
        }
        if observed_old != old_count || observed_new != new_count || lines.is_empty() {
            return Err(WorkspacePatchErrorKind::InvalidPatch);
        }
        hunks.push(Hunk {
            old_start,
            old_count,
            new_start,
            new_count,
            lines,
        });
        if hunks.len() > MAX_WORKSPACE_PATCH_HUNKS {
            return Err(WorkspacePatchErrorKind::InvalidPatch);
        }
    }
    if hunks.is_empty() {
        Err(WorkspacePatchErrorKind::InvalidPatch)
    } else {
        Ok(hunks)
    }
}

fn parse_hunk_header(line: &str) -> Result<(usize, usize, usize, usize), WorkspacePatchErrorKind> {
    if !line.starts_with("@@ -") || !line.ends_with(" @@") {
        return Err(WorkspacePatchErrorKind::InvalidPatch);
    }
    let middle = &line[4..line.len() - 3];
    let (old, new) = middle
        .split_once(" +")
        .ok_or(WorkspacePatchErrorKind::InvalidPatch)?;
    let (old_start, old_count) = parse_range(old)?;
    let (new_start, new_count) = parse_range(new)?;
    Ok((old_start, old_count, new_start, new_count))
}

fn parse_range(value: &str) -> Result<(usize, usize), WorkspacePatchErrorKind> {
    let (start, count) = value
        .split_once(',')
        .ok_or(WorkspacePatchErrorKind::InvalidPatch)?;
    if (start.starts_with('0') && start != "0") || (count.starts_with('0') && count != "0") {
        return Err(WorkspacePatchErrorKind::InvalidPatch);
    }
    let start = start
        .parse()
        .map_err(|_| WorkspacePatchErrorKind::InvalidPatch)?;
    let count = count
        .parse()
        .map_err(|_| WorkspacePatchErrorKind::InvalidPatch)?;
    if start == 0 && count != 0 {
        return Err(WorkspacePatchErrorKind::InvalidPatch);
    }
    Ok((start, count))
}

#[derive(Debug, Clone)]
enum DiffOperation {
    Equal(String),
    Remove(String),
    Add(String),
}

fn apply_hunks(
    before: &[String],
    hunks: &[Hunk],
) -> Result<(Vec<String>, Vec<DiffOperation>), WorkspacePatchErrorKind> {
    let mut after = Vec::new();
    let mut operations = Vec::new();
    let mut old_cursor = 0usize;
    let mut new_cursor = 0usize;
    let mut changed = false;
    for hunk in hunks {
        let expected_old = if hunk.old_count == 0 {
            hunk.old_start
        } else {
            hunk.old_start
                .checked_sub(1)
                .ok_or(WorkspacePatchErrorKind::InvalidPatch)?
        };
        let expected_new = if hunk.new_count == 0 {
            hunk.new_start
        } else {
            hunk.new_start
                .checked_sub(1)
                .ok_or(WorkspacePatchErrorKind::InvalidPatch)?
        };
        if expected_old < old_cursor || expected_new < new_cursor {
            return Err(WorkspacePatchErrorKind::InvalidPatch);
        }
        while old_cursor < expected_old {
            let line = before
                .get(old_cursor)
                .ok_or(WorkspacePatchErrorKind::PatchDoesNotApply)?
                .clone();
            after.push(line.clone());
            operations.push(DiffOperation::Equal(line));
            old_cursor += 1;
            new_cursor += 1;
        }
        if new_cursor != expected_new {
            return Err(WorkspacePatchErrorKind::InvalidPatch);
        }
        for line in &hunk.lines {
            match line {
                PatchLine::Context(expected) => {
                    if before.get(old_cursor) != Some(expected) {
                        return Err(WorkspacePatchErrorKind::PatchDoesNotApply);
                    }
                    after.push(expected.clone());
                    operations.push(DiffOperation::Equal(expected.clone()));
                    old_cursor += 1;
                    new_cursor += 1;
                }
                PatchLine::Remove(expected) => {
                    if before.get(old_cursor) != Some(expected) {
                        return Err(WorkspacePatchErrorKind::PatchDoesNotApply);
                    }
                    operations.push(DiffOperation::Remove(expected.clone()));
                    old_cursor += 1;
                    changed = true;
                }
                PatchLine::Add(value) => {
                    after.push(value.clone());
                    operations.push(DiffOperation::Add(value.clone()));
                    new_cursor += 1;
                    changed = true;
                }
            }
        }
    }
    while old_cursor < before.len() {
        let line = before[old_cursor].clone();
        after.push(line.clone());
        operations.push(DiffOperation::Equal(line));
        old_cursor += 1;
    }
    if !changed {
        return Err(WorkspacePatchErrorKind::InvalidPatch);
    }
    Ok((after, operations))
}

fn render_diff(
    path: &str,
    operations: &[DiffOperation],
) -> Result<String, WorkspacePatchErrorKind> {
    let changed = operations
        .iter()
        .enumerate()
        .filter_map(|(index, operation)| {
            (!matches!(operation, DiffOperation::Equal(_))).then_some(index)
        })
        .collect::<Vec<_>>();
    let mut ranges = Vec::<(usize, usize)>::new();
    for index in changed {
        let start = context_start(operations, index, 3);
        let end = context_end(operations, index, 3);
        if let Some(last) = ranges.last_mut().filter(|last| start <= last.1) {
            last.1 = last.1.max(end);
        } else {
            ranges.push((start, end));
        }
    }
    let mut old_positions = vec![1usize; operations.len() + 1];
    let mut new_positions = vec![1usize; operations.len() + 1];
    for (index, operation) in operations.iter().enumerate() {
        old_positions[index + 1] =
            old_positions[index] + usize::from(!matches!(operation, DiffOperation::Add(_)));
        new_positions[index + 1] =
            new_positions[index] + usize::from(!matches!(operation, DiffOperation::Remove(_)));
    }
    let mut diff = format!("--- a/{path}\n+++ b/{path}\n");
    for (start, end) in ranges {
        let old_count = operations[start..end]
            .iter()
            .filter(|op| !matches!(op, DiffOperation::Add(_)))
            .count();
        let new_count = operations[start..end]
            .iter()
            .filter(|op| !matches!(op, DiffOperation::Remove(_)))
            .count();
        diff.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            old_positions[start], old_count, new_positions[start], new_count
        ));
        for operation in &operations[start..end] {
            let (prefix, value) = match operation {
                DiffOperation::Equal(value) => (' ', value),
                DiffOperation::Remove(value) => ('-', value),
                DiffOperation::Add(value) => ('+', value),
            };
            diff.push(prefix);
            diff.push_str(value);
            diff.push('\n');
        }
    }
    if diff.len() > MAX_WORKSPACE_DIFF_BYTES || diff.lines().count() > MAX_WORKSPACE_DIFF_LINES {
        Err(WorkspacePatchErrorKind::ResultTooLarge)
    } else {
        Ok(diff)
    }
}

fn context_start(operations: &[DiffOperation], index: usize, count: usize) -> usize {
    let mut cursor = index;
    let mut remaining = count;
    while cursor > 0 && remaining > 0 {
        if !matches!(operations[cursor - 1], DiffOperation::Equal(_)) {
            break;
        }
        cursor -= 1;
        remaining -= 1;
    }
    cursor
}

fn context_end(operations: &[DiffOperation], index: usize, count: usize) -> usize {
    let mut cursor = index + 1;
    let mut remaining = count;
    while cursor < operations.len() && remaining > 0 {
        if !matches!(operations[cursor], DiffOperation::Equal(_)) {
            cursor += 1;
            continue;
        }
        cursor += 1;
        remaining -= 1;
    }
    cursor
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn map_read_error(kind: WorkspaceReadErrorKind) -> WorkspacePatchErrorKind {
    match kind {
        WorkspaceReadErrorKind::InvalidPath => WorkspacePatchErrorKind::InvalidPath,
        WorkspaceReadErrorKind::NotFound => WorkspacePatchErrorKind::NotFound,
        WorkspaceReadErrorKind::AccessDenied => WorkspacePatchErrorKind::AccessDenied,
        WorkspaceReadErrorKind::PathNotAllowed => WorkspacePatchErrorKind::PathNotAllowed,
        WorkspaceReadErrorKind::NotRegularFile => WorkspacePatchErrorKind::NotRegularFile,
        WorkspaceReadErrorKind::FileTooLarge => WorkspacePatchErrorKind::FileTooLarge,
        WorkspaceReadErrorKind::BinaryFile => WorkspacePatchErrorKind::BinaryFile,
        WorkspaceReadErrorKind::ChangedDuringRead => WorkspacePatchErrorKind::Conflict,
        WorkspaceReadErrorKind::Cancelled => WorkspacePatchErrorKind::Cancelled,
        WorkspaceReadErrorKind::Unavailable => WorkspacePatchErrorKind::Unavailable,
    }
}

fn prepare_error(kind: WorkspacePatchErrorKind) -> WorkspacePatchPrepareOutcome {
    WorkspacePatchPrepareOutcome::Error { kind }
}

fn commit_error(kind: WorkspacePatchErrorKind) -> WorkspacePatchCommitOutcome {
    WorkspacePatchCommitOutcome::Error { kind }
}

#[cfg(test)]
#[path = "tests/workspace_patch.rs"]
mod tests;
