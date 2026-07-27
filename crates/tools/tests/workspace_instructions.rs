use sugarcode_tools::MAX_WORKSPACE_INSTRUCTIONS_BYTES;
use sugarcode_tools::WORKSPACE_INSTRUCTIONS_FILE_NAME;
use sugarcode_tools::WorkspaceInstructionsErrorKind;
use sugarcode_tools::WorkspaceInstructionsSnapshot;
use sugarcode_tools::WorkspaceTool;

#[cfg(unix)]
#[test]
fn root_workspace_instructions_are_bounded_and_capability_relative() {
    let parent = tempfile::tempdir().expect("parent");
    let configured = parent.path().join("workspace");
    let original = parent.path().join("original");
    let replacement = parent.path().join("replacement");
    std::fs::create_dir(&configured).expect("configured workspace");
    std::fs::create_dir(&replacement).expect("replacement workspace");
    std::fs::write(
        configured.join(WORKSPACE_INSTRUCTIONS_FILE_NAME),
        "Use repository rules.\n",
    )
    .expect("instructions");
    std::fs::write(
        replacement.join(WORKSPACE_INSTRUCTIONS_FILE_NAME),
        "Wrong workspace.\n",
    )
    .expect("replacement instructions");

    let tool = WorkspaceTool::open(&configured).expect("workspace capability");
    std::fs::rename(&configured, &original).expect("move original workspace");
    replace_with_link(&configured, &replacement);

    let snapshot = tool
        .load_root_instructions()
        .expect("instructions snapshot");
    let WorkspaceInstructionsSnapshot::Present {
        content,
        bytes,
        sha256,
    } = snapshot
    else {
        panic!("instructions must be present");
    };
    assert_eq!(content, "Use repository rules.\n");
    assert_eq!(bytes, content.len());
    assert_eq!(sha256.len(), 64);
}

#[cfg(windows)]
#[test]
fn opened_workspace_capability_blocks_root_replacement() {
    let parent = tempfile::tempdir().expect("parent");
    let configured = parent.path().join("workspace");
    let moved = parent.path().join("moved");
    std::fs::create_dir(&configured).expect("configured workspace");
    std::fs::write(
        configured.join(WORKSPACE_INSTRUCTIONS_FILE_NAME),
        "Use repository rules.\n",
    )
    .expect("instructions");

    let tool = WorkspaceTool::open(&configured).expect("workspace capability");
    std::fs::rename(&configured, &moved).expect_err("open capability blocks root replacement");
    assert!(matches!(
        tool.load_root_instructions()
            .expect("original capability remains readable"),
        WorkspaceInstructionsSnapshot::Present { content, .. }
            if content == "Use repository rules.\n"
    ));
}

#[test]
fn missing_and_empty_instructions_are_distinct() {
    let workspace = tempfile::tempdir().expect("workspace");
    let tool = WorkspaceTool::open(workspace.path()).expect("workspace capability");
    assert_eq!(
        tool.load_root_instructions().expect("missing snapshot"),
        WorkspaceInstructionsSnapshot::Absent
    );

    std::fs::write(workspace.path().join(WORKSPACE_INSTRUCTIONS_FILE_NAME), "")
        .expect("empty instructions");
    let WorkspaceInstructionsSnapshot::Present {
        content,
        bytes,
        sha256,
    } = tool.load_root_instructions().expect("empty snapshot")
    else {
        panic!("empty file remains present");
    };
    assert!(content.is_empty());
    assert_eq!(bytes, 0);
    assert_eq!(
        sha256,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

#[test]
fn invalid_oversized_and_hard_linked_instructions_fail_closed() {
    let workspace = tempfile::tempdir().expect("workspace");
    let path = workspace.path().join(WORKSPACE_INSTRUCTIONS_FILE_NAME);
    let tool = WorkspaceTool::open(workspace.path()).expect("workspace capability");

    std::fs::write(&path, b"bad\0content").expect("NUL fixture");
    assert_eq!(
        tool.load_root_instructions(),
        Err(WorkspaceInstructionsErrorKind::InvalidEncoding)
    );

    std::fs::write(&path, vec![b'x'; MAX_WORKSPACE_INSTRUCTIONS_BYTES + 1])
        .expect("oversized fixture");
    assert_eq!(
        tool.load_root_instructions(),
        Err(WorkspaceInstructionsErrorKind::FileTooLarge)
    );

    std::fs::write(&path, "linked\n").expect("hard-link source");
    std::fs::hard_link(&path, workspace.path().join("instructions-alias")).expect("hard link");
    assert_eq!(
        tool.load_root_instructions(),
        Err(WorkspaceInstructionsErrorKind::HardLinkNotAllowed)
    );
}

#[cfg(unix)]
#[test]
fn symlinked_instructions_are_rejected() {
    let workspace = tempfile::tempdir().expect("workspace");
    std::fs::write(workspace.path().join("real.md"), "linked\n").expect("target");
    std::os::unix::fs::symlink(
        "real.md",
        workspace.path().join(WORKSPACE_INSTRUCTIONS_FILE_NAME),
    )
    .expect("symlink");
    let tool = WorkspaceTool::open(workspace.path()).expect("workspace capability");
    assert_eq!(
        tool.load_root_instructions(),
        Err(WorkspaceInstructionsErrorKind::PathNotAllowed)
    );
}

#[cfg(windows)]
#[test]
fn reparse_point_instructions_are_rejected() {
    use std::os::windows::fs::symlink_file;

    let workspace = tempfile::tempdir().expect("workspace");
    std::fs::write(workspace.path().join("real.md"), "linked\n").expect("target");
    symlink_file(
        workspace.path().join("real.md"),
        workspace.path().join(WORKSPACE_INSTRUCTIONS_FILE_NAME),
    )
    .expect("file symlink");
    let tool = WorkspaceTool::open(workspace.path()).expect("workspace capability");
    assert_eq!(
        tool.load_root_instructions(),
        Err(WorkspaceInstructionsErrorKind::PathNotAllowed)
    );
}

#[cfg(unix)]
fn replace_with_link(configured: &std::path::Path, replacement: &std::path::Path) {
    std::os::unix::fs::symlink(replacement, configured).expect("replacement symlink");
}
