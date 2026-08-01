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
use atomic::same_device_file;
use conflict::TargetState;
use conflict::create_temp;
use conflict::resolve_parent;
use conflict::sha256;
use conflict::target_state;
use conflict::verify_original;
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

    fn prepare_edit<'a>(
        &'a self,
        arguments: &'a WorkspaceEditArguments,
        cancellation: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = WorkspacePatchPrepareOutcome> + Send + 'a>> {
        let _ = (arguments, cancellation);
        Box::pin(async { prepare_error(WorkspacePatchErrorKind::UnsupportedDiffFeature) })
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
}

impl WorkspaceTool {
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
        WorkspacePatchCommitOutcome::Applied {
            path,
            before_sha256,
            after_sha256,
            before_bytes,
            after_bytes,
        }
    }
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
