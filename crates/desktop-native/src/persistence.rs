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
const SCHEMA_VERSION: i64 = 8;

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

    pub(super) fn record_asset(&mut self, asset: &AssetRow) -> Result<()> {
        validate_id("asset_id", &asset.asset_id)?;
        if asset.asset_id != format!("ast_{}", asset.sha256)
            || asset.media_type.is_empty()
            || asset.original_name.is_empty()
            || asset.size_bytes == 0
            || !matches!(asset.kind.as_str(), "image" | "pdf" | "text")
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
               kind TEXT NOT NULL CHECK(kind IN ('image','pdf','text')),\
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
    }
    Ok(())
}

fn recover_interrupted_work(connection: &mut Connection) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
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
