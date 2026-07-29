use super::*;
use std::fs;
use std::sync::Arc;

fn ready_workspace_session(root: &std::path::Path) -> Session<Core> {
    let workspace = Arc::new(WorkspaceTool::open(root).expect("workspace"));
    let mut session = Session::with_core_and_workspace(Core::new(), Some(workspace), None);
    let initialize = session.process_line(&initialize_line(1));
    let JsonRpcMessage::Response(response) = &initialize[0] else {
        panic!("initialize response");
    };
    assert_eq!(response.result["capabilities"]["workspaceBrowser"], true);
    assert!(response.result["workspace"]["id"].as_str().is_some());
    session.process_line(r#"{"jsonrpc":"2.0","method":"initialized"}"#);
    session
}

#[test]
fn lists_and_inspects_only_workspace_relative_paths() {
    let root = tempfile::tempdir().expect("root");
    fs::create_dir(root.path().join("src")).expect("src");
    fs::write(
        root.path().join("src/lib.rs"),
        "pub fn answer() -> u8 { 42 }\n",
    )
    .expect("file");
    let mut session = ready_workspace_session(root.path());

    let list = session.process_line(
        r#"{"jsonrpc":"2.0","id":"list","method":"workspace/list","params":{"path":"src"}}"#,
    );
    let JsonRpcMessage::Response(response) = &list[0] else {
        panic!("list response");
    };
    assert_eq!(response.result["entries"][0]["path"], "src/lib.rs");
    assert_eq!(response.result["entries"][0]["kind"], "file");

    let inspect = session.process_line(
        r#"{"jsonrpc":"2.0","id":"inspect","method":"workspace/inspect","params":{"path":"src/lib.rs"}}"#,
    );
    let JsonRpcMessage::Response(response) = &inspect[0] else {
        panic!("inspect response");
    };
    assert_eq!(response.result["status"], "complete");
    assert_eq!(response.result["content"], "pub fn answer() -> u8 { 42 }\n");

    let invalid = session.process_line(
        r#"{"jsonrpc":"2.0","id":"bad","method":"workspace/inspect","params":{"path":"../secret"}}"#,
    );
    let JsonRpcMessage::Error(error) = &invalid[0] else {
        panic!("invalid params");
    };
    assert_eq!(error.error.code, ERROR_INVALID_PARAMS);
}

#[test]
fn workspace_methods_fail_closed_without_a_binding() {
    let mut session = ready_session(Core::new());
    let result = session.process_line(
        r#"{"jsonrpc":"2.0","id":"list","method":"workspace/list","params":{"path":""}}"#,
    );
    let JsonRpcMessage::Error(error) = &result[0] else {
        panic!("workspace unavailable");
    };
    assert_eq!(error.error.code, ERROR_WORKSPACE_UNAVAILABLE);
}
