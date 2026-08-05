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
async fn workspace_freeform_patch_commits_one_atomic_multi_file_change_set() {
    let workspace = tempdir().expect("workspace");
    fs::write(workspace.path().join("notes.txt"), "one\ntwo\n").expect("seed update");
    fs::write(workspace.path().join("stale.txt"), "remove\n").expect("seed delete");
    let tool = WorkspaceTool::open(workspace.path()).expect("open workspace");
    let patch = concat!(
        "*** Begin Patch\n",
        "*** Add File: added.txt\n",
        "+created\n",
        "*** Update File: notes.txt\n",
        "@@\n",
        " one\n",
        "-two\n",
        "+second\n",
        "*** Delete File: stale.txt\n",
        "*** End Patch",
    );

    let WorkspaceChangeSetPrepareOutcome::Prepared(prepared) =
        tool.prepare_freeform_patch(patch, &cancellation()).await
    else {
        panic!("prepare freeform patch");
    };
    assert_eq!(prepared.changes().len(), 3);
    assert!(matches!(
        tool.commit_change_set(prepared, &cancellation()).await,
        WorkspaceChangeSetCommitOutcome::Applied { receipts } if receipts.len() == 3
    ));
    assert_eq!(
        fs::read_to_string(workspace.path().join("added.txt")).expect("added file"),
        "created\n"
    );
    assert_eq!(
        fs::read_to_string(workspace.path().join("notes.txt")).expect("updated file"),
        "one\nsecond\n"
    );
    assert!(!workspace.path().join("stale.txt").exists());
}

#[tokio::test]
async fn workspace_freeform_patch_rejects_stale_context_without_mutation() {
    let workspace = tempdir().expect("workspace");
    fs::write(workspace.path().join("notes.txt"), "actual\n").expect("seed file");
    let tool = WorkspaceTool::open(workspace.path()).expect("open workspace");
    let outcome = tool
        .prepare_freeform_patch(
            concat!(
                "*** Begin Patch\n",
                "*** Update File: notes.txt\n",
                "@@\n",
                "-expected\n",
                "+replacement\n",
                "*** End Patch",
            ),
            &cancellation(),
        )
        .await;

    assert!(matches!(
        outcome,
        WorkspaceChangeSetPrepareOutcome::ValidationRejected {
            kind: WorkspacePatchErrorKind::ExpectedMismatch,
            diagnostic: WorkspaceEditDiagnostic { suggested_action, .. },
            ..
        } if suggested_action == "readFileAndRebase"
    ));
    assert_eq!(
        fs::read_to_string(workspace.path().join("notes.txt")).expect("unchanged file"),
        "actual\n"
    );
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

#[tokio::test]
async fn workspace_change_set_atomically_creates_updates_and_deletes() {
    let workspace = tempdir().expect("workspace");
    let update_before = b"old\n";
    let delete_before = b"remove\n";
    fs::write(workspace.path().join("update.txt"), update_before).expect("update fixture");
    fs::write(workspace.path().join("delete.txt"), delete_before).expect("delete fixture");
    let tool = WorkspaceTool::open(workspace.path()).expect("open workspace");
    let arguments = WorkspaceChangeSetArguments {
        operations: vec![
            WorkspaceChangeSetOperation::Create {
                path: "create.txt".to_string(),
                content: "created\n".to_string(),
            },
            WorkspaceChangeSetOperation::Update(edit(
                "update.txt",
                update_before,
                vec![WorkspaceLineEdit {
                    start_line: 1,
                    delete_line_count: 1,
                    expected: "old".to_string(),
                    replacement: "new".to_string(),
                }],
            )),
            WorkspaceChangeSetOperation::Delete {
                path: "delete.txt".to_string(),
                base_sha256: sha256(delete_before),
            },
        ],
    };
    let outcome = tool.prepare_change_set(&arguments, &cancellation()).await;
    let WorkspaceChangeSetPrepareOutcome::Prepared(prepared) = outcome else {
        panic!("prepare change set: {outcome:?}");
    };
    assert_eq!(prepared.changes().len(), 3);
    assert_eq!(
        prepared.changes()[0].kind(),
        WorkspaceFileChangeKind::Create
    );
    assert!(
        prepared.changes()[0]
            .diff()
            .starts_with("--- /dev/null\n+++ b/create.txt\n")
    );
    assert_eq!(
        prepared.changes()[2].kind(),
        WorkspaceFileChangeKind::Delete
    );
    assert!(
        prepared.changes()[2]
            .diff()
            .starts_with("--- a/delete.txt\n+++ /dev/null\n")
    );
    let WorkspaceChangeSetCommitOutcome::Applied { receipts } =
        tool.commit_change_set(prepared, &cancellation()).await
    else {
        panic!("commit change set");
    };
    assert_eq!(receipts.len(), 3);
    assert_eq!(
        fs::read(workspace.path().join("create.txt")).expect("created"),
        b"created\n"
    );
    assert_eq!(
        fs::read(workspace.path().join("update.txt")).expect("updated"),
        b"new\n"
    );
    assert!(!workspace.path().join("delete.txt").exists());
    assert!(!workspace.path().join(CHANGE_SET_WAL).exists());
}

#[tokio::test]
async fn workspace_change_set_conflict_prevents_every_file_change() {
    let workspace = tempdir().expect("workspace");
    let update_before = b"old\n";
    let delete_before = b"remove\n";
    fs::write(workspace.path().join("update.txt"), update_before).expect("update fixture");
    fs::write(workspace.path().join("delete.txt"), delete_before).expect("delete fixture");
    let tool = WorkspaceTool::open(workspace.path()).expect("open workspace");
    let arguments = WorkspaceChangeSetArguments {
        operations: vec![
            WorkspaceChangeSetOperation::Create {
                path: "create.txt".to_string(),
                content: "created\n".to_string(),
            },
            WorkspaceChangeSetOperation::Update(edit(
                "update.txt",
                update_before,
                vec![WorkspaceLineEdit {
                    start_line: 1,
                    delete_line_count: 1,
                    expected: "old".to_string(),
                    replacement: "new".to_string(),
                }],
            )),
            WorkspaceChangeSetOperation::Delete {
                path: "delete.txt".to_string(),
                base_sha256: sha256(delete_before),
            },
        ],
    };
    let outcome = tool.prepare_change_set(&arguments, &cancellation()).await;
    let WorkspaceChangeSetPrepareOutcome::Prepared(prepared) = outcome else {
        panic!("prepare change set: {outcome:?}");
    };
    fs::write(workspace.path().join("update.txt"), b"external\n").expect("create conflict");
    assert!(matches!(
        tool.commit_change_set(prepared, &cancellation()).await,
        WorkspaceChangeSetCommitOutcome::Error {
            kind: WorkspacePatchErrorKind::Conflict
        }
    ));
    assert!(!workspace.path().join("create.txt").exists());
    assert_eq!(
        fs::read(workspace.path().join("delete.txt")).expect("not deleted"),
        delete_before
    );
    assert_eq!(
        fs::read(workspace.path().join("update.txt")).expect("external kept"),
        b"external\n"
    );
    assert!(!workspace.path().join(CHANGE_SET_WAL).exists());
}

#[test]
fn workspace_change_set_open_recovers_a_partially_applied_wal() {
    let workspace = tempdir().expect("workspace");
    let first_before = b"first-before\n";
    let first_after = b"first-after\n";
    let second_before = b"second-before\n";
    let second_after = b"second-after\n";
    fs::write(workspace.path().join("first.txt"), first_after).expect("applied first file");
    fs::write(workspace.path().join("second.txt"), second_before).expect("unapplied second file");
    let rollback_temp = ".sugarcode-workspace-write-recovery.tmp";
    fs::write(workspace.path().join(rollback_temp), first_before).expect("rollback temp");
    let wal = ChangeSetWal {
        version: 1,
        changes: vec![
            ChangeSetWalEntry {
                path: "first.txt".to_string(),
                kind: "update".to_string(),
                before_sha256: sha256(first_before),
                after_sha256: sha256(first_after),
                before_bytes: first_before.len() as u64,
                after_bytes: first_after.len() as u64,
                forward_temp: None,
                rollback_temp: Some(rollback_temp.to_string()),
            },
            ChangeSetWalEntry {
                path: "second.txt".to_string(),
                kind: "update".to_string(),
                before_sha256: sha256(second_before),
                after_sha256: sha256(second_after),
                before_bytes: second_before.len() as u64,
                after_bytes: second_after.len() as u64,
                forward_temp: None,
                rollback_temp: None,
            },
        ],
    };
    fs::write(
        workspace.path().join(CHANGE_SET_WAL),
        serde_json::to_vec(&wal).expect("serialize WAL"),
    )
    .expect("write WAL");

    let _tool = WorkspaceTool::open(workspace.path()).expect("recover workspace");
    assert_eq!(
        fs::read(workspace.path().join("first.txt")).expect("first restored"),
        first_before
    );
    assert_eq!(
        fs::read(workspace.path().join("second.txt")).expect("second unchanged"),
        second_before
    );
    assert!(!workspace.path().join(rollback_temp).exists());
    assert!(!workspace.path().join(CHANGE_SET_WAL).exists());
}
