use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

use jieba_rs::Jieba;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use quick_xml::Reader;
use quick_xml::events::Event;
use rusqlite::ErrorCode;
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zip::ZipArchive;

use crate::persistence::{KnowledgeChunkInput, PersistenceError, Result, Store};

const MAX_TEXT_BYTES: u64 = 10 * 1_024 * 1_024;
const MAX_EDITABLE_TEXT_BYTES: usize = 2 * 1_024 * 1_024;
const MAX_DOCUMENT_BYTES: u64 = 50 * 1_024 * 1_024;
const MAX_FOLDER_FILES: usize = 20_000;
const MAX_KNOWLEDGE_CHUNKS: usize = 50_000;
const TARGET_TOKENS: usize = 360;
const OVERLAP_TOKENS: usize = 60;
const HARD_MAX_TOKENS: usize = 480;
static AGENT_ACTIVE: AtomicBool = AtomicBool::new(false);

const SUPPORTED_TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "mdx", "rst", "log", "json", "jsonl", "yaml", "yml", "xml", "html", "htm", "csv",
    "tsv", "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "java", "kt", "kts", "swift",
    "c", "h", "cc", "cpp", "hpp", "cs", "php", "rb", "sh", "bash", "zsh", "fish", "ps1", "sql",
    "toml", "ini", "conf", "css", "scss", "less", "vue", "svelte", "graphql", "gql",
];
const CODE_EXTENSIONS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "java", "kt", "kts", "swift", "c",
    "h", "cc", "cpp", "hpp", "cs", "php", "rb", "sh", "bash", "zsh", "fish", "ps1", "sql", "css",
    "scss", "less", "vue", "svelte", "graphql", "gql",
];

pub(super) fn set_agent_active(active: bool) {
    AGENT_ACTIVE.store(active, Ordering::Release);
}

pub(super) fn agent_active() -> bool {
    AGENT_ACTIVE.load(Ordering::Acquire)
}

fn index_priority_checkpoint() {
    if agent_active() {
        thread::sleep(Duration::from_millis(25));
    } else {
        thread::yield_now();
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IndexResult {
    pub(super) indexed: usize,
    pub(super) skipped: usize,
    pub(super) errors: usize,
    pub(super) deleted: usize,
    pub(super) job_id: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EditableKnowledgeDocument {
    pub(super) source_id: String,
    pub(super) knowledge_base_id: String,
    pub(super) file_name: String,
    pub(super) format: String,
    pub(super) content: String,
    pub(super) sha256: String,
    pub(super) size_bytes: usize,
}

pub(super) struct ManagedTextUpdate {
    pub(super) result: IndexResult,
    pub(super) old_path: String,
}

pub(super) struct KnowledgeWatcher {
    watcher: Option<RecommendedWatcher>,
    sender: Option<mpsc::Sender<Vec<PathBuf>>>,
    worker: Option<thread::JoinHandle<()>>,
}

impl KnowledgeWatcher {
    pub(super) fn start(
        data_directory: PathBuf,
        roots: &[PathBuf],
        scan_gate: Arc<Mutex<()>>,
    ) -> Result<Self> {
        let (sender, receiver) = mpsc::channel::<Vec<PathBuf>>();
        let event_sender = sender.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                let paths = event.map(|event| event.paths).unwrap_or_default();
                let _ = event_sender.send(paths);
            })
            .map_err(|error| {
                PersistenceError::InvalidInput(format!("knowledge folder watcher failed: {error}"))
            })?;
        let mut watched = HashSet::new();
        for root in roots {
            if root.is_dir() && watched.insert(root.clone()) {
                let _ = watcher.watch(root, RecursiveMode::Recursive);
            }
            if let Some(parent) = root.ancestors().skip(1).find(|path| path.is_dir()) {
                let parent = parent.to_path_buf();
                if watched.insert(parent.clone()) {
                    let _ = watcher.watch(&parent, RecursiveMode::NonRecursive);
                }
            }
        }
        let worker = thread::Builder::new()
            .name("sugarcode-knowledge-watch".to_owned())
            .spawn(move || watch_worker(receiver, data_directory, scan_gate))?;
        if !roots.is_empty() {
            let _ = sender.send(roots.to_vec());
        }
        Ok(Self {
            watcher: Some(watcher),
            sender: Some(sender),
            worker: Some(worker),
        })
    }

    pub(super) fn watch(&mut self, root: &Path) -> Result<()> {
        if root.is_dir() {
            self.watcher
                .as_mut()
                .ok_or_else(|| {
                    PersistenceError::InvalidInput("knowledge folder watcher is closed".to_owned())
                })?
                .watch(root, RecursiveMode::Recursive)
                .map_err(|error| {
                    PersistenceError::InvalidInput(format!(
                        "knowledge folder watcher could not watch {}: {error}",
                        root.display()
                    ))
                })?;
            if let Some(parent) = root.parent().filter(|path| path.is_dir()) {
                let _ = self
                    .watcher
                    .as_mut()
                    .expect("watcher exists while registering a path")
                    .watch(parent, RecursiveMode::NonRecursive);
            }
        }
        Ok(())
    }
}

impl Drop for KnowledgeWatcher {
    fn drop(&mut self) {
        // macOS FSEvents can spend tens of seconds tearing down a recursive
        // watcher. NativeRuntime owns exactly one process-lifetime watcher, so
        // leave that backend to process teardown and keep app shutdown instant.
        if let Some(watcher) = self.watcher.take() {
            std::mem::forget(watcher);
        }
        self.sender.take();
        self.worker.take();
    }
}

fn watch_worker(
    receiver: mpsc::Receiver<Vec<PathBuf>>,
    data_directory: PathBuf,
    scan_gate: Arc<Mutex<()>>,
) {
    while let Ok(first_paths) = receiver.recv() {
        let mut changed_paths = first_paths;
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            match receiver.recv_timeout(remaining) {
                Ok(paths) => changed_paths.extend(paths),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
        let Ok(_scan_guard) = scan_gate.lock() else {
            return;
        };
        let Ok(mut store) = Store::open_worker(&data_directory) else {
            continue;
        };
        let Ok(sources) = store.linked_knowledge_sources() else {
            continue;
        };
        for source in sources {
            let root = Path::new(&source.path);
            if !changed_paths.is_empty()
                && !changed_paths
                    .iter()
                    .any(|path| path.starts_with(root) || root.starts_with(path))
            {
                continue;
            }
            let _ = rescan_linked_source(&mut store, &source.id, "incremental");
            thread::yield_now();
        }
    }
}

pub(super) fn add_managed_files(
    store: &mut Store,
    knowledge_root: &Path,
    knowledge_base_id: &str,
    paths: &[String],
) -> Result<IndexResult> {
    if paths.is_empty() || paths.len() > 256 {
        return Err(PersistenceError::InvalidInput(
            "select between 1 and 256 knowledge files".to_owned(),
        ));
    }
    let managed_root = knowledge_root.join("managed");
    fs::create_dir_all(&managed_root)?;
    let job_id = store.create_knowledge_index_job(knowledge_base_id, None, "initial")?;
    if !store.start_knowledge_index_job(&job_id)? {
        return Err(PersistenceError::Conflict(
            "knowledge index job could not be started".to_owned(),
        ));
    }
    let mut result = IndexResult {
        indexed: 0,
        skipped: 0,
        errors: 0,
        deleted: 0,
        job_id: Some(job_id.clone()),
    };
    let mut total_chunks = store
        .knowledge_documents(knowledge_base_id)?
        .iter()
        .map(|document| document.chunk_count as usize)
        .sum::<usize>();
    for (position, raw_path) in paths.iter().enumerate() {
        index_priority_checkpoint();
        let source_path = canonical_regular_file(Path::new(raw_path))?;
        let metadata = fs::metadata(&source_path)?;
        ensure_supported_size(&source_path, metadata.len())?;
        if !is_supported(&source_path) {
            result.skipped += 1;
            store.update_knowledge_index_job_progress(
                &job_id,
                paths.len(),
                position + 1,
                result.indexed,
                result.skipped,
                result.deleted,
                result.errors,
            )?;
            continue;
        }
        let bytes = fs::read(&source_path)?;
        let sha256 = hex_sha256(&bytes);
        let file_name = source_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                PersistenceError::InvalidInput("knowledge file name is invalid".to_owned())
            })?;
        let target_dir = managed_root.join(&sha256);
        fs::create_dir_all(&target_dir)?;
        let target_path = target_dir.join(file_name);
        if !target_path.exists() {
            fs::copy(&source_path, &target_path)?;
        }
        let source_id = match store.create_knowledge_source(
            knowledge_base_id,
            "managedFile",
            &target_path.to_string_lossy(),
            file_name,
        ) {
            Ok(id) => id,
            Err(PersistenceError::Sqlite(rusqlite::Error::SqliteFailure(error, _)))
                if error.code == ErrorCode::ConstraintViolation =>
            {
                result.skipped += 1;
                store.update_knowledge_index_job_progress(
                    &job_id,
                    paths.len(),
                    position + 1,
                    result.indexed,
                    result.skipped,
                    result.deleted,
                    result.errors,
                )?;
                continue;
            }
            Err(error) => return Err(error),
        };
        match index_file(
            store,
            knowledge_base_id,
            &source_id,
            &target_path,
            file_name,
            Some(bytes),
            MAX_KNOWLEDGE_CHUNKS.saturating_sub(total_chunks),
        ) {
            Ok(Some(chunk_count)) => {
                total_chunks = total_chunks.saturating_add(chunk_count);
                if total_chunks > MAX_KNOWLEDGE_CHUNKS {
                    return Err(PersistenceError::InvalidInput(
                        "knowledge base exceeded the 50,000 chunk limit".to_owned(),
                    ));
                }
                result.indexed += 1;
            }
            Ok(None) => result.skipped += 1,
            Err(error) => {
                record_parse_error(
                    store,
                    knowledge_base_id,
                    &source_id,
                    &target_path,
                    file_name,
                    &error,
                )?;
                result.errors += 1;
            }
        }
        let cancelled = store.update_knowledge_index_job_progress(
            &job_id,
            paths.len(),
            position + 1,
            result.indexed,
            result.skipped,
            result.deleted,
            result.errors,
        )?;
        if cancelled {
            store.finish_knowledge_index_job(&job_id, "cancelled", None)?;
            store.set_knowledge_status(knowledge_base_id, "ready")?;
            return Ok(result);
        }
    }
    store.finish_knowledge_index_job(&job_id, "completed", None)?;
    store.set_knowledge_status(
        knowledge_base_id,
        if result.errors > 0 && result.indexed == 0 {
            "error"
        } else {
            "ready"
        },
    )?;
    Ok(result)
}

fn validate_editable_text(file_name: &str, content: &str) -> Result<()> {
    let path = Path::new(file_name);
    let mut components = path.components();
    if file_name.trim() != file_name
        || file_name.is_empty()
        || file_name.len() > 255
        || file_name.chars().any(char::is_control)
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
        || !matches!(extension(path).as_str(), "txt" | "md")
    {
        return Err(PersistenceError::InvalidInput(
            "editable knowledge documents must use a safe .txt or .md file name".to_owned(),
        ));
    }
    if content.trim().is_empty()
        || content.as_bytes().len() > MAX_EDITABLE_TEXT_BYTES
        || content.contains('\0')
    {
        return Err(PersistenceError::InvalidInput(
            "editable knowledge document content is empty or exceeds 2 MB".to_owned(),
        ));
    }
    Ok(())
}

fn write_managed_text(knowledge_root: &Path, file_name: &str, content: &str) -> Result<PathBuf> {
    validate_editable_text(file_name, content)?;
    let bytes = content.as_bytes();
    let sha256 = hex_sha256(bytes);
    let target_dir = knowledge_root.join("managed").join(sha256);
    fs::create_dir_all(&target_dir)?;
    let target = target_dir.join(file_name);
    if target.exists() {
        if fs::read(&target)? == bytes {
            return Ok(target);
        }
        return Err(PersistenceError::Conflict(
            "managed knowledge content hash collision".to_owned(),
        ));
    }
    let temporary = target_dir.join(format!(".sugarcode-{}.tmp", Uuid::now_v7().simple()));
    let write_result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, &target)?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    Ok(target)
}

pub(super) fn create_managed_text_document(
    store: &mut Store,
    knowledge_root: &Path,
    knowledge_base_id: &str,
    file_name: &str,
    content: &str,
) -> Result<IndexResult> {
    let target = write_managed_text(knowledge_root, file_name, content)?;
    let target_string = target.to_string_lossy().into_owned();
    let source_id = match store.create_knowledge_source(
        knowledge_base_id,
        "managedFile",
        &target_string,
        file_name,
    ) {
        Ok(source_id) => source_id,
        Err(error) => {
            if store
                .managed_path_reference_count(&target_string)
                .unwrap_or(1)
                == 0
            {
                let _ = fs::remove_file(&target);
                if let Some(parent) = target.parent() {
                    let _ = fs::remove_dir(parent);
                }
            }
            return Err(error);
        }
    };
    rescan_source(store, &source_id, false)
}

pub(super) fn read_managed_text_document(
    store: &mut Store,
    knowledge_root: &Path,
    source_id: &str,
) -> Result<EditableKnowledgeDocument> {
    let source = store.knowledge_source(source_id)?;
    if source.kind != "managedFile"
        || !matches!(
            extension(Path::new(&source.display_name)).as_str(),
            "txt" | "md"
        )
    {
        return Err(PersistenceError::InvalidInput(
            "only managed .txt and .md sources can be edited".to_owned(),
        ));
    }
    let managed_root = fs::canonicalize(knowledge_root.join("managed"))?;
    let source_path = PathBuf::from(&source.path);
    let metadata = fs::symlink_metadata(&source_path)?;
    let canonical = fs::canonicalize(&source_path)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || !canonical.starts_with(&managed_root)
    {
        return Err(PersistenceError::InvalidInput(
            "managed knowledge source escaped its storage root".to_owned(),
        ));
    }
    let bytes = fs::read(&canonical)?;
    if bytes.len() > MAX_EDITABLE_TEXT_BYTES {
        return Err(PersistenceError::InvalidInput(
            "managed knowledge document exceeds the 2 MB editor limit".to_owned(),
        ));
    }
    let content = String::from_utf8(bytes.clone()).map_err(|_| {
        PersistenceError::InvalidInput("managed knowledge document is not UTF-8".to_owned())
    })?;
    Ok(EditableKnowledgeDocument {
        source_id: source.id,
        knowledge_base_id: source.knowledge_base_id,
        file_name: source.display_name.clone(),
        format: if extension(Path::new(&source.display_name)) == "md" {
            "markdown".to_owned()
        } else {
            "text".to_owned()
        },
        content,
        sha256: hex_sha256(&bytes),
        size_bytes: bytes.len(),
    })
}

pub(super) fn update_managed_text_document(
    store: &mut Store,
    knowledge_root: &Path,
    source_id: &str,
    expected_sha256: &str,
    content: &str,
) -> Result<ManagedTextUpdate> {
    if expected_sha256.len() != 64 || !expected_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(PersistenceError::InvalidInput(
            "managed knowledge document revision is invalid".to_owned(),
        ));
    }
    let current = read_managed_text_document(store, knowledge_root, source_id)?;
    if current.sha256 != expected_sha256.to_ascii_lowercase() {
        return Err(PersistenceError::Conflict(
            "managed knowledge document changed; reload before saving".to_owned(),
        ));
    }
    validate_editable_text(&current.file_name, content)?;
    let next_sha256 = hex_sha256(content.as_bytes());
    if next_sha256 == current.sha256 {
        return Ok(ManagedTextUpdate {
            result: IndexResult {
                indexed: 0,
                skipped: 1,
                errors: 0,
                deleted: 0,
                job_id: None,
            },
            old_path: String::new(),
        });
    }
    let source = store.knowledge_source(source_id)?;
    let old_path = source.path;
    let target = write_managed_text(knowledge_root, &current.file_name, content)?;
    let target_string = target.to_string_lossy().into_owned();
    let updated = match store.update_managed_knowledge_source_path(source_id, &target_string) {
        Ok(updated) => updated,
        Err(error) => {
            if store
                .managed_path_reference_count(&target_string)
                .unwrap_or(1)
                == 0
            {
                let _ = fs::remove_file(&target);
                if let Some(parent) = target.parent() {
                    let _ = fs::remove_dir(parent);
                }
            }
            return Err(error);
        }
    };
    if !updated {
        if store.managed_path_reference_count(&target_string)? == 0 {
            let _ = fs::remove_file(&target);
            if let Some(parent) = target.parent() {
                let _ = fs::remove_dir(parent);
            }
        }
        return Err(PersistenceError::InvalidInput(
            "managed knowledge source no longer exists".to_owned(),
        ));
    }
    let result = rescan_source(store, source_id, true)?;
    Ok(ManagedTextUpdate { result, old_path })
}

pub(super) fn add_linked_folder(
    store: &mut Store,
    knowledge_base_id: &str,
    raw_path: &str,
) -> Result<IndexResult> {
    let root = fs::canonicalize(raw_path)?;
    let metadata = fs::symlink_metadata(&root)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(PersistenceError::InvalidInput(
            "knowledge folder must be a real local directory".to_owned(),
        ));
    }
    let display_name = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("本地目录");
    let source_id = store.create_knowledge_source(
        knowledge_base_id,
        "linkedFolder",
        &root.to_string_lossy(),
        display_name,
    )?;
    rescan_linked_source(store, &source_id, "initial")
}

pub(super) fn rescan_linked_source(
    store: &mut Store,
    source_id: &str,
    kind: &str,
) -> Result<IndexResult> {
    let source = store.knowledge_source(source_id)?;
    if source.kind != "linkedFolder" {
        return Err(PersistenceError::InvalidInput(
            "only linked folders can be rescanned".to_owned(),
        ));
    }
    let job_id =
        store.create_knowledge_index_job(&source.knowledge_base_id, Some(source_id), kind)?;
    if !store.start_knowledge_index_job(&job_id)? {
        return Err(PersistenceError::Conflict(
            "knowledge index job could not be started".to_owned(),
        ));
    }
    store.set_knowledge_source_status(source_id, "scanning", None, false)?;
    store.set_knowledge_status(&source.knowledge_base_id, "indexing")?;

    let root = match fs::symlink_metadata(&source.path)
        .ok()
        .filter(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        .and_then(|_| fs::canonicalize(&source.path).ok())
    {
        Some(root) => root,
        None => {
            let message = "链接目录不可用；现有索引已保留。";
            store.set_knowledge_source_status(source_id, "disconnected", Some(message), true)?;
            store.finish_knowledge_index_job(&job_id, "failed", Some(message))?;
            store.set_knowledge_status(&source.knowledge_base_id, "error")?;
            return Ok(IndexResult {
                indexed: 0,
                skipped: 0,
                errors: 1,
                deleted: 0,
                job_id: Some(job_id),
            });
        }
    };
    let config = store.knowledge_base_config(&source.knowledge_base_id)?;
    let files = match collect_folder_files(&root, &config.ignore_rules) {
        Ok(files) => files,
        Err(error) => {
            let message = error.to_string();
            store.set_knowledge_source_status(source_id, "error", Some(&message), true)?;
            store.finish_knowledge_index_job(&job_id, "failed", Some(&message))?;
            store.set_knowledge_status(&source.knowledge_base_id, "error")?;
            return Err(error);
        }
    };
    let existing = store
        .knowledge_documents_for_source(source_id)?
        .into_iter()
        .map(|document| (document.relative_path.clone(), document))
        .collect::<HashMap<_, _>>();
    let mut seen = HashSet::with_capacity(files.len());
    let mut result = IndexResult {
        indexed: 0,
        skipped: 0,
        errors: 0,
        deleted: 0,
        job_id: Some(job_id.clone()),
    };
    let mut total_chunks = store
        .knowledge_documents(&source.knowledge_base_id)?
        .iter()
        .map(|document| usize::try_from(document.chunk_count).unwrap_or(usize::MAX))
        .sum::<usize>();

    for (position, path) in files.iter().enumerate() {
        index_priority_checkpoint();
        let relative_path = path
            .strip_prefix(&root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        seen.insert(relative_path.clone());
        let old = existing.get(&relative_path);
        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) => {
                result.errors += 1;
                let _ = store.update_knowledge_index_job_progress(
                    &job_id,
                    files.len(),
                    position + 1,
                    result.indexed,
                    result.skipped,
                    result.deleted,
                    result.errors,
                )?;
                let _ = error;
                continue;
            }
        };
        let size_bytes = i64::try_from(metadata.len()).unwrap_or(i64::MAX);
        let modified_at = modified_at(&metadata);
        if kind != "rebuild"
            && old.is_some_and(|document| {
                document.size_bytes == size_bytes && document.modified_at == modified_at
            })
        {
            result.skipped += 1;
        } else {
            let bytes = match fs::read(path) {
                Ok(bytes) => Some(bytes),
                Err(error) => {
                    result.errors += 1;
                    let _ = error;
                    None
                }
            };
            if let Some(bytes) = bytes {
                let sha256 = hex_sha256(&bytes);
                if let Some(document) =
                    old.filter(|document| kind != "rebuild" && document.sha256 == sha256)
                {
                    store.update_knowledge_document_stat(&document.id, size_bytes, modified_at)?;
                    result.skipped += 1;
                } else {
                    let old_chunks = old
                        .and_then(|document| usize::try_from(document.chunk_count).ok())
                        .unwrap_or_default();
                    match index_file(
                        store,
                        &source.knowledge_base_id,
                        source_id,
                        path,
                        &relative_path,
                        Some(bytes),
                        MAX_KNOWLEDGE_CHUNKS
                            .saturating_sub(total_chunks)
                            .saturating_add(old_chunks),
                    ) {
                        Ok(Some(chunk_count)) => {
                            total_chunks = total_chunks
                                .saturating_sub(old_chunks)
                                .saturating_add(chunk_count);
                            result.indexed += 1;
                        }
                        Ok(None) => result.skipped += 1,
                        Err(error) => {
                            record_parse_error(
                                store,
                                &source.knowledge_base_id,
                                source_id,
                                path,
                                &relative_path,
                                &error,
                            )?;
                            total_chunks = total_chunks.saturating_sub(old_chunks);
                            result.errors += 1;
                        }
                    }
                }
            }
        }
        let cancelled = store.update_knowledge_index_job_progress(
            &job_id,
            files.len(),
            position + 1,
            result.indexed,
            result.skipped,
            result.deleted,
            result.errors,
        )?;
        if cancelled {
            store.finish_knowledge_index_job(&job_id, "cancelled", None)?;
            store.set_knowledge_source_status(source_id, "ready", None, true)?;
            store.set_knowledge_status(&source.knowledge_base_id, "ready")?;
            return Ok(result);
        }
    }

    for document in existing.values() {
        if !seen.contains(&document.relative_path) {
            if store.delete_knowledge_document(&document.id)? {
                result.deleted += 1;
            }
        }
    }
    store.update_knowledge_index_job_progress(
        &job_id,
        files.len(),
        files.len(),
        result.indexed,
        result.skipped,
        result.deleted,
        result.errors,
    )?;
    store.finish_knowledge_index_job(&job_id, "completed", None)?;
    store.set_knowledge_source_status(source_id, "ready", None, true)?;
    store.set_knowledge_status(
        &source.knowledge_base_id,
        if result.errors > 0 && result.indexed == 0 {
            "error"
        } else {
            "ready"
        },
    )?;
    Ok(result)
}

pub(super) fn rescan_source(
    store: &mut Store,
    source_id: &str,
    rebuild: bool,
) -> Result<IndexResult> {
    let source = store.knowledge_source(source_id)?;
    if source.kind == "linkedFolder" {
        return rescan_linked_source(store, source_id, if rebuild { "rebuild" } else { "rescan" });
    }
    let job_id = store.create_knowledge_index_job(
        &source.knowledge_base_id,
        Some(source_id),
        if rebuild { "rebuild" } else { "rescan" },
    )?;
    store.start_knowledge_index_job(&job_id)?;
    store.set_knowledge_source_status(source_id, "scanning", None, false)?;
    let path = PathBuf::from(&source.path);
    let safe_file = fs::symlink_metadata(&path)
        .ok()
        .is_some_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink());
    if !safe_file {
        let message = "托管文件不可用。";
        store.set_knowledge_source_status(source_id, "error", Some(message), true)?;
        store.finish_knowledge_index_job(&job_id, "failed", Some(message))?;
        return Ok(IndexResult {
            indexed: 0,
            skipped: 0,
            errors: 1,
            deleted: 0,
            job_id: Some(job_id),
        });
    }
    index_priority_checkpoint();
    let existing = store.knowledge_documents_for_source(source_id)?;
    let old_chunks = existing
        .first()
        .and_then(|document| usize::try_from(document.chunk_count).ok())
        .unwrap_or_default();
    let total_chunks = store
        .knowledge_documents(&source.knowledge_base_id)?
        .iter()
        .map(|document| usize::try_from(document.chunk_count).unwrap_or(usize::MAX))
        .sum::<usize>();
    let result = match index_file(
        store,
        &source.knowledge_base_id,
        source_id,
        &path,
        &source.display_name,
        None,
        MAX_KNOWLEDGE_CHUNKS
            .saturating_sub(total_chunks)
            .saturating_add(old_chunks),
    ) {
        Ok(Some(_)) => IndexResult {
            indexed: 1,
            skipped: 0,
            errors: 0,
            deleted: 0,
            job_id: Some(job_id.clone()),
        },
        Ok(None) => IndexResult {
            indexed: 0,
            skipped: 1,
            errors: 0,
            deleted: 0,
            job_id: Some(job_id.clone()),
        },
        Err(error) => {
            record_parse_error(
                store,
                &source.knowledge_base_id,
                source_id,
                &path,
                &source.display_name,
                &error,
            )?;
            IndexResult {
                indexed: 0,
                skipped: 0,
                errors: 1,
                deleted: 0,
                job_id: Some(job_id.clone()),
            }
        }
    };
    store.update_knowledge_index_job_progress(
        &job_id,
        1,
        1,
        result.indexed,
        result.skipped,
        0,
        result.errors,
    )?;
    store.finish_knowledge_index_job(&job_id, "completed", None)?;
    store.set_knowledge_source_status(source_id, "ready", None, true)?;
    store.set_knowledge_status(&source.knowledge_base_id, "ready")?;
    Ok(result)
}

pub(super) fn search_query(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 1_000 {
        return Err(PersistenceError::InvalidInput(
            "knowledge search query is invalid".to_owned(),
        ));
    }
    let jieba = Jieba::new();
    let mut terms = jieba
        .cut(value, false)
        .into_iter()
        .flat_map(split_identifier)
        .filter(|term| term.chars().any(char::is_alphanumeric))
        .take(32)
        .collect::<Vec<_>>();
    terms.sort();
    terms.dedup();
    if terms.is_empty() {
        return Err(PersistenceError::InvalidInput(
            "knowledge search query has no searchable terms".to_owned(),
        ));
    }
    Ok(terms
        .into_iter()
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR "))
}

fn index_file(
    store: &mut Store,
    knowledge_base_id: &str,
    source_id: &str,
    path: &Path,
    relative_path: &str,
    known_bytes: Option<Vec<u8>>,
    remaining_chunks: usize,
) -> Result<Option<usize>> {
    let metadata = fs::metadata(path)?;
    ensure_supported_size(path, metadata.len())?;
    if !is_supported(path) {
        return Ok(None);
    }
    let bytes = known_bytes.unwrap_or(fs::read(path)?);
    let sha256 = hex_sha256(&bytes);
    let chunks = parse_chunks(path, &bytes)?;
    if chunks.is_empty() {
        return Err(PersistenceError::InvalidInput(
            if extension(path) == "pdf" {
                "扫描型 PDF：未检测到可索引文本"
            } else {
                "文件中未检测到可索引文本"
            }
            .to_owned(),
        ));
    }
    if chunks.len() > remaining_chunks {
        return Err(PersistenceError::InvalidInput(
            "knowledge base exceeded the 50,000 chunk limit".to_owned(),
        ));
    }
    let modified_at = modified_at(&metadata);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(relative_path);
    let chunk_count = chunks.len();
    store.replace_knowledge_document(
        knowledge_base_id,
        source_id,
        relative_path,
        file_name,
        media_type(path),
        i64::try_from(metadata.len()).unwrap_or(i64::MAX),
        modified_at,
        &sha256,
        None,
        &chunks,
    )?;
    Ok(Some(chunk_count))
}

fn record_parse_error(
    store: &mut Store,
    knowledge_base_id: &str,
    source_id: &str,
    path: &Path,
    relative_path: &str,
    error: &PersistenceError,
) -> Result<()> {
    let metadata = fs::metadata(path)?;
    let bytes = fs::read(path)?;
    let modified_at = modified_at(&metadata);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(relative_path);
    store.replace_knowledge_document(
        knowledge_base_id,
        source_id,
        relative_path,
        file_name,
        media_type(path),
        i64::try_from(metadata.len()).unwrap_or(i64::MAX),
        modified_at,
        &hex_sha256(&bytes),
        Some(&error.to_string()),
        &[],
    )
}

fn parse_chunks(path: &Path, bytes: &[u8]) -> Result<Vec<KnowledgeChunkInput>> {
    if extension(path) == "pdf" {
        let pages = pdf_extract::extract_text_by_pages(path).map_err(|error| {
            PersistenceError::InvalidInput(format!("PDF text extraction failed: {error}"))
        })?;
        let mut chunks = Vec::new();
        for (page_index, page) in pages.into_iter().enumerate() {
            let mut page_chunks = chunk_text(&page);
            for chunk in &mut page_chunks {
                chunk.ordinal = i64::try_from(chunks.len()).unwrap_or(i64::MAX);
                chunk.page_number = i64::try_from(page_index + 1).ok();
            }
            chunks.extend(page_chunks);
        }
        return Ok(chunks);
    }
    let content = parse_content(path, bytes)?;
    if is_code_path(path) {
        Ok(chunk_code(&content, &extension(path)))
    } else {
        Ok(chunk_text(&content))
    }
}

fn parse_content(path: &Path, bytes: &[u8]) -> Result<String> {
    match extension(path).as_str() {
        "docx" => parse_docx(path),
        "html" | "htm" | "xml" => {
            let text = std::str::from_utf8(bytes).map_err(|_| {
                PersistenceError::InvalidInput("document is not valid UTF-8".to_owned())
            })?;
            Ok(strip_xml(text))
        }
        _ => std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|_| PersistenceError::InvalidInput("document is not valid UTF-8".to_owned())),
    }
}

fn parse_docx(path: &Path) -> Result<String> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file).map_err(|error| {
        PersistenceError::InvalidInput(format!("DOCX archive is invalid: {error}"))
    })?;
    let mut document = archive
        .by_name("word/document.xml")
        .map_err(|_| PersistenceError::InvalidInput("DOCX document body is missing".to_owned()))?;
    let mut xml = String::new();
    document.read_to_string(&mut xml)?;
    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(true);
    let mut output = String::new();
    let mut paragraph = String::new();
    let mut style = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) if local_xml_name(start.name().as_ref()) == b"p" => {
                paragraph.clear();
                style.clear();
            }
            Ok(Event::Empty(start)) | Ok(Event::Start(start))
                if local_xml_name(start.name().as_ref()) == b"pStyle" =>
            {
                for attribute in start.attributes().flatten() {
                    if local_xml_name(attribute.key.as_ref()) == b"val" {
                        if let Ok(value) = attribute.decode_and_unescape_value(reader.decoder()) {
                            style = value.into_owned();
                        }
                    }
                }
            }
            Ok(Event::Text(text)) => {
                if let Ok(decoded) = text.decode() {
                    paragraph.push_str(&decoded);
                }
            }
            Ok(Event::End(end)) if local_xml_name(end.name().as_ref()) == b"p" => {
                let paragraph = paragraph.trim();
                if !paragraph.is_empty() {
                    if let Some(level) = docx_heading_level(&style) {
                        output.push_str(&"#".repeat(level));
                        output.push(' ');
                    }
                    output.push_str(paragraph);
                    output.push_str("\n\n");
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => {
                return Err(PersistenceError::InvalidInput(format!(
                    "DOCX document XML is invalid: {error}"
                )));
            }
            _ => {}
        }
    }
    Ok(output)
}

fn local_xml_name(name: &[u8]) -> &[u8] {
    name.rsplit(|byte| *byte == b':').next().unwrap_or(name)
}

fn docx_heading_level(style: &str) -> Option<usize> {
    let normalized = style.to_ascii_lowercase();
    let suffix = normalized
        .strip_prefix("heading")
        .or_else(|| normalized.strip_prefix("标题"))?;
    suffix
        .trim()
        .parse::<usize>()
        .ok()
        .map(|level| level.clamp(1, 6))
}

fn strip_xml(value: &str) -> String {
    let mut reader = Reader::from_str(value);
    reader.config_mut().trim_text(true);
    let mut output = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Text(text)) => {
                if let Ok(decoded) = text.decode() {
                    if !output.ends_with([' ', '\n']) && !output.is_empty() {
                        output.push(' ');
                    }
                    output.push_str(&decoded);
                }
            }
            Ok(Event::End(end))
                if matches!(
                    local_xml_name(end.name().as_ref()),
                    b"p" | b"h1" | b"h2" | b"h3" | b"tr"
                ) =>
            {
                output.push('\n')
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    output
}

fn chunk_text(content: &str) -> Vec<KnowledgeChunkInput> {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let mut chunks = Vec::new();
    let mut buffer = String::new();
    let mut headings: [Option<String>; 6] = Default::default();
    let mut buffer_heading: Option<String> = None;
    for block in normalized
        .split("\n\n")
        .map(str::trim)
        .filter(|block| !block.is_empty())
    {
        if let Some((level, title)) = markdown_heading(block) {
            if !buffer.is_empty() {
                push_chunk(
                    &mut chunks,
                    &buffer,
                    buffer_heading.clone(),
                    "text",
                    None,
                    None,
                    None,
                );
                buffer.clear();
            }
            headings[level - 1] = Some(title.to_owned());
            headings
                .iter_mut()
                .skip(level)
                .for_each(|heading| *heading = None);
            buffer_heading = heading_path(&headings);
            continue;
        }
        let heading = heading_path(&headings);
        if estimated_tokens(&buffer) + estimated_tokens(block) > TARGET_TOKENS && !buffer.is_empty()
        {
            push_chunk(
                &mut chunks,
                &buffer,
                buffer_heading.clone(),
                "text",
                None,
                None,
                None,
            );
            buffer = token_tail(&buffer, OVERLAP_TOKENS);
            buffer.push_str("\n\n");
        }
        if buffer.is_empty() || buffer.trim().is_empty() {
            buffer_heading = heading.clone();
        }
        buffer.push_str(block);
        buffer.push_str("\n\n");
        while estimated_tokens(&buffer) > HARD_MAX_TOKENS {
            let (head, tail) = split_at_token_budget(&buffer, HARD_MAX_TOKENS);
            push_chunk(
                &mut chunks,
                &head,
                buffer_heading.clone(),
                "text",
                None,
                None,
                None,
            );
            buffer = format!("{}{}", token_tail(&head, OVERLAP_TOKENS), tail);
        }
    }
    if !buffer.trim().is_empty() {
        push_chunk(
            &mut chunks,
            buffer.trim(),
            buffer_heading,
            "text",
            None,
            None,
            None,
        );
    }
    chunks
}

fn chunk_code(content: &str, language: &str) -> Vec<KnowledgeChunkInput> {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let lines = normalized.lines().collect::<Vec<_>>();
    let mut chunks = Vec::new();
    let mut start = 0usize;
    while start < lines.len() {
        let mut end = start;
        let mut tokens = 0usize;
        let mut heading = None;
        while end < lines.len() {
            let line_tokens = estimated_tokens(lines[end]).max(1);
            if end > start && tokens + line_tokens > TARGET_TOKENS {
                break;
            }
            if heading.is_none() {
                heading = code_heading(lines[end]);
            }
            tokens += line_tokens;
            end += 1;
            if tokens >= HARD_MAX_TOKENS {
                break;
            }
        }
        let content = lines[start..end].join("\n");
        push_chunk(
            &mut chunks,
            &content,
            heading,
            "code",
            Some(language.to_owned()),
            i64::try_from(start + 1).ok(),
            i64::try_from(end).ok(),
        );
        if end >= lines.len() {
            break;
        }
        let overlap_lines = lines[start..end]
            .iter()
            .rev()
            .scan(0usize, |tokens, line| {
                *tokens += estimated_tokens(line).max(1);
                (*tokens <= OVERLAP_TOKENS).then_some(())
            })
            .count();
        start = end.saturating_sub(overlap_lines).max(start + 1);
    }
    chunks
}

#[allow(clippy::too_many_arguments)]
fn push_chunk(
    chunks: &mut Vec<KnowledgeChunkInput>,
    content: &str,
    heading: Option<String>,
    content_kind: &str,
    language: Option<String>,
    start_line: Option<i64>,
    end_line: Option<i64>,
) {
    let content = content.trim();
    if content.is_empty() {
        return;
    }
    let search_text = searchable_text(content);
    chunks.push(KnowledgeChunkInput {
        ordinal: i64::try_from(chunks.len()).unwrap_or(i64::MAX),
        heading,
        page_number: None,
        content_kind: content_kind.to_owned(),
        language,
        start_line,
        end_line,
        estimated_tokens: i64::try_from(estimated_tokens(content)).unwrap_or(i64::MAX),
        content: content.to_owned(),
        search_text,
        content_hash: hex_sha256(content.as_bytes()),
    });
}

fn markdown_heading(block: &str) -> Option<(usize, &str)> {
    let first = block.lines().next()?.trim();
    let markers = first.bytes().take_while(|byte| *byte == b'#').count();
    if (1..=6).contains(&markers) && first.as_bytes().get(markers) == Some(&b' ') {
        return Some((markers, first[markers..].trim()));
    }
    (first.chars().count() <= 100 && first.ends_with(':'))
        .then_some((1, first.trim_end_matches(':').trim()))
}

fn heading_path(headings: &[Option<String>; 6]) -> Option<String> {
    let path = headings.iter().flatten().cloned().collect::<Vec<_>>();
    (!path.is_empty()).then(|| path.join(" > "))
}

fn code_heading(line: &str) -> Option<String> {
    let line = line.trim();
    const PREFIXES: &[&str] = &[
        "fn ",
        "pub fn ",
        "async fn ",
        "pub async fn ",
        "def ",
        "class ",
        "interface ",
        "type ",
        "struct ",
        "enum ",
        "func ",
        "function ",
        "export function ",
    ];
    PREFIXES
        .iter()
        .find(|prefix| line.starts_with(**prefix))
        .map(|_| line.chars().take(160).collect())
}

fn estimated_tokens(value: &str) -> usize {
    let (mut ascii, mut non_ascii) = (0usize, 0usize);
    for character in value.chars() {
        if character.is_ascii() {
            ascii += 1;
        } else if !character.is_whitespace() {
            non_ascii += 1;
        }
    }
    non_ascii + ascii.div_ceil(4)
}

fn split_at_token_budget(value: &str, budget: usize) -> (String, String) {
    let mut tokens = 0usize;
    let mut split = value.len();
    for (index, character) in value.char_indices() {
        tokens += if character.is_ascii() { 1 } else { 4 };
        if tokens.div_ceil(4) >= budget {
            split = index + character.len_utf8();
            break;
        }
    }
    (value[..split].to_owned(), value[split..].to_owned())
}

fn token_tail(value: &str, budget: usize) -> String {
    let mut tokens = 0usize;
    let mut start = value.len();
    for (index, character) in value.char_indices().rev() {
        tokens += if character.is_ascii() { 1 } else { 4 };
        if tokens.div_ceil(4) > budget {
            break;
        }
        start = index;
    }
    value[start..].to_owned()
}

fn searchable_text(value: &str) -> String {
    let jieba = Jieba::new();
    let segmented = jieba.cut(value, false).join(" ");
    let identifiers = value
        .split(|character: char| !character.is_alphanumeric())
        .flat_map(split_identifier)
        .collect::<Vec<_>>()
        .join(" ");
    format!("{value}\n{segmented}\n{identifiers}")
}

fn split_identifier(value: &str) -> Vec<String> {
    let mut output = String::new();
    let mut previous_lower = false;
    for character in value.chars() {
        if character == '_'
            || character == '-'
            || character == '/'
            || character == '\\'
            || character == '.'
        {
            output.push(' ');
            previous_lower = false;
        } else {
            if previous_lower && character.is_ascii_uppercase() {
                output.push(' ');
            }
            previous_lower = character.is_ascii_lowercase();
            output.extend(character.to_lowercase());
        }
    }
    output.split_whitespace().map(str::to_owned).collect()
}

fn collect_folder_files(root: &Path, ignore_rules: &[String]) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            let relative_path = path.strip_prefix(root).unwrap_or(&path);
            if metadata.file_type().is_symlink()
                || ignored(&path)
                || matches_ignore_rules(relative_path, metadata.is_dir(), ignore_rules)
            {
                continue;
            }
            if metadata.is_dir() {
                pending.push(path);
            } else if metadata.is_file() && is_supported(&path) {
                ensure_supported_size(&path, metadata.len())?;
                files.push(path);
                if files.len() > MAX_FOLDER_FILES {
                    return Err(PersistenceError::InvalidInput(
                        "knowledge folder exceeds the 20,000 file limit".to_owned(),
                    ));
                }
            }
        }
    }
    files.sort();
    Ok(files)
}

fn matches_ignore_rules(path: &Path, is_directory: bool, rules: &[String]) -> bool {
    let path = path.to_string_lossy().replace('\\', "/");
    let mut ignored = false;
    for raw_rule in rules {
        let rule = raw_rule.trim();
        if rule.is_empty() || rule.starts_with('#') {
            continue;
        }
        let (negated, rule) = rule
            .strip_prefix('!')
            .map_or((false, rule), |value| (true, value));
        let directory_only = rule.ends_with('/');
        if directory_only && !is_directory {
            continue;
        }
        let pattern = rule.trim_matches('/');
        if pattern.is_empty() {
            continue;
        }
        let matches = if pattern.contains('/') {
            glob_matches(pattern, &path)
        } else {
            path.split('/')
                .any(|component| glob_matches(pattern, component))
        };
        if matches {
            ignored = !negated;
        }
    }
    ignored
}

fn glob_matches(pattern: &str, value: &str) -> bool {
    let pattern = pattern.chars().collect::<Vec<_>>();
    let value = value.chars().collect::<Vec<_>>();
    let (mut pattern_index, mut value_index) = (0, 0);
    let (mut star_index, mut star_value_index) = (None, 0);
    while value_index < value.len() {
        if pattern_index < pattern.len()
            && (pattern[pattern_index] == '?' || pattern[pattern_index] == value[value_index])
        {
            pattern_index += 1;
            value_index += 1;
        } else if pattern_index < pattern.len() && pattern[pattern_index] == '*' {
            while pattern_index < pattern.len() && pattern[pattern_index] == '*' {
                pattern_index += 1;
            }
            star_index = Some(pattern_index);
            star_value_index = value_index;
        } else if let Some(after_star) = star_index {
            star_value_index += 1;
            value_index = star_value_index;
            pattern_index = after_star;
        } else {
            return false;
        }
    }
    while pattern_index < pattern.len() && pattern[pattern_index] == '*' {
        pattern_index += 1;
    }
    pattern_index == pattern.len()
}

fn modified_at(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| i64::try_from(duration.as_secs()).ok())
        .unwrap_or_default()
}

fn ignored(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => {
            let name = name.to_string_lossy();
            matches!(
                name.as_ref(),
                ".git"
                    | "node_modules"
                    | "target"
                    | "dist"
                    | "build"
                    | ".next"
                    | ".cache"
                    | "coverage"
                    | "tmp"
                    | "temp"
            ) || name.starts_with(".env")
                || name.ends_with('~')
        }
        _ => false,
    })
}

fn canonical_regular_file(path: &Path) -> Result<PathBuf> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(PersistenceError::InvalidInput(
            "knowledge source must be a regular file".to_owned(),
        ));
    }
    fs::canonicalize(path).map_err(Into::into)
}

fn ensure_supported_size(path: &Path, size: u64) -> Result<()> {
    let limit = if matches!(extension(path).as_str(), "pdf" | "docx") {
        MAX_DOCUMENT_BYTES
    } else {
        MAX_TEXT_BYTES
    };
    if size > limit {
        return Err(PersistenceError::InvalidInput(format!(
            "knowledge file exceeds the {} MiB limit",
            limit / 1_024 / 1_024
        )));
    }
    Ok(())
}

fn is_supported(path: &Path) -> bool {
    let extension = extension(path);
    extension == "pdf"
        || extension == "docx"
        || SUPPORTED_TEXT_EXTENSIONS.contains(&extension.as_str())
}

fn is_code_path(path: &Path) -> bool {
    CODE_EXTENSIONS.contains(&extension(path).as_str())
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn media_type(path: &Path) -> &'static str {
    match extension(path).as_str() {
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "md" | "mdx" => "text/markdown",
        "json" | "jsonl" => "application/json",
        "yaml" | "yml" => "application/yaml",
        "xml" => "application/xml",
        "html" | "htm" => "text/html",
        "csv" => "text/csv",
        _ => "text/plain",
    }
}

fn hex_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
