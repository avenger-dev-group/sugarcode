use super::*;
use crate::workspace_patch::diff::DiffOperation;

#[test]
fn exact_hunks_apply_without_fuzz_and_render_three_lines_of_context() {
    let before = (1..=9)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>();
    let patch = parse_patch("@@ -5,1 +5,1 @@\n-line 5\n+changed\n").expect("patch");
    let (after, operations) = apply_hunks(&before, &patch).expect("exact apply");
    assert_eq!(after[4], "changed");
    assert_eq!(
        render_diff("nested/notes.txt", &operations).expect("review diff"),
        concat!(
            "--- a/nested/notes.txt\n",
            "+++ b/nested/notes.txt\n",
            "@@ -2,7 +2,7 @@\n",
            " line 2\n",
            " line 3\n",
            " line 4\n",
            "-line 5\n",
            "+changed\n",
            " line 6\n",
            " line 7\n",
            " line 8\n",
        )
    );

    let mismatch = parse_patch("@@ -5,1 +5,1 @@\n-other\n+changed\n").expect("patch");
    assert_eq!(
        apply_hunks(&before, &mismatch).unwrap_err(),
        WorkspacePatchErrorKind::PatchDoesNotApply
    );
}

#[test]
fn review_diff_fails_instead_of_truncating_at_the_line_limit() {
    let operations = (0..MAX_WORKSPACE_DIFF_LINES)
        .map(|index| DiffOperation::Add(format!("added {index}")))
        .collect::<Vec<_>>();
    assert_eq!(
        render_diff("notes.txt", &operations).unwrap_err(),
        WorkspacePatchErrorKind::ResultTooLarge
    );

    let oversized_bytes = (0..13)
        .map(|_| DiffOperation::Add("x".repeat(MAX_WORKSPACE_LINE_BYTES)))
        .collect::<Vec<_>>();
    assert_eq!(
        render_diff("notes.txt", &oversized_bytes).unwrap_err(),
        WorkspacePatchErrorKind::ResultTooLarge
    );
}
