use std::error::Error;
use std::fmt;
use std::fs;
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use serde_json::Value;

const DATABASE_FILE: &str = "sugarcode-v3.sqlite3";
const SCHEMA_VERSION: i64 = 1;

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

impl Store {
    pub(super) fn open(data_directory: impl AsRef<Path>) -> Result<Self> {
        let data_directory = data_directory.as_ref();
        fs::create_dir_all(data_directory)?;
        let database_path = data_directory.join(DATABASE_FILE);
        let mut connection = Connection::open(database_path)?;
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

    pub(super) fn ensure_thread(
        &mut self,
        thread_id: &str,
        workspace_id: &str,
        title: Option<&str>,
    ) -> Result<()> {
        validate_id("thread_id", thread_id)?;
        validate_id("workspace_id", workspace_id)?;
        self.connection.execute(
            "INSERT INTO threads (id, workspace_id, title) VALUES (?1, ?2, ?3) \
             ON CONFLICT(id) DO UPDATE SET title = COALESCE(excluded.title, threads.title), \
             updated_at = unixepoch()",
            params![thread_id, workspace_id, title],
        )?;
        Ok(())
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

    pub(super) fn propose_operation(
        &mut self,
        operation_id: &str,
        approval_id: &str,
        turn_id: &str,
        tool_name: &str,
        request_hash: &str,
        arguments_json: &str,
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
            "INSERT INTO approvals (id, operation_id, turn_id, status) \
             VALUES (?1, ?2, ?3, 'pending') \
             ON CONFLICT(id) DO NOTHING",
            params![approval_id, operation_id, turn_id],
        )?;
        if approval_inserted == 0 {
            let existing: (String, String) = transaction.query_row(
                "SELECT operation_id, turn_id FROM approvals WHERE id = ?1",
                [approval_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if existing != (operation_id.to_owned(), turn_id.to_owned()) {
                return Err(PersistenceError::Conflict(format!(
                    "approval {approval_id} was reused for a different operation"
                )));
            }
        }
        transaction.commit()?;
        Ok(inserted == 1)
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
            transaction.execute(
                "UPDATE operations SET status = ?2, updated_at = unixepoch() \
                 WHERE id = ?1 AND status = 'proposed'",
                params![operation_id, decision],
            )?;
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
             WHERE id = ?1 AND status = 'approved'",
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
                    "operation {operation_id} is not approved or has a different result"
                )));
            }
        }
        Ok(updated == 1)
    }

    pub(super) fn load_thread_json(&mut self, thread_id: &str) -> Result<String> {
        validate_id("thread_id", thread_id)?;
        let thread = self.connection.query_row(
            "SELECT id, workspace_id, title, created_at, updated_at FROM threads WHERE id = ?1",
            [thread_id],
            |row| {
                Ok(ThreadRow {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    title: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
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
        Ok(serde_json::to_string(&ThreadSnapshot {
            thread,
            turns,
            items,
        })?)
    }
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
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > SCHEMA_VERSION {
        return Err(PersistenceError::InvalidInput(format!(
            "database schema {version} is newer than supported schema {SCHEMA_VERSION}"
        )));
    }
    if version == SCHEMA_VERSION {
        return Ok(());
    }
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
         WHERE status IN ('running', 'waiting')",
        [],
    )?;
    transaction.execute(
        "UPDATE operations SET status = 'failed', updated_at = unixepoch(),\
         result_json = '{\"kind\":\"runtimeRestart\",\"retryable\":true}'\
         WHERE status = 'executing'",
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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadRow {
    id: String,
    workspace_id: String,
    title: Option<String>,
    created_at: i64,
    updated_at: i64,
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
