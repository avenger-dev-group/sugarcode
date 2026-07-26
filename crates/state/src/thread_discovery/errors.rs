use super::*;

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

pub(super) fn sqlite_error(
    path: &Path,
    operation: &'static str,
    error: rusqlite::Error,
) -> RolloutError {
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

pub(super) fn io_error_kind(error: &std::io::Error) -> &'static str {
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

pub(super) fn projection_error_kind(error: &RolloutError) -> &'static str {
    match error {
        RolloutError::Projection(diagnostic) => diagnostic.kind,
        _ => "projectionFailure",
    }
}

pub(super) fn is_rebuildable_projection_error(error: &RolloutError) -> bool {
    matches!(
        error,
        RolloutError::Projection(ProjectionDiagnostic {
            kind: "invalidHeader" | "corrupt" | "sqliteFailure" | "stale" | "projectionFailure",
            ..
        })
    )
}
