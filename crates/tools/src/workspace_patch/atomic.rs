use super::WorkspacePatchErrorKind;
use cap_std::fs::Dir;
use std::path::Path;
#[cfg(windows)]
use std::path::PathBuf;

#[cfg(unix)]
pub(super) fn same_device(root: &Dir, parent: &Dir) -> bool {
    use std::os::unix::fs::MetadataExt;
    let root = root.try_clone().ok().map(Dir::into_std_file);
    let parent = parent.try_clone().ok().map(Dir::into_std_file);
    matches!(
        (
            root.and_then(|file| file.metadata().ok()).map(|meta| meta.dev()),
            parent.and_then(|file| file.metadata().ok()).map(|meta| meta.dev()),
        ),
        (Some(root), Some(parent)) if root == parent
    )
}

#[cfg(unix)]
pub(super) fn same_device_file(root: &Dir, target: &std::fs::File) -> bool {
    use std::os::unix::fs::MetadataExt;
    let root = root
        .try_clone()
        .ok()
        .map(Dir::into_std_file)
        .and_then(|file| file.metadata().ok())
        .map(|metadata| metadata.dev());
    let target = target.metadata().ok().map(|metadata| metadata.dev());
    matches!((root, target), (Some(root), Some(target)) if root == target)
}

#[cfg(windows)]
pub(super) fn same_device(root: &Dir, parent: &Dir) -> bool {
    matches!(
        (volume_serial(root), volume_serial(parent)),
        (Some(root), Some(parent)) if root == parent
    )
}

#[cfg(windows)]
pub(super) fn same_device_file(root: &Dir, target: &std::fs::File) -> bool {
    matches!(
        (volume_serial(root), file_volume_serial(target)),
        (Some(root), Some(target)) if root == target
    )
}

#[cfg(not(any(unix, windows)))]
pub(super) fn same_device(_root: &Dir, _parent: &Dir) -> bool {
    true
}

#[cfg(not(any(unix, windows)))]
pub(super) fn same_device_file(_root: &Dir, _target: &std::fs::File) -> bool {
    true
}

#[cfg(unix)]
pub(super) fn atomic_replace(
    root: &Dir,
    temp_name: &Path,
    parent: &Dir,
    file_name: &Path,
) -> Result<(), WorkspacePatchErrorKind> {
    use std::ffi::CString;
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    let temp = CString::new(temp_name.as_os_str().as_bytes())
        .map_err(|_| WorkspacePatchErrorKind::InvalidPath)?;
    let target = CString::new(file_name.as_os_str().as_bytes())
        .map_err(|_| WorkspacePatchErrorKind::InvalidPath)?;
    // SAFETY: both directory descriptors and NUL-terminated relative names are valid.
    if unsafe {
        libc::renameat(
            root.as_raw_fd(),
            temp.as_ptr(),
            parent.as_raw_fd(),
            target.as_ptr(),
        )
    } != 0
    {
        return Err(WorkspacePatchErrorKind::AtomicReplaceUnavailable);
    }
    root.try_clone()
        .map(Dir::into_std_file)
        .and_then(|file| file.sync_all())
        .map_err(|_| WorkspacePatchErrorKind::AtomicReplaceUnavailable)?;
    parent
        .try_clone()
        .map(Dir::into_std_file)
        .and_then(|file| file.sync_all())
        .map_err(|_| WorkspacePatchErrorKind::AtomicReplaceUnavailable)
}

#[cfg(windows)]
pub(super) fn atomic_replace(
    root: &Dir,
    temp_name: &Path,
    parent: &Dir,
    file_name: &Path,
) -> Result<(), WorkspacePatchErrorKind> {
    use windows_sys::Win32::Storage::FileSystem::REPLACEFILE_WRITE_THROUGH;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    let root_path = directory_final_path(root)?;
    let parent_path = directory_final_path(parent)?;
    let replacement = wide_path(&root_path.join(temp_name));
    let replaced = wide_path(&parent_path.join(file_name));
    // SAFETY: both path buffers are NUL-terminated for the duration of the call.
    let result = unsafe {
        ReplaceFileW(
            replaced.as_ptr(),
            replacement.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if result == 0 {
        Err(WorkspacePatchErrorKind::AtomicReplaceUnavailable)
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn volume_serial(directory: &Dir) -> Option<u32> {
    let file = directory.try_clone().ok()?.into_std_file();
    file_volume_serial(&file)
}

#[cfg(windows)]
fn file_volume_serial(file: &std::fs::File) -> Option<u32> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION;
    use windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandle;
    let mut information = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
    // SAFETY: the handle and output buffer are valid.
    let result = unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) };
    (result != 0).then_some(information.dwVolumeSerialNumber)
}

#[cfg(windows)]
fn directory_final_path(directory: &Dir) -> Result<PathBuf, WorkspacePatchErrorKind> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::FILE_NAME_NORMALIZED;
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    use windows_sys::Win32::Storage::FileSystem::VOLUME_NAME_DOS;
    let file = directory
        .try_clone()
        .map_err(|_| WorkspacePatchErrorKind::Unavailable)?
        .into_std_file();
    let flags = FILE_NAME_NORMALIZED | VOLUME_NAME_DOS;
    // SAFETY: querying the required buffer length uses a valid handle and null buffer.
    let length = unsafe {
        GetFinalPathNameByHandleW(file.as_raw_handle() as _, std::ptr::null_mut(), 0, flags)
    };
    if length == 0 {
        return Err(WorkspacePatchErrorKind::Unavailable);
    }
    let mut buffer = vec![0u16; length as usize + 1];
    // SAFETY: the buffer is writable and sized from the preceding query.
    let written = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle() as _,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            flags,
        )
    };
    if written == 0 || written as usize >= buffer.len() {
        return Err(WorkspacePatchErrorKind::Unavailable);
    }
    buffer.truncate(written as usize);
    Ok(PathBuf::from(std::ffi::OsString::from_wide(&buffer)))
}

#[cfg(windows)]
fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(not(any(unix, windows)))]
pub(super) fn atomic_replace(
    root: &Dir,
    temp_name: &Path,
    parent: &Dir,
    file_name: &Path,
) -> Result<(), WorkspacePatchErrorKind> {
    root.rename(temp_name, parent, file_name)
        .map_err(|_| WorkspacePatchErrorKind::AtomicReplaceUnavailable)
}
