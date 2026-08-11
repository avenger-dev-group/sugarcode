use std::fs;
use sugarcode_tools::MAX_WORKSPACE_LIST_ENTRIES;
use sugarcode_tools::WorkspaceListArguments;
use sugarcode_tools::WorkspaceListEntry;
use sugarcode_tools::WorkspaceListEntryKind;
use sugarcode_tools::WorkspaceListErrorKind;
use sugarcode_tools::WorkspaceListOutcome;
use sugarcode_tools::WorkspaceRecursiveListEntry;
use sugarcode_tools::WorkspaceRecursiveListOutcome;
use sugarcode_tools::WorkspaceTool;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn lists_one_directory_non_recursively_in_utf8_byte_order() {
    let workspace = tempfile::tempdir().expect("workspace");
    fs::create_dir(workspace.path().join("src")).expect("src");
    fs::create_dir(workspace.path().join("src/nested")).expect("nested");
    fs::write(workspace.path().join("src/zeta"), "z").expect("zeta");
    fs::write(workspace.path().join("src/Alpha"), "a").expect("alpha");
    fs::write(workspace.path().join("src/éclair"), "e").expect("unicode");
    fs::write(workspace.path().join("src/nested/hidden"), "hidden").expect("hidden");
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");

    assert_eq!(
        tool.list(
            &WorkspaceListArguments {
                path: "src".to_string(),
            },
            &CancellationToken::new(),
        )
        .await,
        WorkspaceListOutcome::Entries {
            entries: vec![
                WorkspaceListEntry {
                    name: "Alpha".to_string(),
                    kind: WorkspaceListEntryKind::File,
                },
                WorkspaceListEntry {
                    name: "nested".to_string(),
                    kind: WorkspaceListEntryKind::Directory,
                },
                WorkspaceListEntry {
                    name: "zeta".to_string(),
                    kind: WorkspaceListEntryKind::File,
                },
                WorkspaceListEntry {
                    name: "éclair".to_string(),
                    kind: WorkspaceListEntryKind::File,
                },
            ],
            name_bytes: 22,
        }
    );
}

#[tokio::test]
async fn recursively_lists_relative_paths_in_stable_order() {
    let workspace = tempfile::tempdir().expect("workspace");
    fs::create_dir_all(workspace.path().join("src/nested")).expect("nested");
    fs::write(workspace.path().join("src/zeta.rs"), "z").expect("zeta");
    fs::write(workspace.path().join("src/nested/Alpha.rs"), "a").expect("alpha");
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");

    assert_eq!(
        tool.list_recursive(
            &WorkspaceListArguments {
                path: "src".to_string(),
            },
            &CancellationToken::new(),
        )
        .await,
        WorkspaceRecursiveListOutcome::Entries {
            entries: vec![
                WorkspaceRecursiveListEntry {
                    path: "src/nested".to_string(),
                    name: "nested".to_string(),
                    kind: WorkspaceListEntryKind::Directory,
                },
                WorkspaceRecursiveListEntry {
                    path: "src/nested/Alpha.rs".to_string(),
                    name: "Alpha.rs".to_string(),
                    kind: WorkspaceListEntryKind::File,
                },
                WorkspaceRecursiveListEntry {
                    path: "src/zeta.rs".to_string(),
                    name: "zeta.rs".to_string(),
                    kind: WorkspaceListEntryKind::File,
                },
            ],
            scanned: 3,
            truncated: false,
        }
    );
}

#[tokio::test]
async fn recursive_listing_skips_noise_directories_and_transient_files() {
    let workspace = tempfile::tempdir().expect("workspace");
    for directory in [
        ".git/objects",
        "node_modules/pkg",
        "vendor/pkg",
        "dist/assets",
        "storage/logs/archive",
        "src/nested",
    ] {
        fs::create_dir_all(workspace.path().join(directory)).expect("fixture directory");
    }
    fs::write(workspace.path().join(".git/objects/ignored"), "git").expect("git fixture");
    fs::write(
        workspace.path().join("node_modules/pkg/ignored.js"),
        "module",
    )
    .expect("module fixture");
    fs::write(workspace.path().join("dist/assets/ignored.js"), "dist").expect("dist fixture");
    fs::write(workspace.path().join("vendor/pkg/ignored.php"), "vendor").expect("vendor fixture");
    fs::write(
        workspace.path().join("storage/logs/archive/ignored.log"),
        "runtime log",
    )
    .expect("log fixture");
    fs::write(workspace.path().join("src/nested/included.rs"), "source").expect("source fixture");
    fs::write(workspace.path().join("src/scratch.tmp"), "temporary").expect("temporary fixture");
    fs::write(workspace.path().join("src/bundle.min.js"), "generated").expect("minified fixture");
    fs::write(workspace.path().join("src/source.js.map"), "source map").expect("map fixture");
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");

    let WorkspaceRecursiveListOutcome::Entries { entries, .. } = tool
        .list_recursive(
            &WorkspaceListArguments {
                path: ".".to_string(),
            },
            &CancellationToken::new(),
        )
        .await
    else {
        panic!("recursive listing");
    };
    let paths = entries
        .iter()
        .map(|entry| entry.path.as_str())
        .collect::<Vec<_>>();
    assert!(paths.contains(&".git"));
    assert!(paths.contains(&"node_modules"));
    assert!(paths.contains(&"vendor"));
    assert!(paths.contains(&"dist"));
    assert!(paths.contains(&"storage/logs"));
    assert!(paths.contains(&"src/nested/included.rs"));
    assert!(!paths.iter().any(|path| path.starts_with(".git/")));
    assert!(!paths.iter().any(|path| path.starts_with("node_modules/")));
    assert!(!paths.iter().any(|path| path.starts_with("vendor/")));
    assert!(!paths.iter().any(|path| path.starts_with("dist/")));
    assert!(!paths.iter().any(|path| path.starts_with("storage/logs/")));
    assert!(!paths.contains(&"src/scratch.tmp"));
    assert!(!paths.contains(&"src/bundle.min.js"));
    assert!(!paths.contains(&"src/source.js.map"));
}

#[cfg(unix)]
#[tokio::test]
async fn recursive_listing_reports_but_never_follows_symlinks() {
    use std::os::unix::fs::symlink;

    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    fs::write(outside.path().join("secret"), "secret").expect("secret");
    symlink(outside.path(), workspace.path().join("linked")).expect("link");
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");

    let WorkspaceRecursiveListOutcome::Entries { entries, .. } = tool
        .list_recursive(
            &WorkspaceListArguments {
                path: ".".to_string(),
            },
            &CancellationToken::new(),
        )
        .await
    else {
        panic!("recursive listing");
    };
    assert_eq!(
        entries,
        vec![WorkspaceRecursiveListEntry {
            path: "linked".to_string(),
            name: "linked".to_string(),
            kind: WorkspaceListEntryKind::Link,
        }]
    );
}

#[tokio::test]
async fn root_path_validation_entry_limit_and_cancellation_are_bounded() {
    let workspace = tempfile::tempdir().expect("workspace");
    fs::write(workspace.path().join("file"), "file").expect("file");
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");
    let too_deep = std::iter::repeat_n("a", 65).collect::<Vec<_>>().join("/");
    for (path, expected) in [
        ("", WorkspaceListErrorKind::InvalidPath),
        ("../outside", WorkspaceListErrorKind::InvalidPath),
        ("nested/.", WorkspaceListErrorKind::InvalidPath),
        ("/etc", WorkspaceListErrorKind::InvalidPath),
        ("missing", WorkspaceListErrorKind::NotFound),
        ("file", WorkspaceListErrorKind::NotDirectory),
        (too_deep.as_str(), WorkspaceListErrorKind::InvalidPath),
    ] {
        assert_eq!(
            tool.list(
                &WorkspaceListArguments {
                    path: path.to_string(),
                },
                &CancellationToken::new(),
            )
            .await,
            WorkspaceListOutcome::Error { kind: expected }
        );
    }

    let crowded = workspace.path().join("crowded");
    fs::create_dir(&crowded).expect("crowded");
    for index in 0..=MAX_WORKSPACE_LIST_ENTRIES {
        fs::write(crowded.join(format!("entry-{index:04}")), "").expect("entry");
    }
    assert_eq!(
        tool.list(
            &WorkspaceListArguments {
                path: "crowded".to_string(),
            },
            &CancellationToken::new(),
        )
        .await,
        WorkspaceListOutcome::Error {
            kind: WorkspaceListErrorKind::TooManyEntries
        }
    );

    let cancellation = CancellationToken::new();
    cancellation.cancel();
    assert_eq!(
        tool.list(
            &WorkspaceListArguments {
                path: ".".to_string(),
            },
            &cancellation,
        )
        .await,
        WorkspaceListOutcome::Error {
            kind: WorkspaceListErrorKind::Cancelled
        }
    );
}

#[cfg(unix)]
#[tokio::test]
async fn rejects_control_names_and_permission_denied_directories() {
    use std::os::unix::fs::PermissionsExt;

    let workspace = tempfile::tempdir().expect("workspace");
    let denied = workspace.path().join("denied");
    fs::create_dir(&denied).expect("denied directory");
    fs::set_permissions(&denied, fs::Permissions::from_mode(0o000)).expect("deny permissions");
    fs::write(workspace.path().join("bad\nname"), "invalid").expect("control name");
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");

    let denied_outcome = tool
        .list(
            &WorkspaceListArguments {
                path: "denied".to_string(),
            },
            &CancellationToken::new(),
        )
        .await;
    fs::set_permissions(&denied, fs::Permissions::from_mode(0o700)).expect("restore permissions");
    assert_eq!(
        denied_outcome,
        WorkspaceListOutcome::Error {
            kind: WorkspaceListErrorKind::AccessDenied
        }
    );
    assert_eq!(
        tool.list(
            &WorkspaceListArguments {
                path: ".".to_string(),
            },
            &CancellationToken::new(),
        )
        .await,
        WorkspaceListOutcome::Error {
            kind: WorkspaceListErrorKind::InvalidName
        }
    );
}

#[cfg(unix)]
#[tokio::test]
async fn lists_links_and_special_entries_without_following_them() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::symlink;
    use std::os::unix::net::UnixListener;

    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    fs::write(outside.path().join("secret"), "outside").expect("secret");
    symlink(outside.path(), workspace.path().join("linked")).expect("link");
    let fifo = workspace.path().join("fifo");
    let fifo_path = CString::new(fifo.as_os_str().as_bytes()).expect("fifo path");
    // SAFETY: fifo_path is a valid, NUL-terminated path owned for this call.
    assert_eq!(unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) }, 0);
    let socket = workspace.path().join("socket");
    let _listener = UnixListener::bind(&socket).expect("socket");
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");

    let WorkspaceListOutcome::Entries { entries, .. } = tool
        .list(
            &WorkspaceListArguments {
                path: ".".to_string(),
            },
            &CancellationToken::new(),
        )
        .await
    else {
        panic!("root listing");
    };
    assert_eq!(
        entries,
        vec![
            WorkspaceListEntry {
                name: "fifo".to_string(),
                kind: WorkspaceListEntryKind::Other,
            },
            WorkspaceListEntry {
                name: "linked".to_string(),
                kind: WorkspaceListEntryKind::Link,
            },
            WorkspaceListEntry {
                name: "socket".to_string(),
                kind: WorkspaceListEntryKind::Other,
            },
        ]
    );
    assert_eq!(
        tool.list(
            &WorkspaceListArguments {
                path: "linked".to_string(),
            },
            &CancellationToken::new(),
        )
        .await,
        WorkspaceListOutcome::Error {
            kind: WorkspaceListErrorKind::PathNotAllowed
        }
    );
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn rejects_non_utf8_entry_names_without_lossy_conversion() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    let workspace = tempfile::tempdir().expect("workspace");
    fs::write(
        workspace
            .path()
            .join(OsString::from_vec(vec![b'n', b'a', 0xff])),
        "invalid",
    )
    .expect("non UTF-8 name");
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");
    assert_eq!(
        tool.list(
            &WorkspaceListArguments {
                path: ".".to_string(),
            },
            &CancellationToken::new(),
        )
        .await,
        WorkspaceListOutcome::Error {
            kind: WorkspaceListErrorKind::InvalidEncoding
        }
    );
}

#[cfg(windows)]
#[tokio::test]
async fn rejects_windows_prefixes_and_target_reparse_points_but_lists_links() {
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
    let output = Command::new("cmd")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(&junction)
        .arg(outside.path())
        .output()
        .expect("create junction");
    assert!(
        output.status.success(),
        "junction creation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");
    for path in [r"C:\Windows\System32", r"\\server\share", r"\\?\C:\secret"] {
        assert_eq!(
            tool.list(
                &WorkspaceListArguments {
                    path: path.to_string(),
                },
                &CancellationToken::new(),
            )
            .await,
            WorkspaceListOutcome::Error {
                kind: WorkspaceListErrorKind::InvalidPath
            }
        );
    }
    for path in ["linked", "linked-file", "junction"] {
        assert_eq!(
            tool.list(
                &WorkspaceListArguments {
                    path: path.to_string(),
                },
                &CancellationToken::new(),
            )
            .await,
            WorkspaceListOutcome::Error {
                kind: WorkspaceListErrorKind::PathNotAllowed
            }
        );
    }
    let WorkspaceListOutcome::Entries { entries, .. } = tool
        .list(
            &WorkspaceListArguments {
                path: ".".to_string(),
            },
            &CancellationToken::new(),
        )
        .await
    else {
        panic!("root listing");
    };
    assert_eq!(
        entries
            .iter()
            .filter(|entry| {
                matches!(entry.name.as_str(), "junction" | "linked" | "linked-file")
            })
            .map(|entry| entry.kind)
            .collect::<Vec<_>>(),
        vec![
            WorkspaceListEntryKind::Link,
            WorkspaceListEntryKind::Link,
            WorkspaceListEntryKind::Link
        ]
    );
}
