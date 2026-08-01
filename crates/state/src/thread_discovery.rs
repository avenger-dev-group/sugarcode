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
#[cfg(unix)]
use std::fs::File;
use std::fs::OpenOptions;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use sugarcode_protocol::ThreadId;

mod database;
mod errors;
mod filesystem;

use database::{
    DatabaseValidationError, build_database, configure_connection, open_existing_database,
    sidecar_path, thread_order_key, validate_projection,
};
use errors::{
    classify_validation_error, io_error_kind, is_rebuildable_projection_error,
    projection_error_kind, sqlite_error,
};
use filesystem::{
    checked_directory, precreate_database_file, remove_regular_file_if_present, sync_parent,
};

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
                        thread_id, thread_order_key, last_rollout_sequence, lifecycle
                    ) VALUES (?1, ?2, 1, 'active')",
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

    pub(crate) fn record_thread_snapshot(
        &mut self,
        state: &RolloutThreadState,
    ) -> Result<(), RolloutError> {
        if self.dirty {
            return Ok(());
        }
        let snapshot = &state.snapshot;
        if snapshot.lifecycle != DurableThreadLifecycle::Active {
            return Err(RolloutError::InvalidRecord {
                kind: "materializedThreadNotActive",
            });
        }
        let order_key = thread_order_key(&snapshot.id)?;
        let last_sequence =
            i64::try_from(state.last_record_sequence).map_err(|_| RolloutError::InvalidRecord {
                kind: "projectionSequence",
            })?;
        let added_records = last_sequence;
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
                        thread_id, thread_order_key, last_rollout_sequence, lifecycle
                    ) VALUES (?1, ?2, ?3, 'active')",
                    params![snapshot.id.as_str(), order_key, last_sequence],
                )
                .map_err(|error| sqlite_error(&database_path, "update", error))?;
            let changed = transaction
                .execute(
                    "UPDATE projection_metadata
                     SET rollout_file_count = rollout_file_count + 1,
                         rollout_record_count = rollout_record_count + ?1
                     WHERE singleton = 1
                       AND rollout_file_count < 10000
                       AND rollout_record_count + ?1 <= 1000000",
                    params![added_records],
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
                     WHERE thread_id = ?1
                       AND last_rollout_sequence = ?3
                       AND lifecycle = 'active'",
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
                     SET last_rollout_sequence = ?2, lifecycle = 'archived'
                     WHERE thread_id = ?1
                       AND last_rollout_sequence = ?3
                       AND lifecycle = 'active'",
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
                     SET last_rollout_sequence = ?2, lifecycle = 'active'
                     WHERE thread_id = ?1
                       AND last_rollout_sequence = ?3
                       AND lifecycle = 'archived'",
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
                     SET last_rollout_sequence = ?2, lifecycle = 'deleted'
                     WHERE thread_id = ?1
                       AND last_rollout_sequence = ?3
                       AND lifecycle IN ('active', 'archived')",
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
             WHERE lifecycle = 'active' AND thread_order_key < ?1
             ORDER BY thread_order_key DESC
             LIMIT ?2"
        } else {
            "SELECT thread_id FROM threads
             WHERE lifecycle = 'active'
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
                    title: None,
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
