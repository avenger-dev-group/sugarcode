mod persistence;

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

use napi::Error;
use napi::bindgen_prelude::Result;
use napi_derive::napi;
use serde_json::json;
use sugarcode_tools::GitChangeKind;
use sugarcode_tools::GitCommitArguments;
use sugarcode_tools::GitDiffArguments;
use sugarcode_tools::GitDiffSource;
use sugarcode_tools::GitErrorKind;
use sugarcode_tools::GitMutationArguments;
use sugarcode_tools::GitRepositoryState;
use sugarcode_tools::WorkspaceChangeSetCommitOutcome;
use sugarcode_tools::WorkspaceChangeSetPrepareOutcome;
use sugarcode_tools::WorkspaceListArguments;
use sugarcode_tools::WorkspaceListOutcome;
use sugarcode_tools::WorkspaceReadArguments;
use sugarcode_tools::WorkspaceReadErrorKind;
use sugarcode_tools::WorkspaceReadOutcome;
use sugarcode_tools::WorkspaceSearchArguments;
use sugarcode_tools::WorkspaceSearchOutcome;
use sugarcode_tools::WorkspaceTool;
use tokio_util::sync::CancellationToken;

use persistence::Store;

#[napi]
pub struct NativeRuntime {
    store: Mutex<Store>,
    workspaces: Mutex<HashMap<String, Arc<WorkspaceTool>>>,
}

#[napi]
impl NativeRuntime {
    #[napi(constructor)]
    pub fn open(data_directory: String) -> Result<Self> {
        let store = Store::open(data_directory).map_err(native_error)?;
        Ok(Self {
            store: Mutex::new(store),
            workspaces: Mutex::new(HashMap::new()),
        })
    }

    #[napi]
    pub fn ensure_workspace(&self, workspace_id: String, canonical_root: String) -> Result<()> {
        let workspace = Arc::new(WorkspaceTool::open(Path::new(&canonical_root)).map_err(
            |kind| Error::from_reason(format!("Could not open workspace root: {kind:?}.")),
        )?);
        self.with_store(|store| store.ensure_workspace(&workspace_id, &canonical_root))?;
        self.workspaces
            .lock()
            .map_err(|_| Error::from_reason("Native workspace lock was poisoned."))?
            .insert(workspace_id, workspace);
        Ok(())
    }

    #[napi]
    pub fn ensure_thread(
        &self,
        thread_id: String,
        workspace_id: String,
        title: Option<String>,
    ) -> Result<()> {
        self.with_store(|store| store.ensure_thread(&thread_id, &workspace_id, title.as_deref()))
    }

    #[napi]
    pub fn create_thread_json(
        &self,
        workspace_id: String,
        title: Option<String>,
    ) -> Result<String> {
        self.with_store(|store| store.create_thread_json(&workspace_id, title.as_deref()))
    }

    #[napi]
    pub fn list_threads_json(&self, workspace_id: String, query: Option<String>) -> Result<String> {
        self.with_store(|store| store.list_threads_json(&workspace_id, query.as_deref()))
    }

    #[napi]
    pub fn set_thread_archived_json(
        &self,
        thread_id: String,
        workspace_id: String,
        archived: bool,
    ) -> Result<String> {
        self.with_store(|store| store.set_thread_archived_json(&thread_id, &workspace_id, archived))
    }

    #[napi]
    pub fn delete_thread(&self, thread_id: String, workspace_id: String) -> Result<bool> {
        self.with_store(|store| store.delete_thread(&thread_id, &workspace_id))
    }

    #[napi]
    pub fn fork_thread_json(&self, thread_id: String, workspace_id: String) -> Result<String> {
        self.with_store(|store| store.fork_thread_json(&thread_id, &workspace_id))
    }

    #[napi]
    pub fn start_turn(
        &self,
        turn_id: String,
        thread_id: String,
        request_id: String,
        provider_wire_api: String,
        model: String,
    ) -> Result<()> {
        self.with_store(|store| {
            store.start_turn(
                &turn_id,
                &thread_id,
                &request_id,
                &provider_wire_api,
                &model,
            )
        })
    }

    #[napi]
    pub fn append_item(
        &self,
        item_id: String,
        turn_id: String,
        sequence: u32,
        kind: String,
        payload_json: String,
    ) -> Result<bool> {
        self.with_store(|store| {
            store.append_item(
                &item_id,
                &turn_id,
                i64::from(sequence),
                &kind,
                &payload_json,
            )
        })
    }

    #[napi]
    pub fn finish_turn(
        &self,
        turn_id: String,
        status: String,
        error_json: Option<String>,
    ) -> Result<bool> {
        self.with_store(|store| store.finish_turn(&turn_id, &status, error_json.as_deref()))
    }

    #[napi]
    pub fn propose_operation(
        &self,
        operation_id: String,
        approval_id: String,
        turn_id: String,
        tool_name: String,
        request_hash: String,
        arguments_json: String,
    ) -> Result<bool> {
        self.with_store(|store| {
            store.propose_operation(
                &operation_id,
                &approval_id,
                &turn_id,
                &tool_name,
                &request_hash,
                &arguments_json,
            )
        })
    }

    #[napi]
    pub fn resolve_approval(&self, approval_id: String, decision: String) -> Result<bool> {
        self.with_store(|store| store.resolve_approval(&approval_id, &decision))
    }

    #[napi]
    pub fn complete_operation(
        &self,
        operation_id: String,
        result_json: String,
        succeeded: bool,
    ) -> Result<bool> {
        self.with_store(|store| store.complete_operation(&operation_id, &result_json, succeeded))
    }

    #[napi]
    pub fn load_thread_json(&self, thread_id: String) -> Result<String> {
        self.with_store(|store| store.load_thread_json(&thread_id))
    }

    #[napi]
    pub fn inspect_model_config_json(&self) -> Result<String> {
        self.with_store(Store::inspect_model_config_json)
    }

    #[napi]
    pub fn save_model_config_json(
        &self,
        expected_revision: String,
        config_json: String,
        credential_updates_json: String,
    ) -> Result<String> {
        self.with_store(|store| {
            store.save_model_config_json(&expected_revision, &config_json, &credential_updates_json)
        })
    }

    #[napi]
    pub fn delete_model_api_key_json(
        &self,
        connection_id: String,
        expected_revision: String,
    ) -> Result<String> {
        self.with_store(|store| store.delete_model_api_key_json(&connection_id, &expected_revision))
    }

    #[napi]
    pub fn model_connection_json(&self, connection_id: String) -> Result<String> {
        self.with_store(|store| store.model_connection_json(&connection_id))
    }

    #[napi]
    pub fn model_profile_json(&self, profile_id: Option<String>) -> Result<String> {
        self.with_store(|store| store.model_profile_json(profile_id.as_deref()))
    }

    #[napi]
    pub async fn workspace_apply_patch(
        &self,
        workspace_id: String,
        patch: String,
    ) -> Result<String> {
        let workspace = self.workspace(&workspace_id)?;
        let cancellation = CancellationToken::new();
        let prepared = match workspace
            .prepare_freeform_patch(&patch, &cancellation)
            .await
        {
            WorkspaceChangeSetPrepareOutcome::Prepared(prepared) => prepared,
            WorkspaceChangeSetPrepareOutcome::Error {
                operation_index,
                kind,
            } => {
                return serde_json::to_string(&json!({
                    "ok": false,
                    "error": format!("{kind:?}"),
                    "operationIndex": operation_index,
                }))
                .map_err(|error| Error::from_reason(error.to_string()));
            }
            WorkspaceChangeSetPrepareOutcome::ValidationRejected {
                operation_index,
                kind,
                diagnostic,
            } => {
                return serde_json::to_string(&json!({
                    "ok": false,
                    "error": format!("{kind:?}"),
                    "operationIndex": operation_index,
                    "diagnostic": {
                        "editIndex": diagnostic.edit_index,
                        "hunkIndex": diagnostic.hunk_index,
                        "line": diagnostic.line,
                        "expectedSummary": diagnostic.expected_summary,
                        "actualSummary": diagnostic.actual_summary,
                        "suggestedAction": diagnostic.suggested_action,
                    },
                }))
                .map_err(|error| Error::from_reason(error.to_string()));
            }
        };
        let value = match workspace.commit_change_set(prepared, &cancellation).await {
            WorkspaceChangeSetCommitOutcome::Applied { receipts } => json!({
                "ok": true,
                "files": receipts.into_iter().map(|receipt| json!({
                    "path": receipt.path,
                    "kind": receipt.kind.as_str(),
                    "beforeSha256": receipt.before_sha256,
                    "afterSha256": receipt.after_sha256,
                    "beforeBytes": receipt.before_bytes,
                    "afterBytes": receipt.after_bytes,
                })).collect::<Vec<_>>(),
            }),
            WorkspaceChangeSetCommitOutcome::Error { kind } => {
                json!({ "ok": false, "error": format!("{kind:?}") })
            }
        };
        serde_json::to_string(&value).map_err(|error| Error::from_reason(error.to_string()))
    }

    #[napi]
    pub fn git_status_json(&self, workspace_id: String) -> Result<String> {
        let workspace = self.workspace(&workspace_id)?;
        let value = match workspace.git_status() {
            Ok(status) => {
                let mut value = json!({
                    "status": "ready",
                    "revision": status.revision,
                    "repositoryState": git_repository_state(status.repository_state),
                    "mutationAllowed": status.mutation_allowed,
                    "entries": status.entries.into_iter().map(|entry| {
                        let mut value = json!({
                            "path": entry.path,
                            "stageable": entry.stageable,
                        });
                        if let Some(kind) = entry.index {
                            value["index"] = json!(git_change_kind(kind));
                        }
                        if let Some(kind) = entry.worktree {
                            value["worktree"] = json!(git_change_kind(kind));
                        }
                        value
                    }).collect::<Vec<_>>(),
                    "stagedCount": status.staged_count,
                    "unstagedCount": status.unstaged_count,
                    "unsupportedPaths": status.unsupported_paths,
                });
                if let Some(branch) = status.branch {
                    value["branch"] = json!(branch);
                }
                if let Some(head) = status.head {
                    value["head"] = json!(head);
                }
                value
            }
            Err(kind) => git_error(kind),
        };
        json_string(value)
    }

    #[napi]
    pub fn git_diff_json(
        &self,
        workspace_id: String,
        expected_revision: String,
        path: String,
        source: String,
    ) -> Result<String> {
        let workspace = self.workspace(&workspace_id)?;
        let source_value = match source.as_str() {
            "worktree" => GitDiffSource::Worktree,
            "index" => GitDiffSource::Index,
            _ => return Err(Error::from_reason("Git diff source is invalid.")),
        };
        let value = match workspace.git_diff(&GitDiffArguments {
            expected_revision,
            path,
            source: source_value,
        }) {
            Ok(diff) => json!({
                "status": "ready",
                "revision": diff.revision,
                "path": diff.path,
                "source": match diff.source {
                    GitDiffSource::Worktree => "worktree",
                    GitDiffSource::Index => "index",
                },
                "content": diff.content,
                "additions": diff.additions,
                "deletions": diff.deletions,
            }),
            Err(kind) => git_error(kind),
        };
        json_string(value)
    }

    #[napi]
    pub fn git_mutate_json(
        &self,
        workspace_id: String,
        expected_revision: String,
        paths: Vec<String>,
        stage: bool,
    ) -> Result<String> {
        let workspace = self.workspace(&workspace_id)?;
        let arguments = GitMutationArguments {
            expected_revision,
            paths,
        };
        let outcome = if stage {
            workspace.git_stage(&arguments)
        } else {
            workspace.git_unstage(&arguments)
        };
        let value = match outcome {
            Ok(receipt) => json!({
                "status": "applied",
                "revision": receipt.revision,
                "paths": receipt.paths,
            }),
            Err(kind) => git_error(kind),
        };
        json_string(value)
    }

    #[napi]
    pub fn git_commit_json(
        &self,
        workspace_id: String,
        expected_revision: String,
        message: String,
        author_name: String,
        author_email: String,
    ) -> Result<String> {
        let workspace = self.workspace(&workspace_id)?;
        let value = match workspace.git_commit(&GitCommitArguments {
            expected_revision,
            message,
            author_name,
            author_email,
        }) {
            Ok(receipt) => json!({
                "status": "committed",
                "revision": receipt.revision,
                "oldHead": receipt.old_head,
                "newHead": receipt.new_head,
            }),
            Err(kind) => git_error(kind),
        };
        json_string(value)
    }

    #[napi]
    pub async fn workspace_read(&self, workspace_id: String, path: String) -> Result<String> {
        let workspace = self.workspace(&workspace_id)?;
        let outcome = workspace
            .read(&WorkspaceReadArguments { path }, &CancellationToken::new())
            .await;
        let value = match outcome {
            WorkspaceReadOutcome::Content { content, bytes } => {
                json!({ "ok": true, "content": content, "bytes": bytes })
            }
            WorkspaceReadOutcome::Error { kind } => {
                json!({ "ok": false, "error": read_error_code(kind) })
            }
        };
        serde_json::to_string(&value).map_err(|error| Error::from_reason(error.to_string()))
    }

    #[napi]
    pub async fn workspace_list(&self, workspace_id: String, path: String) -> Result<String> {
        let workspace = self.workspace(&workspace_id)?;
        let outcome = workspace
            .list(&WorkspaceListArguments { path }, &CancellationToken::new())
            .await;
        let value = match outcome {
            WorkspaceListOutcome::Entries {
                entries,
                name_bytes,
            } => json!({
                "ok": true,
                "entries": entries.into_iter().map(|entry| json!({
                    "name": entry.name,
                    "kind": entry.kind.as_str(),
                })).collect::<Vec<_>>(),
                "nameBytes": name_bytes,
            }),
            WorkspaceListOutcome::Error { kind } => {
                json!({ "ok": false, "error": format!("{kind:?}") })
            }
        };
        serde_json::to_string(&value).map_err(|error| Error::from_reason(error.to_string()))
    }

    #[napi]
    pub async fn workspace_search(
        &self,
        workspace_id: String,
        path: String,
        query: String,
    ) -> Result<String> {
        let workspace = self.workspace(&workspace_id)?;
        let outcome = workspace
            .search(
                &WorkspaceSearchArguments { path, query },
                &CancellationToken::new(),
            )
            .await;
        let value = match outcome {
            WorkspaceSearchOutcome::Matches { matches, truncated } => json!({
                "ok": true,
                "matches": matches.into_iter().map(|entry| json!({
                    "path": entry.path,
                    "line": entry.line,
                })).collect::<Vec<_>>(),
                "truncated": truncated,
            }),
            WorkspaceSearchOutcome::Error { kind } => {
                json!({ "ok": false, "error": format!("{kind:?}") })
            }
        };
        serde_json::to_string(&value).map_err(|error| Error::from_reason(error.to_string()))
    }
}

impl NativeRuntime {
    fn workspace(&self, workspace_id: &str) -> Result<Arc<WorkspaceTool>> {
        self.workspaces
            .lock()
            .map_err(|_| Error::from_reason("Native workspace lock was poisoned."))?
            .get(workspace_id)
            .cloned()
            .ok_or_else(|| Error::from_reason(format!("Workspace {workspace_id} is not open.")))
    }

    fn with_store<T>(
        &self,
        operation: impl FnOnce(&mut Store) -> persistence::Result<T>,
    ) -> Result<T> {
        let mut store = self
            .store
            .lock()
            .map_err(|_| Error::from_reason("Native runtime database lock was poisoned."))?;
        operation(&mut store).map_err(native_error)
    }
}

const fn read_error_code(kind: WorkspaceReadErrorKind) -> &'static str {
    match kind {
        WorkspaceReadErrorKind::InvalidPath => "invalidPath",
        WorkspaceReadErrorKind::NotFound => "notFound",
        WorkspaceReadErrorKind::AccessDenied => "accessDenied",
        WorkspaceReadErrorKind::PathNotAllowed => "pathNotAllowed",
        WorkspaceReadErrorKind::NotRegularFile => "notRegularFile",
        WorkspaceReadErrorKind::FileTooLarge => "fileTooLarge",
        WorkspaceReadErrorKind::BinaryFile => "binaryFile",
        WorkspaceReadErrorKind::ChangedDuringRead => "changedDuringRead",
        WorkspaceReadErrorKind::Cancelled => "cancelled",
        WorkspaceReadErrorKind::Unavailable => "unavailable",
    }
}

fn native_error(error: persistence::PersistenceError) -> Error {
    Error::from_reason(error.to_string())
}

fn json_string(value: serde_json::Value) -> Result<String> {
    serde_json::to_string(&value).map_err(|error| Error::from_reason(error.to_string()))
}

const fn git_change_kind(kind: GitChangeKind) -> &'static str {
    match kind {
        GitChangeKind::Added => "added",
        GitChangeKind::Modified => "modified",
        GitChangeKind::Deleted => "deleted",
        GitChangeKind::Renamed => "renamed",
        GitChangeKind::TypeChanged => "typeChanged",
        GitChangeKind::Conflicted => "conflicted",
        GitChangeKind::Untracked => "untracked",
    }
}

const fn git_repository_state(state: GitRepositoryState) -> &'static str {
    match state {
        GitRepositoryState::Clean => "clean",
        GitRepositoryState::Merge => "merge",
        GitRepositoryState::Revert => "revert",
        GitRepositoryState::RevertSequence => "revertSequence",
        GitRepositoryState::CherryPick => "cherryPick",
        GitRepositoryState::CherryPickSequence => "cherryPickSequence",
        GitRepositoryState::Bisect => "bisect",
        GitRepositoryState::Rebase => "rebase",
        GitRepositoryState::RebaseInteractive => "rebaseInteractive",
        GitRepositoryState::RebaseMerge => "rebaseMerge",
        GitRepositoryState::ApplyMailbox => "applyMailbox",
        GitRepositoryState::ApplyMailboxOrRebase => "applyMailboxOrRebase",
    }
}

fn git_error(kind: GitErrorKind) -> serde_json::Value {
    let kind = match kind {
        GitErrorKind::NotRepository => "notRepository",
        GitErrorKind::UnsupportedRepository => "unsupportedRepository",
        GitErrorKind::InvalidPath => "invalidPath",
        GitErrorKind::Stale => "stale",
        GitErrorKind::NothingToCommit => "nothingToCommit",
        GitErrorKind::TooLarge => "tooLarge",
        GitErrorKind::UnsupportedPath => "unsupportedPath",
        GitErrorKind::Unborn => "unborn",
        GitErrorKind::Detached => "detached",
        GitErrorKind::RepositoryState => "repositoryState",
        GitErrorKind::IndexLocked => "indexLocked",
        GitErrorKind::Changed => "changed",
        GitErrorKind::Unavailable => "unavailable",
    };
    json!({ "status": "error", "kind": kind })
}

#[cfg(test)]
#[path = "tests/persistence.rs"]
mod persistence_tests;
