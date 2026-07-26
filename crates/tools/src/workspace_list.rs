use crate::workspace_read::FileSnapshot;
use crate::workspace_read::WorkspaceReadErrorKind;
use crate::workspace_read::WorkspaceTool;
use crate::workspace_read::is_nofollow_error;
use crate::workspace_read::map_io_error;
use crate::workspace_read::open_root_nofollow;
use crate::workspace_read::validate_directory_handle;
use crate::workspace_read::validate_relative_path;
use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use std::fmt;
use std::future::Future;
use std::path::Path;
use std::path::PathBuf;
use std::pin::Pin;
use tokio_util::sync::CancellationToken;

pub const MAX_WORKSPACE_LIST_COMPONENTS: usize = 64;
pub const MAX_WORKSPACE_LIST_ENTRIES: usize = 1_000;
pub const MAX_WORKSPACE_LIST_ENTRY_NAME_BYTES: usize = 1_024;
pub const MAX_WORKSPACE_LIST_TOTAL_NAME_BYTES: usize = 256 * 1_024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceListArguments {
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceListEntryKind {
    File,
    Directory,
    Link,
    Other,
}

impl WorkspaceListEntryKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Directory => "directory",
            Self::Link => "link",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceListEntry {
    pub name: String,
    pub kind: WorkspaceListEntryKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceListErrorKind {
    InvalidPath,
    NotFound,
    AccessDenied,
    PathNotAllowed,
    NotDirectory,
    InvalidEncoding,
    InvalidName,
    TooManyEntries,
    ChangedDuringList,
    ResultTooLarge,
    Cancelled,
    Unavailable,
}

#[derive(Clone, PartialEq, Eq)]
pub enum WorkspaceListOutcome {
    Entries {
        entries: Vec<WorkspaceListEntry>,
        name_bytes: usize,
    },
    Error {
        kind: WorkspaceListErrorKind,
    },
}

impl fmt::Debug for WorkspaceListOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Entries {
                entries,
                name_bytes,
            } => formatter
                .debug_struct("Entries")
                .field("entry_count", &entries.len())
                .field("name_bytes", name_bytes)
                .finish(),
            Self::Error { kind } => formatter.debug_struct("Error").field("kind", kind).finish(),
        }
    }
}

pub trait WorkspaceListExecutor: fmt::Debug + Send + Sync {
    fn list<'a>(
        &'a self,
        arguments: &'a WorkspaceListArguments,
        cancellation: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = WorkspaceListOutcome> + Send + 'a>>;
}

impl WorkspaceTool {
    pub async fn list(
        &self,
        arguments: &WorkspaceListArguments,
        cancellation: &CancellationToken,
    ) -> WorkspaceListOutcome {
        self.list_with_before_identity_check(arguments, cancellation, || {})
            .await
    }

    async fn list_with_before_identity_check<F>(
        &self,
        arguments: &WorkspaceListArguments,
        cancellation: &CancellationToken,
        before_identity_check: F,
    ) -> WorkspaceListOutcome
    where
        F: FnOnce(),
    {
        if cancellation.is_cancelled() {
            return error(WorkspaceListErrorKind::Cancelled);
        }
        let components = match validate_list_path(&arguments.path) {
            Ok(components) => components,
            Err(kind) => return error(kind),
        };
        let mut directory = match self.root.try_clone() {
            Ok(directory) => directory,
            Err(error_value) => return error(map_list_io_error(&error_value)),
        };
        let mut parent = None;
        let mut target_name = None;
        for component in &components {
            if cancellation.is_cancelled() {
                return error(WorkspaceListErrorKind::Cancelled);
            }
            let next = match directory.open_dir_nofollow(component) {
                Ok(next) => next,
                Err(error_value) => {
                    return error(classify_directory_open_error(
                        &directory,
                        component,
                        &error_value,
                    ));
                }
            };
            if let Err(kind) = validate_directory_handle(&next) {
                return error(map_read_error(kind));
            }
            parent = Some(directory);
            target_name = Some(component.clone());
            directory = next;
        }

        let opened_snapshot = match FileSnapshot::from_directory(&directory) {
            Ok(snapshot) => snapshot,
            Err(kind) => return error(map_read_error(kind)),
        };
        let mut read_dir = match directory.entries() {
            Ok(read_dir) => read_dir,
            Err(error_value) => return error(map_list_io_error(&error_value)),
        };
        let mut entries = Vec::new();
        let mut name_bytes = 0usize;
        for entry in &mut read_dir {
            if cancellation.is_cancelled() {
                return error(WorkspaceListErrorKind::Cancelled);
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(error_value) => return error(map_iteration_error(&error_value)),
            };
            if entries.len() >= MAX_WORKSPACE_LIST_ENTRIES {
                return error(WorkspaceListErrorKind::TooManyEntries);
            }
            let name = match entry.file_name().into_string() {
                Ok(name) => name,
                Err(_) => return error(WorkspaceListErrorKind::InvalidEncoding),
            };
            if name.is_empty()
                || name.len() > MAX_WORKSPACE_LIST_ENTRY_NAME_BYTES
                || name.chars().any(char::is_control)
            {
                return error(WorkspaceListErrorKind::InvalidName);
            }
            name_bytes = match name_bytes.checked_add(name.len()) {
                Some(bytes) if bytes <= MAX_WORKSPACE_LIST_TOTAL_NAME_BYTES => bytes,
                _ => return error(WorkspaceListErrorKind::ResultTooLarge),
            };
            let metadata = match directory.symlink_metadata(&name) {
                Ok(metadata) => metadata,
                Err(error_value) => return error(map_iteration_error(&error_value)),
            };
            let file_type = metadata.file_type();
            let kind = if file_type.is_symlink() || cap_metadata_is_reparse_point(&metadata) {
                WorkspaceListEntryKind::Link
            } else if file_type.is_file() {
                WorkspaceListEntryKind::File
            } else if file_type.is_dir() {
                WorkspaceListEntryKind::Directory
            } else {
                WorkspaceListEntryKind::Other
            };
            entries.push(WorkspaceListEntry { name, kind });
            tokio::task::yield_now().await;
        }

        if cancellation.is_cancelled() {
            return error(WorkspaceListErrorKind::Cancelled);
        }
        before_identity_check();
        let final_snapshot = match FileSnapshot::from_directory(&directory) {
            Ok(snapshot) => snapshot,
            Err(_) => return error(WorkspaceListErrorKind::ChangedDuringList),
        };
        let reopened = match (parent.as_ref(), target_name.as_ref()) {
            (Some(parent), Some(target_name)) => match parent.open_dir_nofollow(target_name) {
                Ok(directory) => directory,
                Err(_) => return error(WorkspaceListErrorKind::ChangedDuringList),
            },
            (None, None) => match open_root_nofollow(&self.root_path) {
                Ok(directory) => directory,
                Err(_) => return error(WorkspaceListErrorKind::ChangedDuringList),
            },
            _ => unreachable!("target parent and name are paired"),
        };
        let reopened_snapshot = match FileSnapshot::from_directory(&reopened) {
            Ok(snapshot) => snapshot,
            Err(_) => return error(WorkspaceListErrorKind::ChangedDuringList),
        };
        if opened_snapshot != final_snapshot || opened_snapshot != reopened_snapshot {
            return error(WorkspaceListErrorKind::ChangedDuringList);
        }

        entries.sort_unstable_by(|left, right| left.name.as_bytes().cmp(right.name.as_bytes()));
        if cancellation.is_cancelled() {
            return error(WorkspaceListErrorKind::Cancelled);
        }
        WorkspaceListOutcome::Entries {
            entries,
            name_bytes,
        }
    }
}

impl WorkspaceListExecutor for WorkspaceTool {
    fn list<'a>(
        &'a self,
        arguments: &'a WorkspaceListArguments,
        cancellation: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = WorkspaceListOutcome> + Send + 'a>> {
        Box::pin(WorkspaceTool::list(self, arguments, cancellation))
    }
}

pub(crate) fn validate_list_path(path: &str) -> Result<Vec<PathBuf>, WorkspaceListErrorKind> {
    let components = if path == "." {
        Vec::new()
    } else {
        validate_relative_path(path).map_err(map_read_error)?
    };
    if components.len() > MAX_WORKSPACE_LIST_COMPONENTS {
        Err(WorkspaceListErrorKind::InvalidPath)
    } else {
        Ok(components)
    }
}

pub(crate) fn classify_directory_open_error(
    directory: &Dir,
    path: &Path,
    error_value: &std::io::Error,
) -> WorkspaceListErrorKind {
    match directory.symlink_metadata(path) {
        Ok(metadata)
            if metadata.file_type().is_symlink() || cap_metadata_is_reparse_point(&metadata) =>
        {
            WorkspaceListErrorKind::PathNotAllowed
        }
        Ok(metadata) if !metadata.file_type().is_dir() => WorkspaceListErrorKind::NotDirectory,
        Ok(_) if is_nofollow_error(error_value) => WorkspaceListErrorKind::PathNotAllowed,
        _ => map_list_io_error(error_value),
    }
}

fn map_read_error(kind: WorkspaceReadErrorKind) -> WorkspaceListErrorKind {
    match kind {
        WorkspaceReadErrorKind::InvalidPath => WorkspaceListErrorKind::InvalidPath,
        WorkspaceReadErrorKind::NotFound => WorkspaceListErrorKind::NotFound,
        WorkspaceReadErrorKind::AccessDenied => WorkspaceListErrorKind::AccessDenied,
        WorkspaceReadErrorKind::PathNotAllowed => WorkspaceListErrorKind::PathNotAllowed,
        WorkspaceReadErrorKind::NotRegularFile => WorkspaceListErrorKind::NotDirectory,
        WorkspaceReadErrorKind::Cancelled => WorkspaceListErrorKind::Cancelled,
        WorkspaceReadErrorKind::FileTooLarge
        | WorkspaceReadErrorKind::BinaryFile
        | WorkspaceReadErrorKind::ChangedDuringRead
        | WorkspaceReadErrorKind::Unavailable => WorkspaceListErrorKind::Unavailable,
    }
}

fn map_list_io_error(error_value: &std::io::Error) -> WorkspaceListErrorKind {
    map_read_error(map_io_error(error_value))
}

pub(crate) fn map_iteration_error(error_value: &std::io::Error) -> WorkspaceListErrorKind {
    match error_value.kind() {
        std::io::ErrorKind::NotFound => WorkspaceListErrorKind::ChangedDuringList,
        _ => map_list_io_error(error_value),
    }
}

#[cfg(windows)]
pub(crate) fn cap_metadata_is_reparse_point(metadata: &cap_std::fs::Metadata) -> bool {
    use cap_std::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
pub(crate) fn cap_metadata_is_reparse_point(_metadata: &cap_std::fs::Metadata) -> bool {
    false
}

fn error(kind: WorkspaceListErrorKind) -> WorkspaceListOutcome {
    WorkspaceListOutcome::Error { kind }
}

#[cfg(test)]
#[path = "workspace_list/tests/mod.rs"]
mod tests;
