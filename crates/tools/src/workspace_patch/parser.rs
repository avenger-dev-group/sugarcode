use super::MAX_WORKSPACE_LINE_BYTES;
use super::MAX_WORKSPACE_PATCH_HUNKS;
use super::MAX_WORKSPACE_PATCH_LINES;
use super::WorkspacePatchErrorKind;

#[derive(Debug)]
pub(super) struct Hunk {
    pub(super) old_start: usize,
    pub(super) old_count: usize,
    pub(super) new_start: usize,
    pub(super) new_count: usize,
    pub(super) lines: Vec<PatchLine>,
}

#[derive(Debug, Clone)]
pub(super) enum PatchLine {
    Context(String),
    Remove(String),
    Add(String),
}

pub(super) fn parse_patch(patch: &str) -> Result<Vec<Hunk>, WorkspacePatchErrorKind> {
    if !patch.ends_with('\n') || patch.contains('\r') || patch.contains('\0') {
        return Err(WorkspacePatchErrorKind::InvalidPatch);
    }
    let raw_lines = patch[..patch.len() - 1].split('\n').collect::<Vec<_>>();
    if raw_lines.len() > MAX_WORKSPACE_PATCH_LINES {
        return Err(WorkspacePatchErrorKind::InvalidPatch);
    }
    let mut hunks = Vec::new();
    let mut index = 0;
    while index < raw_lines.len() {
        let (old_start, old_count, new_start, new_count) = parse_hunk_header(raw_lines[index])?;
        index += 1;
        let mut lines = Vec::new();
        let mut observed_old = 0usize;
        let mut observed_new = 0usize;
        while index < raw_lines.len() && !raw_lines[index].starts_with("@@") {
            let line = raw_lines[index];
            let (prefix, value) = line
                .split_at_checked(1)
                .ok_or(WorkspacePatchErrorKind::InvalidPatch)?;
            if value.len() > MAX_WORKSPACE_LINE_BYTES {
                return Err(WorkspacePatchErrorKind::LineTooLong);
            }
            match prefix {
                " " => {
                    observed_old += 1;
                    observed_new += 1;
                    lines.push(PatchLine::Context(value.to_string()));
                }
                "-" => {
                    observed_old += 1;
                    lines.push(PatchLine::Remove(value.to_string()));
                }
                "+" => {
                    observed_new += 1;
                    lines.push(PatchLine::Add(value.to_string()));
                }
                _ => return Err(WorkspacePatchErrorKind::InvalidPatch),
            }
            index += 1;
        }
        if observed_old != old_count || observed_new != new_count || lines.is_empty() {
            return Err(WorkspacePatchErrorKind::InvalidPatch);
        }
        hunks.push(Hunk {
            old_start,
            old_count,
            new_start,
            new_count,
            lines,
        });
        if hunks.len() > MAX_WORKSPACE_PATCH_HUNKS {
            return Err(WorkspacePatchErrorKind::InvalidPatch);
        }
    }
    if hunks.is_empty() {
        Err(WorkspacePatchErrorKind::InvalidPatch)
    } else {
        Ok(hunks)
    }
}

fn parse_hunk_header(line: &str) -> Result<(usize, usize, usize, usize), WorkspacePatchErrorKind> {
    if !line.starts_with("@@ -") || !line.ends_with(" @@") {
        return Err(WorkspacePatchErrorKind::InvalidPatch);
    }
    let middle = &line[4..line.len() - 3];
    let (old, new) = middle
        .split_once(" +")
        .ok_or(WorkspacePatchErrorKind::InvalidPatch)?;
    let (old_start, old_count) = parse_range(old)?;
    let (new_start, new_count) = parse_range(new)?;
    Ok((old_start, old_count, new_start, new_count))
}

fn parse_range(value: &str) -> Result<(usize, usize), WorkspacePatchErrorKind> {
    let (start, count) = value
        .split_once(',')
        .ok_or(WorkspacePatchErrorKind::InvalidPatch)?;
    if (start.starts_with('0') && start != "0") || (count.starts_with('0') && count != "0") {
        return Err(WorkspacePatchErrorKind::InvalidPatch);
    }
    let start = start
        .parse()
        .map_err(|_| WorkspacePatchErrorKind::InvalidPatch)?;
    let count = count
        .parse()
        .map_err(|_| WorkspacePatchErrorKind::InvalidPatch)?;
    if start == 0 && count != 0 {
        return Err(WorkspacePatchErrorKind::InvalidPatch);
    }
    Ok((start, count))
}
