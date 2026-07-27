#![cfg(unix)]

use super::*;

#[test]
fn root_identity_rejects_a_different_directory_handle() {
    let workspace = tempfile::tempdir().expect("workspace");
    let replacement = tempfile::tempdir().expect("replacement");
    let workspace = WorkspaceTool::open(workspace.path()).expect("open workspace");
    let command_root =
        CommandWorkspaceRoot::from_workspace(&workspace).expect("bind workspace root");
    let replacement = std::fs::File::open(replacement.path()).expect("open replacement");

    assert!(
        !command_root
            .identity()
            .matches(&replacement)
            .expect("compare root identity")
    );
}
