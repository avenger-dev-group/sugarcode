use crate::workspace_capability::FileSnapshot;
use crate::workspace_capability::MAX_WORKSPACE_READ_BYTES;
use crate::workspace_capability::WorkspaceReadErrorKind;
use crate::workspace_capability::WorkspaceTool;
use crate::workspace_capability::classify_component_open_error;
use crate::workspace_capability::map_io_error;
use crate::workspace_capability::open_regular_file_nofollow;
use crate::workspace_capability::validate_directory_handle;
use crate::workspace_capability::validate_relative_path;
use cap_fs_ext::DirExt;
use std::fmt;
use std::future::Future;
use std::io::Read;
use std::pin::Pin;
use tokio_util::sync::CancellationToken;

pub(crate) const READ_CHUNK_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceReadArguments {
    pub path: String,
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

impl WorkspaceTool {
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

        let mut bytes = Vec::with_capacity(opened_snapshot.len() as usize);
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

fn error(kind: WorkspaceReadErrorKind) -> WorkspaceReadOutcome {
    WorkspaceReadOutcome::Error { kind }
}

#[cfg(test)]
#[path = "tests/workspace_read.rs"]
mod tests;
