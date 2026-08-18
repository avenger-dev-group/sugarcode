use serde_json::Value;
use std::fs;
use std::path::Path;

use super::NativeRuntime;

fn write_skill(root: &Path, name: &str, description: &str, body: &str) {
    fs::create_dir_all(root).expect("create Skill directory");
    fs::write(
        root.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {description}\n---\n\n{body}\n"),
    )
    .expect("write SKILL.md");
}

fn json(value: String) -> Value {
    serde_json::from_str(&value).expect("valid Skills JSON")
}

#[test]
fn native_skills_inventory_shadows_toggles_imports_and_exports() {
    let data = tempfile::tempdir().expect("data directory");
    let workspace = tempfile::tempdir().expect("workspace");
    write_skill(
        &data.path().join("skills/review"),
        "review",
        "Personal review",
        "Personal instructions.",
    );
    write_skill(
        &workspace.path().join(".agents/skills/review"),
        "review",
        "Project review",
        "Project instructions.",
    );
    write_skill(
        &workspace.path().join(".claude/skills/testing"),
        "testing",
        "Run focused tests",
        "Testing instructions.",
    );

    let runtime =
        NativeRuntime::open(data.path().to_string_lossy().into_owned()).expect("native runtime");
    runtime
        .ensure_workspace(
            "workspace-1".to_owned(),
            workspace.path().to_string_lossy().into_owned(),
        )
        .expect("register workspace");

    let inspection = json(
        runtime
            .inspect_skills_json(Some("workspace-1".to_owned()))
            .expect("inspect Skills"),
    );
    assert_eq!(inspection["workspaceAvailable"], true);
    assert_eq!(inspection["skills"].as_array().map(Vec::len), Some(2));
    let review = inspection["skills"]
        .as_array()
        .and_then(|skills| skills.iter().find(|skill| skill["name"] == "review"))
        .expect("effective review Skill");
    assert_eq!(review["description"], "Project review");
    assert_eq!(review["source"], "project");

    let review_id = review["id"].as_str().expect("review id").to_owned();
    let review_sha = review["sha256"].as_str().expect("review hash").to_owned();
    let content = json(
        runtime
            .read_skill_content_json(
                Some("workspace-1".to_owned()),
                review_id.clone(),
                review_sha.clone(),
            )
            .expect("read Skill"),
    );
    assert!(
        content["content"]
            .as_str()
            .is_some_and(|value| value.contains("Project instructions."))
    );

    runtime
        .set_skill_enabled_json(Some("workspace-1".to_owned()), review_id.clone(), false)
        .expect("disable Skill");
    let context = json(
        runtime
            .skills_context_json("workspace-1".to_owned())
            .expect("Skills context"),
    );
    assert_eq!(context["skills"].as_array().map(Vec::len), Some(1));
    assert_eq!(context["skills"][0]["name"], "testing");

    fs::write(
        workspace.path().join(".agents/skills/review/SKILL.md"),
        "---\nname: review\ndescription: Changed\n---\n\nChanged.\n",
    )
    .expect("change Skill");
    assert!(
        runtime
            .read_skill_content_json(Some("workspace-1".to_owned()), review_id, review_sha,)
            .is_err()
    );

    let imported = tempfile::tempdir().expect("import source");
    write_skill(
        imported.path(),
        "imported",
        "Imported Skill",
        "Imported instructions.",
    );
    let after_import = json(
        runtime
            .import_skill_json(
                Some("workspace-1".to_owned()),
                imported.path().to_string_lossy().into_owned(),
                "project".to_owned(),
            )
            .expect("import project Skill"),
    );
    let imported_id = after_import["skills"]
        .as_array()
        .and_then(|skills| skills.iter().find(|skill| skill["name"] == "imported"))
        .and_then(|skill| skill["id"].as_str())
        .expect("imported Skill id")
        .to_owned();
    assert!(
        workspace
            .path()
            .join(".sugarcode/skills/imported/SKILL.md")
            .is_file()
    );

    let destination = tempfile::tempdir().expect("export destination");
    let exported = json(
        runtime
            .export_skill_json(
                Some("workspace-1".to_owned()),
                imported_id,
                destination.path().to_string_lossy().into_owned(),
            )
            .expect("export Skill"),
    );
    assert_eq!(
        exported["path"],
        destination
            .path()
            .canonicalize()
            .expect("canonical export destination")
            .join("imported")
            .to_string_lossy()
            .as_ref()
    );
    assert!(destination.path().join("imported/SKILL.md").is_file());
}

#[cfg(unix)]
#[test]
fn native_skills_reject_project_roots_that_escape_through_symlinks() {
    use std::os::unix::fs::symlink;

    let data = tempfile::tempdir().expect("data directory");
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside directory");
    write_skill(
        &outside.path().join("skills/escaped"),
        "escaped",
        "Escaped Skill",
        "Must not load.",
    );
    symlink(outside.path(), workspace.path().join(".agents")).expect("symlink project root");
    let runtime =
        NativeRuntime::open(data.path().to_string_lossy().into_owned()).expect("native runtime");
    runtime
        .ensure_workspace(
            "workspace-1".to_owned(),
            workspace.path().to_string_lossy().into_owned(),
        )
        .expect("register workspace");

    assert!(
        runtime
            .inspect_skills_json(Some("workspace-1".to_owned()))
            .is_err()
    );
}
