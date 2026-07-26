use super::*;
#[cfg(not(windows))]
use std::fs;

#[tokio::test]
#[cfg(not(windows))]
async fn detects_candidate_file_replacement() {
    let workspace = tempfile::tempdir().expect("workspace");
    fs::write(workspace.path().join("target"), "needle\n").expect("target");
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");
    let outcome = tool
        .search_with_before_file_identity_check(
            &WorkspaceSearchArguments {
                path: ".".to_string(),
                query: "needle".to_string(),
            },
            &CancellationToken::new(),
            WORKSPACE_SEARCH_DEADLINE,
            Some(|| {
                fs::rename(
                    workspace.path().join("target"),
                    workspace.path().join("previous"),
                )
                .expect("move target");
                fs::write(workspace.path().join("target"), "needle\n").expect("replacement");
            }),
        )
        .await;
    assert_eq!(
        outcome,
        WorkspaceSearchOutcome::Error {
            kind: WorkspaceSearchErrorKind::ChangedDuringSearch
        }
    );
}

#[tokio::test]
async fn deadline_is_checked_before_traversal() {
    let workspace = tempfile::tempdir().expect("workspace");
    let tool = WorkspaceTool::open(workspace.path()).expect("tool");
    assert_eq!(
        tool.search_with_before_file_identity_check(
            &WorkspaceSearchArguments {
                path: ".".to_string(),
                query: "needle".to_string(),
            },
            &CancellationToken::new(),
            Duration::ZERO,
            Option::<fn()>::None,
        )
        .await,
        WorkspaceSearchOutcome::Error {
            kind: WorkspaceSearchErrorKind::SearchTimedOut
        }
    );
}

#[test]
fn query_validation_is_exact_and_bounded() {
    for query in ["", " ", "\t", "line\nbreak", "\0"] {
        assert_eq!(
            validate_query(query),
            Err(WorkspaceSearchErrorKind::InvalidQuery)
        );
    }
    assert_eq!(
        validate_query(&"x".repeat(MAX_WORKSPACE_SEARCH_QUERY_BYTES + 1)),
        Err(WorkspaceSearchErrorKind::InvalidQuery)
    );
    assert_eq!(validate_query(" Needle "), Ok(()));
}
