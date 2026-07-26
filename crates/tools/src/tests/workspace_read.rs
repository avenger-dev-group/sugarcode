use super::*;
use std::fs;

#[tokio::test]
async fn detects_final_path_replacement_without_reading_the_replacement() {
    let workspace = tempfile::tempdir().expect("workspace");
    let path = workspace.path().join("file");
    fs::write(&path, "original").expect("original");
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");
    let outcome = tool
        .read_with_before_identity_check(
            &WorkspaceReadArguments {
                path: "file".to_string(),
            },
            &CancellationToken::new(),
            || {
                let replacement = workspace.path().join("replacement");
                fs::write(&replacement, "replacement").expect("replacement");
                fs::rename(replacement, &path).expect("replace");
            },
        )
        .await;
    assert_eq!(
        outcome,
        WorkspaceReadOutcome::Error {
            kind: WorkspaceReadErrorKind::ChangedDuringRead
        }
    );
}

#[cfg(unix)]
#[tokio::test]
async fn detects_same_inode_same_length_rewrite_with_restored_mtime() {
    let workspace = tempfile::tempdir().expect("workspace");
    let path = workspace.path().join("file");
    fs::write(&path, "original").expect("original");
    let original_modified = fs::metadata(&path)
        .expect("original metadata")
        .modified()
        .expect("original modified");
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");
    let outcome = tool
        .read_with_before_identity_check(
            &WorkspaceReadArguments {
                path: "file".to_string(),
            },
            &CancellationToken::new(),
            || {
                fs::write(&path, "mutated!").expect("same-length rewrite");
                let file = fs::OpenOptions::new()
                    .write(true)
                    .open(&path)
                    .expect("rewrite handle");
                file.set_times(fs::FileTimes::new().set_modified(original_modified))
                    .expect("restore modified time");
            },
        )
        .await;
    assert_eq!(
        outcome,
        WorkspaceReadOutcome::Error {
            kind: WorkspaceReadErrorKind::ChangedDuringRead
        }
    );
}
