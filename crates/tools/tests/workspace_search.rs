use std::fs;
use sugarcode_tools::MAX_WORKSPACE_LIST_ENTRIES;
use sugarcode_tools::MAX_WORKSPACE_READ_BYTES;
use sugarcode_tools::MAX_WORKSPACE_SEARCH_MATCHES;
use sugarcode_tools::MAX_WORKSPACE_SEARCH_TOTAL_READ_BYTES;
use sugarcode_tools::WorkspaceSearchArguments;
use sugarcode_tools::WorkspaceSearchErrorKind;
use sugarcode_tools::WorkspaceSearchMatch;
use sugarcode_tools::WorkspaceSearchOutcome;
use sugarcode_tools::WorkspaceTool;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn searches_content_recursively_with_stable_literal_semantics() {
    let workspace = tempfile::tempdir().expect("workspace");
    fs::create_dir_all(workspace.path().join("src/nested")).expect("nested");
    fs::create_dir_all(workspace.path().join("src/.hidden")).expect("hidden");
    fs::write(
        workspace.path().join("src/zeta.rs"),
        "needle twice needle\nNeedle\n",
    )
    .expect("zeta");
    fs::write(
        workspace.path().join("src/Alpha.rs"),
        "first\nneedle\nneedle\n",
    )
    .expect("alpha");
    fs::write(workspace.path().join("src/nested/lib.rs"), "needle\n").expect("nested file");
    fs::write(workspace.path().join("src/.hidden/secret.rs"), "needle\n").expect("hidden file");
    fs::write(workspace.path().join(".gitignore"), "src/Alpha.rs\n").expect("ignore");
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");

    assert_eq!(
        tool.search(
            &WorkspaceSearchArguments {
                path: "src".to_string(),
                query: "needle".to_string(),
            },
            &CancellationToken::new(),
        )
        .await,
        WorkspaceSearchOutcome::Matches {
            matches: vec![
                WorkspaceSearchMatch {
                    path: "src/Alpha.rs".to_string(),
                    line: 2,
                },
                WorkspaceSearchMatch {
                    path: "src/Alpha.rs".to_string(),
                    line: 3,
                },
                WorkspaceSearchMatch {
                    path: "src/nested/lib.rs".to_string(),
                    line: 1,
                },
                WorkspaceSearchMatch {
                    path: "src/zeta.rs".to_string(),
                    line: 1,
                },
            ],
            truncated: false,
        }
    );
    assert_eq!(
        tool.search(
            &WorkspaceSearchArguments {
                path: "src".to_string(),
                query: "Alpha".to_string(),
            },
            &CancellationToken::new(),
        )
        .await,
        WorkspaceSearchOutcome::Matches {
            matches: Vec::new(),
            truncated: false,
        }
    );
}

#[tokio::test]
async fn explicit_hidden_root_is_allowed_but_hidden_children_are_skipped() {
    let workspace = tempfile::tempdir().expect("workspace");
    fs::create_dir_all(workspace.path().join(".hidden/.nested")).expect("hidden");
    fs::write(workspace.path().join(".hidden/visible"), "needle\n").expect("visible");
    fs::write(workspace.path().join(".hidden/.nested/secret"), "needle\n").expect("secret");
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");

    assert_eq!(
        tool.search(
            &WorkspaceSearchArguments {
                path: ".hidden".to_string(),
                query: "needle".to_string(),
            },
            &CancellationToken::new(),
        )
        .await,
        WorkspaceSearchOutcome::Matches {
            matches: vec![WorkspaceSearchMatch {
                path: ".hidden/visible".to_string(),
                line: 1,
            }],
            truncated: false,
        }
    );
}

#[tokio::test]
async fn skips_binary_oversize_and_special_entries_without_following_links() {
    let workspace = tempfile::tempdir().expect("workspace");
    fs::write(workspace.path().join("binary"), b"needle\0").expect("binary");
    fs::write(workspace.path().join("invalid-utf8"), [0xff, 0xfe]).expect("invalid UTF-8");
    fs::write(
        workspace.path().join("oversize"),
        vec![b'x'; MAX_WORKSPACE_READ_BYTES + 1],
    )
    .expect("oversize");
    fs::write(workspace.path().join("regular"), "needle\n").expect("regular");
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");

    assert_eq!(
        tool.search(
            &WorkspaceSearchArguments {
                path: ".".to_string(),
                query: "needle".to_string(),
            },
            &CancellationToken::new(),
        )
        .await,
        WorkspaceSearchOutcome::Matches {
            matches: vec![WorkspaceSearchMatch {
                path: "regular".to_string(),
                line: 1,
            }],
            truncated: false,
        }
    );
}

#[tokio::test]
async fn validates_paths_queries_cancellation_depth_and_match_limit() {
    let workspace = tempfile::tempdir().expect("workspace");
    fs::write(
        workspace.path().join("many"),
        "needle\n".repeat(MAX_WORKSPACE_SEARCH_MATCHES + 1),
    )
    .expect("many");
    let mut deep = workspace.path().join("zz-depth");
    fs::create_dir(&deep).expect("depth root");
    for _ in 0..=32 {
        deep.push("level");
        fs::create_dir(&deep).expect("level");
    }
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");

    for (path, query, expected) in [
        ("", "needle", WorkspaceSearchErrorKind::InvalidPath),
        (
            "../outside",
            "needle",
            WorkspaceSearchErrorKind::InvalidPath,
        ),
        (".", "", WorkspaceSearchErrorKind::InvalidQuery),
        (".", " ", WorkspaceSearchErrorKind::InvalidQuery),
        (".", "line\nbreak", WorkspaceSearchErrorKind::InvalidQuery),
    ] {
        assert_eq!(
            tool.search(
                &WorkspaceSearchArguments {
                    path: path.to_string(),
                    query: query.to_string(),
                },
                &CancellationToken::new(),
            )
            .await,
            WorkspaceSearchOutcome::Error { kind: expected }
        );
    }

    let cancellation = CancellationToken::new();
    cancellation.cancel();
    assert_eq!(
        tool.search(
            &WorkspaceSearchArguments {
                path: ".".to_string(),
                query: "needle".to_string(),
            },
            &cancellation,
        )
        .await,
        WorkspaceSearchOutcome::Error {
            kind: WorkspaceSearchErrorKind::Cancelled
        }
    );

    let WorkspaceSearchOutcome::Matches { matches, truncated } = tool
        .search(
            &WorkspaceSearchArguments {
                path: ".".to_string(),
                query: "needle".to_string(),
            },
            &CancellationToken::new(),
        )
        .await
    else {
        panic!("bounded matches");
    };
    assert_eq!(matches.len(), MAX_WORKSPACE_SEARCH_MATCHES);
    assert!(truncated);

    assert_eq!(
        tool.search(
            &WorkspaceSearchArguments {
                path: "zz-depth".to_string(),
                query: "absent".to_string(),
            },
            &CancellationToken::new(),
        )
        .await,
        WorkspaceSearchOutcome::Error {
            kind: WorkspaceSearchErrorKind::SearchLimitExceeded
        }
    );
}

#[tokio::test]
async fn enforces_directory_entry_and_total_read_budgets() {
    let workspace = tempfile::tempdir().expect("workspace");
    let crowded = workspace.path().join("crowded");
    fs::create_dir(&crowded).expect("crowded");
    for index in 0..=MAX_WORKSPACE_LIST_ENTRIES {
        fs::write(crowded.join(format!("entry-{index:04}")), "").expect("entry");
    }
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");
    assert_eq!(
        tool.search(
            &WorkspaceSearchArguments {
                path: "crowded".to_string(),
                query: "absent".to_string(),
            },
            &CancellationToken::new(),
        )
        .await,
        WorkspaceSearchOutcome::Error {
            kind: WorkspaceSearchErrorKind::TooManyEntries
        }
    );

    let readable = workspace.path().join("readable");
    fs::create_dir(&readable).expect("readable");
    let file_count = MAX_WORKSPACE_SEARCH_TOTAL_READ_BYTES / MAX_WORKSPACE_READ_BYTES + 1;
    let content = vec![b'x'; MAX_WORKSPACE_READ_BYTES];
    for index in 0..file_count {
        fs::write(readable.join(format!("file-{index:03}")), &content).expect("candidate");
    }
    assert_eq!(
        tool.search(
            &WorkspaceSearchArguments {
                path: "readable".to_string(),
                query: "absent".to_string(),
            },
            &CancellationToken::new(),
        )
        .await,
        WorkspaceSearchOutcome::Error {
            kind: WorkspaceSearchErrorKind::SearchLimitExceeded
        }
    );
}

#[cfg(windows)]
#[tokio::test]
async fn rejects_target_reparse_points_and_skips_recursive_reparse_points() {
    use std::os::windows::fs::symlink_dir;
    use std::os::windows::fs::symlink_file;
    use std::process::Command;

    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    fs::write(outside.path().join("secret"), "needle\n").expect("secret");
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
    fs::write(workspace.path().join("regular"), "needle\n").expect("regular");
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");

    for path in ["linked", "junction"] {
        assert_eq!(
            tool.search(
                &WorkspaceSearchArguments {
                    path: path.to_string(),
                    query: "needle".to_string(),
                },
                &CancellationToken::new(),
            )
            .await,
            WorkspaceSearchOutcome::Error {
                kind: WorkspaceSearchErrorKind::PathNotAllowed
            }
        );
    }
    assert_eq!(
        tool.search(
            &WorkspaceSearchArguments {
                path: ".".to_string(),
                query: "needle".to_string(),
            },
            &CancellationToken::new(),
        )
        .await,
        WorkspaceSearchOutcome::Matches {
            matches: vec![WorkspaceSearchMatch {
                path: "regular".to_string(),
                line: 1,
            }],
            truncated: false,
        }
    );
}

#[cfg(unix)]
#[tokio::test]
async fn skips_links_and_fifo_and_aborts_on_permission_denied() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::fs::symlink;

    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    fs::write(outside.path().join("secret"), "needle\n").expect("secret");
    symlink(outside.path(), workspace.path().join("linked")).expect("link");
    let fifo = workspace.path().join("fifo");
    let fifo_path = CString::new(fifo.as_os_str().as_bytes()).expect("fifo path");
    // SAFETY: fifo_path is a valid, NUL-terminated path owned for this call.
    assert_eq!(unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) }, 0);
    fs::write(workspace.path().join("regular"), "needle\n").expect("regular");
    let denied = workspace.path().join("denied");
    fs::write(&denied, "needle\n").expect("denied");
    fs::set_permissions(&denied, fs::Permissions::from_mode(0o000)).expect("permissions");
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");

    let outcome = tool
        .search(
            &WorkspaceSearchArguments {
                path: ".".to_string(),
                query: "needle".to_string(),
            },
            &CancellationToken::new(),
        )
        .await;
    fs::set_permissions(&denied, fs::Permissions::from_mode(0o600)).expect("restore");
    assert_eq!(
        outcome,
        WorkspaceSearchOutcome::Error {
            kind: WorkspaceSearchErrorKind::AccessDenied
        }
    );
}
