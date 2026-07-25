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
const DATABASE_FILE: &str = "thread-discovery.sqlite3";
const REBUILD_FILE: &str = ".thread-discovery.rebuild.sqlite3";
const CURRENT_PROJECTION_SCHEMA_VERSION: i64 = 1;
const DATABASE_PAGE_SIZE: i64 = 4096;
const MAX_DATABASE_PAGES: i64 = 16_384;
const MAX_DATABASE_BYTES: u64 = 64 * 1024 * 1024;

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
    )
) STRICT;
CREATE TABLE threads (
    thread_id TEXT PRIMARY KEY NOT NULL,
    thread_order_key TEXT NOT NULL,
    last_rollout_sequence INTEGER NOT NULL CHECK (last_rollout_sequence >= 1),
    archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
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
CREATE UNIQUE INDEX thread_discovery_order
    ON threads(thread_order_key DESC);
";

#[derive(Debug)]
pub(crate) struct ThreadDiscoveryProjection {
    root: PathBuf,
    database_path: PathBuf,
    connection: Option<Connection>,
    dirty: bool,
    dirty_kind: Option<&'static str>,
    dirty_rebuildable: bool,
    diagnostics: Vec<ProjectionDiagnostic>,
}

impl ThreadDiscoveryProjection {
    pub(crate) fn open(
        home: &SugarCodeHome,
        threads: &BTreeMap<ThreadId, RolloutThreadState>,
        total_records: usize,
    ) -> Result<Self, RolloutError> {
        let projections = checked_directory(&home.path().join(PROJECTIONS_DIRECTORY))?;
        let root = checked_directory(&projections.join(PROJECTION_LAYOUT_DIRECTORY))?;
        let database_path = root.join(DATABASE_FILE);
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
        if metadata.len() > MAX_DATABASE_BYTES {
            projection
                .diagnostics
                .push(projection.diagnostic("rebuild", "sizeLimitRecovered"));
            projection.rebuild(threads, total_records)?;
            return Ok(projection);
        }
        if projection.sidecars_need_rebuild()? {
            projection
                .diagnostics
                .push(projection.diagnostic("rebuild", "sidecarLimitRecovered"));
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

    fn mark_dirty(&mut self, operation: &'static str, kind: &'static str, rebuildable: bool) {
        self.connection = None;
        self.dirty = true;
        self.dirty_kind = Some(kind);
        self.dirty_rebuildable = rebuildable;
        self.diagnostics.push(self.diagnostic(operation, kind));
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
            let connection = self.connection.as_mut().ok_or_else(|| {
                RolloutError::Projection(ProjectionDiagnostic {
                    path: database_path.clone(),
                    operation: "update",
                    kind: "unavailable",
                })
            })?;
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| sqlite_error(&database_path, "update", error))?;
            transaction
                .execute(
                    "INSERT INTO threads (
                        thread_id, thread_order_key, last_rollout_sequence, archived
                    ) VALUES (?1, ?2, 1, 0)",
                    params![thread_id.as_str(), order_key],
                )
                .map_err(|error| sqlite_error(&database_path, "update", error))?;
            let changed = transaction
                .execute(
                    "UPDATE projection_metadata
                     SET rollout_file_count = rollout_file_count + 1,
                         rollout_record_count = rollout_record_count + 1
                     WHERE singleton = 1",
                    [],
                )
                .map_err(|error| sqlite_error(&database_path, "update", error))?;
            if changed != 1 {
                return Err(RolloutError::Projection(ProjectionDiagnostic {
                    path: database_path.clone(),
                    operation: "update",
                    kind: "stale",
                }));
            }
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
            let connection = self.connection.as_mut().ok_or_else(|| {
                RolloutError::Projection(ProjectionDiagnostic {
                    path: database_path.clone(),
                    operation: "update",
                    kind: "unavailable",
                })
            })?;
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| sqlite_error(&database_path, "update", error))?;
            let changed = transaction
                .execute(
                    "UPDATE threads
                     SET last_rollout_sequence = ?2
                     WHERE thread_id = ?1 AND last_rollout_sequence = ?3",
                    params![thread_id.as_str(), current_sequence, previous_sequence],
                )
                .map_err(|error| sqlite_error(&database_path, "update", error))?;
            if changed != 1 {
                return Err(RolloutError::Projection(ProjectionDiagnostic {
                    path: database_path.clone(),
                    operation: "update",
                    kind: "stale",
                }));
            }
            let changed = transaction
                .execute(
                    "UPDATE projection_metadata
                     SET rollout_record_count = rollout_record_count + 1
                     WHERE singleton = 1",
                    [],
                )
                .map_err(|error| sqlite_error(&database_path, "update", error))?;
            if changed != 1 {
                return Err(RolloutError::Projection(ProjectionDiagnostic {
                    path: database_path.clone(),
                    operation: "update",
                    kind: "stale",
                }));
            }
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
            let connection = self.connection.as_mut().ok_or_else(|| {
                RolloutError::Projection(ProjectionDiagnostic {
                    path: database_path.clone(),
                    operation: "update",
                    kind: "unavailable",
                })
            })?;
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| sqlite_error(&database_path, "update", error))?;
            let changed = transaction
                .execute(
                    "UPDATE threads
                     SET last_rollout_sequence = ?2, archived = 1
                     WHERE thread_id = ?1
                       AND last_rollout_sequence = ?3
                       AND archived = 0",
                    params![thread_id.as_str(), current_sequence, previous_sequence],
                )
                .map_err(|error| sqlite_error(&database_path, "update", error))?;
            if changed != 1 {
                return Err(RolloutError::Projection(ProjectionDiagnostic {
                    path: database_path.clone(),
                    operation: "update",
                    kind: "stale",
                }));
            }
            let changed = transaction
                .execute(
                    "UPDATE projection_metadata
                     SET rollout_record_count = rollout_record_count + 1
                     WHERE singleton = 1",
                    [],
                )
                .map_err(|error| sqlite_error(&database_path, "update", error))?;
            if changed != 1 {
                return Err(RolloutError::Projection(ProjectionDiagnostic {
                    path: database_path.clone(),
                    operation: "update",
                    kind: "stale",
                }));
            }
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
            let connection = self.connection.as_mut().ok_or_else(|| {
                RolloutError::Projection(ProjectionDiagnostic {
                    path: database_path.clone(),
                    operation: "update",
                    kind: "unavailable",
                })
            })?;
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| sqlite_error(&database_path, "update", error))?;
            let changed = transaction
                .execute(
                    "UPDATE threads
                     SET last_rollout_sequence = ?2, archived = 0
                     WHERE thread_id = ?1
                       AND last_rollout_sequence = ?3
                       AND archived = 1",
                    params![thread_id.as_str(), current_sequence, previous_sequence],
                )
                .map_err(|error| sqlite_error(&database_path, "update", error))?;
            if changed != 1 {
                return Err(RolloutError::Projection(ProjectionDiagnostic {
                    path: database_path.clone(),
                    operation: "update",
                    kind: "stale",
                }));
            }
            let changed = transaction
                .execute(
                    "UPDATE projection_metadata
                     SET rollout_record_count = rollout_record_count + 1
                     WHERE singleton = 1",
                    [],
                )
                .map_err(|error| sqlite_error(&database_path, "update", error))?;
            if changed != 1 {
                return Err(RolloutError::Projection(ProjectionDiagnostic {
                    path: database_path.clone(),
                    operation: "update",
                    kind: "stale",
                }));
            }
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

    pub(crate) fn list_threads(
        &mut self,
        source_threads: &BTreeMap<ThreadId, RolloutThreadState>,
        total_records: usize,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, RolloutError> {
        if limit == 0 || limit > 100 {
            return Err(RolloutError::InvalidRecord {
                kind: "threadListLimit",
            });
        }
        if self.dirty {
            if !self.dirty_rebuildable {
                return Err(RolloutError::Projection(
                    self.diagnostic("query", self.dirty_kind.unwrap_or("unavailable")),
                ));
            }
            self.rebuild(source_threads, total_records)?;
        }
        let cursor_key = cursor.map(thread_order_key).transpose()?;
        match self.query_page(cursor_key.as_deref(), limit) {
            Ok(page) => Ok(page),
            Err(error) if is_rebuildable_projection_error(&error) => {
                self.mark_dirty("query", projection_error_kind(&error), true);
                self.rebuild(source_threads, total_records)?;
                self.query_page(cursor_key.as_deref(), limit)
            }
            Err(error) => Err(error),
        }
    }

    fn query_page(
        &self,
        cursor_key: Option<&str>,
        limit: usize,
    ) -> Result<DurableThreadPage, RolloutError> {
        let connection = self
            .connection
            .as_ref()
            .ok_or_else(|| RolloutError::Projection(self.diagnostic("query", "unavailable")))?;
        let sql = if cursor_key.is_some() {
            "SELECT thread_id FROM threads
             WHERE archived = 0 AND thread_order_key < ?1
             ORDER BY thread_order_key DESC
             LIMIT ?2"
        } else {
            "SELECT thread_id FROM threads
             WHERE archived = 0
             ORDER BY thread_order_key DESC
             LIMIT ?1"
        };
        let mut statement = connection
            .prepare(sql)
            .map_err(|error| sqlite_error(&self.database_path, "query", error))?;
        let query_limit = i64::try_from(limit + 1).map_err(|_| RolloutError::InvalidRecord {
            kind: "threadListLimit",
        })?;
        let mut ids = Vec::with_capacity(limit + 1);
        if let Some(cursor_key) = cursor_key {
            let rows = statement
                .query_map(params![cursor_key, query_limit], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|error| sqlite_error(&self.database_path, "query", error))?;
            for row in rows {
                ids.push(row.map_err(|error| sqlite_error(&self.database_path, "query", error))?);
            }
        } else {
            let rows = statement
                .query_map(params![query_limit], |row| row.get::<_, String>(0))
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
        let result = build_database(&rebuild_path, threads, total_records);
        if let Err(error) = result {
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

    fn validate_database_entry(&self) -> Result<bool, RolloutError> {
        match fs::symlink_metadata(&self.database_path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => Err(
                RolloutError::Projection(self.diagnostic("open", "invalidPathType")),
            ),
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
                    return Err(RolloutError::Projection(ProjectionDiagnostic {
                        path,
                        operation: "open",
                        kind: "invalidPathType",
                    }));
                }
                Ok(metadata) if metadata.len() > MAX_DATABASE_BYTES => return Ok(true),
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(RolloutError::Projection(ProjectionDiagnostic {
                        path,
                        operation: "open",
                        kind: io_error_kind(&error),
                    }));
                }
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

    fn io_error(&self, operation: &'static str, error: std::io::Error) -> RolloutError {
        RolloutError::Projection(ProjectionDiagnostic {
            path: self.database_path.clone(),
            operation,
            kind: io_error_kind(&error),
        })
    }
}

enum DatabaseValidationError {
    Recoverable(&'static str),
    Fatal(RolloutError),
}

impl DatabaseValidationError {
    fn into_rollout_error(self, path: &Path) -> RolloutError {
        match self {
            Self::Recoverable(kind) => RolloutError::Projection(ProjectionDiagnostic {
                path: path.to_path_buf(),
                operation: "rebuild",
                kind,
            }),
            Self::Fatal(error) => error,
        }
    }
}

fn build_database(
    path: &Path,
    threads: &BTreeMap<ThreadId, RolloutThreadState>,
    total_records: usize,
) -> Result<(), RolloutError> {
    let mut connection =
        open_existing_database(path).map_err(|error| sqlite_error(path, "rebuild", error))?;
    connection
        .pragma_update(None, "page_size", DATABASE_PAGE_SIZE)
        .map_err(|error| sqlite_error(path, "rebuild", error))?;
    configure_connection(&connection).map_err(|error| sqlite_error(path, "rebuild", error))?;
    connection
        .pragma_update(None, "max_page_count", MAX_DATABASE_PAGES)
        .map_err(|error| sqlite_error(path, "rebuild", error))?;
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
                rollout_file_count, rollout_record_count
             ) VALUES (1, ?1, ?2, ?3, ?4)",
            params![
                CURRENT_PROJECTION_SCHEMA_VERSION,
                i64::from(CURRENT_ROLLOUT_SCHEMA_VERSION),
                bounded_i64(threads.len(), path, "rolloutFiles")?,
                bounded_i64(total_records, path, "totalReplayRecords")?,
            ],
        )
        .map_err(|error| sqlite_error(path, "rebuild", error))?;
    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO threads (
                    thread_id, thread_order_key, last_rollout_sequence, archived
                 ) VALUES (?1, ?2, ?3, ?4)",
            )
            .map_err(|error| sqlite_error(path, "rebuild", error))?;
        for state in threads.values() {
            let snapshot = &state.snapshot;
            let archived = snapshot.lifecycle == DurableThreadLifecycle::Archived;
            statement
                .execute(params![
                    snapshot.id.as_str(),
                    thread_order_key(&snapshot.id)?,
                    i64::try_from(state.last_record_sequence).map_err(|_| {
                        RolloutError::Projection(ProjectionDiagnostic {
                            path: path.to_path_buf(),
                            operation: "rebuild",
                            kind: "limitExceeded",
                        })
                    })?,
                    i64::from(archived),
                ])
                .map_err(|error| sqlite_error(path, "rebuild", error))?;
        }
    }
    transaction
        .commit()
        .map_err(|error| sqlite_error(path, "rebuild", error))?;
    let check: String = connection
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|error| sqlite_error(path, "rebuild", error))?;
    if check != "ok" {
        return Err(RolloutError::Projection(ProjectionDiagnostic {
            path: path.to_path_buf(),
            operation: "rebuild",
            kind: "integrityCheckFailed",
        }));
    }
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
    let quick_check: String =
        connection.query_row("PRAGMA quick_check(1)", [], |row| row.get(0))?;
    if quick_check != "ok" {
        return Err(rusqlite::Error::InvalidQuery);
    }
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

    let metadata = connection
        .query_row(
            "SELECT schema_version, rollout_schema_version,
                    rollout_file_count, rollout_record_count
             FROM projection_metadata WHERE singleton = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?;
    let expected = (
        CURRENT_PROJECTION_SCHEMA_VERSION,
        i64::from(CURRENT_ROLLOUT_SCHEMA_VERSION),
        threads.len() as i64,
        total_records as i64,
    );
    if metadata != Some(expected) {
        return Err(rusqlite::Error::InvalidQuery);
    }

    let mut statement = connection.prepare(
        "SELECT thread_id, thread_order_key, last_rollout_sequence, archived
         FROM threads ORDER BY thread_order_key ASC",
    )?;
    let mut rows = statement.query([])?;
    let mut count = 0usize;
    while let Some(row) = rows.next()? {
        if count >= MAX_ROLLOUT_FILES {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let thread_id: String = row.get(0)?;
        let order_key: String = row.get(1)?;
        let record_sequence: i64 = row.get(2)?;
        let archived: i64 = row.get(3)?;
        let Some(state) = threads.get(&ThreadId::new(thread_id.clone())) else {
            return Err(rusqlite::Error::InvalidQuery);
        };
        let snapshot = &state.snapshot;
        if order_key != thread_order_key(&snapshot.id).map_err(|_| rusqlite::Error::InvalidQuery)?
            || record_sequence
                != i64::try_from(state.last_record_sequence)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?
            || archived != i64::from(snapshot.lifecycle == DurableThreadLifecycle::Archived)
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        count += 1;
    }
    if count != threads.len() {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(())
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

fn precreate_database_file(path: &Path) -> Result<(), RolloutError> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map(|_| ()).map_err(|error| {
        RolloutError::Projection(ProjectionDiagnostic {
            path: path.to_path_buf(),
            operation: "rebuild",
            kind: io_error_kind(&error),
        })
    })
}

fn checked_directory(path: &Path) -> Result<PathBuf, RolloutError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err(RolloutError::Projection(ProjectionDiagnostic {
                path: path.to_path_buf(),
                operation: "open",
                kind: "invalidPathType",
            }))
        }
        Ok(_) => Ok(path.to_path_buf()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            create_directory(path)?;
            Ok(path.to_path_buf())
        }
        Err(error) => Err(RolloutError::Projection(ProjectionDiagnostic {
            path: path.to_path_buf(),
            operation: "open",
            kind: io_error_kind(&error),
        })),
    }
}

fn create_directory(path: &Path) -> Result<(), RolloutError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        builder.create(path).map_err(|error| {
            RolloutError::Projection(ProjectionDiagnostic {
                path: path.to_path_buf(),
                operation: "create",
                kind: io_error_kind(&error),
            })
        })?;
    }
    #[cfg(not(unix))]
    fs::create_dir(path).map_err(|error| {
        RolloutError::Projection(ProjectionDiagnostic {
            path: path.to_path_buf(),
            operation: "create",
            kind: io_error_kind(&error),
        })
    })?;
    sync_parent(path)
}

fn remove_regular_file_if_present(path: &Path) -> Result<(), RolloutError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(RolloutError::Projection(ProjectionDiagnostic {
                path: path.to_path_buf(),
                operation: "cleanup",
                kind: "invalidPathType",
            }))
        }
        Ok(_) => {
            fs::remove_file(path).map_err(|error| {
                RolloutError::Projection(ProjectionDiagnostic {
                    path: path.to_path_buf(),
                    operation: "cleanup",
                    kind: io_error_kind(&error),
                })
            })?;
            sync_parent(path)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(RolloutError::Projection(ProjectionDiagnostic {
            path: path.to_path_buf(),
            operation: "cleanup",
            kind: io_error_kind(&error),
        })),
    }
}

fn sync_parent(path: &Path) -> Result<(), RolloutError> {
    #[cfg(unix)]
    {
        let parent = path.parent().ok_or_else(|| {
            RolloutError::Projection(ProjectionDiagnostic {
                path: path.to_path_buf(),
                operation: "sync",
                kind: "invalidPath",
            })
        })?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| {
                RolloutError::Projection(ProjectionDiagnostic {
                    path: parent.to_path_buf(),
                    operation: "sync",
                    kind: io_error_kind(&error),
                })
            })?;
    }
    Ok(())
}

fn thread_order_key(thread_id: &ThreadId) -> Result<String, RolloutError> {
    let sequence = parse_canonical_id(thread_id.as_str(), "thr_", "thread")?;
    Ok(format!("{sequence:020}"))
}

fn sidecar_path(database_path: &Path, suffix: &str) -> PathBuf {
    let mut value = database_path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn bounded_i64(value: usize, path: &Path, kind: &'static str) -> Result<i64, RolloutError> {
    i64::try_from(value).map_err(|_| {
        RolloutError::Projection(ProjectionDiagnostic {
            path: path.to_path_buf(),
            operation: "rebuild",
            kind,
        })
    })
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
    RolloutError::Projection(ProjectionDiagnostic {
        path: path.to_path_buf(),
        operation,
        kind: match error.sqlite_error_code() {
            Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => "busy",
            Some(ErrorCode::PermissionDenied | ErrorCode::ReadOnly) => "permissionDenied",
            Some(ErrorCode::DiskFull) => "diskFull",
            Some(ErrorCode::CannotOpen) => "cannotOpen",
            Some(ErrorCode::NotADatabase) => "invalidHeader",
            Some(ErrorCode::DatabaseCorrupt) => "corrupt",
            Some(ErrorCode::SystemIoFailure | ErrorCode::FileLockingProtocolFailed) => "ioFailure",
            _ => "sqliteFailure",
        },
    })
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
