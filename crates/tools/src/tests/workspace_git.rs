use super::*;
use std::fs;
use tempfile::TempDir;

fn repository_fixture() -> (TempDir, WorkspaceTool) {
    let directory = TempDir::new().expect("temporary repository");
    let repository = Repository::init(directory.path()).expect("initialize repository");
    fs::write(directory.path().join("tracked.txt"), "before\n").expect("write tracked file");
    let mut index = repository.index().expect("index");
    index
        .add_path(Path::new("tracked.txt"))
        .expect("stage initial file");
    index.write().expect("write initial index");
    let tree_oid = index.write_tree().expect("initial tree");
    let tree = repository.find_tree(tree_oid).expect("find initial tree");
    let signature =
        git2::Signature::now("SugarCode Test", "test@example.invalid").expect("test signature");
    repository
        .commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
        .expect("initial commit");
    drop(tree);
    drop(repository);
    let tool = WorkspaceTool::open(directory.path()).expect("workspace tool");
    (directory, tool)
}

#[test]
fn status_diff_stage_unstage_and_commit_are_revision_bound() {
    let (directory, tool) = repository_fixture();
    fs::write(directory.path().join("tracked.txt"), "after\n").expect("modify tracked file");
    fs::write(directory.path().join("new.txt"), "new\n").expect("write new file");

    let status = tool.git_status().expect("status");
    assert_eq!(status.entries.len(), 2);
    assert_eq!(status.staged_count, 0);
    assert_eq!(status.unstaged_count, 2);
    assert!(status.mutation_allowed);

    let diff = tool
        .git_diff(&GitDiffArguments {
            expected_revision: status.revision.clone(),
            path: "tracked.txt".to_string(),
            source: GitDiffSource::Worktree,
        })
        .expect("worktree diff");
    assert!(diff.content.contains("-before"));
    assert!(diff.content.contains("+after"));

    let staged = tool
        .git_stage(&GitMutationArguments {
            expected_revision: status.revision,
            paths: vec!["tracked.txt".to_string(), "new.txt".to_string()],
        })
        .expect("stage paths");
    assert_eq!(tool.git_status().expect("staged status").staged_count, 2);
    assert_eq!(
        tool.git_stage(&GitMutationArguments {
            expected_revision: "stale".to_string(),
            paths: vec!["tracked.txt".to_string()],
        }),
        Err(GitErrorKind::Stale)
    );

    let unstaged = tool
        .git_unstage(&GitMutationArguments {
            expected_revision: staged.revision,
            paths: vec!["new.txt".to_string()],
        })
        .expect("unstage path");
    let receipt = tool
        .git_commit(&GitCommitArguments {
            expected_revision: unstaged.revision,
            message: "update tracked file".to_string(),
            author_name: "SugarCode Test".to_string(),
            author_email: "test@example.invalid".to_string(),
        })
        .expect("commit staged index");
    let repository = Repository::open(directory.path()).expect("reopen repository");
    assert_eq!(
        repository
            .head()
            .expect("head")
            .target()
            .expect("head oid")
            .to_string(),
        receipt.new_head
    );
    let final_status = tool.git_status().expect("final status");
    assert_eq!(final_status.staged_count, 0);
    assert_eq!(final_status.unstaged_count, 1);
    assert_eq!(final_status.entries[0].path, "new.txt");
}

#[cfg(unix)]
#[test]
fn executable_mode_is_revision_bound_and_staged_from_the_stable_file() {
    use std::os::unix::fs::PermissionsExt;

    let (directory, tool) = repository_fixture();
    let path = directory.path().join("tracked.txt");
    fs::write(&path, "after\n").expect("modify tracked file");
    let non_executable = tool.git_status().expect("non-executable status");

    let mut permissions = fs::metadata(&path).expect("metadata").permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&path, permissions).expect("make executable");
    let executable = tool.git_status().expect("executable status");
    assert_ne!(non_executable.revision, executable.revision);
    assert_eq!(
        tool.git_stage(&GitMutationArguments {
            expected_revision: non_executable.revision,
            paths: vec!["tracked.txt".to_string()],
        }),
        Err(GitErrorKind::Stale)
    );

    tool.git_stage(&GitMutationArguments {
        expected_revision: executable.revision,
        paths: vec!["tracked.txt".to_string()],
    })
    .expect("stage executable");
    let repository = Repository::open(directory.path()).expect("repository");
    let entry = repository
        .index()
        .expect("index")
        .get_path(Path::new("tracked.txt"), 0)
        .expect("tracked entry");
    assert_eq!(entry.mode, 0o100755);
}

#[test]
fn exact_repository_root_is_required() {
    let (directory, _tool) = repository_fixture();
    fs::create_dir(directory.path().join("nested")).expect("nested directory");
    let nested = WorkspaceTool::open(&directory.path().join("nested")).expect("nested workspace");
    assert_eq!(nested.git_status(), Err(GitErrorKind::NotRepository));
}

#[test]
fn linked_worktree_metadata_is_rejected() {
    let directory = TempDir::new().expect("temporary workspace");
    fs::write(directory.path().join(".git"), "gitdir: elsewhere\n").expect("git file");
    let tool = WorkspaceTool::open(directory.path()).expect("workspace");
    assert_eq!(tool.git_status(), Err(GitErrorKind::UnsupportedRepository));
}
