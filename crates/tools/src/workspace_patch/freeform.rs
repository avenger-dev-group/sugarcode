use super::MAX_WORKSPACE_CHANGE_SET_FILES;
use super::MAX_WORKSPACE_PATCH_BYTES;
use super::MAX_WORKSPACE_PATCH_HUNKS;
use super::MAX_WORKSPACE_PATCH_LINES;
use std::collections::BTreeSet;
use std::path::Component;
use std::path::Path;

// Keep the provider grammar deliberately shallow. OpenAI custom-tool grammars
// lex regex terminals greedily before applying parser rules, so splitting the
// arbitrary path and line text across many terminals can drive the model out
// of distribution. The local parser below remains the semantic authority.
pub const WORKSPACE_APPLY_PATCH_LARK_GRAMMAR: &str = r#"start: PATCH
PATCH: /\*\*\* Begin Patch\r?\n(?s:.+)\r?\n\*\*\* End Patch\r?\n?/
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
        move_path: Option<String>,
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
    pub(super) context_pairs: Vec<(usize, usize)>,
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
    if patch.trim().is_empty() {
        return Err(WorkspaceFreeformPatchErrorKind::Empty);
    }
    if patch.len() > MAX_WORKSPACE_PATCH_BYTES {
        return Err(WorkspaceFreeformPatchErrorKind::TooLarge);
    }
    let raw_lines = patch
        .trim()
        .split_terminator('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect::<Vec<_>>();
    let lines = unwrap_heredoc(&raw_lines);
    if lines.len() > MAX_WORKSPACE_PATCH_LINES {
        return Err(WorkspaceFreeformPatchErrorKind::TooLarge);
    }
    if lines.first().map(|line| line.trim()) != Some("*** Begin Patch")
        || lines.last().map(|line| line.trim()) != Some("*** End Patch")
    {
        return Err(WorkspaceFreeformPatchErrorKind::InvalidBoundary);
    }

    let mut files = Vec::new();
    let mut index = 1usize;
    if let Some(environment_id) = lines
        .get(index)
        .and_then(|line| line.trim().strip_prefix("*** Environment ID:"))
    {
        if environment_id.trim().is_empty() {
            return Err(WorkspaceFreeformPatchErrorKind::InvalidHunk);
        }
        index += 1;
    }
    let mut file_sections = 0usize;
    while index + 1 < lines.len() {
        if file_sections >= MAX_WORKSPACE_CHANGE_SET_FILES {
            return Err(WorkspaceFreeformPatchErrorKind::TooManyFiles);
        }
        file_sections += 1;
        let marker = lines[index].trim();
        index += 1;
        if let Some(path) = marker.strip_prefix("*** Add File: ") {
            let path = path.trim();
            validate_marker_path(path)?;
            let mut content = String::new();
            while index < lines.len() - 1 && !is_file_marker(lines[index].trim()) {
                let line = lines[index]
                    .strip_prefix('+')
                    .ok_or(WorkspaceFreeformPatchErrorKind::InvalidHunk)?;
                content.push_str(line);
                content.push('\n');
                index += 1;
            }
            files.push(FilePatch::Add {
                path: path.to_owned(),
                content,
            });
        } else if let Some(path) = marker.strip_prefix("*** Delete File: ") {
            let path = path.trim();
            validate_marker_path(path)?;
            files.push(FilePatch::Delete {
                path: path.to_owned(),
            });
        } else if let Some(path) = marker.strip_prefix("*** Update File: ") {
            let path = path.trim();
            validate_marker_path(path)?;
            let move_path = lines
                .get(index)
                .and_then(|line| line.trim_end().strip_prefix("*** Move to: ").map(str::trim));
            if let Some(move_path) = move_path {
                validate_marker_path(move_path)?;
                index += 1;
            }
            let start = index;
            while index < lines.len() - 1 && !is_file_marker(lines[index].trim_end()) {
                index += 1;
            }
            let chunks = if start == index && move_path.is_some() {
                Vec::new()
            } else {
                parse_update(&lines[start..index])?
            };
            if move_path.is_none()
                && let Some(FilePatch::Update {
                    path: previous_path,
                    move_path: None,
                    chunks: previous_chunks,
                }) = files.last_mut()
                && previous_path == path
            {
                previous_chunks.extend(chunks);
            } else {
                files.push(FilePatch::Update {
                    path: path.to_owned(),
                    move_path: move_path.map(str::to_owned),
                    chunks,
                });
            }
        } else {
            return Err(WorkspaceFreeformPatchErrorKind::InvalidHunk);
        }
    }
    if files.is_empty() || index != lines.len() - 1 {
        return Err(WorkspaceFreeformPatchErrorKind::Empty);
    }
    let mut paths = BTreeSet::new();
    for file in &files {
        if !paths.insert(file.path()) {
            return Err(WorkspaceFreeformPatchErrorKind::DuplicatePath);
        }
        if let FilePatch::Update {
            move_path: Some(move_path),
            ..
        } = file
            && !paths.insert(move_path)
        {
            return Err(WorkspaceFreeformPatchErrorKind::DuplicatePath);
        }
    }
    if paths.len() > MAX_WORKSPACE_CHANGE_SET_FILES {
        return Err(WorkspaceFreeformPatchErrorKind::TooManyFiles);
    }
    Ok(ParsedPatch { files })
}

fn unwrap_heredoc<'a>(lines: &'a [&'a str]) -> &'a [&'a str] {
    match lines {
        [first, .., last]
            if matches!(first.trim(), "<<EOF" | "<<'EOF'" | "<<\"EOF\"")
                && last.trim() == "EOF"
                && lines.len() >= 4 =>
        {
            &lines[1..lines.len() - 1]
        }
        _ => lines,
    }
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
        context_pairs: Vec::new(),
        end_of_file: false,
    };
    let mut has_change_line = false;
    let mut changed_lines = 0usize;
    for line in lines {
        let marker_line = line.trim_end();
        if current.end_of_file {
            if line.trim().is_empty() {
                continue;
            }
            return Err(WorkspaceFreeformPatchErrorKind::InvalidHunk);
        }
        if marker_line == "@@" || marker_line.starts_with("@@ ") {
            if has_change_line {
                finish_chunk(&mut chunks, current)?;
                current = UpdateChunk {
                    context: None,
                    old_lines: Vec::new(),
                    new_lines: Vec::new(),
                    context_pairs: Vec::new(),
                    end_of_file: false,
                };
                has_change_line = false;
            } else if current.context.is_some() {
                return Err(WorkspaceFreeformPatchErrorKind::InvalidHunk);
            }
            current.context = marker_line.strip_prefix("@@ ").map(str::to_owned);
            continue;
        }
        if marker_line == "*** End of File" {
            if !has_change_line {
                return Err(WorkspaceFreeformPatchErrorKind::InvalidHunk);
            }
            current.end_of_file = true;
            continue;
        }
        // Codex apply_patch treats an empty line inside an update section as
        // unchanged blank-line context. Models commonly omit the otherwise
        // invisible single-space prefix, so normalize that harmless spelling
        // before classifying the line.
        let (prefix, text) = match line.as_bytes().first().copied() {
            None => (b' ', ""),
            Some(prefix @ (b' ' | b'-' | b'+')) => (prefix, &line[1..]),
            // Compatible models frequently omit the otherwise invisible diff
            // prefix on unchanged source lines. Treat an unprefixed line as
            // context; file, chunk and EOF markers were handled above.
            Some(_) => (b' ', *line),
        };
        match prefix {
            b' ' => {
                current
                    .context_pairs
                    .push((current.old_lines.len(), current.new_lines.len()));
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
    let parsed = Path::new(path);
    if path.is_empty()
        || path.contains(['\r', '\n', '\0'])
        || parsed.is_absolute()
        || !parsed
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
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
