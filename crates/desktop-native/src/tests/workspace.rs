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

#[tokio::test]
async fn native_workspace_resolution_returns_only_unique_file_names() {
    let data_directory = tempfile::tempdir().expect("data directory");
    let workspace = tempfile::tempdir().expect("workspace");
    fs::create_dir_all(workspace.path().join("src/components")).expect("create source directory");
    fs::write(
        workspace.path().join("src/components/extension.tsx"),
        "export {};",
    )
    .expect("write unique fixture");
    let runtime = NativeRuntime::open(data_directory.path().to_string_lossy().into_owned())
        .expect("native runtime");
    runtime
        .ensure_workspace(
            "workspace-fixture".to_owned(),
            workspace.path().to_string_lossy().into_owned(),
        )
        .expect("open workspace");

    let resolved: Value = serde_json::from_str(
        &runtime
            .workspace_resolve_json("workspace-fixture".to_owned(), "extension.tsx".to_owned())
            .await
            .expect("resolve fixture"),
    )
    .expect("resolution JSON");
    assert_eq!(resolved["status"], "resolved");
    assert_eq!(resolved["path"], "src/components/extension.tsx");

    fs::create_dir_all(workspace.path().join("tests")).expect("create test directory");
    fs::write(workspace.path().join("tests/extension.tsx"), "export {};")
        .expect("write duplicate fixture");
    let ambiguous: Value = serde_json::from_str(
        &runtime
            .workspace_resolve_json("workspace-fixture".to_owned(), "extension.tsx".to_owned())
            .await
            .expect("resolve duplicate fixture"),
    )
    .expect("ambiguous resolution JSON");
    assert_eq!(ambiguous["status"], "ambiguous");
    assert!(ambiguous.get("path").is_none());
}
