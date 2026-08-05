use crate::workspace_capability::FileSnapshot;
use crate::workspace_capability::WorkspaceReadErrorKind;
use crate::workspace_capability::WorkspaceTool;
use crate::workspace_capability::open_regular_file_nofollow;
use crate::workspace_capability::validate_relative_path;
use crate::workspace_read::WorkspaceReadArguments;
use crate::workspace_read::WorkspaceReadOutcome;
use cap_std::fs::Dir;
use std::fmt;
use std::fs::File;
use std::future::Future;
use std::io::Read;
use std::io::Write;
use std::path::PathBuf;
use std::pin::Pin;
use tokio_util::sync::CancellationToken;

mod atomic;
mod conflict;
mod diff;
mod parser;
mod text;

use atomic::atomic_create;
use atomic::atomic_replace;
use atomic::same_device;
use atomic::same_device_file;
use conflict::TargetState;
use conflict::create_temp;
use conflict::create_temp_new;
use conflict::resolve_parent;
use conflict::sha256;
use conflict::target_state;
use conflict::verify_original;
use diff::DiffOperation;
#[cfg(test)]
use diff::apply_hunks;
use diff::apply_hunks_detailed;
use diff::render_diff;
#[cfg(test)]
use parser::parse_patch;
use parser::parse_patch_detailed;
use text::TextFile;
use text::encode_text;

pub const MAX_WORKSPACE_PATCH_BYTES: usize = 96 * 1024;
pub const MAX_WORKSPACE_PATCH_HUNKS: usize = 128;
pub const MAX_WORKSPACE_PATCH_LINES: usize = 8_192;
pub const MAX_WORKSPACE_FILE_LINES: usize = 20_000;
pub const MAX_WORKSPACE_LINE_BYTES: usize = 16 * 1024;
pub const MAX_WORKSPACE_DIFF_BYTES: usize = 192 * 1024;
pub const MAX_WORKSPACE_DIFF_LINES: usize = 5_000;
pub const MAX_WORKSPACE_CHANGE_SET_FILES: usize = 64;
const CHANGE_SET_WAL: &str = ".sugarcode-workspace-changeset.wal";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceFileChangeKind {
    Create,
    Update,
    Delete,
}

impl WorkspaceFileChangeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Update => "update",
            Self::Delete => "delete",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspacePatchArguments {
    pub path: String,
    pub diff: String,
    pub base_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceLineEdit {
    pub start_line: u32,
    pub delete_line_count: u32,
    pub expected: String,
    pub replacement: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceEditArguments {
    pub path: String,
    pub base_sha256: String,
    pub edits: Vec<WorkspaceLineEdit>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceChangeSetOperation {
    Create { path: String, content: String },
    Update(WorkspaceEditArguments),
    Delete { path: String, base_sha256: String },
    Diff(WorkspacePatchArguments),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceChangeSetArguments {
    pub operations: Vec<WorkspaceChangeSetOperation>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceEditDiagnostic {
    pub edit_index: Option<u32>,
    pub hunk_index: Option<u32>,
    pub line: Option<u32>,
    pub expected_summary: Option<String>,
    pub actual_summary: Option<String>,
    pub suggested_action: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WorkspacePatchFailure {
    kind: WorkspacePatchErrorKind,
    diagnostic: WorkspaceEditDiagnostic,
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
    HeaderCountMismatch,
    RangeOutOfBounds,
    ExpectedMismatch,
    BaseRevisionMismatch,
    UnsupportedDiffFeature,
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
    Error {
        kind: WorkspacePatchErrorKind,
    },
    ValidationRejected {
        kind: WorkspacePatchErrorKind,
        diagnostic: WorkspaceEditDiagnostic,
    },
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

#[derive(Debug)]
pub enum WorkspaceChangeSetPrepareOutcome {
    Prepared(WorkspaceChangeSetPrepared),
    Error {
        operation_index: Option<usize>,
        kind: WorkspacePatchErrorKind,
    },
    ValidationRejected {
        operation_index: usize,
        kind: WorkspacePatchErrorKind,
        diagnostic: WorkspaceEditDiagnostic,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceChangeSetReceipt {
    pub path: String,
    pub kind: WorkspaceFileChangeKind,
    pub before_sha256: String,
    pub after_sha256: String,
    pub before_bytes: u64,
    pub after_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceChangeSetCommitOutcome {
    Applied {
        receipts: Vec<WorkspaceChangeSetReceipt>,
    },
    Error {
        kind: WorkspacePatchErrorKind,
    },
}

pub struct WorkspaceChangeSetPrepared {
    changes: Vec<WorkspacePatchPrepared>,
}

impl fmt::Debug for WorkspaceChangeSetPrepared {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkspaceChangeSetPrepared")
            .field("change_count", &self.changes.len())
            .finish()
    }
}

impl WorkspaceChangeSetPrepared {
    pub fn changes(&self) -> &[WorkspacePatchPrepared] {
        &self.changes
    }
}

pub struct WorkspacePatchPrepared {
    path: String,
    kind: WorkspaceFileChangeKind,
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

    pub fn kind(&self) -> WorkspaceFileChangeKind {
        self.kind
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
            kind: WorkspaceFileChangeKind::Update,
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
        original: Option<File>,
        snapshot: Option<FileSnapshot>,
        before: Vec<u8>,
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

    fn prepare_edit<'a>(
        &'a self,
        arguments: &'a WorkspaceEditArguments,
        cancellation: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = WorkspacePatchPrepareOutcome> + Send + 'a>> {
        let _ = (arguments, cancellation);
        Box::pin(async { prepare_error(WorkspacePatchErrorKind::UnsupportedDiffFeature) })
    }

    fn prepare_change_set<'a>(
        &'a self,
        arguments: &'a WorkspaceChangeSetArguments,
        cancellation: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = WorkspaceChangeSetPrepareOutcome> + Send + 'a>> {
        Box::pin(async move {
            if arguments.operations.len() != 1 {
                return WorkspaceChangeSetPrepareOutcome::Error {
                    operation_index: None,
                    kind: WorkspacePatchErrorKind::UnsupportedDiffFeature,
                };
            }
            let outcome = match &arguments.operations[0] {
                WorkspaceChangeSetOperation::Update(arguments) => {
                    self.prepare_edit(arguments, cancellation).await
                }
                WorkspaceChangeSetOperation::Diff(arguments) => {
                    self.prepare(arguments, cancellation).await
                }
                WorkspaceChangeSetOperation::Create { .. }
                | WorkspaceChangeSetOperation::Delete { .. } => {
                    return WorkspaceChangeSetPrepareOutcome::Error {
                        operation_index: Some(0),
                        kind: WorkspacePatchErrorKind::UnsupportedDiffFeature,
                    };
                }
            };
            match outcome {
                WorkspacePatchPrepareOutcome::Prepared(prepared) => {
                    WorkspaceChangeSetPrepareOutcome::Prepared(WorkspaceChangeSetPrepared {
                        changes: vec![*prepared],
                    })
                }
                WorkspacePatchPrepareOutcome::Error { kind } => {
                    WorkspaceChangeSetPrepareOutcome::Error {
                        operation_index: Some(0),
                        kind,
                    }
                }
                WorkspacePatchPrepareOutcome::ValidationRejected { kind, diagnostic } => {
                    WorkspaceChangeSetPrepareOutcome::ValidationRejected {
                        operation_index: 0,
                        kind,
                        diagnostic,
                    }
                }
            }
        })
    }

    fn commit_change_set<'a>(
        &'a self,
        prepared: WorkspaceChangeSetPrepared,
        cancellation: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = WorkspaceChangeSetCommitOutcome> + Send + 'a>> {
        Box::pin(async move {
            if prepared.changes.len() != 1 {
                return WorkspaceChangeSetCommitOutcome::Error {
                    kind: WorkspacePatchErrorKind::UnsupportedDiffFeature,
                };
            }
            let change = prepared.changes.into_iter().next().expect("one change");
            let kind = change.kind;
            match self.commit(change, cancellation).await {
                WorkspacePatchCommitOutcome::Applied {
                    path,
                    before_sha256,
                    after_sha256,
                    before_bytes,
                    after_bytes,
                } => WorkspaceChangeSetCommitOutcome::Applied {
                    receipts: vec![WorkspaceChangeSetReceipt {
                        path,
                        kind,
                        before_sha256,
                        after_sha256,
                        before_bytes,
                        after_bytes,
                    }],
                },
                WorkspacePatchCommitOutcome::Error { kind } => {
                    WorkspaceChangeSetCommitOutcome::Error { kind }
                }
            }
        })
    }
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

    fn prepare_edit<'a>(
        &'a self,
        arguments: &'a WorkspaceEditArguments,
        cancellation: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = WorkspacePatchPrepareOutcome> + Send + 'a>> {
        Box::pin(WorkspaceTool::prepare_edit(self, arguments, cancellation))
    }

    fn prepare_change_set<'a>(
        &'a self,
        arguments: &'a WorkspaceChangeSetArguments,
        cancellation: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = WorkspaceChangeSetPrepareOutcome> + Send + 'a>> {
        Box::pin(WorkspaceTool::prepare_change_set(
            self,
            arguments,
            cancellation,
        ))
    }

    fn commit_change_set<'a>(
        &'a self,
        prepared: WorkspaceChangeSetPrepared,
        cancellation: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = WorkspaceChangeSetCommitOutcome> + Send + 'a>> {
        Box::pin(WorkspaceTool::commit_change_set(
            self,
            prepared,
            cancellation,
        ))
    }
}

impl WorkspaceTool {
    pub async fn prepare_change_set(
        &self,
        arguments: &WorkspaceChangeSetArguments,
        cancellation: &CancellationToken,
    ) -> WorkspaceChangeSetPrepareOutcome {
        if arguments.operations.is_empty()
            || arguments.operations.len() > MAX_WORKSPACE_CHANGE_SET_FILES
        {
            return WorkspaceChangeSetPrepareOutcome::Error {
                operation_index: None,
                kind: WorkspacePatchErrorKind::UnsupportedDiffFeature,
            };
        }
        let mut paths = std::collections::BTreeSet::new();
        let mut changes = Vec::with_capacity(arguments.operations.len());
        for (operation_index, operation) in arguments.operations.iter().enumerate() {
            if cancellation.is_cancelled() {
                return WorkspaceChangeSetPrepareOutcome::Error {
                    operation_index: Some(operation_index),
                    kind: WorkspacePatchErrorKind::Cancelled,
                };
            }
            let path = match operation {
                WorkspaceChangeSetOperation::Create { path, .. }
                | WorkspaceChangeSetOperation::Delete { path, .. } => path,
                WorkspaceChangeSetOperation::Update(arguments) => &arguments.path,
                WorkspaceChangeSetOperation::Diff(arguments) => &arguments.path,
            };
            if !paths.insert(path.clone()) {
                return WorkspaceChangeSetPrepareOutcome::Error {
                    operation_index: Some(operation_index),
                    kind: WorkspacePatchErrorKind::Conflict,
                };
            }
            let outcome = match operation {
                WorkspaceChangeSetOperation::Create { path, content } => {
                    self.prepare_create(path, content, cancellation).await
                }
                WorkspaceChangeSetOperation::Update(arguments) => {
                    self.prepare_edit(arguments, cancellation).await
                }
                WorkspaceChangeSetOperation::Delete { path, base_sha256 } => {
                    self.prepare_delete(path, base_sha256, cancellation).await
                }
                WorkspaceChangeSetOperation::Diff(arguments) => {
                    self.prepare_patch(arguments, cancellation).await
                }
            };
            match outcome {
                WorkspacePatchPrepareOutcome::Prepared(prepared) => changes.push(*prepared),
                WorkspacePatchPrepareOutcome::Error { kind } => {
                    return WorkspaceChangeSetPrepareOutcome::Error {
                        operation_index: Some(operation_index),
                        kind,
                    };
                }
                WorkspacePatchPrepareOutcome::ValidationRejected { kind, diagnostic } => {
                    return WorkspaceChangeSetPrepareOutcome::ValidationRejected {
                        operation_index,
                        kind,
                        diagnostic,
                    };
                }
            }
        }
        WorkspaceChangeSetPrepareOutcome::Prepared(WorkspaceChangeSetPrepared { changes })
    }

    async fn prepare_create(
        &self,
        path: &str,
        content: &str,
        cancellation: &CancellationToken,
    ) -> WorkspacePatchPrepareOutcome {
        if cancellation.is_cancelled() {
            return prepare_error(WorkspacePatchErrorKind::Cancelled);
        }
        if content.len() > crate::MAX_WORKSPACE_READ_BYTES {
            return prepare_error(WorkspacePatchErrorKind::FileTooLarge);
        }
        let text = match TextFile::parse(content.as_bytes()) {
            Ok(text) => text,
            Err(kind) => return prepare_error(kind),
        };
        let components = match validate_relative_path(path) {
            Ok(components) => components,
            Err(kind) => return prepare_error(map_read_error(kind)),
        };
        let (file_name, parents) = components.split_last().expect("validated path has a name");
        let parent = match resolve_parent(&self.root, parents, cancellation) {
            Ok(parent) => parent,
            Err(kind) => return prepare_error(kind),
        };
        match parent.symlink_metadata(file_name) {
            Ok(_) => return prepare_error(WorkspacePatchErrorKind::Conflict),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return prepare_error(map_read_error(crate::workspace_capability::map_io_error(
                    &error,
                )));
            }
        }
        if !same_device(&self.root, &parent) {
            return prepare_error(WorkspacePatchErrorKind::CrossDeviceNotAllowed);
        }
        let path = components
            .iter()
            .map(|component| component.to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let operations = text
            .lines
            .iter()
            .cloned()
            .map(DiffOperation::Add)
            .collect::<Vec<_>>();
        let diff = match render_file_diff(&path, WorkspaceFileChangeKind::Create, &operations) {
            Ok(diff) => diff,
            Err(kind) => return prepare_error(kind),
        };
        let after = content.as_bytes().to_vec();
        WorkspacePatchPrepareOutcome::Prepared(Box::new(WorkspacePatchPrepared {
            path,
            kind: WorkspaceFileChangeKind::Create,
            diff,
            newline: text.newline,
            final_newline: text.final_newline,
            before_sha256: sha256(&[]),
            after_sha256: sha256(&after),
            before_bytes: 0,
            after_bytes: after.len() as u64,
            backing: PreparedBacking::Native {
                parent,
                file_name: file_name.clone(),
                original: None,
                snapshot: None,
                before: Vec::new(),
                after,
            },
        }))
    }

    async fn prepare_delete(
        &self,
        path: &str,
        base_sha256: &str,
        cancellation: &CancellationToken,
    ) -> WorkspacePatchPrepareOutcome {
        let content = match self
            .read(
                &WorkspaceReadArguments {
                    path: path.to_string(),
                },
                cancellation,
            )
            .await
        {
            WorkspaceReadOutcome::Content { content, .. } => content,
            WorkspaceReadOutcome::Error { kind } => return prepare_error(map_read_error(kind)),
        };
        let text = match TextFile::parse(content.as_bytes()) {
            Ok(text) => text,
            Err(kind) => return prepare_error(kind),
        };
        let operations = text
            .lines
            .iter()
            .cloned()
            .map(DiffOperation::Remove)
            .collect::<Vec<_>>();
        let diff = match render_file_diff(path, WorkspaceFileChangeKind::Delete, &operations) {
            Ok(diff) => diff,
            Err(kind) => return prepare_error(kind),
        };
        self.prepare_patch(
            &WorkspacePatchArguments {
                path: path.to_string(),
                diff,
                base_sha256: Some(base_sha256.to_string()),
            },
            cancellation,
        )
        .await
    }

    async fn prepare_create_diff(
        &self,
        arguments: &WorkspacePatchArguments,
        cancellation: &CancellationToken,
    ) -> WorkspacePatchPrepareOutcome {
        let patch = match parse_patch_detailed(&arguments.diff) {
            Ok(patch) => patch,
            Err(failure) => return prepare_rejection(failure),
        };
        let (after_lines, _) = match apply_hunks_detailed(&[], &patch) {
            Ok(value) => value,
            Err(failure) => return prepare_rejection(failure),
        };
        let final_newline =
            !after_lines.is_empty() && !arguments.diff.contains("\\ No newline at end of file");
        let after = encode_text(&after_lines, WorkspaceNewlineStyle::Lf, final_newline);
        let content = match String::from_utf8(after) {
            Ok(content) => content,
            Err(_) => return prepare_error(WorkspacePatchErrorKind::InvalidEncoding),
        };
        self.prepare_create(&arguments.path, &content, cancellation)
            .await
    }

    pub async fn prepare_edit(
        &self,
        arguments: &WorkspaceEditArguments,
        cancellation: &CancellationToken,
    ) -> WorkspacePatchPrepareOutcome {
        let diff = match line_edits_to_diff(&arguments.path, &arguments.edits) {
            Ok(diff) => diff,
            Err(failure) => return prepare_rejection(failure),
        };
        match self
            .prepare_patch(
                &WorkspacePatchArguments {
                    path: arguments.path.clone(),
                    diff,
                    base_sha256: Some(arguments.base_sha256.clone()),
                },
                cancellation,
            )
            .await
        {
            WorkspacePatchPrepareOutcome::ValidationRejected {
                kind,
                mut diagnostic,
            } => {
                diagnostic.edit_index = diagnostic.hunk_index;
                WorkspacePatchPrepareOutcome::ValidationRejected { kind, diagnostic }
            }
            outcome => outcome,
        }
    }

    pub async fn prepare_patch(
        &self,
        arguments: &WorkspacePatchArguments,
        cancellation: &CancellationToken,
    ) -> WorkspacePatchPrepareOutcome {
        if cancellation.is_cancelled() {
            return prepare_error(WorkspacePatchErrorKind::Cancelled);
        }
        if arguments.diff.is_empty() || arguments.diff.len() > MAX_WORKSPACE_PATCH_BYTES {
            return prepare_error(WorkspacePatchErrorKind::UnsupportedDiffFeature);
        }
        let requested_kind = match diff_file_kind(&arguments.diff) {
            Ok(kind) => kind,
            Err(kind) => return prepare_error(kind),
        };
        if requested_kind == WorkspaceFileChangeKind::Create {
            return self.prepare_create_diff(arguments, cancellation).await;
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
        if !same_device(&self.root, &parent) || !same_device_file(&self.root, &original) {
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
        let before_sha256 = sha256(&before);
        if arguments
            .base_sha256
            .as_ref()
            .is_some_and(|expected| expected != &before_sha256)
        {
            return prepare_rejection(WorkspacePatchFailure {
                kind: WorkspacePatchErrorKind::BaseRevisionMismatch,
                diagnostic: WorkspaceEditDiagnostic {
                    edit_index: None,
                    hunk_index: None,
                    line: None,
                    expected_summary: arguments
                        .base_sha256
                        .as_ref()
                        .map(|value| format!("sha256={value}")),
                    actual_summary: Some(format!("sha256={before_sha256}")),
                    suggested_action: "readFileAndRebase".to_string(),
                },
            });
        }
        let patch = match parse_patch_detailed(&arguments.diff) {
            Ok(patch) => patch,
            Err(failure) => return prepare_rejection(failure),
        };
        let (after_lines, operations) = match apply_hunks_detailed(&text.lines, &patch) {
            Ok(value) => value,
            Err(failure) => return prepare_rejection(failure),
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
        let after_final_newline = if requested_kind == WorkspaceFileChangeKind::Delete {
            false
        } else {
            text.final_newline
        };
        let after = encode_text(&after_lines, text.newline, after_final_newline);
        if after.len() > crate::MAX_WORKSPACE_READ_BYTES {
            return prepare_error(WorkspacePatchErrorKind::FileTooLarge);
        }
        let path = components
            .iter()
            .map(|component| component.to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if requested_kind == WorkspaceFileChangeKind::Delete && !after.is_empty() {
            return prepare_error(WorkspacePatchErrorKind::UnsupportedDiffFeature);
        }
        let diff = match render_file_diff(&path, requested_kind, &operations) {
            Ok(diff) => diff,
            Err(kind) => return prepare_error(kind),
        };
        let after_sha256 = sha256(&after);
        WorkspacePatchPrepareOutcome::Prepared(Box::new(WorkspacePatchPrepared {
            path,
            kind: requested_kind,
            diff,
            newline: text.newline,
            final_newline: after_final_newline,
            before_sha256,
            after_sha256,
            before_bytes: before.len() as u64,
            after_bytes: after.len() as u64,
            backing: PreparedBacking::Native {
                parent,
                file_name: file_name.clone(),
                original: Some(original),
                snapshot: Some(snapshot),
                before,
                after,
            },
        }))
    }

    pub async fn commit_patch(
        &self,
        prepared: WorkspacePatchPrepared,
        cancellation: &CancellationToken,
    ) -> WorkspacePatchCommitOutcome {
        let _write_permit = self.acquire_write_async().await;
        if cancellation.is_cancelled() {
            return commit_error(WorkspacePatchErrorKind::Cancelled);
        }
        let WorkspacePatchPrepared {
            path,
            kind,
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
            before: _,
            after,
        } = backing
        else {
            return commit_error(WorkspacePatchErrorKind::Unavailable);
        };
        match kind {
            WorkspaceFileChangeKind::Create => {
                if parent.symlink_metadata(&file_name).is_ok() {
                    return commit_error(WorkspacePatchErrorKind::Conflict);
                }
            }
            WorkspaceFileChangeKind::Update | WorkspaceFileChangeKind::Delete => {
                let (Some(original), Some(snapshot)) = (original.as_mut(), snapshot) else {
                    return commit_error(WorkspacePatchErrorKind::Unavailable);
                };
                if verify_original(&parent, &file_name, original, snapshot, &before_sha256).is_err()
                {
                    return commit_error(WorkspacePatchErrorKind::Conflict);
                }
            }
        }
        if cancellation.is_cancelled() {
            return commit_error(WorkspacePatchErrorKind::Cancelled);
        }
        match kind {
            WorkspaceFileChangeKind::Create => {
                let temp_name = match create_temp_new(&self.root, &after) {
                    Ok(name) => name,
                    Err(kind) => return commit_error(kind),
                };
                let created = atomic_create(&self.root, &temp_name, &parent, &file_name);
                if created.is_err() {
                    let _ = self.root.remove_file(&temp_name);
                }
                if let Err(kind) = created {
                    return commit_error(kind);
                }
                if !target_has_revision(&parent, &file_name, &after_sha256, after_bytes) {
                    return commit_error(WorkspacePatchErrorKind::AtomicReplaceUnavailable);
                }
            }
            WorkspaceFileChangeKind::Update => {
                let Some(original) = original.as_ref() else {
                    return commit_error(WorkspacePatchErrorKind::Unavailable);
                };
                let temp_name = match create_temp(&self.root, &after, original) {
                    Ok(name) => name,
                    Err(kind) => return commit_error(kind),
                };
                let replaced = atomic_replace(&self.root, &temp_name, &parent, &file_name);
                if replaced.is_err() {
                    let _ = self.root.remove_file(&temp_name);
                }
                let state = target_state(
                    &parent,
                    &file_name,
                    &before_sha256,
                    before_bytes,
                    &after_sha256,
                    after_bytes,
                );
                match (replaced, state) {
                    (_, Ok(TargetState::After)) => {}
                    (Err(kind), Ok(TargetState::Before) | Err(())) => return commit_error(kind),
                    (Ok(()), Ok(TargetState::Before) | Err(())) => {
                        return commit_error(WorkspacePatchErrorKind::AtomicReplaceUnavailable);
                    }
                    (_, Ok(TargetState::Other)) => {
                        return commit_error(WorkspacePatchErrorKind::Conflict);
                    }
                }
            }
            WorkspaceFileChangeKind::Delete => {
                if parent.remove_file(&file_name).is_err() {
                    return commit_error(WorkspacePatchErrorKind::AtomicReplaceUnavailable);
                }
                if parent.symlink_metadata(&file_name).is_ok() {
                    return commit_error(WorkspacePatchErrorKind::AtomicReplaceUnavailable);
                }
                if parent
                    .try_clone()
                    .map(Dir::into_std_file)
                    .and_then(|file| file.sync_all())
                    .is_err()
                {
                    return commit_error(WorkspacePatchErrorKind::AtomicReplaceUnavailable);
                }
            }
        }
        WorkspacePatchCommitOutcome::Applied {
            path,
            before_sha256,
            after_sha256,
            before_bytes,
            after_bytes,
        }
    }

    pub async fn commit_change_set(
        &self,
        prepared: WorkspaceChangeSetPrepared,
        cancellation: &CancellationToken,
    ) -> WorkspaceChangeSetCommitOutcome {
        let _write_permit = self.acquire_write_async().await;
        if cancellation.is_cancelled() {
            return change_set_commit_error(WorkspacePatchErrorKind::Cancelled);
        }
        let mut staged = Vec::with_capacity(prepared.changes.len());
        for mut change in prepared.changes {
            if let Err(kind) = verify_prepared(&mut change) {
                cleanup_staged(&self.root, &staged);
                return change_set_commit_error(kind);
            }
            let forward_temp = match &change.backing {
                PreparedBacking::Native {
                    original, after, ..
                } if change.kind != WorkspaceFileChangeKind::Delete => {
                    let temp = match original.as_ref() {
                        Some(original) => create_temp(&self.root, after, original),
                        None => create_temp_new(&self.root, after),
                    };
                    match temp {
                        Ok(temp) => Some(temp),
                        Err(kind) => {
                            cleanup_staged(&self.root, &staged);
                            return change_set_commit_error(kind);
                        }
                    }
                }
                PreparedBacking::Native { .. } => None,
                PreparedBacking::Recorded => {
                    cleanup_staged(&self.root, &staged);
                    return change_set_commit_error(WorkspacePatchErrorKind::Unavailable);
                }
            };
            let rollback_temp = match &change.backing {
                PreparedBacking::Native {
                    original: Some(original),
                    before,
                    ..
                } if change.kind != WorkspaceFileChangeKind::Create => {
                    match create_temp(&self.root, before, original) {
                        Ok(temp) => Some(temp),
                        Err(kind) => {
                            if let Some(temp) = forward_temp.as_ref() {
                                let _ = self.root.remove_file(temp);
                            }
                            cleanup_staged(&self.root, &staged);
                            return change_set_commit_error(kind);
                        }
                    }
                }
                _ => None,
            };
            staged.push(StagedChange {
                change,
                forward_temp,
                rollback_temp,
            });
        }
        if cancellation.is_cancelled() {
            cleanup_staged(&self.root, &staged);
            return change_set_commit_error(WorkspacePatchErrorKind::Cancelled);
        }
        if let Err(kind) = write_change_set_wal(&self.root, &staged) {
            cleanup_staged(&self.root, &staged);
            return change_set_commit_error(kind);
        }
        let mut committed = 0usize;
        for index in 0..staged.len() {
            if let Err(kind) = apply_staged(&self.root, &mut staged[index]) {
                let current_is_after = staged_target_has_after(&staged[index]);
                let current_is_before = staged_target_has_before(&staged[index]);
                let rollback_len = committed + usize::from(current_is_after);
                let rollback_ok = (current_is_after || current_is_before)
                    && rollback_staged(&self.root, &mut staged[..rollback_len]);
                if rollback_ok {
                    let _ = remove_change_set_wal(&self.root);
                    cleanup_staged(&self.root, &staged);
                }
                return change_set_commit_error(if rollback_ok {
                    kind
                } else {
                    WorkspacePatchErrorKind::AtomicReplaceUnavailable
                });
            }
            committed += 1;
        }
        if let Err(kind) = remove_change_set_wal(&self.root) {
            return change_set_commit_error(kind);
        }
        cleanup_staged(&self.root, &staged);
        let receipts = staged
            .into_iter()
            .map(|staged| WorkspaceChangeSetReceipt {
                path: staged.change.path,
                kind: staged.change.kind,
                before_sha256: staged.change.before_sha256,
                after_sha256: staged.change.after_sha256,
                before_bytes: staged.change.before_bytes,
                after_bytes: staged.change.after_bytes,
            })
            .collect();
        WorkspaceChangeSetCommitOutcome::Applied { receipts }
    }
}

struct StagedChange {
    change: WorkspacePatchPrepared,
    forward_temp: Option<PathBuf>,
    rollback_temp: Option<PathBuf>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangeSetWal {
    version: u32,
    changes: Vec<ChangeSetWalEntry>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangeSetWalEntry {
    path: String,
    kind: String,
    before_sha256: String,
    after_sha256: String,
    before_bytes: u64,
    after_bytes: u64,
    forward_temp: Option<String>,
    rollback_temp: Option<String>,
}

fn verify_prepared(change: &mut WorkspacePatchPrepared) -> Result<(), WorkspacePatchErrorKind> {
    let PreparedBacking::Native {
        parent,
        file_name,
        original,
        snapshot,
        ..
    } = &mut change.backing
    else {
        return Err(WorkspacePatchErrorKind::Unavailable);
    };
    match change.kind {
        WorkspaceFileChangeKind::Create => match parent.symlink_metadata(file_name) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Ok(_) => Err(WorkspacePatchErrorKind::Conflict),
            Err(_) => Err(WorkspacePatchErrorKind::Unavailable),
        },
        WorkspaceFileChangeKind::Update | WorkspaceFileChangeKind::Delete => {
            let (Some(original), Some(snapshot)) = (original.as_mut(), *snapshot) else {
                return Err(WorkspacePatchErrorKind::Unavailable);
            };
            verify_original(parent, file_name, original, snapshot, &change.before_sha256)
                .map_err(|_| WorkspacePatchErrorKind::Conflict)
        }
    }
}

fn apply_staged(root: &Dir, staged: &mut StagedChange) -> Result<(), WorkspacePatchErrorKind> {
    let PreparedBacking::Native {
        parent, file_name, ..
    } = &staged.change.backing
    else {
        return Err(WorkspacePatchErrorKind::Unavailable);
    };
    match staged.change.kind {
        WorkspaceFileChangeKind::Create => atomic_create(
            root,
            staged
                .forward_temp
                .take()
                .as_deref()
                .ok_or(WorkspacePatchErrorKind::Unavailable)?,
            parent,
            file_name,
        ),
        WorkspaceFileChangeKind::Update => atomic_replace(
            root,
            staged
                .forward_temp
                .take()
                .as_deref()
                .ok_or(WorkspacePatchErrorKind::Unavailable)?,
            parent,
            file_name,
        ),
        WorkspaceFileChangeKind::Delete => {
            parent
                .remove_file(file_name)
                .map_err(|_| WorkspacePatchErrorKind::AtomicReplaceUnavailable)?;
            parent
                .try_clone()
                .map(Dir::into_std_file)
                .and_then(|file| file.sync_all())
                .map_err(|_| WorkspacePatchErrorKind::AtomicReplaceUnavailable)
        }
    }
}

fn staged_target_has_after(staged: &StagedChange) -> bool {
    let PreparedBacking::Native {
        parent, file_name, ..
    } = &staged.change.backing
    else {
        return false;
    };
    match staged.change.kind {
        WorkspaceFileChangeKind::Delete => parent
            .symlink_metadata(file_name)
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound),
        WorkspaceFileChangeKind::Create | WorkspaceFileChangeKind::Update => target_has_revision(
            parent,
            file_name,
            &staged.change.after_sha256,
            staged.change.after_bytes,
        ),
    }
}

fn staged_target_has_before(staged: &StagedChange) -> bool {
    let PreparedBacking::Native {
        parent, file_name, ..
    } = &staged.change.backing
    else {
        return false;
    };
    match staged.change.kind {
        WorkspaceFileChangeKind::Create => parent
            .symlink_metadata(file_name)
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound),
        WorkspaceFileChangeKind::Update | WorkspaceFileChangeKind::Delete => target_has_revision(
            parent,
            file_name,
            &staged.change.before_sha256,
            staged.change.before_bytes,
        ),
    }
}

fn rollback_staged(root: &Dir, staged: &mut [StagedChange]) -> bool {
    let mut ok = true;
    for staged in staged.iter_mut().rev() {
        let PreparedBacking::Native {
            parent, file_name, ..
        } = &staged.change.backing
        else {
            ok = false;
            continue;
        };
        let restored = match staged.change.kind {
            WorkspaceFileChangeKind::Create => parent.remove_file(file_name).map_err(|_| ()),
            WorkspaceFileChangeKind::Update => staged
                .rollback_temp
                .take()
                .ok_or(())
                .and_then(|temp| atomic_replace(root, &temp, parent, file_name).map_err(|_| ())),
            WorkspaceFileChangeKind::Delete => staged
                .rollback_temp
                .take()
                .ok_or(())
                .and_then(|temp| atomic_create(root, &temp, parent, file_name).map_err(|_| ())),
        };
        ok &= restored.is_ok();
    }
    ok
}

fn cleanup_staged(root: &Dir, staged: &[StagedChange]) {
    for staged in staged {
        if let Some(temp) = staged.forward_temp.as_ref() {
            let _ = root.remove_file(temp);
        }
        if let Some(temp) = staged.rollback_temp.as_ref() {
            let _ = root.remove_file(temp);
        }
    }
}

fn write_change_set_wal(
    root: &Dir,
    staged: &[StagedChange],
) -> Result<(), WorkspacePatchErrorKind> {
    let wal = ChangeSetWal {
        version: 1,
        changes: staged
            .iter()
            .map(|staged| ChangeSetWalEntry {
                path: staged.change.path.clone(),
                kind: staged.change.kind.as_str().to_string(),
                before_sha256: staged.change.before_sha256.clone(),
                after_sha256: staged.change.after_sha256.clone(),
                before_bytes: staged.change.before_bytes,
                after_bytes: staged.change.after_bytes,
                forward_temp: staged
                    .forward_temp
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned()),
                rollback_temp: staged
                    .rollback_temp
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned()),
            })
            .collect(),
    };
    let bytes = serde_json::to_vec(&wal).map_err(|_| WorkspacePatchErrorKind::Unavailable)?;
    if bytes.len() > 256 * 1024 {
        return Err(WorkspacePatchErrorKind::ResultTooLarge);
    }
    let mut options = cap_std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use cap_fs_ext::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = root
        .open_with(CHANGE_SET_WAL, &options)
        .map_err(|_| WorkspacePatchErrorKind::Unavailable)?
        .into_std();
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| WorkspacePatchErrorKind::Unavailable)?;
    root.try_clone()
        .map(Dir::into_std_file)
        .and_then(|file| file.sync_all())
        .map_err(|_| WorkspacePatchErrorKind::Unavailable)
}

fn remove_change_set_wal(root: &Dir) -> Result<(), WorkspacePatchErrorKind> {
    match root.remove_file(CHANGE_SET_WAL) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(WorkspacePatchErrorKind::Unavailable),
    }
    root.try_clone()
        .map(Dir::into_std_file)
        .and_then(|file| file.sync_all())
        .map_err(|_| WorkspacePatchErrorKind::Unavailable)
}

pub(crate) fn recover_pending_change_set(root: &Dir) -> Result<(), WorkspacePatchErrorKind> {
    let mut file = match root.open(CHANGE_SET_WAL) {
        Ok(file) => file.into_std(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(WorkspacePatchErrorKind::Unavailable),
    };
    let metadata = file
        .metadata()
        .map_err(|_| WorkspacePatchErrorKind::Unavailable)?;
    if metadata.len() > 256 * 1024 {
        return Err(WorkspacePatchErrorKind::Unavailable);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| WorkspacePatchErrorKind::Unavailable)?;
    let mut wal: ChangeSetWal =
        serde_json::from_slice(&bytes).map_err(|_| WorkspacePatchErrorKind::Unavailable)?;
    if wal.version != 1
        || wal.changes.is_empty()
        || wal.changes.len() > MAX_WORKSPACE_CHANGE_SET_FILES
    {
        return Err(WorkspacePatchErrorKind::Unavailable);
    }
    for entry in &wal.changes {
        validate_wal_entry(entry)?;
    }
    let all_after = wal
        .changes
        .iter()
        .all(|entry| wal_target_state(root, entry).is_ok_and(|state| state == TargetState::After));
    if !all_after {
        for entry in wal.changes.iter_mut().rev() {
            let state = wal_target_state(root, entry)?;
            if state == TargetState::Before {
                continue;
            }
            if state != TargetState::After {
                return Err(WorkspacePatchErrorKind::Conflict);
            }
            let (parent, file_name) = wal_target(root, &entry.path)?;
            match entry.kind.as_str() {
                "create" => parent
                    .remove_file(&file_name)
                    .map_err(|_| WorkspacePatchErrorKind::AtomicReplaceUnavailable)?,
                "update" => {
                    let temp = entry
                        .rollback_temp
                        .take()
                        .ok_or(WorkspacePatchErrorKind::Unavailable)?;
                    atomic_replace(root, std::path::Path::new(&temp), &parent, &file_name)?;
                }
                "delete" => {
                    let temp = entry
                        .rollback_temp
                        .take()
                        .ok_or(WorkspacePatchErrorKind::Unavailable)?;
                    atomic_create(root, std::path::Path::new(&temp), &parent, &file_name)?;
                }
                _ => return Err(WorkspacePatchErrorKind::Unavailable),
            }
        }
        if !wal.changes.iter().all(|entry| {
            wal_target_state(root, entry).is_ok_and(|state| state == TargetState::Before)
        }) {
            return Err(WorkspacePatchErrorKind::Conflict);
        }
    }
    for entry in &wal.changes {
        for temp in [
            entry.forward_temp.as_deref(),
            entry.rollback_temp.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            let _ = root.remove_file(temp);
        }
    }
    remove_change_set_wal(root)
}

fn validate_wal_entry(entry: &ChangeSetWalEntry) -> Result<(), WorkspacePatchErrorKind> {
    validate_relative_path(&entry.path).map_err(map_read_error)?;
    if !matches!(entry.kind.as_str(), "create" | "update" | "delete")
        || !valid_revision(&entry.before_sha256)
        || !valid_revision(&entry.after_sha256)
        || [
            entry.forward_temp.as_deref(),
            entry.rollback_temp.as_deref(),
        ]
        .into_iter()
        .flatten()
        .any(|path| {
            path.contains('/')
                || path.contains('\\')
                || !path.starts_with(".sugarcode-workspace-write-")
                || !path.ends_with(".tmp")
        })
    {
        return Err(WorkspacePatchErrorKind::Unavailable);
    }
    Ok(())
}

fn valid_revision(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn wal_target(root: &Dir, path: &str) -> Result<(Dir, PathBuf), WorkspacePatchErrorKind> {
    let components = validate_relative_path(path).map_err(map_read_error)?;
    let (file_name, parents) = components.split_last().expect("validated WAL path");
    let parent = resolve_parent(root, parents, &CancellationToken::new())?;
    Ok((parent, file_name.clone()))
}

fn wal_target_state(
    root: &Dir,
    entry: &ChangeSetWalEntry,
) -> Result<TargetState, WorkspacePatchErrorKind> {
    let (parent, file_name) = wal_target(root, &entry.path)?;
    match entry.kind.as_str() {
        "create" => match parent.symlink_metadata(&file_name) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(TargetState::Before),
            Ok(_)
                if target_has_revision(
                    &parent,
                    &file_name,
                    &entry.after_sha256,
                    entry.after_bytes,
                ) =>
            {
                Ok(TargetState::After)
            }
            _ => Ok(TargetState::Other),
        },
        "update" => target_state(
            &parent,
            &file_name,
            &entry.before_sha256,
            entry.before_bytes,
            &entry.after_sha256,
            entry.after_bytes,
        )
        .map_err(|_| WorkspacePatchErrorKind::Unavailable),
        "delete" => match parent.symlink_metadata(&file_name) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(TargetState::After),
            Ok(_)
                if target_has_revision(
                    &parent,
                    &file_name,
                    &entry.before_sha256,
                    entry.before_bytes,
                ) =>
            {
                Ok(TargetState::Before)
            }
            _ => Ok(TargetState::Other),
        },
        _ => Err(WorkspacePatchErrorKind::Unavailable),
    }
}

fn change_set_commit_error(kind: WorkspacePatchErrorKind) -> WorkspaceChangeSetCommitOutcome {
    WorkspaceChangeSetCommitOutcome::Error { kind }
}

fn line_edits_to_diff(
    path: &str,
    edits: &[WorkspaceLineEdit],
) -> Result<String, WorkspacePatchFailure> {
    if edits.is_empty() || edits.len() > MAX_WORKSPACE_PATCH_HUNKS {
        return Err(validation_failure(
            WorkspacePatchErrorKind::UnsupportedDiffFeature,
            None,
            None,
            None,
            None,
            "provideOneTo128Edits",
        ));
    }
    let mut diff = format!("--- a/{path}\n+++ b/{path}\n");
    let mut previous_start = 0usize;
    let mut previous_end = 0usize;
    let mut line_delta = 0isize;
    for (edit_offset, edit) in edits.iter().enumerate() {
        let edit_index = u32::try_from(edit_offset + 1).ok();
        let start = usize::try_from(edit.start_line).map_err(|_| {
            validation_failure(
                WorkspacePatchErrorKind::RangeOutOfBounds,
                edit_index,
                Some(edit.start_line),
                None,
                None,
                "readFileAndRebase",
            )
        })?;
        let delete_count = usize::try_from(edit.delete_line_count).map_err(|_| {
            validation_failure(
                WorkspacePatchErrorKind::RangeOutOfBounds,
                edit_index,
                Some(edit.start_line),
                None,
                None,
                "readFileAndRebase",
            )
        })?;
        if start == 0
            || start <= previous_start
            || (previous_end != 0 && start < previous_end)
            || edit.expected.contains(['\r', '\0'])
            || edit.replacement.contains(['\r', '\0'])
        {
            return Err(validation_failure(
                WorkspacePatchErrorKind::RangeOutOfBounds,
                edit_index,
                Some(edit.start_line),
                None,
                None,
                "readFileAndRebase",
            ));
        }
        let expected = split_expected(&edit.expected, delete_count).map_err(|kind| {
            validation_failure(
                kind,
                edit_index,
                Some(edit.start_line),
                Some(format!("deleteLineCount={delete_count}")),
                Some(format!(
                    "expectedLines={}",
                    edit.expected.split('\n').count()
                )),
                "correctLineCounts",
            )
        })?;
        let replacement = split_replacement(&edit.replacement);
        if expected
            .iter()
            .chain(replacement.iter())
            .any(|line| line.len() > MAX_WORKSPACE_LINE_BYTES)
        {
            return Err(validation_failure(
                WorkspacePatchErrorKind::LineTooLong,
                edit_index,
                Some(edit.start_line),
                None,
                None,
                "shortenReplacementLines",
            ));
        }
        let old_start = if delete_count == 0 { start - 1 } else { start };
        let new_cursor = (start - 1).checked_add_signed(line_delta).ok_or_else(|| {
            validation_failure(
                WorkspacePatchErrorKind::RangeOutOfBounds,
                edit_index,
                Some(edit.start_line),
                None,
                None,
                "readFileAndRebase",
            )
        })?;
        let new_start = if replacement.is_empty() {
            new_cursor
        } else {
            new_cursor + 1
        };
        diff.push_str(&format!(
            "@@ -{old_start},{delete_count} +{new_start},{} @@\n",
            replacement.len()
        ));
        for line in &expected {
            diff.push('-');
            diff.push_str(line);
            diff.push('\n');
        }
        for line in &replacement {
            diff.push('+');
            diff.push_str(line);
            diff.push('\n');
        }
        if diff.len() > MAX_WORKSPACE_PATCH_BYTES {
            return Err(validation_failure(
                WorkspacePatchErrorKind::ResultTooLarge,
                edit_index,
                Some(edit.start_line),
                None,
                None,
                "splitIntoSmallerEdits",
            ));
        }
        line_delta = line_delta
            .checked_add_unsigned(replacement.len())
            .and_then(|value| value.checked_sub_unsigned(delete_count))
            .ok_or_else(|| {
                validation_failure(
                    WorkspacePatchErrorKind::RangeOutOfBounds,
                    edit_index,
                    Some(edit.start_line),
                    None,
                    None,
                    "readFileAndRebase",
                )
            })?;
        previous_start = start;
        previous_end = start.checked_add(delete_count).ok_or_else(|| {
            validation_failure(
                WorkspacePatchErrorKind::RangeOutOfBounds,
                edit_index,
                Some(edit.start_line),
                None,
                None,
                "readFileAndRebase",
            )
        })?;
    }
    Ok(diff)
}

fn diff_file_kind(diff: &str) -> Result<WorkspaceFileChangeKind, WorkspacePatchErrorKind> {
    let mut lines = diff.lines();
    let old = lines
        .next()
        .and_then(|line| line.strip_prefix("--- "))
        .ok_or(WorkspacePatchErrorKind::UnsupportedDiffFeature)?;
    let new = lines
        .next()
        .and_then(|line| line.strip_prefix("+++ "))
        .ok_or(WorkspacePatchErrorKind::UnsupportedDiffFeature)?;
    match (old == "/dev/null", new == "/dev/null") {
        (true, false) => Ok(WorkspaceFileChangeKind::Create),
        (false, true) => Ok(WorkspaceFileChangeKind::Delete),
        (false, false) => Ok(WorkspaceFileChangeKind::Update),
        (true, true) => Err(WorkspacePatchErrorKind::UnsupportedDiffFeature),
    }
}

fn render_file_diff(
    path: &str,
    kind: WorkspaceFileChangeKind,
    operations: &[DiffOperation],
) -> Result<String, WorkspacePatchErrorKind> {
    let rendered = render_diff(path, operations)?;
    let body = rendered
        .split_once('\n')
        .and_then(|(_, rest)| rest.split_once('\n').map(|(_, body)| body))
        .unwrap_or("");
    let headers = match kind {
        WorkspaceFileChangeKind::Create => format!("--- /dev/null\n+++ b/{path}\n"),
        WorkspaceFileChangeKind::Update => format!("--- a/{path}\n+++ b/{path}\n"),
        WorkspaceFileChangeKind::Delete => format!("--- a/{path}\n+++ /dev/null\n"),
    };
    let diff = format!("{headers}{body}");
    if diff.len() > MAX_WORKSPACE_DIFF_BYTES || diff.lines().count() > MAX_WORKSPACE_DIFF_LINES {
        Err(WorkspacePatchErrorKind::ResultTooLarge)
    } else {
        Ok(diff)
    }
}

fn target_has_revision(parent: &Dir, file_name: &std::path::Path, hash: &str, bytes: u64) -> bool {
    let Ok((mut file, snapshot)) = open_regular_file_nofollow(parent, file_name) else {
        return false;
    };
    if snapshot.len() != bytes || snapshot.links() != 1 {
        return false;
    }
    let mut content = Vec::with_capacity(bytes as usize);
    file.read_to_end(&mut content).is_ok()
        && content.len() as u64 == bytes
        && sha256(&content) == hash
}

fn split_expected(
    expected: &str,
    delete_count: usize,
) -> Result<Vec<&str>, WorkspacePatchErrorKind> {
    if delete_count == 0 {
        return if expected.is_empty() {
            Ok(Vec::new())
        } else {
            Err(WorkspacePatchErrorKind::HeaderCountMismatch)
        };
    }
    let lines = expected.split('\n').collect::<Vec<_>>();
    if lines.len() == delete_count {
        Ok(lines)
    } else {
        Err(WorkspacePatchErrorKind::HeaderCountMismatch)
    }
}

fn split_replacement(replacement: &str) -> Vec<&str> {
    if replacement.is_empty() {
        Vec::new()
    } else {
        replacement.split_terminator('\n').collect()
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

fn prepare_rejection(failure: WorkspacePatchFailure) -> WorkspacePatchPrepareOutcome {
    WorkspacePatchPrepareOutcome::ValidationRejected {
        kind: failure.kind,
        diagnostic: failure.diagnostic,
    }
}

fn validation_failure(
    kind: WorkspacePatchErrorKind,
    edit_index: Option<u32>,
    line: Option<u32>,
    expected_summary: Option<String>,
    actual_summary: Option<String>,
    suggested_action: &str,
) -> WorkspacePatchFailure {
    WorkspacePatchFailure {
        kind,
        diagnostic: WorkspaceEditDiagnostic {
            edit_index,
            hunk_index: None,
            line,
            expected_summary,
            actual_summary,
            suggested_action: suggested_action.to_string(),
        },
    }
}

fn content_summary(value: Option<&str>) -> String {
    match value {
        Some(value) => format!("bytes={},sha256={}", value.len(), sha256(value.as_bytes())),
        None => "eof".to_string(),
    }
}

fn commit_error(kind: WorkspacePatchErrorKind) -> WorkspacePatchCommitOutcome {
    WorkspacePatchCommitOutcome::Error { kind }
}

#[cfg(test)]
#[path = "workspace_patch/tests/mod.rs"]
mod tests;
