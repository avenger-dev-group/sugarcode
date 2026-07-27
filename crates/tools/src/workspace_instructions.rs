use crate::workspace_capability::FileSnapshot;
use crate::workspace_capability::WorkspaceReadErrorKind;
use crate::workspace_capability::WorkspaceTool;
use crate::workspace_capability::map_io_error;
use crate::workspace_capability::open_regular_file_nofollow;
use sha2::Digest;
use sha2::Sha256;
use std::io::Read;
use std::path::Path;

pub const WORKSPACE_INSTRUCTIONS_FILE_NAME: &str = "AGENTS.md";
pub const MAX_WORKSPACE_INSTRUCTIONS_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceInstructionsErrorKind {
    AccessDenied,
    PathNotAllowed,
    NotRegularFile,
    HardLinkNotAllowed,
    FileTooLarge,
    InvalidEncoding,
    ChangedDuringRead,
    Unavailable,
}

#[derive(Clone, PartialEq, Eq)]
pub enum WorkspaceInstructionsSnapshot {
    Absent,
    Present {
        content: String,
        bytes: usize,
        sha256: String,
    },
}

impl std::fmt::Debug for WorkspaceInstructionsSnapshot {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Absent => formatter.write_str("Absent"),
            Self::Present { bytes, sha256, .. } => formatter
                .debug_struct("Present")
                .field("content", &"<redacted>")
                .field("bytes", bytes)
                .field("sha256", sha256)
                .finish(),
        }
    }
}

impl WorkspaceTool {
    pub fn load_root_instructions(
        &self,
    ) -> Result<WorkspaceInstructionsSnapshot, WorkspaceInstructionsErrorKind> {
        self.load_root_instructions_with_before_reopen(|| {})
    }

    fn load_root_instructions_with_before_reopen<F>(
        &self,
        before_reopen: F,
    ) -> Result<WorkspaceInstructionsSnapshot, WorkspaceInstructionsErrorKind>
    where
        F: FnOnce(),
    {
        let file_name = Path::new(WORKSPACE_INSTRUCTIONS_FILE_NAME);
        let (mut file, opened_snapshot) = match open_regular_file_nofollow(&self.root, file_name) {
            Ok(opened) => opened,
            Err(WorkspaceReadErrorKind::NotFound) => {
                return Ok(WorkspaceInstructionsSnapshot::Absent);
            }
            Err(kind) => return Err(map_workspace_error(kind)),
        };
        if opened_snapshot.links() != 1 {
            return Err(WorkspaceInstructionsErrorKind::HardLinkNotAllowed);
        }
        if opened_snapshot.len() > MAX_WORKSPACE_INSTRUCTIONS_BYTES as u64 {
            return Err(WorkspaceInstructionsErrorKind::FileTooLarge);
        }

        let mut bytes = Vec::with_capacity(opened_snapshot.len() as usize);
        let mut buffer = [0_u8; 8 * 1024];
        loop {
            let count = file
                .read(&mut buffer)
                .map_err(|error| map_workspace_error(map_io_error(&error)))?;
            if count == 0 {
                break;
            }
            if bytes
                .len()
                .checked_add(count)
                .is_none_or(|length| length > MAX_WORKSPACE_INSTRUCTIONS_BYTES)
            {
                return Err(WorkspaceInstructionsErrorKind::FileTooLarge);
            }
            bytes.extend_from_slice(&buffer[..count]);
        }

        let final_metadata = file
            .metadata()
            .map_err(|error| map_workspace_error(map_io_error(&error)))?;
        let final_snapshot =
            FileSnapshot::from_file(&file, &final_metadata).map_err(map_workspace_error)?;
        if final_snapshot != opened_snapshot || bytes.len() as u64 != final_metadata.len() {
            return Err(WorkspaceInstructionsErrorKind::ChangedDuringRead);
        }

        before_reopen();
        let reopened_snapshot = open_regular_file_nofollow(&self.root, file_name)
            .map(|(_, snapshot)| snapshot)
            .map_err(|_| WorkspaceInstructionsErrorKind::ChangedDuringRead)?;
        if reopened_snapshot != opened_snapshot {
            return Err(WorkspaceInstructionsErrorKind::ChangedDuringRead);
        }
        if bytes.contains(&0) {
            return Err(WorkspaceInstructionsErrorKind::InvalidEncoding);
        }
        let content = String::from_utf8(bytes)
            .map_err(|_| WorkspaceInstructionsErrorKind::InvalidEncoding)?;
        let sha256 = format!("{:x}", Sha256::digest(content.as_bytes()));
        Ok(WorkspaceInstructionsSnapshot::Present {
            bytes: content.len(),
            content,
            sha256,
        })
    }
}

fn map_workspace_error(kind: WorkspaceReadErrorKind) -> WorkspaceInstructionsErrorKind {
    match kind {
        WorkspaceReadErrorKind::AccessDenied => WorkspaceInstructionsErrorKind::AccessDenied,
        WorkspaceReadErrorKind::PathNotAllowed => WorkspaceInstructionsErrorKind::PathNotAllowed,
        WorkspaceReadErrorKind::NotRegularFile => WorkspaceInstructionsErrorKind::NotRegularFile,
        WorkspaceReadErrorKind::FileTooLarge => WorkspaceInstructionsErrorKind::FileTooLarge,
        WorkspaceReadErrorKind::BinaryFile => WorkspaceInstructionsErrorKind::InvalidEncoding,
        WorkspaceReadErrorKind::ChangedDuringRead => {
            WorkspaceInstructionsErrorKind::ChangedDuringRead
        }
        WorkspaceReadErrorKind::InvalidPath
        | WorkspaceReadErrorKind::NotFound
        | WorkspaceReadErrorKind::Cancelled
        | WorkspaceReadErrorKind::Unavailable => WorkspaceInstructionsErrorKind::Unavailable,
    }
}

#[cfg(test)]
#[path = "tests/workspace_instructions.rs"]
mod tests;
