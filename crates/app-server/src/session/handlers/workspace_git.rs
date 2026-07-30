use super::super::*;
use sugarcode_app_server_protocol::WorkspaceGitChangeKind as PublicChangeKind;
use sugarcode_app_server_protocol::WorkspaceGitDiffSource as PublicDiffSource;
use sugarcode_app_server_protocol::WorkspaceGitErrorKind as PublicErrorKind;
use sugarcode_app_server_protocol::WorkspaceGitRepositoryState as PublicRepositoryState;
use sugarcode_app_server_protocol::WorkspaceGitStatusEntry as PublicStatusEntry;
use sugarcode_tools::GitChangeKind;
use sugarcode_tools::GitDiffSource;
use sugarcode_tools::GitErrorKind;
use sugarcode_tools::GitRepositoryState;

impl<C> Session<C>
where
    C: CoreApi,
{
    pub(in crate::session) fn git_status(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> JsonRpcMessage {
        if parse_params::<WorkspaceGitStatusParams>(params).is_err() {
            return error(Some(id), ERROR_INVALID_PARAMS, "Invalid params", None);
        }
        let Some(workspace) = self.workspace.as_ref() else {
            return error(
                Some(id),
                ERROR_WORKSPACE_UNAVAILABLE,
                "Workspace unavailable",
                None,
            );
        };
        let result = match workspace.git_status() {
            Ok(status) => WorkspaceGitStatusResponse::Ready {
                revision: status.revision,
                branch: status.branch,
                head: status.head,
                repository_state: map_repository_state(status.repository_state),
                mutation_allowed: status.mutation_allowed,
                entries: status
                    .entries
                    .into_iter()
                    .map(|entry| PublicStatusEntry {
                        path: entry.path,
                        index: entry.index.map(map_change_kind),
                        worktree: entry.worktree.map(map_change_kind),
                        stageable: entry.stageable,
                    })
                    .collect(),
                staged_count: status.staged_count as u32,
                unstaged_count: status.unstaged_count as u32,
                unsupported_paths: status.unsupported_paths as u32,
            },
            Err(kind) => WorkspaceGitStatusResponse::Error {
                kind: map_error_kind(kind),
            },
        };
        git_response(id, result)
    }

    pub(in crate::session) fn git_diff(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> JsonRpcMessage {
        let params = match parse_params::<WorkspaceGitDiffParams>(params) {
            Ok(params) => params,
            Err(()) => return error(Some(id), ERROR_INVALID_PARAMS, "Invalid params", None),
        };
        let Some(workspace) = self.workspace.as_ref() else {
            return error(
                Some(id),
                ERROR_WORKSPACE_UNAVAILABLE,
                "Workspace unavailable",
                None,
            );
        };
        let result = match workspace.git_diff(&GitDiffArguments {
            expected_revision: params.expected_revision,
            path: params.path,
            source: match params.source {
                PublicDiffSource::Worktree => GitDiffSource::Worktree,
                PublicDiffSource::Index => GitDiffSource::Index,
            },
        }) {
            Ok(diff) => WorkspaceGitDiffResponse::Ready {
                revision: diff.revision,
                path: diff.path,
                source: match diff.source {
                    GitDiffSource::Worktree => PublicDiffSource::Worktree,
                    GitDiffSource::Index => PublicDiffSource::Index,
                },
                content: diff.content,
                additions: diff.additions as u32,
                deletions: diff.deletions as u32,
            },
            Err(kind) => WorkspaceGitDiffResponse::Error {
                kind: map_error_kind(kind),
            },
        };
        git_response(id, result)
    }

    pub(in crate::session) fn git_stage(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> JsonRpcMessage {
        self.git_mutation(id, params, true)
    }

    pub(in crate::session) fn git_unstage(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> JsonRpcMessage {
        self.git_mutation(id, params, false)
    }

    fn git_mutation(
        &mut self,
        id: RequestId,
        params: Option<Value>,
        stage: bool,
    ) -> JsonRpcMessage {
        let params = match parse_params::<WorkspaceGitMutationParams>(params) {
            Ok(params) => params,
            Err(()) => return error(Some(id), ERROR_INVALID_PARAMS, "Invalid params", None),
        };
        let Some(workspace) = self.workspace.as_ref() else {
            return error(
                Some(id),
                ERROR_WORKSPACE_UNAVAILABLE,
                "Workspace unavailable",
                None,
            );
        };
        let arguments = GitMutationArguments {
            expected_revision: params.expected_revision,
            paths: params.paths,
        };
        let result = if stage {
            workspace.git_stage(&arguments)
        } else {
            workspace.git_unstage(&arguments)
        };
        let response = match result {
            Ok(receipt) => WorkspaceGitMutationResponse::Applied {
                revision: receipt.revision,
                paths: receipt.paths,
            },
            Err(kind) => WorkspaceGitMutationResponse::Error {
                kind: map_error_kind(kind),
            },
        };
        git_response(id, response)
    }

    pub(in crate::session) fn git_commit(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> JsonRpcMessage {
        let params = match parse_params::<WorkspaceGitCommitParams>(params) {
            Ok(params) => params,
            Err(()) => return error(Some(id), ERROR_INVALID_PARAMS, "Invalid params", None),
        };
        let Some(workspace) = self.workspace.as_ref() else {
            return error(
                Some(id),
                ERROR_WORKSPACE_UNAVAILABLE,
                "Workspace unavailable",
                None,
            );
        };
        let result = match workspace.git_commit(&GitCommitArguments {
            expected_revision: params.expected_revision,
            message: params.message,
            author_name: params.author_name,
            author_email: params.author_email,
        }) {
            Ok(receipt) => WorkspaceGitCommitResponse::Committed {
                revision: receipt.revision,
                old_head: receipt.old_head,
                new_head: receipt.new_head,
            },
            Err(kind) => WorkspaceGitCommitResponse::Error {
                kind: map_error_kind(kind),
            },
        };
        git_response(id, result)
    }
}

fn parse_params<T: serde::de::DeserializeOwned>(params: Option<Value>) -> Result<T, ()> {
    params
        .ok_or(())
        .and_then(|value| serde_json::from_value(value).map_err(|_| ()))
}

fn git_response<T: serde::Serialize>(id: RequestId, result: T) -> JsonRpcMessage {
    JsonRpcMessage::Response(JsonRpcResponse {
        jsonrpc: JsonRpcVersion::V2,
        id,
        result: serde_json::to_value(result).expect("Git response must serialize"),
    })
}

fn map_change_kind(kind: GitChangeKind) -> PublicChangeKind {
    match kind {
        GitChangeKind::Added => PublicChangeKind::Added,
        GitChangeKind::Modified => PublicChangeKind::Modified,
        GitChangeKind::Deleted => PublicChangeKind::Deleted,
        GitChangeKind::Renamed => PublicChangeKind::Renamed,
        GitChangeKind::TypeChanged => PublicChangeKind::TypeChanged,
        GitChangeKind::Conflicted => PublicChangeKind::Conflicted,
        GitChangeKind::Untracked => PublicChangeKind::Untracked,
    }
}

fn map_repository_state(state: GitRepositoryState) -> PublicRepositoryState {
    match state {
        GitRepositoryState::Clean => PublicRepositoryState::Clean,
        GitRepositoryState::Merge => PublicRepositoryState::Merge,
        GitRepositoryState::Revert => PublicRepositoryState::Revert,
        GitRepositoryState::RevertSequence => PublicRepositoryState::RevertSequence,
        GitRepositoryState::CherryPick => PublicRepositoryState::CherryPick,
        GitRepositoryState::CherryPickSequence => PublicRepositoryState::CherryPickSequence,
        GitRepositoryState::Bisect => PublicRepositoryState::Bisect,
        GitRepositoryState::Rebase => PublicRepositoryState::Rebase,
        GitRepositoryState::RebaseInteractive => PublicRepositoryState::RebaseInteractive,
        GitRepositoryState::RebaseMerge => PublicRepositoryState::RebaseMerge,
        GitRepositoryState::ApplyMailbox => PublicRepositoryState::ApplyMailbox,
        GitRepositoryState::ApplyMailboxOrRebase => PublicRepositoryState::ApplyMailboxOrRebase,
    }
}

fn map_error_kind(kind: GitErrorKind) -> PublicErrorKind {
    match kind {
        GitErrorKind::NotRepository => PublicErrorKind::NotRepository,
        GitErrorKind::UnsupportedRepository => PublicErrorKind::UnsupportedRepository,
        GitErrorKind::InvalidPath => PublicErrorKind::InvalidPath,
        GitErrorKind::Stale => PublicErrorKind::Stale,
        GitErrorKind::NothingToCommit => PublicErrorKind::NothingToCommit,
        GitErrorKind::TooLarge => PublicErrorKind::TooLarge,
        GitErrorKind::UnsupportedPath => PublicErrorKind::UnsupportedPath,
        GitErrorKind::Unborn => PublicErrorKind::Unborn,
        GitErrorKind::Detached => PublicErrorKind::Detached,
        GitErrorKind::RepositoryState => PublicErrorKind::RepositoryState,
        GitErrorKind::IndexLocked => PublicErrorKind::IndexLocked,
        GitErrorKind::Changed => PublicErrorKind::Changed,
        GitErrorKind::Unavailable => PublicErrorKind::Unavailable,
    }
}
