use crate::DurableItemSnapshot;
use crate::DurableThreadLifecycle;
use crate::DurableThreadPage;
use crate::DurableThreadSummary;
use crate::ProjectionDiagnostic;
use crate::RolloutError;
use crate::SugarCodeHome;
use crate::rollout::CURRENT_ROLLOUT_SCHEMA_VERSION;
use crate::rollout::MAX_ROLLOUT_FILES;
use crate::rollout::RolloutThreadState;
use crate::rollout::parse_canonical_id;
use rusqlite::Connection;
use rusqlite::ErrorCode;
use rusqlite::OpenFlags;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use rusqlite::params;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::fs;
use std::fs::File;
use std::fs::OpenOptions;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use sugarcode_protocol::ThreadId;

const PROJECTIONS_DIRECTORY: &str = "projections";
const PROJECTION_LAYOUT_DIRECTORY: &str = "v1";
const DATABASE_FILE: &str = "thread-search.sqlite3";
const REBUILD_FILE: &str = ".thread-search.rebuild.sqlite3";
const CURRENT_PROJECTION_SCHEMA_VERSION: i64 = 1;
const DATABASE_PAGE_SIZE: i64 = 4096;
const MAX_DATABASE_PAGES: i64 = 262_144;
const MAX_DATABASE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_SEARCHABLE_ITEMS: usize = 1_000_000;
const MAX_QUERY_BYTES: usize = 256;
const MAX_QUERY_TERMS: usize = 16;
const MAX_PAGE_SIZE: usize = 100;

const CREATE_SCHEMA: &str = "
CREATE TABLE projection_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    rollout_schema_version INTEGER NOT NULL CHECK (rollout_schema_version = 1),
    rollout_file_count INTEGER NOT NULL CHECK (
        rollout_file_count >= 0 AND rollout_file_count <= 10000
    ),
    rollout_record_count INTEGER NOT NULL CHECK (
        rollout_record_count >= 0 AND rollout_record_count <= 1000000
    ),
    searchable_item_count INTEGER NOT NULL CHECK (
        searchable_item_count >= 0 AND searchable_item_count <= 1000000
    )
) STRICT;
CREATE TABLE thread_watermarks (
    thread_id TEXT PRIMARY KEY NOT NULL,
    thread_order_key TEXT NOT NULL UNIQUE,
    last_rollout_sequence INTEGER NOT NULL CHECK (last_rollout_sequence >= 1),
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'archived', 'deleted')),
    CHECK (
        length(thread_id) BETWEEN 20 AND 24
        AND substr(thread_id, 1, 4) = 'thr_'
        AND substr(thread_id, 5) NOT GLOB '*[^0-9]*'
    ),
    CHECK (
        length(thread_order_key) = 20
        AND thread_order_key NOT GLOB '*[^0-9]*'
    )
) STRICT;
CREATE UNIQUE INDEX thread_search_order
    ON thread_watermarks(thread_order_key DESC);
CREATE TABLE search_documents (
    document_id INTEGER PRIMARY KEY CHECK (document_id > 0),
    thread_id TEXT NOT NULL REFERENCES thread_watermarks(thread_id),
    rollout_sequence INTEGER NOT NULL CHECK (rollout_sequence >= 2),
    item_index INTEGER NOT NULL CHECK (item_index >= 0),
    item_id TEXT NOT NULL UNIQUE,
    text_sha256 BLOB NOT NULL CHECK (length(text_sha256) = 32),
    UNIQUE(thread_id, rollout_sequence, item_index)
) STRICT;
CREATE INDEX search_documents_thread
    ON search_documents(thread_id);
CREATE VIRTUAL TABLE search_fts USING fts5(
    text,
    content='',
    tokenize='unicode61 remove_diacritics 2'
);
";

#[derive(Debug)]
pub(crate) struct ThreadSearchProjection {
    root: PathBuf,
    database_path: PathBuf,
    connection: Option<Connection>,
    dirty: bool,
    dirty_kind: Option<&'static str>,
    dirty_rebuildable: bool,
    diagnostics: Vec<ProjectionDiagnostic>,
}

impl ThreadSearchProjection {
    pub(crate) fn open(
        home: &SugarCodeHome,
        threads: &BTreeMap<ThreadId, RolloutThreadState>,
        total_records: usize,
    ) -> Self {
        let root = home
            .path()
            .join(PROJECTIONS_DIRECTORY)
            .join(PROJECTION_LAYOUT_DIRECTORY);
        let database_path = root.join(DATABASE_FILE);
        match Self::try_open(root.clone(), database_path.clone(), threads, total_records) {
            Ok(projection) => projection,
            Err(error) => {
                let diagnostic = into_diagnostic(error, &database_path, "open");
                Self {
                    root,
                    database_path,
                    connection: None,
                    dirty: true,
                    dirty_kind: Some(diagnostic.kind),
                    dirty_rebuildable: false,
                    diagnostics: vec![diagnostic],
                }
            }
        }
    }

    fn try_open(
        root: PathBuf,
        database_path: PathBuf,
        threads: &BTreeMap<ThreadId, RolloutThreadState>,
        total_records: usize,
    ) -> Result<Self, RolloutError> {
        checked_directory(
            root.parent()
                .ok_or_else(|| projection_error(&root, "open", "invalidPath"))?,
        )?;
        checked_directory(&root)?;
        let mut projection = Self {
            root,
            database_path,
            connection: None,
            dirty: false,
            dirty_kind: None,
            dirty_rebuildable: true,
            diagnostics: Vec::new(),
        };
        projection.cleanup_rebuild_artifacts()?;
        let existed = projection.validate_database_entry()?;
        if !existed {
            projection.rebuild(threads, total_records)?;
            return Ok(projection);
        }

        let metadata = fs::metadata(&projection.database_path)
            .map_err(|error| projection.io_error("open", error))?;
        if metadata.len() > MAX_DATABASE_BYTES || projection.sidecars_need_rebuild()? {
            projection
                .diagnostics
                .push(projection.diagnostic("rebuild", "sizeLimitRecovered"));
            projection.rebuild(threads, total_records)?;
            return Ok(projection);
        }

        match projection.open_and_validate(threads, total_records) {
            Ok(connection) => projection.connection = Some(connection),
            Err(DatabaseValidationError::Recoverable(kind)) => {
                projection
                    .diagnostics
                    .push(projection.diagnostic("rebuild", kind));
                projection.rebuild(threads, total_records)?;
            }
            Err(DatabaseValidationError::Fatal(error)) => return Err(error),
        }
        Ok(projection)
    }

    pub(crate) fn diagnostics(&self) -> &[ProjectionDiagnostic] {
        &self.diagnostics
    }

    pub(crate) fn record_thread_created(
        &mut self,
        thread_id: &ThreadId,
    ) -> Result<(), RolloutError> {
        if self.dirty {
            return Ok(());
        }
        let order_key = thread_order_key(thread_id)?;
        let database_path = self.database_path.clone();
        let result = (|| {
            let connection = self
                .connection
                .as_mut()
                .ok_or_else(|| projection_error(&database_path, "update", "unavailable"))?;
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| sqlite_error(&database_path, "update", error))?;
            transaction
                .execute(
                    "INSERT INTO thread_watermarks (
                        thread_id, thread_order_key, last_rollout_sequence, lifecycle
                     ) VALUES (?1, ?2, 1, 'active')",
                    params![thread_id.as_str(), order_key],
                )
                .map_err(|error| sqlite_error(&database_path, "update", error))?;
            require_one(
                transaction
                    .execute(
                        "UPDATE projection_metadata
                         SET rollout_file_count = rollout_file_count + 1,
                             rollout_record_count = rollout_record_count + 1
                         WHERE singleton = 1",
                        [],
                    )
                    .map_err(|error| sqlite_error(&database_path, "update", error))?,
                &database_path,
                "update",
            )?;
            transaction
                .commit()
                .map_err(|error| sqlite_error(&database_path, "update", error))
        })();
        if let Err(error) = &result {
            self.mark_dirty(
                "update",
                projection_error_kind(error),
                is_rebuildable_projection_error(error),
            );
        }
        result
    }

    pub(crate) fn record_thread_archived(
        &mut self,
        thread_id: &ThreadId,
        record_sequence: u64,
    ) -> Result<(), RolloutError> {
        if self.dirty {
            return Ok(());
        }
        let current_sequence =
            i64::try_from(record_sequence).map_err(|_| RolloutError::InvalidRecord {
                kind: "projectionSequence",
            })?;
        let previous_sequence = current_sequence - 1;
        let database_path = self.database_path.clone();
        let result = (|| {
            let connection = self
                .connection
                .as_mut()
                .ok_or_else(|| projection_error(&database_path, "update", "unavailable"))?;
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| sqlite_error(&database_path, "update", error))?;
            require_one(
                transaction
                    .execute(
                        "UPDATE thread_watermarks
                         SET last_rollout_sequence = ?2, lifecycle = 'archived'
                         WHERE thread_id = ?1
                           AND last_rollout_sequence = ?3
                           AND lifecycle = 'active'",
                        params![thread_id.as_str(), current_sequence, previous_sequence],
                    )
                    .map_err(|error| sqlite_error(&database_path, "update", error))?,
                &database_path,
                "update",
            )?;
            require_one(
                transaction
                    .execute(
                        "UPDATE projection_metadata
                         SET rollout_record_count = rollout_record_count + 1
                         WHERE singleton = 1",
                        [],
                    )
                    .map_err(|error| sqlite_error(&database_path, "update", error))?,
                &database_path,
                "update",
            )?;
            transaction
                .commit()
                .map_err(|error| sqlite_error(&database_path, "update", error))
        })();
        if let Err(error) = &result {
            self.mark_dirty(
                "update",
                projection_error_kind(error),
                is_rebuildable_projection_error(error),
            );
        }
        result
    }

    pub(crate) fn record_thread_unarchived(
        &mut self,
        thread_id: &ThreadId,
        record_sequence: u64,
    ) -> Result<(), RolloutError> {
        if self.dirty {
            return Ok(());
        }
        let current_sequence =
            i64::try_from(record_sequence).map_err(|_| RolloutError::InvalidRecord {
                kind: "projectionSequence",
            })?;
        let previous_sequence = current_sequence - 1;
        let database_path = self.database_path.clone();
        let result = (|| {
            let connection = self
                .connection
                .as_mut()
                .ok_or_else(|| projection_error(&database_path, "update", "unavailable"))?;
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| sqlite_error(&database_path, "update", error))?;
            require_one(
                transaction
                    .execute(
                        "UPDATE thread_watermarks
                         SET last_rollout_sequence = ?2, lifecycle = 'active'
                         WHERE thread_id = ?1
                           AND last_rollout_sequence = ?3
                           AND lifecycle = 'archived'",
                        params![thread_id.as_str(), current_sequence, previous_sequence],
                    )
                    .map_err(|error| sqlite_error(&database_path, "update", error))?,
                &database_path,
                "update",
            )?;
            require_one(
                transaction
                    .execute(
                        "UPDATE projection_metadata
                         SET rollout_record_count = rollout_record_count + 1
                         WHERE singleton = 1",
                        [],
                    )
                    .map_err(|error| sqlite_error(&database_path, "update", error))?,
                &database_path,
                "update",
            )?;
            transaction
                .commit()
                .map_err(|error| sqlite_error(&database_path, "update", error))
        })();
        if let Err(error) = &result {
            self.mark_dirty(
                "update",
                projection_error_kind(error),
                is_rebuildable_projection_error(error),
            );
        }
        result
    }

    pub(crate) fn record_thread_deleted(
        &mut self,
        thread_id: &ThreadId,
        record_sequence: u64,
    ) -> Result<(), RolloutError> {
        if self.dirty {
            return Ok(());
        }
        let current_sequence =
            i64::try_from(record_sequence).map_err(|_| RolloutError::InvalidRecord {
                kind: "projectionSequence",
            })?;
        let previous_sequence = current_sequence - 1;
        let database_path = self.database_path.clone();
        let result = (|| {
            let connection = self
                .connection
                .as_mut()
                .ok_or_else(|| projection_error(&database_path, "update", "unavailable"))?;
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| sqlite_error(&database_path, "update", error))?;
            require_one(
                transaction
                    .execute(
                        "UPDATE thread_watermarks
                         SET last_rollout_sequence = ?2, lifecycle = 'deleted'
                         WHERE thread_id = ?1
                           AND last_rollout_sequence = ?3
                           AND lifecycle IN ('active', 'archived')",
                        params![thread_id.as_str(), current_sequence, previous_sequence],
                    )
                    .map_err(|error| sqlite_error(&database_path, "update", error))?,
                &database_path,
                "update",
            )?;
            require_one(
                transaction
                    .execute(
                        "UPDATE projection_metadata
                         SET rollout_record_count = rollout_record_count + 1
                         WHERE singleton = 1",
                        [],
                    )
                    .map_err(|error| sqlite_error(&database_path, "update", error))?,
                &database_path,
                "update",
            )?;
            transaction
                .commit()
                .map_err(|error| sqlite_error(&database_path, "update", error))
        })();
        if let Err(error) = &result {
            self.mark_dirty(
                "update",
                projection_error_kind(error),
                is_rebuildable_projection_error(error),
            );
        }
        result
    }

    pub(crate) fn record_turn_completed(
        &mut self,
        thread_id: &ThreadId,
        record_sequence: u64,
        turn: &crate::DurableTurnSnapshot,
    ) -> Result<(), RolloutError> {
        if self.dirty {
            return Ok(());
        }
        let current_sequence =
            i64::try_from(record_sequence).map_err(|_| RolloutError::InvalidRecord {
                kind: "projectionSequence",
            })?;
        let previous_sequence = current_sequence - 1;
        let added_items = turn.items.len();
        let database_path = self.database_path.clone();
        let result = (|| {
            let connection = self
                .connection
                .as_mut()
                .ok_or_else(|| projection_error(&database_path, "update", "unavailable"))?;
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| sqlite_error(&database_path, "update", error))?;
            require_one(
                transaction
                    .execute(
                        "UPDATE thread_watermarks
                         SET last_rollout_sequence = ?2
                         WHERE thread_id = ?1
                           AND last_rollout_sequence = ?3
                           AND lifecycle = 'active'",
                        params![thread_id.as_str(), current_sequence, previous_sequence],
                    )
                    .map_err(|error| sqlite_error(&database_path, "update", error))?,
                &database_path,
                "update",
            )?;
            {
                let mut document_statement = transaction
                    .prepare(
                        "INSERT INTO search_documents (
                            document_id, thread_id, rollout_sequence, item_index,
                            item_id, text_sha256
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    )
                    .map_err(|error| sqlite_error(&database_path, "update", error))?;
                let mut fts_statement = transaction
                    .prepare("INSERT INTO search_fts(rowid, text) VALUES (?1, ?2)")
                    .map_err(|error| sqlite_error(&database_path, "update", error))?;
                for (item_index, item) in turn.items.iter().enumerate() {
                    let DurableItemSnapshot::AgentMessage { id, text } = item;
                    let document_id = item_document_id(id.as_str())?;
                    let digest = Sha256::digest(text.as_bytes());
                    document_statement
                        .execute(params![
                            document_id,
                            thread_id.as_str(),
                            current_sequence,
                            bounded_i64(item_index, &database_path, "searchableItems")?,
                            id.as_str(),
                            digest.as_slice(),
                        ])
                        .map_err(|error| sqlite_error(&database_path, "update", error))?;
                    fts_statement
                        .execute(params![document_id, text])
                        .map_err(|error| sqlite_error(&database_path, "update", error))?;
                }
            }
            require_one(
                transaction
                    .execute(
                        "UPDATE projection_metadata
                         SET rollout_record_count = rollout_record_count + 1,
                             searchable_item_count = searchable_item_count + ?1
                         WHERE singleton = 1
                           AND searchable_item_count + ?1 <= 1000000",
                        params![bounded_i64(added_items, &database_path, "searchableItems")?],
                    )
                    .map_err(|error| sqlite_error(&database_path, "update", error))?,
                &database_path,
                "update",
            )?;
            transaction
                .commit()
                .map_err(|error| sqlite_error(&database_path, "update", error))
        })();
        if let Err(error) = &result {
            self.mark_dirty(
                "update",
                projection_error_kind(error),
                is_rebuildable_projection_error(error),
            );
        }
        result
    }

    pub(crate) fn search_threads(
        &mut self,
        source_threads: &BTreeMap<ThreadId, RolloutThreadState>,
        total_records: usize,
        query: &str,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, RolloutError> {
        let match_query = compile_match_query(query)?;
        if limit == 0 || limit > MAX_PAGE_SIZE {
            return Err(RolloutError::InvalidRecord {
                kind: "threadSearchLimit",
            });
        }
        let cursor_key = cursor.map(thread_order_key).transpose()?;
        if self.dirty {
            if !self.dirty_rebuildable {
                return Err(RolloutError::Projection(
                    self.diagnostic("query", self.dirty_kind.unwrap_or("unavailable")),
                ));
            }
            self.rebuild(source_threads, total_records)?;
        }
        match self.query_page(&match_query, cursor_key.as_deref(), limit) {
            Ok(page) => Ok(page),
            Err(error) if is_rebuildable_projection_error(&error) => {
                self.mark_dirty("query", projection_error_kind(&error), true);
                self.rebuild(source_threads, total_records)?;
                self.query_page(&match_query, cursor_key.as_deref(), limit)
            }
            Err(error) => Err(error),
        }
    }

    fn query_page(
        &self,
        match_query: &str,
        cursor_key: Option<&str>,
        limit: usize,
    ) -> Result<DurableThreadPage, RolloutError> {
        let connection = self
            .connection
            .as_ref()
            .ok_or_else(|| projection_error(&self.database_path, "query", "unavailable"))?;
        let sql = if cursor_key.is_some() {
            "SELECT DISTINCT watermarks.thread_id, watermarks.thread_order_key
             FROM search_fts
             JOIN search_documents AS documents ON documents.document_id = search_fts.rowid
             JOIN thread_watermarks AS watermarks
               ON watermarks.thread_id = documents.thread_id
             WHERE search_fts MATCH ?1
               AND watermarks.lifecycle = 'active'
               AND watermarks.thread_order_key < ?2
             ORDER BY watermarks.thread_order_key DESC
             LIMIT ?3"
        } else {
            "SELECT DISTINCT watermarks.thread_id, watermarks.thread_order_key
             FROM search_fts
             JOIN search_documents AS documents ON documents.document_id = search_fts.rowid
             JOIN thread_watermarks AS watermarks
               ON watermarks.thread_id = documents.thread_id
             WHERE search_fts MATCH ?1 AND watermarks.lifecycle = 'active'
             ORDER BY watermarks.thread_order_key DESC
             LIMIT ?2"
        };
        let mut statement = connection
            .prepare(sql)
            .map_err(|error| sqlite_error(&self.database_path, "query", error))?;
        let query_limit = i64::try_from(limit + 1).map_err(|_| RolloutError::InvalidRecord {
            kind: "threadSearchLimit",
        })?;
        let mut ids = Vec::with_capacity(limit + 1);
        if let Some(cursor_key) = cursor_key {
            let rows = statement
                .query_map(params![match_query, cursor_key, query_limit], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|error| sqlite_error(&self.database_path, "query", error))?;
            for row in rows {
                ids.push(row.map_err(|error| sqlite_error(&self.database_path, "query", error))?);
            }
        } else {
            let rows = statement
                .query_map(params![match_query, query_limit], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|error| sqlite_error(&self.database_path, "query", error))?;
            for row in rows {
                ids.push(row.map_err(|error| sqlite_error(&self.database_path, "query", error))?);
            }
        }
        let has_more = ids.len() > limit;
        ids.truncate(limit);
        let next_cursor = has_more
            .then(|| ids.last().cloned())
            .flatten()
            .map(ThreadId::new);
        Ok(DurableThreadPage {
            data: ids
                .into_iter()
                .map(|id| DurableThreadSummary {
                    id: ThreadId::new(id),
                })
                .collect(),
            next_cursor,
        })
    }

    fn open_and_validate(
        &self,
        threads: &BTreeMap<ThreadId, RolloutThreadState>,
        total_records: usize,
    ) -> Result<Connection, DatabaseValidationError> {
        let connection = open_existing_database(&self.database_path)
            .map_err(|error| classify_validation_error(&self.database_path, "open", error))?;
        configure_connection(&connection)
            .map_err(|error| classify_validation_error(&self.database_path, "configure", error))?;
        validate_projection(&connection, threads, total_records)
            .map_err(|error| classify_validation_error(&self.database_path, "validate", error))?;
        Ok(connection)
    }

    fn rebuild(
        &mut self,
        threads: &BTreeMap<ThreadId, RolloutThreadState>,
        total_records: usize,
    ) -> Result<(), RolloutError> {
        self.connection = None;
        self.cleanup_rebuild_artifacts()?;
        let rebuild_path = self.root.join(REBUILD_FILE);
        precreate_database_file(&rebuild_path)?;
        if let Err(error) = build_database(&rebuild_path, threads, total_records) {
            let _ = remove_regular_file_if_present(&rebuild_path);
            return Err(error);
        }
        OpenOptions::new()
            .read(true)
            .write(true)
            .open(&rebuild_path)
            .and_then(|file| file.sync_all())
            .map_err(|error| self.io_error("rebuild", error))?;
        self.cleanup_database_sidecars()?;
        fs::rename(&rebuild_path, &self.database_path)
            .map_err(|error| self.io_error("replace", error))?;
        sync_parent(&self.database_path)?;
        let connection = self
            .open_and_validate(threads, total_records)
            .map_err(|error| error.into_rollout_error(&self.database_path))?;
        self.connection = Some(connection);
        self.dirty = false;
        self.dirty_kind = None;
        self.dirty_rebuildable = true;
        Ok(())
    }

    fn mark_dirty(&mut self, operation: &'static str, kind: &'static str, rebuildable: bool) {
        self.connection = None;
        self.dirty = true;
        self.dirty_kind = Some(kind);
        self.dirty_rebuildable = rebuildable;
        self.diagnostics.push(self.diagnostic(operation, kind));
    }

    fn validate_database_entry(&self) -> Result<bool, RolloutError> {
        match fs::symlink_metadata(&self.database_path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                Err(self.diagnostic_error("open", "invalidPathType"))
            }
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(self.io_error("open", error)),
        }
    }

    fn cleanup_rebuild_artifacts(&self) -> Result<(), RolloutError> {
        let rebuild_path = self.root.join(REBUILD_FILE);
        remove_regular_file_if_present(&rebuild_path)?;
        for suffix in ["-journal", "-wal", "-shm"] {
            remove_regular_file_if_present(&sidecar_path(&rebuild_path, suffix))?;
        }
        Ok(())
    }

    fn cleanup_database_sidecars(&self) -> Result<(), RolloutError> {
        for suffix in ["-journal", "-wal", "-shm"] {
            remove_regular_file_if_present(&sidecar_path(&self.database_path, suffix))?;
        }
        Ok(())
    }

    fn sidecars_need_rebuild(&self) -> Result<bool, RolloutError> {
        for suffix in ["-journal", "-wal", "-shm"] {
            let path = sidecar_path(&self.database_path, suffix);
            match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                    return Err(projection_error(&path, "open", "invalidPathType"));
                }
                Ok(metadata) if metadata.len() > MAX_DATABASE_BYTES => return Ok(true),
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(projection_error(&path, "open", io_error_kind(&error))),
            }
        }
        Ok(false)
    }

    fn diagnostic(&self, operation: &'static str, kind: &'static str) -> ProjectionDiagnostic {
        ProjectionDiagnostic {
            path: self.database_path.clone(),
            operation,
            kind,
        }
    }

    fn diagnostic_error(&self, operation: &'static str, kind: &'static str) -> RolloutError {
        RolloutError::Projection(self.diagnostic(operation, kind))
    }

    fn io_error(&self, operation: &'static str, error: std::io::Error) -> RolloutError {
        projection_error(&self.database_path, operation, io_error_kind(&error))
    }
}

enum DatabaseValidationError {
    Recoverable(&'static str),
    Fatal(RolloutError),
}

impl DatabaseValidationError {
    fn into_rollout_error(self, path: &Path) -> RolloutError {
        match self {
            Self::Recoverable(kind) => projection_error(path, "rebuild", kind),
            Self::Fatal(error) => error,
        }
    }
}

fn build_database(
    path: &Path,
    threads: &BTreeMap<ThreadId, RolloutThreadState>,
    total_records: usize,
) -> Result<(), RolloutError> {
    let searchable_items = searchable_item_count(threads)?;
    let mut connection =
        open_existing_database(path).map_err(|error| sqlite_error(path, "rebuild", error))?;
    connection
        .pragma_update(None, "page_size", DATABASE_PAGE_SIZE)
        .map_err(|error| sqlite_error(path, "rebuild", error))?;
    configure_connection(&connection).map_err(|error| sqlite_error(path, "rebuild", error))?;
    connection
        .pragma_update(None, "max_page_count", MAX_DATABASE_PAGES)
        .map_err(|error| sqlite_error(path, "rebuild", error))?;
    require_fts5(&connection).map_err(|error| sqlite_error(path, "rebuild", error))?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| sqlite_error(path, "rebuild", error))?;
    transaction
        .execute_batch(CREATE_SCHEMA)
        .map_err(|error| sqlite_error(path, "rebuild", error))?;
    transaction
        .execute(
            "INSERT INTO projection_metadata (
                singleton, schema_version, rollout_schema_version,
                rollout_file_count, rollout_record_count, searchable_item_count
             ) VALUES (1, ?1, ?2, ?3, ?4, ?5)",
            params![
                CURRENT_PROJECTION_SCHEMA_VERSION,
                i64::from(CURRENT_ROLLOUT_SCHEMA_VERSION),
                bounded_i64(threads.len(), path, "rolloutFiles")?,
                bounded_i64(total_records, path, "totalReplayRecords")?,
                bounded_i64(searchable_items, path, "searchableItems")?,
            ],
        )
        .map_err(|error| sqlite_error(path, "rebuild", error))?;
    for state in threads.values() {
        let snapshot = &state.snapshot;
        transaction
            .execute(
                "INSERT INTO thread_watermarks (
                    thread_id, thread_order_key, last_rollout_sequence, lifecycle
                 ) VALUES (?1, ?2, ?3, ?4)",
                params![
                    snapshot.id.as_str(),
                    thread_order_key(&snapshot.id)?,
                    i64::try_from(state.last_record_sequence)
                        .map_err(|_| { projection_error(path, "rebuild", "rolloutRecordLimit") })?,
                    lifecycle_name(snapshot.lifecycle),
                ],
            )
            .map_err(|error| sqlite_error(path, "rebuild", error))?;
        for (turn, record_sequence) in snapshot.turns.iter().zip(&state.turn_record_sequences) {
            let rollout_sequence = i64::try_from(*record_sequence)
                .map_err(|_| projection_error(path, "rebuild", "rolloutRecordLimit"))?;
            for (item_index, item) in turn.items.iter().enumerate() {
                let DurableItemSnapshot::AgentMessage { id, text } = item;
                let document_id = item_document_id(id.as_str())?;
                let digest = Sha256::digest(text.as_bytes());
                transaction
                    .execute(
                        "INSERT INTO search_documents (
                            document_id, thread_id, rollout_sequence, item_index,
                            item_id, text_sha256
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![
                            document_id,
                            snapshot.id.as_str(),
                            rollout_sequence,
                            bounded_i64(item_index, path, "searchableItems")?,
                            id.as_str(),
                            digest.as_slice(),
                        ],
                    )
                    .map_err(|error| sqlite_error(path, "rebuild", error))?;
                transaction
                    .execute(
                        "INSERT INTO search_fts(rowid, text) VALUES (?1, ?2)",
                        params![document_id, text],
                    )
                    .map_err(|error| sqlite_error(path, "rebuild", error))?;
            }
        }
    }
    transaction
        .commit()
        .map_err(|error| sqlite_error(path, "rebuild", error))?;
    validate_projection(&connection, threads, total_records)
        .map_err(|error| sqlite_error(path, "rebuild", error))?;
    connection
        .execute_batch("PRAGMA optimize")
        .map_err(|error| sqlite_error(path, "rebuild", error))?;
    connection
        .close()
        .map_err(|(_, error)| sqlite_error(path, "rebuild", error))
}

fn validate_projection(
    connection: &Connection,
    threads: &BTreeMap<ThreadId, RolloutThreadState>,
    total_records: usize,
) -> rusqlite::Result<()> {
    require_fts5(connection)?;
    let quick_check: String =
        connection.query_row("PRAGMA quick_check(1)", [], |row| row.get(0))?;
    if quick_check != "ok" {
        return Err(rusqlite::Error::InvalidQuery);
    }
    connection.execute(
        "INSERT INTO search_fts(search_fts) VALUES('integrity-check')",
        [],
    )?;
    let page_size: i64 = connection.query_row("PRAGMA page_size", [], |row| row.get(0))?;
    let page_count: i64 = connection.query_row("PRAGMA page_count", [], |row| row.get(0))?;
    if page_size <= 0
        || page_count < 0
        || page_count
            .checked_mul(page_size)
            .is_none_or(|bytes| bytes > MAX_DATABASE_BYTES as i64)
    {
        return Err(rusqlite::Error::InvalidQuery);
    }

    let searchable_items =
        searchable_item_count(threads).map_err(|_| rusqlite::Error::InvalidQuery)?;
    let metadata = connection
        .query_row(
            "SELECT schema_version, rollout_schema_version, rollout_file_count,
                    rollout_record_count, searchable_item_count
             FROM projection_metadata WHERE singleton = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()?;
    if metadata
        != Some((
            CURRENT_PROJECTION_SCHEMA_VERSION,
            i64::from(CURRENT_ROLLOUT_SCHEMA_VERSION),
            threads.len() as i64,
            total_records as i64,
            searchable_items as i64,
        ))
    {
        return Err(rusqlite::Error::InvalidQuery);
    }

    let mut watermarks = connection.prepare(
        "SELECT thread_id, thread_order_key, last_rollout_sequence, lifecycle
         FROM thread_watermarks ORDER BY thread_order_key ASC",
    )?;
    let mut rows = watermarks.query([])?;
    let mut thread_count = 0usize;
    while let Some(row) = rows.next()? {
        if thread_count >= MAX_ROLLOUT_FILES {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let thread_id: String = row.get(0)?;
        let order_key: String = row.get(1)?;
        let sequence: i64 = row.get(2)?;
        let lifecycle: String = row.get(3)?;
        let Some(state) = threads.get(&ThreadId::new(thread_id)) else {
            return Err(rusqlite::Error::InvalidQuery);
        };
        let snapshot = &state.snapshot;
        if order_key != thread_order_key(&snapshot.id).map_err(|_| rusqlite::Error::InvalidQuery)?
            || sequence
                != i64::try_from(state.last_record_sequence)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?
            || lifecycle != lifecycle_name(snapshot.lifecycle)
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        thread_count += 1;
    }
    if thread_count != threads.len() {
        return Err(rusqlite::Error::InvalidQuery);
    }

    let expected_documents = expected_documents(threads)?;
    let mut documents = connection.prepare(
        "SELECT document_id, thread_id, rollout_sequence, item_index,
                item_id, text_sha256
         FROM search_documents ORDER BY document_id ASC",
    )?;
    let actual = documents
        .query_map([], |row| {
            Ok(ExpectedDocument {
                document_id: row.get(0)?,
                thread_id: row.get(1)?,
                rollout_sequence: row.get(2)?,
                item_index: row.get(3)?,
                item_id: row.get(4)?,
                text_sha256: row.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if actual != expected_documents {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let fts_rowids = connection
        .prepare("SELECT rowid FROM search_fts ORDER BY rowid ASC")?
        .query_map([], |row| row.get::<_, i64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if fts_rowids
        != expected_documents
            .iter()
            .map(|document| document.document_id)
            .collect::<Vec<_>>()
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
struct ExpectedDocument {
    document_id: i64,
    thread_id: String,
    rollout_sequence: i64,
    item_index: i64,
    item_id: String,
    text_sha256: Vec<u8>,
}

fn expected_documents(
    threads: &BTreeMap<ThreadId, RolloutThreadState>,
) -> rusqlite::Result<Vec<ExpectedDocument>> {
    let mut documents = Vec::new();
    for state in threads.values() {
        let snapshot = &state.snapshot;
        for (turn, record_sequence) in snapshot.turns.iter().zip(&state.turn_record_sequences) {
            for (item_index, item) in turn.items.iter().enumerate() {
                let DurableItemSnapshot::AgentMessage { id, text } = item;
                documents.push(ExpectedDocument {
                    document_id: item_document_id(id.as_str())
                        .map_err(|_| rusqlite::Error::InvalidQuery)?,
                    thread_id: snapshot.id.as_str().to_string(),
                    rollout_sequence: i64::try_from(*record_sequence)
                        .map_err(|_| rusqlite::Error::InvalidQuery)?,
                    item_index: i64::try_from(item_index)
                        .map_err(|_| rusqlite::Error::InvalidQuery)?,
                    item_id: id.as_str().to_string(),
                    text_sha256: Sha256::digest(text.as_bytes()).to_vec(),
                });
            }
        }
    }
    documents.sort_unstable_by_key(|document| document.document_id);
    Ok(documents)
}

fn searchable_item_count(
    threads: &BTreeMap<ThreadId, RolloutThreadState>,
) -> Result<usize, RolloutError> {
    let count = threads
        .values()
        .flat_map(|thread| &thread.snapshot.turns)
        .try_fold(0usize, |count, turn| count.checked_add(turn.items.len()))
        .ok_or_else(|| {
            projection_error(Path::new(DATABASE_FILE), "rebuild", "searchableItemLimit")
        })?;
    if count > MAX_SEARCHABLE_ITEMS {
        return Err(projection_error(
            Path::new(DATABASE_FILE),
            "rebuild",
            "searchableItemLimit",
        ));
    }
    Ok(count)
}

fn compile_match_query(query: &str) -> Result<String, RolloutError> {
    if query.chars().any(char::is_control) {
        return Err(RolloutError::InvalidRecord {
            kind: "threadSearchQuery",
        });
    }
    let query = query.trim();
    let terms = query.split_whitespace().collect::<Vec<_>>();
    if query.is_empty() || query.len() > MAX_QUERY_BYTES || terms.len() > MAX_QUERY_TERMS {
        return Err(RolloutError::InvalidRecord {
            kind: "threadSearchQuery",
        });
    }
    Ok(terms
        .into_iter()
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND "))
}

fn require_fts5(connection: &Connection) -> rusqlite::Result<()> {
    let enabled: i64 = connection.query_row(
        "SELECT sqlite_compileoption_used('ENABLE_FTS5')",
        [],
        |row| row.get(0),
    )?;
    if enabled == 1 {
        Ok(())
    } else {
        Err(rusqlite::Error::InvalidQuery)
    }
}

fn configure_connection(connection: &Connection) -> rusqlite::Result<()> {
    connection.busy_timeout(Duration::ZERO)?;
    connection.pragma_update(None, "journal_mode", "DELETE")?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "trusted_schema", "OFF")?;
    connection.pragma_update(None, "max_page_count", MAX_DATABASE_PAGES)?;
    Ok(())
}

fn open_existing_database(path: &Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
}

fn checked_directory(path: &Path) -> Result<PathBuf, RolloutError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err(projection_error(path, "open", "invalidPathType"))
        }
        Ok(_) => Ok(path.to_path_buf()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            create_directory(path)?;
            Ok(path.to_path_buf())
        }
        Err(error) => Err(projection_error(path, "open", io_error_kind(&error))),
    }
}

fn create_directory(path: &Path) -> Result<(), RolloutError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        builder
            .create(path)
            .map_err(|error| projection_error(path, "create", io_error_kind(&error)))?;
    }
    #[cfg(not(unix))]
    fs::create_dir(path)
        .map_err(|error| projection_error(path, "create", io_error_kind(&error)))?;
    sync_parent(path)
}

fn precreate_database_file(path: &Path) -> Result<(), RolloutError> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map(|_| ())
        .map_err(|error| projection_error(path, "rebuild", io_error_kind(&error)))
}

fn remove_regular_file_if_present(path: &Path) -> Result<(), RolloutError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(projection_error(path, "cleanup", "invalidPathType"))
        }
        Ok(_) => fs::remove_file(path)
            .map_err(|error| projection_error(path, "cleanup", io_error_kind(&error))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(projection_error(path, "cleanup", io_error_kind(&error))),
    }
}

fn sync_parent(path: &Path) -> Result<(), RolloutError> {
    #[cfg(unix)]
    {
        let parent = path
            .parent()
            .ok_or_else(|| projection_error(path, "sync", "invalidPath"))?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| projection_error(parent, "sync", io_error_kind(&error)))?;
    }
    Ok(())
}

fn sidecar_path(database_path: &Path, suffix: &str) -> PathBuf {
    let mut value = database_path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn thread_order_key(thread_id: &ThreadId) -> Result<String, RolloutError> {
    let sequence = parse_canonical_id(thread_id.as_str(), "thr_", "thread")?;
    Ok(format!("{sequence:020}"))
}

fn lifecycle_name(lifecycle: DurableThreadLifecycle) -> &'static str {
    match lifecycle {
        DurableThreadLifecycle::Active => "active",
        DurableThreadLifecycle::Archived => "archived",
        DurableThreadLifecycle::Deleted => "deleted",
    }
}

fn item_document_id(item_id: &str) -> Result<i64, RolloutError> {
    let sequence = parse_canonical_id(item_id, "item_", "item")?;
    i64::try_from(sequence).map_err(|_| RolloutError::InvalidRecord {
        kind: "searchDocumentId",
    })
}

fn bounded_i64(value: usize, path: &Path, kind: &'static str) -> Result<i64, RolloutError> {
    i64::try_from(value).map_err(|_| projection_error(path, "rebuild", kind))
}

fn require_one(changed: usize, path: &Path, operation: &'static str) -> Result<(), RolloutError> {
    if changed == 1 {
        Ok(())
    } else {
        Err(projection_error(path, operation, "stale"))
    }
}

fn classify_validation_error(
    path: &Path,
    operation: &'static str,
    error: rusqlite::Error,
) -> DatabaseValidationError {
    match error.sqlite_error_code() {
        Some(
            ErrorCode::DatabaseBusy
            | ErrorCode::DatabaseLocked
            | ErrorCode::PermissionDenied
            | ErrorCode::ReadOnly
            | ErrorCode::SystemIoFailure
            | ErrorCode::DiskFull
            | ErrorCode::CannotOpen
            | ErrorCode::FileLockingProtocolFailed,
        ) => DatabaseValidationError::Fatal(sqlite_error(path, operation, error)),
        Some(ErrorCode::NotADatabase) => {
            DatabaseValidationError::Recoverable("invalidHeaderRecovered")
        }
        Some(ErrorCode::DatabaseCorrupt) => {
            DatabaseValidationError::Recoverable("corruptionRecovered")
        }
        _ => DatabaseValidationError::Recoverable("staleRecovered"),
    }
}

fn sqlite_error(path: &Path, operation: &'static str, error: rusqlite::Error) -> RolloutError {
    projection_error(
        path,
        operation,
        match error.sqlite_error_code() {
            Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => "busy",
            Some(ErrorCode::PermissionDenied | ErrorCode::ReadOnly) => "permissionDenied",
            Some(ErrorCode::DiskFull) => "diskFull",
            Some(ErrorCode::CannotOpen) => "cannotOpen",
            Some(ErrorCode::NotADatabase) => "invalidHeader",
            Some(ErrorCode::DatabaseCorrupt) => "corrupt",
            Some(ErrorCode::SystemIoFailure | ErrorCode::FileLockingProtocolFailed) => "ioFailure",
            _ => "sqliteFailure",
        },
    )
}

fn io_error_kind(error: &std::io::Error) -> &'static str {
    match error.kind() {
        std::io::ErrorKind::NotFound => "notFound",
        std::io::ErrorKind::PermissionDenied => "permissionDenied",
        std::io::ErrorKind::AlreadyExists => "alreadyExists",
        std::io::ErrorKind::InvalidInput => "invalidPath",
        std::io::ErrorKind::NotADirectory => "notDirectory",
        std::io::ErrorKind::IsADirectory => "isDirectory",
        std::io::ErrorKind::ReadOnlyFilesystem => "readOnlyFilesystem",
        _ => "ioFailure",
    }
}

fn projection_error(path: &Path, operation: &'static str, kind: &'static str) -> RolloutError {
    RolloutError::Projection(ProjectionDiagnostic {
        path: path.to_path_buf(),
        operation,
        kind,
    })
}

fn into_diagnostic(
    error: RolloutError,
    path: &Path,
    operation: &'static str,
) -> ProjectionDiagnostic {
    match error {
        RolloutError::Projection(diagnostic) => diagnostic,
        _ => ProjectionDiagnostic {
            path: path.to_path_buf(),
            operation,
            kind: "projectionFailure",
        },
    }
}

fn projection_error_kind(error: &RolloutError) -> &'static str {
    match error {
        RolloutError::Projection(diagnostic) => diagnostic.kind,
        _ => "projectionFailure",
    }
}

fn is_rebuildable_projection_error(error: &RolloutError) -> bool {
    matches!(
        error,
        RolloutError::Projection(ProjectionDiagnostic {
            kind: "invalidHeader" | "corrupt" | "sqliteFailure" | "stale" | "projectionFailure",
            ..
        })
    )
}
