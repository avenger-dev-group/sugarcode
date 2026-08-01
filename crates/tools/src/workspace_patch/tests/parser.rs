use super::*;

fn diff(body: &str) -> String {
    format!("--- a/notes.txt\n+++ b/notes.txt\n{body}")
}

#[test]
fn standard_unified_diff_accepts_optional_counts_function_context_and_crlf() {
    let hunks = parse_patch(&diff(
        "@@ -1,2 +1,2 @@ replace heading\n one\n-two\n+second\n",
    ))
    .expect("standard unified diff");
    assert_eq!(hunks.len(), 1);
    assert_eq!(hunks[0].old_start, 1);
    assert_eq!(hunks[0].old_count, 2);
    assert_eq!(hunks[0].new_start, 1);
    assert_eq!(hunks[0].new_count, 2);

    let omitted_counts = diff("@@ -1 +1 @@\n-old\n+new\n");
    assert!(parse_patch(&omitted_counts).is_ok());

    let crlf = omitted_counts.replace('\n', "\r\n");
    assert!(parse_patch(&crlf).is_ok());
}

#[test]
fn standard_unified_diff_reports_header_count_mismatch() {
    let malformed = diff("@@ -1,2 +1,2 @@\n-old\n+new\n");
    assert_eq!(
        parse_patch(&malformed).unwrap_err(),
        WorkspacePatchErrorKind::HeaderCountMismatch
    );
}

#[test]
fn standard_unified_diff_rejects_unsupported_or_ambiguous_features() {
    for invalid in [
        "@@ -1 +1 @@\n-old\n+new\n".to_string(),
        diff("@@ -1 +1 @@\n-old\n+new"),
        "diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-old\n+new\n".to_string(),
        "--- a/notes.txt\n+++ b/notes.txt\nrename from notes.txt\nrename to renamed.txt\n".to_string(),
        "--- a/notes.txt\n+++ b/notes.txt\nGIT binary patch\n".to_string(),
        "--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n-old\n+new\n--- a/two.txt\n+++ b/two.txt\n@@ -1 +1 @@\n-old\n+new\n".to_string(),
        diff("@@ -01 +1 @@\n-old\n+new\n"),
    ] {
        assert_eq!(
            parse_patch(&invalid).unwrap_err(),
            WorkspacePatchErrorKind::UnsupportedDiffFeature
        );
    }

    assert_eq!(
        parse_patch(&diff("@@ -0,1 +1 @@\n-old\n+new\n")).unwrap_err(),
        WorkspacePatchErrorKind::RangeOutOfBounds
    );

    let no_change = parse_patch(&diff("@@ -1 +1 @@\n old\n")).expect("structural hunk");
    assert_eq!(
        apply_hunks(&["old".to_string()], &no_change).unwrap_err(),
        WorkspacePatchErrorKind::UnsupportedDiffFeature
    );
}

#[test]
fn standard_unified_diff_enforces_hunk_patch_line_and_content_line_limits() {
    let too_many_hunks = format!(
        "--- a/notes.txt\n+++ b/notes.txt\n{}",
        (0..=MAX_WORKSPACE_PATCH_HUNKS)
            .map(|index| format!("@@ -{} +{} @@\n-old\n+new\n", index + 1, index + 1))
            .collect::<String>()
    );
    assert_eq!(
        parse_patch(&too_many_hunks).unwrap_err(),
        WorkspacePatchErrorKind::UnsupportedDiffFeature
    );

    let too_many_lines = diff(&format!(
        "@@ -1,{} +0,0 @@\n{}",
        MAX_WORKSPACE_PATCH_LINES,
        "-old\n".repeat(MAX_WORKSPACE_PATCH_LINES)
    ));
    assert_eq!(
        parse_patch(&too_many_lines).unwrap_err(),
        WorkspacePatchErrorKind::UnsupportedDiffFeature
    );

    let long_line = "x".repeat(MAX_WORKSPACE_LINE_BYTES + 1);
    assert_eq!(
        parse_patch(&diff(&format!("@@ -1 +1 @@\n-old\n+{long_line}\n"))).unwrap_err(),
        WorkspacePatchErrorKind::LineTooLong
    );
}
