use super::MAX_WORKSPACE_DIFF_BYTES;
use super::MAX_WORKSPACE_DIFF_LINES;
use super::WorkspacePatchErrorKind;
use super::parser::Hunk;
use super::parser::PatchLine;

#[derive(Debug, Clone)]
pub(super) enum DiffOperation {
    Equal(String),
    Remove(String),
    Add(String),
}

pub(super) fn apply_hunks(
    before: &[String],
    hunks: &[Hunk],
) -> Result<(Vec<String>, Vec<DiffOperation>), WorkspacePatchErrorKind> {
    let mut after = Vec::new();
    let mut operations = Vec::new();
    let mut old_cursor = 0usize;
    let mut new_cursor = 0usize;
    let mut changed = false;
    for hunk in hunks {
        let expected_old = if hunk.old_count == 0 {
            hunk.old_start
        } else {
            hunk.old_start
                .checked_sub(1)
                .ok_or(WorkspacePatchErrorKind::InvalidPatch)?
        };
        let expected_new = if hunk.new_count == 0 {
            hunk.new_start
        } else {
            hunk.new_start
                .checked_sub(1)
                .ok_or(WorkspacePatchErrorKind::InvalidPatch)?
        };
        if expected_old < old_cursor || expected_new < new_cursor {
            return Err(WorkspacePatchErrorKind::InvalidPatch);
        }
        while old_cursor < expected_old {
            let line = before
                .get(old_cursor)
                .ok_or(WorkspacePatchErrorKind::PatchDoesNotApply)?
                .clone();
            after.push(line.clone());
            operations.push(DiffOperation::Equal(line));
            old_cursor += 1;
            new_cursor += 1;
        }
        if new_cursor != expected_new {
            return Err(WorkspacePatchErrorKind::InvalidPatch);
        }
        for line in &hunk.lines {
            match line {
                PatchLine::Context(expected) => {
                    if before.get(old_cursor) != Some(expected) {
                        return Err(WorkspacePatchErrorKind::PatchDoesNotApply);
                    }
                    after.push(expected.clone());
                    operations.push(DiffOperation::Equal(expected.clone()));
                    old_cursor += 1;
                    new_cursor += 1;
                }
                PatchLine::Remove(expected) => {
                    if before.get(old_cursor) != Some(expected) {
                        return Err(WorkspacePatchErrorKind::PatchDoesNotApply);
                    }
                    operations.push(DiffOperation::Remove(expected.clone()));
                    old_cursor += 1;
                    changed = true;
                }
                PatchLine::Add(value) => {
                    after.push(value.clone());
                    operations.push(DiffOperation::Add(value.clone()));
                    new_cursor += 1;
                    changed = true;
                }
            }
        }
    }
    while old_cursor < before.len() {
        let line = before[old_cursor].clone();
        after.push(line.clone());
        operations.push(DiffOperation::Equal(line));
        old_cursor += 1;
    }
    if !changed {
        return Err(WorkspacePatchErrorKind::InvalidPatch);
    }
    Ok((after, operations))
}

pub(super) fn render_diff(
    path: &str,
    operations: &[DiffOperation],
) -> Result<String, WorkspacePatchErrorKind> {
    let changed = operations
        .iter()
        .enumerate()
        .filter_map(|(index, operation)| {
            (!matches!(operation, DiffOperation::Equal(_))).then_some(index)
        })
        .collect::<Vec<_>>();
    let mut ranges = Vec::<(usize, usize)>::new();
    for index in changed {
        let start = context_start(operations, index, 3);
        let end = context_end(operations, index, 3);
        if let Some(last) = ranges.last_mut().filter(|last| start <= last.1) {
            last.1 = last.1.max(end);
        } else {
            ranges.push((start, end));
        }
    }
    let mut old_positions = vec![1usize; operations.len() + 1];
    let mut new_positions = vec![1usize; operations.len() + 1];
    for (index, operation) in operations.iter().enumerate() {
        old_positions[index + 1] =
            old_positions[index] + usize::from(!matches!(operation, DiffOperation::Add(_)));
        new_positions[index + 1] =
            new_positions[index] + usize::from(!matches!(operation, DiffOperation::Remove(_)));
    }
    let mut diff = format!("--- a/{path}\n+++ b/{path}\n");
    for (start, end) in ranges {
        let old_count = operations[start..end]
            .iter()
            .filter(|op| !matches!(op, DiffOperation::Add(_)))
            .count();
        let new_count = operations[start..end]
            .iter()
            .filter(|op| !matches!(op, DiffOperation::Remove(_)))
            .count();
        diff.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            old_positions[start], old_count, new_positions[start], new_count
        ));
        for operation in &operations[start..end] {
            let (prefix, value) = match operation {
                DiffOperation::Equal(value) => (' ', value),
                DiffOperation::Remove(value) => ('-', value),
                DiffOperation::Add(value) => ('+', value),
            };
            diff.push(prefix);
            diff.push_str(value);
            diff.push('\n');
        }
    }
    if diff.len() > MAX_WORKSPACE_DIFF_BYTES || diff.lines().count() > MAX_WORKSPACE_DIFF_LINES {
        Err(WorkspacePatchErrorKind::ResultTooLarge)
    } else {
        Ok(diff)
    }
}

fn context_start(operations: &[DiffOperation], index: usize, count: usize) -> usize {
    let mut cursor = index;
    let mut remaining = count;
    while cursor > 0 && remaining > 0 {
        if !matches!(operations[cursor - 1], DiffOperation::Equal(_)) {
            break;
        }
        cursor -= 1;
        remaining -= 1;
    }
    cursor
}

fn context_end(operations: &[DiffOperation], index: usize, count: usize) -> usize {
    let mut cursor = index + 1;
    let mut remaining = count;
    while cursor < operations.len() && remaining > 0 {
        if !matches!(operations[cursor], DiffOperation::Equal(_)) {
            cursor += 1;
            continue;
        }
        cursor += 1;
        remaining -= 1;
    }
    cursor
}
