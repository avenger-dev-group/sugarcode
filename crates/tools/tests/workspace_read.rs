use std::fs;
use sugarcode_tools::MAX_WORKSPACE_READ_BYTES;
use sugarcode_tools::WorkspaceReadArguments;
use sugarcode_tools::WorkspaceReadErrorKind;
use sugarcode_tools::WorkspaceReadOutcome;
use sugarcode_tools::WorkspaceTool;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn reads_one_bounded_utf8_regular_file() {
    let workspace = tempfile::tempdir().expect("workspace");
    fs::create_dir(workspace.path().join("src")).expect("src");
    fs::write(workspace.path().join("src/lib.rs"), "pub fn sugar() {}\n").expect("file");
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");
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
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");
    for (path, expected) in [
        ("../secret", WorkspaceReadErrorKind::InvalidPath),
        ("/etc/passwd", WorkspaceReadErrorKind::InvalidPath),
        ("src/./lib.rs", WorkspaceReadErrorKind::InvalidPath),
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
    symlink(
        outside.path().join("secret"),
        workspace.path().join("linked-file"),
    )
    .expect("file symlink");
    symlink("loop", workspace.path().join("loop")).expect("loop");
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");
    for path in ["linked/secret", "linked-file", "loop"] {
        assert_eq!(
            tool.read(
                &WorkspaceReadArguments {
                    path: path.to_string(),
                },
                &CancellationToken::new(),
            )
            .await,
            WorkspaceReadOutcome::Error {
                kind: WorkspaceReadErrorKind::PathNotAllowed
            }
        );
    }
    let linked_roots = tempfile::tempdir().expect("linked roots");
    let linked_root = linked_roots.path().join("linked-root");
    symlink(workspace.path(), &linked_root).expect("root symlink");
    assert_eq!(
        WorkspaceTool::open(&linked_root).expect_err("reject root symlink"),
        WorkspaceReadErrorKind::PathNotAllowed
    );
}

#[cfg(unix)]
#[tokio::test]
async fn rejects_fifo_socket_and_permission_denied_without_blocking() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;

    let workspace = tempfile::tempdir().expect("workspace");
    let fifo = workspace.path().join("fifo");
    let fifo_path = CString::new(fifo.as_os_str().as_bytes()).expect("fifo path");
    // SAFETY: fifo_path is a valid, NUL-terminated path owned for the duration
    // of the call.
    assert_eq!(unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) }, 0);
    let socket = workspace.path().join("socket");
    let _listener = UnixListener::bind(&socket).expect("socket");
    let denied = workspace.path().join("denied");
    fs::write(&denied, "secret").expect("denied file");
    fs::set_permissions(&denied, fs::Permissions::from_mode(0o000)).expect("permissions");
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");
    for path in ["fifo", "socket"] {
        assert_eq!(
            tool.read(
                &WorkspaceReadArguments {
                    path: path.to_string(),
                },
                &CancellationToken::new(),
            )
            .await,
            WorkspaceReadOutcome::Error {
                kind: WorkspaceReadErrorKind::NotRegularFile
            }
        );
    }
    let denied_outcome = tool
        .read(
            &WorkspaceReadArguments {
                path: "denied".to_string(),
            },
            &CancellationToken::new(),
        )
        .await;
    fs::set_permissions(&denied, fs::Permissions::from_mode(0o600)).expect("restore");
    assert_eq!(
        denied_outcome,
        WorkspaceReadOutcome::Error {
            kind: WorkspaceReadErrorKind::AccessDenied
        }
    );
}

#[cfg(windows)]
#[tokio::test]
async fn rejects_windows_prefixes_and_reparse_points() {
    use std::os::windows::fs::symlink_dir;
    use std::os::windows::fs::symlink_file;
    use std::process::Command;

    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    fs::write(outside.path().join("secret"), "outside").expect("secret");
    symlink_dir(outside.path(), workspace.path().join("linked")).expect("directory reparse");
    symlink_file(
        outside.path().join("secret"),
        workspace.path().join("linked-file"),
    )
    .expect("file reparse");
    let junction = workspace.path().join("junction");
    let junction_output = Command::new("cmd")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(&junction)
        .arg(outside.path())
        .output()
        .expect("create junction");
    assert!(
        junction_output.status.success(),
        "junction creation failed: {}",
        String::from_utf8_lossy(&junction_output.stderr)
    );
    let root_junctions = tempfile::tempdir().expect("root junctions");
    let root_junction = root_junctions.path().join("workspace-root");
    let root_junction_output = Command::new("cmd")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(&root_junction)
        .arg(workspace.path())
        .output()
        .expect("create root junction");
    assert!(
        root_junction_output.status.success(),
        "root junction creation failed: {}",
        String::from_utf8_lossy(&root_junction_output.stderr)
    );
    assert_eq!(
        WorkspaceTool::open(&root_junction).expect_err("reject root junction"),
        WorkspaceReadErrorKind::PathNotAllowed
    );
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");
    for path in [
        r"C:\Windows\System32\drivers\etc\hosts",
        r"\\server\share\secret",
        r"\\?\C:\secret",
    ] {
        assert_eq!(
            tool.read(
                &WorkspaceReadArguments {
                    path: path.to_string(),
                },
                &CancellationToken::new(),
            )
            .await,
            WorkspaceReadOutcome::Error {
                kind: WorkspaceReadErrorKind::InvalidPath
            }
        );
    }
    for path in ["linked/secret", "linked-file", "junction/secret"] {
        assert_eq!(
            tool.read(
                &WorkspaceReadArguments {
                    path: path.to_string(),
                },
                &CancellationToken::new(),
            )
            .await,
            WorkspaceReadOutcome::Error {
                kind: WorkspaceReadErrorKind::PathNotAllowed
            }
        );
    }
}
