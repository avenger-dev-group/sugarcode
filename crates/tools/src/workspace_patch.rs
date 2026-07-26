use crate::workspace_capability::FileSnapshot;
use crate::workspace_capability::WorkspaceReadErrorKind;
use crate::workspace_capability::WorkspaceTool;
use crate::workspace_capability::open_regular_file_nofollow;
use crate::workspace_capability::validate_relative_path;
use cap_std::fs::Dir;
use std::fmt;
use std::fs::File;
use std::future::Future;
use std::io::Read;
use std::path::PathBuf;
use std::pin::Pin;
use tokio_util::sync::CancellationToken;

mod atomic;
mod conflict;
mod diff;
mod parser;
mod text;

use atomic::atomic_replace;
use atomic::same_device;
use conflict::create_temp;
use conflict::resolve_parent;
use conflict::sha256;
use conflict::target_matches;
use conflict::verify_original;
use diff::apply_hunks;
use diff::render_diff;
use parser::parse_patch;
use text::TextFile;
use text::encode_text;

pub const MAX_WORKSPACE_PATCH_BYTES: usize = 96 * 1024;
pub const MAX_WORKSPACE_PATCH_HUNKS: usize = 128;
pub const MAX_WORKSPACE_PATCH_LINES: usize = 8_192;
pub const MAX_WORKSPACE_FILE_LINES: usize = 20_000;
pub const MAX_WORKSPACE_LINE_BYTES: usize = 16 * 1024;
pub const MAX_WORKSPACE_DIFF_BYTES: usize = 192 * 1024;
pub const MAX_WORKSPACE_DIFF_LINES: usize = 5_000;

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
