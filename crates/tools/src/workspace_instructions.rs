use crate::workspace_capability::FileSnapshot;
use crate::workspace_capability::WorkspaceReadErrorKind;
use crate::workspace_capability::WorkspaceRootReopen;
use crate::workspace_capability::WorkspaceTool;
use crate::workspace_capability::map_io_error;
use crate::workspace_capability::open_directory_component;
use crate::workspace_capability::validate_relative_path;
use crate::workspace_skills::WorkspaceScopeContextErrorKind;
use crate::workspace_skills::WorkspaceSkillsSnapshot;
use crate::workspace_skills::load_workspace_skills;
use crate::workspace_snapshot::StableUtf8FileErrorKind;
use crate::workspace_snapshot::read_stable_utf8_file_before_reopen;
use cap_std::fs::Dir;
use sha2::Digest;
use sha2::Sha256;
use std::path::Path;
use std::path::PathBuf;

pub const WORKSPACE_INSTRUCTIONS_FILE_NAME: &str = "AGENTS.md";
pub const MAX_WORKSPACE_INSTRUCTIONS_BYTES: usize = 32 * 1024;
const WORKSPACE_INSTRUCTIONS_MANIFEST_DOMAIN: &[u8] = b"boundedNestedWorkspaceInstructionsV1\0";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceInstructionsErrorKind {
    AccessDenied,
    PathNotAllowed,
    NotRegularFile,
    HardLinkNotAllowed,
    FileTooLarge,
    InvalidEncoding,
    ChangedDuringRead,
    ChangedDuringDiscovery,
    AggregateTooLarge,
    Unavailable,
}

#[derive(Clone, PartialEq, Eq)]
pub struct WorkspaceInstructionEntry {
    pub path: String,
    pub content: String,
}

impl std::fmt::Debug for WorkspaceInstructionEntry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkspaceInstructionEntry")
            .field("path", &"<redacted>")
            .field("content", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub enum WorkspaceInstructionsSnapshot {
    Absent,
    Present {
        content: String,
        bytes: usize,
        sha256: String,
    },
    Hierarchy {
        entries: Vec<WorkspaceInstructionEntry>,
        present: bool,
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
            Self::Hierarchy {
                entries,
                present,
                bytes,
                sha256,
            } => formatter
                .debug_struct("Hierarchy")
                .field("entry_count", &entries.len())
                .field("present", present)
                .field("bytes", bytes)
                .field("sha256", sha256)
                .finish(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceScopeInstructionsErrorKind {
    Scope(WorkspaceReadErrorKind),
    Instructions(WorkspaceInstructionsErrorKind),
}

#[derive(Clone, PartialEq, Eq)]
enum CandidateSnapshot {
    Absent,
    Present {
        content: String,
        bytes: usize,
        sha256: String,
    },
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
        load_instruction_candidate(&self.root, before_reopen).map(candidate_into_root_snapshot)
    }

    pub fn derive_scope_with_instructions(
        &self,
        scope: &str,
    ) -> Result<(Self, WorkspaceInstructionsSnapshot), WorkspaceScopeInstructionsErrorKind> {
        self.derive_scope_with_instructions_before_revalidate(scope, || {})
    }

    fn derive_scope_with_instructions_before_revalidate<F>(
        &self,
        scope: &str,
        before_revalidate: F,
    ) -> Result<(Self, WorkspaceInstructionsSnapshot), WorkspaceScopeInstructionsErrorKind>
    where
        F: FnOnce(),
    {
        if scope == "." {
            let instructions = self
                .load_root_instructions()
                .map_err(WorkspaceScopeInstructionsErrorKind::Instructions)?;
            let scope = self
                .derive_scope(scope)
                .map_err(WorkspaceScopeInstructionsErrorKind::Scope)?;
            return Ok((scope, instructions));
        }

        let components =
            validate_relative_path(scope).map_err(WorkspaceScopeInstructionsErrorKind::Scope)?;
        let mut directories = Vec::with_capacity(components.len() + 1);
        directories.push(
            self.root.try_clone().map_err(|error| {
                WorkspaceScopeInstructionsErrorKind::Scope(map_io_error(&error))
            })?,
        );
        for component in &components {
            let directory = open_directory_component(
                directories.last().expect("workspace root is present"),
                component,
            )
            .map_err(WorkspaceScopeInstructionsErrorKind::Scope)?;
            directories.push(directory);
        }

        let paths = instruction_paths(&components);
        let mut candidates = Vec::with_capacity(directories.len());
        let mut total_bytes = 0usize;
        for directory in &directories {
            let candidate = load_instruction_candidate(directory, || {})
                .map_err(WorkspaceScopeInstructionsErrorKind::Instructions)?;
            if let CandidateSnapshot::Present { bytes, .. } = &candidate {
                total_bytes = total_bytes.checked_add(*bytes).ok_or(
                    WorkspaceScopeInstructionsErrorKind::Instructions(
                        WorkspaceInstructionsErrorKind::AggregateTooLarge,
                    ),
                )?;
                if total_bytes > MAX_WORKSPACE_INSTRUCTIONS_BYTES {
                    return Err(WorkspaceScopeInstructionsErrorKind::Instructions(
                        WorkspaceInstructionsErrorKind::AggregateTooLarge,
                    ));
                }
            }
            candidates.push(candidate);
        }

        before_revalidate();
        revalidate_hierarchy(&directories, &components, &candidates)
            .map_err(WorkspaceScopeInstructionsErrorKind::Instructions)?;

        let snapshot = hierarchy_snapshot(&paths, candidates, total_bytes);
        let final_index = directories.len() - 1;
        let root = directories[final_index]
            .try_clone()
            .map_err(|error| WorkspaceScopeInstructionsErrorKind::Scope(map_io_error(&error)))?;
        let parent = directories[final_index - 1]
            .try_clone()
            .map_err(|error| WorkspaceScopeInstructionsErrorKind::Scope(map_io_error(&error)))?;
        let name = components
            .last()
            .expect("non-root scope has a final component")
            .clone();
        Ok((
            Self {
                root,
                root_reopen: WorkspaceRootReopen::Relative { parent, name },
            },
            snapshot,
        ))
    }

    pub fn derive_scope_with_context(
        &self,
        scope: &str,
    ) -> Result<
        (Self, WorkspaceInstructionsSnapshot, WorkspaceSkillsSnapshot),
        WorkspaceScopeContextErrorKind,
    > {
        self.derive_scope_with_context_before_revalidate(scope, || {})
    }

    pub(crate) fn derive_scope_with_context_before_revalidate<F>(
        &self,
        scope: &str,
        before_revalidate: F,
    ) -> Result<
        (Self, WorkspaceInstructionsSnapshot, WorkspaceSkillsSnapshot),
        WorkspaceScopeContextErrorKind,
    >
    where
        F: FnOnce(),
    {
        let components = if scope == "." {
            Vec::new()
        } else {
            validate_relative_path(scope).map_err(WorkspaceScopeContextErrorKind::Scope)?
        };
        let mut directories = Vec::with_capacity(components.len() + 1);
        directories.push(
            self.root
                .try_clone()
                .map_err(|error| WorkspaceScopeContextErrorKind::Scope(map_io_error(&error)))?,
        );
        for component in &components {
            let directory = open_directory_component(
                directories.last().expect("workspace root is present"),
                component,
            )
            .map_err(WorkspaceScopeContextErrorKind::Scope)?;
            directories.push(directory);
        }

        let paths = instruction_paths(&components);
        let mut candidates = Vec::with_capacity(directories.len());
        let mut total_bytes = 0usize;
        for directory in &directories {
            let candidate = load_instruction_candidate(directory, || {})
                .map_err(WorkspaceScopeContextErrorKind::Instructions)?;
            if let CandidateSnapshot::Present { bytes, .. } = &candidate {
                total_bytes = total_bytes.checked_add(*bytes).ok_or(
                    WorkspaceScopeContextErrorKind::Instructions(
                        WorkspaceInstructionsErrorKind::AggregateTooLarge,
                    ),
                )?;
                if total_bytes > MAX_WORKSPACE_INSTRUCTIONS_BYTES {
                    return Err(WorkspaceScopeContextErrorKind::Instructions(
                        WorkspaceInstructionsErrorKind::AggregateTooLarge,
                    ));
                }
            }
            candidates.push(candidate);
        }
        let skills = load_workspace_skills(&directories, &components)
            .map_err(WorkspaceScopeContextErrorKind::Skills)?;

        before_revalidate();
        revalidate_hierarchy(&directories, &components, &candidates)
            .map_err(WorkspaceScopeContextErrorKind::Instructions)?;
        let verified_skills = load_workspace_skills(&directories, &components).map_err(|_| {
            WorkspaceScopeContextErrorKind::Skills(
                crate::workspace_skills::WorkspaceSkillsErrorKind::ChangedDuringDiscovery,
            )
        })?;
        if verified_skills != skills {
            return Err(WorkspaceScopeContextErrorKind::Skills(
                crate::workspace_skills::WorkspaceSkillsErrorKind::ChangedDuringDiscovery,
            ));
        }

        let instructions = if components.is_empty() {
            candidate_into_root_snapshot(
                candidates
                    .into_iter()
                    .next()
                    .expect("root instruction candidate is present"),
            )
        } else {
            hierarchy_snapshot(&paths, candidates, total_bytes)
        };
        let scope = if components.is_empty() {
            self.derive_scope(".")
                .map_err(WorkspaceScopeContextErrorKind::Scope)?
        } else {
            let final_index = directories.len() - 1;
            let root = directories[final_index]
                .try_clone()
                .map_err(|error| WorkspaceScopeContextErrorKind::Scope(map_io_error(&error)))?;
            let parent = directories[final_index - 1]
                .try_clone()
                .map_err(|error| WorkspaceScopeContextErrorKind::Scope(map_io_error(&error)))?;
            let name = components
                .last()
                .expect("non-root scope has a final component")
                .clone();
            Self {
                root,
                root_reopen: WorkspaceRootReopen::Relative { parent, name },
            }
        };
        Ok((scope, instructions, skills))
    }
}

fn load_instruction_candidate<F>(
    directory: &Dir,
    before_reopen: F,
) -> Result<CandidateSnapshot, WorkspaceInstructionsErrorKind>
where
    F: FnOnce(),
{
    let file_name = Path::new(WORKSPACE_INSTRUCTIONS_FILE_NAME);
    let snapshot = match read_stable_utf8_file_before_reopen(
        directory,
        file_name,
        MAX_WORKSPACE_INSTRUCTIONS_BYTES,
        before_reopen,
    ) {
        Ok(snapshot) => snapshot,
        Err(StableUtf8FileErrorKind::Read(WorkspaceReadErrorKind::NotFound)) => {
            return Ok(CandidateSnapshot::Absent);
        }
        Err(kind) => return Err(map_stable_file_error(kind)),
    };
    Ok(CandidateSnapshot::Present {
        bytes: snapshot.bytes,
        content: snapshot.content,
        sha256: snapshot.sha256,
    })
}

fn candidate_into_root_snapshot(candidate: CandidateSnapshot) -> WorkspaceInstructionsSnapshot {
    match candidate {
        CandidateSnapshot::Absent => WorkspaceInstructionsSnapshot::Absent,
        CandidateSnapshot::Present {
            content,
            bytes,
            sha256,
        } => WorkspaceInstructionsSnapshot::Present {
            content,
            bytes,
            sha256,
        },
    }
}

fn instruction_paths(components: &[PathBuf]) -> Vec<String> {
    let mut paths = Vec::with_capacity(components.len() + 1);
    paths.push(WORKSPACE_INSTRUCTIONS_FILE_NAME.to_string());
    let mut directory = String::new();
    for component in components {
        if !directory.is_empty() {
            directory.push('/');
        }
        directory.push_str(
            component
                .to_str()
                .expect("validated workspace component is UTF-8"),
        );
        paths.push(format!("{directory}/{WORKSPACE_INSTRUCTIONS_FILE_NAME}"));
    }
    paths
}

fn revalidate_hierarchy(
    directories: &[Dir],
    components: &[PathBuf],
    candidates: &[CandidateSnapshot],
) -> Result<(), WorkspaceInstructionsErrorKind> {
    for (index, component) in components.iter().enumerate() {
        let reopened = open_directory_component(&directories[index], component)
            .map_err(|_| WorkspaceInstructionsErrorKind::ChangedDuringDiscovery)?;
        let opened_snapshot = FileSnapshot::from_directory(&directories[index + 1])
            .map_err(|_| WorkspaceInstructionsErrorKind::ChangedDuringDiscovery)?;
        let reopened_snapshot = FileSnapshot::from_directory(&reopened)
            .map_err(|_| WorkspaceInstructionsErrorKind::ChangedDuringDiscovery)?;
        if opened_snapshot != reopened_snapshot {
            return Err(WorkspaceInstructionsErrorKind::ChangedDuringDiscovery);
        }
    }
    for (directory, candidate) in directories.iter().zip(candidates) {
        let reopened = load_instruction_candidate(directory, || {})
            .map_err(|_| WorkspaceInstructionsErrorKind::ChangedDuringDiscovery)?;
        if &reopened != candidate {
            return Err(WorkspaceInstructionsErrorKind::ChangedDuringDiscovery);
        }
    }
    Ok(())
}

fn hierarchy_snapshot(
    paths: &[String],
    candidates: Vec<CandidateSnapshot>,
    bytes: usize,
) -> WorkspaceInstructionsSnapshot {
    let mut manifest = Sha256::new();
    manifest.update(WORKSPACE_INSTRUCTIONS_MANIFEST_DOMAIN);
    manifest.update((paths.len() as u64).to_be_bytes());
    let mut entries = Vec::new();
    let mut present = false;
    for (path, candidate) in paths.iter().zip(candidates) {
        manifest.update((path.len() as u64).to_be_bytes());
        manifest.update(path.as_bytes());
        match candidate {
            CandidateSnapshot::Absent => manifest.update([0]),
            CandidateSnapshot::Present {
                content,
                bytes,
                sha256,
            } => {
                present = true;
                manifest.update([1]);
                manifest.update((bytes as u64).to_be_bytes());
                manifest.update(sha256.as_bytes());
                entries.push(WorkspaceInstructionEntry {
                    path: path.clone(),
                    content,
                });
            }
        }
    }
    WorkspaceInstructionsSnapshot::Hierarchy {
        entries,
        present,
        bytes,
        sha256: format!("{:x}", manifest.finalize()),
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

fn map_stable_file_error(kind: StableUtf8FileErrorKind) -> WorkspaceInstructionsErrorKind {
    match kind {
        StableUtf8FileErrorKind::Read(kind) => map_workspace_error(kind),
        StableUtf8FileErrorKind::HardLinkNotAllowed => {
            WorkspaceInstructionsErrorKind::HardLinkNotAllowed
        }
        StableUtf8FileErrorKind::FileTooLarge => WorkspaceInstructionsErrorKind::FileTooLarge,
        StableUtf8FileErrorKind::InvalidEncoding => WorkspaceInstructionsErrorKind::InvalidEncoding,
        StableUtf8FileErrorKind::ChangedDuringRead => {
            WorkspaceInstructionsErrorKind::ChangedDuringRead
        }
    }
}

#[cfg(test)]
#[path = "tests/workspace_instructions.rs"]
mod tests;
