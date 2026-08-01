use super::*;
use std::fs;
use std::path::Path;
use tempfile::tempdir;

fn cancellation() -> CancellationToken {
    CancellationToken::new()
}

fn edit(path: &str, before: &[u8], edits: Vec<WorkspaceLineEdit>) -> WorkspaceEditArguments {
    WorkspaceEditArguments {
        path: path.to_string(),
        base_sha256: sha256(before),
        edits,
    }
}

#[tokio::test]
async fn workspace_edit_applies_multiple_original_revision_line_splices() {
    let workspace = tempdir().expect("workspace");
    let before = b"one\ntwo\nthree\nfour\n";
    fs::write(workspace.path().join("notes.txt"), before).expect("seed file");
    let tool = WorkspaceTool::open(workspace.path()).expect("open workspace");
    let arguments = edit(
        "notes.txt",
        before,
        vec![
            WorkspaceLineEdit {
                start_line: 1,
                delete_line_count: 0,
                expected: String::new(),
                replacement: "zero".to_string(),
            },
            WorkspaceLineEdit {
                start_line: 2,
                delete_line_count: 2,
                expected: "two\nthree".to_string(),
                replacement: "second".to_string(),
            },
            WorkspaceLineEdit {
                start_line: 5,
                delete_line_count: 0,
                expected: String::new(),
                replacement: "five".to_string(),
            },
        ],
    );
    let WorkspacePatchPrepareOutcome::Prepared(prepared) =
        tool.prepare_edit(&arguments, &cancellation()).await
    else {
        panic!("prepare line edit");
    };
    assert_eq!(
        prepared.diff(),
        concat!(
            "--- a/notes.txt\n",
            "+++ b/notes.txt\n",
            "@@ -1,4 +1,5 @@\n",
            "+zero\n",
            " one\n",
            "-two\n",
            "-three\n",
            "+second\n",
            " four\n",
            "+five\n",
        )
    );
    assert!(matches!(
        tool.commit_patch(*prepared, &cancellation()).await,
        WorkspacePatchCommitOutcome::Applied { .. }
    ));
    assert_eq!(
        fs::read_to_string(workspace.path().join("notes.txt")).expect("edited file"),
        "zero\none\nsecond\nfour\nfive\n"
    );
}

#[tokio::test]
async fn workspace_edit_handles_blank_lines_missing_final_newline_and_conflicts() {
    let workspace = tempdir().expect("workspace");
    let before = b"one\ntwo";
    fs::write(workspace.path().join("notes.txt"), before).expect("seed file");
    let tool = WorkspaceTool::open(workspace.path()).expect("open workspace");
    let arguments = edit(
        "notes.txt",
        before,
        vec![WorkspaceLineEdit {
            start_line: 2,
            delete_line_count: 1,
            expected: "two".to_string(),
            replacement: "\nsecond".to_string(),
        }],
    );
    let WorkspacePatchPrepareOutcome::Prepared(prepared) =
        tool.prepare_edit(&arguments, &cancellation()).await
    else {
        panic!("prepare line edit");
    };
    assert!(!prepared.final_newline());
    assert!(matches!(
        tool.commit_patch(*prepared, &cancellation()).await,
        WorkspacePatchCommitOutcome::Applied { .. }
    ));
    assert_eq!(
        fs::read(workspace.path().join("notes.txt")).expect("edited file"),
        b"one\n\nsecond"
    );

    let stale = WorkspaceEditArguments {
        path: "notes.txt".to_string(),
        base_sha256: sha256(before),
        edits: vec![WorkspaceLineEdit {
            start_line: 1,
            delete_line_count: 1,
            expected: "one".to_string(),
            replacement: "first".to_string(),
        }],
    };
    assert!(matches!(
        tool.prepare_edit(&stale, &cancellation()).await,
        WorkspacePatchPrepareOutcome::ValidationRejected {
            kind: WorkspacePatchErrorKind::BaseRevisionMismatch,
            diagnostic: WorkspaceEditDiagnostic {
                suggested_action,
                ..
            }
        } if suggested_action == "readFileAndRebase"
    ));
}

#[tokio::test]
async fn workspace_edit_rejects_bad_counts_overlap_and_expected_content() {
    let workspace = tempdir().expect("workspace");
    let before = b"one\ntwo\nthree\n";
    fs::write(workspace.path().join("notes.txt"), before).expect("seed file");
    let tool = WorkspaceTool::open(workspace.path()).expect("open workspace");
    for (edits, expected_kind, expected_edit_index) in [
        (
            vec![WorkspaceLineEdit {
                start_line: 2,
                delete_line_count: 2,
                expected: "two".to_string(),
                replacement: "changed".to_string(),
            }],
            WorkspacePatchErrorKind::HeaderCountMismatch,
            1,
        ),
        (
            vec![
                WorkspaceLineEdit {
                    start_line: 1,
                    delete_line_count: 2,
                    expected: "one\ntwo".to_string(),
                    replacement: "first".to_string(),
                },
                WorkspaceLineEdit {
                    start_line: 2,
                    delete_line_count: 1,
                    expected: "two".to_string(),
                    replacement: "second".to_string(),
                },
            ],
            WorkspacePatchErrorKind::RangeOutOfBounds,
            2,
        ),
        (
            vec![WorkspaceLineEdit {
                start_line: 2,
                delete_line_count: 1,
                expected: "other".to_string(),
                replacement: "second".to_string(),
            }],
            WorkspacePatchErrorKind::ExpectedMismatch,
            1,
        ),
    ] {
        assert!(matches!(
            tool.prepare_edit(&edit("notes.txt", before, edits), &cancellation())
                .await,
            WorkspacePatchPrepareOutcome::ValidationRejected { kind, diagnostic }
                if kind == expected_kind
                    && diagnostic.edit_index == Some(expected_edit_index)
                    && !diagnostic.suggested_action.is_empty()
        ));
    }
}

#[tokio::test]
async fn workspace_patch_updates_one_existing_lf_file_and_returns_review_diff() {
    let workspace = tempdir().expect("workspace");
    fs::write(
        workspace.path().join("notes.txt"),
        "one\ntwo\nthree\nfour\n",
    )
    .expect("seed file");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            workspace.path().join("notes.txt"),
            fs::Permissions::from_mode(0o640),
        )
        .expect("fixture permissions");
    }
    let tool = WorkspaceTool::open(workspace.path()).expect("open workspace");
    let prepared = tool
        .prepare_patch(
            &WorkspacePatchArguments {
                path: "notes.txt".to_string(),
                base_sha256: None,
                diff: "--- a/notes.txt\n+++ b/notes.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+second\n three\n".to_string(),
            },
            &cancellation(),
        )
        .await;
    let WorkspacePatchPrepareOutcome::Prepared(prepared) = prepared else {
        panic!("expected prepared patch, got {prepared:?}");
    };
    assert_eq!(prepared.path(), "notes.txt");
    assert_eq!(prepared.newline(), WorkspaceNewlineStyle::Lf);
    assert!(prepared.final_newline());
    assert_eq!(
        prepared.diff(),
        "--- a/notes.txt\n+++ b/notes.txt\n@@ -1,4 +1,4 @@\n one\n-two\n+second\n three\n four\n"
    );
    let outcome = tool.commit_patch(*prepared, &cancellation()).await;
    assert!(matches!(
        outcome,
        WorkspacePatchCommitOutcome::Applied { .. }
    ));
    assert_eq!(
        fs::read_to_string(workspace.path().join("notes.txt")).expect("updated file"),
        "one\nsecond\nthree\nfour\n"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(workspace.path().join("notes.txt"))
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777,
            0o640
        );
    }
}

#[tokio::test]
async fn workspace_patch_preserves_crlf_and_missing_final_newline() {
    let workspace = tempdir().expect("workspace");
    fs::write(workspace.path().join("notes.txt"), b"one\r\ntwo").expect("seed file");
    let tool = WorkspaceTool::open(workspace.path()).expect("open workspace");
    let WorkspacePatchPrepareOutcome::Prepared(prepared) = tool
        .prepare_patch(
            &WorkspacePatchArguments {
                path: "notes.txt".to_string(),
                base_sha256: None,
                diff: "--- a/notes.txt\n+++ b/notes.txt\n@@ -2,1 +2,1 @@\n-two\n+second\n"
                    .to_string(),
            },
            &cancellation(),
        )
        .await
    else {
        panic!("prepare patch");
    };
    assert_eq!(prepared.newline(), WorkspaceNewlineStyle::CrLf);
    assert!(!prepared.final_newline());
    let outcome = tool.commit_patch(*prepared, &cancellation()).await;
    assert!(matches!(
        outcome,
        WorkspacePatchCommitOutcome::Applied { .. }
    ));
    assert_eq!(
        fs::read(workspace.path().join("notes.txt")).expect("updated file"),
        b"one\r\nsecond"
    );
}

#[tokio::test]
async fn workspace_patch_detects_conflict_between_proposal_and_commit() {
    let workspace = tempdir().expect("workspace");
    let target = workspace.path().join("notes.txt");
    fs::write(&target, "one\ntwo\n").expect("seed file");
    let tool = WorkspaceTool::open(workspace.path()).expect("open workspace");
    let WorkspacePatchPrepareOutcome::Prepared(prepared) = tool
        .prepare_patch(
            &WorkspacePatchArguments {
                path: "notes.txt".to_string(),
                base_sha256: None,
                diff: "--- a/notes.txt\n+++ b/notes.txt\n@@ -2,1 +2,1 @@\n-two\n+second\n"
                    .to_string(),
            },
            &cancellation(),
        )
        .await
    else {
        panic!("prepare patch");
    };
    fs::write(&target, "one\nexternal\n").expect("conflicting write");
    assert_eq!(
        tool.commit_patch(*prepared, &cancellation()).await,
        WorkspacePatchCommitOutcome::Error {
            kind: WorkspacePatchErrorKind::Conflict
        }
    );
    assert_eq!(
        fs::read_to_string(target).expect("target"),
        "one\nexternal\n"
    );
}

#[test]
fn workspace_patch_reconciliation_distinguishes_before_after_and_other_content() {
    let workspace = tempdir().expect("workspace");
    let target = workspace.path().join("notes.txt");
    let root = WorkspaceTool::open(workspace.path()).expect("open workspace");
    let parent = root.root.try_clone().expect("clone root");
    let before = b"before\n";
    let after = b"after\n";

    fs::write(&target, before).expect("write before");
    assert_eq!(
        target_state(
            &parent,
            Path::new("notes.txt"),
            &sha256(before),
            before.len() as u64,
            &sha256(after),
            after.len() as u64,
        ),
        Ok(TargetState::Before)
    );

    fs::write(&target, after).expect("write after");
    assert_eq!(
        target_state(
            &parent,
            Path::new("notes.txt"),
            &sha256(before),
            before.len() as u64,
            &sha256(after),
            after.len() as u64,
        ),
        Ok(TargetState::After)
    );

    fs::write(&target, b"other\n").expect("write other");
    assert_eq!(
        target_state(
            &parent,
            Path::new("notes.txt"),
            &sha256(before),
            before.len() as u64,
            &sha256(after),
            after.len() as u64,
        ),
        Ok(TargetState::Other)
    );
}

#[tokio::test]
async fn workspace_patch_rejects_oversized_patch_and_original_before_writing() {
    let workspace = tempdir().expect("workspace");
    let target = workspace.path().join("notes.txt");
    fs::write(&target, "one\n").expect("seed file");
    let tool = WorkspaceTool::open(workspace.path()).expect("open workspace");
    let oversized_patch = tool
        .prepare_patch(
            &WorkspacePatchArguments {
                path: "notes.txt".to_string(),
                base_sha256: None,
                diff: "x".repeat(MAX_WORKSPACE_PATCH_BYTES + 1),
            },
            &cancellation(),
        )
        .await;
    assert!(matches!(
        oversized_patch,
        WorkspacePatchPrepareOutcome::Error {
            kind: WorkspacePatchErrorKind::UnsupportedDiffFeature
        }
    ));
    assert_eq!(
        fs::read_to_string(&target).expect("unchanged file"),
        "one\n"
    );

    fs::write(&target, vec![b'x'; crate::MAX_WORKSPACE_READ_BYTES + 1])
        .expect("oversized original");
    let oversized_original = tool
        .prepare_patch(
            &WorkspacePatchArguments {
                path: "notes.txt".to_string(),
                base_sha256: None,
                diff: "--- a/notes.txt\n+++ b/notes.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n".to_string(),
            },
            &cancellation(),
        )
        .await;
    assert!(matches!(
        oversized_original,
        WorkspacePatchPrepareOutcome::Error {
            kind: WorkspacePatchErrorKind::FileTooLarge
        }
    ));
}

#[tokio::test]
async fn workspace_patch_rejects_mixed_newlines_and_non_applying_hunks() {
    let workspace = tempdir().expect("workspace");
    fs::write(workspace.path().join("mixed.txt"), b"one\r\ntwo\n").expect("seed file");
    fs::write(workspace.path().join("clean.txt"), b"one\ntwo\n").expect("seed file");
    let tool = WorkspaceTool::open(workspace.path()).expect("open workspace");
    let mixed = tool
        .prepare_patch(
            &WorkspacePatchArguments {
                path: "mixed.txt".to_string(),
                base_sha256: None,
                diff: "--- a/notes.txt\n+++ b/notes.txt\n@@ -1,1 +1,1 @@\n-one\n+first\n"
                    .to_string(),
            },
            &cancellation(),
        )
        .await;
    assert!(matches!(
        mixed,
        WorkspacePatchPrepareOutcome::Error {
            kind: WorkspacePatchErrorKind::InvalidNewline
        }
    ));
    let mismatch = tool
        .prepare_patch(
            &WorkspacePatchArguments {
                path: "clean.txt".to_string(),
                base_sha256: None,
                diff: "--- a/notes.txt\n+++ b/notes.txt\n@@ -2,1 +2,1 @@\n-other\n+second\n"
                    .to_string(),
            },
            &cancellation(),
        )
        .await;
    assert!(matches!(
        mismatch,
        WorkspacePatchPrepareOutcome::ValidationRejected {
            kind: WorkspacePatchErrorKind::ExpectedMismatch,
            diagnostic: WorkspaceEditDiagnostic {
                hunk_index: Some(1),
                line: Some(2),
                expected_summary: Some(_),
                actual_summary: Some(_),
                ..
            }
        }
    ));
}

#[cfg(any(unix, windows))]
#[tokio::test]
async fn workspace_patch_rejects_hard_link_targets() {
    let workspace = tempdir().expect("workspace");
    let target = workspace.path().join("notes.txt");
    fs::write(&target, "one\n").expect("seed file");
    fs::hard_link(&target, workspace.path().join("alias.txt")).expect("hard link");
    let tool = WorkspaceTool::open(workspace.path()).expect("open workspace");
    let outcome = tool
        .prepare_patch(
            &WorkspacePatchArguments {
                path: "notes.txt".to_string(),
                base_sha256: None,
                diff: "--- a/notes.txt\n+++ b/notes.txt\n@@ -1,1 +1,1 @@\n-one\n+first\n"
                    .to_string(),
            },
            &cancellation(),
        )
        .await;
    assert!(matches!(
        outcome,
        WorkspacePatchPrepareOutcome::Error {
            kind: WorkspacePatchErrorKind::HardLinkNotAllowed
        }
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn workspace_patch_rejects_symlinked_parent_components() {
    use std::os::unix::fs::symlink;
    let workspace = tempdir().expect("workspace");
    fs::create_dir(workspace.path().join("real")).expect("real directory");
    fs::write(workspace.path().join("real/notes.txt"), "one\n").expect("seed file");
    symlink("real", workspace.path().join("linked")).expect("symlink");
    let tool = WorkspaceTool::open(workspace.path()).expect("open workspace");
    let outcome = tool
        .prepare_patch(
            &WorkspacePatchArguments {
                path: "linked/notes.txt".to_string(),
                base_sha256: None,
                diff: "--- a/notes.txt\n+++ b/notes.txt\n@@ -1,1 +1,1 @@\n-one\n+first\n"
                    .to_string(),
            },
            &cancellation(),
        )
        .await;
    assert!(matches!(
        outcome,
        WorkspacePatchPrepareOutcome::Error {
            kind: WorkspacePatchErrorKind::PathNotAllowed
        }
    ));
}

#[cfg(windows)]
#[tokio::test]
async fn workspace_patch_rejects_junction_parent_components() {
    let workspace = tempdir().expect("workspace");
    fs::create_dir(workspace.path().join("real")).expect("real directory");
    fs::write(workspace.path().join("real/notes.txt"), "one\n").expect("seed file");
    let status = std::process::Command::new("cmd.exe")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(workspace.path().join("linked"))
        .arg(workspace.path().join("real"))
        .status()
        .expect("create junction");
    assert!(status.success(), "create junction fixture");
    let tool = WorkspaceTool::open(workspace.path()).expect("open workspace");
    let outcome = tool
        .prepare_patch(
            &WorkspacePatchArguments {
                path: "linked/notes.txt".to_string(),
                base_sha256: None,
                diff: "--- a/notes.txt\n+++ b/notes.txt\n@@ -1,1 +1,1 @@\n-one\n+first\n"
                    .to_string(),
            },
            &cancellation(),
        )
        .await;
    assert!(matches!(
        outcome,
        WorkspacePatchPrepareOutcome::Error {
            kind: WorkspacePatchErrorKind::PathNotAllowed
        }
    ));
}
