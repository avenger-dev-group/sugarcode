use super::MAX_WORKSPACE_LINE_BYTES;
use super::MAX_WORKSPACE_PATCH_HUNKS;
use super::MAX_WORKSPACE_PATCH_LINES;
use super::WorkspaceEditDiagnostic;
use super::WorkspacePatchErrorKind;
use super::WorkspacePatchFailure;

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

#[cfg(test)]
pub(super) fn parse_patch(diff: &str) -> Result<Vec<Hunk>, WorkspacePatchErrorKind> {
    parse_patch_detailed(diff).map_err(|failure| failure.kind)
}

pub(super) fn parse_patch_detailed(diff: &str) -> Result<Vec<Hunk>, WorkspacePatchFailure> {
    if diff.is_empty() || !diff.ends_with('\n') || diff.contains('\0') {
        return Err(parse_failure(
            WorkspacePatchErrorKind::UnsupportedDiffFeature,
            None,
            None,
            "provideStandardUnifiedDiff",
        ));
    }
    let normalized = if diff.contains('\r') {
        if diff
            .as_bytes()
            .windows(2)
            .filter(|window| window[1] == b'\n')
            .any(|window| window[0] != b'\r')
            || diff.as_bytes().iter().enumerate().any(|(index, byte)| {
                *byte == b'\r' && diff.as_bytes().get(index + 1) != Some(&b'\n')
            })
        {
            return Err(parse_failure(
                WorkspacePatchErrorKind::UnsupportedDiffFeature,
                None,
                None,
                "useConsistentLineEndings",
            ));
        }
        diff.replace("\r\n", "\n")
    } else {
        diff.to_owned()
    };
    let raw_lines = normalized[..normalized.len() - 1]
        .split('\n')
        .collect::<Vec<_>>();
    if raw_lines.len() > MAX_WORKSPACE_PATCH_LINES || raw_lines.len() < 3 {
        return Err(parse_failure(
            WorkspacePatchErrorKind::UnsupportedDiffFeature,
            None,
            None,
            "reduceDiffSize",
        ));
    }
    if raw_lines[0].starts_with("diff --git")
        || raw_lines.iter().any(|line| {
            line.starts_with("rename from ")
                || line.starts_with("rename to ")
                || line.starts_with("Binary files ")
                || line == &"GIT binary patch"
        })
    {
        return Err(parse_failure(
            WorkspacePatchErrorKind::UnsupportedDiffFeature,
            None,
            Some(1),
            "removeRenameOrBinaryMetadata",
        ));
    }
    if !raw_lines[0].starts_with("--- ") || !raw_lines[1].starts_with("+++ ") {
        return Err(parse_failure(
            WorkspacePatchErrorKind::UnsupportedDiffFeature,
            None,
            Some(1),
            "addSingleFileHeaders",
        ));
    }

    let mut hunks = Vec::new();
    let mut index = 2usize;
    while index < raw_lines.len() {
        if raw_lines[index].starts_with("--- ") || raw_lines[index].starts_with("+++ ") {
            return Err(parse_failure(
                WorkspacePatchErrorKind::UnsupportedDiffFeature,
                None,
                u32::try_from(index + 1).ok(),
                "useSingleFileUnifiedDiff",
            ));
        }
        let hunk_index = u32::try_from(hunks.len() + 1).ok();
        let (old_start, old_count, new_start, new_count) = parse_hunk_header(raw_lines[index])
            .map_err(|kind| {
                parse_failure(
                    kind,
                    hunk_index,
                    u32::try_from(index + 1).ok(),
                    "correctHunkHeader",
                )
            })?;
        index += 1;
        let mut lines = Vec::new();
        let mut observed_old = 0usize;
        let mut observed_new = 0usize;
        while index < raw_lines.len() && !raw_lines[index].starts_with("@@") {
            let line = raw_lines[index];
            if line.starts_with("--- ") || line.starts_with("+++ ") {
                return Err(parse_failure(
                    WorkspacePatchErrorKind::UnsupportedDiffFeature,
                    hunk_index,
                    u32::try_from(index + 1).ok(),
                    "useSingleFileUnifiedDiff",
                ));
            }
            if line == "\\ No newline at end of file" {
                index += 1;
                continue;
            }
            let (prefix, value) = line.split_at_checked(1).ok_or_else(|| {
                parse_failure(
                    WorkspacePatchErrorKind::UnsupportedDiffFeature,
                    hunk_index,
                    u32::try_from(index + 1).ok(),
                    "prefixEveryHunkLine",
                )
            })?;
            if value.len() > MAX_WORKSPACE_LINE_BYTES {
                return Err(parse_failure(
                    WorkspacePatchErrorKind::LineTooLong,
                    hunk_index,
                    u32::try_from(index + 1).ok(),
                    "shortenDiffLine",
                ));
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
                _ => {
                    return Err(parse_failure(
                        WorkspacePatchErrorKind::UnsupportedDiffFeature,
                        hunk_index,
                        u32::try_from(index + 1).ok(),
                        "prefixEveryHunkLine",
                    ));
                }
            }
            index += 1;
        }
        if observed_old != old_count || observed_new != new_count || lines.is_empty() {
            return Err(WorkspacePatchFailure {
                kind: WorkspacePatchErrorKind::HeaderCountMismatch,
                diagnostic: WorkspaceEditDiagnostic {
                    edit_index: None,
                    hunk_index,
                    line: u32::try_from(index).ok(),
                    expected_summary: Some(format!("old={old_count},new={new_count}")),
                    actual_summary: Some(format!("old={observed_old},new={observed_new}")),
                    suggested_action: "correctLineCounts".to_string(),
                },
            });
        }
        hunks.push(Hunk {
            old_start,
            old_count,
            new_start,
            new_count,
            lines,
        });
        if hunks.len() > MAX_WORKSPACE_PATCH_HUNKS {
            return Err(parse_failure(
                WorkspacePatchErrorKind::UnsupportedDiffFeature,
                hunk_index,
                None,
                "reduceHunkCount",
            ));
        }
    }
    if hunks.is_empty() {
        Err(parse_failure(
            WorkspacePatchErrorKind::UnsupportedDiffFeature,
            None,
            None,
            "addAtLeastOneHunk",
        ))
    } else {
        Ok(hunks)
    }
}

fn parse_failure(
    kind: WorkspacePatchErrorKind,
    hunk_index: Option<u32>,
    line: Option<u32>,
    suggested_action: &str,
) -> WorkspacePatchFailure {
    WorkspacePatchFailure {
        kind,
        diagnostic: WorkspaceEditDiagnostic {
            edit_index: None,
            hunk_index,
            line,
            expected_summary: None,
            actual_summary: None,
            suggested_action: suggested_action.to_string(),
        },
    }
}

fn parse_hunk_header(line: &str) -> Result<(usize, usize, usize, usize), WorkspacePatchErrorKind> {
    let rest = line
        .strip_prefix("@@ -")
        .ok_or(WorkspacePatchErrorKind::UnsupportedDiffFeature)?;
    let (ranges, _) = rest
        .split_once(" @@")
        .ok_or(WorkspacePatchErrorKind::UnsupportedDiffFeature)?;
    let (old, new) = ranges
        .split_once(" +")
        .ok_or(WorkspacePatchErrorKind::UnsupportedDiffFeature)?;
    let (old_start, old_count) = parse_range(old)?;
    let (new_start, new_count) = parse_range(new)?;
    Ok((old_start, old_count, new_start, new_count))
}

fn parse_range(value: &str) -> Result<(usize, usize), WorkspacePatchErrorKind> {
    let (start, count) = value.split_once(',').unwrap_or((value, "1"));
    if start.is_empty()
        || count.is_empty()
        || (start.starts_with('0') && start != "0")
        || (count.starts_with('0') && count != "0")
    {
        return Err(WorkspacePatchErrorKind::UnsupportedDiffFeature);
    }
    let start = start
        .parse()
        .map_err(|_| WorkspacePatchErrorKind::UnsupportedDiffFeature)?;
    let count = count
        .parse()
        .map_err(|_| WorkspacePatchErrorKind::UnsupportedDiffFeature)?;
    if start == 0 && count != 0 {
        return Err(WorkspacePatchErrorKind::RangeOutOfBounds);
    }
    Ok((start, count))
}
