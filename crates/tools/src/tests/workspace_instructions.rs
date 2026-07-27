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

#[test]
fn candidate_creation_before_hierarchy_revalidation_is_rejected() {
    let workspace = tempfile::tempdir().expect("workspace");
    std::fs::create_dir_all(workspace.path().join("projects/active")).expect("scope");
    let tool = WorkspaceTool::open(workspace.path()).expect("workspace capability");

    let result = tool.derive_scope_with_instructions_before_revalidate("projects/active", || {
        std::fs::write(
            workspace.path().join("projects/AGENTS.md"),
            "created during discovery\n",
        )
        .expect("racing candidate");
    });

    assert!(matches!(
        result,
        Err(WorkspaceScopeInstructionsErrorKind::Instructions(
            WorkspaceInstructionsErrorKind::ChangedDuringDiscovery
        ))
    ));
}

#[cfg(unix)]
#[test]
fn directory_replacement_before_hierarchy_revalidation_never_redirects() {
    use std::os::unix::fs::symlink;

    let parent = tempfile::tempdir().expect("parent");
    let workspace = parent.path().join("workspace");
    let active = workspace.join("projects/active");
    let moved = workspace.join("projects/moved");
    let replacement = parent.path().join("replacement");
    std::fs::create_dir_all(&active).expect("scope");
    std::fs::create_dir(&replacement).expect("replacement");
    std::fs::write(active.join("AGENTS.md"), "original\n").expect("original");
    std::fs::write(replacement.join("AGENTS.md"), "replacement\n").expect("replacement");
    let tool = WorkspaceTool::open(&workspace).expect("workspace capability");

    let result = tool.derive_scope_with_instructions_before_revalidate("projects/active", || {
        std::fs::rename(&active, &moved).expect("move original");
        symlink(&replacement, &active).expect("replace path");
    });

    assert!(matches!(
        result,
        Err(WorkspaceScopeInstructionsErrorKind::Instructions(
            WorkspaceInstructionsErrorKind::ChangedDuringDiscovery
        ))
    ));
}
