use super::MAX_WORKSPACE_CHANGE_SET_FILES;
use super::MAX_WORKSPACE_PATCH_BYTES;
use super::MAX_WORKSPACE_PATCH_HUNKS;
use super::MAX_WORKSPACE_PATCH_LINES;
use std::collections::BTreeSet;

pub const WORKSPACE_APPLY_PATCH_LARK_GRAMMAR: &str = r#"start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change+

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceFreeformPatchErrorKind {
    Empty,
    TooLarge,
    InvalidBoundary,
    InvalidHunk,
    TooManyFiles,
    DuplicatePath,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ParsedPatch {
    pub(super) files: Vec<FilePatch>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum FilePatch {
    Add {
        path: String,
        content: String,
    },
    Delete {
        path: String,
    },
    Update {
        path: String,
        chunks: Vec<UpdateChunk>,
    },
}

impl FilePatch {
    fn path(&self) -> &str {
        match self {
            Self::Add { path, .. } | Self::Delete { path } | Self::Update { path, .. } => path,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct UpdateChunk {
    pub(super) context: Option<String>,
    pub(super) old_lines: Vec<String>,
    pub(super) new_lines: Vec<String>,
    pub(super) end_of_file: bool,
}

pub fn validate_workspace_freeform_patch(
    patch: &str,
) -> Result<(), WorkspaceFreeformPatchErrorKind> {
    parse_workspace_freeform_patch(patch).map(|_| ())
}

pub(super) fn parse_workspace_freeform_patch(
    patch: &str,
) -> Result<ParsedPatch, WorkspaceFreeformPatchErrorKind> {
    if patch.is_empty() {
        return Err(WorkspaceFreeformPatchErrorKind::Empty);
    }
    if patch.len() > MAX_WORKSPACE_PATCH_BYTES {
        return Err(WorkspaceFreeformPatchErrorKind::TooLarge);
    }
    let lines = patch
        .split_terminator('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect::<Vec<_>>();
    if lines.len() > MAX_WORKSPACE_PATCH_LINES {
        return Err(WorkspaceFreeformPatchErrorKind::TooLarge);
    }
    if lines.first() != Some(&"*** Begin Patch") || lines.last() != Some(&"*** End Patch") {
        return Err(WorkspaceFreeformPatchErrorKind::InvalidBoundary);
    }

    let mut files = Vec::new();
    let mut index = 1usize;
    while index + 1 < lines.len() {
        if files.len() >= MAX_WORKSPACE_CHANGE_SET_FILES {
            return Err(WorkspaceFreeformPatchErrorKind::TooManyFiles);
        }
        let marker = lines[index];
        index += 1;
        if let Some(path) = marker.strip_prefix("*** Add File: ") {
            validate_marker_path(path)?;
            let mut content = String::new();
            let mut count = 0usize;
            while index < lines.len() - 1 && !is_file_marker(lines[index]) {
                let line = lines[index]
                    .strip_prefix('+')
                    .ok_or(WorkspaceFreeformPatchErrorKind::InvalidHunk)?;
                content.push_str(line);
                content.push('\n');
                count += 1;
                index += 1;
            }
            if count == 0 {
                return Err(WorkspaceFreeformPatchErrorKind::InvalidHunk);
            }
            files.push(FilePatch::Add {
                path: path.to_owned(),
                content,
            });
        } else if let Some(path) = marker.strip_prefix("*** Delete File: ") {
            validate_marker_path(path)?;
            files.push(FilePatch::Delete {
                path: path.to_owned(),
            });
        } else if let Some(path) = marker.strip_prefix("*** Update File: ") {
            validate_marker_path(path)?;
            let start = index;
            while index < lines.len() - 1 && !is_file_marker(lines[index]) {
                index += 1;
            }
            let chunks = parse_update(&lines[start..index])?;
            files.push(FilePatch::Update {
                path: path.to_owned(),
                chunks,
            });
        } else {
            return Err(WorkspaceFreeformPatchErrorKind::InvalidHunk);
        }
    }
    if files.is_empty() || index != lines.len() - 1 {
        return Err(WorkspaceFreeformPatchErrorKind::Empty);
    }
    let mut paths = BTreeSet::new();
    if files.iter().any(|file| !paths.insert(file.path())) {
        return Err(WorkspaceFreeformPatchErrorKind::DuplicatePath);
    }
    Ok(ParsedPatch { files })
}

fn parse_update(lines: &[&str]) -> Result<Vec<UpdateChunk>, WorkspaceFreeformPatchErrorKind> {
    if lines.is_empty() {
        return Err(WorkspaceFreeformPatchErrorKind::InvalidHunk);
    }
    let mut chunks = Vec::new();
    let mut current = UpdateChunk {
        context: None,
        old_lines: Vec::new(),
        new_lines: Vec::new(),
        end_of_file: false,
    };
    let mut has_change_line = false;
    let mut changed_lines = 0usize;
    for (offset, line) in lines.iter().enumerate() {
        if *line == "@@" || line.starts_with("@@ ") {
            if has_change_line {
                finish_chunk(&mut chunks, current)?;
                current = UpdateChunk {
                    context: None,
                    old_lines: Vec::new(),
                    new_lines: Vec::new(),
                    end_of_file: false,
                };
                has_change_line = false;
            } else if current.context.is_some() {
                return Err(WorkspaceFreeformPatchErrorKind::InvalidHunk);
            }
            current.context = line.strip_prefix("@@ ").map(str::to_owned);
            continue;
        }
        if *line == "*** End of File" {
            if !has_change_line || offset + 1 != lines.len() {
                return Err(WorkspaceFreeformPatchErrorKind::InvalidHunk);
            }
            current.end_of_file = true;
            continue;
        }
        let Some(prefix) = line.as_bytes().first().copied() else {
            return Err(WorkspaceFreeformPatchErrorKind::InvalidHunk);
        };
        let text = match prefix {
            b' ' | b'-' | b'+' => &line[1..],
            _ => return Err(WorkspaceFreeformPatchErrorKind::InvalidHunk),
        };
        match prefix {
            b' ' => {
                current.old_lines.push(text.to_owned());
                current.new_lines.push(text.to_owned());
            }
            b'-' => {
                current.old_lines.push(text.to_owned());
                changed_lines += 1;
            }
            b'+' => {
                current.new_lines.push(text.to_owned());
                changed_lines += 1;
            }
            _ => return Err(WorkspaceFreeformPatchErrorKind::InvalidHunk),
        }
        has_change_line = true;
        if changed_lines > MAX_WORKSPACE_PATCH_LINES {
            return Err(WorkspaceFreeformPatchErrorKind::TooLarge);
        }
    }
    if !has_change_line {
        return Err(WorkspaceFreeformPatchErrorKind::InvalidHunk);
    }
    finish_chunk(&mut chunks, current)?;
    if chunks.len() > MAX_WORKSPACE_PATCH_HUNKS {
        return Err(WorkspaceFreeformPatchErrorKind::TooLarge);
    }
    Ok(chunks)
}

fn finish_chunk(
    chunks: &mut Vec<UpdateChunk>,
    chunk: UpdateChunk,
) -> Result<(), WorkspaceFreeformPatchErrorKind> {
    if chunk.old_lines == chunk.new_lines {
        return Err(WorkspaceFreeformPatchErrorKind::InvalidHunk);
    }
    chunks.push(chunk);
    Ok(())
}

fn validate_marker_path(path: &str) -> Result<(), WorkspaceFreeformPatchErrorKind> {
    if path.is_empty() || path.contains(['\r', '\n', '\0']) {
        Err(WorkspaceFreeformPatchErrorKind::InvalidHunk)
    } else {
        Ok(())
    }
}

fn is_file_marker(line: &str) -> bool {
    line.starts_with("*** Add File: ")
        || line.starts_with("*** Delete File: ")
        || line.starts_with("*** Update File: ")
}

#[cfg(test)]
#[path = "tests/freeform.rs"]
mod tests;
