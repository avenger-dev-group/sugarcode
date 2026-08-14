mod persistence;
mod skills;

use base64::Engine;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use napi::Error;
use napi::bindgen_prelude::Result;
use napi_derive::napi;
use serde_json::json;
use sugarcode_state::ContentAsset;
use sugarcode_state::ContentAssetKind;
use sugarcode_state::ContentStore;
use sugarcode_terminal::EmbeddedTerminal;
use sugarcode_tools::EmbeddedShellCommandExecutor;
use sugarcode_tools::FullAccessShellArguments;
use sugarcode_tools::GitChangeKind;
use sugarcode_tools::GitCommitArguments;
use sugarcode_tools::GitDiffArguments;
use sugarcode_tools::GitDiffSource;
use sugarcode_tools::GitErrorKind;
use sugarcode_tools::GitMutationArguments;
use sugarcode_tools::GitRepositoryState;
use sugarcode_tools::MAX_WORKSPACE_INSTRUCTIONS_BYTES;
use sugarcode_tools::ShellCommandArguments;
use sugarcode_tools::ShellCommandExecution;
use sugarcode_tools::ShellCommandExecutor;
use sugarcode_tools::ShellOutputChunk;
use sugarcode_tools::ShellOutputStream;
use sugarcode_tools::WorkspaceAdvancedSearchArguments;
use sugarcode_tools::WorkspaceAdvancedSearchOutcome;
use sugarcode_tools::WorkspaceChangeSetCommitOutcome;
use sugarcode_tools::WorkspaceChangeSetPrepareOutcome;
use sugarcode_tools::WorkspaceInspectArguments;
use sugarcode_tools::WorkspaceInspectErrorKind;
use sugarcode_tools::WorkspaceInspectOutcome;
use sugarcode_tools::WorkspaceInstructionsErrorKind;
use sugarcode_tools::WorkspaceInstructionsSnapshot;
use sugarcode_tools::WorkspaceListArguments;
use sugarcode_tools::WorkspaceListEntryKind;
use sugarcode_tools::WorkspaceListOutcome;
use sugarcode_tools::WorkspaceReadArguments;
use sugarcode_tools::WorkspaceReadErrorKind;
use sugarcode_tools::WorkspaceReadOutcome;
use sugarcode_tools::WorkspaceScopeInstructionsErrorKind;
use sugarcode_tools::WorkspaceSearchArguments;
use sugarcode_tools::WorkspaceSearchMode;
use sugarcode_tools::WorkspaceSearchOutcome;
use sugarcode_tools::WorkspaceTool;
use tokio_util::sync::CancellationToken;

use persistence::AssetRow;
use persistence::Store;

#[napi]
pub struct NativeRuntime {
    store: Mutex<Store>,
    content_store: ContentStore,
    workspaces: Mutex<HashMap<String, Arc<WorkspaceTool>>>,
    command_cancellations: Mutex<HashMap<String, CancellationToken>>,
    command_output: Arc<Mutex<HashMap<String, VecDeque<ShellOutputChunk>>>>,
    terminals: Mutex<HashMap<String, EmbeddedTerminal>>,
    skills_root: PathBuf,
}

#[napi]
impl NativeRuntime {
    #[napi(constructor)]
    pub fn open(data_directory: String) -> Result<Self> {
        let store = Store::open(&data_directory).map_err(native_error)?;
        let content_store = ContentStore::open_at(Path::new(&data_directory))
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let skills_root = Path::new(&data_directory).join("skills");
        std::fs::create_dir_all(&skills_root)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        Ok(Self {
            store: Mutex::new(store),
            content_store,
            workspaces: Mutex::new(HashMap::new()),
            command_cancellations: Mutex::new(HashMap::new()),
            command_output: Arc::new(Mutex::new(HashMap::new())),
            terminals: Mutex::new(HashMap::new()),
            skills_root,
        })
    }

    #[napi]
    pub fn inspect_skills_json(&self, workspace_id: Option<String>) -> Result<String> {
        let workspace = workspace_id
            .as_deref()
            .map(|workspace_id| self.workspace(workspace_id))
            .transpose()?;
        let preferences = self.with_store(Store::skill_preferences)?;
        skills::inspect_skills_json(
            &self.skills_root,
            workspace.as_deref().map(WorkspaceTool::canonical_root),
            &preferences,
        )
        .map_err(native_error_message)
    }

    #[napi]
    pub fn skills_context_json(&self, workspace_id: String) -> Result<String> {
        let workspace = self.workspace(&workspace_id)?;
        let preferences = self.with_store(Store::skill_preferences)?;
        skills::skills_context_json(
            &self.skills_root,
            Some(workspace.canonical_root()),
            &preferences,
        )
        .map_err(native_error_message)
    }

    #[napi]
    pub fn read_skill_content_json(
        &self,
        workspace_id: Option<String>,
        skill_id: String,
        expected_sha256: String,
    ) -> Result<String> {
        let workspace = workspace_id
            .as_deref()
            .map(|workspace_id| self.workspace(workspace_id))
            .transpose()?;
        let preferences = self.with_store(Store::skill_preferences)?;
        skills::read_skill_content_json(
            &self.skills_root,
            workspace.as_deref().map(WorkspaceTool::canonical_root),
            &preferences,
            &skill_id,
            &expected_sha256,
        )
        .map_err(native_error_message)
    }

    #[napi]
    pub fn set_skill_enabled_json(
        &self,
        workspace_id: Option<String>,
        skill_id: String,
        enabled: bool,
    ) -> Result<String> {
        let workspace = workspace_id
            .as_deref()
            .map(|workspace_id| self.workspace(workspace_id))
            .transpose()?;
        let preferences = self.with_store(Store::skill_preferences)?;
        skills::ensure_skill(
            &self.skills_root,
            workspace.as_deref().map(WorkspaceTool::canonical_root),
            &preferences,
            &skill_id,
        )
        .map_err(native_error_message)?;
        self.with_store(|store| store.set_skill_enabled(&skill_id, enabled))?;
        self.inspect_skills_json(workspace_id)
    }

    #[napi]
    pub fn import_skill_json(
        &self,
        workspace_id: Option<String>,
        source_path: String,
        scope: String,
    ) -> Result<String> {
        let workspace = workspace_id
            .as_deref()
            .map(|workspace_id| self.workspace(workspace_id))
            .transpose()?;
        skills::import_skill(
            &self.skills_root,
            workspace.as_deref().map(WorkspaceTool::canonical_root),
            Path::new(&source_path),
            &scope,
        )
        .map_err(native_error_message)?;
        self.inspect_skills_json(workspace_id)
    }

    #[napi]
    pub fn export_skill_json(
        &self,
        workspace_id: Option<String>,
        skill_id: String,
        destination_path: String,
    ) -> Result<String> {
        let workspace = workspace_id
            .as_deref()
            .map(|workspace_id| self.workspace(workspace_id))
            .transpose()?;
        let preferences = self.with_store(Store::skill_preferences)?;
        skills::export_skill(
            &self.skills_root,
            workspace.as_deref().map(WorkspaceTool::canonical_root),
            &preferences,
            &skill_id,
            Path::new(&destination_path),
        )
        .map(|value| value.to_string())
        .map_err(native_error_message)
    }

    #[napi]
    pub fn import_asset_json(
        &self,
        file_name: String,
        media_type: Option<String>,
        data: String,
    ) -> Result<String> {
        const MAX_BASE64_BYTES: usize = 27_962_032;
        if data.is_empty() || data.len() > MAX_BASE64_BYTES {
            return Err(Error::from_reason("Asset data is empty or too large."));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.as_bytes())
            .map_err(|_| Error::from_reason("Asset data is not valid Base64."))?;
        let asset = self
            .content_store
            .import(file_name, media_type.as_deref(), &bytes)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let row = asset_row(&asset);
        self.with_store(|store| store.record_asset(&row))?;
        serde_json::to_string(&row).map_err(|error| {
            Error::from_reason(format!("Could not encode asset metadata: {error}"))
        })
    }

    #[napi]
    pub fn inspect_mcp_config_json(&self) -> Result<String> {
        self.with_store(Store::inspect_mcp_config_json)
    }

    #[napi]
    pub fn save_mcp_config_json(
        &self,
        expected_revision: String,
        servers_json: String,
    ) -> Result<String> {
        self.with_store(|store| store.save_mcp_config_json(&expected_revision, &servers_json))
    }

    #[napi]
    pub fn read_asset_json(&self, asset_id: String) -> Result<String> {
        let row = self
            .with_store(|store| store.asset(&asset_id))?
            .ok_or_else(|| Error::from_reason("Content asset does not exist."))?;
        let asset = content_asset(&row)?;
        let bytes = self
            .content_store
            .read_verified(&asset)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        serde_json::to_string(&json!({
            "asset": row,
            "data": base64::engine::general_purpose::STANDARD.encode(bytes),
        }))
        .map_err(|error| Error::from_reason(format!("Could not encode asset content: {error}")))
    }

    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub async fn execute_command_json(
        &self,
        operation_id: String,
        workspace_id: String,
        mode: String,
        command: String,
        arguments_json: String,
        cwd: String,
        timeout_ms: u32,
    ) -> Result<String> {
        let arguments: Vec<String> = serde_json::from_str(&arguments_json)
            .map_err(|_| Error::from_reason("Command arguments must be a JSON string array."))?;
        let workspace = self.workspace(&workspace_id)?;
        let command_root = workspace.command_workspace_root().map_err(|kind| {
            Error::from_reason(format!("Could not bind command workspace root: {kind:?}."))
        })?;
        let executor = EmbeddedShellCommandExecutor::new(command_root)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let cancellation = CancellationToken::new();
        {
            let mut active = self.command_cancellations.lock().map_err(|_| {
                Error::from_reason("Native command cancellation lock was poisoned.")
            })?;
            if active.contains_key(&operation_id) {
                return Err(Error::from_reason(
                    "Command operation is already executing.",
                ));
            }
            active.insert(operation_id.clone(), cancellation.clone());
        }
        self.command_output
            .lock()
            .map_err(|_| Error::from_reason("Native command output lock was poisoned."))?
            .insert(operation_id.clone(), VecDeque::new());
        let execution = match mode.as_str() {
            "sandboxed" if cwd == "." => {
                executor
                    .execute(ShellCommandArguments { command, arguments }, cancellation)
                    .await
            }
            "fullAccess" if arguments.is_empty() => {
                let (output_tx, mut output_rx) = tokio::sync::mpsc::unbounded_channel();
                let output_store = Arc::clone(&self.command_output);
                let output_operation_id = operation_id.clone();
                let output_task = tokio::spawn(async move {
                    while let Some(chunk) = output_rx.recv().await {
                        if let Ok(mut outputs) = output_store.lock()
                            && let Some(queue) = outputs.get_mut(&output_operation_id)
                        {
                            queue.push_back(chunk);
                        }
                    }
                });
                let result = executor
                    .execute_full_access(
                        FullAccessShellArguments {
                            command,
                            cwd,
                            timeout_ms: u64::from(timeout_ms),
                            output_tx: Some(output_tx),
                        },
                        cancellation,
                    )
                    .await;
                let _ = output_task.await;
                result
            }
            _ => ShellCommandExecution::Error(
                sugarcode_tools::ShellCommandErrorKind::InvalidArguments,
            ),
        };
        self.command_cancellations
            .lock()
            .map_err(|_| Error::from_reason("Native command cancellation lock was poisoned."))?
            .remove(&operation_id);
        let value = match execution {
            ShellCommandExecution::Completed(output) => {
                json!({ "status": "completed", "mode": "sandboxed", "output": output })
            }
            ShellCommandExecution::FullAccessCompleted(output) => {
                json!({ "status": "completed", "mode": "fullAccess", "output": output })
            }
            ShellCommandExecution::Error(kind) => {
                json!({ "status": "error", "kind": kind.to_string() })
            }
            ShellCommandExecution::Cancelled => json!({ "status": "cancelled" }),
        };
        json_string(value)
    }

    #[napi]
    pub fn drain_command_output_json(&self, operation_id: String) -> Result<String> {
        let mut outputs = self
            .command_output
            .lock()
            .map_err(|_| Error::from_reason("Native command output lock was poisoned."))?;
        let Some(queue) = outputs.get_mut(&operation_id) else {
            return json_string(json!([]));
        };
        let chunks = queue
            .drain(..)
            .map(|chunk| {
                json!({
                    "stream": match chunk.stream {
                        ShellOutputStream::Stdout => "stdout",
                        ShellOutputStream::Stderr => "stderr",
                    },
                    "delta": chunk.content,
                })
            })
            .collect::<Vec<_>>();
        json_string(json!(chunks))
    }

    #[napi]
    pub fn finish_command_output(&self, operation_id: String) -> Result<()> {
        self.command_output
            .lock()
            .map_err(|_| Error::from_reason("Native command output lock was poisoned."))?
            .remove(&operation_id);
        Ok(())
    }

    #[napi]
    pub fn create_terminal_json(
        &self,
        session_id: String,
        workspace_id: String,
        columns: u16,
        rows: u16,
    ) -> Result<String> {
        let workspace = self.workspace(&workspace_id)?;
        let mut terminals = self
            .terminals
            .lock()
            .map_err(|_| Error::from_reason("Native terminal lock was poisoned."))?;
        if terminals.contains_key(&session_id) {
            return Err(Error::from_reason("Terminal session already exists."));
        }
        let terminal = EmbeddedTerminal::spawn(workspace.canonical_root(), columns, rows)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let encoded = serde_json::to_string(terminal.info())
            .map_err(|error| Error::from_reason(error.to_string()))?;
        terminals.insert(session_id, terminal);
        Ok(encoded)
    }

    #[napi]
    pub fn terminal_input(&self, session_id: String, data: String) -> Result<()> {
        self.with_terminal(&session_id, |terminal| terminal.input(data))
    }

    #[napi]
    pub fn terminal_resize(&self, session_id: String, columns: u16, rows: u16) -> Result<()> {
        self.with_terminal(&session_id, |terminal| terminal.resize(columns, rows))
    }

    #[napi]
    pub fn terminal_terminate(&self, session_id: String) -> Result<()> {
        self.with_terminal(&session_id, EmbeddedTerminal::terminate)
    }

    #[napi]
    pub fn drain_terminal_events_json(&self, session_id: String) -> Result<String> {
        let events = self.with_terminal(&session_id, |terminal| terminal.drain_events(128))?;
        serde_json::to_string(&events).map_err(|error| Error::from_reason(error.to_string()))
    }

    #[napi]
    pub fn close_terminal(&self, session_id: String) -> Result<bool> {
        let terminal = self
            .terminals
            .lock()
            .map_err(|_| Error::from_reason("Native terminal lock was poisoned."))?
            .remove(&session_id);
        if let Some(terminal) = terminal {
            let _ = terminal.terminate();
            Ok(true)
        } else {
            Ok(false)
        }
    }

    #[napi]
    pub fn cancel_operation(&self, operation_id: String) -> Result<bool> {
        let active = self
            .command_cancellations
            .lock()
            .map_err(|_| Error::from_reason("Native command cancellation lock was poisoned."))?;
        let Some(cancellation) = active.get(&operation_id) else {
            return Ok(false);
        };
        cancellation.cancel();
        Ok(true)
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
    pub fn workspace_instructions_json(
        &self,
        workspace_id: String,
        scopes_json: String,
    ) -> Result<String> {
        let workspace = self.workspace(&workspace_id)?;
        let scopes: Vec<String> = serde_json::from_str(&scopes_json).map_err(|_| {
            Error::from_reason("Workspace instruction scopes must be a JSON string array.")
        })?;
        if scopes.len() > 64 || scopes.iter().any(|scope| scope.len() > 4_096) {
            return Err(Error::from_reason(
                "Workspace instruction scopes exceed the bounded request.",
            ));
        }
        let mut documents = BTreeMap::<String, serde_json::Value>::new();
        let mut chains = Vec::with_capacity(scopes.len());
        let mut errors = Vec::new();
        for requested_scope in scopes {
            match nearest_instruction_snapshot(&workspace, &requested_scope) {
                Ok(snapshot) => {
                    let mut paths = Vec::new();
                    match snapshot {
                        WorkspaceInstructionsSnapshot::Absent => {}
                        WorkspaceInstructionsSnapshot::Present {
                            path,
                            content,
                            bytes,
                            sha256,
                        } => {
                            paths.push(path.clone());
                            documents.insert(
                                path.clone(),
                                json!({
                                    "path": path,
                                    "scope": instruction_scope(&paths[0]),
                                    "content": content,
                                    "bytes": bytes,
                                    "sha256": sha256,
                                }),
                            );
                        }
                        WorkspaceInstructionsSnapshot::Hierarchy { entries, .. } => {
                            for entry in entries {
                                paths.push(entry.path.clone());
                                documents.insert(entry.path.clone(), json!({
                                    "path": entry.path,
                                    "scope": instruction_scope(paths.last().expect("path was pushed")),
                                    "content": entry.content,
                                    "bytes": entry.bytes,
                                    "sha256": entry.sha256,
                                }));
                            }
                        }
                    }
                    chains.push(json!({ "scope": requested_scope, "paths": paths }));
                }
                Err(kind) => errors.push(json!({
                    "scope": requested_scope,
                    "kind": instruction_error_code(kind),
                })),
            }
        }
        let aggregate_bytes = documents
            .values()
            .filter_map(|document| document.get("bytes").and_then(serde_json::Value::as_u64))
            .sum::<u64>();
        if aggregate_bytes > MAX_WORKSPACE_INSTRUCTIONS_BYTES as u64 {
            errors.extend(chains.iter().filter_map(|chain| {
                chain.get("scope").cloned().map(|scope| {
                    json!({
                        "scope": scope,
                        "kind": "aggregateTooLarge",
                    })
                })
            }));
            documents.clear();
            chains.clear();
        }
        json_string(json!({
            "contractVersion": 1,
            "documents": documents.into_values().collect::<Vec<_>>(),
            "chains": chains,
            "errors": errors,
        }))
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
    pub fn update_thread_title_json(
        &self,
        thread_id: String,
        workspace_id: String,
        title: String,
        only_if_unset: bool,
    ) -> Result<String> {
        self.with_store(|store| {
            store.update_thread_title_json(&thread_id, &workspace_id, &title, only_if_unset)
        })
    }

    #[napi]
    pub fn list_threads_json(&self, workspace_id: String, query: Option<String>) -> Result<String> {
        self.with_store(|store| store.list_threads_json(&workspace_id, query.as_deref()))
    }

    #[napi]
    pub fn delete_thread(&self, thread_id: String, workspace_id: String) -> Result<bool> {
        self.with_store(|store| store.delete_thread(&thread_id, &workspace_id))
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
    // The flattened arguments are the Runtime v3 ABI. Replacing them with an
    // object would silently break an older generated Native binding.
    #[allow(clippy::too_many_arguments)]
    pub fn replace_latest_turn_with_user_message(
        &self,
        replaced_turn_id: String,
        turn_id: String,
        thread_id: String,
        request_id: String,
        provider_wire_api: String,
        model: String,
        user_content_json: String,
    ) -> Result<()> {
        self.with_store(|store| {
            store.replace_latest_turn_with_user_message(
                &replaced_turn_id,
                &turn_id,
                &thread_id,
                &request_id,
                &provider_wire_api,
                &model,
                &user_content_json,
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
    pub fn create_agent_tasks_json(&self, turn_id: String, tasks_json: String) -> Result<String> {
        self.with_store(|store| store.create_agent_tasks_json(&turn_id, &tasks_json))
    }

    #[napi]
    pub fn update_agent_task(
        &self,
        task_id: String,
        status: String,
        payload_json: String,
    ) -> Result<bool> {
        self.with_store(|store| store.update_agent_task(&task_id, &status, &payload_json))
    }

    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn propose_operation(
        &self,
        operation_id: String,
        approval_id: String,
        turn_id: String,
        tool_name: String,
        request_hash: String,
        arguments_json: String,
        approval_payload_json: String,
    ) -> Result<bool> {
        self.with_store(|store| {
            store.propose_operation(
                &operation_id,
                &approval_id,
                &turn_id,
                &tool_name,
                &request_hash,
                &arguments_json,
                &approval_payload_json,
            )
        })
    }

    #[napi]
    pub fn list_pending_approvals_json(&self) -> Result<String> {
        self.with_store(Store::list_pending_approvals_json)
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
        let reviews = prepared
            .changes()
            .iter()
            .map(|change| {
                (
                    change.path().to_owned(),
                    change.diff().to_owned(),
                    change.newline().as_str(),
                    change.final_newline(),
                )
            })
            .collect::<Vec<_>>();
        let value = match workspace.commit_change_set(prepared, &cancellation).await {
            WorkspaceChangeSetCommitOutcome::Applied { receipts } => json!({
                "ok": true,
                "files": receipts.into_iter().zip(reviews).map(
                    |(receipt, (path, diff, newline_style, final_newline))| {
                        debug_assert_eq!(receipt.path, path);
                        json!({
                            "path": receipt.path,
                            "kind": receipt.kind.as_str(),
                            "diff": diff,
                            "beforeSha256": receipt.before_sha256,
                            "afterSha256": receipt.after_sha256,
                            "beforeBytes": receipt.before_bytes,
                            "afterBytes": receipt.after_bytes,
                            "newlineStyle": newline_style,
                            "finalNewline": final_newline,
                        })
                    }
                ).collect::<Vec<_>>(),
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
    pub fn workspace_inspect_json(&self, workspace_id: String, path: String) -> Result<String> {
        let workspace = self.workspace(&workspace_id)?;
        let value = match workspace.inspect_now(&WorkspaceInspectArguments { path: path.clone() }) {
            WorkspaceInspectOutcome::Complete {
                content,
                bytes,
                lines,
                has_utf8_bom,
            } => json!({
                "status": "complete",
                "path": path,
                "content": content,
                "bytes": bytes,
                "lines": lines,
                "hasUtf8Bom": has_utf8_bom,
            }),
            WorkspaceInspectOutcome::Truncated {
                content,
                bytes,
                returned_bytes,
                lines,
                has_utf8_bom,
            } => json!({
                "status": "truncated",
                "path": path,
                "content": content,
                "bytes": bytes,
                "returnedBytes": returned_bytes,
                "lines": lines,
                "hasUtf8Bom": has_utf8_bom,
            }),
            WorkspaceInspectOutcome::Error { kind } => json!({
                "status": "error",
                "path": path,
                "kind": inspect_error_code(kind),
            }),
        };
        json_string(value)
    }

    #[napi]
    pub async fn workspace_resolve_json(
        &self,
        workspace_id: String,
        name: String,
    ) -> Result<String> {
        let workspace = self.workspace(&workspace_id)?;
        let outcome = workspace
            .search_advanced(
                &WorkspaceAdvancedSearchArguments {
                    path: ".".to_owned(),
                    query: name.clone(),
                    mode: WorkspaceSearchMode::Path,
                    case_sensitive: true,
                    regex: false,
                    file_pattern: None,
                },
                &CancellationToken::new(),
            )
            .await;
        let value = match outcome {
            WorkspaceAdvancedSearchOutcome::Matches {
                matches, truncated, ..
            } => {
                let paths = matches
                    .into_iter()
                    .filter(|entry| entry.kind == Some(WorkspaceListEntryKind::File))
                    .map(|entry| entry.path)
                    .filter(|path| path.rsplit('/').next() == Some(name.as_str()))
                    .collect::<Vec<_>>();
                if truncated {
                    json!({ "status": "unavailable" })
                } else if paths.len() == 1 {
                    json!({ "status": "resolved", "path": paths[0] })
                } else if paths.is_empty() {
                    json!({ "status": "notFound" })
                } else {
                    json!({ "status": "ambiguous" })
                }
            }
            WorkspaceAdvancedSearchOutcome::Error { .. } => {
                json!({ "status": "unavailable" })
            }
        };
        json_string(value)
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

    #[napi]
    pub async fn workspace_path_search_json(
        &self,
        workspace_id: String,
        query: String,
    ) -> Result<String> {
        let workspace = self.workspace(&workspace_id)?;
        let outcome = workspace
            .search_advanced(
                &WorkspaceAdvancedSearchArguments {
                    path: ".".to_owned(),
                    query,
                    mode: WorkspaceSearchMode::Path,
                    case_sensitive: false,
                    regex: false,
                    file_pattern: None,
                },
                &CancellationToken::new(),
            )
            .await;
        let value = match outcome {
            WorkspaceAdvancedSearchOutcome::Matches {
                matches, truncated, ..
            } => {
                let mut paths = matches
                    .into_iter()
                    .filter(|entry| entry.kind == Some(WorkspaceListEntryKind::File))
                    .map(|entry| entry.path)
                    .collect::<Vec<_>>();
                let overflow = paths.len() > 64;
                paths.truncate(64);
                json!({
                    "ok": true,
                    "paths": paths,
                    "truncated": truncated || overflow,
                })
            }
            WorkspaceAdvancedSearchOutcome::Error { kind } => {
                json!({ "ok": false, "error": format!("{kind:?}") })
            }
        };
        json_string(value)
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

    fn with_terminal<T>(
        &self,
        session_id: &str,
        operation: impl FnOnce(
            &EmbeddedTerminal,
        ) -> std::result::Result<T, sugarcode_terminal::TerminalError>,
    ) -> Result<T> {
        let terminals = self
            .terminals
            .lock()
            .map_err(|_| Error::from_reason("Native terminal lock was poisoned."))?;
        let terminal = terminals
            .get(session_id)
            .ok_or_else(|| Error::from_reason("Terminal session does not exist."))?;
        operation(terminal).map_err(|error| Error::from_reason(error.to_string()))
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

fn nearest_instruction_snapshot(
    workspace: &WorkspaceTool,
    requested_scope: &str,
) -> std::result::Result<WorkspaceInstructionsSnapshot, WorkspaceInstructionsErrorKind> {
    let mut scope = if requested_scope.is_empty() {
        ".".to_owned()
    } else {
        requested_scope.replace('\\', "/")
    };
    loop {
        match workspace.derive_scope_with_instructions(&scope) {
            Ok((_, snapshot)) => return Ok(snapshot),
            Err(WorkspaceScopeInstructionsErrorKind::Instructions(kind)) => return Err(kind),
            Err(WorkspaceScopeInstructionsErrorKind::Scope(WorkspaceReadErrorKind::NotFound)) => {
                if scope == "." {
                    return Err(WorkspaceInstructionsErrorKind::Unavailable);
                }
                scope = scope
                    .rsplit_once('/')
                    .map(|(parent, _)| if parent.is_empty() { "." } else { parent })
                    .unwrap_or(".")
                    .to_owned();
            }
            Err(WorkspaceScopeInstructionsErrorKind::Scope(kind)) => {
                return Err(match kind {
                    WorkspaceReadErrorKind::AccessDenied => {
                        WorkspaceInstructionsErrorKind::AccessDenied
                    }
                    WorkspaceReadErrorKind::PathNotAllowed => {
                        WorkspaceInstructionsErrorKind::PathNotAllowed
                    }
                    WorkspaceReadErrorKind::NotRegularFile => {
                        WorkspaceInstructionsErrorKind::NotRegularFile
                    }
                    WorkspaceReadErrorKind::FileTooLarge => {
                        WorkspaceInstructionsErrorKind::FileTooLarge
                    }
                    WorkspaceReadErrorKind::BinaryFile => {
                        WorkspaceInstructionsErrorKind::InvalidEncoding
                    }
                    WorkspaceReadErrorKind::ChangedDuringRead => {
                        WorkspaceInstructionsErrorKind::ChangedDuringRead
                    }
                    WorkspaceReadErrorKind::InvalidPath
                    | WorkspaceReadErrorKind::NotFound
                    | WorkspaceReadErrorKind::Cancelled
                    | WorkspaceReadErrorKind::Unavailable => {
                        WorkspaceInstructionsErrorKind::Unavailable
                    }
                });
            }
        }
    }
}

fn instruction_scope(path: &str) -> &str {
    path.rsplit_once('/').map(|(scope, _)| scope).unwrap_or(".")
}

const fn instruction_error_code(kind: WorkspaceInstructionsErrorKind) -> &'static str {
    match kind {
        WorkspaceInstructionsErrorKind::AccessDenied => "accessDenied",
        WorkspaceInstructionsErrorKind::PathNotAllowed => "pathNotAllowed",
        WorkspaceInstructionsErrorKind::NotRegularFile => "notRegularFile",
        WorkspaceInstructionsErrorKind::HardLinkNotAllowed => "hardLinkNotAllowed",
        WorkspaceInstructionsErrorKind::FileTooLarge => "fileTooLarge",
        WorkspaceInstructionsErrorKind::InvalidEncoding => "invalidEncoding",
        WorkspaceInstructionsErrorKind::ChangedDuringRead => "changedDuringRead",
        WorkspaceInstructionsErrorKind::ChangedDuringDiscovery => "changedDuringDiscovery",
        WorkspaceInstructionsErrorKind::AggregateTooLarge => "aggregateTooLarge",
        WorkspaceInstructionsErrorKind::Unavailable => "unavailable",
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

const fn inspect_error_code(kind: WorkspaceInspectErrorKind) -> &'static str {
    match kind {
        WorkspaceInspectErrorKind::InvalidPath => "invalidPath",
        WorkspaceInspectErrorKind::NotFound => "notFound",
        WorkspaceInspectErrorKind::AccessDenied => "accessDenied",
        WorkspaceInspectErrorKind::PathNotAllowed => "pathNotAllowed",
        WorkspaceInspectErrorKind::NotRegularFile => "notRegularFile",
        WorkspaceInspectErrorKind::Oversized => "oversized",
        WorkspaceInspectErrorKind::Binary => "binary",
        WorkspaceInspectErrorKind::InvalidEncoding => "invalidEncoding",
        WorkspaceInspectErrorKind::LongLine => "longLine",
        WorkspaceInspectErrorKind::Changed => "changed",
        WorkspaceInspectErrorKind::Unavailable => "unavailable",
    }
}

fn native_error(error: persistence::PersistenceError) -> Error {
    Error::from_reason(error.to_string())
}

fn native_error_message(error: impl ToString) -> Error {
    Error::from_reason(error.to_string())
}

fn asset_row(asset: &ContentAsset) -> AssetRow {
    AssetRow {
        asset_id: asset.asset_id.clone(),
        sha256: asset.sha256.clone(),
        media_type: asset.media_type.clone(),
        original_name: asset.original_name.clone(),
        size_bytes: i64::try_from(asset.size_bytes).expect("validated asset size fits i64"),
        kind: asset.kind.as_str().to_owned(),
        pdf_pages: asset.pdf_pages,
    }
}

fn content_asset(row: &AssetRow) -> Result<ContentAsset> {
    let kind = match row.kind.as_str() {
        "image" => ContentAssetKind::Image,
        "pdf" => ContentAssetKind::Pdf,
        "text" => ContentAssetKind::Text,
        _ => return Err(Error::from_reason("Content asset kind is invalid.")),
    };
    Ok(ContentAsset {
        asset_id: row.asset_id.clone(),
        sha256: row.sha256.clone(),
        media_type: row.media_type.clone(),
        original_name: row.original_name.clone(),
        size_bytes: u64::try_from(row.size_bytes)
            .map_err(|_| Error::from_reason("Content asset size is invalid."))?,
        kind,
        pdf_pages: row.pdf_pages,
    })
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

#[cfg(test)]
#[path = "tests/skills.rs"]
mod skills_tests;

#[cfg(test)]
#[path = "tests/workspace.rs"]
mod workspace_tests;
