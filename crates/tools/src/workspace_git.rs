use crate::WorkspaceTool;
use crate::workspace_capability::FileSnapshot;
use crate::workspace_capability::WorkspaceRootReopen;
use crate::workspace_capability::open_directory_component;
use crate::workspace_capability::open_regular_file_nofollow_with_limit;
use crate::workspace_capability::validate_relative_path;
use git2::DiffFormat;
use git2::DiffOptions;
use git2::ErrorCode;
use git2::IndexEntry;
use git2::IndexTime;
use git2::Repository;
use git2::RepositoryState;
use git2::Status;
use git2::StatusOptions;
use sha2::Digest;
use sha2::Sha256;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;

pub const MAX_GIT_STATUS_ENTRIES: usize = 1_000;
pub const MAX_GIT_STATUS_PATH_BYTES: usize = 256 * 1_024;
pub const MAX_GIT_DIFF_BYTES: usize = 512 * 1_024;
pub const MAX_GIT_DIFF_LINES: usize = 20_000;
pub const MAX_GIT_MUTATION_PATHS: usize = 100;
pub const MAX_GIT_MUTATION_BYTES: usize = 64 * 1_024 * 1_024;
pub const MAX_GIT_COMMIT_MESSAGE_BYTES: usize = 64 * 1_024;
pub const MAX_GIT_IDENTITY_BYTES: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    TypeChanged,
    Conflicted,
    Untracked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitRepositoryState {
    Clean,
    Merge,
    Revert,
    RevertSequence,
    CherryPick,
    CherryPickSequence,
    Bisect,
    Rebase,
    RebaseInteractive,
    RebaseMerge,
    ApplyMailbox,
    ApplyMailboxOrRebase,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitStatusEntry {
    pub path: String,
    pub index: Option<GitChangeKind>,
    pub worktree: Option<GitChangeKind>,
    pub stageable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitStatus {
    pub revision: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub repository_state: GitRepositoryState,
    pub mutation_allowed: bool,
    pub entries: Vec<GitStatusEntry>,
    pub staged_count: usize,
    pub unstaged_count: usize,
    pub unsupported_paths: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitDiffSource {
    Worktree,
    Index,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitDiffArguments {
    pub expected_revision: String,
    pub path: String,
    pub source: GitDiffSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitDiff {
    pub revision: String,
    pub path: String,
    pub source: GitDiffSource,
    pub content: String,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitMutationArguments {
    pub expected_revision: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitMutationReceipt {
    pub revision: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitCommitArguments {
    pub expected_revision: String,
    pub message: String,
    pub author_name: String,
    pub author_email: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitCommitReceipt {
    pub revision: String,
    pub old_head: String,
    pub new_head: String,
}

struct StableGitFile {
    bytes: Vec<u8>,
    executable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitErrorKind {
    NotRepository,
    UnsupportedRepository,
    InvalidPath,
    Stale,
    NothingToCommit,
    TooLarge,
    UnsupportedPath,
    Unborn,
    Detached,
    RepositoryState,
    IndexLocked,
    Changed,
    Unavailable,
}

impl WorkspaceTool {
    pub fn git_status(&self) -> Result<GitStatus, GitErrorKind> {
        let repository = self.open_git_repository()?;
        self.collect_git_status(&repository)
    }

    pub fn git_diff(&self, arguments: &GitDiffArguments) -> Result<GitDiff, GitErrorKind> {
        validate_git_path(&arguments.path)?;
        let repository = self.open_git_repository()?;
        let status = self.collect_git_status(&repository)?;
        if status.revision != arguments.expected_revision {
            return Err(GitErrorKind::Stale);
        }
        if !status
            .entries
            .iter()
            .any(|entry| entry.path == arguments.path)
        {
            return Err(GitErrorKind::InvalidPath);
        }

        let mut options = DiffOptions::new();
        options
            .context_lines(3)
            .include_typechange(true)
            .include_untracked(true)
            .recurse_untracked_dirs(true)
            .show_untracked_content(true)
            .pathspec(&arguments.path);
        let diff = match arguments.source {
            GitDiffSource::Worktree => {
                let index = repository.index().map_err(map_git_error)?;
                repository
                    .diff_index_to_workdir(Some(&index), Some(&mut options))
                    .map_err(map_git_error)?
            }
            GitDiffSource::Index => {
                let head = repository.head().map_err(map_head_error)?;
                let tree = head.peel_to_tree().map_err(map_head_error)?;
                let index = repository.index().map_err(map_git_error)?;
                repository
                    .diff_tree_to_index(Some(&tree), Some(&index), Some(&mut options))
                    .map_err(map_git_error)?
            }
        };
        if diff.deltas().any(|delta| delta.flags().is_binary()) {
            return Err(GitErrorKind::UnsupportedPath);
        }

        let mut bytes = Vec::new();
        let mut additions = 0usize;
        let mut deletions = 0usize;
        let mut lines = 0usize;
        let mut too_large = false;
        diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
            lines += 1;
            match line.origin() {
                '+' => additions += 1,
                '-' => deletions += 1,
                _ => {}
            }
            let origin = line.origin();
            if origin != 'F' && origin != 'H' && origin != 'B' {
                bytes.push(origin as u8);
            }
            bytes.extend_from_slice(line.content());
            if bytes.len() > MAX_GIT_DIFF_BYTES || lines > MAX_GIT_DIFF_LINES {
                too_large = true;
                return false;
            }
            true
        })
        .map_err(map_git_error)?;
        if too_large {
            return Err(GitErrorKind::TooLarge);
        }
        let content = String::from_utf8(bytes).map_err(|_| GitErrorKind::UnsupportedPath)?;
        Ok(GitDiff {
            revision: status.revision,
            path: arguments.path.clone(),
            source: arguments.source,
            content,
            additions,
            deletions,
        })
    }

    pub fn git_stage(
        &self,
        arguments: &GitMutationArguments,
    ) -> Result<GitMutationReceipt, GitErrorKind> {
        let repository = self.open_git_repository()?;
        let status = self.verify_mutation(&repository, arguments)?;
        let mut index = repository.index().map_err(map_git_error)?;
        let mut total_bytes = 0usize;

        for path in &arguments.paths {
            let entry = status
                .entries
                .iter()
                .find(|entry| entry.path == *path)
                .ok_or(GitErrorKind::InvalidPath)?;
            if !entry.stageable {
                return Err(GitErrorKind::UnsupportedPath);
            }
            if matches!(entry.worktree, Some(GitChangeKind::Deleted)) {
                match index.remove_path(Path::new(path)) {
                    Ok(()) => {}
                    Err(error) if error.code() == ErrorCode::NotFound => {}
                    Err(error) => return Err(map_git_error(error)),
                }
                continue;
            }

            let file = self.read_stable_git_file(path, MAX_GIT_MUTATION_BYTES)?;
            total_bytes = total_bytes
                .checked_add(file.bytes.len())
                .ok_or(GitErrorKind::TooLarge)?;
            if total_bytes > MAX_GIT_MUTATION_BYTES {
                return Err(GitErrorKind::TooLarge);
            }
            let index_entry = build_index_entry(path, file.bytes.len(), file.executable)?;
            index
                .add_frombuffer(&index_entry, &file.bytes)
                .map_err(map_git_error)?;
        }
        index.write().map_err(map_git_error)?;
        let next = self.collect_git_status(&repository)?;
        Ok(GitMutationReceipt {
            revision: next.revision,
            paths: arguments.paths.clone(),
        })
    }

    pub fn git_unstage(
        &self,
        arguments: &GitMutationArguments,
    ) -> Result<GitMutationReceipt, GitErrorKind> {
        let repository = self.open_git_repository()?;
        let status = self.verify_mutation(&repository, arguments)?;
        if status.head.is_none() {
            return Err(GitErrorKind::Unborn);
        }
        let object = repository
            .head()
            .and_then(|head| head.peel(git2::ObjectType::Commit))
            .map_err(map_head_error)?;
        repository
            .reset_default(Some(&object), arguments.paths.iter().map(Path::new))
            .map_err(map_git_error)?;
        let next = self.collect_git_status(&repository)?;
        Ok(GitMutationReceipt {
            revision: next.revision,
            paths: arguments.paths.clone(),
        })
    }

    pub fn git_commit(
        &self,
        arguments: &GitCommitArguments,
    ) -> Result<GitCommitReceipt, GitErrorKind> {
        validate_commit_arguments(arguments)?;
        let repository = self.open_git_repository()?;
        let status = self.collect_git_status(&repository)?;
        if status.revision != arguments.expected_revision {
            return Err(GitErrorKind::Stale);
        }
        if status.repository_state != GitRepositoryState::Clean {
            return Err(GitErrorKind::RepositoryState);
        }
        if status.branch.is_none() {
            return Err(if status.head.is_some() {
                GitErrorKind::Detached
            } else {
                GitErrorKind::Unborn
            });
        }
        if status.staged_count == 0 {
            return Err(GitErrorKind::NothingToCommit);
        }

        let head = repository.head().map_err(map_head_error)?;
        let reference_name = head.name().ok_or(GitErrorKind::Detached)?.to_string();
        let old_oid = head.target().ok_or(GitErrorKind::Detached)?;
        let parent = repository.find_commit(old_oid).map_err(map_git_error)?;
        let mut index = repository.index().map_err(map_git_error)?;
        let tree_oid = index.write_tree().map_err(map_git_error)?;
        let tree = repository.find_tree(tree_oid).map_err(map_git_error)?;
        if tree.id() == parent.tree_id() {
            return Err(GitErrorKind::NothingToCommit);
        }
        let signature = git2::Signature::now(&arguments.author_name, &arguments.author_email)
            .map_err(|_| GitErrorKind::InvalidPath)?;
        let commit_oid = repository
            .commit(
                None,
                &signature,
                &signature,
                arguments.message.trim(),
                &tree,
                &[&parent],
            )
            .map_err(map_git_error)?;
        repository
            .reference_matching(
                &reference_name,
                commit_oid,
                true,
                old_oid,
                &format!("commit: {}", commit_subject(&arguments.message)),
            )
            .map_err(|error| {
                if error.code() == ErrorCode::Modified {
                    GitErrorKind::Stale
                } else {
                    map_git_error(error)
                }
            })?;
        let next = self.collect_git_status(&repository)?;
        Ok(GitCommitReceipt {
            revision: next.revision,
            old_head: old_oid.to_string(),
            new_head: commit_oid.to_string(),
        })
    }

    fn open_git_repository(&self) -> Result<Repository, GitErrorKind> {
        let WorkspaceRootReopen::AmbientPath(root) = &self.root_reopen else {
            return Err(GitErrorKind::UnsupportedRepository);
        };
        let git_metadata = std::fs::symlink_metadata(root.join(".git"))
            .map_err(|_| GitErrorKind::NotRepository)?;
        if !git_metadata.is_dir() || git_metadata.file_type().is_symlink() {
            return Err(GitErrorKind::UnsupportedRepository);
        }
        let repository = Repository::open(root).map_err(|error| {
            if error.code() == ErrorCode::NotFound {
                GitErrorKind::NotRepository
            } else {
                map_git_error(error)
            }
        })?;
        if repository.is_bare() || repository.is_worktree() {
            return Err(GitErrorKind::UnsupportedRepository);
        }
        let root_canonical = std::fs::canonicalize(root).map_err(|_| GitErrorKind::Unavailable)?;
        let workdir = repository
            .workdir()
            .ok_or(GitErrorKind::UnsupportedRepository)?;
        let workdir_canonical =
            std::fs::canonicalize(workdir).map_err(|_| GitErrorKind::Unavailable)?;
        let gitdir_canonical =
            std::fs::canonicalize(repository.path()).map_err(|_| GitErrorKind::Unavailable)?;
        let expected_gitdir =
            std::fs::canonicalize(root.join(".git")).map_err(|_| GitErrorKind::Unavailable)?;
        if workdir_canonical != root_canonical || gitdir_canonical != expected_gitdir {
            return Err(GitErrorKind::UnsupportedRepository);
        }
        Ok(repository)
    }

    fn collect_git_status(&self, repository: &Repository) -> Result<GitStatus, GitErrorKind> {
        let repository_state = map_repository_state(repository.state());
        let mut options = StatusOptions::new();
        options
            .include_untracked(true)
            .recurse_untracked_dirs(true)
            .include_unmodified(false)
            .include_ignored(false)
            .renames_head_to_index(true)
            .renames_index_to_workdir(true);
        let statuses = repository
            .statuses(Some(&mut options))
            .map_err(map_git_error)?;
        if statuses.len() > MAX_GIT_STATUS_ENTRIES {
            return Err(GitErrorKind::TooLarge);
        }
        let mut entries = Vec::with_capacity(statuses.len());
        let mut total_path_bytes = 0usize;
        let mut unsupported_paths = 0usize;
        for status_entry in statuses.iter() {
            let Some(path) = status_entry.path() else {
                unsupported_paths += 1;
                continue;
            };
            if validate_git_path(path).is_err() {
                unsupported_paths += 1;
                continue;
            }
            total_path_bytes += path.len();
            if total_path_bytes > MAX_GIT_STATUS_PATH_BYTES {
                return Err(GitErrorKind::TooLarge);
            }
            let raw = status_entry.status();
            let index = map_index_status(raw);
            let worktree = map_worktree_status(raw);
            let stageable = !raw.is_conflicted()
                && !matches!(
                    worktree,
                    Some(GitChangeKind::TypeChanged | GitChangeKind::Renamed)
                )
                && self.is_stageable_path(path, worktree)?;
            entries.push(GitStatusEntry {
                path: path.to_string(),
                index,
                worktree,
                stageable,
            });
        }
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        let branch = repository.head().ok().and_then(|head| {
            if head.is_branch() {
                head.shorthand().map(str::to_string)
            } else {
                None
            }
        });
        let head = repository
            .head()
            .ok()
            .and_then(|head| head.target())
            .map(|oid| oid.to_string());
        let staged_count = entries.iter().filter(|entry| entry.index.is_some()).count();
        let unstaged_count = entries
            .iter()
            .filter(|entry| entry.worktree.is_some())
            .count();
        let revision = self.git_revision(
            repository,
            repository_state,
            branch.as_deref(),
            head.as_deref(),
            &entries,
            unsupported_paths,
        )?;
        Ok(GitStatus {
            revision,
            branch,
            head,
            repository_state,
            mutation_allowed: repository_state == GitRepositoryState::Clean
                && unsupported_paths == 0,
            entries,
            staged_count,
            unstaged_count,
            unsupported_paths,
        })
    }

    fn git_revision(
        &self,
        repository: &Repository,
        state: GitRepositoryState,
        branch: Option<&str>,
        head: Option<&str>,
        entries: &[GitStatusEntry],
        unsupported_paths: usize,
    ) -> Result<String, GitErrorKind> {
        let mut hasher = Sha256::new();
        hasher.update(b"sugarcode-workspace-git-v1\0");
        hasher.update(format!(
            "{state:?}\0{branch:?}\0{head:?}\0{unsupported_paths}\0"
        ));
        let index = repository.index().map_err(map_git_error)?;
        for entry in index.iter() {
            hasher.update(entry.path);
            hasher.update(entry.id.as_bytes());
            hasher.update(entry.mode.to_le_bytes());
        }
        let mut total_hashed_bytes = 0usize;
        for entry in entries {
            hasher.update(entry.path.as_bytes());
            hasher.update(format!(
                "\0{:?}\0{:?}\0{}\0",
                entry.index, entry.worktree, entry.stageable
            ));
            if entry.worktree.is_some()
                && !matches!(entry.worktree, Some(GitChangeKind::Deleted))
                && entry.stageable
            {
                let file = self.read_stable_git_file(&entry.path, MAX_GIT_MUTATION_BYTES)?;
                total_hashed_bytes = total_hashed_bytes
                    .checked_add(file.bytes.len())
                    .ok_or(GitErrorKind::TooLarge)?;
                if total_hashed_bytes > MAX_GIT_MUTATION_BYTES {
                    return Err(GitErrorKind::TooLarge);
                }
                hasher.update([u8::from(file.executable)]);
                hasher.update(Sha256::digest(file.bytes));
            }
        }
        Ok(format!("{:x}", hasher.finalize()))
    }

    fn verify_mutation(
        &self,
        repository: &Repository,
        arguments: &GitMutationArguments,
    ) -> Result<GitStatus, GitErrorKind> {
        if arguments.paths.is_empty() || arguments.paths.len() > MAX_GIT_MUTATION_PATHS {
            return Err(GitErrorKind::InvalidPath);
        }
        let mut paths = arguments.paths.clone();
        paths.sort();
        if paths.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(GitErrorKind::InvalidPath);
        }
        for path in &arguments.paths {
            validate_git_path(path)?;
        }
        let status = self.collect_git_status(repository)?;
        if status.revision != arguments.expected_revision {
            return Err(GitErrorKind::Stale);
        }
        if !status.mutation_allowed {
            return Err(if status.repository_state != GitRepositoryState::Clean {
                GitErrorKind::RepositoryState
            } else {
                GitErrorKind::UnsupportedPath
            });
        }
        Ok(status)
    }

    fn is_stageable_path(
        &self,
        path: &str,
        worktree: Option<GitChangeKind>,
    ) -> Result<bool, GitErrorKind> {
        if matches!(worktree, Some(GitChangeKind::Deleted)) || worktree.is_none() {
            return Ok(true);
        }
        let components = validate_relative_path(path).map_err(|_| GitErrorKind::InvalidPath)?;
        let (name, parents) = components.split_last().ok_or(GitErrorKind::InvalidPath)?;
        let mut directory = self
            .root
            .try_clone()
            .map_err(|_| GitErrorKind::Unavailable)?;
        for component in parents {
            directory = open_directory_component(&directory, component)
                .map_err(|_| GitErrorKind::UnsupportedPath)?;
        }
        match directory.symlink_metadata(name) {
            Ok(metadata) => Ok(metadata.is_file() && !metadata.file_type().is_symlink()),
            Err(_) => Ok(false),
        }
    }

    fn read_stable_git_file(
        &self,
        path: &str,
        limit: usize,
    ) -> Result<StableGitFile, GitErrorKind> {
        let components = validate_relative_path(path).map_err(|_| GitErrorKind::InvalidPath)?;
        let (name, parents) = components.split_last().ok_or(GitErrorKind::InvalidPath)?;
        let mut directory = self
            .root
            .try_clone()
            .map_err(|_| GitErrorKind::Unavailable)?;
        for component in parents {
            directory = open_directory_component(&directory, component)
                .map_err(|_| GitErrorKind::UnsupportedPath)?;
        }
        let (mut file, opened) =
            open_regular_file_nofollow_with_limit(&directory, name, limit as u64)
                .map_err(|_| GitErrorKind::UnsupportedPath)?;
        if opened.links() != 1 {
            return Err(GitErrorKind::UnsupportedPath);
        }
        let mut bytes = Vec::with_capacity(opened.len() as usize);
        file.read_to_end(&mut bytes)
            .map_err(|_| GitErrorKind::Unavailable)?;
        let final_metadata = file.metadata().map_err(|_| GitErrorKind::Unavailable)?;
        let executable = is_executable(&final_metadata);
        let final_snapshot = FileSnapshot::from_file(&file, &final_metadata)
            .map_err(|_| GitErrorKind::Unavailable)?;
        let reopened = open_regular_file_nofollow_with_limit(&directory, name, limit as u64)
            .map(|(_, snapshot)| snapshot)
            .map_err(|_| GitErrorKind::Changed)?;
        if opened != final_snapshot || opened != reopened || bytes.len() as u64 != opened.len() {
            return Err(GitErrorKind::Changed);
        }
        Ok(StableGitFile { bytes, executable })
    }
}

fn validate_git_path(path: &str) -> Result<PathBuf, GitErrorKind> {
    validate_relative_path(path)
        .map(|components| components.into_iter().collect())
        .map_err(|_| GitErrorKind::InvalidPath)
}

fn map_index_status(status: Status) -> Option<GitChangeKind> {
    if status.is_conflicted() {
        Some(GitChangeKind::Conflicted)
    } else if status.contains(Status::INDEX_NEW) {
        Some(GitChangeKind::Added)
    } else if status.contains(Status::INDEX_MODIFIED) {
        Some(GitChangeKind::Modified)
    } else if status.contains(Status::INDEX_DELETED) {
        Some(GitChangeKind::Deleted)
    } else if status.contains(Status::INDEX_RENAMED) {
        Some(GitChangeKind::Renamed)
    } else if status.contains(Status::INDEX_TYPECHANGE) {
        Some(GitChangeKind::TypeChanged)
    } else {
        None
    }
}

fn map_worktree_status(status: Status) -> Option<GitChangeKind> {
    if status.is_conflicted() {
        Some(GitChangeKind::Conflicted)
    } else if status.contains(Status::WT_NEW) {
        Some(GitChangeKind::Untracked)
    } else if status.contains(Status::WT_MODIFIED) {
        Some(GitChangeKind::Modified)
    } else if status.contains(Status::WT_DELETED) {
        Some(GitChangeKind::Deleted)
    } else if status.contains(Status::WT_RENAMED) {
        Some(GitChangeKind::Renamed)
    } else if status.contains(Status::WT_TYPECHANGE) {
        Some(GitChangeKind::TypeChanged)
    } else {
        None
    }
}

fn map_repository_state(state: RepositoryState) -> GitRepositoryState {
    match state {
        RepositoryState::Clean => GitRepositoryState::Clean,
        RepositoryState::Merge => GitRepositoryState::Merge,
        RepositoryState::Revert => GitRepositoryState::Revert,
        RepositoryState::RevertSequence => GitRepositoryState::RevertSequence,
        RepositoryState::CherryPick => GitRepositoryState::CherryPick,
        RepositoryState::CherryPickSequence => GitRepositoryState::CherryPickSequence,
        RepositoryState::Bisect => GitRepositoryState::Bisect,
        RepositoryState::Rebase => GitRepositoryState::Rebase,
        RepositoryState::RebaseInteractive => GitRepositoryState::RebaseInteractive,
        RepositoryState::RebaseMerge => GitRepositoryState::RebaseMerge,
        RepositoryState::ApplyMailbox => GitRepositoryState::ApplyMailbox,
        RepositoryState::ApplyMailboxOrRebase => GitRepositoryState::ApplyMailboxOrRebase,
    }
}

fn build_index_entry(
    path: &str,
    file_len: usize,
    executable: bool,
) -> Result<IndexEntry, GitErrorKind> {
    let mode = if executable { 0o100755 } else { 0o100644 };
    Ok(IndexEntry {
        ctime: IndexTime::new(0, 0),
        mtime: IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        mode,
        uid: 0,
        gid: 0,
        file_size: u32::try_from(file_len).map_err(|_| GitErrorKind::TooLarge)?,
        id: git2::Oid::zero(),
        flags: 0,
        flags_extended: 0,
        path: path.as_bytes().to_vec(),
    })
}

#[cfg(unix)]
fn is_executable(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_metadata: &std::fs::Metadata) -> bool {
    false
}

fn validate_commit_arguments(arguments: &GitCommitArguments) -> Result<(), GitErrorKind> {
    let message = arguments.message.trim();
    if message.is_empty()
        || message.len() > MAX_GIT_COMMIT_MESSAGE_BYTES
        || arguments.author_name.is_empty()
        || arguments.author_email.is_empty()
        || arguments.author_name.len() > MAX_GIT_IDENTITY_BYTES
        || arguments.author_email.len() > MAX_GIT_IDENTITY_BYTES
        || arguments.author_name.chars().any(char::is_control)
        || arguments.author_email.chars().any(char::is_control)
    {
        return Err(GitErrorKind::InvalidPath);
    }
    Ok(())
}

fn commit_subject(message: &str) -> &str {
    message.lines().next().unwrap_or("commit").trim()
}

fn map_head_error(error: git2::Error) -> GitErrorKind {
    if error.code() == ErrorCode::UnbornBranch || error.code() == ErrorCode::NotFound {
        GitErrorKind::Unborn
    } else {
        map_git_error(error)
    }
}

fn map_git_error(error: git2::Error) -> GitErrorKind {
    match error.code() {
        ErrorCode::Locked => GitErrorKind::IndexLocked,
        ErrorCode::Modified => GitErrorKind::Stale,
        ErrorCode::NotFound => GitErrorKind::NotRepository,
        _ => GitErrorKind::Unavailable,
    }
}

#[cfg(test)]
#[path = "tests/workspace_git.rs"]
mod tests;
