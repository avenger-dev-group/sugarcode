use super::*;

#[test]
fn skill_mutation_before_final_validation_is_rejected() {
    let workspace = tempfile::tempdir().expect("workspace");
    let scope = workspace.path().join("projects/active");
    let skill = workspace.path().join(".agents/skills/review/SKILL.md");
    std::fs::create_dir_all(skill.parent().expect("skill parent")).expect("skill directory");
    std::fs::create_dir_all(&scope).expect("scope");
    std::fs::write(
        &skill,
        "---\nname: review\ndescription: Review code\n---\nfirst body\n",
    )
    .expect("skill");
    let tool = crate::WorkspaceTool::open(workspace.path()).expect("workspace capability");

    let result = tool.derive_scope_with_context_before_revalidate("projects/active", || {
        std::fs::write(
            &skill,
            "---\nname: review\ndescription: Review code\n---\nsecond body\n",
        )
        .expect("replace skill");
    });

    assert!(matches!(
        result,
        Err(WorkspaceScopeContextErrorKind::Skills(
            WorkspaceSkillsErrorKind::ChangedDuringDiscovery
        ))
    ));
}

#[test]
fn known_markers_select_at_most_once_in_first_mention_order() {
    let snapshot = WorkspaceSkillsSnapshot {
        skills: vec![
            WorkspaceSkill {
                name: "alpha".to_string(),
                description: "Alpha".to_string(),
                content: "alpha body".to_string(),
                bytes: 10,
                sha256: "a".repeat(64),
            },
            WorkspaceSkill {
                name: "beta".to_string(),
                description: "Beta".to_string(),
                content: "beta body".to_string(),
                bytes: 9,
                sha256: "b".repeat(64),
            },
        ],
        inventory: "- $alpha: \"Alpha\"\n- $beta: \"Beta\"\n".to_string(),
        discovered_count: 2,
        source_bytes: 19,
        manifest_sha256: "c".repeat(64),
    };

    let selected = snapshot
        .select(Some(
            "use $beta, then $alpha and $beta again; ignore $missing",
        ))
        .expect("selection");
    let content = selected.content.expect("selected content");
    assert_eq!(selected.selected_count, 2);
    assert!(content.find("$beta").expect("beta") < content.find("$alpha").expect("alpha"));
    assert_eq!(content.matches("$beta").count(), 1);
}
