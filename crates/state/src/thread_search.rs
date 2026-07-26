use crate::DurableItemSnapshot;
use crate::DurableThreadLifecycle;
use crate::DurableThreadPage;
use crate::DurableThreadSummary;
use crate::DurableTurnStatus;
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
    DatabaseValidationError, bounded_i64, build_database, classify_validation_error,
    compile_match_query, configure_connection, item_document_id, open_existing_database,
    require_one, searchable_turn_item_count, thread_order_key, validate_projection,
};
use errors::{
    into_diagnostic, io_error_kind, is_rebuildable_projection_error, projection_error,
    projection_error_kind, sqlite_error,
};
use filesystem::{
    checked_directory, precreate_database_file, remove_regular_file_if_present, sidecar_path,
    sync_parent,
};

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
        if snapshot.turns.len() != state.turn_record_sequences.len() {
            return Err(RolloutError::InvalidRecord {
                kind: "turnRecordSequences",
            });
        }
        let order_key = thread_order_key(&snapshot.id)?;
        let last_sequence =
            i64::try_from(state.last_record_sequence).map_err(|_| RolloutError::InvalidRecord {
                kind: "projectionSequence",
            })?;
        let added_records = last_sequence;
        let added_items = snapshot.turns.iter().try_fold(0usize, |count, turn| {
            count
                .checked_add(searchable_turn_item_count(turn))
                .ok_or(RolloutError::InvalidRecord {
                    kind: "searchableItems",
                })
        })?;
        let added_items_i64 = bounded_i64(added_items, &self.database_path, "searchableItems")?;
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
                     ) VALUES (?1, ?2, ?3, 'active')",
                    params![snapshot.id.as_str(), order_key, last_sequence],
                )
                .map_err(|error| sqlite_error(&database_path, "update", error))?;
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
                for (turn, record_sequence) in
                    snapshot.turns.iter().zip(&state.turn_record_sequences)
                {
                    if turn.status != DurableTurnStatus::Completed {
                        continue;
                    }
                    let record_sequence = i64::try_from(*record_sequence).map_err(|_| {
                        RolloutError::InvalidRecord {
                            kind: "projectionSequence",
                        }
                    })?;
                    for (item_index, item) in turn.items.iter().enumerate() {
                        let DurableItemSnapshot::AgentMessage { id, text } = item else {
                            continue;
                        };
                        let document_id = item_document_id(id.as_str())?;
                        let digest = Sha256::digest(text.as_bytes());
                        document_statement
                            .execute(params![
                                document_id,
                                snapshot.id.as_str(),
                                record_sequence,
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
            }
            require_one(
                transaction
                    .execute(
                        "UPDATE projection_metadata
                         SET rollout_file_count = rollout_file_count + 1,
                             rollout_record_count = rollout_record_count + ?1,
                             searchable_item_count = searchable_item_count + ?2
                         WHERE singleton = 1
                           AND rollout_file_count < 10000
                           AND rollout_record_count + ?1 <= 1000000
                           AND searchable_item_count + ?2 <= 1000000",
                        params![added_records, added_items_i64],
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
        let added_items = searchable_turn_item_count(turn);
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
                    if turn.status != DurableTurnStatus::Completed {
                        break;
                    }
                    let DurableItemSnapshot::AgentMessage { id, text } = item else {
                        continue;
                    };
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

    pub(crate) fn record_turn_started(
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
