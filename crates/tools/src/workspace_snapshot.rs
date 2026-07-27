use crate::workspace_capability::FileSnapshot;
use crate::workspace_capability::WorkspaceReadErrorKind;
use crate::workspace_capability::map_io_error;
use crate::workspace_capability::open_regular_file_nofollow;
use cap_std::fs::Dir;
use sha2::Digest;
use sha2::Sha256;
use std::io::Read;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StableUtf8FileErrorKind {
    Read(WorkspaceReadErrorKind),
    HardLinkNotAllowed,
    FileTooLarge,
    InvalidEncoding,
    ChangedDuringRead,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct StableUtf8FileSnapshot {
    pub(crate) content: String,
    pub(crate) bytes: usize,
    pub(crate) sha256: String,
}

pub(crate) fn read_stable_utf8_file(
    directory: &Dir,
    file_name: &Path,
    max_bytes: usize,
) -> Result<StableUtf8FileSnapshot, StableUtf8FileErrorKind> {
    read_stable_utf8_file_before_reopen(directory, file_name, max_bytes, || {})
}

pub(crate) fn read_stable_utf8_file_before_reopen<F>(
    directory: &Dir,
    file_name: &Path,
    max_bytes: usize,
    before_reopen: F,
) -> Result<StableUtf8FileSnapshot, StableUtf8FileErrorKind>
where
    F: FnOnce(),
{
    let (mut file, opened_snapshot) =
        open_regular_file_nofollow(directory, file_name).map_err(map_read_error)?;
    if opened_snapshot.links() != 1 {
        return Err(StableUtf8FileErrorKind::HardLinkNotAllowed);
    }
    if opened_snapshot.len() > max_bytes as u64 {
        return Err(StableUtf8FileErrorKind::FileTooLarge);
    }

    let mut bytes = Vec::with_capacity(opened_snapshot.len() as usize);
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| map_read_error(map_io_error(&error)))?;
        if count == 0 {
            break;
        }
        if bytes
            .len()
            .checked_add(count)
            .is_none_or(|length| length > max_bytes)
        {
            return Err(StableUtf8FileErrorKind::FileTooLarge);
        }
        bytes.extend_from_slice(&buffer[..count]);
    }

    let final_metadata = file
        .metadata()
        .map_err(|error| map_read_error(map_io_error(&error)))?;
    let final_snapshot = FileSnapshot::from_file(&file, &final_metadata).map_err(map_read_error)?;
    if final_snapshot != opened_snapshot || bytes.len() as u64 != final_metadata.len() {
        return Err(StableUtf8FileErrorKind::ChangedDuringRead);
    }

    before_reopen();
    let reopened_snapshot = open_regular_file_nofollow(directory, file_name)
        .map(|(_, snapshot)| snapshot)
        .map_err(|_| StableUtf8FileErrorKind::ChangedDuringRead)?;
    if reopened_snapshot != opened_snapshot {
        return Err(StableUtf8FileErrorKind::ChangedDuringRead);
    }
    if bytes.contains(&0) {
        return Err(StableUtf8FileErrorKind::InvalidEncoding);
    }
    let content = String::from_utf8(bytes).map_err(|_| StableUtf8FileErrorKind::InvalidEncoding)?;
    Ok(StableUtf8FileSnapshot {
        bytes: content.len(),
        sha256: format!("{:x}", Sha256::digest(content.as_bytes())),
        content,
    })
}

fn map_read_error(kind: WorkspaceReadErrorKind) -> StableUtf8FileErrorKind {
    match kind {
        WorkspaceReadErrorKind::FileTooLarge => StableUtf8FileErrorKind::FileTooLarge,
        WorkspaceReadErrorKind::BinaryFile => StableUtf8FileErrorKind::InvalidEncoding,
        WorkspaceReadErrorKind::ChangedDuringRead => StableUtf8FileErrorKind::ChangedDuringRead,
        kind => StableUtf8FileErrorKind::Read(kind),
    }
}
