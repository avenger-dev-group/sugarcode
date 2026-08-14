use git2::{Repository, Signature};
use serde_json::Value;
use std::fs;
use std::path::Path;

use super::NativeRuntime;

fn commit_project(repository_root: &Path) {
    let repository = Repository::init(repository_root).expect("initialize repository");
    let mut index = repository.index().expect("repository index");
    index
        .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
        .expect("add project files");
    let tree_id = index.write_tree().expect("write tree");
    let tree = repository.find_tree(tree_id).expect("find tree");
    let signature = Signature::now("SugarCode", "fixture@example.com").expect("signature");
    repository
        .commit(Some("HEAD"), &signature, &signature, "Initial", &tree, &[])
        .expect("initial commit");
}

fn project_config(value: &str) -> String {
    format!(
        r#"{{
          "schemaVersion": 1,
          "setup": {{ "default": "printf setup > setup-marker.txt" }},
          "environment": {{ "default": "export SUGARCODE_PROJECT_VALUE={value}" }},
          "actions": [{{
            "id": "verify",
            "label": "Verify",
            "command": {{ "default": "printf 'verified:%s:%s' \"$SUGARCODE_PROJECT_VALUE\" \"$PWD\"" }}
          }}]
        }}"#,
    )
}

#[tokio::test]
async fn trusted_project_environment_and_worktrees_stay_task_isolated() {
    let data_directory = tempfile::tempdir().expect("data directory");
    let repository_root = tempfile::tempdir().expect("repository root");
    fs::create_dir(repository_root.path().join(".sugarcode")).expect("config directory");
    fs::write(
        repository_root.path().join(".sugarcode/project.json"),
        project_config("one"),
    )
    .expect("project environment config");
    fs::write(repository_root.path().join("README.md"), "fixture\n").expect("fixture file");
    commit_project(repository_root.path());

    let runtime = NativeRuntime::open(data_directory.path().to_string_lossy().into_owned())
        .expect("native runtime");
    runtime
        .ensure_workspace(
            "workspace-1".to_owned(),
            repository_root.path().to_string_lossy().into_owned(),
        )
        .expect("workspace");
    for thread_id in ["thread-local", "thread-worktree"] {
        runtime
            .ensure_thread(thread_id.to_owned(), "workspace-1".to_owned(), None)
            .expect("thread");
    }

    let inspection: Value = serde_json::from_str(
        &runtime
            .inspect_project_environment_json(
                "workspace-1".to_owned(),
                Some("thread-worktree".to_owned()),
            )
            .await
            .expect("inspect project environment"),
    )
    .expect("inspection JSON");
    assert_eq!(inspection["state"], "trustRequired");
    assert_eq!(inspection["actions"][0]["id"], "verify");
    let config_hash = inspection["configHash"]
        .as_str()
        .expect("config hash")
        .to_owned();
    runtime
        .trust_project_environment_json(
            "workspace-1".to_owned(),
            config_hash,
            Some("thread-worktree".to_owned()),
        )
        .await
        .expect("trust project environment");

    let worktree_binding: Value = serde_json::from_str(
        &runtime
            .set_task_workspace_mode_json(
                "workspace-1".to_owned(),
                "thread-worktree".to_owned(),
                "worktree".to_owned(),
            )
            .expect("create task worktree"),
    )
    .expect("worktree JSON");
    let worktree_root = worktree_binding["workspace"]["root"]
        .as_str()
        .expect("worktree root")
        .to_owned();
    assert_ne!(Path::new(&worktree_root), repository_root.path());

    let result: Value = serde_json::from_str(
        &runtime
            .execute_command_json(
                "operation-worktree".to_owned(),
                "workspace-1".to_owned(),
                "thread-worktree".to_owned(),
                "fullAccess".to_owned(),
                "printf '%s|%s' \"$SUGARCODE_PROJECT_VALUE\" \"$PWD\"".to_owned(),
                "[]".to_owned(),
                ".".to_owned(),
                15_000,
            )
            .await
            .expect("execute task command"),
    )
    .expect("command JSON");
    assert_eq!(result["status"], "completed", "command failed: {result}");
    let output = result["output"]["stdout"].as_str().expect("stdout");
    assert_eq!(output, format!("one|{worktree_root}"));
    assert!(Path::new(&worktree_root).join("setup-marker.txt").is_file());
    assert!(!repository_root.path().join("setup-marker.txt").exists());

    let action: Value = serde_json::from_str(
        &runtime
            .run_project_environment_action_json(
                "workspace-1".to_owned(),
                "thread-worktree".to_owned(),
                "verify".to_owned(),
            )
            .await
            .expect("run project action"),
    )
    .expect("action JSON");
    assert_eq!(action["accepted"], true, "action rejected: {action}");
    assert_eq!(action["status"], "completed");
    assert_eq!(
        action["output"]["stdout"],
        format!("verified:one:{worktree_root}")
    );

    fs::write(
        repository_root.path().join(".sugarcode/project.json"),
        project_config("two"),
    )
    .expect("changed project config");
    let local_inspection: Value = serde_json::from_str(
        &runtime
            .inspect_project_environment_json(
                "workspace-1".to_owned(),
                Some("thread-local".to_owned()),
            )
            .await
            .expect("inspect local task"),
    )
    .expect("local inspection JSON");
    let worktree_inspection: Value = serde_json::from_str(
        &runtime
            .inspect_project_environment_json(
                "workspace-1".to_owned(),
                Some("thread-worktree".to_owned()),
            )
            .await
            .expect("inspect worktree task"),
    )
    .expect("worktree inspection JSON");
    assert_eq!(local_inspection["state"], "trustRequired");
    assert_eq!(worktree_inspection["state"], "trusted");
}
