use crate::workspace_capability::FileSnapshot;
use crate::workspace_capability::WorkspaceReadErrorKind;
use crate::workspace_capability::WorkspaceTool;
use crate::workspace_capability::classify_component_open_error;
use crate::workspace_capability::map_io_error;
use crate::workspace_capability::open_regular_file_nofollow_with_limit;
use crate::workspace_capability::validate_directory_handle;
use crate::workspace_capability::validate_relative_path;
use cap_fs_ext::DirExt;
use std::io::Read;

pub const MAX_WORKSPACE_INSPECT_COMPLETE_BYTES: usize = 1024 * 1024;
pub const MAX_WORKSPACE_INSPECT_PROBE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_WORKSPACE_INSPECT_PREVIEW_BYTES: usize = 256 * 1024;
pub const MAX_WORKSPACE_INSPECT_COMPLETE_LINES: usize = 20_000;
pub const MAX_WORKSPACE_INSPECT_PREVIEW_LINES: usize = 10_000;
pub const MAX_WORKSPACE_INSPECT_LINE_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceInspectArguments {
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceInspectErrorKind {
    InvalidPath,
    NotFound,
    AccessDenied,
    PathNotAllowed,
    NotRegularFile,
    Oversized,
    Binary,
    InvalidEncoding,
    LongLine,
    Changed,
    Unavailable,
}

#[derive(Clone, PartialEq, Eq)]
pub enum WorkspaceInspectOutcome {
    Complete {
        content: String,
        bytes: usize,
        lines: usize,
        has_utf8_bom: bool,
    },
    Truncated {
        content: String,
        bytes: usize,
        returned_bytes: usize,
        lines: usize,
        has_utf8_bom: bool,
    },
    Error {
        kind: WorkspaceInspectErrorKind,
    },
}

impl std::fmt::Debug for WorkspaceInspectOutcome {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Complete { bytes, lines, .. } => formatter
                .debug_struct("Complete")
                .field("content", &"<redacted>")
                .field("bytes", bytes)
                .field("lines", lines)
                .finish(),
            Self::Truncated {
                bytes,
                returned_bytes,
                lines,
                ..
            } => formatter
                .debug_struct("Truncated")
                .field("content", &"<redacted>")
                .field("bytes", bytes)
                .field("returned_bytes", returned_bytes)
                .field("lines", lines)
                .finish(),
            Self::Error { kind } => formatter.debug_struct("Error").field("kind", kind).finish(),
        }
    }
}

impl WorkspaceTool {
    pub fn inspect_now(&self, arguments: &WorkspaceInspectArguments) -> WorkspaceInspectOutcome {
        let components = match validate_relative_path(&arguments.path) {
            Ok(components) => components,
            Err(kind) => return error(map_error(kind)),
        };
        let (file_name, parents) = components
            .split_last()
            .expect("validated path has a final component");
        let mut directory = match self.root.try_clone() {
            Ok(directory) => directory,
            Err(error_value) => return error(map_error(map_io_error(&error_value))),
        };
        for component in parents {
            directory = match directory.open_dir_nofollow(component) {
                Ok(next) => next,
                Err(error_value) => {
                    return error(map_error(classify_component_open_error(
                        &directory,
                        component,
                        &error_value,
                    )));
                }
            };
            if let Err(kind) = validate_directory_handle(&directory) {
                return error(map_error(kind));
            }
        }

        let (mut file, opened_snapshot) = match open_regular_file_nofollow_with_limit(
            &directory,
            file_name,
            MAX_WORKSPACE_INSPECT_PROBE_BYTES as u64,
        ) {
            Ok(opened) => opened,
            Err(kind) => return error(map_error(kind)),
        };
        let mut bytes = Vec::with_capacity(opened_snapshot.len() as usize);
        if (&mut file)
            .take(MAX_WORKSPACE_INSPECT_PROBE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .is_err()
        {
            return error(WorkspaceInspectErrorKind::Unavailable);
        }
        if bytes.len() > MAX_WORKSPACE_INSPECT_PROBE_BYTES {
            return error(WorkspaceInspectErrorKind::Changed);
        }
        let final_metadata = match file.metadata() {
            Ok(metadata) => metadata,
            Err(error_value) => return error(map_error(map_io_error(&error_value))),
        };
        let final_snapshot = match FileSnapshot::from_file(&file, &final_metadata) {
            Ok(snapshot) => snapshot,
            Err(kind) => return error(map_error(kind)),
        };
        let reopened_snapshot = match open_regular_file_nofollow_with_limit(
            &directory,
            file_name,
            MAX_WORKSPACE_INSPECT_PROBE_BYTES as u64,
        ) {
            Ok((_, snapshot)) => snapshot,
            Err(_) => return error(WorkspaceInspectErrorKind::Changed),
        };
        if opened_snapshot != final_snapshot
            || opened_snapshot != reopened_snapshot
            || bytes.len() as u64 != final_metadata.len()
        {
            return error(WorkspaceInspectErrorKind::Changed);
        }
        if bytes.contains(&0) {
            return error(WorkspaceInspectErrorKind::Binary);
        }
        let has_utf8_bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
        let text_bytes = if has_utf8_bom { &bytes[3..] } else { &bytes };
        let text = match std::str::from_utf8(text_bytes) {
            Ok(text) => text,
            Err(_) => return error(WorkspaceInspectErrorKind::InvalidEncoding),
        };
        if text
            .split('\n')
            .any(|line| line.trim_end_matches('\r').len() > MAX_WORKSPACE_INSPECT_LINE_BYTES)
        {
            return error(WorkspaceInspectErrorKind::LongLine);
        }
        let lines = text.lines().count().max(1);
        if text_bytes.len() <= MAX_WORKSPACE_INSPECT_COMPLETE_BYTES
            && lines <= MAX_WORKSPACE_INSPECT_COMPLETE_LINES
        {
            return WorkspaceInspectOutcome::Complete {
                content: text.to_owned(),
                bytes: bytes.len(),
                lines,
                has_utf8_bom,
            };
        }

        let mut end = text.len().min(MAX_WORKSPACE_INSPECT_PREVIEW_BYTES);
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        let mut preview = &text[..end];
        if preview.lines().count() > MAX_WORKSPACE_INSPECT_PREVIEW_LINES {
            let cutoff = preview
                .match_indices('\n')
                .nth(MAX_WORKSPACE_INSPECT_PREVIEW_LINES - 1)
                .map_or(preview.len(), |(index, _)| index + 1);
            preview = &preview[..cutoff];
        }
        WorkspaceInspectOutcome::Truncated {
            content: preview.to_owned(),
            bytes: bytes.len(),
            returned_bytes: preview.len(),
            lines,
            has_utf8_bom,
        }
    }
}

fn map_error(kind: WorkspaceReadErrorKind) -> WorkspaceInspectErrorKind {
    match kind {
        WorkspaceReadErrorKind::InvalidPath => WorkspaceInspectErrorKind::InvalidPath,
        WorkspaceReadErrorKind::NotFound => WorkspaceInspectErrorKind::NotFound,
        WorkspaceReadErrorKind::AccessDenied => WorkspaceInspectErrorKind::AccessDenied,
        WorkspaceReadErrorKind::PathNotAllowed => WorkspaceInspectErrorKind::PathNotAllowed,
        WorkspaceReadErrorKind::NotRegularFile => WorkspaceInspectErrorKind::NotRegularFile,
        WorkspaceReadErrorKind::FileTooLarge => WorkspaceInspectErrorKind::Oversized,
        WorkspaceReadErrorKind::BinaryFile => WorkspaceInspectErrorKind::Binary,
        WorkspaceReadErrorKind::ChangedDuringRead => WorkspaceInspectErrorKind::Changed,
        WorkspaceReadErrorKind::Cancelled | WorkspaceReadErrorKind::Unavailable => {
            WorkspaceInspectErrorKind::Unavailable
        }
    }
}

fn error(kind: WorkspaceInspectErrorKind) -> WorkspaceInspectOutcome {
    WorkspaceInspectOutcome::Error { kind }
}

#[cfg(test)]
#[path = "tests/workspace_inspect.rs"]
mod tests;
