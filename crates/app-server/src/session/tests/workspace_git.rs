use super::*;
use git2::Repository;
use std::fs;
use std::path::Path;
use std::sync::Arc;

fn ready_git_session(root: &Path) -> Session<Core> {
    let repository = Repository::init(root).expect("repository");
    fs::write(root.join("tracked.txt"), "before\n").expect("tracked file");
    let mut index = repository.index().expect("index");
    index.add_path(Path::new("tracked.txt")).expect("stage");
    index.write().expect("write index");
    let tree_oid = index.write_tree().expect("tree");
    let tree = repository.find_tree(tree_oid).expect("find tree");
    let signature =
        git2::Signature::now("SugarCode Test", "test@example.invalid").expect("signature");
    repository
        .commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
        .expect("initial commit");
    drop(tree);
    drop(repository);

    let workspace = Arc::new(WorkspaceTool::open(root).expect("workspace"));
    let mut session = Session::with_core_and_workspace(Core::new(), Some(workspace), None);
    let initialized = session.process_line(&initialize_line(1));
    let JsonRpcMessage::Response(response) = &initialized[0] else {
        panic!("initialize response");
    };
    assert_eq!(response.result["capabilities"]["workspaceGit"], true);
    session.process_line(r#"{"jsonrpc":"2.0","method":"initialized"}"#);
    session
}

fn result_value(messages: &[JsonRpcMessage]) -> &Value {
    let JsonRpcMessage::Response(response) = &messages[0] else {
        panic!("result response");
    };
    &response.result
}

#[test]
fn status_stage_commit_flow_is_public_and_revision_bound() {
    let root = tempfile::tempdir().expect("root");
    let mut session = ready_git_session(root.path());
    fs::write(root.path().join("tracked.txt"), "after\n").expect("modify");

    let status = session.process_line(
        r#"{"jsonrpc":"2.0","id":"status","method":"workspace/git/status","params":{}}"#,
    );
    let status = result_value(&status);
    assert_eq!(status["status"], "ready");
    assert_eq!(status["unstagedCount"], 1);
    let revision = status["revision"].as_str().expect("revision");

    let stage = session.process_line(
        &json!({
            "jsonrpc": "2.0",
            "id": "stage",
            "method": "workspace/git/stage",
            "params": {
                "expectedRevision": revision,
                "paths": ["tracked.txt"]
            }
        })
        .to_string(),
    );
    let stage = result_value(&stage);
    assert_eq!(stage["status"], "applied");

    let stale = session.process_line(
        &json!({
            "jsonrpc": "2.0",
            "id": "stale",
            "method": "workspace/git/unstage",
            "params": {
                "expectedRevision": revision,
                "paths": ["tracked.txt"]
            }
        })
        .to_string(),
    );
    assert_eq!(result_value(&stale)["kind"], "stale");

    let commit = session.process_line(
        &json!({
            "jsonrpc": "2.0",
            "id": "commit",
            "method": "workspace/git/commit",
            "params": {
                "expectedRevision": stage["revision"],
                "message": "update tracked file",
                "authorName": "SugarCode Test",
                "authorEmail": "test@example.invalid"
            }
        })
        .to_string(),
    );
    let commit = result_value(&commit);
    assert_eq!(commit["status"], "committed");
    assert_eq!(
        Repository::open(root.path())
            .expect("reopen")
            .head()
            .expect("head")
            .target()
            .expect("oid")
            .to_string(),
        commit["newHead"]
    );
}

#[test]
fn git_params_reject_absolute_paths_and_unknown_fields() {
    let root = tempfile::tempdir().expect("root");
    let mut session = ready_git_session(root.path());
    let invalid = session.process_line(
        r#"{"jsonrpc":"2.0","id":"bad","method":"workspace/git/diff","params":{"expectedRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","path":"/etc/passwd","source":"worktree","cwd":"/"}}"#,
    );
    let JsonRpcMessage::Error(error) = &invalid[0] else {
        panic!("invalid params response");
    };
    assert_eq!(error.error.code, ERROR_INVALID_PARAMS);
}
