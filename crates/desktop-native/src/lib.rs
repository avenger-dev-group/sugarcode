mod persistence;

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

use napi::Error;
use napi::bindgen_prelude::Result;
use napi_derive::napi;
use serde_json::json;
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

#[cfg(test)]
#[path = "tests/persistence.rs"]
mod persistence_tests;
