use git2::{ErrorCode, Repository, WorktreeAddOptions};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskWorktree {
    pub root: PathBuf,
    pub branch: String,
    pub name: String,
}

pub fn create_task_worktree(
    repository_root: &Path,
    worktree_root: &Path,
    thread_id: &str,
) -> Result<TaskWorktree, String> {
    if thread_id.is_empty() || thread_id.len() > 512 {
        return Err("task identifier is invalid".to_owned());
    }
    let repository_root = std::fs::canonicalize(repository_root)
        .map_err(|error| format!("could not canonicalize repository root: {error}"))?;
    let repository = Repository::open(&repository_root)
        .map_err(|_| "task worktrees require a Git repository".to_owned())?;
    if repository.is_bare() || repository.is_worktree() {
        return Err("task worktrees require the main non-bare Git worktree".to_owned());
    }
    let workdir = repository
        .workdir()
        .and_then(|path| std::fs::canonicalize(path).ok())
        .ok_or_else(|| "Git repository workdir is unavailable".to_owned())?;
    if workdir != repository_root {
        return Err("the selected project must be the exact Git repository root".to_owned());
    }
    let mut hasher = Sha256::new();
    hasher.update(b"sugarcode-task-worktree-v1\0");
    hasher.update(thread_id.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    let suffix = &digest[..24];
    let name = format!("sugarcode-{suffix}");
    let branch = format!("sugarcode/{suffix}");
    let root = worktree_root.join(&name);
    if root.exists() {
        return validate_existing_worktree(&root, &branch, &name);
    }
    std::fs::create_dir_all(worktree_root)
        .map_err(|error| format!("could not create task worktree directory: {error}"))?;
    let commit = repository
        .head()
        .and_then(|head| head.peel_to_commit())
        .map_err(|_| "task worktrees require an existing HEAD commit".to_owned())?;
    let mut created_branch =
        repository
            .branch(&branch, &commit, false)
            .map_err(|error| match error.code() {
                ErrorCode::Exists => "the task worktree branch already exists".to_owned(),
                _ => format!("could not create task worktree branch: {error}"),
            })?;
    let reference = created_branch.get();
    let mut options = WorktreeAddOptions::new();
    options.reference(Some(reference));
    if let Err(error) = repository.worktree(&name, &root, Some(&options)) {
        let _ = created_branch.delete();
        return Err(format!("could not create task worktree: {error}"));
    }
    validate_existing_worktree(&root, &branch, &name)
}

fn validate_existing_worktree(
    root: &Path,
    expected_branch: &str,
    name: &str,
) -> Result<TaskWorktree, String> {
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|error| format!("could not reopen task worktree: {error}"))?;
    let repository = Repository::open(&canonical_root)
        .map_err(|_| "existing task worktree metadata is invalid".to_owned())?;
    let workdir = repository
        .workdir()
        .and_then(|path| std::fs::canonicalize(path).ok())
        .ok_or_else(|| "existing task worktree has no workdir".to_owned())?;
    let branch = repository
        .head()
        .ok()
        .and_then(|head| head.shorthand().map(str::to_owned))
        .ok_or_else(|| "existing task worktree has no branch".to_owned())?;
    if workdir != canonical_root || branch != expected_branch {
        return Err("existing task worktree does not match this task".to_owned());
    }
    Ok(TaskWorktree {
        root: canonical_root,
        branch,
        name: name.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Signature;

    #[test]
    fn creates_and_reopens_a_task_branch_worktree() {
        let temporary = tempfile::tempdir().expect("temporary root");
        let repository_root = temporary.path().join("repository");
        std::fs::create_dir(&repository_root).expect("repository directory");
        let repository = Repository::init(&repository_root).expect("repository");
        std::fs::write(repository_root.join("README.md"), "fixture\n").expect("fixture");
        let mut index = repository.index().expect("index");
        index.add_path(Path::new("README.md")).expect("add fixture");
        let tree_id = index.write_tree().expect("tree id");
        let tree = repository.find_tree(tree_id).expect("tree");
        let signature = Signature::now("SugarCode", "fixture@example.com").expect("signature");
        repository
            .commit(Some("HEAD"), &signature, &signature, "Initial", &tree, &[])
            .expect("commit");
        drop(tree);
        drop(index);

        let worktrees = temporary.path().join("worktrees");
        let created = create_task_worktree(&repository_root, &worktrees, "thread-one")
            .expect("task worktree");
        assert!(created.root.join("README.md").is_file());
        assert!(
            repository
                .find_branch(&created.branch, git2::BranchType::Local)
                .is_ok()
        );
        let tool = crate::WorkspaceTool::open(&created.root).expect("worktree workspace");
        assert!(tool.git_status().is_ok());
        assert_eq!(
            create_task_worktree(&repository_root, &worktrees, "thread-one")
                .expect("reopened worktree"),
            created
        );
    }
}
