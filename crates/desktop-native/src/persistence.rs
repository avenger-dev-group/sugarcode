use std::error::Error;
use std::fmt;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sugarcode_state::validate_mcp_loopback_streamable_http_server;
use sugarcode_state::validate_mcp_stdio_server;
use uuid::Uuid;

const DATABASE_FILE: &str = "sugarcode-v3.sqlite3";
const SCHEMA_VERSION: i64 = 17;
const MAX_QUEUED_MESSAGES: i64 = 10;

pub(super) type Result<T> = std::result::Result<T, PersistenceError>;

#[derive(Debug)]
pub(super) enum PersistenceError {
    InvalidInput(String),
    Conflict(String),
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
    Json(serde_json::Error),
}

impl fmt::Display for PersistenceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput(message) | Self::Conflict(message) => formatter.write_str(message),
            Self::Io(error) => write!(formatter, "v3 persistence filesystem failure: {error}"),
            Self::Sqlite(error) => write!(formatter, "v3 persistence SQLite failure: {error}"),
            Self::Json(error) => write!(formatter, "v3 persistence JSON failure: {error}"),
        }
    }
}

impl Error for PersistenceError {}

impl From<std::io::Error> for PersistenceError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<rusqlite::Error> for PersistenceError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

impl From<serde_json::Error> for PersistenceError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

pub(super) struct Store {
    connection: Connection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AssetRow {
    pub(super) asset_id: String,
    pub(super) sha256: String,
    pub(super) media_type: String,
    pub(super) original_name: String,
    pub(super) size_bytes: i64,
    pub(super) kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) pdf_pages: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TaskWorkspaceRow {
    pub(super) thread_id: String,
    pub(super) mode: String,
    pub(super) task_root: Option<String>,
    pub(super) branch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct KnowledgeBaseRow {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) description: String,
    pub(super) scope: String,
    pub(super) workspace_ids: Vec<String>,
    pub(super) source_count: i64,
    pub(super) document_count: i64,
    pub(super) chunk_count: i64,
    pub(super) error_count: i64,
    pub(super) size_bytes: i64,
    pub(super) status: String,
    pub(super) semantic_enabled: bool,
    pub(super) updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct KnowledgeSourceRow {
    pub(super) id: String,
    pub(super) knowledge_base_id: String,
    pub(super) kind: String,
    pub(super) path: String,
    pub(super) display_name: String,
    pub(super) document_count: i64,
    pub(super) error_count: i64,
    pub(super) status: String,
    pub(super) last_error: Option<String>,
    pub(super) last_scanned_at: Option<i64>,
    pub(super) updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct KnowledgeIndexJobRow {
    pub(super) id: String,
    pub(super) knowledge_base_id: String,
    pub(super) source_id: Option<String>,
    pub(super) kind: String,
    pub(super) status: String,
    pub(super) discovered_files: i64,
    pub(super) processed_files: i64,
    pub(super) indexed_files: i64,
    pub(super) skipped_files: i64,
    pub(super) deleted_files: i64,
    pub(super) error_count: i64,
    pub(super) attempt_count: i64,
    pub(super) cancel_requested: bool,
    pub(super) last_error: Option<String>,
    pub(super) created_at: i64,
    pub(super) updated_at: i64,
}

#[derive(Debug, Clone)]
pub(super) struct KnowledgeBaseConfigRow {
    pub(super) ignore_rules: Vec<String>,
    pub(super) semantic_enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct KnowledgeRetrievalSettingsRow {
    pub(super) strategy: String,
    pub(super) selected_plan_id: String,
    pub(super) active_model_id: Option<String>,
    pub(super) active_model_version: Option<String>,
    pub(super) pending_model_id: Option<String>,
    pub(super) pending_model_version: Option<String>,
    pub(super) index_paused: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct KnowledgeDocumentRow {
    pub(super) id: String,
    pub(super) knowledge_base_id: String,
    pub(super) source_id: String,
    pub(super) relative_path: String,
    pub(super) file_name: String,
    pub(super) media_type: String,
    pub(super) size_bytes: i64,
    pub(super) modified_at: i64,
    pub(super) sha256: String,
    pub(super) parse_status: String,
    pub(super) parse_error: Option<String>,
    pub(super) chunk_count: i64,
    pub(super) updated_at: i64,
}

#[derive(Debug, Clone)]
pub(super) struct KnowledgeChunkInput {
    pub(super) ordinal: i64,
    pub(super) heading: Option<String>,
    pub(super) page_number: Option<i64>,
    pub(super) content_kind: String,
    pub(super) language: Option<String>,
    pub(super) start_line: Option<i64>,
    pub(super) end_line: Option<i64>,
    pub(super) estimated_tokens: i64,
    pub(super) content: String,
    pub(super) search_text: String,
    pub(super) content_hash: String,
}

#[derive(Debug, Clone)]
pub(super) struct KnowledgeEmbeddingChunk {
    pub(super) id: String,
    pub(super) content: String,
    pub(super) content_hash: String,
}

#[derive(Debug, Clone)]
pub(super) struct KnowledgeEmbeddingInput {
    pub(super) chunk_id: String,
    pub(super) content_hash: String,
    pub(super) vector: Vec<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct KnowledgeSemanticIndexSummary {
    pub(super) state: String,
    pub(super) indexed_chunks: i64,
    pub(super) total_chunks: i64,
    pub(super) error_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct KnowledgeSearchHit {
    #[serde(skip)]
    pub(super) chunk_id: String,
    pub(super) citation: String,
    pub(super) knowledge_base_id: String,
    pub(super) knowledge_base_name: String,
    pub(super) document_id: String,
    pub(super) file_name: String,
    pub(super) relative_path: String,
    pub(super) heading: Option<String>,
    pub(super) page_number: Option<i64>,
    pub(super) content_kind: String,
    pub(super) language: Option<String>,
    pub(super) start_line: Option<i64>,
    pub(super) end_line: Option<i64>,
    pub(super) content: String,
    pub(super) score: f64,
}

pub(super) struct KnowledgeHybridSearchRequest<'a> {
    pub(super) knowledge_base_ids: &'a [String],
    pub(super) semantic_knowledge_base_ids: &'a [String],
    pub(super) workspace_id: Option<&'a str>,
    pub(super) query: &'a str,
    pub(super) query_vector: &'a [f32],
    pub(super) model_id: &'a str,
    pub(super) model_version: &'a str,
    pub(super) limit: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct KnowledgeReadChunk {
    pub(super) ordinal: i64,
    pub(super) heading: Option<String>,
    pub(super) page_number: Option<i64>,
    pub(super) content_kind: String,
    pub(super) language: Option<String>,
    pub(super) start_line: Option<i64>,
    pub(super) end_line: Option<i64>,
    pub(super) content: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct QueuedMessageRow {
    pub(super) id: String,
    pub(super) thread_id: String,
    pub(super) position: i64,
    pub(super) revision: i64,
    pub(super) content: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) model_profile_id: Option<String>,
    pub(super) created_at: i64,
    pub(super) updated_at: i64,
}

type QueuedMessageSqlRow = (String, String, i64, i64, String, Option<String>, i64, i64);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThreadQueueRow {
    pub(super) paused: bool,
    pub(super) messages: Vec<QueuedMessageRow>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QueueTakeResult {
    message: QueuedMessageRow,
    queue: ThreadQueueRow,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentTaskCreate {
    id: String,
    parent_task_id: Option<String>,
    title: String,
    status: String,
    payload: Value,
}

impl Store {
    pub(super) fn open(data_directory: impl AsRef<Path>) -> Result<Self> {
        let data_directory = data_directory.as_ref();
        fs::create_dir_all(data_directory)?;
        let database_path = data_directory.join(DATABASE_FILE);
        let mut connection = Connection::open(&database_path)?;
        restrict_database_permissions(&database_path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        migrate(&mut connection)?;
        recover_interrupted_work(&mut connection)?;
        Ok(Self { connection })
    }

    pub(super) fn open_worker(data_directory: impl AsRef<Path>) -> Result<Self> {
        let database_path = data_directory.as_ref().join(DATABASE_FILE);
        let mut connection = Connection::open(&database_path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        migrate(&mut connection)?;
        Ok(Self { connection })
    }

    #[cfg(test)]
    pub(super) fn database_path(data_directory: &Path) -> std::path::PathBuf {
        data_directory.join(DATABASE_FILE)
    }

    pub(super) fn ensure_workspace(&mut self, workspace_id: &str, root: &str) -> Result<()> {
        validate_id("workspace_id", workspace_id)?;
        if root.is_empty() {
            return Err(PersistenceError::InvalidInput(
                "canonical workspace root must not be empty".to_owned(),
            ));
        }
        self.connection.execute(
            "INSERT INTO workspaces (id, canonical_root) VALUES (?1, ?2) \
             ON CONFLICT(id) DO UPDATE SET canonical_root = excluded.canonical_root, \
             updated_at = unixepoch()",
            params![workspace_id, root],
        )?;
        Ok(())
    }

    pub(super) fn project_environment_trusted(
        &mut self,
        canonical_root: &str,
        config_hash: &str,
    ) -> Result<bool> {
        validate_project_environment_trust(canonical_root, config_hash)?;
        self.connection
            .query_row(
                "SELECT config_hash = ?2 FROM project_environment_trust WHERE canonical_root = ?1",
                params![canonical_root, config_hash],
                |row| row.get(0),
            )
            .optional()
            .map(Option::unwrap_or_default)
            .map_err(Into::into)
    }

    pub(super) fn trust_project_environment(
        &mut self,
        canonical_root: &str,
        config_hash: &str,
    ) -> Result<()> {
        validate_project_environment_trust(canonical_root, config_hash)?;
        self.connection.execute(
            "INSERT INTO project_environment_trust (canonical_root, config_hash, trusted_at) \
             VALUES (?1, ?2, unixepoch()) ON CONFLICT(canonical_root) DO UPDATE SET \
             config_hash = excluded.config_hash, trusted_at = unixepoch()",
            params![canonical_root, config_hash],
        )?;
        Ok(())
    }

    pub(super) fn task_workspace(
        &mut self,
        thread_id: &str,
        workspace_id: &str,
    ) -> Result<TaskWorkspaceRow> {
        validate_id("thread_id", thread_id)?;
        validate_id("workspace_id", workspace_id)?;
        let exists: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM threads WHERE id = ?1 AND workspace_id = ?2)",
            params![thread_id, workspace_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(PersistenceError::InvalidInput(
                "task does not belong to the selected workspace".to_owned(),
            ));
        }
        Ok(self
            .connection
            .query_row(
                "SELECT thread_id, mode, task_root, branch FROM task_workspaces WHERE thread_id = ?1",
                [thread_id],
                |row| {
                    Ok(TaskWorkspaceRow {
                        thread_id: row.get(0)?,
                        mode: row.get(1)?,
                        task_root: row.get(2)?,
                        branch: row.get(3)?,
                    })
                },
            )
            .optional()?
            .unwrap_or(TaskWorkspaceRow {
                thread_id: thread_id.to_owned(),
                mode: "local".to_owned(),
                task_root: None,
                branch: None,
            }))
    }

    pub(super) fn task_workspaces(&mut self, workspace_id: &str) -> Result<Vec<TaskWorkspaceRow>> {
        validate_id("workspace_id", workspace_id)?;
        let mut statement = self.connection.prepare(
            "SELECT task_workspaces.thread_id, mode, task_root, branch FROM task_workspaces \
             JOIN threads ON threads.id = task_workspaces.thread_id \
             WHERE threads.workspace_id = ?1 AND mode = 'worktree'",
        )?;
        statement
            .query_map([workspace_id], |row| {
                Ok(TaskWorkspaceRow {
                    thread_id: row.get(0)?,
                    mode: row.get(1)?,
                    task_root: row.get(2)?,
                    branch: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub(super) fn set_task_workspace(
        &mut self,
        thread_id: &str,
        workspace_id: &str,
        mode: &str,
        task_root: Option<&str>,
        branch: Option<&str>,
    ) -> Result<TaskWorkspaceRow> {
        let _ = self.task_workspace(thread_id, workspace_id)?;
        match mode {
            "local" if task_root.is_none() && branch.is_none() => {
                self.connection.execute(
                    "DELETE FROM task_workspaces WHERE thread_id = ?1",
                    [thread_id],
                )?;
            }
            "worktree"
                if task_root.is_some_and(|value| !value.is_empty() && value.len() <= 16 * 1024)
                    && branch.is_some_and(|value| !value.is_empty() && value.len() <= 512) =>
            {
                self.connection.execute(
                    "INSERT INTO task_workspaces (thread_id, mode, task_root, branch, updated_at) \
                     VALUES (?1, 'worktree', ?2, ?3, unixepoch()) ON CONFLICT(thread_id) DO UPDATE SET \
                     mode = 'worktree', task_root = excluded.task_root, branch = excluded.branch, \
                     updated_at = unixepoch()",
                    params![thread_id, task_root, branch],
                )?;
            }
            _ => {
                return Err(PersistenceError::InvalidInput(
                    "task workspace binding is invalid".to_owned(),
                ));
            }
        }
        self.task_workspace(thread_id, workspace_id)
    }

    pub(super) fn record_asset(&mut self, asset: &AssetRow) -> Result<()> {
        validate_id("asset_id", &asset.asset_id)?;
        if asset.asset_id != format!("ast_{}", asset.sha256)
            || asset.media_type.is_empty()
            || asset.original_name.is_empty()
            || asset.size_bytes == 0
            || !matches!(asset.kind.as_str(), "image" | "video" | "pdf" | "text")
        {
            return Err(PersistenceError::InvalidInput(
                "content asset descriptor is invalid".to_owned(),
            ));
        }
        self.connection.execute(
            "INSERT INTO content_assets \
             (asset_id, sha256, media_type, original_name, size_bytes, kind, pdf_pages) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
             ON CONFLICT(asset_id) DO NOTHING",
            params![
                asset.asset_id,
                asset.sha256,
                asset.media_type,
                asset.original_name,
                asset.size_bytes,
                asset.kind,
                asset.pdf_pages
            ],
        )?;
        let existing = self.asset(&asset.asset_id)?;
        if existing.as_ref() != Some(asset) {
            return Err(PersistenceError::Conflict(format!(
                "asset {} was reused with different metadata",
                asset.asset_id
            )));
        }
        Ok(())
    }

    pub(super) fn asset(&mut self, asset_id: &str) -> Result<Option<AssetRow>> {
        validate_id("asset_id", asset_id)?;
        self.connection
            .query_row(
                "SELECT asset_id, sha256, media_type, original_name, size_bytes, kind, pdf_pages \
                 FROM content_assets WHERE asset_id = ?1",
                [asset_id],
                |row| {
                    Ok(AssetRow {
                        asset_id: row.get(0)?,
                        sha256: row.get(1)?,
                        media_type: row.get(2)?,
                        original_name: row.get(3)?,
                        size_bytes: row.get(4)?,
                        kind: row.get(5)?,
                        pdf_pages: row.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(PersistenceError::from)
    }

    pub(super) fn skill_preferences(&mut self) -> Result<std::collections::HashMap<String, bool>> {
        let mut statement = self
            .connection
            .prepare("SELECT skill_id, enabled FROM skill_preferences")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
        })?;
        rows.collect::<std::result::Result<std::collections::HashMap<_, _>, _>>()
            .map_err(Into::into)
    }

    pub(super) fn set_skill_enabled(&mut self, skill_id: &str, enabled: bool) -> Result<()> {
        if !skill_id.starts_with("skl_")
            || skill_id.len() != 68
            || !skill_id[4..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(PersistenceError::InvalidInput(
                "skill identifier is invalid".to_owned(),
            ));
        }
        self.connection.execute(
            "INSERT INTO skill_preferences (skill_id, enabled, updated_at) VALUES (?1, ?2, unixepoch()) \
             ON CONFLICT(skill_id) DO UPDATE SET enabled = excluded.enabled, updated_at = unixepoch()",
            params![skill_id, enabled],
        )?;
        Ok(())
    }

    pub(super) fn ensure_thread(
        &mut self,
        thread_id: &str,
        workspace_id: &str,
        title: Option<&str>,
    ) -> Result<()> {
        validate_id("thread_id", thread_id)?;
        validate_id("workspace_id", workspace_id)?;
        let existing_workspace: Option<String> = self
            .connection
            .query_row(
                "SELECT workspace_id FROM threads WHERE id = ?1",
                [thread_id],
                |row| row.get(0),
            )
            .optional()?;
        if existing_workspace
            .as_deref()
            .is_some_and(|id| id != workspace_id)
        {
            return Err(PersistenceError::Conflict(format!(
                "thread {thread_id} belongs to a different workspace"
            )));
        }
        self.connection.execute(
            "INSERT INTO threads (id, workspace_id, title) VALUES (?1, ?2, ?3) \
             ON CONFLICT(id) DO UPDATE SET title = COALESCE(excluded.title, threads.title), \
             updated_at = unixepoch()",
            params![thread_id, workspace_id, title],
        )?;
        Ok(())
    }

    pub(super) fn create_thread_json(
        &mut self,
        workspace_id: &str,
        title: Option<&str>,
    ) -> Result<String> {
        validate_id("workspace_id", workspace_id)?;
        validate_title(title)?;
        let thread_id = Uuid::now_v7().hyphenated().to_string();
        self.ensure_thread(&thread_id, workspace_id, title)?;
        self.load_thread_json(&thread_id)
    }

    pub(super) fn update_thread_title_json(
        &mut self,
        thread_id: &str,
        workspace_id: &str,
        title: &str,
        only_if_unset: bool,
    ) -> Result<String> {
        validate_id("thread_id", thread_id)?;
        validate_id("workspace_id", workspace_id)?;
        validate_title(Some(title))?;
        if title.trim().is_empty() {
            return Err(PersistenceError::InvalidInput(
                "thread title cannot be empty".to_owned(),
            ));
        }
        let changed = self.connection.execute(
            "UPDATE threads SET title = ?3, updated_at = unixepoch() \
             WHERE id = ?1 AND workspace_id = ?2 \
             AND (?4 = 0 OR title IS NULL)",
            params![thread_id, workspace_id, title, only_if_unset],
        )?;
        if changed == 0 {
            let exists = self
                .connection
                .query_row(
                    "SELECT 1 FROM threads WHERE id = ?1 AND workspace_id = ?2",
                    params![thread_id, workspace_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !exists {
                return Err(PersistenceError::InvalidInput(format!(
                    "thread {thread_id} was not found in workspace {workspace_id}"
                )));
            }
        }
        self.load_thread_json(thread_id)
    }

    pub(super) fn list_threads_json(
        &mut self,
        workspace_id: &str,
        query: Option<&str>,
    ) -> Result<String> {
        validate_id("workspace_id", workspace_id)?;
        let query = query.map(str::trim).filter(|value| !value.is_empty());
        if query.is_some_and(|value| value.len() > 256) {
            return Err(PersistenceError::InvalidInput(
                "thread search query is too long".to_owned(),
            ));
        }
        let pattern = query.map(|value| format!("%{}%", escape_like(value)));
        let mut statement = self.connection.prepare(
            "SELECT id, workspace_id, title, created_at, updated_at, archived_at, parent_thread_id \
             FROM threads WHERE workspace_id = ?1 AND archived_at IS NULL \
             AND (?2 IS NULL OR COALESCE(title, '') LIKE ?2 ESCAPE '\\') \
             ORDER BY updated_at DESC, id DESC LIMIT 200",
        )?;
        let threads = statement
            .query_map(params![workspace_id, pattern], thread_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(serde_json::to_string(&threads)?)
    }

    pub(super) fn delete_thread(&mut self, thread_id: &str, workspace_id: &str) -> Result<bool> {
        validate_id("thread_id", thread_id)?;
        validate_id("workspace_id", workspace_id)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let running: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM turns WHERE thread_id = ?1 AND status = 'running')",
            [thread_id],
            |row| row.get(0),
        )?;
        if running {
            return Err(PersistenceError::Conflict(format!(
                "thread {thread_id} has a running Turn"
            )));
        }
        let owned: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM threads WHERE id = ?1 AND workspace_id = ?2)",
            params![thread_id, workspace_id],
            |row| row.get(0),
        )?;
        if !owned {
            return Ok(false);
        }
        transaction.execute(
            "DELETE FROM approvals WHERE turn_id IN (SELECT id FROM turns WHERE thread_id = ?1)",
            [thread_id],
        )?;
        transaction.execute(
            "DELETE FROM operations WHERE turn_id IN (SELECT id FROM turns WHERE thread_id = ?1)",
            [thread_id],
        )?;
        transaction.execute(
            "DELETE FROM agent_tasks WHERE turn_id IN (SELECT id FROM turns WHERE thread_id = ?1)",
            [thread_id],
        )?;
        transaction.execute(
            "DELETE FROM turn_items WHERE turn_id IN (SELECT id FROM turns WHERE thread_id = ?1)",
            [thread_id],
        )?;
        transaction.execute("DELETE FROM turns WHERE thread_id = ?1", [thread_id])?;
        transaction.execute(
            "UPDATE threads SET parent_thread_id = NULL WHERE parent_thread_id = ?1",
            [thread_id],
        )?;
        let deleted = transaction.execute(
            "DELETE FROM threads WHERE id = ?1 AND workspace_id = ?2",
            params![thread_id, workspace_id],
        )?;
        transaction.commit()?;
        Ok(deleted == 1)
    }

    pub(super) fn start_turn(
        &mut self,
        turn_id: &str,
        thread_id: &str,
        request_id: &str,
        provider_wire_api: &str,
        model: &str,
    ) -> Result<()> {
        for (name, value) in [
            ("turn_id", turn_id),
            ("thread_id", thread_id),
            ("request_id", request_id),
        ] {
            validate_id(name, value)?;
        }
        if !matches!(
            provider_wire_api,
            "openaiResponses" | "openaiChatCompletions" | "anthropicMessages"
        ) {
            return Err(PersistenceError::InvalidInput(
                "unsupported provider wire API".to_owned(),
            ));
        }
        if model.is_empty() {
            return Err(PersistenceError::InvalidInput(
                "model must not be empty".to_owned(),
            ));
        }
        self.connection.execute(
            "INSERT INTO turns \
             (id, thread_id, request_id, status, provider_wire_api, model) \
             VALUES (?1, ?2, ?3, 'running', ?4, ?5)",
            params![turn_id, thread_id, request_id, provider_wire_api, model],
        )?;
        self.connection.execute(
            "UPDATE threads SET updated_at = unixepoch() WHERE id = ?1",
            [thread_id],
        )?;
        Ok(())
    }

    // Keep this boundary aligned with the versioned Native method. Grouping the
    // fields here would create a second representation of the atomic request.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn replace_latest_turn_with_user_message(
        &mut self,
        replaced_turn_id: &str,
        turn_id: &str,
        thread_id: &str,
        request_id: &str,
        provider_wire_api: &str,
        model: &str,
        user_content_json: &str,
    ) -> Result<()> {
        for (name, value) in [
            ("replaced_turn_id", replaced_turn_id),
            ("turn_id", turn_id),
            ("thread_id", thread_id),
            ("request_id", request_id),
        ] {
            validate_id(name, value)?;
        }
        if !matches!(
            provider_wire_api,
            "openaiResponses" | "openaiChatCompletions" | "anthropicMessages"
        ) {
            return Err(PersistenceError::InvalidInput(
                "unsupported provider wire API".to_owned(),
            ));
        }
        if model.is_empty() {
            return Err(PersistenceError::InvalidInput(
                "model must not be empty".to_owned(),
            ));
        }
        let user_content: Value = serde_json::from_str(user_content_json)?;
        if user_content
            .as_array()
            .is_none_or(|content| content.is_empty())
        {
            return Err(PersistenceError::InvalidInput(
                "user content must be a non-empty JSON array".to_owned(),
            ));
        }
        let user_item_id = format!("{turn_id}:user");
        validate_id("user_item_id", &user_item_id)?;
        let user_payload_json = serde_json::to_string(&serde_json::json!({
            "content": user_content,
        }))?;

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let latest: Option<(String, String)> = transaction
            .query_row(
                "SELECT id, status FROM turns WHERE thread_id = ?1 \
                 ORDER BY started_at DESC, id DESC LIMIT 1",
                [thread_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if latest.as_ref().map(|(id, _)| id.as_str()) != Some(replaced_turn_id) {
            return Err(PersistenceError::Conflict(format!(
                "turn {replaced_turn_id} is not the latest Turn"
            )));
        }
        if latest
            .as_ref()
            .is_some_and(|(_, status)| status == "running")
        {
            return Err(PersistenceError::Conflict(format!(
                "turn {replaced_turn_id} is still running"
            )));
        }

        transaction.execute(
            "DELETE FROM approvals WHERE turn_id = ?1",
            [replaced_turn_id],
        )?;
        transaction.execute(
            "DELETE FROM operations WHERE turn_id = ?1",
            [replaced_turn_id],
        )?;
        transaction.execute(
            "DELETE FROM agent_tasks WHERE turn_id = ?1",
            [replaced_turn_id],
        )?;
        transaction.execute(
            "DELETE FROM turn_items WHERE turn_id = ?1",
            [replaced_turn_id],
        )?;
        transaction.execute(
            "DELETE FROM turns WHERE id = ?1 AND thread_id = ?2",
            params![replaced_turn_id, thread_id],
        )?;
        transaction.execute(
            "INSERT INTO turns \
             (id, thread_id, request_id, status, provider_wire_api, model) \
             VALUES (?1, ?2, ?3, 'running', ?4, ?5)",
            params![turn_id, thread_id, request_id, provider_wire_api, model],
        )?;
        transaction.execute(
            "INSERT INTO turn_items (id, turn_id, sequence, kind, payload_json) \
             VALUES (?1, ?2, 0, 'turn.userMessage', ?3)",
            params![user_item_id, turn_id, user_payload_json],
        )?;
        transaction.execute(
            "UPDATE threads SET updated_at = unixepoch() WHERE id = ?1",
            [thread_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub(super) fn append_item(
        &mut self,
        item_id: &str,
        turn_id: &str,
        sequence: i64,
        kind: &str,
        payload_json: &str,
    ) -> Result<bool> {
        validate_id("item_id", item_id)?;
        validate_id("turn_id", turn_id)?;
        if sequence < 1 || kind.is_empty() {
            return Err(PersistenceError::InvalidInput(
                "item sequence and kind are invalid".to_owned(),
            ));
        }
        validate_json(payload_json)?;
        let inserted = self.connection.execute(
            "INSERT INTO turn_items (id, turn_id, sequence, kind, payload_json) \
             VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(id) DO NOTHING",
            params![item_id, turn_id, sequence, kind, payload_json],
        )?;
        if inserted == 0 {
            let existing: Option<(String, i64, String, String)> = self
                .connection
                .query_row(
                    "SELECT turn_id, sequence, kind, payload_json FROM turn_items WHERE id = ?1",
                    [item_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()?;
            if existing.as_ref()
                != Some(&(
                    turn_id.to_owned(),
                    sequence,
                    kind.to_owned(),
                    payload_json.to_owned(),
                ))
            {
                return Err(PersistenceError::Conflict(format!(
                    "item {item_id} was reused with different content"
                )));
            }
        }
        Ok(inserted == 1)
    }

    pub(super) fn finish_turn(
        &mut self,
        turn_id: &str,
        status: &str,
        error_json: Option<&str>,
    ) -> Result<bool> {
        validate_id("turn_id", turn_id)?;
        if !matches!(status, "completed" | "interrupted" | "failed") {
            return Err(PersistenceError::InvalidInput(
                "invalid terminal Turn status".to_owned(),
            ));
        }
        if let Some(error_json) = error_json {
            validate_json(error_json)?;
        }
        let updated = self.connection.execute(
            "UPDATE turns SET status = ?2, error_json = ?3, completed_at = unixepoch() \
             WHERE id = ?1 AND status = 'running'",
            params![turn_id, status, error_json],
        )?;
        if updated == 0 {
            let existing: Option<(String, Option<String>)> = self
                .connection
                .query_row(
                    "SELECT status, error_json FROM turns WHERE id = ?1",
                    [turn_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if existing.as_ref() != Some(&(status.to_owned(), error_json.map(str::to_owned))) {
                return Err(PersistenceError::Conflict(format!(
                    "Turn {turn_id} already has a different terminal result"
                )));
            }
        }
        Ok(updated == 1)
    }

    pub(super) fn create_agent_tasks_json(
        &mut self,
        turn_id: &str,
        tasks_json: &str,
    ) -> Result<String> {
        validate_id("turn_id", turn_id)?;
        let tasks: Vec<AgentTaskCreate> = serde_json::from_str(tasks_json)?;
        if tasks.is_empty() || tasks.len() > 12 {
            return Err(PersistenceError::InvalidInput(
                "an Agent task batch must contain 1 to 12 tasks".to_owned(),
            ));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let turn_running: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM turns WHERE id = ?1 AND status = 'running')",
            [turn_id],
            |row| row.get(0),
        )?;
        if !turn_running {
            return Err(PersistenceError::Conflict(format!(
                "Turn {turn_id} is not running"
            )));
        }
        let mut inserted_count = 0usize;
        for task in tasks {
            validate_agent_task_create(&task)?;
            let payload_json = serde_json::to_string(&task.payload)?;
            let inserted = transaction.execute(
                "INSERT INTO agent_tasks \
                 (id, turn_id, parent_task_id, title, status, payload_json) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(id) DO NOTHING",
                params![
                    task.id,
                    turn_id,
                    task.parent_task_id,
                    task.title,
                    task.status,
                    payload_json
                ],
            )?;
            if inserted == 0 {
                let existing: (String, Option<String>, String, String, String) = transaction
                    .query_row(
                        "SELECT turn_id, parent_task_id, title, status, payload_json \
                         FROM agent_tasks WHERE id = ?1",
                        [&task.id],
                        |row| {
                            Ok((
                                row.get(0)?,
                                row.get(1)?,
                                row.get(2)?,
                                row.get(3)?,
                                row.get(4)?,
                            ))
                        },
                    )?;
                if existing
                    != (
                        turn_id.to_owned(),
                        task.parent_task_id,
                        task.title,
                        task.status,
                        payload_json,
                    )
                {
                    return Err(PersistenceError::Conflict(format!(
                        "Agent task {} was reused with different content",
                        task.id
                    )));
                }
            } else {
                inserted_count += 1;
            }
        }
        transaction.commit()?;
        Ok(serde_json::to_string(&serde_json::json!({
            "inserted": inserted_count
        }))?)
    }

    pub(super) fn update_agent_task(
        &mut self,
        task_id: &str,
        status: &str,
        payload_json: &str,
    ) -> Result<bool> {
        validate_id("task_id", task_id)?;
        validate_agent_task_status(status)?;
        let payload: Value = serde_json::from_str(payload_json)?;
        validate_agent_task_payload(task_id, status, &payload)?;
        let canonical_payload = serde_json::to_string(&payload)?;
        let existing: Option<(String, String)> = self
            .connection
            .query_row(
                "SELECT status, payload_json FROM agent_tasks WHERE id = ?1",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((existing_status, existing_payload)) = existing else {
            return Err(PersistenceError::InvalidInput(format!(
                "Agent task {task_id} does not exist"
            )));
        };
        if existing_status == status && existing_payload == canonical_payload {
            return Ok(false);
        }
        if agent_task_terminal(&existing_status)
            || (existing_status != status
                && !agent_task_transition_allowed(&existing_status, status))
        {
            return Err(PersistenceError::Conflict(format!(
                "Agent task {task_id} cannot transition from {existing_status} to {status}"
            )));
        }
        self.connection.execute(
            "UPDATE agent_tasks SET status = ?2, payload_json = ?3, updated_at = unixepoch() \
             WHERE id = ?1",
            params![task_id, status, canonical_payload],
        )?;
        Ok(true)
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn propose_operation(
        &mut self,
        operation_id: &str,
        approval_id: &str,
        turn_id: &str,
        tool_name: &str,
        request_hash: &str,
        arguments_json: &str,
        approval_payload_json: &str,
    ) -> Result<bool> {
        for (name, value) in [
            ("operation_id", operation_id),
            ("approval_id", approval_id),
            ("turn_id", turn_id),
        ] {
            validate_id(name, value)?;
        }
        if tool_name.is_empty() || request_hash.is_empty() {
            return Err(PersistenceError::InvalidInput(
                "operation tool name and request hash must not be empty".to_owned(),
            ));
        }
        validate_json(arguments_json)?;
        validate_json(approval_payload_json)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let inserted = transaction.execute(
            "INSERT INTO operations \
             (id, turn_id, tool_name, request_hash, arguments_json, status) \
             VALUES (?1, ?2, ?3, ?4, ?5, 'proposed') \
             ON CONFLICT(id) DO NOTHING",
            params![
                operation_id,
                turn_id,
                tool_name,
                request_hash,
                arguments_json
            ],
        )?;
        if inserted == 0 {
            let existing: (String, String, String, String) = transaction.query_row(
                "SELECT turn_id, tool_name, request_hash, arguments_json \
                 FROM operations WHERE id = ?1",
                [operation_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            if existing
                != (
                    turn_id.to_owned(),
                    tool_name.to_owned(),
                    request_hash.to_owned(),
                    arguments_json.to_owned(),
                )
            {
                return Err(PersistenceError::Conflict(format!(
                    "operation {operation_id} was reused with different content"
                )));
            }
        }
        let approval_inserted = transaction.execute(
            "INSERT INTO approvals (id, operation_id, turn_id, status, payload_json) \
             VALUES (?1, ?2, ?3, 'pending', ?4) \
             ON CONFLICT(id) DO NOTHING",
            params![approval_id, operation_id, turn_id, approval_payload_json],
        )?;
        if approval_inserted == 0 {
            let existing: (String, String, Option<String>) = transaction.query_row(
                "SELECT operation_id, turn_id, payload_json FROM approvals WHERE id = ?1",
                [approval_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            if existing
                != (
                    operation_id.to_owned(),
                    turn_id.to_owned(),
                    Some(approval_payload_json.to_owned()),
                )
            {
                return Err(PersistenceError::Conflict(format!(
                    "approval {approval_id} was reused for a different operation"
                )));
            }
        }
        transaction.commit()?;
        Ok(inserted == 1)
    }

    pub(super) fn list_pending_approvals_json(&mut self) -> Result<String> {
        let mut statement = self.connection.prepare(
            "SELECT a.id, a.operation_id, a.turn_id, t.request_id, th.id, th.workspace_id, \
             o.tool_name, o.request_hash, o.arguments_json, a.payload_json \
             FROM approvals a \
             JOIN operations o ON o.id = a.operation_id \
             JOIN turns t ON t.id = a.turn_id \
             JOIN threads th ON th.id = t.thread_id \
             WHERE a.status = 'pending' AND o.status = 'proposed' \
             ORDER BY a.created_at, a.id",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let records = rows
            .into_iter()
            .map(
                |(
                    approval_id,
                    operation_id,
                    turn_id,
                    request_id,
                    thread_id,
                    workspace_id,
                    tool_name,
                    request_hash,
                    arguments_json,
                    approval_payload_json,
                )| {
                    Ok(serde_json::json!({
                        "approvalId": approval_id,
                        "operationId": operation_id,
                        "turnId": turn_id,
                        "requestId": request_id,
                        "threadId": thread_id,
                        "workspaceId": workspace_id,
                        "toolName": tool_name,
                        "requestHash": request_hash,
                        "argumentsJson": arguments_json,
                        "approval": approval_payload_json
                            .map(|payload| serde_json::from_str::<Value>(&payload))
                            .transpose()?,
                    }))
                },
            )
            .collect::<Result<Vec<_>>>()?;
        Ok(serde_json::to_string(&records)?)
    }

    pub(super) fn resolve_approval(&mut self, approval_id: &str, decision: &str) -> Result<bool> {
        validate_id("approval_id", approval_id)?;
        if !matches!(decision, "approved" | "denied") {
            return Err(PersistenceError::InvalidInput(
                "approval decision must be approved or denied".to_owned(),
            ));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let updated = transaction.execute(
            "UPDATE approvals SET status = ?2, updated_at = unixepoch() \
             WHERE id = ?1 AND status = 'pending'",
            params![approval_id, decision],
        )?;
        let (operation_id, existing): (String, String) = transaction.query_row(
            "SELECT operation_id, status FROM approvals WHERE id = ?1",
            [approval_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if updated == 0 && existing != decision {
            return Err(PersistenceError::Conflict(format!(
                "approval {approval_id} was already resolved as {existing}"
            )));
        }
        if updated == 1 {
            let operation_status = if decision == "approved" {
                "executing"
            } else {
                "denied"
            };
            let claimed = transaction.execute(
                "UPDATE operations SET status = ?2, updated_at = unixepoch() \
                 WHERE id = ?1 AND status = 'proposed'",
                params![operation_id, operation_status],
            )?;
            if claimed != 1 {
                return Err(PersistenceError::Conflict(format!(
                    "approval {approval_id} does not own a proposed operation"
                )));
            }
        }
        transaction.commit()?;
        Ok(updated == 1)
    }

    pub(super) fn complete_operation(
        &mut self,
        operation_id: &str,
        result_json: &str,
        succeeded: bool,
    ) -> Result<bool> {
        validate_id("operation_id", operation_id)?;
        validate_json(result_json)?;
        let status = if succeeded { "completed" } else { "failed" };
        let updated = self.connection.execute(
            "UPDATE operations SET status = ?2, result_json = ?3, updated_at = unixepoch() \
             WHERE id = ?1 AND status = 'executing'",
            params![operation_id, status, result_json],
        )?;
        if updated == 0 {
            let existing: Option<(String, Option<String>)> = self
                .connection
                .query_row(
                    "SELECT status, result_json FROM operations WHERE id = ?1",
                    [operation_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if existing.as_ref() != Some(&(status.to_owned(), Some(result_json.to_owned()))) {
                return Err(PersistenceError::Conflict(format!(
                    "operation {operation_id} is not executing or has a different result"
                )));
            }
        }
        Ok(updated == 1)
    }

    pub(super) fn create_queued_message_json(
        &mut self,
        thread_id: &str,
        message_id: &str,
        content_json: &str,
        model_profile_id: Option<&str>,
    ) -> Result<String> {
        validate_id("thread_id", thread_id)?;
        validate_id("queue_message_id", message_id)?;
        validate_model_profile_id(model_profile_id)?;
        let content = validate_queued_content(content_json)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let owned: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM threads WHERE id = ?1)",
            [thread_id],
            |row| row.get(0),
        )?;
        if !owned {
            return Err(PersistenceError::InvalidInput(format!(
                "thread {thread_id} was not found"
            )));
        }
        let count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM queued_messages WHERE thread_id = ?1",
            [thread_id],
            |row| row.get(0),
        )?;
        if count >= MAX_QUEUED_MESSAGES {
            return Err(PersistenceError::Conflict("queueFull".to_owned()));
        }
        let position: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(position), 0) + 1 FROM queued_messages WHERE thread_id = ?1",
            [thread_id],
            |row| row.get(0),
        )?;
        transaction.execute(
            "INSERT INTO thread_queues (thread_id, paused, updated_at) VALUES (?1, 0, unixepoch()) \
             ON CONFLICT(thread_id) DO UPDATE SET updated_at = unixepoch()",
            [thread_id],
        )?;
        transaction.execute(
            "INSERT INTO queued_messages \
             (id, thread_id, position, revision, content_json, model_profile_id) \
             VALUES (?1, ?2, ?3, 1, ?4, ?5)",
            params![
                message_id,
                thread_id,
                position,
                serde_json::to_string(&content)?,
                model_profile_id
            ],
        )?;
        transaction.execute(
            "UPDATE threads SET updated_at = unixepoch() WHERE id = ?1",
            [thread_id],
        )?;
        let queue = load_thread_queue(&transaction, thread_id)?;
        transaction.commit()?;
        Ok(serde_json::to_string(&queue)?)
    }

    pub(super) fn update_queued_message_json(
        &mut self,
        thread_id: &str,
        message_id: &str,
        expected_revision: i64,
        content_json: &str,
        model_profile_id: Option<&str>,
    ) -> Result<String> {
        validate_id("thread_id", thread_id)?;
        validate_id("queue_message_id", message_id)?;
        validate_model_profile_id(model_profile_id)?;
        if expected_revision < 1 {
            return Err(PersistenceError::InvalidInput(
                "queue revision is invalid".to_owned(),
            ));
        }
        let content = validate_queued_content(content_json)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let updated = transaction.execute(
            "UPDATE queued_messages SET content_json = ?4, model_profile_id = ?5, \
             revision = revision + 1, updated_at = unixepoch() \
             WHERE id = ?1 AND thread_id = ?2 AND revision = ?3",
            params![
                message_id,
                thread_id,
                expected_revision,
                serde_json::to_string(&content)?,
                model_profile_id
            ],
        )?;
        if updated == 0 {
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM queued_messages WHERE id = ?1 AND thread_id = ?2)",
                params![message_id, thread_id],
                |row| row.get(0),
            )?;
            return Err(PersistenceError::Conflict(
                if exists {
                    "queueRevisionMismatch"
                } else {
                    "queueItemNotFound"
                }
                .to_owned(),
            ));
        }
        transaction.execute(
            "UPDATE thread_queues SET updated_at = unixepoch() WHERE thread_id = ?1",
            [thread_id],
        )?;
        let queue = load_thread_queue(&transaction, thread_id)?;
        transaction.commit()?;
        Ok(serde_json::to_string(&queue)?)
    }

    pub(super) fn delete_queued_message_json(
        &mut self,
        thread_id: &str,
        message_id: &str,
        expected_revision: i64,
    ) -> Result<String> {
        validate_id("thread_id", thread_id)?;
        validate_id("queue_message_id", message_id)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let deleted = transaction.execute(
            "DELETE FROM queued_messages WHERE id = ?1 AND thread_id = ?2 AND revision = ?3",
            params![message_id, thread_id, expected_revision],
        )?;
        if deleted == 0 {
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM queued_messages WHERE id = ?1 AND thread_id = ?2)",
                params![message_id, thread_id],
                |row| row.get(0),
            )?;
            return Err(PersistenceError::Conflict(
                if exists {
                    "queueRevisionMismatch"
                } else {
                    "queueItemNotFound"
                }
                .to_owned(),
            ));
        }
        cleanup_empty_queue(&transaction, thread_id)?;
        let queue = load_thread_queue(&transaction, thread_id)?;
        transaction.commit()?;
        Ok(serde_json::to_string(&queue)?)
    }

    pub(super) fn set_queue_paused_json(
        &mut self,
        thread_id: &str,
        paused: bool,
    ) -> Result<String> {
        validate_id("thread_id", thread_id)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM queued_messages WHERE thread_id = ?1",
            [thread_id],
            |row| row.get(0),
        )?;
        if count == 0 {
            transaction.execute(
                "DELETE FROM thread_queues WHERE thread_id = ?1",
                [thread_id],
            )?;
        } else {
            transaction.execute(
                "INSERT INTO thread_queues (thread_id, paused, updated_at) VALUES (?1, ?2, unixepoch()) \
                 ON CONFLICT(thread_id) DO UPDATE SET paused = excluded.paused, updated_at = unixepoch()",
                params![thread_id, paused],
            )?;
        }
        let queue = load_thread_queue(&transaction, thread_id)?;
        transaction.commit()?;
        Ok(serde_json::to_string(&queue)?)
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn promote_queued_message_json(
        &mut self,
        thread_id: &str,
        message_id: &str,
        expected_revision: i64,
        turn_id: &str,
        request_id: &str,
        provider_wire_api: &str,
        model: &str,
    ) -> Result<String> {
        validate_turn_identity(turn_id, thread_id, request_id, provider_wire_api, model)?;
        validate_id("queue_message_id", message_id)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let queue = load_thread_queue(&transaction, thread_id)?;
        if queue.paused {
            return Err(PersistenceError::Conflict("queuePaused".to_owned()));
        }
        let message = queue
            .messages
            .first()
            .filter(|message| message.id == message_id && message.revision == expected_revision)
            .cloned()
            .ok_or_else(|| PersistenceError::Conflict("queueRevisionMismatch".to_owned()))?;
        transaction.execute(
            "INSERT INTO turns \
             (id, thread_id, request_id, status, provider_wire_api, model) \
             VALUES (?1, ?2, ?3, 'running', ?4, ?5)",
            params![turn_id, thread_id, request_id, provider_wire_api, model],
        )?;
        transaction.execute(
            "INSERT INTO turn_items (id, turn_id, sequence, kind, payload_json) \
             VALUES (?1, ?2, 0, 'turn.userMessage', ?3)",
            params![
                format!("{turn_id}:user"),
                turn_id,
                serde_json::to_string(&serde_json::json!({ "content": message.content }))?
            ],
        )?;
        transaction.execute("DELETE FROM queued_messages WHERE id = ?1", [message_id])?;
        cleanup_empty_queue(&transaction, thread_id)?;
        transaction.execute(
            "UPDATE threads SET updated_at = unixepoch() WHERE id = ?1",
            [thread_id],
        )?;
        let result = QueueTakeResult {
            message,
            queue: load_thread_queue(&transaction, thread_id)?,
        };
        transaction.commit()?;
        Ok(serde_json::to_string(&result)?)
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn steer_queued_message_json(
        &mut self,
        thread_id: &str,
        message_id: &str,
        expected_revision: i64,
        turn_id: &str,
        item_id: &str,
        sequence: i64,
    ) -> Result<String> {
        for (name, value) in [
            ("thread_id", thread_id),
            ("queue_message_id", message_id),
            ("turn_id", turn_id),
            ("item_id", item_id),
        ] {
            validate_id(name, value)?;
        }
        if sequence < 1 {
            return Err(PersistenceError::InvalidInput(
                "item sequence is invalid".to_owned(),
            ));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let active: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM turns WHERE id = ?1 AND thread_id = ?2 AND status = 'running')",
            params![turn_id, thread_id],
            |row| row.get(0),
        )?;
        if !active {
            return Err(PersistenceError::Conflict("turnMismatch".to_owned()));
        }
        let message = load_queued_message(&transaction, thread_id, message_id)?
            .ok_or_else(|| PersistenceError::Conflict("queueItemNotFound".to_owned()))?;
        if message.revision != expected_revision {
            return Err(PersistenceError::Conflict(
                "queueRevisionMismatch".to_owned(),
            ));
        }
        transaction.execute(
            "INSERT INTO turn_items (id, turn_id, sequence, kind, payload_json) \
             VALUES (?1, ?2, ?3, 'turn.userMessage', ?4)",
            params![
                item_id,
                turn_id,
                sequence,
                serde_json::to_string(&serde_json::json!({ "content": message.content }))?
            ],
        )?;
        transaction.execute("DELETE FROM queued_messages WHERE id = ?1", [message_id])?;
        cleanup_empty_queue(&transaction, thread_id)?;
        let result = QueueTakeResult {
            message,
            queue: load_thread_queue(&transaction, thread_id)?,
        };
        transaction.commit()?;
        Ok(serde_json::to_string(&result)?)
    }

    pub(super) fn load_thread_json(&mut self, thread_id: &str) -> Result<String> {
        validate_id("thread_id", thread_id)?;
        let thread = self.connection.query_row(
            "SELECT id, workspace_id, title, created_at, updated_at, archived_at, parent_thread_id \
             FROM threads WHERE id = ?1",
            [thread_id],
            thread_row,
        )?;
        let mut statement = self.connection.prepare(
            "SELECT id, request_id, status, provider_wire_api, model, error_json, \
             started_at, completed_at FROM turns WHERE thread_id = ?1 ORDER BY started_at, id",
        )?;
        let turns = statement
            .query_map([thread_id], |row| {
                Ok(TurnRow {
                    id: row.get(0)?,
                    request_id: row.get(1)?,
                    status: row.get(2)?,
                    provider_wire_api: row.get(3)?,
                    model: row.get(4)?,
                    error_json: row.get(5)?,
                    started_at: row.get(6)?,
                    completed_at: row.get(7)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut items_statement = self.connection.prepare(
            "SELECT id, turn_id, sequence, kind, payload_json FROM turn_items \
             WHERE turn_id IN (SELECT id FROM turns WHERE thread_id = ?1) \
             ORDER BY sequence, id",
        )?;
        let items = items_statement
            .query_map([thread_id], |row| {
                let payload: String = row.get(4)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    payload,
                ))
            })?
            .map(|row| {
                let (id, turn_id, sequence, kind, payload) = row?;
                Ok(ItemRow {
                    id,
                    turn_id,
                    sequence,
                    kind,
                    payload: serde_json::from_str(&payload)?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let mut tasks_statement = self.connection.prepare(
            "SELECT id, turn_id, parent_task_id, title, status, payload_json, \
             created_at, updated_at FROM agent_tasks \
             WHERE turn_id IN (SELECT id FROM turns WHERE thread_id = ?1) \
             ORDER BY created_at, id",
        )?;
        let agent_tasks = tasks_statement
            .query_map([thread_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            })?
            .map(|row| {
                let (id, turn_id, parent_task_id, title, status, payload, created_at, updated_at) =
                    row?;
                Ok(AgentTaskRow {
                    id,
                    turn_id,
                    parent_task_id,
                    title,
                    status,
                    payload: serde_json::from_str(&payload)?,
                    created_at,
                    updated_at,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(serde_json::to_string(&ThreadSnapshot {
            thread,
            turns,
            items,
            agent_tasks,
            queue: load_thread_queue(&self.connection, thread_id)?,
        })?)
    }

    pub(super) fn inspect_model_config_json(&mut self) -> Result<String> {
        Ok(serde_json::to_string(&model_config_inspection(
            &self.connection,
        )?)?)
    }

    pub(super) fn inspect_mcp_config_json(&mut self) -> Result<String> {
        Ok(serde_json::to_string(&mcp_config_inspection(
            &self.connection,
        )?)?)
    }

    pub(super) fn save_mcp_config_json(
        &mut self,
        expected_revision: &str,
        servers_json: &str,
    ) -> Result<String> {
        validate_revision(expected_revision)?;
        let inputs: Vec<McpServerInput> = serde_json::from_str(servers_json)?;
        let servers = validated_mcp_servers(inputs)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = mcp_config_inspection(&transaction)?;
        if current.revision != expected_revision {
            return Ok(serde_json::to_string(&McpConfigAction {
                accepted: false,
                reason: "stale",
                inspection: Some(current),
            })?);
        }
        transaction.execute(
            "INSERT INTO mcp_config (singleton, config_json, updated_at) \
             VALUES (1, ?1, unixepoch()) ON CONFLICT(singleton) DO UPDATE SET \
             config_json = excluded.config_json, updated_at = excluded.updated_at",
            [serde_json::to_string(&servers)?],
        )?;
        transaction.commit()?;
        Ok(serde_json::to_string(&McpConfigAction {
            accepted: true,
            reason: "accepted",
            inspection: Some(mcp_config_inspection(&self.connection)?),
        })?)
    }

    pub(super) fn save_model_config_json(
        &mut self,
        expected_revision: &str,
        config_json: &str,
        credential_updates_json: &str,
    ) -> Result<String> {
        validate_revision(expected_revision)?;
        let config: Value = serde_json::from_str(config_json)?;
        let updates: Vec<CredentialUpdate> = serde_json::from_str(credential_updates_json)?;
        let connection_ids = model_connection_ids(&config)?;
        if updates.len() != connection_ids.len()
            || updates
                .iter()
                .any(|update| !connection_ids.iter().any(|id| id == update.connection_id()))
        {
            return Err(PersistenceError::InvalidInput(
                "credential updates do not match model connections".to_owned(),
            ));
        }
        let canonical_config = serde_json::to_string(&config)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = model_config_inspection(&transaction)?;
        if current.revision != expected_revision {
            return Ok(serde_json::to_string(&ModelConfigAction {
                accepted: false,
                state: "blocked",
                reason: Some("stale"),
                inspection: Some(current),
            })?);
        }
        transaction.execute(
            "INSERT INTO model_config (singleton, config_json, updated_at) \
             VALUES (1, ?1, unixepoch()) ON CONFLICT(singleton) DO UPDATE SET \
             config_json = excluded.config_json, updated_at = excluded.updated_at",
            [&canonical_config],
        )?;
        for update in updates {
            match update {
                CredentialUpdate::Preserve { .. } => {}
                CredentialUpdate::Set {
                    connection_id,
                    value,
                } => {
                    transaction.execute(
                        "INSERT INTO model_credentials (connection_id, api_key, updated_at) \
                         VALUES (?1, ?2, unixepoch()) ON CONFLICT(connection_id) DO UPDATE SET \
                         api_key = excluded.api_key, updated_at = excluded.updated_at",
                        params![connection_id, value],
                    )?;
                }
                CredentialUpdate::Delete { connection_id } => {
                    transaction.execute(
                        "DELETE FROM model_credentials WHERE connection_id = ?1",
                        [connection_id],
                    )?;
                }
            }
        }
        let placeholders = connection_ids.iter().map(|_| "?").collect::<Vec<_>>();
        if !placeholders.is_empty() {
            let sql = format!(
                "DELETE FROM model_credentials WHERE connection_id NOT IN ({})",
                placeholders.join(",")
            );
            transaction.execute(&sql, rusqlite::params_from_iter(connection_ids.iter()))?;
        }
        transaction.commit()?;
        let inspection = model_config_inspection(&self.connection)?;
        Ok(serde_json::to_string(&ModelConfigAction {
            accepted: true,
            state: "saved",
            reason: None,
            inspection: Some(inspection),
        })?)
    }

    pub(super) fn delete_model_api_key_json(
        &mut self,
        connection_id: &str,
        expected_revision: &str,
    ) -> Result<String> {
        validate_id("connection_id", connection_id)?;
        validate_revision(expected_revision)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = model_config_inspection(&transaction)?;
        if current.revision != expected_revision {
            return Ok(serde_json::to_string(&ModelConfigAction {
                accepted: false,
                state: "blocked",
                reason: Some("stale"),
                inspection: Some(current),
            })?);
        }
        let deleted = transaction.execute(
            "DELETE FROM model_credentials WHERE connection_id = ?1",
            [connection_id],
        )?;
        if deleted == 0 {
            return Ok(serde_json::to_string(&ModelConfigAction {
                accepted: false,
                state: "failed",
                reason: Some("invalid"),
                inspection: Some(current),
            })?);
        }
        transaction.commit()?;
        let inspection = model_config_inspection(&self.connection)?;
        Ok(serde_json::to_string(&ModelConfigAction {
            accepted: true,
            state: "saved",
            reason: None,
            inspection: Some(inspection),
        })?)
    }

    pub(super) fn model_connection_json(&mut self, connection_id: &str) -> Result<String> {
        validate_id("connection_id", connection_id)?;
        let config = current_model_config(&self.connection)?.ok_or_else(|| {
            PersistenceError::InvalidInput("model configuration is not set".to_owned())
        })?;
        let connection = config
            .get("connections")
            .and_then(Value::as_array)
            .and_then(|connections| {
                connections.iter().find(|connection| {
                    connection.get("id").and_then(Value::as_str) == Some(connection_id)
                })
            })
            .cloned()
            .ok_or_else(|| {
                PersistenceError::InvalidInput(format!(
                    "model connection {connection_id} does not exist"
                ))
            })?;
        let api_key: Option<String> = self
            .connection
            .query_row(
                "SELECT api_key FROM model_credentials WHERE connection_id = ?1",
                [connection_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(serde_json::to_string(&serde_json::json!({
            "connection": connection,
            "apiKey": api_key,
        }))?)
    }

    pub(super) fn model_profile_json(&mut self, profile_id: Option<&str>) -> Result<String> {
        let config = current_model_config(&self.connection)?.ok_or_else(|| {
            PersistenceError::InvalidInput("model configuration is not set".to_owned())
        })?;
        let selected_id = profile_id
            .or_else(|| config.get("defaultProfileId").and_then(Value::as_str))
            .ok_or_else(|| {
                PersistenceError::InvalidInput("default model profile is missing".to_owned())
            })?;
        let profile = config
            .get("profiles")
            .and_then(Value::as_array)
            .and_then(|profiles| {
                profiles
                    .iter()
                    .find(|profile| profile.get("id").and_then(Value::as_str) == Some(selected_id))
            })
            .cloned()
            .ok_or_else(|| {
                PersistenceError::InvalidInput(format!(
                    "model profile {selected_id} does not exist"
                ))
            })?;
        let connection_id = profile
            .get("connectionId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                PersistenceError::InvalidInput("profile connection is missing".to_owned())
            })?;
        let connection: Value = config
            .get("connections")
            .and_then(Value::as_array)
            .and_then(|connections| {
                connections.iter().find(|connection| {
                    connection.get("id").and_then(Value::as_str) == Some(connection_id)
                })
            })
            .cloned()
            .ok_or_else(|| {
                PersistenceError::InvalidInput("profile connection does not exist".to_owned())
            })?;
        let api_key: Option<String> = self
            .connection
            .query_row(
                "SELECT api_key FROM model_credentials WHERE connection_id = ?1",
                [connection_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(serde_json::to_string(&serde_json::json!({
            "profile": profile,
            "connection": connection,
            "apiKey": api_key,
        }))?)
    }
}

fn finalize_knowledge_hits(hits: Vec<KnowledgeSearchHit>, limit: usize) -> Vec<KnowledgeSearchHit> {
    let mut bytes = 0usize;
    let mut finalized = Vec::new();
    for mut hit in hits.into_iter().take(limit.min(8)) {
        if bytes.saturating_add(hit.content.len()) > 48 * 1_024 {
            break;
        }
        bytes += hit.content.len();
        hit.citation = format!("K{}", finalized.len() + 1);
        finalized.push(hit);
    }
    finalized
}

fn vector_to_blob(vector: &[f32]) -> Vec<u8> {
    vector
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

fn dot_product_blob(blob: &[u8], query: &[f32]) -> Option<f64> {
    if query.is_empty() || blob.len() != std::mem::size_of_val(query) {
        return None;
    }
    let mut score = 0.0_f64;
    for (bytes, query_value) in blob.chunks_exact(4).zip(query) {
        let value = f32::from_le_bytes(bytes.try_into().ok()?);
        score += f64::from(value) * f64::from(*query_value);
    }
    Some(score)
}

impl Store {
    pub(super) fn knowledge_bases(
        &mut self,
        workspace_id: Option<&str>,
    ) -> Result<Vec<KnowledgeBaseRow>> {
        if let Some(workspace_id) = workspace_id {
            validate_id("workspace_id", workspace_id)?;
        }
        let mut statement = self.connection.prepare(
            "SELECT kb.id, kb.name, kb.description, kb.scope, kb.status, kb.semantic_enabled, kb.updated_at, \
               (SELECT COUNT(*) FROM knowledge_sources source WHERE source.knowledge_base_id = kb.id), \
               (SELECT COUNT(*) FROM knowledge_documents document WHERE document.knowledge_base_id = kb.id), \
               (SELECT COUNT(*) FROM knowledge_chunks chunk WHERE chunk.knowledge_base_id = kb.id), \
               (SELECT COUNT(*) FROM knowledge_documents document WHERE document.knowledge_base_id = kb.id AND document.parse_status = 'error'), \
               COALESCE((SELECT SUM(document.size_bytes) FROM knowledge_documents document WHERE document.knowledge_base_id = kb.id), 0) \
             FROM knowledge_bases kb \
             WHERE kb.scope = 'global' OR EXISTS(SELECT 1 FROM knowledge_base_workspaces scope \
               WHERE scope.knowledge_base_id = kb.id AND scope.workspace_id = ?1) \
             ORDER BY kb.updated_at DESC, kb.name COLLATE NOCASE",
        )?;
        let mut bases = statement
            .query_map([workspace_id], |row| {
                Ok(KnowledgeBaseRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    scope: row.get(3)?,
                    workspace_ids: Vec::new(),
                    status: row.get(4)?,
                    semantic_enabled: row.get(5)?,
                    updated_at: row.get(6)?,
                    source_count: row.get(7)?,
                    document_count: row.get(8)?,
                    chunk_count: row.get(9)?,
                    error_count: row.get(10)?,
                    size_bytes: row.get(11)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut workspace_statement = self.connection.prepare(
            "SELECT workspace_id FROM knowledge_base_workspaces WHERE knowledge_base_id = ?1 ORDER BY workspace_id",
        )?;
        for base in &mut bases {
            base.workspace_ids = workspace_statement
                .query_map([&base.id], |row| row.get(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
        }
        Ok(bases)
    }

    pub(super) fn create_knowledge_base(
        &mut self,
        name: &str,
        description: &str,
        workspace_ids: &[String],
    ) -> Result<String> {
        let name = name.trim();
        let description = description.trim();
        if name.is_empty() || name.chars().count() > 80 || description.chars().count() > 1_024 {
            return Err(PersistenceError::InvalidInput(
                "knowledge base name or description is invalid".to_owned(),
            ));
        }
        if workspace_ids.len() > 64 {
            return Err(PersistenceError::InvalidInput(
                "knowledge base has too many project scopes".to_owned(),
            ));
        }
        for workspace_id in workspace_ids {
            validate_id("workspace_id", workspace_id)?;
        }
        let id = format!("kb_{}", Uuid::now_v7().simple());
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO knowledge_bases (id, name, description, scope, status, semantic_enabled) \
             VALUES (?1, ?2, ?3, ?4, 'ready', \
               COALESCE((SELECT strategy = 'semantic' FROM knowledge_retrieval_settings WHERE singleton = 1), 0))",
            params![id, name, description, if workspace_ids.is_empty() { "global" } else { "project" }],
        )?;
        for workspace_id in workspace_ids {
            transaction.execute(
                "INSERT INTO knowledge_base_workspaces (knowledge_base_id, workspace_id) VALUES (?1, ?2)",
                params![id, workspace_id],
            )?;
        }
        transaction.commit()?;
        Ok(id)
    }

    pub(super) fn update_knowledge_base(
        &mut self,
        id: &str,
        name: &str,
        description: &str,
        workspace_ids: &[String],
        ignore_rules: &[String],
        semantic_enabled: Option<bool>,
    ) -> Result<bool> {
        validate_id("knowledge_base_id", id)?;
        let name = name.trim();
        let description = description.trim();
        if name.is_empty()
            || name.chars().count() > 80
            || description.chars().count() > 1_024
            || workspace_ids.len() > 64
            || ignore_rules.len() > 256
            || ignore_rules
                .iter()
                .any(|rule| rule.is_empty() || rule.len() > 1_024 || rule.contains('\0'))
        {
            return Err(PersistenceError::InvalidInput(
                "knowledge base settings are invalid".to_owned(),
            ));
        }
        for workspace_id in workspace_ids {
            validate_id("workspace_id", workspace_id)?;
        }
        let ignore_rules_json = serde_json::to_string(ignore_rules)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let updated = transaction.execute(
            "UPDATE knowledge_bases SET name = ?2, description = ?3, scope = ?4, \
               ignore_rules_json = ?5, semantic_enabled = COALESCE(?6, semantic_enabled), \
               updated_at = unixepoch() WHERE id = ?1",
            params![
                id,
                name,
                description,
                if workspace_ids.is_empty() {
                    "global"
                } else {
                    "project"
                },
                ignore_rules_json,
                semantic_enabled,
            ],
        )? > 0;
        if updated {
            transaction.execute(
                "DELETE FROM knowledge_base_workspaces WHERE knowledge_base_id = ?1",
                [id],
            )?;
            for workspace_id in workspace_ids {
                transaction.execute(
                    "INSERT INTO knowledge_base_workspaces (knowledge_base_id, workspace_id) VALUES (?1, ?2)",
                    params![id, workspace_id],
                )?;
            }
        }
        transaction.commit()?;
        Ok(updated)
    }

    pub(super) fn knowledge_base_config(&mut self, id: &str) -> Result<KnowledgeBaseConfigRow> {
        validate_id("knowledge_base_id", id)?;
        self.connection
            .query_row(
                "SELECT ignore_rules_json, semantic_enabled FROM knowledge_bases WHERE id = ?1",
                [id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
            )
            .optional()?
            .map(
                |(rules, semantic_enabled)| -> Result<KnowledgeBaseConfigRow> {
                    Ok(KnowledgeBaseConfigRow {
                        ignore_rules: serde_json::from_str(&rules)?,
                        semantic_enabled,
                    })
                },
            )
            .transpose()?
            .ok_or_else(|| {
                PersistenceError::InvalidInput("knowledge base does not exist".to_owned())
            })
    }

    pub(super) fn knowledge_retrieval_settings(&mut self) -> Result<KnowledgeRetrievalSettingsRow> {
        self.connection
            .query_row(
                "SELECT strategy, selected_plan_id, active_model_id, active_model_version, \
                   pending_model_id, pending_model_version, index_paused \
                 FROM knowledge_retrieval_settings WHERE singleton = 1",
                [],
                |row| {
                    Ok(KnowledgeRetrievalSettingsRow {
                        strategy: row.get(0)?,
                        selected_plan_id: row.get(1)?,
                        active_model_id: row.get(2)?,
                        active_model_version: row.get(3)?,
                        pending_model_id: row.get(4)?,
                        pending_model_version: row.get(5)?,
                        index_paused: row.get(6)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    pub(super) fn set_knowledge_retrieval_settings(
        &mut self,
        strategy: &str,
        model_id: Option<&str>,
        model_version: Option<&str>,
    ) -> Result<()> {
        let valid = match strategy {
            "fullText" => model_id.is_none() && model_version.is_none(),
            "semantic" => {
                model_id.is_some_and(|value| !value.is_empty())
                    && model_version.is_some_and(|value| !value.is_empty())
            }
            _ => false,
        };
        if !valid {
            return Err(PersistenceError::InvalidInput(
                "knowledge retrieval settings are invalid".to_owned(),
            ));
        }
        self.connection.execute(
            "UPDATE knowledge_retrieval_settings SET strategy = ?1, selected_plan_id = \
               CASE WHEN ?1 = 'fullText' THEN 'fullText' ELSE ?2 END, active_model_id = ?2, \
               active_model_version = ?3, pending_model_id = NULL, pending_model_version = NULL, \
               updated_at = unixepoch() WHERE singleton = 1",
            params![strategy, model_id, model_version],
        )?;
        Ok(())
    }

    pub(super) fn request_knowledge_retrieval_model(
        &mut self,
        model_id: &str,
        model_version: &str,
    ) -> Result<()> {
        if model_id.is_empty() || model_version.is_empty() {
            return Err(PersistenceError::InvalidInput(
                "knowledge retrieval model is invalid".to_owned(),
            ));
        }
        self.connection.execute(
            "UPDATE knowledge_retrieval_settings SET selected_plan_id = ?1, \
               pending_model_id = CASE WHEN active_model_id = ?1 AND active_model_version = ?2 \
                 THEN NULL ELSE ?1 END, \
               pending_model_version = CASE WHEN active_model_id = ?1 AND active_model_version = ?2 \
                 THEN NULL ELSE ?2 END, updated_at = unixepoch() WHERE singleton = 1",
            params![model_id, model_version],
        )?;
        Ok(())
    }

    pub(super) fn activate_pending_knowledge_retrieval_model(
        &mut self,
        model_id: &str,
        model_version: &str,
    ) -> Result<bool> {
        Ok(self.connection.execute(
            "UPDATE knowledge_retrieval_settings SET strategy = 'semantic', \
               selected_plan_id = ?1, active_model_id = ?1, active_model_version = ?2, \
               pending_model_id = NULL, pending_model_version = NULL, updated_at = unixepoch() \
             WHERE singleton = 1 AND pending_model_id = ?1 AND pending_model_version = ?2",
            params![model_id, model_version],
        )? > 0)
    }

    pub(super) fn cancel_pending_knowledge_retrieval_model(
        &mut self,
        model_id: &str,
        model_version: &str,
    ) -> Result<bool> {
        Ok(self.connection.execute(
            "UPDATE knowledge_retrieval_settings SET selected_plan_id = \
               COALESCE(active_model_id, 'fullText'), pending_model_id = NULL, \
               pending_model_version = NULL, updated_at = unixepoch() \
             WHERE singleton = 1 AND pending_model_id = ?1 AND pending_model_version = ?2",
            params![model_id, model_version],
        )? > 0)
    }

    pub(super) fn set_semantic_index_paused(&mut self, paused: bool) -> Result<()> {
        self.connection.execute(
            "UPDATE knowledge_retrieval_settings SET index_paused = ?1, \
               updated_at = unixepoch() WHERE singleton = 1",
            [paused],
        )?;
        Ok(())
    }

    pub(super) fn delete_knowledge_base(&mut self, id: &str) -> Result<bool> {
        validate_id("knowledge_base_id", id)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM knowledge_chunks_fts WHERE knowledge_base_id = ?1",
            [id],
        )?;
        let deleted = transaction.execute("DELETE FROM knowledge_bases WHERE id = ?1", [id])? > 0;
        transaction.commit()?;
        Ok(deleted)
    }

    pub(super) fn managed_path_reference_count(&mut self, path: &str) -> Result<i64> {
        self.connection
            .query_row(
                "SELECT COUNT(*) FROM knowledge_sources WHERE kind = 'managedFile' AND path = ?1",
                [path],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    pub(super) fn update_managed_knowledge_source_path(
        &mut self,
        source_id: &str,
        path: &str,
    ) -> Result<bool> {
        validate_id("knowledge_source_id", source_id)?;
        if path.is_empty() || path.len() > 16 * 1_024 {
            return Err(PersistenceError::InvalidInput(
                "managed knowledge source path is invalid".to_owned(),
            ));
        }
        Ok(self.connection.execute(
            "UPDATE knowledge_sources SET path = ?2, status = 'scanning', last_error = NULL, \
               updated_at = unixepoch() WHERE id = ?1 AND kind = 'managedFile'",
            params![source_id, path],
        )? > 0)
    }

    pub(super) fn create_knowledge_source(
        &mut self,
        knowledge_base_id: &str,
        kind: &str,
        path: &str,
        display_name: &str,
    ) -> Result<String> {
        validate_id("knowledge_base_id", knowledge_base_id)?;
        if !matches!(kind, "managedFile" | "linkedFolder")
            || path.is_empty()
            || path.len() > 16 * 1_024
            || display_name.is_empty()
            || display_name.len() > 1_024
        {
            return Err(PersistenceError::InvalidInput(
                "knowledge source is invalid".to_owned(),
            ));
        }
        let exists: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM knowledge_bases WHERE id = ?1)",
            [knowledge_base_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(PersistenceError::InvalidInput(
                "knowledge base does not exist".to_owned(),
            ));
        }
        let id = format!("ks_{}", Uuid::now_v7().simple());
        self.connection.execute(
            "INSERT INTO knowledge_sources (id, knowledge_base_id, kind, path, display_name) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, knowledge_base_id, kind, path, display_name],
        )?;
        self.set_knowledge_status(knowledge_base_id, "indexing")?;
        Ok(id)
    }

    pub(super) fn knowledge_sources(
        &mut self,
        knowledge_base_id: &str,
    ) -> Result<Vec<KnowledgeSourceRow>> {
        validate_id("knowledge_base_id", knowledge_base_id)?;
        let mut statement = self.connection.prepare(
            "SELECT source.id, source.knowledge_base_id, source.kind, source.path, source.display_name, source.updated_at, \
               source.status, source.last_error, source.last_scanned_at, \
               COUNT(document.id), COALESCE(SUM(CASE WHEN document.parse_status = 'error' THEN 1 ELSE 0 END), 0) \
             FROM knowledge_sources source LEFT JOIN knowledge_documents document ON document.source_id = source.id \
             WHERE source.knowledge_base_id = ?1 GROUP BY source.id ORDER BY source.created_at, source.id",
        )?;
        statement
            .query_map([knowledge_base_id], |row| {
                Ok(KnowledgeSourceRow {
                    id: row.get(0)?,
                    knowledge_base_id: row.get(1)?,
                    kind: row.get(2)?,
                    path: row.get(3)?,
                    display_name: row.get(4)?,
                    updated_at: row.get(5)?,
                    status: row.get(6)?,
                    last_error: row.get(7)?,
                    last_scanned_at: row.get(8)?,
                    document_count: row.get(9)?,
                    error_count: row.get(10)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub(super) fn knowledge_source(&mut self, source_id: &str) -> Result<KnowledgeSourceRow> {
        validate_id("knowledge_source_id", source_id)?;
        let knowledge_base_id: Option<String> = self
            .connection
            .query_row(
                "SELECT knowledge_base_id FROM knowledge_sources WHERE id = ?1",
                [source_id],
                |row| row.get(0),
            )
            .optional()?;
        let knowledge_base_id = knowledge_base_id.ok_or_else(|| {
            PersistenceError::InvalidInput("knowledge source does not exist".to_owned())
        })?;
        self.knowledge_sources(&knowledge_base_id)?
            .into_iter()
            .find(|source| source.id == source_id)
            .ok_or_else(|| {
                PersistenceError::InvalidInput("knowledge source does not exist".to_owned())
            })
    }

    pub(super) fn linked_knowledge_sources(&mut self) -> Result<Vec<KnowledgeSourceRow>> {
        let mut statement = self.connection.prepare(
            "SELECT id, knowledge_base_id FROM knowledge_sources \
             WHERE kind = 'linkedFolder' ORDER BY created_at, id",
        )?;
        let coordinates = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(statement);
        let mut sources = Vec::with_capacity(coordinates.len());
        for (source_id, knowledge_base_id) in coordinates {
            if let Some(source) = self
                .knowledge_sources(&knowledge_base_id)?
                .into_iter()
                .find(|source| source.id == source_id)
            {
                sources.push(source);
            }
        }
        Ok(sources)
    }

    pub(super) fn set_knowledge_source_status(
        &mut self,
        source_id: &str,
        status: &str,
        last_error: Option<&str>,
        scanned: bool,
    ) -> Result<()> {
        validate_id("knowledge_source_id", source_id)?;
        if !matches!(status, "ready" | "scanning" | "disconnected" | "error") {
            return Err(PersistenceError::InvalidInput(
                "knowledge source status is invalid".to_owned(),
            ));
        }
        self.connection.execute(
            "UPDATE knowledge_sources SET status = ?2, last_error = ?3, \
               last_scanned_at = CASE WHEN ?4 THEN unixepoch() ELSE last_scanned_at END, \
               updated_at = unixepoch() WHERE id = ?1",
            params![source_id, status, last_error, scanned],
        )?;
        Ok(())
    }

    pub(super) fn delete_knowledge_source(&mut self, source_id: &str) -> Result<Option<String>> {
        validate_id("knowledge_source_id", source_id)?;
        let source = self.knowledge_source(source_id)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM knowledge_chunks_fts WHERE chunk_id IN (\
               SELECT id FROM knowledge_chunks WHERE document_id IN (\
                 SELECT id FROM knowledge_documents WHERE source_id = ?1))",
            [source_id],
        )?;
        transaction.execute("DELETE FROM knowledge_sources WHERE id = ?1", [source_id])?;
        transaction.execute(
            "UPDATE knowledge_bases SET updated_at = unixepoch() WHERE id = ?1",
            [&source.knowledge_base_id],
        )?;
        transaction.commit()?;
        Ok((source.kind == "managedFile").then_some(source.path))
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn replace_knowledge_document(
        &mut self,
        knowledge_base_id: &str,
        source_id: &str,
        relative_path: &str,
        file_name: &str,
        media_type: &str,
        size_bytes: i64,
        modified_at: i64,
        sha256: &str,
        parse_error: Option<&str>,
        chunks: &[KnowledgeChunkInput],
    ) -> Result<()> {
        if relative_path.is_empty()
            || relative_path.len() > 16 * 1_024
            || file_name.is_empty()
            || file_name.len() > 1_024
            || size_bytes < 0
            || sha256.len() != 64
        {
            return Err(PersistenceError::InvalidInput(
                "knowledge document metadata is invalid".to_owned(),
            ));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing_id: Option<String> = transaction
            .query_row(
                "SELECT id FROM knowledge_documents WHERE source_id = ?1 AND relative_path = ?2",
                params![source_id, relative_path],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(existing_id) = existing_id {
            transaction.execute(
                "DELETE FROM knowledge_chunks_fts WHERE chunk_id IN (SELECT id FROM knowledge_chunks WHERE document_id = ?1)",
                [&existing_id],
            )?;
            transaction.execute(
                "DELETE FROM knowledge_documents WHERE id = ?1",
                [&existing_id],
            )?;
        }
        let document_id = format!("kd_{}", Uuid::now_v7().simple());
        let parse_status = if parse_error.is_some() {
            "error"
        } else {
            "ready"
        };
        transaction.execute(
            "INSERT INTO knowledge_documents (id, knowledge_base_id, source_id, relative_path, file_name, media_type, size_bytes, modified_at, sha256, parse_status, parse_error, chunk_count) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![document_id, knowledge_base_id, source_id, relative_path, file_name, media_type, size_bytes, modified_at, sha256, parse_status, parse_error, i64::try_from(chunks.len()).unwrap_or(i64::MAX)],
        )?;
        for chunk in chunks {
            let chunk_id = format!("kc_{}", Uuid::now_v7().simple());
            transaction.execute(
                "INSERT INTO knowledge_chunks (id, knowledge_base_id, document_id, ordinal, heading, page_number, content_kind, language, start_line, end_line, estimated_tokens, content, content_hash) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    chunk_id,
                    knowledge_base_id,
                    document_id,
                    chunk.ordinal,
                    chunk.heading,
                    chunk.page_number,
                    chunk.content_kind,
                    chunk.language,
                    chunk.start_line,
                    chunk.end_line,
                    chunk.estimated_tokens,
                    chunk.content,
                    chunk.content_hash
                ],
            )?;
            transaction.execute(
                "INSERT INTO knowledge_chunks_fts (chunk_id, knowledge_base_id, relative_path, heading, search_text) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![chunk_id, knowledge_base_id, relative_path, chunk.heading, chunk.search_text],
            )?;
        }
        transaction.execute(
            "UPDATE knowledge_sources SET updated_at = unixepoch() WHERE id = ?1",
            [source_id],
        )?;
        transaction.execute(
            "UPDATE knowledge_bases SET updated_at = unixepoch() WHERE id = ?1",
            [knowledge_base_id],
        )?;
        transaction.execute(
            "UPDATE knowledge_semantic_indexes SET status = 'notIndexed', error = NULL, \
               updated_at = unixepoch() WHERE knowledge_base_id = ?1",
            [knowledge_base_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub(super) fn knowledge_documents(
        &mut self,
        knowledge_base_id: &str,
    ) -> Result<Vec<KnowledgeDocumentRow>> {
        validate_id("knowledge_base_id", knowledge_base_id)?;
        let mut statement = self.connection.prepare(
            "SELECT id, knowledge_base_id, source_id, relative_path, file_name, media_type, size_bytes, modified_at, sha256, parse_status, parse_error, chunk_count, updated_at \
             FROM knowledge_documents WHERE knowledge_base_id = ?1 ORDER BY relative_path COLLATE NOCASE",
        )?;
        statement
            .query_map([knowledge_base_id], |row| {
                Ok(KnowledgeDocumentRow {
                    id: row.get(0)?,
                    knowledge_base_id: row.get(1)?,
                    source_id: row.get(2)?,
                    relative_path: row.get(3)?,
                    file_name: row.get(4)?,
                    media_type: row.get(5)?,
                    size_bytes: row.get(6)?,
                    modified_at: row.get(7)?,
                    sha256: row.get(8)?,
                    parse_status: row.get(9)?,
                    parse_error: row.get(10)?,
                    chunk_count: row.get(11)?,
                    updated_at: row.get(12)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub(super) fn knowledge_documents_for_source(
        &mut self,
        source_id: &str,
    ) -> Result<Vec<KnowledgeDocumentRow>> {
        validate_id("knowledge_source_id", source_id)?;
        let mut statement = self.connection.prepare(
            "SELECT id, knowledge_base_id, source_id, relative_path, file_name, media_type, size_bytes, modified_at, sha256, parse_status, parse_error, chunk_count, updated_at \
             FROM knowledge_documents WHERE source_id = ?1 ORDER BY relative_path COLLATE NOCASE",
        )?;
        statement
            .query_map([source_id], |row| {
                Ok(KnowledgeDocumentRow {
                    id: row.get(0)?,
                    knowledge_base_id: row.get(1)?,
                    source_id: row.get(2)?,
                    relative_path: row.get(3)?,
                    file_name: row.get(4)?,
                    media_type: row.get(5)?,
                    size_bytes: row.get(6)?,
                    modified_at: row.get(7)?,
                    sha256: row.get(8)?,
                    parse_status: row.get(9)?,
                    parse_error: row.get(10)?,
                    chunk_count: row.get(11)?,
                    updated_at: row.get(12)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub(super) fn update_knowledge_document_stat(
        &mut self,
        document_id: &str,
        size_bytes: i64,
        modified_at: i64,
    ) -> Result<()> {
        validate_id("knowledge_document_id", document_id)?;
        if size_bytes < 0 || modified_at < 0 {
            return Err(PersistenceError::InvalidInput(
                "knowledge document stat is invalid".to_owned(),
            ));
        }
        self.connection.execute(
            "UPDATE knowledge_documents SET size_bytes = ?2, modified_at = ?3, \
               updated_at = unixepoch() WHERE id = ?1",
            params![document_id, size_bytes, modified_at],
        )?;
        Ok(())
    }

    pub(super) fn delete_knowledge_document(&mut self, document_id: &str) -> Result<bool> {
        validate_id("knowledge_document_id", document_id)?;
        let knowledge_base_id: Option<String> = self
            .connection
            .query_row(
                "SELECT knowledge_base_id FROM knowledge_documents WHERE id = ?1",
                [document_id],
                |row| row.get(0),
            )
            .optional()?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM knowledge_chunks_fts WHERE chunk_id IN (\
               SELECT id FROM knowledge_chunks WHERE document_id = ?1)",
            [document_id],
        )?;
        let deleted = transaction.execute(
            "DELETE FROM knowledge_documents WHERE id = ?1",
            [document_id],
        )? > 0;
        if let Some(knowledge_base_id) = knowledge_base_id {
            transaction.execute(
                "UPDATE knowledge_semantic_indexes SET status = 'notIndexed', error = NULL, \
                   updated_at = unixepoch() WHERE knowledge_base_id = ?1",
                [knowledge_base_id],
            )?;
        }
        transaction.commit()?;
        Ok(deleted)
    }

    pub(super) fn create_knowledge_index_job(
        &mut self,
        knowledge_base_id: &str,
        source_id: Option<&str>,
        kind: &str,
    ) -> Result<String> {
        validate_id("knowledge_base_id", knowledge_base_id)?;
        if let Some(source_id) = source_id {
            validate_id("knowledge_source_id", source_id)?;
        }
        if !matches!(kind, "initial" | "incremental" | "rescan" | "rebuild") {
            return Err(PersistenceError::InvalidInput(
                "knowledge index job kind is invalid".to_owned(),
            ));
        }
        let id = format!("kj_{}", Uuid::now_v7().simple());
        self.connection.execute(
            "INSERT INTO knowledge_index_jobs (id, knowledge_base_id, source_id, kind, status) \
             VALUES (?1, ?2, ?3, ?4, 'queued')",
            params![id, knowledge_base_id, source_id, kind],
        )?;
        Ok(id)
    }

    pub(super) fn start_knowledge_index_job(&mut self, id: &str) -> Result<bool> {
        validate_id("knowledge_index_job_id", id)?;
        Ok(self.connection.execute(
            "UPDATE knowledge_index_jobs SET status = 'running', attempt_count = attempt_count + 1, \
               cancel_requested = 0, started_at = unixepoch(), completed_at = NULL, \
               last_error = NULL, updated_at = unixepoch() \
             WHERE id = ?1 AND status IN ('queued','paused','failed')",
            [id],
        )? > 0)
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn update_knowledge_index_job_progress(
        &mut self,
        id: &str,
        discovered_files: usize,
        processed_files: usize,
        indexed_files: usize,
        skipped_files: usize,
        deleted_files: usize,
        error_count: usize,
    ) -> Result<bool> {
        validate_id("knowledge_index_job_id", id)?;
        self.connection.execute(
            "UPDATE knowledge_index_jobs SET discovered_files = ?2, processed_files = ?3, \
               indexed_files = ?4, skipped_files = ?5, deleted_files = ?6, error_count = ?7, \
               updated_at = unixepoch() WHERE id = ?1",
            params![
                id,
                i64::try_from(discovered_files).unwrap_or(i64::MAX),
                i64::try_from(processed_files).unwrap_or(i64::MAX),
                i64::try_from(indexed_files).unwrap_or(i64::MAX),
                i64::try_from(skipped_files).unwrap_or(i64::MAX),
                i64::try_from(deleted_files).unwrap_or(i64::MAX),
                i64::try_from(error_count).unwrap_or(i64::MAX),
            ],
        )?;
        self.connection
            .query_row(
                "SELECT cancel_requested FROM knowledge_index_jobs WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map(Option::unwrap_or_default)
            .map_err(Into::into)
    }

    pub(super) fn finish_knowledge_index_job(
        &mut self,
        id: &str,
        status: &str,
        last_error: Option<&str>,
    ) -> Result<()> {
        validate_id("knowledge_index_job_id", id)?;
        if !matches!(status, "paused" | "completed" | "failed" | "cancelled") {
            return Err(PersistenceError::InvalidInput(
                "knowledge index job final status is invalid".to_owned(),
            ));
        }
        self.connection.execute(
            "UPDATE knowledge_index_jobs SET status = ?2, last_error = ?3, \
               completed_at = CASE WHEN ?2 IN ('completed','cancelled') THEN unixepoch() ELSE NULL END, \
               updated_at = unixepoch() WHERE id = ?1",
            params![id, status, last_error],
        )?;
        Ok(())
    }

    pub(super) fn request_knowledge_index_job_cancel(&mut self, id: &str) -> Result<bool> {
        validate_id("knowledge_index_job_id", id)?;
        Ok(self.connection.execute(
            "UPDATE knowledge_index_jobs SET cancel_requested = 1, updated_at = unixepoch() \
             WHERE id = ?1 AND status IN ('queued','running','paused','failed')",
            [id],
        )? > 0)
    }

    pub(super) fn knowledge_index_jobs(
        &mut self,
        knowledge_base_id: &str,
    ) -> Result<Vec<KnowledgeIndexJobRow>> {
        validate_id("knowledge_base_id", knowledge_base_id)?;
        let mut statement = self.connection.prepare(
            "SELECT id, knowledge_base_id, source_id, kind, status, discovered_files, \
               processed_files, indexed_files, skipped_files, deleted_files, error_count, \
               attempt_count, cancel_requested, last_error, created_at, updated_at \
             FROM knowledge_index_jobs WHERE knowledge_base_id = ?1 \
             ORDER BY created_at DESC, id DESC LIMIT 50",
        )?;
        statement
            .query_map([knowledge_base_id], |row| {
                Ok(KnowledgeIndexJobRow {
                    id: row.get(0)?,
                    knowledge_base_id: row.get(1)?,
                    source_id: row.get(2)?,
                    kind: row.get(3)?,
                    status: row.get(4)?,
                    discovered_files: row.get(5)?,
                    processed_files: row.get(6)?,
                    indexed_files: row.get(7)?,
                    skipped_files: row.get(8)?,
                    deleted_files: row.get(9)?,
                    error_count: row.get(10)?,
                    attempt_count: row.get(11)?,
                    cancel_requested: row.get(12)?,
                    last_error: row.get(13)?,
                    created_at: row.get(14)?,
                    updated_at: row.get(15)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub(super) fn search_knowledge(
        &mut self,
        knowledge_base_ids: &[String],
        workspace_id: Option<&str>,
        query: &str,
        limit: usize,
    ) -> Result<Vec<KnowledgeSearchHit>> {
        let hits = self.search_knowledge_candidates(
            knowledge_base_ids,
            workspace_id,
            query,
            limit.min(8),
        )?;
        Ok(finalize_knowledge_hits(hits, limit.min(8)))
    }

    pub(super) fn search_knowledge_hybrid(
        &mut self,
        request: KnowledgeHybridSearchRequest<'_>,
    ) -> Result<Vec<KnowledgeSearchHit>> {
        if request.query_vector.is_empty()
            || request.model_id.is_empty()
            || request.model_version.is_empty()
        {
            return Err(PersistenceError::InvalidInput(
                "knowledge semantic search request is invalid".to_owned(),
            ));
        }
        let lexical = self.search_knowledge_candidates(
            request.knowledge_base_ids,
            request.workspace_id,
            request.query,
            30,
        )?;
        let semantic = self.search_knowledge_vector_candidates(
            request.semantic_knowledge_base_ids,
            request.workspace_id,
            request.query_vector,
            request.model_id,
            request.model_version,
            30,
        )?;
        let mut fused = std::collections::HashMap::<String, (KnowledgeSearchHit, f64)>::new();
        for (rank, hit) in lexical.into_iter().enumerate() {
            let score = 1.0 / (60.0 + rank as f64 + 1.0);
            let entry = fused
                .entry(hit.chunk_id.clone())
                .or_insert_with(|| (hit, 0.0));
            entry.1 += score;
        }
        for (rank, hit) in semantic.into_iter().enumerate() {
            let score = 1.0 / (60.0 + rank as f64 + 1.0);
            let entry = fused
                .entry(hit.chunk_id.clone())
                .or_insert_with(|| (hit, 0.0));
            entry.1 += score;
        }
        let mut hits = fused
            .into_values()
            .map(|(mut hit, score)| {
                hit.score = score;
                hit
            })
            .collect::<Vec<_>>();
        hits.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.chunk_id.cmp(&right.chunk_id))
        });
        Ok(finalize_knowledge_hits(hits, request.limit.min(8)))
    }

    fn search_knowledge_candidates(
        &mut self,
        knowledge_base_ids: &[String],
        workspace_id: Option<&str>,
        query: &str,
        limit: usize,
    ) -> Result<Vec<KnowledgeSearchHit>> {
        if knowledge_base_ids.is_empty() || knowledge_base_ids.len() > 4 || query.is_empty() {
            return Err(PersistenceError::InvalidInput(
                "knowledge search request is invalid".to_owned(),
            ));
        }
        let ids_json = serde_json::to_string(knowledge_base_ids)?;
        let mut statement = self.connection.prepare(
            "SELECT chunk.id, chunk.knowledge_base_id, kb.name, chunk.document_id, document.file_name, document.relative_path, \
               chunk.heading, chunk.page_number, chunk.content_kind, chunk.language, chunk.start_line, chunk.end_line, \
               chunk.content, bm25(knowledge_chunks_fts) \
             FROM knowledge_chunks_fts \
             JOIN knowledge_chunks chunk ON chunk.id = knowledge_chunks_fts.chunk_id \
             JOIN knowledge_documents document ON document.id = chunk.document_id \
             JOIN knowledge_bases kb ON kb.id = chunk.knowledge_base_id \
             WHERE knowledge_chunks_fts MATCH ?2 AND chunk.knowledge_base_id IN (SELECT value FROM json_each(?1)) \
               AND (kb.scope = 'global' OR EXISTS(SELECT 1 FROM knowledge_base_workspaces scope \
                 WHERE scope.knowledge_base_id = kb.id AND scope.workspace_id = ?3)) \
             ORDER BY bm25(knowledge_chunks_fts), chunk.ordinal LIMIT ?4",
        )?;
        let mut hits = Vec::new();
        for row in statement.query_map(
            params![
                ids_json,
                query,
                workspace_id.unwrap_or_default(),
                i64::try_from(limit.min(30)).unwrap_or(30)
            ],
            |row| {
                Ok(KnowledgeSearchHit {
                    chunk_id: row.get(0)?,
                    citation: String::new(),
                    knowledge_base_id: row.get(1)?,
                    knowledge_base_name: row.get(2)?,
                    document_id: row.get(3)?,
                    file_name: row.get(4)?,
                    relative_path: row.get(5)?,
                    heading: row.get(6)?,
                    page_number: row.get(7)?,
                    content_kind: row.get(8)?,
                    language: row.get(9)?,
                    start_line: row.get(10)?,
                    end_line: row.get(11)?,
                    content: row.get(12)?,
                    score: row.get(13)?,
                })
            },
        )? {
            hits.push(row?);
        }
        Ok(hits)
    }

    fn search_knowledge_vector_candidates(
        &mut self,
        knowledge_base_ids: &[String],
        workspace_id: Option<&str>,
        query_vector: &[f32],
        model_id: &str,
        model_version: &str,
        limit: usize,
    ) -> Result<Vec<KnowledgeSearchHit>> {
        let ids_json = serde_json::to_string(knowledge_base_ids)?;
        let mut statement = self.connection.prepare(
            "SELECT embedding.chunk_id, embedding.vector \
             FROM knowledge_chunk_embeddings embedding \
             JOIN knowledge_bases kb ON kb.id = embedding.knowledge_base_id \
             WHERE embedding.model_id = ?2 AND embedding.model_version = ?3 \
               AND embedding.knowledge_base_id IN (SELECT value FROM json_each(?1)) \
               AND (kb.scope = 'global' OR EXISTS(SELECT 1 FROM knowledge_base_workspaces scope \
                 WHERE scope.knowledge_base_id = kb.id AND scope.workspace_id = ?4))",
        )?;
        let candidate_limit = limit.min(30);
        let rows = statement.query_map(
            params![
                ids_json,
                model_id,
                model_version,
                workspace_id.unwrap_or_default()
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)),
        )?;
        let mut scores = Vec::<(String, f64)>::with_capacity(candidate_limit);
        for row in rows {
            let (chunk_id, blob) = row?;
            let Some(score) = dot_product_blob(&blob, query_vector) else {
                continue;
            };
            if scores.len() < candidate_limit {
                scores.push((chunk_id, score));
                continue;
            }
            let Some((minimum_index, minimum)) = scores
                .iter()
                .enumerate()
                .min_by(|(_, left), (_, right)| left.1.total_cmp(&right.1))
            else {
                continue;
            };
            if score > minimum.1 {
                scores[minimum_index] = (chunk_id, score);
            }
        }
        drop(statement);
        scores.sort_by(|left, right| {
            right
                .1
                .partial_cmp(&left.1)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut hits = Vec::new();
        for (chunk_id, score) in scores {
            if let Some(mut hit) = self.knowledge_hit_by_chunk_id(&chunk_id)? {
                hit.score = score;
                hits.push(hit);
            }
        }
        Ok(hits)
    }

    fn knowledge_hit_by_chunk_id(&mut self, chunk_id: &str) -> Result<Option<KnowledgeSearchHit>> {
        self.connection
            .query_row(
                "SELECT chunk.id, chunk.knowledge_base_id, kb.name, chunk.document_id, document.file_name, \
                   document.relative_path, chunk.heading, chunk.page_number, chunk.content_kind, chunk.language, \
                   chunk.start_line, chunk.end_line, chunk.content \
                 FROM knowledge_chunks chunk \
                 JOIN knowledge_documents document ON document.id = chunk.document_id \
                 JOIN knowledge_bases kb ON kb.id = chunk.knowledge_base_id WHERE chunk.id = ?1",
                [chunk_id],
                |row| {
                    Ok(KnowledgeSearchHit {
                        chunk_id: row.get(0)?,
                        citation: String::new(),
                        knowledge_base_id: row.get(1)?,
                        knowledge_base_name: row.get(2)?,
                        document_id: row.get(3)?,
                        file_name: row.get(4)?,
                        relative_path: row.get(5)?,
                        heading: row.get(6)?,
                        page_number: row.get(7)?,
                        content_kind: row.get(8)?,
                        language: row.get(9)?,
                        start_line: row.get(10)?,
                        end_line: row.get(11)?,
                        content: row.get(12)?,
                        score: 0.0,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub(super) fn semantic_enabled_knowledge_base_ids(&mut self) -> Result<Vec<String>> {
        let mut statement = self.connection.prepare(
            "SELECT id FROM knowledge_bases WHERE semantic_enabled = 1 ORDER BY created_at",
        )?;
        statement
            .query_map([], |row| row.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub(super) fn semantic_ready_knowledge_base_ids(
        &mut self,
        knowledge_base_ids: &[String],
        model_id: &str,
        model_version: &str,
    ) -> Result<Vec<String>> {
        if knowledge_base_ids.is_empty() {
            return Ok(Vec::new());
        }
        let ids_json = serde_json::to_string(knowledge_base_ids)?;
        let mut statement = self.connection.prepare(
            "SELECT kb.id FROM knowledge_bases kb \
             JOIN knowledge_semantic_indexes semantic \
               ON semantic.knowledge_base_id = kb.id \
             WHERE kb.id IN (SELECT value FROM json_each(?1)) AND kb.semantic_enabled = 1 \
               AND semantic.model_id = ?2 AND semantic.model_version = ?3 \
               AND semantic.status = 'ready' ORDER BY kb.created_at",
        )?;
        statement
            .query_map(params![ids_json, model_id, model_version], |row| row.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub(super) fn knowledge_chunks_needing_embeddings(
        &mut self,
        knowledge_base_id: &str,
        model_id: &str,
        model_version: &str,
        limit: usize,
    ) -> Result<Vec<KnowledgeEmbeddingChunk>> {
        validate_id("knowledge_base_id", knowledge_base_id)?;
        let mut statement = self.connection.prepare(
            "SELECT chunk.id, chunk.content, chunk.content_hash FROM knowledge_chunks chunk \
             LEFT JOIN knowledge_chunk_embeddings embedding ON embedding.chunk_id = chunk.id \
               AND embedding.model_id = ?2 AND embedding.model_version = ?3 \
             WHERE chunk.knowledge_base_id = ?1 AND (embedding.chunk_id IS NULL \
               OR embedding.content_hash != chunk.content_hash) \
             ORDER BY chunk.document_id, chunk.ordinal LIMIT ?4",
        )?;
        statement
            .query_map(
                params![
                    knowledge_base_id,
                    model_id,
                    model_version,
                    i64::try_from(limit.min(16)).unwrap_or(16)
                ],
                |row| {
                    Ok(KnowledgeEmbeddingChunk {
                        id: row.get(0)?,
                        content: row.get(1)?,
                        content_hash: row.get(2)?,
                    })
                },
            )?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub(super) fn save_knowledge_embeddings(
        &mut self,
        knowledge_base_id: &str,
        model_id: &str,
        model_version: &str,
        dimensions: usize,
        embeddings: &[KnowledgeEmbeddingInput],
    ) -> Result<()> {
        validate_id("knowledge_base_id", knowledge_base_id)?;
        if model_id.is_empty()
            || model_version.is_empty()
            || dimensions == 0
            || dimensions > 4_096
            || embeddings.is_empty()
            || embeddings.len() > 16
            || embeddings
                .iter()
                .any(|embedding| embedding.vector.len() != dimensions)
        {
            return Err(PersistenceError::InvalidInput(
                "knowledge embedding batch is invalid".to_owned(),
            ));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for embedding in embeddings {
            transaction.execute(
                "INSERT INTO knowledge_chunk_embeddings \
                   (chunk_id, knowledge_base_id, content_hash, model_id, model_version, dimensions, vector, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, unixepoch()) \
                 ON CONFLICT(chunk_id, model_id, model_version) DO UPDATE SET \
                   knowledge_base_id = excluded.knowledge_base_id, content_hash = excluded.content_hash, \
                   dimensions = excluded.dimensions, vector = excluded.vector, updated_at = unixepoch()",
                params![
                    embedding.chunk_id,
                    knowledge_base_id,
                    embedding.content_hash,
                    model_id,
                    model_version,
                    i64::try_from(dimensions).unwrap_or(4_096),
                    vector_to_blob(&embedding.vector)
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub(super) fn set_knowledge_semantic_index_status(
        &mut self,
        knowledge_base_id: &str,
        model_id: &str,
        model_version: &str,
        status: &str,
        error: Option<&str>,
    ) -> Result<()> {
        if model_id.is_empty()
            || model_version.is_empty()
            || !matches!(
                status,
                "notIndexed" | "indexing" | "paused" | "ready" | "error"
            )
        {
            return Err(PersistenceError::InvalidInput(
                "knowledge semantic index status is invalid".to_owned(),
            ));
        }
        self.connection.execute(
            "INSERT INTO knowledge_semantic_indexes \
               (knowledge_base_id, model_id, model_version, status, error, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, unixepoch()) \
             ON CONFLICT(knowledge_base_id, model_id, model_version) DO UPDATE SET \
               status = excluded.status, error = excluded.error, updated_at = unixepoch()",
            params![knowledge_base_id, model_id, model_version, status, error],
        )?;
        self.connection.execute(
            "UPDATE knowledge_bases SET semantic_model_version = ?2 WHERE id = ?1",
            params![knowledge_base_id, model_version],
        )?;
        Ok(())
    }

    pub(super) fn semantic_indexes_ready(
        &mut self,
        knowledge_base_ids: &[String],
        model_id: &str,
        model_version: &str,
    ) -> Result<bool> {
        let ids_json = serde_json::to_string(knowledge_base_ids)?;
        let ready: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM knowledge_semantic_indexes \
             WHERE knowledge_base_id IN (SELECT value FROM json_each(?1)) \
               AND model_id = ?2 AND model_version = ?3 AND status = 'ready'",
            params![ids_json, model_id, model_version],
            |row| row.get(0),
        )?;
        Ok(usize::try_from(ready).unwrap_or(0) == knowledge_base_ids.len())
    }

    pub(super) fn semantic_index_summary(
        &mut self,
        model_id: &str,
        model_version: &str,
    ) -> Result<KnowledgeSemanticIndexSummary> {
        let (total_chunks, indexed_chunks): (i64, i64) = self.connection.query_row(
            "SELECT (SELECT COUNT(*) FROM knowledge_chunks chunk JOIN knowledge_bases kb \
                 ON kb.id = chunk.knowledge_base_id WHERE kb.semantic_enabled = 1), \
               (SELECT COUNT(*) FROM knowledge_chunk_embeddings embedding JOIN knowledge_bases kb \
                 ON kb.id = embedding.knowledge_base_id WHERE kb.semantic_enabled = 1 \
                   AND embedding.model_id = ?1 AND embedding.model_version = ?2)",
            params![model_id, model_version],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let (indexing, paused, errors): (i64, i64, i64) = self.connection.query_row(
            "SELECT COALESCE(SUM(status = 'indexing'), 0), COALESCE(SUM(status = 'paused'), 0), \
               COALESCE(SUM(status = 'error'), 0) \
             FROM knowledge_semantic_indexes WHERE model_id = ?1 AND model_version = ?2",
            params![model_id, model_version],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        Ok(KnowledgeSemanticIndexSummary {
            state: if indexing > 0 {
                "indexing"
            } else if paused > 0 {
                "paused"
            } else if errors > 0 {
                "error"
            } else if total_chunks > 0 && indexed_chunks >= total_chunks {
                "ready"
            } else {
                "notIndexed"
            }
            .to_owned(),
            indexed_chunks,
            total_chunks,
            error_count: errors,
        })
    }

    pub(super) fn clear_knowledge_semantic_indexes(
        &mut self,
        model_id: &str,
        model_version: &str,
    ) -> Result<()> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM knowledge_chunk_embeddings WHERE model_id = ?1 AND model_version = ?2",
            params![model_id, model_version],
        )?;
        transaction.execute(
            "DELETE FROM knowledge_semantic_indexes WHERE model_id = ?1 AND model_version = ?2",
            params![model_id, model_version],
        )?;
        transaction.execute(
            "UPDATE knowledge_bases SET semantic_model_version = NULL WHERE semantic_model_version = ?1",
            [model_version],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub(super) fn read_knowledge_document(
        &mut self,
        knowledge_base_ids: &[String],
        workspace_id: Option<&str>,
        document_id: &str,
        start_ordinal: i64,
    ) -> Result<Vec<KnowledgeReadChunk>> {
        if knowledge_base_ids.is_empty() || knowledge_base_ids.len() > 4 || start_ordinal < 0 {
            return Err(PersistenceError::InvalidInput(
                "knowledge read request is invalid".to_owned(),
            ));
        }
        let ids_json = serde_json::to_string(knowledge_base_ids)?;
        let mut statement = self.connection.prepare(
            "SELECT chunk.ordinal, chunk.heading, chunk.page_number, chunk.content_kind, chunk.language, \
               chunk.start_line, chunk.end_line, chunk.content \
             FROM knowledge_chunks chunk JOIN knowledge_bases kb ON kb.id = chunk.knowledge_base_id \
             WHERE chunk.document_id = ?2 AND chunk.knowledge_base_id IN (SELECT value FROM json_each(?1)) \
               AND chunk.ordinal >= ?4 AND (kb.scope = 'global' OR EXISTS(SELECT 1 FROM knowledge_base_workspaces scope \
                 WHERE scope.knowledge_base_id = kb.id AND scope.workspace_id = ?3)) \
             ORDER BY chunk.ordinal LIMIT 12",
        )?;
        let mut bytes = 0usize;
        let mut chunks = Vec::new();
        for row in statement.query_map(
            params![
                ids_json,
                document_id,
                workspace_id.unwrap_or_default(),
                start_ordinal
            ],
            |row| {
                Ok(KnowledgeReadChunk {
                    ordinal: row.get(0)?,
                    heading: row.get(1)?,
                    page_number: row.get(2)?,
                    content_kind: row.get(3)?,
                    language: row.get(4)?,
                    start_line: row.get(5)?,
                    end_line: row.get(6)?,
                    content: row.get(7)?,
                })
            },
        )? {
            let chunk = row?;
            if bytes.saturating_add(chunk.content.len()) > 48 * 1_024 {
                break;
            }
            bytes += chunk.content.len();
            chunks.push(chunk);
        }
        Ok(chunks)
    }

    pub(super) fn set_knowledge_status(&mut self, id: &str, status: &str) -> Result<()> {
        if !matches!(status, "ready" | "indexing" | "error") {
            return Err(PersistenceError::InvalidInput(
                "knowledge base status is invalid".to_owned(),
            ));
        }
        self.connection.execute(
            "UPDATE knowledge_bases SET status = ?2, updated_at = unixepoch() WHERE id = ?1",
            params![id, status],
        )?;
        Ok(())
    }
}

#[cfg(unix)]
fn restrict_database_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict_database_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

fn validate_revision(value: &str) -> Result<()> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(PersistenceError::InvalidInput(
            "model configuration revision is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn current_model_config(connection: &Connection) -> Result<Option<Value>> {
    let config_json: Option<String> = connection
        .query_row(
            "SELECT config_json FROM model_config WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    config_json
        .map(|value| serde_json::from_str(&value).map_err(PersistenceError::from))
        .transpose()
}

fn model_connection_ids(config: &Value) -> Result<Vec<String>> {
    let connections = config
        .get("connections")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            PersistenceError::InvalidInput("model connections are invalid".to_owned())
        })?;
    let mut ids = connections
        .iter()
        .map(|connection| {
            connection
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| {
                    PersistenceError::InvalidInput(
                        "model connection identifier is invalid".to_owned(),
                    )
                })
        })
        .collect::<Result<Vec<_>>>()?;
    ids.sort();
    ids.dedup();
    Ok(ids)
}

fn model_config_inspection(connection: &Connection) -> Result<ModelConfigInspection> {
    let config = current_model_config(connection)?;
    let connection_ids = config
        .as_ref()
        .map(model_connection_ids)
        .transpose()?
        .unwrap_or_default();
    let mut credential_statuses = Vec::with_capacity(connection_ids.len());
    for connection_id in connection_ids {
        let present: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM model_credentials WHERE connection_id = ?1)",
            [&connection_id],
            |row| row.get(0),
        )?;
        credential_statuses.push(ModelCredentialStatus {
            connection_id,
            status: if present { "present" } else { "notConfigured" },
        });
    }
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&config)?);
    hasher.update(b"\n");
    hasher.update(serde_json::to_vec(&credential_statuses)?);
    Ok(ModelConfigInspection {
        contract_version: 1,
        revision: format!("{:x}", hasher.finalize()),
        config,
        credential_statuses,
    })
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "transport", rename_all = "camelCase")]
enum McpServerInput {
    Stdio {
        id: String,
        executable: String,
        argv: Vec<String>,
        cwd: String,
    },
    LoopbackStreamableHttp {
        id: String,
        endpoint: String,
    },
}

fn validated_mcp_servers(inputs: Vec<McpServerInput>) -> Result<Vec<McpServerInput>> {
    if inputs.len() > sugarcode_state::MAX_MCP_SERVERS {
        return Err(PersistenceError::InvalidInput(
            "too many MCP servers".to_owned(),
        ));
    }
    let mut validated = inputs
        .into_iter()
        .map(|input| {
            let validation = match &input {
                McpServerInput::Stdio {
                    id,
                    executable,
                    argv,
                    cwd,
                } => validate_mcp_stdio_server(
                    id,
                    &PathBuf::from(executable),
                    argv,
                    &PathBuf::from(cwd),
                ),
                McpServerInput::LoopbackStreamableHttp { id, endpoint } => {
                    validate_mcp_loopback_streamable_http_server(id, endpoint)
                }
            };
            validation.map(|()| input).map_err(|kind| {
                PersistenceError::InvalidInput(format!("invalid MCP server: {kind}"))
            })
        })
        .collect::<Result<Vec<_>>>()?;
    validated.sort_by(|left, right| {
        mcp_server_id(left)
            .as_bytes()
            .cmp(mcp_server_id(right).as_bytes())
    });
    if validated
        .windows(2)
        .any(|pair| mcp_server_id(&pair[0]) == mcp_server_id(&pair[1]))
    {
        return Err(PersistenceError::InvalidInput(
            "duplicate MCP server identifier".to_owned(),
        ));
    }
    Ok(validated)
}

fn mcp_server_id(server: &McpServerInput) -> &str {
    match server {
        McpServerInput::Stdio { id, .. } | McpServerInput::LoopbackStreamableHttp { id, .. } => id,
    }
}

fn current_mcp_servers(connection: &Connection) -> Result<Vec<McpServerInput>> {
    let config_json: Option<String> = connection
        .query_row(
            "SELECT config_json FROM mcp_config WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    config_json
        .map(|value| serde_json::from_str(&value).map_err(PersistenceError::from))
        .transpose()
        .map(Option::unwrap_or_default)
}

fn mcp_config_inspection(connection: &Connection) -> Result<McpConfigInspection> {
    let servers = current_mcp_servers(connection)?;
    let mut hasher = Sha256::new();
    hasher.update(b"mcp-config-v1\0");
    for server in &servers {
        hasher.update(mcp_server_id(server).as_bytes());
        hasher.update(b"\0");
        match server {
            McpServerInput::Stdio {
                executable,
                argv,
                cwd,
                ..
            } => {
                hasher.update(b"stdio\0");
                hasher.update(executable.as_bytes());
                hasher.update(b"\0");
                for argument in argv {
                    hasher.update(argument.as_bytes());
                    hasher.update(b"\0");
                }
                hasher.update(b"\0");
                hasher.update(cwd.as_bytes());
            }
            McpServerInput::LoopbackStreamableHttp { endpoint, .. } => {
                hasher.update(b"loopbackStreamableHttp\0");
                hasher.update(endpoint.as_bytes());
            }
        }
        hasher.update(b"\0");
    }
    Ok(McpConfigInspection {
        contract_version: 1,
        revision: format!("{:x}", hasher.finalize()),
        servers,
    })
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum CredentialUpdate {
    Preserve {
        connection_id: String,
    },
    Set {
        connection_id: String,
        value: String,
    },
    Delete {
        connection_id: String,
    },
}

impl CredentialUpdate {
    fn connection_id(&self) -> &str {
        match self {
            Self::Preserve { connection_id }
            | Self::Set { connection_id, .. }
            | Self::Delete { connection_id } => connection_id,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelConfigInspection {
    contract_version: u8,
    revision: String,
    config: Option<Value>,
    credential_statuses: Vec<ModelCredentialStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelCredentialStatus {
    connection_id: String,
    status: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelConfigAction {
    accepted: bool,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    inspection: Option<ModelConfigInspection>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McpConfigInspection {
    contract_version: u8,
    revision: String,
    servers: Vec<McpServerInput>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McpConfigAction {
    accepted: bool,
    reason: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    inspection: Option<McpConfigInspection>,
}

fn validate_id(name: &str, value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 512 {
        return Err(PersistenceError::InvalidInput(format!(
            "{name} must contain 1 to 512 bytes"
        )));
    }
    Ok(())
}

fn validate_project_environment_trust(canonical_root: &str, config_hash: &str) -> Result<()> {
    if canonical_root.is_empty()
        || canonical_root.len() > 16 * 1024
        || config_hash.len() != 64
        || !config_hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(PersistenceError::InvalidInput(
            "project environment trust coordinates are invalid".to_owned(),
        ));
    }
    Ok(())
}

fn validate_json(value: &str) -> Result<()> {
    let _: Value = serde_json::from_str(value)?;
    Ok(())
}

fn migrate(connection: &mut Connection) -> Result<()> {
    let mut version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > SCHEMA_VERSION {
        return Err(PersistenceError::InvalidInput(format!(
            "database schema {version} is newer than supported schema {SCHEMA_VERSION}"
        )));
    }
    if version == SCHEMA_VERSION {
        return Ok(());
    }
    if version == 0 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
        "CREATE TABLE workspaces (\
           id TEXT PRIMARY KEY, canonical_root TEXT NOT NULL,\
           created_at INTEGER NOT NULL DEFAULT (unixepoch()),\
           updated_at INTEGER NOT NULL DEFAULT (unixepoch())\
         ) STRICT;\
         CREATE TABLE threads (\
           id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),\
           title TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()),\
           updated_at INTEGER NOT NULL DEFAULT (unixepoch())\
         ) STRICT;\
         CREATE INDEX threads_workspace_updated ON threads(workspace_id, updated_at DESC);\
         CREATE TABLE turns (\
           id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id),\
           request_id TEXT NOT NULL UNIQUE,\
           status TEXT NOT NULL CHECK(status IN ('running','completed','interrupted','failed')),\
           provider_wire_api TEXT NOT NULL, model TEXT NOT NULL, error_json TEXT,\
           started_at INTEGER NOT NULL DEFAULT (unixepoch()), completed_at INTEGER\
         ) STRICT;\
         CREATE INDEX turns_thread_started ON turns(thread_id, started_at, id);\
         CREATE TABLE turn_items (\
           id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES turns(id),\
           sequence INTEGER NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL,\
           created_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE(turn_id, sequence)\
         ) STRICT;\
         CREATE TABLE operations (\
           id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES turns(id), tool_name TEXT NOT NULL,\
           request_hash TEXT NOT NULL, arguments_json TEXT NOT NULL,\
           status TEXT NOT NULL CHECK(status IN\
             ('proposed','approved','denied','executing','completed','failed')),\
           result_json TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()),\
           updated_at INTEGER NOT NULL DEFAULT (unixepoch())\
         ) STRICT;\
         CREATE TABLE approvals (\
           id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),\
           turn_id TEXT NOT NULL REFERENCES turns(id),\
           status TEXT NOT NULL CHECK(status IN ('pending','approved','denied')),\
           created_at INTEGER NOT NULL DEFAULT (unixepoch()),\
           updated_at INTEGER NOT NULL DEFAULT (unixepoch())\
         ) STRICT;\
         CREATE TABLE agent_tasks (\
           id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES turns(id),\
           parent_task_id TEXT REFERENCES agent_tasks(id), title TEXT NOT NULL,\
           status TEXT NOT NULL CHECK(status IN\
             ('pending','running','waiting','completed','failed','interrupted')),\
           payload_json TEXT NOT NULL DEFAULT '{}',\
           created_at INTEGER NOT NULL DEFAULT (unixepoch()),\
           updated_at INTEGER NOT NULL DEFAULT (unixepoch())\
         ) STRICT;\
         PRAGMA user_version = 1;",
        )?;
        transaction.commit()?;
        version = 1;
    }
    if version == 1 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TABLE model_config (\
               singleton INTEGER PRIMARY KEY CHECK(singleton = 1),\
               config_json TEXT NOT NULL,\
               updated_at INTEGER NOT NULL DEFAULT (unixepoch())\
             ) STRICT;\
             CREATE TABLE model_credentials (\
               connection_id TEXT PRIMARY KEY, api_key TEXT NOT NULL,\
               updated_at INTEGER NOT NULL DEFAULT (unixepoch())\
             ) STRICT;\
             PRAGMA user_version = 2;",
        )?;
        transaction.commit()?;
        version = 2;
    }
    if version == 2 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "ALTER TABLE threads ADD COLUMN archived_at INTEGER;
             ALTER TABLE threads ADD COLUMN parent_thread_id TEXT REFERENCES threads(id);
             CREATE INDEX threads_workspace_archive_updated
               ON threads(workspace_id, archived_at, updated_at DESC);
             PRAGMA user_version = 3;",
        )?;
        transaction.commit()?;
        version = 3;
    }
    if version == 3 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TABLE content_assets (\
               asset_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE,\
               media_type TEXT NOT NULL, original_name TEXT NOT NULL,\
               size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),\
               kind TEXT NOT NULL CHECK(kind IN ('image','video','pdf','text')),\
               pdf_pages INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch())\
             ) STRICT;\
             PRAGMA user_version = 4;",
        )?;
        transaction.commit()?;
        version = 4;
    }
    if version == 4 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TABLE mcp_config (\
               singleton INTEGER PRIMARY KEY CHECK(singleton = 1),\
               config_json TEXT NOT NULL,\
               updated_at INTEGER NOT NULL DEFAULT (unixepoch())\
             ) STRICT;\
             PRAGMA user_version = 5;",
        )?;
        transaction.commit()?;
        version = 5;
    }
    if version == 5 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "PRAGMA defer_foreign_keys = ON;
             ALTER TABLE agent_tasks RENAME TO agent_tasks_v5;
             CREATE TABLE agent_tasks (\
               id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES turns(id),\
               parent_task_id TEXT REFERENCES agent_tasks(id), title TEXT NOT NULL,\
               status TEXT NOT NULL CHECK(status IN\
                 ('queued','running','waitingApproval','completed','failed','interrupted','cancelled')),\
               payload_json TEXT NOT NULL DEFAULT '{}',\
               created_at INTEGER NOT NULL DEFAULT (unixepoch()),\
               updated_at INTEGER NOT NULL DEFAULT (unixepoch())\
             ) STRICT;
             INSERT INTO agent_tasks
               (id, turn_id, parent_task_id, title, status, payload_json, created_at, updated_at)
             SELECT id, turn_id, parent_task_id, title,
               CASE status WHEN 'pending' THEN 'queued' WHEN 'waiting' THEN 'waitingApproval'
                 ELSE status END,
               payload_json, created_at, updated_at FROM agent_tasks_v5;
             DROP TABLE agent_tasks_v5;
             PRAGMA user_version = 6;",
        )?;
        transaction.commit()?;
        version = 6;
    }
    if version == 6 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "ALTER TABLE approvals ADD COLUMN payload_json TEXT;
             PRAGMA user_version = 7;",
        )?;
        transaction.commit()?;
        version = 7;
    }
    if version == 7 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TABLE skill_preferences (\
               skill_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),\
               updated_at INTEGER NOT NULL DEFAULT (unixepoch())\
             ) STRICT;\
             PRAGMA user_version = 8;",
        )?;
        transaction.commit()?;
        version = 8;
    }
    if version == 8 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TABLE project_environment_trust (\
               canonical_root TEXT PRIMARY KEY, config_hash TEXT NOT NULL,\
               trusted_at INTEGER NOT NULL DEFAULT (unixepoch())\
             ) STRICT;\
             PRAGMA user_version = 9;",
        )?;
        transaction.commit()?;
        version = 9;
    }
    if version == 9 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TABLE task_workspaces (\
               thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,\
               mode TEXT NOT NULL CHECK(mode IN ('worktree')),\
               task_root TEXT NOT NULL, branch TEXT NOT NULL,\
               updated_at INTEGER NOT NULL DEFAULT (unixepoch())\
             ) STRICT;\
             PRAGMA user_version = 10;",
        )?;
        transaction.commit()?;
        version = 10;
    }
    if version == 10 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TABLE thread_queues (\
               thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,\
               paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0, 1)),\
               updated_at INTEGER NOT NULL DEFAULT (unixepoch())\
             ) STRICT;\
             CREATE TABLE queued_messages (\
               id TEXT PRIMARY KEY,\
               thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,\
               position INTEGER NOT NULL CHECK(position > 0),\
               revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),\
               content_json TEXT NOT NULL, model_profile_id TEXT,\
               created_at INTEGER NOT NULL DEFAULT (unixepoch()),\
               updated_at INTEGER NOT NULL DEFAULT (unixepoch()),\
               UNIQUE(thread_id, position)\
             ) STRICT;\
             CREATE INDEX queued_messages_thread_position \
               ON queued_messages(thread_id, position);\
             PRAGMA user_version = 11;",
        )?;
        transaction.commit()?;
        version = 11;
    }
    if version == 11 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TABLE knowledge_bases (\
               id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, description TEXT NOT NULL DEFAULT '',\
               scope TEXT NOT NULL CHECK(scope IN ('global','project')),\
               status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','indexing','error')),\
               ignore_rules_json TEXT NOT NULL DEFAULT '[]', semantic_model_version TEXT,\
               created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())\
             ) STRICT;\
             CREATE TABLE knowledge_base_workspaces (\
               knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,\
               workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,\
               PRIMARY KEY(knowledge_base_id, workspace_id)\
             ) STRICT;\
             CREATE TABLE knowledge_sources (\
               id TEXT PRIMARY KEY, knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,\
               kind TEXT NOT NULL CHECK(kind IN ('managedFile','linkedFolder')), path TEXT NOT NULL, display_name TEXT NOT NULL,\
               created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()),\
               UNIQUE(knowledge_base_id, path)\
             ) STRICT;\
             CREATE TABLE knowledge_documents (\
               id TEXT PRIMARY KEY, knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,\
               source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE, relative_path TEXT NOT NULL,\
               file_name TEXT NOT NULL, media_type TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),\
               modified_at INTEGER NOT NULL, sha256 TEXT NOT NULL,\
               parse_status TEXT NOT NULL CHECK(parse_status IN ('ready','error')), parse_error TEXT,\
               chunk_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT (unixepoch()),\
               UNIQUE(source_id, relative_path)\
             ) STRICT;\
             CREATE INDEX knowledge_documents_base_path ON knowledge_documents(knowledge_base_id, relative_path);\
             CREATE TABLE knowledge_chunks (\
               id TEXT PRIMARY KEY, knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,\
               document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL,\
               heading TEXT, page_number INTEGER, content TEXT NOT NULL, content_hash TEXT NOT NULL,\
               UNIQUE(document_id, ordinal)\
             ) STRICT;\
             CREATE INDEX knowledge_chunks_document_ordinal ON knowledge_chunks(document_id, ordinal);\
             CREATE VIRTUAL TABLE knowledge_chunks_fts USING fts5(\
               chunk_id UNINDEXED, knowledge_base_id UNINDEXED, relative_path, heading, search_text,\
               tokenize = 'unicode61 remove_diacritics 2'\
             );\
             PRAGMA user_version = 12;",
        )?;
        transaction.commit()?;
        version = 12;
    }
    if version == 12 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TABLE skill_market_sources (\
               skill_id TEXT PRIMARY KEY, catalog_source TEXT NOT NULL, version TEXT NOT NULL,\
               installed_sha256 TEXT NOT NULL, directory_sha256 TEXT NOT NULL,\
               checked_at INTEGER, updated_at INTEGER NOT NULL DEFAULT (unixepoch())\
             ) STRICT;\
             CREATE TABLE skill_update_history (\
               id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, from_version TEXT, to_version TEXT NOT NULL,\
               state TEXT NOT NULL CHECK(state IN ('installed','updated','failed')),\
               details_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL DEFAULT (unixepoch())\
             ) STRICT;\
             PRAGMA user_version = 13;",
        )?;
        transaction.commit()?;
        version = 13;
    }
    if version == 13 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TABLE knowledge_chunk_embeddings (\
               chunk_id TEXT PRIMARY KEY REFERENCES knowledge_chunks(id) ON DELETE CASCADE,\
               knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,\
               content_hash TEXT NOT NULL, model_version TEXT NOT NULL,\
               dimensions INTEGER NOT NULL CHECK(dimensions = 384), vector BLOB NOT NULL,\
               updated_at INTEGER NOT NULL DEFAULT (unixepoch())\
             ) STRICT;\
             CREATE INDEX knowledge_chunk_embeddings_base_model \
               ON knowledge_chunk_embeddings(knowledge_base_id, model_version);\
             CREATE TABLE knowledge_semantic_indexes (\
               knowledge_base_id TEXT PRIMARY KEY REFERENCES knowledge_bases(id) ON DELETE CASCADE,\
               model_version TEXT NOT NULL,\
               status TEXT NOT NULL CHECK(status IN ('notIndexed','indexing','ready','error')),\
               error TEXT, updated_at INTEGER NOT NULL DEFAULT (unixepoch())\
             ) STRICT;\
             PRAGMA user_version = 14;",
        )?;
        transaction.commit()?;
        version = 14;
    }
    if version == 14 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "ALTER TABLE knowledge_sources ADD COLUMN status TEXT NOT NULL DEFAULT 'ready' \
               CHECK(status IN ('ready','scanning','disconnected','error')); \
             ALTER TABLE knowledge_sources ADD COLUMN last_error TEXT; \
             ALTER TABLE knowledge_sources ADD COLUMN last_scanned_at INTEGER; \
             ALTER TABLE knowledge_chunks ADD COLUMN content_kind TEXT NOT NULL DEFAULT 'text' \
               CHECK(content_kind IN ('text','code')); \
             ALTER TABLE knowledge_chunks ADD COLUMN language TEXT; \
             ALTER TABLE knowledge_chunks ADD COLUMN start_line INTEGER; \
             ALTER TABLE knowledge_chunks ADD COLUMN end_line INTEGER; \
             ALTER TABLE knowledge_chunks ADD COLUMN estimated_tokens INTEGER NOT NULL DEFAULT 0 \
               CHECK(estimated_tokens >= 0); \
             CREATE TABLE knowledge_index_jobs (\
               id TEXT PRIMARY KEY,\
               knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,\
               source_id TEXT REFERENCES knowledge_sources(id) ON DELETE CASCADE,\
               kind TEXT NOT NULL CHECK(kind IN ('initial','incremental','rescan','rebuild')),\
               status TEXT NOT NULL CHECK(status IN ('queued','running','paused','completed','failed','cancelled')),\
               discovered_files INTEGER NOT NULL DEFAULT 0 CHECK(discovered_files >= 0),\
               processed_files INTEGER NOT NULL DEFAULT 0 CHECK(processed_files >= 0),\
               indexed_files INTEGER NOT NULL DEFAULT 0 CHECK(indexed_files >= 0),\
               skipped_files INTEGER NOT NULL DEFAULT 0 CHECK(skipped_files >= 0),\
               deleted_files INTEGER NOT NULL DEFAULT 0 CHECK(deleted_files >= 0),\
               error_count INTEGER NOT NULL DEFAULT 0 CHECK(error_count >= 0),\
               attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),\
               cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),\
               last_error TEXT,\
               created_at INTEGER NOT NULL DEFAULT (unixepoch()),\
               started_at INTEGER, completed_at INTEGER,\
               updated_at INTEGER NOT NULL DEFAULT (unixepoch())\
             ) STRICT;\
             CREATE INDEX knowledge_index_jobs_pending \
               ON knowledge_index_jobs(status, updated_at);\
             CREATE INDEX knowledge_index_jobs_source \
               ON knowledge_index_jobs(source_id, created_at DESC);\
             PRAGMA user_version = 15;",
        )?;
        transaction.commit()?;
        version = 15;
    }
    if version == 15 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "PRAGMA defer_foreign_keys = ON; \
             ALTER TABLE knowledge_bases ADD COLUMN semantic_enabled INTEGER NOT NULL DEFAULT 1 \
               CHECK(semantic_enabled IN (0, 1)); \
             CREATE TABLE knowledge_retrieval_settings (\
               singleton INTEGER PRIMARY KEY CHECK(singleton = 1),\
               strategy TEXT NOT NULL CHECK(strategy IN ('fullText','semantic')),\
               selected_plan_id TEXT NOT NULL, active_model_id TEXT, active_model_version TEXT,\
               pending_model_id TEXT, pending_model_version TEXT,\
               index_paused INTEGER NOT NULL DEFAULT 0 CHECK(index_paused IN (0, 1)),\
               updated_at INTEGER NOT NULL DEFAULT (unixepoch()),\
               CHECK((strategy = 'fullText' AND active_model_id IS NULL AND active_model_version IS NULL) OR\
                 (strategy = 'semantic' AND active_model_id IS NOT NULL AND active_model_version IS NOT NULL)),\
               CHECK((pending_model_id IS NULL AND pending_model_version IS NULL) OR\
                 (pending_model_id IS NOT NULL AND pending_model_version IS NOT NULL))\
             ) STRICT; \
             INSERT INTO knowledge_retrieval_settings \
               (singleton, strategy, selected_plan_id, active_model_id, active_model_version) \
             SELECT 1, \
               CASE WHEN EXISTS(SELECT 1 FROM knowledge_chunk_embeddings) \
                 OR EXISTS(SELECT 1 FROM knowledge_semantic_indexes) \
                 OR EXISTS(SELECT 1 FROM knowledge_bases WHERE semantic_model_version IS NOT NULL) \
                 THEN 'semantic' ELSE 'fullText' END, \
               CASE WHEN EXISTS(SELECT 1 FROM knowledge_chunk_embeddings) \
                 OR EXISTS(SELECT 1 FROM knowledge_semantic_indexes) \
                 OR EXISTS(SELECT 1 FROM knowledge_bases WHERE semantic_model_version IS NOT NULL) \
                 THEN 'intfloat/multilingual-e5-small' ELSE 'fullText' END, \
               CASE WHEN EXISTS(SELECT 1 FROM knowledge_chunk_embeddings) \
                 OR EXISTS(SELECT 1 FROM knowledge_semantic_indexes) \
                 OR EXISTS(SELECT 1 FROM knowledge_bases WHERE semantic_model_version IS NOT NULL) \
                 THEN 'intfloat/multilingual-e5-small' ELSE NULL END, \
               CASE WHEN EXISTS(SELECT 1 FROM knowledge_chunk_embeddings) \
                 OR EXISTS(SELECT 1 FROM knowledge_semantic_indexes) \
                 OR EXISTS(SELECT 1 FROM knowledge_bases WHERE semantic_model_version IS NOT NULL) \
                 THEN '2026-04-02' ELSE NULL END; \
             ALTER TABLE knowledge_chunk_embeddings RENAME TO knowledge_chunk_embeddings_v15; \
             CREATE TABLE knowledge_chunk_embeddings (\
               chunk_id TEXT NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE,\
               knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,\
               content_hash TEXT NOT NULL, model_id TEXT NOT NULL, model_version TEXT NOT NULL,\
               dimensions INTEGER NOT NULL CHECK(dimensions > 0 AND dimensions <= 4096),\
               vector BLOB NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()),\
               PRIMARY KEY(chunk_id, model_id, model_version)\
             ) STRICT; \
             INSERT INTO knowledge_chunk_embeddings \
               (chunk_id, knowledge_base_id, content_hash, model_id, model_version, dimensions, vector, updated_at) \
             SELECT chunk_id, knowledge_base_id, content_hash, 'intfloat/multilingual-e5-small', \
               model_version, dimensions, vector, updated_at FROM knowledge_chunk_embeddings_v15; \
             DROP TABLE knowledge_chunk_embeddings_v15; \
             CREATE INDEX knowledge_chunk_embeddings_base_model \
               ON knowledge_chunk_embeddings(knowledge_base_id, model_id, model_version); \
             ALTER TABLE knowledge_semantic_indexes RENAME TO knowledge_semantic_indexes_v15; \
             CREATE TABLE knowledge_semantic_indexes (\
               knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,\
               model_id TEXT NOT NULL, model_version TEXT NOT NULL,\
               status TEXT NOT NULL CHECK(status IN ('notIndexed','indexing','paused','ready','error')),\
               error TEXT, updated_at INTEGER NOT NULL DEFAULT (unixepoch()),\
               PRIMARY KEY(knowledge_base_id, model_id, model_version)\
             ) STRICT; \
             INSERT INTO knowledge_semantic_indexes \
               (knowledge_base_id, model_id, model_version, status, error, updated_at) \
             SELECT knowledge_base_id, 'intfloat/multilingual-e5-small', model_version, status, error, updated_at \
               FROM knowledge_semantic_indexes_v15; \
             DROP TABLE knowledge_semantic_indexes_v15; \
             CREATE INDEX knowledge_semantic_indexes_model_status \
               ON knowledge_semantic_indexes(model_id, model_version, status); \
             PRAGMA user_version = 16;",
        )?;
        transaction.commit()?;
        version = 16;
    }
    if version == 16 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "ALTER TABLE content_assets RENAME TO content_assets_v16; \
             CREATE TABLE content_assets (\
               asset_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE,\
               media_type TEXT NOT NULL, original_name TEXT NOT NULL,\
               size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),\
               kind TEXT NOT NULL CHECK(kind IN ('image','video','pdf','text')),\
               pdf_pages INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch())\
             ) STRICT; \
             INSERT INTO content_assets \
               (asset_id, sha256, media_type, original_name, size_bytes, kind, pdf_pages, created_at) \
             SELECT asset_id, sha256, media_type, original_name, size_bytes, kind, pdf_pages, created_at \
               FROM content_assets_v16; \
             DROP TABLE content_assets_v16; \
             PRAGMA user_version = 17;",
        )?;
        transaction.commit()?;
    }
    Ok(())
}

fn recover_interrupted_work(connection: &mut Connection) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute(
        "UPDATE thread_queues SET paused = 1, updated_at = unixepoch()\
         WHERE EXISTS(SELECT 1 FROM queued_messages WHERE queued_messages.thread_id = thread_queues.thread_id)\
         AND EXISTS(SELECT 1 FROM turns WHERE turns.thread_id = thread_queues.thread_id AND turns.status = 'running')",
        [],
    )?;
    transaction.execute(
        "UPDATE turns SET status = 'interrupted', completed_at = unixepoch(),\
         error_json = '{\"kind\":\"runtimeRestart\",\"retryable\":true}'\
         WHERE status = 'running'",
        [],
    )?;
    transaction.execute(
        "UPDATE agent_tasks SET status = 'interrupted', updated_at = unixepoch()\
         WHERE status IN ('queued', 'running', 'waitingApproval')",
        [],
    )?;
    transaction.execute(
        "UPDATE operations SET status = 'failed', updated_at = unixepoch(),\
         result_json = '{\"kind\":\"runtimeRestart\",\"retryable\":true}'\
         WHERE status IN ('approved', 'executing')",
        [],
    )?;
    transaction.execute(
        "UPDATE knowledge_semantic_indexes SET status = 'notIndexed', error = NULL, \
           updated_at = unixepoch() WHERE status = 'indexing'",
        [],
    )?;
    transaction.execute(
        "UPDATE knowledge_semantic_indexes SET status = 'notIndexed', error = NULL, \
           updated_at = unixepoch() WHERE status = 'paused' AND NOT EXISTS(\
             SELECT 1 FROM knowledge_retrieval_settings WHERE singleton = 1 AND index_paused = 1)",
        [],
    )?;
    transaction.execute(
        "UPDATE knowledge_index_jobs SET status = 'paused', cancel_requested = 0, \
           last_error = 'runtimeRestart', updated_at = unixepoch() WHERE status = 'running'",
        [],
    )?;
    transaction.execute(
        "UPDATE knowledge_sources SET status = 'ready', last_error = NULL, updated_at = unixepoch() \
           WHERE status = 'scanning'",
        [],
    )?;
    transaction.execute(
        "UPDATE knowledge_bases SET status = CASE \
           WHEN EXISTS(SELECT 1 FROM knowledge_documents document \
             WHERE document.knowledge_base_id = knowledge_bases.id AND document.parse_status = 'error') \
           THEN 'error' ELSE 'ready' END, updated_at = unixepoch() WHERE status = 'indexing'",
        [],
    )?;
    transaction.commit()?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadSnapshot {
    thread: ThreadRow,
    turns: Vec<TurnRow>,
    items: Vec<ItemRow>,
    agent_tasks: Vec<AgentTaskRow>,
    queue: ThreadQueueRow,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentTaskRow {
    id: String,
    turn_id: String,
    parent_task_id: Option<String>,
    title: String,
    status: String,
    payload: Value,
    created_at: i64,
    updated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadRow {
    id: String,
    workspace_id: String,
    title: Option<String>,
    created_at: i64,
    updated_at: i64,
    archived_at: Option<i64>,
    parent_thread_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnRow {
    id: String,
    request_id: String,
    status: String,
    provider_wire_api: String,
    model: String,
    error_json: Option<String>,
    started_at: i64,
    completed_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ItemRow {
    id: String,
    turn_id: String,
    sequence: i64,
    kind: String,
    payload: Value,
}

fn thread_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ThreadRow> {
    Ok(ThreadRow {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        title: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        archived_at: row.get(5)?,
        parent_thread_id: row.get(6)?,
    })
}

fn validate_model_profile_id(value: Option<&str>) -> Result<()> {
    if value.is_some_and(|profile| {
        profile.is_empty()
            || profile.len() > 64
            || !profile
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    }) {
        return Err(PersistenceError::InvalidInput(
            "model profile identifier is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn validate_queued_content(value: &str) -> Result<Value> {
    let content: Value = serde_json::from_str(value)?;
    let Some(parts) = content.as_array() else {
        return Err(PersistenceError::InvalidInput(
            "queued message content is invalid".to_owned(),
        ));
    };
    if parts.is_empty() || parts.len() > 11 || value.len() > 28 * 1024 * 1024 {
        return Err(PersistenceError::InvalidInput(
            "queued message content is invalid".to_owned(),
        ));
    }
    let mut assets = 0usize;
    for part in parts {
        let Some(object) = part.as_object() else {
            return Err(PersistenceError::InvalidInput(
                "queued message content is invalid".to_owned(),
            ));
        };
        match object.get("type").and_then(Value::as_str) {
            Some("text") => {
                if object.len() != 2
                    || object
                        .get("text")
                        .and_then(Value::as_str)
                        .is_none_or(|text| text.len() > 256 * 1024)
                {
                    return Err(PersistenceError::InvalidInput(
                        "queued message text is invalid".to_owned(),
                    ));
                }
            }
            Some("asset") => {
                assets += 1;
                let Some(asset) = object.get("asset").and_then(Value::as_object) else {
                    return Err(PersistenceError::InvalidInput(
                        "queued message asset is invalid".to_owned(),
                    ));
                };
                let sha = asset
                    .get("sha256")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let kind = asset
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let required_strings_valid =
                    ["assetId", "mediaType", "originalName"].iter().all(|key| {
                        asset
                            .get(*key)
                            .and_then(Value::as_str)
                            .is_some_and(|item| !item.is_empty())
                    });
                if object.len() != 2
                    || asset.contains_key("data")
                    || !required_strings_valid
                    || sha.len() != 64
                    || !sha.bytes().all(|byte| byte.is_ascii_hexdigit())
                    || !matches!(kind, "image" | "video" | "pdf" | "text")
                    || asset.get("sizeBytes").and_then(Value::as_u64).is_none()
                    || asset
                        .get("pdfPages")
                        .is_some_and(|pages| pages.as_u64().is_none())
                {
                    return Err(PersistenceError::InvalidInput(
                        "queued message asset is invalid".to_owned(),
                    ));
                }
            }
            _ => {
                return Err(PersistenceError::InvalidInput(
                    "queued message content is invalid".to_owned(),
                ));
            }
        }
    }
    if assets > 10 {
        return Err(PersistenceError::InvalidInput(
            "queued message has too many assets".to_owned(),
        ));
    }
    Ok(content)
}

fn validate_turn_identity(
    turn_id: &str,
    thread_id: &str,
    request_id: &str,
    provider_wire_api: &str,
    model: &str,
) -> Result<()> {
    for (name, value) in [
        ("turn_id", turn_id),
        ("thread_id", thread_id),
        ("request_id", request_id),
    ] {
        validate_id(name, value)?;
    }
    if !matches!(
        provider_wire_api,
        "openaiResponses" | "openaiChatCompletions" | "anthropicMessages"
    ) || model.is_empty()
    {
        return Err(PersistenceError::InvalidInput(
            "queued Turn model is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn queued_message_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<QueuedMessageSqlRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
    ))
}

fn load_queued_message(
    connection: &Connection,
    thread_id: &str,
    message_id: &str,
) -> Result<Option<QueuedMessageRow>> {
    connection
        .query_row(
            "SELECT id, thread_id, position, revision, content_json, model_profile_id, created_at, updated_at \
             FROM queued_messages WHERE thread_id = ?1 AND id = ?2",
            params![thread_id, message_id],
            queued_message_from_row,
        )
        .optional()?
        .map(|(id, thread_id, position, revision, content, model_profile_id, created_at, updated_at)| {
            Ok(QueuedMessageRow {
                id,
                thread_id,
                position,
                revision,
                content: serde_json::from_str(&content)?,
                model_profile_id,
                created_at,
                updated_at,
            })
        })
        .transpose()
}

fn load_thread_queue(connection: &Connection, thread_id: &str) -> Result<ThreadQueueRow> {
    let paused = connection
        .query_row(
            "SELECT paused FROM thread_queues WHERE thread_id = ?1",
            [thread_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(false);
    let mut statement = connection.prepare(
        "SELECT id, thread_id, position, revision, content_json, model_profile_id, created_at, updated_at \
         FROM queued_messages WHERE thread_id = ?1 ORDER BY position, id",
    )?;
    let messages = statement
        .query_map([thread_id], queued_message_from_row)?
        .map(|row| {
            let (
                id,
                thread_id,
                position,
                revision,
                content,
                model_profile_id,
                created_at,
                updated_at,
            ) = row?;
            Ok(QueuedMessageRow {
                id,
                thread_id,
                position,
                revision,
                content: serde_json::from_str(&content)?,
                model_profile_id,
                created_at,
                updated_at,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(ThreadQueueRow { paused, messages })
}

fn cleanup_empty_queue(connection: &Connection, thread_id: &str) -> Result<()> {
    connection.execute(
        "DELETE FROM thread_queues WHERE thread_id = ?1 \
         AND NOT EXISTS(SELECT 1 FROM queued_messages WHERE thread_id = ?1)",
        [thread_id],
    )?;
    Ok(())
}

fn validate_title(value: Option<&str>) -> Result<()> {
    if value.is_some_and(|title| title.len() > 512 || title.chars().any(char::is_control)) {
        return Err(PersistenceError::InvalidInput(
            "thread title is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn validate_agent_task_create(task: &AgentTaskCreate) -> Result<()> {
    validate_id("task_id", &task.id)?;
    if let Some(parent_task_id) = &task.parent_task_id {
        validate_id("parent_task_id", parent_task_id)?;
    }
    if task.title.is_empty() || task.title.len() > 256 || task.status != "queued" {
        return Err(PersistenceError::InvalidInput(
            "new Agent tasks must have a bounded title and queued status".to_owned(),
        ));
    }
    validate_agent_task_payload(&task.id, &task.status, &task.payload)
}

fn validate_agent_task_status(status: &str) -> Result<()> {
    if matches!(
        status,
        "queued"
            | "running"
            | "waitingApproval"
            | "completed"
            | "failed"
            | "interrupted"
            | "cancelled"
    ) {
        Ok(())
    } else {
        Err(PersistenceError::InvalidInput(
            "invalid Agent task status".to_owned(),
        ))
    }
}

fn validate_agent_task_payload(task_id: &str, status: &str, payload: &Value) -> Result<()> {
    validate_agent_task_status(status)?;
    let object = payload.as_object().ok_or_else(|| {
        PersistenceError::InvalidInput("Agent task payload must be an object".to_owned())
    })?;
    if object.get("taskId").and_then(Value::as_str) != Some(task_id)
        || object.get("status").and_then(Value::as_str) != Some(status)
    {
        return Err(PersistenceError::InvalidInput(
            "Agent task payload identity or status does not match its row".to_owned(),
        ));
    }
    Ok(())
}

fn agent_task_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "interrupted" | "cancelled")
}

fn agent_task_transition_allowed(from: &str, to: &str) -> bool {
    match from {
        "queued" => matches!(to, "running" | "failed" | "interrupted" | "cancelled"),
        "running" => matches!(
            to,
            "waitingApproval" | "completed" | "failed" | "interrupted" | "cancelled"
        ),
        "waitingApproval" => matches!(to, "running" | "failed" | "interrupted" | "cancelled"),
        _ => false,
    }
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}
