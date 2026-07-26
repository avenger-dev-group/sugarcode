use super::WorkspacePatchErrorKind;
use super::map_read_error;
use crate::workspace_capability::FileSnapshot;
use crate::workspace_capability::classify_component_open_error;
use crate::workspace_capability::map_io_error;
use crate::workspace_capability::open_regular_file_nofollow;
use crate::workspace_capability::validate_directory_handle;
use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use cap_std::fs::OpenOptions;
use sha2::Digest;
use sha2::Sha256;
use std::fs::File;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use tokio_util::sync::CancellationToken;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub(super) fn resolve_parent(
    root: &Dir,
    parents: &[PathBuf],
    cancellation: &CancellationToken,
) -> Result<Dir, WorkspacePatchErrorKind> {
    let mut directory = root
        .try_clone()
        .map_err(|_| WorkspacePatchErrorKind::Unavailable)?;
    for component in parents {
        if cancellation.is_cancelled() {
            return Err(WorkspacePatchErrorKind::Cancelled);
        }
        directory = directory.open_dir_nofollow(component).map_err(|error| {
            map_read_error(classify_component_open_error(&directory, component, &error))
        })?;
        validate_directory_handle(&directory).map_err(map_read_error)?;
    }
    Ok(directory)
}

pub(super) fn verify_original(
    parent: &Dir,
    file_name: &Path,
    original: &mut File,
    snapshot: FileSnapshot,
    expected_hash: &str,
) -> Result<(), ()> {
    let metadata = original.metadata().map_err(|_| ())?;
    let now = FileSnapshot::from_file(original, &metadata).map_err(|_| ())?;
    if now != snapshot || now.links() != 1 {
        return Err(());
    }
    original.seek(SeekFrom::Start(0)).map_err(|_| ())?;
    let mut bytes = Vec::with_capacity(snapshot.len() as usize);
    original.read_to_end(&mut bytes).map_err(|_| ())?;
    if bytes.len() as u64 != snapshot.len() || sha256(&bytes) != expected_hash {
        return Err(());
    }
    let (_, reopened) = open_regular_file_nofollow(parent, file_name).map_err(|_| ())?;
    if reopened != snapshot || reopened.links() != 1 {
        return Err(());
    }
    Ok(())
}

pub(super) fn create_temp(
    root: &Dir,
    bytes: &[u8],
    _original: &File,
) -> Result<PathBuf, WorkspacePatchErrorKind> {
    for _ in 0..32 {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let name = PathBuf::from(format!(
            ".sugarcode-apply-patch-{}-{sequence:016x}.tmp",
            std::process::id()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use cap_fs_ext::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = match root.open_with(&name, &options) {
            Ok(file) => file.into_std(),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(map_read_error(map_io_error(&error))),
        };
        if file.write_all(bytes).is_err() || file.sync_all().is_err() {
            let _ = root.remove_file(&name);
            return Err(WorkspacePatchErrorKind::Unavailable);
        }
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            use std::os::unix::fs::MetadataExt;
            use std::os::unix::fs::PermissionsExt;
            let metadata = _original
                .metadata()
                .map_err(|_| WorkspacePatchErrorKind::Unavailable)?;
            // SAFETY: the descriptor belongs to the open temporary file and
            // the uid/gid values came from the verified original metadata.
            if unsafe { libc::fchown(file.as_raw_fd(), metadata.uid(), metadata.gid()) } != 0 {
                let _ = root.remove_file(&name);
                return Err(WorkspacePatchErrorKind::Unavailable);
            }
            file.set_permissions(std::fs::Permissions::from_mode(metadata.mode()))
                .map_err(|_| WorkspacePatchErrorKind::Unavailable)?;
            file.sync_all()
                .map_err(|_| WorkspacePatchErrorKind::Unavailable)?;
        }
        return Ok(name);
    }
    Err(WorkspacePatchErrorKind::Unavailable)
}

pub(super) fn target_matches(parent: &Dir, file_name: &Path, hash: &str, len: u64) -> bool {
    let Ok((mut file, snapshot)) = open_regular_file_nofollow(parent, file_name) else {
        return false;
    };
    if snapshot.len() != len || snapshot.links() != 1 {
        return false;
    }
    let mut bytes = Vec::with_capacity(len as usize);
    file.read_to_end(&mut bytes).is_ok()
        && bytes.len() as u64 == len
        && sha256(&bytes) == hash
        && file.sync_all().is_ok()
}

pub(super) fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
