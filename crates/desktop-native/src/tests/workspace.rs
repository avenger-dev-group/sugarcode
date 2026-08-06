use serde_json::Value;
use std::fs;

use super::NativeRuntime;

#[test]
fn native_workspace_inspection_preserves_the_desktop_document_contract() {
    let data_directory = tempfile::tempdir().expect("data directory");
    let workspace = tempfile::tempdir().expect("workspace");
    fs::write(workspace.path().join("fixture.txt"), "first\nsecond\n").expect("write fixture");
    let runtime = NativeRuntime::open(data_directory.path().to_string_lossy().into_owned())
        .expect("native runtime");
    runtime
        .ensure_workspace(
            "workspace-fixture".to_owned(),
            workspace.path().to_string_lossy().into_owned(),
        )
        .expect("open workspace");

    let document: Value = serde_json::from_str(
        &runtime
            .workspace_inspect_json("workspace-fixture".to_owned(), "fixture.txt".to_owned())
            .expect("inspect fixture"),
    )
    .expect("document JSON");
    assert_eq!(document["status"], "complete");
    assert_eq!(document["content"], "first\nsecond\n");
    assert_eq!(document["bytes"], 13);
    assert_eq!(document["lines"], 2);
    assert_eq!(document["hasUtf8Bom"], false);

    let missing: Value = serde_json::from_str(
        &runtime
            .workspace_inspect_json("workspace-fixture".to_owned(), "missing.txt".to_owned())
            .expect("inspect missing fixture"),
    )
    .expect("missing document JSON");
    assert_eq!(missing["status"], "error");
    assert_eq!(missing["kind"], "notFound");
}
