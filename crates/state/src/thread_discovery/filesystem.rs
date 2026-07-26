use super::*;

pub(super) fn precreate_database_file(path: &Path) -> Result<(), RolloutError> {
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

pub(super) fn checked_directory(path: &Path) -> Result<PathBuf, RolloutError> {
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

pub(super) fn create_directory(path: &Path) -> Result<(), RolloutError> {
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

pub(super) fn remove_regular_file_if_present(path: &Path) -> Result<(), RolloutError> {
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

pub(super) fn sync_parent(_path: &Path) -> Result<(), RolloutError> {
    #[cfg(unix)]
    {
        let path = _path;
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
