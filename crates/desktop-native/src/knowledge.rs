use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use jieba_rs::Jieba;
use quick_xml::Reader;
use quick_xml::events::Event;
use rusqlite::ErrorCode;
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::persistence::{KnowledgeChunkInput, PersistenceError, Result, Store};

const MAX_TEXT_BYTES: u64 = 10 * 1_024 * 1_024;
const MAX_DOCUMENT_BYTES: u64 = 50 * 1_024 * 1_024;
const MAX_FOLDER_FILES: usize = 20_000;
const MAX_KNOWLEDGE_CHUNKS: usize = 50_000;
const TARGET_CHARS: usize = 1_400;
const OVERLAP_CHARS: usize = 240;
const HARD_MAX_CHARS: usize = 1_920;

const SUPPORTED_TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "mdx", "rst", "log", "json", "jsonl", "yaml", "yml", "xml", "html", "htm", "csv",
    "tsv", "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "java", "kt", "kts", "swift",
    "c", "h", "cc", "cpp", "hpp", "cs", "php", "rb", "sh", "bash", "zsh", "fish", "ps1", "sql",
    "toml", "ini", "conf", "css", "scss", "less", "vue", "svelte", "graphql", "gql",
];

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IndexResult {
    pub(super) indexed: usize,
    pub(super) skipped: usize,
    pub(super) errors: usize,
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
    let mut result = IndexResult {
        indexed: 0,
        skipped: 0,
        errors: 0,
    };
    let mut total_chunks = store
        .knowledge_documents(knowledge_base_id)?
        .iter()
        .map(|document| document.chunk_count as usize)
        .sum::<usize>();
    for raw_path in paths {
        let source_path = canonical_regular_file(Path::new(raw_path))?;
        let metadata = fs::metadata(&source_path)?;
        ensure_supported_size(&source_path, metadata.len())?;
        if !is_supported(&source_path) {
            result.skipped += 1;
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
    }
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
    let files = collect_folder_files(&root)?;
    let mut result = IndexResult {
        indexed: 0,
        skipped: 0,
        errors: 0,
    };
    let mut total_chunks = store
        .knowledge_documents(knowledge_base_id)?
        .iter()
        .map(|document| document.chunk_count as usize)
        .sum::<usize>();
    for path in files {
        let relative_path = path
            .strip_prefix(&root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        match index_file(
            store,
            knowledge_base_id,
            &source_id,
            &path,
            &relative_path,
            None,
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
                    &path,
                    &relative_path,
                    &error,
                )?;
                result.errors += 1;
            }
        }
    }
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
    let content = parse_content(path, &bytes)?;
    let chunks = chunk_content(&content);
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
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| i64::try_from(duration.as_secs()).ok())
        .unwrap_or_default();
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
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| i64::try_from(duration.as_secs()).ok())
        .unwrap_or_default();
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

fn parse_content(path: &Path, bytes: &[u8]) -> Result<String> {
    match extension(path).as_str() {
        "pdf" => pdf_extract::extract_text(path).map_err(|error| {
            PersistenceError::InvalidInput(format!("PDF text extraction failed: {error}"))
        }),
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
    Ok(strip_xml(&xml))
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
                if matches!(end.name().as_ref(), b"p" | b"h1" | b"h2" | b"h3" | b"tr") =>
            {
                output.push('\n')
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    output
}

fn chunk_content(content: &str) -> Vec<KnowledgeChunkInput> {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let mut chunks = Vec::new();
    let mut buffer = String::new();
    let mut heading: Option<String> = None;
    for block in normalized
        .split("\n\n")
        .map(str::trim)
        .filter(|block| !block.is_empty())
    {
        if let Some(first) = block.lines().next() {
            if first.starts_with('#') || (first.chars().count() <= 100 && first.ends_with(':')) {
                heading = Some(first.trim_start_matches('#').trim().to_owned());
            }
        }
        if buffer.chars().count() + block.chars().count() + 2 > TARGET_CHARS && !buffer.is_empty() {
            push_chunk(&mut chunks, &buffer, heading.clone());
            buffer = char_tail(&buffer, OVERLAP_CHARS);
            buffer.push_str("\n\n");
        }
        buffer.push_str(block);
        buffer.push_str("\n\n");
        while buffer.chars().count() > HARD_MAX_CHARS {
            let head = char_head(&buffer, HARD_MAX_CHARS);
            push_chunk(&mut chunks, &head, heading.clone());
            buffer = char_tail(&head, OVERLAP_CHARS) + &char_tail_after(&buffer, HARD_MAX_CHARS);
        }
    }
    if !buffer.trim().is_empty() {
        push_chunk(&mut chunks, buffer.trim(), heading);
    }
    chunks
}

fn push_chunk(chunks: &mut Vec<KnowledgeChunkInput>, content: &str, heading: Option<String>) {
    let content = content.trim();
    if content.is_empty() {
        return;
    }
    let search_text = searchable_text(content);
    chunks.push(KnowledgeChunkInput {
        ordinal: i64::try_from(chunks.len()).unwrap_or(i64::MAX),
        heading,
        page_number: None,
        content: content.to_owned(),
        search_text,
        content_hash: hex_sha256(content.as_bytes()),
    });
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

fn collect_folder_files(root: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() || ignored(&path) {
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

fn char_head(value: &str, count: usize) -> String {
    value.chars().take(count).collect()
}
fn char_tail(value: &str, count: usize) -> String {
    let length = value.chars().count();
    value.chars().skip(length.saturating_sub(count)).collect()
}
fn char_tail_after(value: &str, count: usize) -> String {
    value.chars().skip(count).collect()
}
