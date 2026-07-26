use super::*;

pub(super) fn checked_directory(path: &Path) -> Result<PathBuf, RolloutError> {
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

pub(super) fn create_directory(path: &Path) -> Result<(), RolloutError> {
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

pub(super) fn precreate_database_file(path: &Path) -> Result<(), RolloutError> {
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

pub(super) fn remove_regular_file_if_present(path: &Path) -> Result<(), RolloutError> {
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

pub(super) fn sync_parent(_path: &Path) -> Result<(), RolloutError> {
    #[cfg(unix)]
    {
        let path = _path;
        let parent = path
            .parent()
            .ok_or_else(|| projection_error(path, "sync", "invalidPath"))?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| projection_error(parent, "sync", io_error_kind(&error)))?;
    }
    Ok(())
}

pub(super) fn sidecar_path(database_path: &Path, suffix: &str) -> PathBuf {
    let mut value = database_path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}
