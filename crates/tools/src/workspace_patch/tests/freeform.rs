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
        FilePatch::Update { path, chunks, .. }
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
fn accepts_codex_lenient_boundaries_heredocs_and_move_sections() {
    for opener in ["<<EOF", "<<'EOF'", "<<\"EOF\""] {
        let patch = format!(
            "{opener}\n  *** Begin Patch  \n*** Update File: old.txt  \n*** Move to: new.txt\n-old\n+new\n  *** End Patch  \nEOF\n"
        );
        let parsed = parse_workspace_freeform_patch(&patch).expect("lenient Codex patch");
        assert!(matches!(
            &parsed.files[0],
            FilePatch::Update { path, move_path: Some(move_path), chunks }
                if path == "old.txt"
                    && move_path == "new.txt"
                    && chunks[0].old_lines == ["old"]
                    && chunks[0].new_lines == ["new"]
        ));
    }
}

#[test]
fn merges_adjacent_update_sections_for_one_path() {
    let parsed = parse_workspace_freeform_patch(concat!(
        "*** Begin Patch\n",
        "*** Update File: notes.txt\n",
        "-one\n",
        "+first\n",
        "*** Update File: notes.txt\n",
        "-two\n",
        "+second\n",
        "*** End Patch",
    ))
    .expect("adjacent updates");

    let FilePatch::Update { chunks, .. } = &parsed.files[0] else {
        panic!("update patch");
    };
    assert_eq!(parsed.files.len(), 1);
    assert_eq!(chunks.len(), 2);
}

#[test]
fn accepts_an_empty_add_file_like_codex_apply_patch() {
    let parsed = parse_workspace_freeform_patch(concat!(
        "*** Begin Patch\n",
        "*** Add File: empty.txt\n",
        "*** End Patch",
    ))
    .expect("empty add file");

    assert!(matches!(
        &parsed.files[0],
        FilePatch::Add { path, content } if path == "empty.txt" && content.is_empty()
    ));
}

#[test]
fn accepts_an_unprefixed_complete_add_file_body() {
    let parsed = parse_workspace_freeform_patch(concat!(
        "*** Begin Patch\n",
        "*** Add File: added.ts\n",
        "export const sum = left + right;\n",
        "+literalLeadingPlus\n",
        "*** End Patch",
    ))
    .expect("unprefixed add file");

    assert!(matches!(
        &parsed.files[0],
        FilePatch::Add { path, content }
            if path == "added.ts"
                && content == "export const sum = left + right;\n+literalLeadingPlus\n"
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
    assert!(WORKSPACE_APPLY_PATCH_LARK_GRAMMAR.contains("start: PATCH"));
    assert!(WORKSPACE_APPLY_PATCH_LARK_GRAMMAR.contains("Begin Patch"));
    assert!(WORKSPACE_APPLY_PATCH_LARK_GRAMMAR.contains("End Patch"));
    assert!(!WORKSPACE_APPLY_PATCH_LARK_GRAMMAR.contains("filename:"));
}

#[test]
fn accepts_unprefixed_blank_context_lines_like_codex_apply_patch() {
    let parsed = parse_workspace_freeform_patch(concat!(
        "*** Begin Patch\n",
        "*** Update File: notes.txt\n",
        "@@\n",
        " before\n",
        "\n",
        "-old\n",
        "+new\n",
        " after\n",
        "*** End Patch",
    ))
    .expect("blank context line");

    let FilePatch::Update { chunks, .. } = &parsed.files[0] else {
        panic!("update patch");
    };
    assert_eq!(chunks[0].old_lines, ["before", "", "old", "after"]);
    assert_eq!(chunks[0].new_lines, ["before", "", "new", "after"]);
}

#[test]
fn accepts_unprefixed_nonempty_context_from_compatible_models() {
    let parsed = parse_workspace_freeform_patch(concat!(
        "*** Begin Patch\n",
        "*** Update File: notes.txt\n",
        "before\n",
        "-old\n",
        "+new\n",
        "after\n",
        "*** End Patch",
    ))
    .expect("unprefixed context lines");

    let FilePatch::Update { chunks, .. } = &parsed.files[0] else {
        panic!("update patch");
    };
    assert_eq!(chunks[0].old_lines, ["before", "old", "after"]);
    assert_eq!(chunks[0].new_lines, ["before", "new", "after"]);
    assert_eq!(chunks[0].context_pairs, [(0, 0), (2, 2)]);
}

#[test]
fn accepts_unchanged_file_prelude_before_the_first_hunk_marker() {
    let parsed = parse_workspace_freeform_patch(concat!(
        "*** Begin Patch\n",
        "*** Update File: notes.txt\n",
        "import alpha\n",
        "import beta\n",
        "@@\n",
        "-old\n",
        "+new\n",
        "*** End Patch",
    ))
    .expect("compatible prelude");

    let FilePatch::Update { chunks, .. } = &parsed.files[0] else {
        panic!("update patch");
    };
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].old_lines, ["import alpha", "import beta", "old"]);
    assert_eq!(chunks[0].new_lines, ["import alpha", "import beta", "new"]);
}
