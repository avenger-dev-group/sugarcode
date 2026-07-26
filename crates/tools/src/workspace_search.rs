use crate::workspace_list::MAX_WORKSPACE_LIST_ENTRIES;
use crate::workspace_list::WorkspaceListErrorKind;
use crate::workspace_list::cap_metadata_is_reparse_point;
use crate::workspace_list::classify_directory_open_error;
use crate::workspace_list::map_iteration_error;
use crate::workspace_list::validate_list_path;
use crate::workspace_read::FileSnapshot;
use crate::workspace_read::READ_CHUNK_BYTES;
use crate::workspace_read::WorkspaceReadErrorKind;
use crate::workspace_read::WorkspaceTool;
use crate::workspace_read::map_io_error;
use crate::workspace_read::open_regular_file_nofollow;
use crate::workspace_read::open_root_nofollow;
use crate::workspace_read::validate_directory_handle;
use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use std::fmt;
use std::future::Future;
use std::io::Read;
use std::path::PathBuf;
use std::pin::Pin;
use std::time::Duration;
use std::time::Instant;
use tokio_util::sync::CancellationToken;

pub const MAX_WORKSPACE_SEARCH_QUERY_BYTES: usize = 256;
pub const MAX_WORKSPACE_SEARCH_DEPTH: usize = 32;
pub const MAX_WORKSPACE_SEARCH_DIRECTORIES: usize = 1_024;
pub const MAX_WORKSPACE_SEARCH_OBSERVED_ENTRIES: usize = 20_000;
pub const MAX_WORKSPACE_SEARCH_CANDIDATE_FILES: usize = 10_000;
pub const MAX_WORKSPACE_SEARCH_TOTAL_READ_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_WORKSPACE_SEARCH_MATCHES: usize = 200;
const MAX_WORKSPACE_SEARCH_PATH_BYTES: usize = 1_024;
const MAX_WORKSPACE_SEARCH_RESULT_PATH_BYTES: usize = 256 * 1_024;
const WORKSPACE_SEARCH_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceSearchArguments {
    pub path: String,
    pub query: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceSearchMatch {
    pub path: String,
    pub line: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceSearchErrorKind {
    InvalidPath,
    InvalidQuery,
    NotFound,
    AccessDenied,
    PathNotAllowed,
    NotDirectory,
    InvalidEncoding,
    InvalidName,
    TooManyEntries,
    SearchLimitExceeded,
    SearchTimedOut,
    ChangedDuringSearch,
    ResultTooLarge,
    Cancelled,
    Unavailable,
}

#[derive(Clone, PartialEq, Eq)]
pub enum WorkspaceSearchOutcome {
    Matches {
        matches: Vec<WorkspaceSearchMatch>,
        truncated: bool,
    },
    Error {
        kind: WorkspaceSearchErrorKind,
    },
}

impl fmt::Debug for WorkspaceSearchOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Matches { matches, truncated } => formatter
                .debug_struct("Matches")
                .field("match_count", &matches.len())
                .field("truncated", truncated)
                .finish(),
            Self::Error { kind } => formatter.debug_struct("Error").field("kind", kind).finish(),
        }
    }
}

pub trait WorkspaceSearchExecutor: fmt::Debug + Send + Sync {
    fn search<'a>(
        &'a self,
        arguments: &'a WorkspaceSearchArguments,
        cancellation: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = WorkspaceSearchOutcome> + Send + 'a>>;
}

struct SearchEntry {
    name: String,
    kind: SearchEntryKind,
}

enum SearchEntryKind {
    File,
    Directory,
    Skip,
}

struct DirectoryFrame {
    directory: Dir,
    parent: Option<Dir>,
    target_name: Option<PathBuf>,
    root_path: Option<PathBuf>,
    relative_path: String,
    depth: usize,
    opened_snapshot: FileSnapshot,
    entries: Vec<SearchEntry>,
    next_entry: usize,
}

struct DirectoryFrameSeed {
    directory: Dir,
    parent: Option<Dir>,
    target_name: Option<PathBuf>,
    root_path: Option<PathBuf>,
    relative_path: String,
    depth: usize,
}

struct SearchState {
    started: Instant,
    deadline: Duration,
    directories: usize,
    observed_entries: usize,
    candidate_files: usize,
    read_bytes: usize,
    result_path_bytes: usize,
    matches: Vec<WorkspaceSearchMatch>,
    truncated: bool,
}

impl SearchState {
    fn new(deadline: Duration) -> Self {
        Self {
            started: Instant::now(),
            deadline,
            directories: 0,
            observed_entries: 0,
            candidate_files: 0,
            read_bytes: 0,
            result_path_bytes: 0,
            matches: Vec::new(),
            truncated: false,
        }
    }

    fn checkpoint(&self, cancellation: &CancellationToken) -> Result<(), WorkspaceSearchErrorKind> {
        if cancellation.is_cancelled() {
            Err(WorkspaceSearchErrorKind::Cancelled)
        } else if self.started.elapsed() >= self.deadline {
            Err(WorkspaceSearchErrorKind::SearchTimedOut)
        } else {
            Ok(())
        }
    }
}

impl WorkspaceTool {
    pub async fn search(
        &self,
        arguments: &WorkspaceSearchArguments,
        cancellation: &CancellationToken,
    ) -> WorkspaceSearchOutcome {
        self.search_with_before_file_identity_check(
            arguments,
            cancellation,
            WORKSPACE_SEARCH_DEADLINE,
            Option::<fn()>::None,
        )
        .await
    }

    async fn search_with_before_file_identity_check<F>(
        &self,
        arguments: &WorkspaceSearchArguments,
        cancellation: &CancellationToken,
        deadline: Duration,
        mut before_file_identity_check: Option<F>,
    ) -> WorkspaceSearchOutcome
    where
        F: FnOnce(),
    {
        let mut state = SearchState::new(deadline);
        if cancellation.is_cancelled() {
            return error(WorkspaceSearchErrorKind::Cancelled);
        }
        if let Err(kind) = validate_query(&arguments.query) {
            return error(kind);
        }
        let components = match validate_list_path(&arguments.path) {
            Ok(components) => components,
            Err(kind) => return error(map_list_error(kind)),
        };
        let mut directory = match self.root.try_clone() {
            Ok(directory) => directory,
            Err(error_value) => return error(map_search_io_error(&error_value)),
        };
        let mut parent = None;
        let mut target_name = None;
        for component in &components {
            if let Err(kind) = state.checkpoint(cancellation) {
                return error(kind);
            }
            let next = match directory.open_dir_nofollow(component) {
                Ok(next) => next,
                Err(error_value) => {
                    return error(map_list_error(classify_directory_open_error(
                        &directory,
                        component,
                        &error_value,
                    )));
                }
            };
            if let Err(kind) = validate_directory_handle(&next) {
                return error(map_read_error(kind));
            }
            parent = Some(directory);
            target_name = Some(component.clone());
            directory = next;
        }

        let relative_path = components
            .iter()
            .map(|component| component.to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let root_frame = match build_directory_frame(
            DirectoryFrameSeed {
                directory,
                parent,
                target_name,
                root_path: components.is_empty().then(|| self.root_path.clone()),
                relative_path,
                depth: 0,
            },
            &mut state,
            cancellation,
        )
        .await
        {
            Ok(frame) => frame,
            Err(kind) => return error(kind),
        };
        let mut stack = vec![root_frame];

        while let Some(frame) = stack.last_mut() {
            if let Err(kind) = state.checkpoint(cancellation) {
                return error(kind);
            }
            if state.truncated || frame.next_entry >= frame.entries.len() {
                let frame = stack.pop().expect("non-empty stack");
                if let Err(kind) = verify_directory_frame(&frame) {
                    return error(kind);
                }
                continue;
            }

            let entry = &frame.entries[frame.next_entry];
            frame.next_entry += 1;
            let relative_path = join_workspace_path(&frame.relative_path, &entry.name);
            match entry.kind {
                SearchEntryKind::Skip => {}
                SearchEntryKind::Directory => {
                    if frame.depth >= MAX_WORKSPACE_SEARCH_DEPTH {
                        return error(WorkspaceSearchErrorKind::SearchLimitExceeded);
                    }
                    let child = match frame.directory.open_dir_nofollow(&entry.name) {
                        Ok(child) => child,
                        Err(error_value) => {
                            return error(map_child_directory_open_error(
                                &frame.directory,
                                &entry.name,
                                &error_value,
                            ));
                        }
                    };
                    if validate_directory_handle(&child).is_err() {
                        return error(WorkspaceSearchErrorKind::ChangedDuringSearch);
                    }
                    let parent = match frame.directory.try_clone() {
                        Ok(parent) => parent,
                        Err(error_value) => return error(map_search_io_error(&error_value)),
                    };
                    let child_frame = match build_directory_frame(
                        DirectoryFrameSeed {
                            directory: child,
                            parent: Some(parent),
                            target_name: Some(PathBuf::from(&entry.name)),
                            root_path: None,
                            relative_path,
                            depth: frame.depth + 1,
                        },
                        &mut state,
                        cancellation,
                    )
                    .await
                    {
                        Ok(child_frame) => child_frame,
                        Err(kind) => return error(kind),
                    };
                    stack.push(child_frame);
                }
                SearchEntryKind::File => {
                    state.candidate_files += 1;
                    if state.candidate_files > MAX_WORKSPACE_SEARCH_CANDIDATE_FILES {
                        return error(WorkspaceSearchErrorKind::SearchLimitExceeded);
                    }
                    match search_file(
                        &frame.directory,
                        &entry.name,
                        &relative_path,
                        &arguments.query,
                        &mut state,
                        cancellation,
                        &mut before_file_identity_check,
                    )
                    .await
                    {
                        Ok(()) => {}
                        Err(kind) => return error(kind),
                    }
                }
            }
            tokio::task::yield_now().await;
        }

        state.matches.sort_unstable_by(|left, right| {
            left.path
                .as_bytes()
                .cmp(right.path.as_bytes())
                .then_with(|| left.line.cmp(&right.line))
        });
        WorkspaceSearchOutcome::Matches {
            matches: state.matches,
            truncated: state.truncated,
        }
    }
}

impl WorkspaceSearchExecutor for WorkspaceTool {
    fn search<'a>(
        &'a self,
        arguments: &'a WorkspaceSearchArguments,
        cancellation: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = WorkspaceSearchOutcome> + Send + 'a>> {
        Box::pin(WorkspaceTool::search(self, arguments, cancellation))
    }
}

async fn build_directory_frame(
    seed: DirectoryFrameSeed,
    state: &mut SearchState,
    cancellation: &CancellationToken,
) -> Result<DirectoryFrame, WorkspaceSearchErrorKind> {
    let DirectoryFrameSeed {
        directory,
        parent,
        target_name,
        root_path,
        relative_path,
        depth,
    } = seed;
    state.directories += 1;
    if state.directories > MAX_WORKSPACE_SEARCH_DIRECTORIES {
        return Err(WorkspaceSearchErrorKind::SearchLimitExceeded);
    }
    state.checkpoint(cancellation)?;
    let opened_snapshot = FileSnapshot::from_directory(&directory).map_err(map_read_error)?;
    let mut read_dir = directory
        .entries()
        .map_err(|error_value| map_search_io_error(&error_value))?;
    let mut entries = Vec::new();
    for entry in &mut read_dir {
        state.checkpoint(cancellation)?;
        let entry =
            entry.map_err(|error_value| map_list_error(map_iteration_error(&error_value)))?;
        if entries.len() >= MAX_WORKSPACE_LIST_ENTRIES {
            return Err(WorkspaceSearchErrorKind::TooManyEntries);
        }
        state.observed_entries += 1;
        if state.observed_entries > MAX_WORKSPACE_SEARCH_OBSERVED_ENTRIES {
            return Err(WorkspaceSearchErrorKind::SearchLimitExceeded);
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| WorkspaceSearchErrorKind::InvalidEncoding)?;
        if name.is_empty()
            || name.len() > MAX_WORKSPACE_SEARCH_PATH_BYTES
            || name.chars().any(char::is_control)
        {
            return Err(WorkspaceSearchErrorKind::InvalidName);
        }
        let kind = if name.as_bytes().first() == Some(&b'.') {
            SearchEntryKind::Skip
        } else {
            let metadata = directory
                .symlink_metadata(&name)
                .map_err(|error_value| map_list_error(map_iteration_error(&error_value)))?;
            let file_type = metadata.file_type();
            if file_type.is_symlink() || cap_metadata_is_reparse_point(&metadata) {
                SearchEntryKind::Skip
            } else if file_type.is_dir() {
                SearchEntryKind::Directory
            } else if file_type.is_file() {
                SearchEntryKind::File
            } else {
                SearchEntryKind::Skip
            }
        };
        entries.push(SearchEntry { name, kind });
        tokio::task::yield_now().await;
    }
    entries.sort_unstable_by(compare_search_entries);
    Ok(DirectoryFrame {
        directory,
        parent,
        target_name,
        root_path,
        relative_path,
        depth,
        opened_snapshot,
        entries,
        next_entry: 0,
    })
}

async fn search_file<F>(
    directory: &Dir,
    file_name: &str,
    relative_path: &str,
    query: &str,
    state: &mut SearchState,
    cancellation: &CancellationToken,
    before_file_identity_check: &mut Option<F>,
) -> Result<(), WorkspaceSearchErrorKind>
where
    F: FnOnce(),
{
    if relative_path.len() > MAX_WORKSPACE_SEARCH_PATH_BYTES {
        return Err(WorkspaceSearchErrorKind::ResultTooLarge);
    }
    let (mut file, opened_snapshot) =
        match open_regular_file_nofollow(directory, file_name.as_ref()) {
            Ok(opened) => opened,
            Err(WorkspaceReadErrorKind::FileTooLarge) => return Ok(()),
            Err(WorkspaceReadErrorKind::AccessDenied) => {
                return Err(WorkspaceSearchErrorKind::AccessDenied);
            }
            Err(
                WorkspaceReadErrorKind::NotFound
                | WorkspaceReadErrorKind::PathNotAllowed
                | WorkspaceReadErrorKind::NotRegularFile,
            ) => return Err(WorkspaceSearchErrorKind::ChangedDuringSearch),
            Err(kind) => return Err(map_read_error(kind)),
        };
    if state
        .read_bytes
        .checked_add(opened_snapshot.len() as usize)
        .is_none_or(|bytes| bytes > MAX_WORKSPACE_SEARCH_TOTAL_READ_BYTES)
    {
        return Err(WorkspaceSearchErrorKind::SearchLimitExceeded);
    }

    let mut bytes = Vec::with_capacity(opened_snapshot.len() as usize);
    let mut buffer = [0u8; READ_CHUNK_BYTES];
    loop {
        state.checkpoint(cancellation)?;
        let count = file
            .read(&mut buffer)
            .map_err(|error_value| map_search_io_error(&error_value))?;
        if count == 0 {
            break;
        }
        if bytes
            .len()
            .checked_add(count)
            .is_none_or(|length| length > crate::MAX_WORKSPACE_READ_BYTES)
        {
            return Ok(());
        }
        bytes.extend_from_slice(&buffer[..count]);
        tokio::task::yield_now().await;
    }
    let final_metadata = file
        .metadata()
        .map_err(|error_value| map_search_io_error(&error_value))?;
    let final_snapshot = FileSnapshot::from_file(&file, &final_metadata).map_err(map_read_error)?;
    if final_snapshot != opened_snapshot || bytes.len() as u64 != final_metadata.len() {
        return Err(WorkspaceSearchErrorKind::ChangedDuringSearch);
    }
    if let Some(hook) = before_file_identity_check.take() {
        hook();
    }
    let reopened_snapshot = open_regular_file_nofollow(directory, file_name.as_ref())
        .map(|(_, snapshot)| snapshot)
        .map_err(|_| WorkspaceSearchErrorKind::ChangedDuringSearch)?;
    if reopened_snapshot != opened_snapshot {
        return Err(WorkspaceSearchErrorKind::ChangedDuringSearch);
    }
    state.read_bytes += bytes.len();
    if bytes.contains(&0) {
        return Ok(());
    }
    let Ok(content) = String::from_utf8(bytes) else {
        return Ok(());
    };
    for (line_index, line) in content.split('\n').enumerate() {
        if line.contains(query) {
            if state.matches.len() == MAX_WORKSPACE_SEARCH_MATCHES {
                state.truncated = true;
                break;
            }
            state.result_path_bytes = state
                .result_path_bytes
                .checked_add(relative_path.len())
                .ok_or(WorkspaceSearchErrorKind::ResultTooLarge)?;
            if state.result_path_bytes > MAX_WORKSPACE_SEARCH_RESULT_PATH_BYTES {
                return Err(WorkspaceSearchErrorKind::ResultTooLarge);
            }
            state.matches.push(WorkspaceSearchMatch {
                path: relative_path.to_string(),
                line: line_index + 1,
            });
        }
    }
    Ok(())
}

fn verify_directory_frame(frame: &DirectoryFrame) -> Result<(), WorkspaceSearchErrorKind> {
    let final_snapshot = FileSnapshot::from_directory(&frame.directory)
        .map_err(|_| WorkspaceSearchErrorKind::ChangedDuringSearch)?;
    let reopened = match (frame.parent.as_ref(), frame.target_name.as_ref()) {
        (Some(parent), Some(target_name)) => parent
            .open_dir_nofollow(target_name)
            .map_err(|_| WorkspaceSearchErrorKind::ChangedDuringSearch)?,
        (None, None) => open_root_nofollow(
            frame
                .root_path
                .as_deref()
                .expect("root frame has a root path"),
        )
        .map_err(|_| WorkspaceSearchErrorKind::ChangedDuringSearch)?,
        _ => unreachable!("target parent and name are paired"),
    };
    let reopened_snapshot = FileSnapshot::from_directory(&reopened)
        .map_err(|_| WorkspaceSearchErrorKind::ChangedDuringSearch)?;
    if frame.opened_snapshot != final_snapshot || frame.opened_snapshot != reopened_snapshot {
        Err(WorkspaceSearchErrorKind::ChangedDuringSearch)
    } else {
        Ok(())
    }
}

fn validate_query(query: &str) -> Result<(), WorkspaceSearchErrorKind> {
    if query.is_empty()
        || query.len() > MAX_WORKSPACE_SEARCH_QUERY_BYTES
        || query.chars().any(|character| character.is_control())
        || query.chars().all(char::is_whitespace)
    {
        Err(WorkspaceSearchErrorKind::InvalidQuery)
    } else {
        Ok(())
    }
}

fn compare_search_entries(left: &SearchEntry, right: &SearchEntry) -> std::cmp::Ordering {
    let left_suffix = matches!(left.kind, SearchEntryKind::Directory).then_some(b'/');
    let right_suffix = matches!(right.kind, SearchEntryKind::Directory).then_some(b'/');
    left.name
        .as_bytes()
        .iter()
        .copied()
        .chain(left_suffix)
        .cmp(right.name.as_bytes().iter().copied().chain(right_suffix))
}

fn join_workspace_path(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

fn map_child_directory_open_error(
    directory: &Dir,
    name: &str,
    error_value: &std::io::Error,
) -> WorkspaceSearchErrorKind {
    match classify_directory_open_error(directory, name.as_ref(), error_value) {
        WorkspaceListErrorKind::AccessDenied => WorkspaceSearchErrorKind::AccessDenied,
        WorkspaceListErrorKind::Unavailable => WorkspaceSearchErrorKind::Unavailable,
        _ => WorkspaceSearchErrorKind::ChangedDuringSearch,
    }
}

fn map_search_io_error(error_value: &std::io::Error) -> WorkspaceSearchErrorKind {
    map_read_error(map_io_error(error_value))
}

fn map_read_error(kind: WorkspaceReadErrorKind) -> WorkspaceSearchErrorKind {
    match kind {
        WorkspaceReadErrorKind::InvalidPath => WorkspaceSearchErrorKind::InvalidPath,
        WorkspaceReadErrorKind::NotFound => WorkspaceSearchErrorKind::NotFound,
        WorkspaceReadErrorKind::AccessDenied => WorkspaceSearchErrorKind::AccessDenied,
        WorkspaceReadErrorKind::PathNotAllowed => WorkspaceSearchErrorKind::PathNotAllowed,
        WorkspaceReadErrorKind::NotRegularFile => WorkspaceSearchErrorKind::NotDirectory,
        WorkspaceReadErrorKind::Cancelled => WorkspaceSearchErrorKind::Cancelled,
        WorkspaceReadErrorKind::FileTooLarge
        | WorkspaceReadErrorKind::BinaryFile
        | WorkspaceReadErrorKind::ChangedDuringRead
        | WorkspaceReadErrorKind::Unavailable => WorkspaceSearchErrorKind::Unavailable,
    }
}

fn map_list_error(kind: WorkspaceListErrorKind) -> WorkspaceSearchErrorKind {
    match kind {
        WorkspaceListErrorKind::InvalidPath => WorkspaceSearchErrorKind::InvalidPath,
        WorkspaceListErrorKind::NotFound => WorkspaceSearchErrorKind::NotFound,
        WorkspaceListErrorKind::AccessDenied => WorkspaceSearchErrorKind::AccessDenied,
        WorkspaceListErrorKind::PathNotAllowed => WorkspaceSearchErrorKind::PathNotAllowed,
        WorkspaceListErrorKind::NotDirectory => WorkspaceSearchErrorKind::NotDirectory,
        WorkspaceListErrorKind::InvalidEncoding => WorkspaceSearchErrorKind::InvalidEncoding,
        WorkspaceListErrorKind::InvalidName => WorkspaceSearchErrorKind::InvalidName,
        WorkspaceListErrorKind::TooManyEntries => WorkspaceSearchErrorKind::TooManyEntries,
        WorkspaceListErrorKind::ChangedDuringList => WorkspaceSearchErrorKind::ChangedDuringSearch,
        WorkspaceListErrorKind::ResultTooLarge => WorkspaceSearchErrorKind::ResultTooLarge,
        WorkspaceListErrorKind::Cancelled => WorkspaceSearchErrorKind::Cancelled,
        WorkspaceListErrorKind::Unavailable => WorkspaceSearchErrorKind::Unavailable,
    }
}

fn error(kind: WorkspaceSearchErrorKind) -> WorkspaceSearchOutcome {
    WorkspaceSearchOutcome::Error { kind }
}

#[cfg(test)]
#[path = "workspace_search/tests/mod.rs"]
mod tests;
