mod knowledge;
mod persistence;
mod semantic_catalog;
mod semantic_model;
mod skills;

use base64::Engine;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use napi::Error;
use napi::bindgen_prelude::Result;
use napi_derive::napi;
use serde_json::json;
use sha2::{Digest, Sha256};
use sugarcode_state::ContentAsset;
use sugarcode_state::ContentAssetKind;
use sugarcode_state::ContentStore;
use sugarcode_terminal::EmbeddedTerminal;
use sugarcode_tools::CommandEnvironmentManager;
use sugarcode_tools::CommandEnvironmentSnapshot;
use sugarcode_tools::CommandEnvironmentState;
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
use sugarcode_tools::PROJECT_ENVIRONMENT_CONFIG_PATH;
use sugarcode_tools::ResolvedProjectEnvironmentConfig;
use sugarcode_tools::ShellCommandArguments;
use sugarcode_tools::ShellCommandExecution;
use sugarcode_tools::ShellCommandExecutor;
use sugarcode_tools::ShellCommandOutcome;
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
use sugarcode_tools::capture_project_environment;
use sugarcode_tools::create_task_worktree;
use sugarcode_tools::parse_project_environment_config;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

use persistence::AssetRow;
use persistence::KnowledgeHybridSearchRequest;
use persistence::Store;
use persistence::TaskWorkspaceRow;

#[napi]
pub struct NativeRuntime {
    store: Arc<Mutex<Store>>,
    content_store: ContentStore,
    workspaces: Mutex<HashMap<String, Arc<WorkspaceTool>>>,
    task_workspaces: Mutex<HashMap<String, Arc<WorkspaceTool>>>,
    command_cancellations: Mutex<HashMap<String, CancellationToken>>,
    command_output: Arc<Mutex<HashMap<String, VecDeque<ShellOutputChunk>>>>,
    command_environments: CommandEnvironmentManager,
    project_environment_gates:
        Mutex<HashMap<String, Arc<AsyncMutex<Option<ProjectTaskEnvironment>>>>>,
    terminals: Mutex<HashMap<String, EmbeddedTerminal>>,
    skills_root: PathBuf,
    knowledge_root: PathBuf,
    semantic_model: semantic_model::SemanticModelManager,
    data_directory: PathBuf,
    knowledge_index_gate: Arc<Mutex<()>>,
    knowledge_watcher: Arc<Mutex<Option<knowledge::KnowledgeWatcher>>>,
    pending_knowledge_watch_paths: Arc<Mutex<Vec<PathBuf>>>,
    semantic_index_gate: Arc<Mutex<()>>,
    semantic_index_scheduled: Arc<AtomicBool>,
    task_worktrees_root: PathBuf,
}

struct ProjectTaskEnvironment {
    config_hash: String,
    snapshot: Arc<CommandEnvironmentSnapshot>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskWorkspaceStatus {
    thread_id: String,
    mode: String,
    root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch: Option<String>,
}

fn task_workspace_status(binding: TaskWorkspaceRow, default_root: &Path) -> TaskWorkspaceStatus {
    TaskWorkspaceStatus {
        thread_id: binding.thread_id,
        mode: binding.mode,
        root: binding
            .task_root
            .unwrap_or_else(|| default_root.to_string_lossy().into_owned()),
        branch: binding.branch,
    }
}

#[napi]
impl NativeRuntime {
    #[napi(constructor)]
    pub fn open(data_directory: String) -> Result<Self> {
        let mut store = Store::open(&data_directory).map_err(native_error)?;
        let data_directory_path = PathBuf::from(&data_directory);
        let content_store = ContentStore::open_at(Path::new(&data_directory))
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let skills_root = Path::new(&data_directory).join("skills");
        let knowledge_root = Path::new(&data_directory).join("knowledge");
        let semantic_model = semantic_model::SemanticModelManager::open(&data_directory_path)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let mut retrieval_settings = store.knowledge_retrieval_settings().map_err(native_error)?;
        if retrieval_settings.strategy == "fullText"
            && retrieval_settings.active_model_id.is_none()
            && semantic_model.is_ready()
        {
            store
                .set_knowledge_retrieval_settings(
                    "semantic",
                    Some(semantic_model.model_id()),
                    Some(semantic_model.model_version()),
                )
                .map_err(native_error)?;
            retrieval_settings = store.knowledge_retrieval_settings().map_err(native_error)?;
        }
        if let Some(model_id) = retrieval_settings
            .pending_model_id
            .as_deref()
            .or(retrieval_settings.active_model_id.as_deref())
        {
            semantic_model
                .select_model(model_id)
                .map_err(Error::from_reason)?;
        }
        let task_worktrees_root = Path::new(&data_directory).join("worktrees");
        std::fs::create_dir_all(&skills_root)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        std::fs::create_dir_all(&knowledge_root)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let knowledge_index_gate = Arc::new(Mutex::new(()));
        let linked_roots = store
            .linked_knowledge_sources()
            .map_err(native_error)?
            .into_iter()
            .map(|source| PathBuf::from(source.path))
            .collect::<Vec<_>>();
        let knowledge_watcher = Arc::new(Mutex::new(None));
        let pending_knowledge_watch_paths = Arc::new(Mutex::new(Vec::<PathBuf>::new()));
        let watcher_slot = knowledge_watcher.clone();
        let pending_watch_paths = pending_knowledge_watch_paths.clone();
        let watcher_data_directory = data_directory_path.clone();
        let watcher_index_gate = knowledge_index_gate.clone();
        std::thread::Builder::new()
            .name("sugarcode-knowledge-watch-init".to_owned())
            .spawn(move || {
                let Ok(watcher) = knowledge::KnowledgeWatcher::start(
                    watcher_data_directory,
                    &linked_roots,
                    watcher_index_gate,
                ) else {
                    return;
                };
                if let Ok(mut slot) = watcher_slot.lock() {
                    *slot = Some(watcher);
                    if let Ok(mut pending) = pending_watch_paths.lock()
                        && let Some(watcher) = slot.as_mut()
                    {
                        for path in pending.drain(..) {
                            let _ = watcher.watch(&path);
                        }
                    }
                }
            })
            .map_err(native_error_message)?;
        Ok(Self {
            store: Arc::new(Mutex::new(store)),
            content_store,
            workspaces: Mutex::new(HashMap::new()),
            task_workspaces: Mutex::new(HashMap::new()),
            command_cancellations: Mutex::new(HashMap::new()),
            command_output: Arc::new(Mutex::new(HashMap::new())),
            command_environments: CommandEnvironmentManager::new(),
            project_environment_gates: Mutex::new(HashMap::new()),
            terminals: Mutex::new(HashMap::new()),
            skills_root,
            knowledge_root,
            semantic_model,
            data_directory: data_directory_path,
            knowledge_index_gate,
            knowledge_watcher,
            pending_knowledge_watch_paths,
            semantic_index_gate: Arc::new(Mutex::new(())),
            semantic_index_scheduled: Arc::new(AtomicBool::new(false)),
            task_worktrees_root,
        })
    }

    #[napi]
    pub fn set_knowledge_agent_active(&self, active: bool) {
        knowledge::set_agent_active(active);
    }

    #[napi]
    pub fn inspect_knowledge_json(&self, workspace_id: Option<String>) -> Result<String> {
        let (knowledge_bases, semantic_index, retrieval_settings) = self.with_store(|store| {
            Ok((
                store.knowledge_bases(workspace_id.as_deref())?,
                store.semantic_index_summary(
                    self.semantic_model.model_id(),
                    self.semantic_model.model_version(),
                )?,
                store.knowledge_retrieval_settings()?,
            ))
        })?;
        let mut semantic_model =
            serde_json::to_value(self.semantic_model.inspect()).map_err(native_error_message)?;
        if (retrieval_settings.strategy == "semantic"
            || retrieval_settings.pending_model_id.as_deref()
                == Some(self.semantic_model.model_id()))
            && self.semantic_model.is_ready()
            && semantic_index.total_chunks > semantic_index.indexed_chunks
            && semantic_index.state == "notIndexed"
        {
            self.schedule_semantic_index(None);
        }
        semantic_model["semanticIndex"] =
            serde_json::to_value(semantic_index).map_err(native_error_message)?;
        serde_json::to_string(&json!({
            "knowledgeBases": knowledge_bases,
            "semanticModel": semantic_model,
            "retrievalPlans": semantic_catalog::RETRIEVAL_PLANS,
            "retrievalSettings": retrieval_settings,
        }))
        .map_err(native_error_message)
    }

    #[napi]
    pub async fn install_semantic_model_json(&self) -> Result<String> {
        match self.semantic_model.install().await {
            Ok(()) => {
                self.schedule_semantic_index(None);
                serde_json::to_string(&json!({ "accepted": true })).map_err(native_error_message)
            }
            Err(message) if message == "cancelled" => serde_json::to_string(&json!({
                "accepted": false, "reason": "cancelled"
            }))
            .map_err(native_error_message),
            Err(message) => serde_json::to_string(&json!({
                "accepted": false, "reason": "unavailable", "message": message
            }))
            .map_err(native_error_message),
        }
    }

    #[napi]
    pub fn select_knowledge_retrieval_plan_json(&self, plan_id: String) -> Result<String> {
        if plan_id == semantic_catalog::FULL_TEXT_PLAN_ID {
            self.with_store(|store| {
                store.set_knowledge_retrieval_settings("fullText", None, None)
            })?;
            return serde_json::to_string(&json!({ "accepted": true }))
                .map_err(native_error_message);
        }
        let model = semantic_catalog::semantic_model(&plan_id)
            .ok_or_else(|| Error::from_reason("Knowledge retrieval plan does not exist."))?;
        {
            let _semantic_guard = self
                .semantic_index_gate
                .lock()
                .map_err(|_| Error::from_reason("Semantic index lock was poisoned."))?;
            self.semantic_model
                .select_model(model.id)
                .map_err(Error::from_reason)?;
            self.with_store(|store| {
                store.request_knowledge_retrieval_model(model.id, model.version)
            })?;
        }
        let installed = self.semantic_model.is_ready();
        if installed {
            self.schedule_semantic_index(None);
        }
        serde_json::to_string(&json!({
            "accepted": true,
            "requiresDownload": !installed,
        }))
        .map_err(native_error_message)
    }

    #[napi]
    pub fn cancel_semantic_model_download_json(&self) -> Result<String> {
        let cancelled = self.semantic_model.cancel();
        serde_json::to_string(&if cancelled {
            json!({ "accepted": true })
        } else {
            json!({
                "accepted": false,
                "reason": "conflict",
                "message": "当前没有正在进行的模型下载。"
            })
        })
        .map_err(native_error_message)
    }

    #[napi]
    pub fn set_semantic_index_paused_json(&self, paused: bool) -> Result<String> {
        self.with_store(|store| store.set_semantic_index_paused(paused))?;
        if !paused {
            self.schedule_semantic_index(None);
        }
        serde_json::to_string(&json!({ "accepted": true })).map_err(native_error_message)
    }

    #[napi]
    pub fn remove_semantic_model_json(&self) -> Result<String> {
        let removed_model_id = self.semantic_model.model_id();
        let removed_model_version = self.semantic_model.model_version();
        let retrieval_settings = self.with_store(Store::knowledge_retrieval_settings)?;
        match self.semantic_model.remove() {
            Ok(()) => {
                // Removing the loaded model first makes an active indexer stop at its
                // next batch. Wait for that batch to finish before clearing vectors so
                // it cannot write stale rows back after the clear.
                let _semantic_guard = self
                    .semantic_index_gate
                    .lock()
                    .map_err(|_| Error::from_reason("Semantic index lock was poisoned."))?;
                self.with_store(|store| {
                    store.clear_knowledge_semantic_indexes(removed_model_id, removed_model_version)
                })?;
                self.with_store(|store| {
                    if retrieval_settings.active_model_id.as_deref() == Some(removed_model_id)
                        && retrieval_settings.active_model_version.as_deref()
                            == Some(removed_model_version)
                    {
                        store.set_knowledge_retrieval_settings("fullText", None, None)
                    } else {
                        let _ = store.cancel_pending_knowledge_retrieval_model(
                            removed_model_id,
                            removed_model_version,
                        )?;
                        Ok(())
                    }
                })?;
                serde_json::to_string(&json!({ "accepted": true })).map_err(native_error_message)
            }
            Err(message) => serde_json::to_string(&json!({
                "accepted": false, "reason": "conflict", "message": message
            }))
            .map_err(native_error_message),
        }
    }

    #[napi]
    pub fn create_knowledge_base_json(
        &self,
        name: String,
        description: String,
        workspace_ids_json: String,
    ) -> Result<String> {
        let workspace_ids: Vec<String> =
            serde_json::from_str(&workspace_ids_json).map_err(native_error_message)?;
        let id = self
            .with_store(|store| store.create_knowledge_base(&name, &description, &workspace_ids))?;
        serde_json::to_string(&json!({ "accepted": true, "knowledgeBaseId": id }))
            .map_err(native_error_message)
    }

    #[napi]
    pub fn update_knowledge_base_json(
        &self,
        knowledge_base_id: String,
        name: String,
        description: String,
        workspace_ids_json: String,
        ignore_rules_json: String,
        semantic_enabled: Option<bool>,
    ) -> Result<String> {
        let workspace_ids: Vec<String> =
            serde_json::from_str(&workspace_ids_json).map_err(native_error_message)?;
        let ignore_rules: Vec<String> =
            serde_json::from_str(&ignore_rules_json).map_err(native_error_message)?;
        let updated = self.with_store(|store| {
            store.update_knowledge_base(
                &knowledge_base_id,
                &name,
                &description,
                &workspace_ids,
                &ignore_rules,
                semantic_enabled,
            )
        })?;
        if updated && semantic_enabled == Some(true) {
            self.schedule_semantic_index(Some(knowledge_base_id));
        }
        serde_json::to_string(&json!({ "accepted": updated })).map_err(native_error_message)
    }

    #[napi]
    pub fn delete_knowledge_base_json(&self, knowledge_base_id: String) -> Result<String> {
        let managed_paths = self.with_store(|store| {
            Ok(store
                .knowledge_sources(&knowledge_base_id)?
                .into_iter()
                .filter(|source| source.kind == "managedFile")
                .map(|source| source.path)
                .collect::<Vec<_>>())
        })?;
        let deleted = self.with_store(|store| store.delete_knowledge_base(&knowledge_base_id))?;
        if deleted {
            for path in managed_paths {
                let still_referenced =
                    self.with_store(|store| store.managed_path_reference_count(&path))? > 0;
                if !still_referenced {
                    let path = PathBuf::from(path);
                    let _ = std::fs::remove_file(&path);
                    if let Some(parent) = path.parent() {
                        let _ = std::fs::remove_dir(parent);
                    }
                }
            }
        }
        serde_json::to_string(&json!({ "accepted": deleted })).map_err(native_error_message)
    }

    #[napi]
    pub async fn add_knowledge_files_json(
        &self,
        knowledge_base_id: String,
        paths_json: String,
    ) -> Result<String> {
        let paths: Vec<String> = serde_json::from_str(&paths_json).map_err(native_error_message)?;
        let data_directory = self.data_directory.clone();
        let knowledge_root = self.knowledge_root.clone();
        let index_gate = self.knowledge_index_gate.clone();
        let knowledge_base_id_for_index = knowledge_base_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            let _index_guard = index_gate
                .lock()
                .map_err(|_| Error::from_reason("Knowledge index lock was poisoned."))?;
            let mut store = Store::open_worker(data_directory).map_err(native_error)?;
            let result = knowledge::add_managed_files(
                &mut store,
                &knowledge_root,
                &knowledge_base_id,
                &paths,
            )
            .map_err(native_error)?;
            serde_json::to_string(&result).map_err(native_error_message)
        })
        .await
        .map_err(native_error_message)??;
        self.schedule_semantic_index(Some(knowledge_base_id_for_index));
        Ok(result)
    }

    #[napi]
    pub async fn create_knowledge_text_document_json(
        &self,
        knowledge_base_id: String,
        file_name: String,
        content: String,
    ) -> Result<String> {
        let data_directory = self.data_directory.clone();
        let knowledge_root = self.knowledge_root.clone();
        let index_gate = self.knowledge_index_gate.clone();
        let knowledge_base_id_for_index = knowledge_base_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            let _index_guard = index_gate
                .lock()
                .map_err(|_| Error::from_reason("Knowledge index lock was poisoned."))?;
            let mut store = Store::open_worker(data_directory).map_err(native_error)?;
            let result = knowledge::create_managed_text_document(
                &mut store,
                &knowledge_root,
                &knowledge_base_id,
                &file_name,
                &content,
            )
            .map_err(native_error)?;
            serde_json::to_string(&result).map_err(native_error_message)
        })
        .await
        .map_err(native_error_message)??;
        self.schedule_semantic_index(Some(knowledge_base_id_for_index));
        Ok(result)
    }

    #[napi]
    pub fn read_knowledge_text_document_json(&self, source_id: String) -> Result<String> {
        let document = self.with_store(|store| {
            knowledge::read_managed_text_document(store, &self.knowledge_root, &source_id)
        })?;
        serde_json::to_string(&document).map_err(native_error_message)
    }

    #[napi]
    pub async fn update_knowledge_text_document_json(
        &self,
        source_id: String,
        expected_sha256: String,
        content: String,
    ) -> Result<String> {
        let data_directory = self.data_directory.clone();
        let knowledge_root = self.knowledge_root.clone();
        let index_gate = self.knowledge_index_gate.clone();
        let source_id_for_lookup = source_id.clone();
        let (result, old_path) = tokio::task::spawn_blocking(move || {
            let _index_guard = index_gate
                .lock()
                .map_err(|_| Error::from_reason("Knowledge index lock was poisoned."))?;
            let mut store = Store::open_worker(data_directory).map_err(native_error)?;
            let update = knowledge::update_managed_text_document(
                &mut store,
                &knowledge_root,
                &source_id,
                &expected_sha256,
                &content,
            )
            .map_err(native_error)?;
            Ok::<_, Error>((update.result, update.old_path))
        })
        .await
        .map_err(native_error_message)??;
        let knowledge_base_id = self.with_store(|store| {
            Ok(store
                .knowledge_source(&source_id_for_lookup)?
                .knowledge_base_id)
        })?;
        if !old_path.is_empty()
            && self.with_store(|store| store.managed_path_reference_count(&old_path))? == 0
        {
            let old_path = PathBuf::from(old_path);
            let _ = std::fs::remove_file(&old_path);
            if let Some(parent) = old_path.parent() {
                let _ = std::fs::remove_dir(parent);
            }
        }
        self.schedule_semantic_index(Some(knowledge_base_id));
        serde_json::to_string(&result).map_err(native_error_message)
    }

    #[napi]
    pub async fn add_knowledge_folder_json(
        &self,
        knowledge_base_id: String,
        path: String,
    ) -> Result<String> {
        let data_directory = self.data_directory.clone();
        let index_gate = self.knowledge_index_gate.clone();
        let watched_path = PathBuf::from(&path);
        let knowledge_base_id_for_index = knowledge_base_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            let _index_guard = index_gate
                .lock()
                .map_err(|_| Error::from_reason("Knowledge index lock was poisoned."))?;
            let mut store = Store::open_worker(data_directory).map_err(native_error)?;
            let result = knowledge::add_linked_folder(&mut store, &knowledge_base_id, &path)
                .map_err(native_error)?;
            serde_json::to_string(&result).map_err(native_error_message)
        })
        .await
        .map_err(native_error_message)??;
        if let Ok(mut watcher) = self.knowledge_watcher.lock() {
            if let Some(watcher) = watcher.as_mut() {
                let _ = watcher.watch(&watched_path);
            } else if let Ok(mut pending) = self.pending_knowledge_watch_paths.lock() {
                pending.push(watched_path);
            }
        }
        self.schedule_semantic_index(Some(knowledge_base_id_for_index));
        Ok(result)
    }

    #[napi]
    pub async fn rescan_knowledge_source_json(
        &self,
        source_id: String,
        rebuild: Option<bool>,
    ) -> Result<String> {
        let data_directory = self.data_directory.clone();
        let index_gate = self.knowledge_index_gate.clone();
        let source_id_for_index = source_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            let _index_guard = index_gate
                .lock()
                .map_err(|_| Error::from_reason("Knowledge index lock was poisoned."))?;
            let mut store = Store::open_worker(data_directory).map_err(native_error)?;
            let result = knowledge::rescan_source(&mut store, &source_id, rebuild.unwrap_or(false))
                .map_err(native_error)?;
            serde_json::to_string(&result).map_err(native_error_message)
        })
        .await
        .map_err(native_error_message)??;
        let knowledge_base_id = self.with_store(|store| {
            Ok(store
                .knowledge_source(&source_id_for_index)?
                .knowledge_base_id)
        })?;
        self.schedule_semantic_index(Some(knowledge_base_id));
        Ok(result)
    }

    #[napi]
    pub fn cancel_knowledge_index_job_json(&self, job_id: String) -> Result<String> {
        let accepted =
            self.with_store(|store| store.request_knowledge_index_job_cancel(&job_id))?;
        serde_json::to_string(&json!({ "accepted": accepted })).map_err(native_error_message)
    }

    #[napi]
    pub fn delete_knowledge_source_json(&self, source_id: String) -> Result<String> {
        let managed_path = self.with_store(|store| store.delete_knowledge_source(&source_id))?;
        if let Some(path) = managed_path {
            let still_referenced =
                self.with_store(|store| store.managed_path_reference_count(&path))? > 0;
            if !still_referenced {
                let path = PathBuf::from(path);
                let _ = std::fs::remove_file(&path);
                if let Some(parent) = path.parent() {
                    let _ = std::fs::remove_dir(parent);
                }
            }
        }
        serde_json::to_string(&json!({ "accepted": true })).map_err(native_error_message)
    }

    #[napi]
    pub fn inspect_knowledge_base_json(&self, knowledge_base_id: String) -> Result<String> {
        let (sources, documents, jobs, config) = self.with_store(|store| {
            Ok((
                store.knowledge_sources(&knowledge_base_id)?,
                store.knowledge_documents(&knowledge_base_id)?,
                store.knowledge_index_jobs(&knowledge_base_id)?,
                store.knowledge_base_config(&knowledge_base_id)?,
            ))
        })?;
        serde_json::to_string(&json!({
            "sources": sources,
            "documents": documents,
            "indexJobs": jobs,
            "ignoreRules": config.ignore_rules,
            "semanticEnabled": config.semantic_enabled,
        }))
        .map_err(native_error_message)
    }

    #[napi]
    pub async fn search_knowledge_json(
        &self,
        workspace_id: Option<String>,
        knowledge_base_ids_json: String,
        query: String,
    ) -> Result<String> {
        let knowledge_base_ids: Vec<String> =
            serde_json::from_str(&knowledge_base_ids_json).map_err(native_error_message)?;
        let data_directory = self.data_directory.clone();
        let semantic_model = self.semantic_model.clone();
        tokio::task::spawn_blocking(move || {
            let fts_query = knowledge::search_query(&query).map_err(native_error)?;
            let mut store = Store::open_worker(data_directory).map_err(native_error)?;
            let retrieval_settings = store.knowledge_retrieval_settings().map_err(native_error)?;
            let active_model = retrieval_settings
                .active_model_id
                .as_deref()
                .zip(retrieval_settings.active_model_version.as_deref());
            let semantic_knowledge_base_ids = if retrieval_settings.strategy == "semantic"
                && active_model.is_some_and(|(model_id, model_version)| {
                    semantic_model.is_model_ready(model_id, model_version)
                }) {
                let (model_id, model_version) = active_model.expect("active model checked");
                store
                    .semantic_ready_knowledge_base_ids(&knowledge_base_ids, model_id, model_version)
                    .map_err(native_error)?
            } else {
                Vec::new()
            };
            let (mode, hits) = if !semantic_knowledge_base_ids.is_empty() {
                let (model_id, model_version) = active_model.expect("semantic ids require model");
                match semantic_model.embed_query_for(model_id, model_version, &query) {
                    Ok(vector) => (
                        "hybrid",
                        store
                            .search_knowledge_hybrid(KnowledgeHybridSearchRequest {
                                knowledge_base_ids: &knowledge_base_ids,
                                semantic_knowledge_base_ids: &semantic_knowledge_base_ids,
                                workspace_id: workspace_id.as_deref(),
                                query: &fts_query,
                                query_vector: &vector,
                                model_id,
                                model_version,
                                limit: 8,
                            })
                            .map_err(native_error)?,
                    ),
                    Err(_) => (
                        "fullText",
                        store
                            .search_knowledge(
                                &knowledge_base_ids,
                                workspace_id.as_deref(),
                                &fts_query,
                                8,
                            )
                            .map_err(native_error)?,
                    ),
                }
            } else {
                (
                    "fullText",
                    store
                        .search_knowledge(
                            &knowledge_base_ids,
                            workspace_id.as_deref(),
                            &fts_query,
                            8,
                        )
                        .map_err(native_error)?,
                )
            };
            serde_json::to_string(&json!({ "query": query, "mode": mode, "hits": hits }))
                .map_err(native_error_message)
        })
        .await
        .map_err(native_error_message)?
    }

    #[napi]
    pub fn read_knowledge_json(
        &self,
        workspace_id: Option<String>,
        knowledge_base_ids_json: String,
        document_id: String,
        start_ordinal: i64,
    ) -> Result<String> {
        let knowledge_base_ids: Vec<String> =
            serde_json::from_str(&knowledge_base_ids_json).map_err(native_error_message)?;
        let chunks = self.with_store(|store| {
            store.read_knowledge_document(
                &knowledge_base_ids,
                workspace_id.as_deref(),
                &document_id,
                start_ordinal,
            )
        })?;
        serde_json::to_string(&json!({ "documentId": document_id, "chunks": chunks }))
            .map_err(native_error_message)
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
    ) -> Result<String> {
        skills::import_skill(&self.skills_root, Path::new(&source_path))
            .map_err(native_error_message)?;
        self.inspect_skills_json(workspace_id)
    }

    #[napi]
    pub fn import_skill_zip_json(
        &self,
        workspace_id: Option<String>,
        archive_path: String,
    ) -> Result<String> {
        skills::import_skill_zip(&self.skills_root, Path::new(&archive_path))
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
    pub fn export_skill_zip_json(
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
        skills::export_skill_zip(
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
        thread_id: String,
        mode: String,
        command: String,
        arguments_json: String,
        cwd: String,
        timeout_ms: u32,
    ) -> Result<String> {
        let arguments: Vec<String> = serde_json::from_str(&arguments_json)
            .map_err(|_| Error::from_reason("Command arguments must be a JSON string array."))?;
        let base_workspace = self.workspace(&workspace_id)?;
        let workspace = self.workspace_for_thread(&workspace_id, &thread_id)?;
        let command_root = workspace.command_workspace_root().map_err(|kind| {
            Error::from_reason(format!("Could not bind command workspace root: {kind:?}."))
        })?;
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
        match self.command_output.lock() {
            Ok(mut output) => {
                output.insert(operation_id.clone(), VecDeque::new());
            }
            Err(_) => {
                self.command_cancellations
                    .lock()
                    .map_err(|_| {
                        Error::from_reason("Native command cancellation lock was poisoned.")
                    })?
                    .remove(&operation_id);
                return Err(Error::from_reason(
                    "Native command output lock was poisoned.",
                ));
            }
        }
        let host_environment = self
            .command_environments
            .environment_for_thread(&thread_id)
            .await;
        let (environment, project_config_hash) = match self
            .project_environment_for_thread(
                &workspace,
                base_workspace.canonical_root(),
                &thread_id,
                host_environment,
                &cancellation,
            )
            .await
        {
            Ok(prepared) => prepared,
            Err(error) => {
                self.command_cancellations
                    .lock()
                    .map_err(|_| {
                        Error::from_reason("Native command cancellation lock was poisoned.")
                    })?
                    .remove(&operation_id);
                return json_string(json!({
                    "status": "error",
                    "kind": "projectEnvironmentUnavailable",
                    "message": error,
                }));
            }
        };
        let environment_status = environment.status().clone();
        let executor =
            match EmbeddedShellCommandExecutor::new_with_environment(command_root, environment) {
                Ok(executor) => executor,
                Err(error) => {
                    self.command_cancellations
                        .lock()
                        .map_err(|_| {
                            Error::from_reason("Native command cancellation lock was poisoned.")
                        })?
                        .remove(&operation_id);
                    return Err(Error::from_reason(error.to_string()));
                }
            };
        let execution = if cancellation.is_cancelled() {
            ShellCommandExecution::Cancelled
        } else {
            match mode.as_str() {
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
            }
        };
        self.command_cancellations
            .lock()
            .map_err(|_| Error::from_reason("Native command cancellation lock was poisoned."))?
            .remove(&operation_id);
        let environment_metadata = json!({
            "snapshotId": environment_status.snapshot_id,
            "shell": environment_status.shell,
            "source": environment_status.source,
            "degraded": environment_status.state == CommandEnvironmentState::Degraded,
            "projectConfigHash": project_config_hash,
        });
        let value = match execution {
            ShellCommandExecution::Completed(output) => {
                json!({ "status": "completed", "mode": "sandboxed", "output": output, "environment": environment_metadata })
            }
            ShellCommandExecution::FullAccessCompleted(output) => {
                json!({ "status": "completed", "mode": "fullAccess", "output": output, "environment": environment_metadata })
            }
            ShellCommandExecution::Error(kind) => {
                json!({ "status": "error", "kind": kind.to_string(), "environment": environment_metadata })
            }
            ShellCommandExecution::Cancelled => {
                json!({ "status": "cancelled", "environment": environment_metadata })
            }
        };
        json_string(value)
    }

    #[napi]
    pub fn inspect_command_environment_json(
        &self,
        workspace_id: String,
        thread_id: Option<String>,
    ) -> Result<String> {
        let _ = self.workspace(&workspace_id)?;
        json_string(json!(
            self.command_environments.inspect(thread_id.as_deref())
        ))
    }

    #[napi]
    pub async fn refresh_command_environment_json(
        &self,
        workspace_id: String,
        thread_id: String,
    ) -> Result<String> {
        let _ = self.workspace(&workspace_id)?;
        self.project_environment_gates
            .lock()
            .map_err(|_| Error::from_reason("Project environment gate lock was poisoned."))?
            .remove(&thread_id);
        let snapshot = self.command_environments.refresh_thread(&thread_id).await;
        json_string(json!(snapshot.status()))
    }

    #[napi]
    pub fn set_command_profile_loading_enabled_json(&self, enabled: bool) -> Result<String> {
        let changed = self
            .command_environments
            .set_profile_loading_enabled(enabled);
        json_string(json!({ "accepted": true, "changed": changed }))
    }

    #[napi]
    pub fn inspect_task_workspace_json(
        &self,
        workspace_id: String,
        thread_id: String,
    ) -> Result<String> {
        let base = self.workspace(&workspace_id)?;
        let binding = self.with_store(|store| store.task_workspace(&thread_id, &workspace_id))?;
        json_string(json!(task_workspace_status(binding, base.canonical_root())))
    }

    #[napi]
    pub fn task_workspace_binding_id(
        &self,
        workspace_id: String,
        thread_id: String,
    ) -> Result<String> {
        let workspace = self.workspace_for_thread(&workspace_id, &thread_id)?;
        let base = self.workspace(&workspace_id)?;
        if Arc::ptr_eq(&workspace, &base) {
            return Ok(workspace_id);
        }
        let binding_id = format!("task-workspace:{thread_id}");
        self.workspaces
            .lock()
            .map_err(|_| Error::from_reason("Native workspace lock was poisoned."))?
            .insert(binding_id.clone(), workspace);
        Ok(binding_id)
    }

    #[napi]
    pub fn set_task_workspace_mode_json(
        &self,
        workspace_id: String,
        thread_id: String,
        mode: String,
    ) -> Result<String> {
        let base = self.workspace(&workspace_id)?;
        let binding = match mode.as_str() {
            "local" => {
                self.task_workspaces
                    .lock()
                    .map_err(|_| Error::from_reason("Task workspace lock was poisoned."))?
                    .remove(&thread_id);
                self.workspaces
                    .lock()
                    .map_err(|_| Error::from_reason("Native workspace lock was poisoned."))?
                    .remove(&format!("task-workspace:{thread_id}"));
                self.with_store(|store| {
                    store.set_task_workspace(&thread_id, &workspace_id, "local", None, None)
                })?
            }
            "worktree" => {
                let mut hasher = Sha256::new();
                hasher.update(b"sugarcode-workspace-root-v1\0");
                hasher.update(workspace_id.as_bytes());
                let workspace_hash = format!("{:x}", hasher.finalize());
                let parent = self.task_worktrees_root.join(&workspace_hash[..24]);
                let worktree = create_task_worktree(base.canonical_root(), &parent, &thread_id)
                    .map_err(Error::from_reason)?;
                let task_workspace =
                    Arc::new(WorkspaceTool::open(&worktree.root).map_err(|kind| {
                        Error::from_reason(format!("Could not open task worktree: {kind:?}."))
                    })?);
                let root = worktree.root.to_string_lossy().into_owned();
                let binding = self.with_store(|store| {
                    store.set_task_workspace(
                        &thread_id,
                        &workspace_id,
                        "worktree",
                        Some(&root),
                        Some(&worktree.branch),
                    )
                })?;
                self.task_workspaces
                    .lock()
                    .map_err(|_| Error::from_reason("Task workspace lock was poisoned."))?
                    .insert(thread_id.clone(), task_workspace);
                binding
            }
            _ => return Err(Error::from_reason("Task workspace mode is invalid.")),
        };
        self.command_environments.evict_thread(&thread_id);
        self.project_environment_gates
            .lock()
            .map_err(|_| Error::from_reason("Project environment gate lock was poisoned."))?
            .remove(&thread_id);
        json_string(json!({
            "accepted": true,
            "workspace": task_workspace_status(binding, base.canonical_root()),
        }))
    }

    #[napi]
    pub async fn inspect_project_environment_json(
        &self,
        workspace_id: String,
        thread_id: Option<String>,
    ) -> Result<String> {
        let base = self.workspace(&workspace_id)?;
        let workspace = match thread_id.as_deref() {
            Some(thread_id) => self.workspace_for_thread(&workspace_id, thread_id)?,
            None => Arc::clone(&base),
        };
        json_string(
            self.project_environment_inspection(&workspace, base.canonical_root())
                .await?,
        )
    }

    #[napi]
    pub async fn trust_project_environment_json(
        &self,
        workspace_id: String,
        expected_hash: String,
        thread_id: Option<String>,
    ) -> Result<String> {
        let base = self.workspace(&workspace_id)?;
        let workspace = match thread_id.as_deref() {
            Some(thread_id) => self.workspace_for_thread(&workspace_id, thread_id)?,
            None => Arc::clone(&base),
        };
        let Some(config) = read_project_environment_config(&workspace).await? else {
            return json_string(json!({ "accepted": false, "reason": "missing" }));
        };
        if config.config_hash != expected_hash {
            return json_string(json!({ "accepted": false, "reason": "changed" }));
        }
        let canonical_root = base.canonical_root().to_string_lossy().into_owned();
        self.with_store(|store| {
            store.trust_project_environment(&canonical_root, &config.config_hash)
        })?;
        json_string(json!({
            "accepted": true,
            "inspection": project_environment_inspection_value(config, true),
        }))
    }

    #[napi]
    pub async fn run_project_environment_action_json(
        &self,
        workspace_id: String,
        thread_id: String,
        action_id: String,
    ) -> Result<String> {
        let base = self.workspace(&workspace_id)?;
        let workspace = self.workspace_for_thread(&workspace_id, &thread_id)?;
        let Some(config) = read_project_environment_config(&workspace).await? else {
            return json_string(json!({ "accepted": false, "reason": "absent" }));
        };
        let Some(action) = config
            .actions
            .iter()
            .find(|action| action.id == action_id)
            .cloned()
        else {
            return json_string(json!({ "accepted": false, "reason": "actionNotFound" }));
        };
        let canonical_root = base.canonical_root().to_string_lossy().into_owned();
        if !self.with_store(|store| {
            store.project_environment_trusted(&canonical_root, &config.config_hash)
        })? {
            return json_string(json!({ "accepted": false, "reason": "trustRequired" }));
        }
        let cancellation = CancellationToken::new();
        let host_environment = self
            .command_environments
            .environment_for_thread(&thread_id)
            .await;
        let (environment, project_config_hash) = match self
            .project_environment_for_thread(
                &workspace,
                base.canonical_root(),
                &thread_id,
                host_environment,
                &cancellation,
            )
            .await
        {
            Ok(prepared) => prepared,
            Err(message) => {
                return json_string(json!({
                    "accepted": false,
                    "reason": "initializationFailed",
                    "message": message,
                }));
            }
        };
        let Some(current) = read_project_environment_config(&workspace).await? else {
            return json_string(json!({ "accepted": false, "reason": "configChanged" }));
        };
        if current.config_hash != config.config_hash
            || !current
                .actions
                .iter()
                .any(|current_action| current_action == &action)
        {
            return json_string(json!({ "accepted": false, "reason": "configChanged" }));
        }
        let command_root = workspace.command_workspace_root().map_err(|kind| {
            Error::from_reason(format!("Could not bind project action root: {kind:?}."))
        })?;
        let executor = EmbeddedShellCommandExecutor::new_with_environment(
            command_root,
            Arc::clone(&environment),
        )
        .map_err(|error| Error::from_reason(error.to_string()))?;
        let execution = executor
            .execute_full_access(
                FullAccessShellArguments {
                    command: action.command,
                    cwd: ".".to_owned(),
                    timeout_ms: 600_000,
                    output_tx: None,
                },
                cancellation,
            )
            .await;
        let status = environment.status();
        let metadata = json!({
            "snapshotId": status.snapshot_id,
            "projectConfigHash": project_config_hash,
            "shell": status.shell,
            "source": status.source,
            "degraded": status.state == CommandEnvironmentState::Degraded,
        });
        match execution {
            ShellCommandExecution::FullAccessCompleted(output) => json_string(json!({
                "accepted": true,
                "actionId": action_id,
                "status": "completed",
                "output": output,
                "environment": metadata,
            })),
            ShellCommandExecution::Cancelled => json_string(json!({
                "accepted": true,
                "actionId": action_id,
                "status": "cancelled",
                "environment": metadata,
            })),
            ShellCommandExecution::Error(kind) => json_string(json!({
                "accepted": true,
                "actionId": action_id,
                "status": "error",
                "kind": kind.to_string(),
                "environment": metadata,
            })),
            ShellCommandExecution::Completed(_) => json_string(json!({
                "accepted": true,
                "actionId": action_id,
                "status": "error",
                "kind": "invalidExecutionMode",
                "environment": metadata,
            })),
        }
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
        thread_id: Option<String>,
        columns: u16,
        rows: u16,
    ) -> Result<String> {
        let workspace = match thread_id.as_deref() {
            Some(thread_id) => self.workspace_for_thread(&workspace_id, thread_id)?,
            None => self.workspace(&workspace_id)?,
        };
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
            .insert(workspace_id.clone(), workspace);
        let persisted = self.with_store(|store| store.task_workspaces(&workspace_id))?;
        let mut task_workspaces = self
            .task_workspaces
            .lock()
            .map_err(|_| Error::from_reason("Task workspace lock was poisoned."))?;
        for binding in persisted {
            let Some(root) = binding.task_root else {
                continue;
            };
            if let Ok(workspace) = WorkspaceTool::open(Path::new(&root)) {
                task_workspaces.insert(binding.thread_id, Arc::new(workspace));
            }
        }
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
        let deleted = self.with_store(|store| store.delete_thread(&thread_id, &workspace_id))?;
        if deleted {
            self.command_environments.evict_thread(&thread_id);
            self.task_workspaces
                .lock()
                .map_err(|_| Error::from_reason("Task workspace lock was poisoned."))?
                .remove(&thread_id);
            self.workspaces
                .lock()
                .map_err(|_| Error::from_reason("Native workspace lock was poisoned."))?
                .remove(&format!("task-workspace:{thread_id}"));
            self.project_environment_gates
                .lock()
                .map_err(|_| Error::from_reason("Project environment gate lock was poisoned."))?
                .remove(&thread_id);
        }
        Ok(deleted)
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
    pub fn create_queued_message_json(
        &self,
        thread_id: String,
        message_id: String,
        content_json: String,
        model_profile_id: Option<String>,
    ) -> Result<String> {
        self.with_store(|store| {
            store.create_queued_message_json(
                &thread_id,
                &message_id,
                &content_json,
                model_profile_id.as_deref(),
            )
        })
    }

    #[napi]
    pub fn update_queued_message_json(
        &self,
        thread_id: String,
        message_id: String,
        expected_revision: u32,
        content_json: String,
        model_profile_id: Option<String>,
    ) -> Result<String> {
        self.with_store(|store| {
            store.update_queued_message_json(
                &thread_id,
                &message_id,
                i64::from(expected_revision),
                &content_json,
                model_profile_id.as_deref(),
            )
        })
    }

    #[napi]
    pub fn delete_queued_message_json(
        &self,
        thread_id: String,
        message_id: String,
        expected_revision: u32,
    ) -> Result<String> {
        self.with_store(|store| {
            store.delete_queued_message_json(&thread_id, &message_id, i64::from(expected_revision))
        })
    }

    #[napi]
    pub fn set_queue_paused_json(&self, thread_id: String, paused: bool) -> Result<String> {
        self.with_store(|store| store.set_queue_paused_json(&thread_id, paused))
    }

    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn promote_queued_message_json(
        &self,
        thread_id: String,
        message_id: String,
        expected_revision: u32,
        turn_id: String,
        request_id: String,
        provider_wire_api: String,
        model: String,
    ) -> Result<String> {
        self.with_store(|store| {
            store.promote_queued_message_json(
                &thread_id,
                &message_id,
                i64::from(expected_revision),
                &turn_id,
                &request_id,
                &provider_wire_api,
                &model,
            )
        })
    }

    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn steer_queued_message_json(
        &self,
        thread_id: String,
        message_id: String,
        expected_revision: u32,
        turn_id: String,
        item_id: String,
        sequence: u32,
    ) -> Result<String> {
        self.with_store(|store| {
            store.steer_queued_message_json(
                &thread_id,
                &message_id,
                i64::from(expected_revision),
                &turn_id,
                &item_id,
                i64::from(sequence),
            )
        })
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
    async fn project_environment_for_thread(
        &self,
        workspace: &Arc<WorkspaceTool>,
        trust_root: &Path,
        thread_id: &str,
        host_environment: Arc<CommandEnvironmentSnapshot>,
        cancellation: &CancellationToken,
    ) -> std::result::Result<(Arc<CommandEnvironmentSnapshot>, Option<String>), String> {
        let Some(config) = read_project_environment_config(workspace)
            .await
            .map_err(|error| error.to_string())?
        else {
            return Ok((host_environment, None));
        };
        let canonical_root = trust_root.to_string_lossy().into_owned();
        let trusted = self
            .with_store(|store| {
                store.project_environment_trusted(&canonical_root, &config.config_hash)
            })
            .map_err(|error| error.to_string())?;
        if !trusted {
            return Err(format!(
                "{} changed or has not been trusted",
                PROJECT_ENVIRONMENT_CONFIG_PATH
            ));
        }
        let gate = {
            let mut gates = self
                .project_environment_gates
                .lock()
                .map_err(|_| "project environment gate lock was poisoned".to_owned())?;
            Arc::clone(
                gates
                    .entry(thread_id.to_owned())
                    .or_insert_with(|| Arc::new(AsyncMutex::new(None))),
            )
        };
        let mut cached = gate.lock().await;
        if let Some(cached) = cached.as_ref()
            && cached.config_hash == config.config_hash
        {
            return Ok((
                Arc::clone(&cached.snapshot),
                Some(cached.config_hash.clone()),
            ));
        }
        if cancellation.is_cancelled() {
            return Err("project environment initialization was cancelled".to_owned());
        }
        if let Some(setup_script) = config.setup_script.as_ref() {
            let command_root = workspace
                .command_workspace_root()
                .map_err(|kind| format!("could not bind project setup root: {kind:?}"))?;
            let executor = EmbeddedShellCommandExecutor::new_with_environment(
                command_root,
                Arc::clone(&host_environment),
            )
            .map_err(|error| error.to_string())?;
            match executor
                .execute_full_access(
                    FullAccessShellArguments {
                        command: setup_script.clone(),
                        cwd: ".".to_owned(),
                        timeout_ms: 600_000,
                        output_tx: None,
                    },
                    cancellation.clone(),
                )
                .await
            {
                ShellCommandExecution::FullAccessCompleted(output)
                    if output.outcome == (ShellCommandOutcome::ExitCode { code: 0 }) => {}
                ShellCommandExecution::FullAccessCompleted(output) => {
                    return Err(format!(
                        "project setup failed ({:?}): {}",
                        output.outcome,
                        output.stderr.trim().chars().take(2_048).collect::<String>()
                    ));
                }
                ShellCommandExecution::Cancelled => {
                    return Err("project setup was cancelled".to_owned());
                }
                ShellCommandExecution::Error(kind) => {
                    return Err(format!("project setup could not start: {kind}"));
                }
                ShellCommandExecution::Completed(_) => {
                    return Err("project setup returned an invalid execution mode".to_owned());
                }
            }
        }
        let current = read_project_environment_config(workspace)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "project environment configuration disappeared".to_owned())?;
        if current.config_hash != config.config_hash {
            return Err("project environment configuration changed during setup".to_owned());
        }
        let snapshot = match config.environment_script.as_ref() {
            Some(script) => Arc::new(
                capture_project_environment(&host_environment, workspace.canonical_root(), script)
                    .await?,
            ),
            None => host_environment,
        };
        *cached = Some(ProjectTaskEnvironment {
            config_hash: config.config_hash.clone(),
            snapshot: Arc::clone(&snapshot),
        });
        Ok((snapshot, Some(config.config_hash)))
    }

    async fn project_environment_inspection(
        &self,
        workspace: &WorkspaceTool,
        trust_root: &Path,
    ) -> Result<serde_json::Value> {
        let Some(content) = read_project_environment_content(workspace).await? else {
            return Ok(json!({
                "state": "absent",
                "configPath": PROJECT_ENVIRONMENT_CONFIG_PATH,
            }));
        };
        let config = match parse_project_environment_config(&content) {
            Ok(config) => config,
            Err(error) => {
                return Ok(json!({
                    "state": "invalid",
                    "configPath": PROJECT_ENVIRONMENT_CONFIG_PATH,
                    "lastError": error,
                }));
            }
        };
        let canonical_root = trust_root.to_string_lossy().into_owned();
        let trusted = self.with_store(|store| {
            store.project_environment_trusted(&canonical_root, &config.config_hash)
        })?;
        Ok(project_environment_inspection_value(config, trusted))
    }

    fn workspace(&self, workspace_id: &str) -> Result<Arc<WorkspaceTool>> {
        self.workspaces
            .lock()
            .map_err(|_| Error::from_reason("Native workspace lock was poisoned."))?
            .get(workspace_id)
            .cloned()
            .ok_or_else(|| Error::from_reason(format!("Workspace {workspace_id} is not open.")))
    }

    fn workspace_for_thread(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<Arc<WorkspaceTool>> {
        if let Some(workspace) = self
            .task_workspaces
            .lock()
            .map_err(|_| Error::from_reason("Task workspace lock was poisoned."))?
            .get(thread_id)
            .cloned()
        {
            let _ = self.with_store(|store| store.task_workspace(thread_id, workspace_id))?;
            return Ok(workspace);
        }
        self.workspace(workspace_id)
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

    fn schedule_semantic_index(&self, knowledge_base_id: Option<String>) {
        if !self.semantic_model.is_ready()
            || self
                .with_store(Store::knowledge_retrieval_settings)
                .is_ok_and(|settings| settings.index_paused)
        {
            return;
        }
        if self
            .semantic_index_scheduled
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let gate = self.semantic_index_gate.clone();
        let scheduled = self.semantic_index_scheduled.clone();
        let data_directory = self.data_directory.clone();
        let semantic_model = self.semantic_model.clone();
        std::thread::spawn(move || {
            let _guard = gate.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let model_id = semantic_model.model_id();
            let model_version = semantic_model.model_version();
            let result = match knowledge_base_id {
                Some(knowledge_base_id) => semantic_model::index_knowledge_base(
                    &data_directory,
                    &semantic_model,
                    &knowledge_base_id,
                ),
                None => semantic_model::index_all_knowledge_bases(&data_directory, &semantic_model),
            };
            if result.is_ok()
                && let Ok(mut store) = Store::open_worker(&data_directory)
                && let Ok(knowledge_base_ids) = store.semantic_enabled_knowledge_base_ids()
                && store
                    .semantic_indexes_ready(&knowledge_base_ids, model_id, model_version)
                    .unwrap_or(false)
            {
                let _ = store.activate_pending_knowledge_retrieval_model(model_id, model_version);
            }
            scheduled.store(false, Ordering::Release);
        });
    }
}

async fn read_project_environment_content(workspace: &WorkspaceTool) -> Result<Option<String>> {
    match workspace
        .read(
            &WorkspaceReadArguments {
                path: PROJECT_ENVIRONMENT_CONFIG_PATH.to_owned(),
            },
            &CancellationToken::new(),
        )
        .await
    {
        WorkspaceReadOutcome::Content { content, .. } => Ok(Some(content)),
        WorkspaceReadOutcome::Error {
            kind: WorkspaceReadErrorKind::NotFound,
        } => Ok(None),
        WorkspaceReadOutcome::Error { kind } => Err(Error::from_reason(format!(
            "Could not read {PROJECT_ENVIRONMENT_CONFIG_PATH}: {}.",
            read_error_code(kind)
        ))),
    }
}

async fn read_project_environment_config(
    workspace: &WorkspaceTool,
) -> Result<Option<ResolvedProjectEnvironmentConfig>> {
    read_project_environment_content(workspace)
        .await?
        .map(|content| parse_project_environment_config(&content).map_err(Error::from_reason))
        .transpose()
}

fn project_environment_inspection_value(
    config: ResolvedProjectEnvironmentConfig,
    trusted: bool,
) -> serde_json::Value {
    json!({
        "state": if trusted { "trusted" } else { "trustRequired" },
        "configPath": config.config_path,
        "configHash": config.config_hash,
        "setupScript": config.setup_script,
        "environmentScript": config.environment_script,
        "actions": config.actions,
    })
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
#[path = "tests/project_environment.rs"]
mod project_environment_tests;

#[cfg(test)]
#[path = "tests/skills.rs"]
mod skills_tests;

#[cfg(test)]
#[path = "tests/knowledge.rs"]
mod knowledge_tests;

#[cfg(test)]
#[path = "tests/performance.rs"]
mod performance_tests;

#[cfg(test)]
#[path = "tests/workspace.rs"]
mod workspace_tests;
