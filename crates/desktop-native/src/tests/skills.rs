use serde_json::Value;
use std::fs;
use std::fs::File;
use std::io::Write;
use std::path::Path;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

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
    assert_eq!(inspection["skills"].as_array().map(Vec::len), Some(7));
    for name in [
        "video-production",
        "figma",
        "figma-code-connect",
        "figma-design-to-code",
        "figma-selection-context",
    ] {
        let bundled = inspection["skills"]
            .as_array()
            .and_then(|skills| skills.iter().find(|skill| skill["name"] == name))
            .expect("bundled Skill");
        assert_eq!(bundled["source"], "bundled");
        assert_eq!(bundled["enabled"], true);
    }
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
    assert_eq!(context["skills"].as_array().map(Vec::len), Some(6));
    assert!(
        context["skills"]
            .as_array()
            .is_some_and(|skills| skills.iter().any(|skill| skill["name"] == "testing"))
    );

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
            )
            .expect("import personal Skill"),
    );
    let imported_id = after_import["skills"]
        .as_array()
        .and_then(|skills| skills.iter().find(|skill| skill["name"] == "imported"))
        .and_then(|skill| skill["id"].as_str())
        .expect("imported Skill id")
        .to_owned();
    assert!(data.path().join("skills/imported/SKILL.md").is_file());

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

#[test]
fn native_bundled_figma_skill_can_be_disabled_and_exported() {
    let data = tempfile::tempdir().expect("data directory");
    let runtime =
        NativeRuntime::open(data.path().to_string_lossy().into_owned()).expect("native runtime");
    let inspection = json(
        runtime
            .inspect_skills_json(None)
            .expect("inspect bundled Skills"),
    );
    let skill = inspection["skills"]
        .as_array()
        .and_then(|skills| {
            skills
                .iter()
                .find(|skill| skill["name"] == "figma-design-to-code")
        })
        .expect("bundled design-to-code Skill");
    let skill_id = skill["id"].as_str().expect("bundled Skill id").to_owned();

    let disabled = json(
        runtime
            .set_skill_enabled_json(None, skill_id.clone(), false)
            .expect("disable bundled Skill"),
    );
    assert_eq!(
        disabled["skills"]
            .as_array()
            .and_then(|skills| skills.iter().find(|skill| skill["id"] == skill_id))
            .and_then(|skill| skill["enabled"].as_bool()),
        Some(false)
    );

    let destination = tempfile::tempdir().expect("export destination");
    runtime
        .export_skill_json(
            None,
            skill_id,
            destination.path().to_string_lossy().into_owned(),
        )
        .expect("export bundled Skill");
    let exported = fs::read_to_string(destination.path().join("figma-design-to-code/SKILL.md"))
        .expect("read exported bundled Skill");
    assert!(exported.contains("name: figma-design-to-code"));
}

#[test]
fn native_bundled_video_skill_requires_stable_remotion_rendering() {
    let data = tempfile::tempdir().expect("data directory");
    let runtime =
        NativeRuntime::open(data.path().to_string_lossy().into_owned()).expect("native runtime");
    let inspection = json(
        runtime
            .inspect_skills_json(None)
            .expect("inspect bundled Skills"),
    );
    let skill = inspection["skills"]
        .as_array()
        .and_then(|skills| {
            skills
                .iter()
                .find(|skill| skill["name"] == "video-production")
        })
        .expect("bundled video Skill");
    let skill_id = skill["id"].as_str().expect("bundled Skill id").to_owned();
    let skill_sha = skill["sha256"]
        .as_str()
        .expect("bundled Skill hash")
        .to_owned();

    let content = json(
        runtime
            .read_skill_content_json(None, skill_id, skill_sha)
            .expect("read bundled video Skill"),
    );
    let instructions = content["content"]
        .as_str()
        .expect("video Skill instructions");
    assert!(instructions.contains("--concurrency=1"));
    assert!(instructions.contains("isolated single-frame luminance outliers"));
    assert!(instructions.contains("system-installed Chrome or Chromium"));
    assert!(instructions.contains("at most one tool call"));
    assert!(instructions.contains("standalone JSON object"));
    assert!(instructions.contains("quick playback card"));
    assert!(instructions.contains("::preview{path=\"renders/final.mp4\"}"));
    assert!(instructions.contains("video_runtime_prepare"));
    assert!(instructions.contains("video_render"));
    assert!(instructions.contains("video_voiceover"));
    assert!(instructions.contains("video_audio_mix"));
    assert!(instructions.contains("do not install Remotion packages into the project"));
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

#[test]
fn native_skill_zip_rejects_path_traversal_before_extraction() {
    let data = tempfile::tempdir().expect("data directory");
    let archive_path = data.path().join("traversal.zip");
    let file = File::create(&archive_path).expect("archive file");
    let mut archive = ZipWriter::new(file);
    archive
        .start_file("../SKILL.md", SimpleFileOptions::default())
        .expect("unsafe entry");
    archive
        .write_all(b"---\nname: escaped\ndescription: escaped\n---\n")
        .expect("unsafe content");
    archive.finish().expect("finish archive");
    let runtime =
        NativeRuntime::open(data.path().to_string_lossy().into_owned()).expect("native runtime");

    let error = runtime
        .import_skill_zip_json(None, archive_path.to_string_lossy().into_owned())
        .expect_err("path traversal must be rejected");
    assert!(error.to_string().contains("unsafe path"));
    assert!(!data.path().join("SKILL.md").exists());
}

#[test]
fn native_skill_zip_rejects_highly_compressed_expansion_bombs() {
    let data = tempfile::tempdir().expect("data directory");
    let archive_path = data.path().join("bomb.zip");
    let file = File::create(&archive_path).expect("archive file");
    let mut archive = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    archive
        .start_file("bomb/SKILL.md", options)
        .expect("Skill entry");
    archive
        .write_all(b"---\nname: bomb\ndescription: bomb\n---\n")
        .expect("Skill header");
    let block = vec![b'a'; 1024 * 1024];
    for _ in 0..17 {
        archive.write_all(&block).expect("compressed payload");
    }
    archive.finish().expect("finish archive");
    assert!(fs::metadata(&archive_path).expect("archive metadata").len() < 16 * 1024 * 1024);
    let runtime =
        NativeRuntime::open(data.path().to_string_lossy().into_owned()).expect("native runtime");

    let error = runtime
        .import_skill_zip_json(None, archive_path.to_string_lossy().into_owned())
        .expect_err("expansion bomb must be rejected");
    assert!(error.to_string().contains("expands beyond"));
    assert!(!data.path().join("skills/bomb").exists());
}
