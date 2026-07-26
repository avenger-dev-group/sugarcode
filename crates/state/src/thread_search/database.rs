use super::*;

pub(super) enum DatabaseValidationError {
    Recoverable(&'static str),
    Fatal(RolloutError),
}

impl DatabaseValidationError {
    pub(super) fn into_rollout_error(self, path: &Path) -> RolloutError {
        match self {
            Self::Recoverable(kind) => projection_error(path, "rebuild", kind),
            Self::Fatal(error) => error,
        }
    }
}

pub(super) fn build_database(
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
            if turn.status != DurableTurnStatus::Completed {
                continue;
            }
            let rollout_sequence = i64::try_from(*record_sequence)
                .map_err(|_| projection_error(path, "rebuild", "rolloutRecordLimit"))?;
            for (item_index, item) in turn.items.iter().enumerate() {
                let DurableItemSnapshot::AgentMessage { id, text } = item else {
                    continue;
                };
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

pub(super) fn validate_projection(
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
            if turn.status != DurableTurnStatus::Completed {
                continue;
            }
            for (item_index, item) in turn.items.iter().enumerate() {
                let DurableItemSnapshot::AgentMessage { id, text } = item else {
                    continue;
                };
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
        .try_fold(0usize, |count, turn| {
            count.checked_add(searchable_turn_item_count(turn))
        })
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

pub(super) fn searchable_turn_item_count(turn: &crate::DurableTurnSnapshot) -> usize {
    if turn.status != DurableTurnStatus::Completed {
        return 0;
    }
    turn.items
        .iter()
        .filter(|item| matches!(item, DurableItemSnapshot::AgentMessage { .. }))
        .count()
}

pub(super) fn compile_match_query(query: &str) -> Result<String, RolloutError> {
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

pub(super) fn configure_connection(connection: &Connection) -> rusqlite::Result<()> {
    connection.busy_timeout(Duration::ZERO)?;
    connection.pragma_update(None, "journal_mode", "DELETE")?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "trusted_schema", "OFF")?;
    connection.pragma_update(None, "max_page_count", MAX_DATABASE_PAGES)?;
    Ok(())
}

pub(super) fn open_existing_database(path: &Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
}

pub(super) fn thread_order_key(thread_id: &ThreadId) -> Result<String, RolloutError> {
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

pub(super) fn item_document_id(item_id: &str) -> Result<i64, RolloutError> {
    let sequence = parse_canonical_id(item_id, "item_", "item")?;
    i64::try_from(sequence).map_err(|_| RolloutError::InvalidRecord {
        kind: "searchDocumentId",
    })
}

pub(super) fn bounded_i64(
    value: usize,
    path: &Path,
    kind: &'static str,
) -> Result<i64, RolloutError> {
    i64::try_from(value).map_err(|_| projection_error(path, "rebuild", kind))
}

pub(super) fn require_one(
    changed: usize,
    path: &Path,
    operation: &'static str,
) -> Result<(), RolloutError> {
    if changed == 1 {
        Ok(())
    } else {
        Err(projection_error(path, operation, "stale"))
    }
}

pub(super) fn classify_validation_error(
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
