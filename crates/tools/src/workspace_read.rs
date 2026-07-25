use cap_std::ambient_authority;
use cap_std::fs::Dir;
use std::fmt;
use std::io::Read;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
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

pub struct WorkspaceReadTool {
    root_path: PathBuf,
    root: Dir,
}

impl fmt::Debug for WorkspaceReadTool {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkspaceReadTool")
            .field("root", &"<redacted>")
            .finish()
    }
}

impl WorkspaceReadTool {
    pub fn open(root: &Path) -> Result<Self, WorkspaceReadErrorKind> {
        if !root.is_absolute() {
            return Err(WorkspaceReadErrorKind::InvalidPath);
        }
        let root_path = root.canonicalize().map_err(map_open_error)?;
        if !root_path.is_dir() {
            return Err(WorkspaceReadErrorKind::NotRegularFile);
        }
        let root =
            Dir::open_ambient_dir(&root_path, ambient_authority()).map_err(map_open_error)?;
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
            let metadata = match directory.symlink_metadata(component) {
                Ok(metadata) => metadata,
                Err(error_value) => return error(map_io_error(&error_value)),
            };
            if metadata.file_type().is_symlink() {
                return error(WorkspaceReadErrorKind::PathNotAllowed);
            }
            if !metadata.is_dir() {
                return error(WorkspaceReadErrorKind::NotRegularFile);
            }
            directory = match directory.open_dir(component) {
                Ok(next) => next,
                Err(error_value) => return error(map_io_error(&error_value)),
            };
        }

        let metadata = match directory.symlink_metadata(file_name) {
            Ok(metadata) => metadata,
            Err(error_value) => return error(map_io_error(&error_value)),
        };
        if metadata.file_type().is_symlink() {
            return error(WorkspaceReadErrorKind::PathNotAllowed);
        }
        if !metadata.is_file() {
            return error(WorkspaceReadErrorKind::NotRegularFile);
        }
        if metadata.len() > MAX_WORKSPACE_READ_BYTES as u64 {
            return error(WorkspaceReadErrorKind::FileTooLarge);
        }
        let mut file = match directory.open(file_name) {
            Ok(file) => file,
            Err(error_value) => return error(map_io_error(&error_value)),
        };
        let opened_metadata = match file.metadata() {
            Ok(metadata) => metadata,
            Err(error_value) => return error(map_io_error(&error_value)),
        };
        if !opened_metadata.is_file() {
            return error(WorkspaceReadErrorKind::NotRegularFile);
        }
        if opened_metadata.len() > MAX_WORKSPACE_READ_BYTES as u64 {
            return error(WorkspaceReadErrorKind::FileTooLarge);
        }

        let mut bytes = Vec::with_capacity(opened_metadata.len() as usize);
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
        if final_metadata.len() != opened_metadata.len()
            || bytes.len() as u64 != final_metadata.len()
        {
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

fn validate_relative_path(path: &str) -> Result<Vec<PathBuf>, WorkspaceReadErrorKind> {
    if path.is_empty()
        || path.len() > MAX_WORKSPACE_RELATIVE_PATH_BYTES
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

fn map_open_error(error_value: std::io::Error) -> WorkspaceReadErrorKind {
    map_io_error(&error_value)
}

fn map_io_error(error_value: &std::io::Error) -> WorkspaceReadErrorKind {
    match error_value.kind() {
        std::io::ErrorKind::NotFound => WorkspaceReadErrorKind::NotFound,
        std::io::ErrorKind::PermissionDenied => WorkspaceReadErrorKind::AccessDenied,
        std::io::ErrorKind::InvalidInput => WorkspaceReadErrorKind::InvalidPath,
        _ => WorkspaceReadErrorKind::Unavailable,
    }
}

fn error(kind: WorkspaceReadErrorKind) -> WorkspaceReadOutcome {
    WorkspaceReadOutcome::Error { kind }
}
