use super::*;

#[test]
fn unified_hunks_v1_requires_exact_headers_counts_and_lf_termination() {
    let hunks = parse_patch("@@ -1,2 +1,2 @@\n one\n-two\n+second\n").expect("strict unified hunk");
    assert_eq!(hunks.len(), 1);
    assert_eq!(hunks[0].old_start, 1);
    assert_eq!(hunks[0].old_count, 2);
    assert_eq!(hunks[0].new_start, 1);
    assert_eq!(hunks[0].new_count, 2);

    for invalid in [
        "--- a/notes.txt\n+++ b/notes.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n",
        "@@ -1 +1 @@\n-old\n+new\n",
        "@@ -1,1 +1,1 @@\n-old\n+new",
        "@@ -1,1 +1,1 @@\r\n-old\r\n+new\r\n",
        "@@ -01,1 +1,1 @@\n-old\n+new\n",
        "@@ -0,1 +1,1 @@\n-old\n+new\n",
    ] {
        assert_eq!(
            parse_patch(invalid).unwrap_err(),
            WorkspacePatchErrorKind::InvalidPatch
        );
    }

    let no_change = parse_patch("@@ -1,1 +1,1 @@\n old\n").expect("structural hunk");
    assert_eq!(
        apply_hunks(&["old".to_string()], &no_change).unwrap_err(),
        WorkspacePatchErrorKind::InvalidPatch
    );
}

#[test]
fn unified_hunks_v1_enforces_hunk_patch_line_and_content_line_limits() {
    let too_many_hunks = (0..=MAX_WORKSPACE_PATCH_HUNKS)
        .map(|index| format!("@@ -{},1 +{},1 @@\n-old\n+new\n", index + 1, index + 1))
        .collect::<String>();
    assert_eq!(
        parse_patch(&too_many_hunks).unwrap_err(),
        WorkspacePatchErrorKind::InvalidPatch
    );

    let too_many_lines = format!(
        "@@ -1,{} +1,0 @@\n{}",
        MAX_WORKSPACE_PATCH_LINES,
        "-old\n".repeat(MAX_WORKSPACE_PATCH_LINES)
    );
    assert_eq!(
        parse_patch(&too_many_lines).unwrap_err(),
        WorkspacePatchErrorKind::InvalidPatch
    );

    let long_line = "x".repeat(MAX_WORKSPACE_LINE_BYTES + 1);
    assert_eq!(
        parse_patch(&format!("@@ -1,1 +1,1 @@\n-old\n+{long_line}\n")).unwrap_err(),
        WorkspacePatchErrorKind::LineTooLong
    );
}
