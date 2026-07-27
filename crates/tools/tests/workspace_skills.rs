use std::fs;
use sugarcode_tools::MAX_WORKSPACE_SKILL_BYTES;
use sugarcode_tools::WorkspaceSkillSelectionErrorKind;
use sugarcode_tools::WorkspaceSkillsErrorKind;
use sugarcode_tools::WorkspaceTool;

fn write_skill(root: &std::path::Path, name: &str, description: &str, body: &str) {
    let path = root.join(format!(".agents/skills/{name}/SKILL.md"));
    fs::create_dir_all(path.parent().expect("skill parent")).expect("skill directory");
    fs::write(
        path,
        format!("---\nname: {name}\ndescription: {description}\n---\n{body}\n"),
    )
    .expect("skill");
}

#[test]
fn skills_are_bounded_sorted_shadowed_and_selected_from_the_frozen_scope_chain() {
    let workspace = tempfile::tempdir().expect("workspace");
    let middle = workspace.path().join("projects");
    let active = middle.join("active");
    fs::create_dir_all(&active).expect("active scope");
    write_skill(
        workspace.path(),
        "review",
        "Root review",
        "root review body",
    );
    write_skill(workspace.path(), "alpha", "Alpha workflow", "alpha body");
    write_skill(&middle, "review", "Middle review", "middle review body");
    write_skill(&active, "review", "Leaf review", "leaf review body");

    let tool = WorkspaceTool::open(workspace.path()).expect("workspace capability");
    let (_, _, skills) = tool
        .derive_scope_with_context("projects/active")
        .expect("context snapshot");

    assert_eq!(skills.discovered_count(), 4);
    assert_eq!(skills.effective_count(), 2);
    assert_eq!(
        skills.inventory(),
        "- $alpha: \"Alpha workflow\"\n- $review: \"Leaf review\"\n"
    );
    let selection = skills
        .select(Some("use $review and then $alpha"))
        .expect("selected skills");
    let content = selection.content.expect("selected body");
    assert!(content.contains("leaf review body"));
    assert!(!content.contains("root review body"));
    assert!(!content.contains("middle review body"));
    assert!(content.find("$review").expect("review") < content.find("$alpha").expect("alpha"));
}

#[test]
fn wrong_case_filename_is_not_a_skill_and_invalid_content_fails_closed() {
    let workspace = tempfile::tempdir().expect("workspace");
    let wrong_case = workspace.path().join(".agents/skills/ignored/skill.md");
    fs::create_dir_all(wrong_case.parent().expect("skill parent")).expect("skill directory");
    fs::write(
        wrong_case,
        "---\nname: ignored\ndescription: ignored\n---\nbody\n",
    )
    .expect("wrong case");
    let tool = WorkspaceTool::open(workspace.path()).expect("workspace capability");
    let (_, _, skills) = tool.derive_scope_with_context(".").expect("empty skills");
    assert_eq!(skills.effective_count(), 0);

    let invalid = workspace.path().join(".agents/skills/broken/SKILL.md");
    fs::create_dir_all(invalid.parent().expect("skill parent")).expect("skill directory");
    fs::write(&invalid, b"---\nname: broken\ndescription: bad\n---\n\0").expect("invalid skill");
    assert!(matches!(
        tool.derive_scope_with_context("."),
        Err(sugarcode_tools::WorkspaceScopeContextErrorKind::Skills(
            WorkspaceSkillsErrorKind::InvalidEncoding
        ))
    ));
}

#[test]
fn file_and_selection_limits_fail_without_truncation() {
    let workspace = tempfile::tempdir().expect("workspace");
    let path = workspace.path().join(".agents/skills/large/SKILL.md");
    fs::create_dir_all(path.parent().expect("skill parent")).expect("skill directory");
    fs::write(&path, vec![b'x'; MAX_WORKSPACE_SKILL_BYTES + 1]).expect("oversized skill");
    let tool = WorkspaceTool::open(workspace.path()).expect("workspace capability");
    assert!(matches!(
        tool.derive_scope_with_context("."),
        Err(sugarcode_tools::WorkspaceScopeContextErrorKind::Skills(
            WorkspaceSkillsErrorKind::FileTooLarge
        ))
    ));

    let workspace = tempfile::tempdir().expect("workspace");
    for name in ["one", "two", "three", "four", "five"] {
        write_skill(workspace.path(), name, name, "body");
    }
    let tool = WorkspaceTool::open(workspace.path()).expect("workspace capability");
    let (_, _, skills) = tool.derive_scope_with_context(".").expect("skills");
    assert_eq!(
        skills.select(Some("$one $two $three $four $five")),
        Err(WorkspaceSkillSelectionErrorKind::TooManySkills)
    );
}

#[test]
fn discovery_count_entry_aggregate_and_inventory_limits_fail_closed() {
    let workspace = tempfile::tempdir().expect("workspace");
    for index in 0..65 {
        let name = format!("skill-{index}");
        write_skill(workspace.path(), &name, &name, "body");
    }
    let tool = WorkspaceTool::open(workspace.path()).expect("workspace capability");
    assert!(matches!(
        tool.derive_scope_with_context("."),
        Err(sugarcode_tools::WorkspaceScopeContextErrorKind::Skills(
            WorkspaceSkillsErrorKind::TooManySkills
        ))
    ));

    let workspace = tempfile::tempdir().expect("workspace");
    let skills_root = workspace.path().join(".agents/skills");
    fs::create_dir_all(&skills_root).expect("skills root");
    for index in 0..257 {
        fs::write(skills_root.join(format!("entry-{index}")), "").expect("root entry");
    }
    let tool = WorkspaceTool::open(workspace.path()).expect("workspace capability");
    assert!(matches!(
        tool.derive_scope_with_context("."),
        Err(sugarcode_tools::WorkspaceScopeContextErrorKind::Skills(
            WorkspaceSkillsErrorKind::TooManyEntries
        ))
    ));

    let workspace = tempfile::tempdir().expect("workspace");
    let frontmatter = "---\nname: ";
    for index in 0..33 {
        let name = format!("skill-{index}");
        let prefix = format!("{frontmatter}{name}\ndescription: {name}\n---\n");
        let body = "x".repeat(MAX_WORKSPACE_SKILL_BYTES - prefix.len() - 1);
        write_skill(workspace.path(), &name, &name, &body);
    }
    let tool = WorkspaceTool::open(workspace.path()).expect("workspace capability");
    assert!(matches!(
        tool.derive_scope_with_context("."),
        Err(sugarcode_tools::WorkspaceScopeContextErrorKind::Skills(
            WorkspaceSkillsErrorKind::AggregateTooLarge
        ))
    ));

    let workspace = tempfile::tempdir().expect("workspace");
    let escaped_description = "\\".repeat(1024);
    for index in 0..49 {
        let name = format!("skill-{index}");
        write_skill(workspace.path(), &name, &escaped_description, "body");
    }
    let tool = WorkspaceTool::open(workspace.path()).expect("workspace capability");
    assert!(matches!(
        tool.derive_scope_with_context("."),
        Err(sugarcode_tools::WorkspaceScopeContextErrorKind::Skills(
            WorkspaceSkillsErrorKind::InventoryTooLarge
        ))
    ));
}

#[cfg(unix)]
#[test]
fn linked_skill_directories_are_rejected() {
    use std::os::unix::fs::symlink;

    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    write_skill(outside.path(), "linked", "Linked", "outside body");
    let root = workspace.path().join(".agents/skills");
    fs::create_dir_all(&root).expect("skills root");
    symlink(
        outside.path().join(".agents/skills/linked"),
        root.join("linked"),
    )
    .expect("linked skill directory");
    let tool = WorkspaceTool::open(workspace.path()).expect("workspace capability");
    assert!(matches!(
        tool.derive_scope_with_context("."),
        Err(sugarcode_tools::WorkspaceScopeContextErrorKind::Skills(
            WorkspaceSkillsErrorKind::PathNotAllowed
        ))
    ));
}

#[cfg(windows)]
#[test]
fn reparse_point_skill_directories_are_rejected() {
    use std::os::windows::fs::symlink_dir;

    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    write_skill(outside.path(), "linked", "Linked", "outside body");
    let root = workspace.path().join(".agents/skills");
    fs::create_dir_all(&root).expect("skills root");
    symlink_dir(
        outside.path().join(".agents/skills/linked"),
        root.join("linked"),
    )
    .expect("Skill directory reparse point");
    let tool = WorkspaceTool::open(workspace.path()).expect("workspace capability");
    assert!(matches!(
        tool.derive_scope_with_context("."),
        Err(sugarcode_tools::WorkspaceScopeContextErrorKind::Skills(
            WorkspaceSkillsErrorKind::PathNotAllowed
        ))
    ));
}

#[test]
fn hard_linked_skill_files_are_rejected() {
    let workspace = tempfile::tempdir().expect("workspace");
    let root = workspace.path().join(".agents/skills");
    write_skill(workspace.path(), "linked", "Linked", "body");
    fs::hard_link(
        root.join("linked/SKILL.md"),
        workspace.path().join("skill-copy.md"),
    )
    .expect("hard link");
    let tool = WorkspaceTool::open(workspace.path()).expect("workspace capability");
    assert!(matches!(
        tool.derive_scope_with_context("."),
        Err(sugarcode_tools::WorkspaceScopeContextErrorKind::Skills(
            WorkspaceSkillsErrorKind::HardLinkNotAllowed
        ))
    ));
}
