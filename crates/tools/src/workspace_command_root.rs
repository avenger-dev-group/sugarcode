use crate::WorkspaceReadErrorKind;
use crate::workspace_capability::WorkspaceTool;
use std::fmt;
#[cfg(unix)]
use std::fs::File;
use std::sync::Arc;

pub struct CommandWorkspaceRoot {
    #[cfg(unix)]
    directory: File,
    #[cfg(unix)]
    identity: CommandWorkspaceRootIdentity,
    write_gate: Arc<crate::workspace_capability::WorkspaceWriteGate>,
}

impl fmt::Debug for CommandWorkspaceRoot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CommandWorkspaceRoot")
            .field("directory", &"<redacted>")
            .finish()
    }
}

impl CommandWorkspaceRoot {
    #[cfg(unix)]
    pub(crate) fn from_workspace(
        workspace: &WorkspaceTool,
    ) -> Result<Self, WorkspaceReadErrorKind> {
        let directory = workspace
            .root
            .try_clone()
            .map_err(|_| WorkspaceReadErrorKind::Unavailable)?
            .into_std_file();
        let metadata = directory
            .metadata()
            .map_err(|_| WorkspaceReadErrorKind::Unavailable)?;
        if !metadata.is_dir() {
            return Err(WorkspaceReadErrorKind::NotRegularFile);
        }
        let identity = CommandWorkspaceRootIdentity::from_metadata(&metadata);
        Ok(Self {
            directory,
            identity,
            write_gate: Arc::clone(&workspace.write_gate),
        })
    }

    #[cfg(not(unix))]
    pub(crate) fn from_workspace(
        workspace: &WorkspaceTool,
    ) -> Result<Self, WorkspaceReadErrorKind> {
        Ok(Self {
            write_gate: Arc::clone(&workspace.write_gate),
        })
    }

    #[cfg(unix)]
    pub(crate) fn try_clone_directory(&self) -> Result<File, std::io::Error> {
        self.directory.try_clone()
    }

    #[cfg(unix)]
    pub(crate) fn identity(&self) -> CommandWorkspaceRootIdentity {
        self.identity
    }

    pub(crate) async fn acquire_write(&self) -> crate::workspace_capability::WorkspaceWritePermit {
        crate::workspace_capability::WorkspaceWriteGate::acquire_async(Arc::clone(&self.write_gate))
            .await
    }
}

#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandWorkspaceRootIdentity {
    device: u64,
    inode: u64,
}

#[cfg(unix)]
impl CommandWorkspaceRootIdentity {
    fn from_metadata(metadata: &std::fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;

        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    }

    pub(crate) fn matches(self, directory: &File) -> Result<bool, std::io::Error> {
        let metadata = directory.metadata()?;
        Ok(metadata.is_dir() && self == Self::from_metadata(&metadata))
    }
}

#[cfg(test)]
#[path = "tests/workspace_command_root.rs"]
mod tests;
