use std::fs;
use sugarcode_tools::WorkspaceListArguments;
#[cfg(unix)]
use sugarcode_tools::WorkspaceListErrorKind;
use sugarcode_tools::WorkspaceListOutcome;
use sugarcode_tools::WorkspacePatchArguments;
use sugarcode_tools::WorkspacePatchCommitOutcome;
use sugarcode_tools::WorkspacePatchPrepareOutcome;
use sugarcode_tools::WorkspaceReadArguments;
use sugarcode_tools::WorkspaceReadErrorKind;
use sugarcode_tools::WorkspaceReadOutcome;
use sugarcode_tools::WorkspaceSearchArguments;
#[cfg(unix)]
use sugarcode_tools::WorkspaceSearchErrorKind;
use sugarcode_tools::WorkspaceSearchMatch;
use sugarcode_tools::WorkspaceSearchOutcome;
use sugarcode_tools::WorkspaceTool;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn active_scope_rebases_every_structured_workspace_tool() {
    let workspace = tempfile::tempdir().expect("workspace");
    fs::create_dir_all(workspace.path().join("projects/active/src")).expect("active scope");
    fs::write(workspace.path().join("outside.txt"), "outside marker\n").expect("outside");
    fs::write(
        workspace.path().join("projects/active/src/lib.rs"),
        "one\nneedle\ntwo\n",
    )
    .expect("scoped source");
    fs::write(
        workspace.path().join("projects/active/AGENTS.md"),
        "nested instructions\n",
    )
    .expect("nested AGENTS.md");

    let root = WorkspaceTool::open(workspace.path()).expect("workspace root");
    let scope = root
        .derive_scope("projects/active")
        .expect("active workspace scope");
    let cancellation = CancellationToken::new();

    assert_eq!(
        scope
            .read(
                &WorkspaceReadArguments {
                    path: "src/lib.rs".to_string(),
                },
                &cancellation,
            )
            .await,
        WorkspaceReadOutcome::Content {
            content: "one\nneedle\ntwo\n".to_string(),
            bytes: "one\nneedle\ntwo\n".len(),
        }
    );
    assert_eq!(
        scope
            .read(
                &WorkspaceReadArguments {
                    path: "../outside.txt".to_string(),
                },
                &cancellation,
            )
            .await,
        WorkspaceReadOutcome::Error {
            kind: WorkspaceReadErrorKind::InvalidPath,
        }
    );
    assert_eq!(
        scope
            .search(
                &WorkspaceSearchArguments {
                    path: ".".to_string(),
                    query: "needle".to_string(),
                },
                &cancellation,
            )
            .await,
        WorkspaceSearchOutcome::Matches {
            matches: vec![WorkspaceSearchMatch {
                path: "src/lib.rs".to_string(),
                line: 2,
            }],
            truncated: false,
        }
    );
    let WorkspaceListOutcome::Entries { entries, .. } = scope
        .list(
            &WorkspaceListArguments {
                path: ".".to_string(),
            },
            &cancellation,
        )
        .await
    else {
        panic!("scope listing");
    };
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        vec!["AGENTS.md", "src"]
    );

    let WorkspacePatchPrepareOutcome::Prepared(prepared) = scope
        .prepare_patch(
            &WorkspacePatchArguments {
                path: "src/lib.rs".to_string(),
                base_sha256: None,
                diff: "--- a/notes.txt\n+++ b/notes.txt\n@@ -1,3 +1,3 @@\n one\n-needle\n+updated\n two\n".to_string(),
            },
            &cancellation,
        )
        .await
    else {
        panic!("prepare scoped patch");
    };
    assert!(matches!(
        scope.commit_patch(*prepared, &cancellation).await,
        WorkspacePatchCommitOutcome::Applied { path, .. } if path == "src/lib.rs"
    ));
    assert_eq!(
        fs::read_to_string(workspace.path().join("projects/active/src/lib.rs"))
            .expect("patched scoped file"),
        "one\nupdated\ntwo\n"
    );
    assert_eq!(
        fs::read_to_string(workspace.path().join("outside.txt")).expect("outside unchanged"),
        "outside marker\n"
    );

    assert_eq!(
        scope
            .read(
                &WorkspaceReadArguments {
                    path: "AGENTS.md".to_string(),
                },
                &cancellation,
            )
            .await,
        WorkspaceReadOutcome::Content {
            content: "nested instructions\n".to_string(),
            bytes: "nested instructions\n".len(),
        }
    );
}

#[test]
fn active_scope_path_is_bounded_and_no_follow() {
    let workspace = tempfile::tempdir().expect("workspace");
    fs::create_dir_all(workspace.path().join("valid/nested")).expect("valid scope");
    fs::write(workspace.path().join("file"), "not a directory").expect("file");
    let root = WorkspaceTool::open(workspace.path()).expect("workspace root");

    assert!(root.derive_scope(".").is_ok());
    for (scope, expected) in [
        ("", WorkspaceReadErrorKind::InvalidPath),
        ("../outside", WorkspaceReadErrorKind::InvalidPath),
        ("valid/.", WorkspaceReadErrorKind::InvalidPath),
        ("/absolute", WorkspaceReadErrorKind::InvalidPath),
        ("missing", WorkspaceReadErrorKind::NotFound),
        ("file", WorkspaceReadErrorKind::NotRegularFile),
    ] {
        assert_eq!(
            root.derive_scope(scope).expect_err("invalid scope"),
            expected,
            "{scope}"
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn scope_path_replacement_never_redirects_opened_authority() {
    use std::os::unix::fs::symlink;

    let parent = tempfile::tempdir().expect("parent");
    let workspace = parent.path().join("workspace");
    let active = workspace.join("active");
    let moved = workspace.join("moved");
    let replacement = parent.path().join("replacement");
    fs::create_dir_all(&active).expect("active scope");
    fs::create_dir(&replacement).expect("replacement scope");
    fs::write(active.join("marker.txt"), "original marker\n").expect("original marker");
    fs::write(active.join("notes.txt"), "one\ntwo\nthree\n").expect("original notes");
    fs::write(replacement.join("marker.txt"), "replacement marker\n").expect("replacement marker");
    fs::write(replacement.join("notes.txt"), "replacement notes\n").expect("replacement notes");

    let root = WorkspaceTool::open(&workspace).expect("workspace root");
    let scope = root.derive_scope("active").expect("active scope");
    fs::rename(&active, &moved).expect("move active scope");
    symlink(&replacement, &active).expect("replace scope path");
    let cancellation = CancellationToken::new();

    assert_eq!(
        scope
            .read(
                &WorkspaceReadArguments {
                    path: "marker.txt".to_string(),
                },
                &cancellation,
            )
            .await,
        WorkspaceReadOutcome::Content {
            content: "original marker\n".to_string(),
            bytes: "original marker\n".len(),
        }
    );
    assert_eq!(
        scope
            .list(
                &WorkspaceListArguments {
                    path: ".".to_string(),
                },
                &cancellation,
            )
            .await,
        WorkspaceListOutcome::Error {
            kind: WorkspaceListErrorKind::ChangedDuringList,
        }
    );
    assert_eq!(
        scope
            .search(
                &WorkspaceSearchArguments {
                    path: ".".to_string(),
                    query: "marker".to_string(),
                },
                &cancellation,
            )
            .await,
        WorkspaceSearchOutcome::Error {
            kind: WorkspaceSearchErrorKind::ChangedDuringSearch,
        }
    );

    let WorkspacePatchPrepareOutcome::Prepared(prepared) = scope
        .prepare_patch(
            &WorkspacePatchArguments {
                path: "notes.txt".to_string(),
                base_sha256: None,
                diff: "--- a/notes.txt\n+++ b/notes.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+updated\n three\n".to_string(),
            },
            &cancellation,
        )
        .await
    else {
        panic!("prepare original scoped patch");
    };
    assert!(matches!(
        scope.commit_patch(*prepared, &cancellation).await,
        WorkspacePatchCommitOutcome::Applied { .. }
    ));
    assert_eq!(
        fs::read_to_string(moved.join("notes.txt")).expect("original scope patched"),
        "one\nupdated\nthree\n"
    );
    assert_eq!(
        fs::read_to_string(replacement.join("notes.txt")).expect("replacement untouched"),
        "replacement notes\n"
    );
}

#[cfg(unix)]
#[test]
fn symlinked_scope_is_rejected() {
    use std::os::unix::fs::symlink;

    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    symlink(outside.path(), workspace.path().join("linked")).expect("scope symlink");
    let root = WorkspaceTool::open(workspace.path()).expect("workspace root");
    assert_eq!(
        root.derive_scope("linked").expect_err("reject scope link"),
        WorkspaceReadErrorKind::PathNotAllowed
    );
}

#[cfg(windows)]
#[test]
fn reparse_scope_is_rejected() {
    use std::os::windows::fs::symlink_dir;

    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    symlink_dir(outside.path(), workspace.path().join("linked")).expect("scope reparse point");
    let root = WorkspaceTool::open(workspace.path()).expect("workspace root");
    assert_eq!(
        root.derive_scope("linked")
            .expect_err("reject scope reparse point"),
        WorkspaceReadErrorKind::PathNotAllowed
    );
}

#[cfg(windows)]
#[tokio::test]
async fn opened_scope_handle_blocks_replacement_without_redirection() {
    let workspace = tempfile::tempdir().expect("workspace");
    let active = workspace.path().join("active");
    let moved = workspace.path().join("moved");
    fs::create_dir(&active).expect("active scope");
    fs::write(active.join("marker.txt"), "original marker\n").expect("original marker");
    let root = WorkspaceTool::open(workspace.path()).expect("workspace root");
    let scope = root.derive_scope("active").expect("active scope");

    fs::rename(&active, &moved).expect_err("open scope handle must block replacement");
    assert_eq!(
        scope
            .read(
                &WorkspaceReadArguments {
                    path: "marker.txt".to_string(),
                },
                &CancellationToken::new(),
            )
            .await,
        WorkspaceReadOutcome::Content {
            content: "original marker\n".to_string(),
            bytes: "original marker\n".len(),
        }
    );
}
