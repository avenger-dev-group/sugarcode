use super::*;

#[test]
fn parses_bounded_add_update_and_delete_hunks() {
    let parsed = parse_workspace_freeform_patch(concat!(
        "*** Begin Patch\n",
        "*** Add File: added.txt\n",
        "+new\n",
        "*** Update File: notes.txt\n",
        "@@ heading\n",
        "-old\n",
        "+new\n",
        "*** Delete File: stale.txt\n",
        "*** End Patch\n",
    ))
    .expect("valid patch");

    assert_eq!(parsed.files.len(), 3);
    assert!(matches!(
        &parsed.files[0],
        FilePatch::Add { path, content } if path == "added.txt" && content == "new\n"
    ));
    assert!(matches!(
        &parsed.files[1],
        FilePatch::Update { path, chunks }
            if path == "notes.txt"
                && chunks[0].context.as_deref() == Some("heading")
                && chunks[0].old_lines == ["old"]
                && chunks[0].new_lines == ["new"]
    ));
    assert!(matches!(
        &parsed.files[2],
        FilePatch::Delete { path } if path == "stale.txt"
    ));
}

#[test]
fn rejects_bad_boundaries_duplicate_paths_and_context_only_updates() {
    for (patch, kind) in [
        (
            "*** Add File: a.txt\n+x\n*** End Patch",
            WorkspaceFreeformPatchErrorKind::InvalidBoundary,
        ),
        (
            concat!(
                "*** Begin Patch\n",
                "*** Add File: a.txt\n",
                "+x\n",
                "*** Delete File: a.txt\n",
                "*** End Patch",
            ),
            WorkspaceFreeformPatchErrorKind::DuplicatePath,
        ),
        (
            concat!(
                "*** Begin Patch\n",
                "*** Update File: a.txt\n",
                " unchanged\n",
                "*** End Patch",
            ),
            WorkspaceFreeformPatchErrorKind::InvalidHunk,
        ),
    ] {
        assert_eq!(parse_workspace_freeform_patch(patch), Err(kind));
    }
}

#[test]
fn exported_lark_grammar_matches_the_parser_envelope() {
    assert!(WORKSPACE_APPLY_PATCH_LARK_GRAMMAR.contains("start: begin_patch hunk+ end_patch"));
    assert!(WORKSPACE_APPLY_PATCH_LARK_GRAMMAR.contains("*** Update File: "));
    assert!(!WORKSPACE_APPLY_PATCH_LARK_GRAMMAR.contains("Move to"));
}
