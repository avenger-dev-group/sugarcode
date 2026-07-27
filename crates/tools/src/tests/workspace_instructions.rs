use super::*;

#[test]
fn replacement_before_final_reopen_is_rejected() {
    let workspace = tempfile::tempdir().expect("workspace");
    std::fs::write(
        workspace.path().join(WORKSPACE_INSTRUCTIONS_FILE_NAME),
        "before\n",
    )
    .expect("instructions");
    let tool = WorkspaceTool::open(workspace.path()).expect("workspace capability");

    let result = tool.load_root_instructions_with_before_reopen(|| {
        std::fs::rename(
            workspace.path().join(WORKSPACE_INSTRUCTIONS_FILE_NAME),
            workspace.path().join("AGENTS.old"),
        )
        .expect("rename original");
        std::fs::write(
            workspace.path().join(WORKSPACE_INSTRUCTIONS_FILE_NAME),
            "after\n",
        )
        .expect("replacement");
    });

    assert_eq!(
        result,
        Err(WorkspaceInstructionsErrorKind::ChangedDuringRead)
    );
}
