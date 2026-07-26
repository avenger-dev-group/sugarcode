use super::*;
use std::fs;
use tempfile::tempdir;

fn cancellation() -> CancellationToken {
    CancellationToken::new()
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
                patch: "@@ -1,3 +1,3 @@\n one\n-two\n+second\n three\n".to_string(),
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
                patch: "@@ -2,1 +2,1 @@\n-two\n+second\n".to_string(),
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
                patch: "@@ -2,1 +2,1 @@\n-two\n+second\n".to_string(),
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
                patch: "@@ -1,1 +1,1 @@\n-one\n+first\n".to_string(),
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
                patch: "@@ -2,1 +2,1 @@\n-other\n+second\n".to_string(),
            },
            &cancellation(),
        )
        .await;
    assert!(matches!(
        mismatch,
        WorkspacePatchPrepareOutcome::Error {
            kind: WorkspacePatchErrorKind::PatchDoesNotApply
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
                patch: "@@ -1,1 +1,1 @@\n-one\n+first\n".to_string(),
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
                patch: "@@ -1,1 +1,1 @@\n-one\n+first\n".to_string(),
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
                patch: "@@ -1,1 +1,1 @@\n-one\n+first\n".to_string(),
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
