use super::*;

pub(super) enum DatabaseValidationError {
    Recoverable(&'static str),
    Fatal(RolloutError),
}

impl DatabaseValidationError {
    pub(super) fn into_rollout_error(self, path: &Path) -> RolloutError {
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

pub(super) fn build_database(
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
                    thread_id, thread_order_key, last_rollout_sequence, lifecycle
                 ) VALUES (?1, ?2, ?3, ?4)",
            )
            .map_err(|error| sqlite_error(path, "rebuild", error))?;
        for state in threads.values() {
            let snapshot = &state.snapshot;
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
                    lifecycle_name(snapshot.lifecycle),
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

pub(super) fn validate_projection(
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
        "SELECT thread_id, thread_order_key, last_rollout_sequence, lifecycle
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
        let lifecycle: String = row.get(3)?;
        let Some(state) = threads.get(&ThreadId::new(thread_id.clone())) else {
            return Err(rusqlite::Error::InvalidQuery);
        };
        let snapshot = &state.snapshot;
        if order_key != thread_order_key(&snapshot.id).map_err(|_| rusqlite::Error::InvalidQuery)?
            || record_sequence
                != i64::try_from(state.last_record_sequence)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?
            || lifecycle != lifecycle_name(snapshot.lifecycle)
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

pub(super) fn lifecycle_name(lifecycle: DurableThreadLifecycle) -> &'static str {
    match lifecycle {
        DurableThreadLifecycle::Active => "active",
        DurableThreadLifecycle::Archived => "archived",
        DurableThreadLifecycle::Deleted => "deleted",
    }
}

pub(super) fn sidecar_path(database_path: &Path, suffix: &str) -> PathBuf {
    let mut value = database_path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

pub(super) fn bounded_i64(
    value: usize,
    path: &Path,
    kind: &'static str,
) -> Result<i64, RolloutError> {
    i64::try_from(value).map_err(|_| {
        RolloutError::Projection(ProjectionDiagnostic {
            path: path.to_path_buf(),
            operation: "rebuild",
            kind,
        })
    })
}
