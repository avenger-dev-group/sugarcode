use super::*;
use std::fs;

#[tokio::test]
async fn detects_directory_changes_before_returning_entries() {
    let workspace = tempfile::tempdir().expect("workspace");
    fs::create_dir(workspace.path().join("target")).expect("target");
    fs::write(workspace.path().join("target/original"), "original").expect("file");
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");
    let outcome = tool
        .list_with_before_identity_check(
            &WorkspaceListArguments {
                path: "target".to_string(),
            },
            &CancellationToken::new(),
            || {
                fs::write(workspace.path().join("target/added"), "added").expect("added");
            },
        )
        .await;
    assert_eq!(
        outcome,
        WorkspaceListOutcome::Error {
            kind: WorkspaceListErrorKind::ChangedDuringList
        }
    );
}

#[tokio::test]
#[cfg(not(windows))]
async fn detects_target_directory_replacement() {
    let workspace = tempfile::tempdir().expect("workspace");
    fs::create_dir(workspace.path().join("target")).expect("target");
    fs::write(workspace.path().join("target/original"), "original").expect("file");
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");
    let outcome = tool
        .list_with_before_identity_check(
            &WorkspaceListArguments {
                path: "target".to_string(),
            },
            &CancellationToken::new(),
            || {
                fs::rename(
                    workspace.path().join("target"),
                    workspace.path().join("previous"),
                )
                .expect("move target");
                fs::create_dir(workspace.path().join("target")).expect("replacement");
            },
        )
        .await;
    assert_eq!(
        outcome,
        WorkspaceListOutcome::Error {
            kind: WorkspaceListErrorKind::ChangedDuringList
        }
    );
}

#[tokio::test]
#[cfg(windows)]
async fn windows_directory_handle_prevents_target_replacement() {
    let workspace = tempfile::tempdir().expect("workspace");
    fs::create_dir(workspace.path().join("target")).expect("target");
    fs::write(workspace.path().join("target/original"), "original").expect("file");
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");
    let outcome = tool
        .list_with_before_identity_check(
            &WorkspaceListArguments {
                path: "target".to_string(),
            },
            &CancellationToken::new(),
            || {
                fs::rename(
                    workspace.path().join("target"),
                    workspace.path().join("previous"),
                )
                .expect_err("the open directory handle must prevent replacement");
            },
        )
        .await;
    assert_eq!(
        outcome,
        WorkspaceListOutcome::Entries {
            entries: vec![WorkspaceListEntry {
                name: "original".to_string(),
                kind: WorkspaceListEntryKind::File,
            }],
            name_bytes: "original".len(),
        }
    );
}
