use std::fs;
use sugarcode_tools::MAX_WORKSPACE_READ_BYTES;
use sugarcode_tools::WorkspaceReadArguments;
use sugarcode_tools::WorkspaceReadErrorKind;
use sugarcode_tools::WorkspaceReadOutcome;
use sugarcode_tools::WorkspaceReadTool;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn reads_one_bounded_utf8_regular_file() {
    let workspace = tempfile::tempdir().expect("workspace");
    fs::create_dir(workspace.path().join("src")).expect("src");
    fs::write(workspace.path().join("src/lib.rs"), "pub fn sugar() {}\n").expect("file");
    let tool = WorkspaceReadTool::open(workspace.path()).expect("tool");
    let outcome = tool
        .read(
            &WorkspaceReadArguments {
                path: "src/lib.rs".to_string(),
            },
            &CancellationToken::new(),
        )
        .await;
    assert_eq!(
        outcome,
        WorkspaceReadOutcome::Content {
            content: "pub fn sugar() {}\n".to_string(),
            bytes: 18,
        }
    );
}

#[tokio::test]
async fn rejects_escape_binary_directory_oversize_and_cancelled_reads() {
    let workspace = tempfile::tempdir().expect("workspace");
    fs::write(workspace.path().join("binary"), [0, 1, 2]).expect("binary");
    fs::write(
        workspace.path().join("large"),
        vec![b'x'; MAX_WORKSPACE_READ_BYTES + 1],
    )
    .expect("large");
    let tool = WorkspaceReadTool::open(workspace.path()).expect("tool");
    for (path, expected) in [
        ("../secret", WorkspaceReadErrorKind::InvalidPath),
        ("/etc/passwd", WorkspaceReadErrorKind::InvalidPath),
        ("binary", WorkspaceReadErrorKind::BinaryFile),
        (".", WorkspaceReadErrorKind::InvalidPath),
        ("large", WorkspaceReadErrorKind::FileTooLarge),
    ] {
        assert_eq!(
            tool.read(
                &WorkspaceReadArguments {
                    path: path.to_string(),
                },
                &CancellationToken::new(),
            )
            .await,
            WorkspaceReadOutcome::Error { kind: expected }
        );
    }
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    assert_eq!(
        tool.read(
            &WorkspaceReadArguments {
                path: "binary".to_string(),
            },
            &cancellation,
        )
        .await,
        WorkspaceReadOutcome::Error {
            kind: WorkspaceReadErrorKind::Cancelled
        }
    );
}

#[cfg(unix)]
#[tokio::test]
async fn rejects_symlink_components_without_following_them() {
    use std::os::unix::fs::symlink;

    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    fs::write(outside.path().join("secret"), "outside").expect("secret");
    symlink(outside.path(), workspace.path().join("linked")).expect("symlink");
    let tool = WorkspaceReadTool::open(workspace.path()).expect("tool");
    assert_eq!(
        tool.read(
            &WorkspaceReadArguments {
                path: "linked/secret".to_string(),
            },
            &CancellationToken::new(),
        )
        .await,
        WorkspaceReadOutcome::Error {
            kind: WorkspaceReadErrorKind::PathNotAllowed
        }
    );
}
