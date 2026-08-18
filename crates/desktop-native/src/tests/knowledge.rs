use std::fs::{self, File};
use std::io::Write;
#[cfg(windows)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use lopdf::content::{Content, Operation};
use lopdf::{Document, Object, Stream, dictionary};
use tempfile::tempdir;
use zip::write::SimpleFileOptions;

use crate::knowledge;
use crate::persistence::{KnowledgeEmbeddingInput, KnowledgeHybridSearchRequest, Store};

#[test]
fn indexes_and_searches_chinese_and_code_content_without_a_model() {
    let data = tempdir().expect("data directory");
    let source = tempdir().expect("source directory");
    let file = source.path().join("产品规范.md");
    fs::write(
        &file,
        "# 登录流程\n\n用户登录后调用 createSessionToken，并将会话写入安全存储。\n\n# 退出\n\n退出时清理本地凭据。",
    )
    .expect("write fixture");
    let mut store = Store::open(data.path()).expect("store");
    let knowledge_base_id = store
        .create_knowledge_base("产品规范", "内部产品资料", &[])
        .expect("knowledge base");
    let indexed = knowledge::add_managed_files(
        &mut store,
        &data.path().join("knowledge"),
        &knowledge_base_id,
        &[file.to_string_lossy().into_owned()],
    )
    .expect("index file");
    assert_eq!(indexed.indexed, 1);
    let query = knowledge::search_query("登录 session token").expect("query");
    let hits = store
        .search_knowledge(&[knowledge_base_id], None, &query, 8)
        .expect("search");
    assert!(!hits.is_empty());
    assert!(hits[0].content.contains("createSessionToken"));
    assert_eq!(hits[0].citation, "K1");
}

#[test]
fn project_scope_is_enforced_and_linked_source_is_not_deleted() {
    let data = tempdir().expect("data directory");
    let source = tempdir().expect("source directory");
    let file = source.path().join("notes.txt");
    fs::write(&file, "private project knowledge marker").expect("write fixture");
    let mut store = Store::open(data.path()).expect("store");
    store
        .ensure_workspace("workspace-a", "/project/a")
        .expect("workspace a");
    store
        .ensure_workspace("workspace-b", "/project/b")
        .expect("workspace b");
    let knowledge_base_id = store
        .create_knowledge_base("项目知识", "", &["workspace-a".to_owned()])
        .expect("knowledge base");
    knowledge::add_linked_folder(
        &mut store,
        &knowledge_base_id,
        &source.path().to_string_lossy(),
    )
    .expect("index folder");
    let query = knowledge::search_query("private marker").expect("query");
    assert_eq!(
        store
            .search_knowledge(
                std::slice::from_ref(&knowledge_base_id),
                Some("workspace-a"),
                &query,
                8,
            )
            .expect("allowed search")
            .len(),
        1,
    );
    assert!(
        store
            .search_knowledge(
                std::slice::from_ref(&knowledge_base_id),
                Some("workspace-b"),
                &query,
                8,
            )
            .expect("isolated search")
            .is_empty(),
    );
    store
        .delete_knowledge_base(&knowledge_base_id)
        .expect("delete index");
    assert!(file.exists(), "linked source file must remain on disk");
}

#[test]
fn knowledge_read_rejects_documents_outside_the_explicit_selection() {
    let data = tempdir().expect("data directory");
    let source = tempdir().expect("source directory");
    let first_path = source.path().join("first.txt");
    let second_path = source.path().join("second.txt");
    fs::write(&first_path, "first selected knowledge").expect("first fixture");
    fs::write(&second_path, "second private knowledge").expect("second fixture");
    let mut store = Store::open(data.path()).expect("store");
    let first_id = store
        .create_knowledge_base("First", "", &[])
        .expect("first knowledge base");
    let second_id = store
        .create_knowledge_base("Second", "", &[])
        .expect("second knowledge base");
    knowledge::add_managed_files(
        &mut store,
        &data.path().join("knowledge"),
        &first_id,
        &[first_path.to_string_lossy().into_owned()],
    )
    .expect("index first fixture");
    knowledge::add_managed_files(
        &mut store,
        &data.path().join("knowledge"),
        &second_id,
        &[second_path.to_string_lossy().into_owned()],
    )
    .expect("index second fixture");
    let second_document = store
        .knowledge_documents(&second_id)
        .expect("second documents")
        .into_iter()
        .next()
        .expect("second document");

    let denied = store
        .read_knowledge_document(
            std::slice::from_ref(&first_id),
            None,
            &second_document.id,
            0,
        )
        .expect("unselected document lookup remains indistinguishable from a missing document");
    assert!(
        denied.is_empty(),
        "unselected document content must not leak"
    );
    let allowed = store
        .read_knowledge_document(
            std::slice::from_ref(&second_id),
            None,
            &second_document.id,
            0,
        )
        .expect("selected document is readable");
    assert!(allowed[0].content.contains("second private knowledge"));
}

#[test]
fn semantic_vectors_are_isolated_per_knowledge_base_and_fused_with_fts() {
    let data = tempdir().expect("data directory");
    let source = tempdir().expect("source directory");
    let file = source.path().join("semantic.md");
    fs::write(
        &file,
        "# 发布流程\n\n上线前必须执行数据库备份，并准备回滚方案。",
    )
    .expect("write fixture");
    let mut store = Store::open(data.path()).expect("store");
    let knowledge_base_id = store
        .create_knowledge_base("发布规范", "", &[])
        .expect("knowledge base");
    store
        .update_knowledge_base(&knowledge_base_id, "发布规范", "", &[], &[], Some(true))
        .expect("enable shared semantic model");
    knowledge::add_managed_files(
        &mut store,
        &data.path().join("knowledge"),
        &knowledge_base_id,
        &[file.to_string_lossy().into_owned()],
    )
    .expect("index file");
    let chunks = store
        .knowledge_chunks_needing_embeddings(&knowledge_base_id, "test/model", "test-version", 16)
        .expect("embedding chunks");
    assert!(!chunks.is_empty());
    let inputs = chunks
        .iter()
        .map(|chunk| KnowledgeEmbeddingInput {
            chunk_id: chunk.id.clone(),
            content_hash: chunk.content_hash.clone(),
            vector: vec![1.0 / 384_f32.sqrt(); 384],
        })
        .collect::<Vec<_>>();
    store
        .save_knowledge_embeddings(
            &knowledge_base_id,
            "test/model",
            "test-version",
            384,
            &inputs,
        )
        .expect("save embeddings");
    let bge_inputs = chunks
        .iter()
        .map(|chunk| KnowledgeEmbeddingInput {
            chunk_id: chunk.id.clone(),
            content_hash: chunk.content_hash.clone(),
            vector: vec![1.0 / 512_f32.sqrt(); 512],
        })
        .collect::<Vec<_>>();
    store
        .save_knowledge_embeddings(
            &knowledge_base_id,
            "BAAI/bge-small-zh-v1.5",
            "bge-test-version",
            512,
            &bge_inputs,
        )
        .expect("save 512-dimensional embeddings alongside 384-dimensional embeddings");
    store
        .set_knowledge_semantic_index_status(
            &knowledge_base_id,
            "test/model",
            "test-version",
            "ready",
            None,
        )
        .expect("semantic ready");
    assert!(
        store
            .semantic_indexes_ready(
                std::slice::from_ref(&knowledge_base_id),
                "test/model",
                "test-version",
            )
            .expect("semantic status")
    );
    let full_text_only_id = store
        .create_knowledge_base("仅全文", "", &[])
        .expect("full-text-only knowledge base");
    let ready = store
        .semantic_ready_knowledge_base_ids(
            &[knowledge_base_id.clone(), full_text_only_id],
            "test/model",
            "test-version",
        )
        .expect("per-knowledge-base semantic readiness");
    assert_eq!(ready, vec![knowledge_base_id.clone()]);
    assert!(
        store
            .knowledge_chunks_needing_embeddings(
                &knowledge_base_id,
                "BAAI/bge-small-zh-v1.5",
                "bge-test-version",
                16,
            )
            .expect("BGE embedding state")
            .is_empty(),
        "model-specific embeddings must coexist for the same chunk"
    );
    let query = knowledge::search_query("备份回滚").expect("fts query");
    let hits = store
        .search_knowledge_hybrid(KnowledgeHybridSearchRequest {
            knowledge_base_ids: std::slice::from_ref(&knowledge_base_id),
            semantic_knowledge_base_ids: std::slice::from_ref(&knowledge_base_id),
            workspace_id: None,
            query: &query,
            query_vector: &vec![1.0 / 384_f32.sqrt(); 384],
            model_id: "test/model",
            model_version: "test-version",
            limit: 8,
        })
        .expect("hybrid search");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].citation, "K1");
    assert!(hits[0].content.contains("回滚方案"));
}

#[test]
fn linked_folder_rescan_is_incremental_deletes_stale_documents_and_recovers_disconnects() {
    let data = tempdir().expect("data directory");
    let source_parent = tempdir().expect("source parent");
    let source = source_parent.path().join("linked");
    fs::create_dir(&source).expect("source directory");
    let first = source.join("first.md");
    fs::write(&first, "# First\n\noriginal searchable marker").expect("first fixture");
    let mut store = Store::open(data.path()).expect("store");
    let knowledge_base_id = store
        .create_knowledge_base("增量资料", "", &[])
        .expect("knowledge base");
    let initial =
        knowledge::add_linked_folder(&mut store, &knowledge_base_id, &source.to_string_lossy())
            .expect("initial index");
    assert_eq!(initial.indexed, 1);
    assert!(initial.job_id.is_some());
    let source_id = store
        .knowledge_sources(&knowledge_base_id)
        .expect("sources")[0]
        .id
        .clone();
    let initial_document = store
        .knowledge_documents_for_source(&source_id)
        .expect("documents")[0]
        .clone();

    let unchanged = knowledge::rescan_linked_source(&mut store, &source_id, "rescan")
        .expect("unchanged rescan");
    assert_eq!(unchanged.indexed, 0);
    assert_eq!(unchanged.skipped, 1);
    assert_eq!(
        store
            .knowledge_documents_for_source(&source_id)
            .expect("unchanged documents")[0]
            .id,
        initial_document.id,
        "size/mtime matches must avoid replacing the indexed document",
    );

    fs::write(
        &first,
        "# First\n\nupdated searchable marker with a different size",
    )
    .expect("modify first");
    let second = source.join("second.txt");
    fs::write(&second, "newly added marker").expect("second fixture");
    let changed = knowledge::rescan_linked_source(&mut store, &source_id, "incremental")
        .expect("changed rescan");
    assert_eq!(changed.indexed, 2);
    assert_eq!(
        store
            .knowledge_documents_for_source(&source_id)
            .expect("changed documents")
            .len(),
        2,
    );

    fs::remove_file(&first).expect("remove first");
    let removed = knowledge::rescan_linked_source(&mut store, &source_id, "incremental")
        .expect("removed rescan");
    assert_eq!(removed.deleted, 1);
    assert_eq!(
        store
            .knowledge_documents_for_source(&source_id)
            .expect("remaining documents")[0]
            .relative_path,
        "second.txt",
    );

    let disconnected = source_parent.path().join("disconnected");
    fs::rename(&source, &disconnected).expect("disconnect folder");
    let unavailable = knowledge::rescan_linked_source(&mut store, &source_id, "rescan")
        .expect("disconnected rescan remains inspectable");
    assert_eq!(unavailable.errors, 1);
    assert_eq!(
        store
            .knowledge_source(&source_id)
            .expect("disconnected source")
            .status,
        "disconnected",
    );
    assert_eq!(
        store
            .knowledge_documents_for_source(&source_id)
            .expect("preserved disconnected index")
            .len(),
        1,
    );
    fs::rename(&disconnected, &source).expect("restore folder");
    knowledge::rescan_linked_source(&mut store, &source_id, "rescan").expect("restored rescan");
    assert_eq!(
        store
            .knowledge_source(&source_id)
            .expect("restored source")
            .status,
        "ready",
    );
}

#[test]
fn custom_ignore_rules_remove_matching_linked_documents() {
    let data = tempdir().expect("data directory");
    let source = tempdir().expect("source directory");
    fs::write(source.path().join("keep.md"), "keep marker").expect("keep fixture");
    fs::write(source.path().join("private.md"), "private marker").expect("private fixture");
    let mut store = Store::open(data.path()).expect("store");
    let knowledge_base_id = store
        .create_knowledge_base("忽略规则", "", &[])
        .expect("knowledge base");
    knowledge::add_linked_folder(
        &mut store,
        &knowledge_base_id,
        &source.path().to_string_lossy(),
    )
    .expect("initial index");
    let source_id = store
        .knowledge_sources(&knowledge_base_id)
        .expect("sources")[0]
        .id
        .clone();
    store
        .update_knowledge_base(
            &knowledge_base_id,
            "忽略规则",
            "updated",
            &[],
            &["private.*".to_owned()],
            None,
        )
        .expect("update ignore rules");
    let result =
        knowledge::rescan_linked_source(&mut store, &source_id, "rescan").expect("ignore rescan");
    assert_eq!(result.deleted, 1);
    let documents = store
        .knowledge_documents_for_source(&source_id)
        .expect("filtered documents");
    assert_eq!(documents.len(), 1);
    assert_eq!(documents[0].relative_path, "keep.md");
}

#[test]
fn managed_file_reference_count_survives_deleting_one_knowledge_base() {
    let data = tempdir().expect("data directory");
    let source = tempdir().expect("source directory");
    let file = source.path().join("shared.md");
    fs::write(&file, "shared managed marker").expect("shared fixture");
    let mut store = Store::open(data.path()).expect("store");
    let first = store
        .create_knowledge_base("共享一", "", &[])
        .expect("first base");
    let second = store
        .create_knowledge_base("共享二", "", &[])
        .expect("second base");
    for knowledge_base_id in [&first, &second] {
        knowledge::add_managed_files(
            &mut store,
            &data.path().join("knowledge"),
            knowledge_base_id,
            &[file.to_string_lossy().into_owned()],
        )
        .expect("managed index");
    }
    let managed_path = store.knowledge_sources(&first).expect("first source")[0]
        .path
        .clone();
    assert_eq!(
        store
            .managed_path_reference_count(&managed_path)
            .expect("refs"),
        2
    );
    store
        .delete_knowledge_base(&first)
        .expect("delete first base");
    assert_eq!(
        store
            .managed_path_reference_count(&managed_path)
            .expect("remaining ref"),
        1,
    );
    assert!(std::path::Path::new(&managed_path).exists());
}

#[test]
fn managed_text_documents_are_created_and_edited_with_copy_on_write() {
    let data = tempdir().expect("data directory");
    let knowledge_root = data.path().join("knowledge");
    let mut store = Store::open(data.path()).expect("store");
    let first = store
        .create_knowledge_base("可编辑一", "", &[])
        .expect("first base");
    let second = store
        .create_knowledge_base("可编辑二", "", &[])
        .expect("second base");
    for knowledge_base_id in [&first, &second] {
        let result = knowledge::create_managed_text_document(
            &mut store,
            &knowledge_root,
            knowledge_base_id,
            "公司信息.md",
            "# 公司信息\n\n公司电话：10086",
        )
        .expect("create managed text");
        assert_eq!(result.indexed, 1);
    }
    let first_source = store.knowledge_sources(&first).expect("first source")[0].clone();
    let second_source = store.knowledge_sources(&second).expect("second source")[0].clone();
    assert_eq!(first_source.path, second_source.path);
    let original =
        knowledge::read_managed_text_document(&mut store, &knowledge_root, &first_source.id)
            .expect("read original");
    let update = knowledge::update_managed_text_document(
        &mut store,
        &knowledge_root,
        &first_source.id,
        &original.sha256,
        "# 公司信息\n\n公司电话：12345",
    )
    .expect("update managed text");
    assert_eq!(update.result.indexed, 1);
    assert_eq!(update.old_path, first_source.path);

    let updated_first =
        knowledge::read_managed_text_document(&mut store, &knowledge_root, &first_source.id)
            .expect("read updated first");
    let unchanged_second =
        knowledge::read_managed_text_document(&mut store, &knowledge_root, &second_source.id)
            .expect("read unchanged second");
    assert!(updated_first.content.contains("12345"));
    assert!(unchanged_second.content.contains("10086"));
    assert_ne!(
        store
            .knowledge_source(&first_source.id)
            .expect("first path")
            .path,
        store
            .knowledge_source(&second_source.id)
            .expect("second path")
            .path,
    );
    assert!(
        knowledge::update_managed_text_document(
            &mut store,
            &knowledge_root,
            &first_source.id,
            &original.sha256,
            "# 公司信息\n\n过期覆盖",
        )
        .is_err()
    );
    assert!(
        knowledge::create_managed_text_document(
            &mut store,
            &knowledge_root,
            &first,
            "../escape.md",
            "unsafe",
        )
        .is_err()
    );
}

#[test]
fn linked_folder_watcher_debounces_changes_and_runs_incremental_indexing() {
    let data = tempdir().expect("data directory");
    let source = tempdir().expect("source directory");
    fs::write(source.path().join("initial.md"), "initial marker").expect("initial fixture");
    let (knowledge_base_id, source_id) = {
        let mut store = Store::open(data.path()).expect("store");
        let knowledge_base_id = store
            .create_knowledge_base("监听资料", "", &[])
            .expect("knowledge base");
        knowledge::add_linked_folder(
            &mut store,
            &knowledge_base_id,
            &source.path().to_string_lossy(),
        )
        .expect("initial index");
        let source_id = store
            .knowledge_sources(&knowledge_base_id)
            .expect("sources")[0]
            .id
            .clone();
        (knowledge_base_id, source_id)
    };
    let mut poll_store = Store::open_worker(data.path()).expect("poll store");
    let watcher = knowledge::KnowledgeWatcher::start(
        PathBuf::from(data.path()),
        &[source.path().to_path_buf()],
        Arc::new(Mutex::new(())),
    )
    .expect("watcher");

    let initial_deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if poll_store
            .knowledge_index_jobs(&knowledge_base_id)
            .expect("initial watch jobs")
            .iter()
            .any(|job| job.kind == "incremental" && job.status == "completed")
        {
            break;
        }
        assert!(
            Instant::now() < initial_deadline,
            "watcher did not complete its initial scan"
        );
        thread::sleep(Duration::from_millis(100));
    }

    fs::write(
        source.path().join("changed.md"),
        "watched incremental marker",
    )
    .expect("watched fixture");

    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if poll_store
            .knowledge_documents_for_source(&source_id)
            .expect("watched documents")
            .iter()
            .any(|document| document.relative_path == "changed.md")
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "watcher did not index the changed file"
        );
        thread::sleep(Duration::from_millis(100));
    }
    assert!(
        poll_store
            .knowledge_index_jobs(&knowledge_base_id)
            .expect("watch jobs")
            .iter()
            .any(|job| job.kind == "incremental" && job.status == "completed"),
    );
    drop(poll_store);
    drop(watcher);
}

#[cfg(windows)]
#[test]
fn linked_folder_watcher_matches_windows_verbatim_and_event_paths() {
    assert!(knowledge::watch_paths_overlap(
        Path::new(r"C:\Users\runner\source\changed.md"),
        Path::new(r"\\?\C:\Users\Runner\source"),
    ));
    assert!(knowledge::watch_paths_overlap(
        Path::new(r"\\server\share\source\changed.md"),
        Path::new(r"\\?\UNC\server\share\source"),
    ));
    assert!(!knowledge::watch_paths_overlap(
        Path::new(r"C:\Users\runner\source-other\changed.md"),
        Path::new(r"\\?\C:\Users\runner\source"),
    ));
}

#[test]
fn docx_heading_hierarchy_and_code_line_metadata_are_preserved() {
    let data = tempdir().expect("data directory");
    let source = tempdir().expect("source directory");
    let docx = source.path().join("headings.docx");
    {
        let file = fs::File::create(&docx).expect("docx file");
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file("word/document.xml", SimpleFileOptions::default())
            .expect("docx entry");
        archive
            .write_all(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
                  <w:body>
                    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>产品规范</w:t></w:r></w:p>
                    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>登录流程</w:t></w:r></w:p>
                    <w:p><w:r><w:t>登录必须创建安全会话。</w:t></w:r></w:p>
                  </w:body>
                </w:document>"#
                    .as_bytes(),
            )
            .expect("docx XML");
        archive.finish().expect("finish docx");
    }
    let code = source.path().join("session.rs");
    fs::write(
        &code,
        "pub fn create_session_token() -> String {\n    \"token\".to_owned()\n}\n",
    )
    .expect("code fixture");
    let mut store = Store::open(data.path()).expect("store");
    let knowledge_base_id = store
        .create_knowledge_base("结构元数据", "", &[])
        .expect("knowledge base");
    knowledge::add_managed_files(
        &mut store,
        &data.path().join("knowledge"),
        &knowledge_base_id,
        &[
            docx.to_string_lossy().into_owned(),
            code.to_string_lossy().into_owned(),
        ],
    )
    .expect("index structured fixtures");
    let documents = store
        .knowledge_documents(&knowledge_base_id)
        .expect("documents");
    let docx_document = documents
        .iter()
        .find(|document| document.file_name == "headings.docx")
        .expect("docx document");
    let docx_chunks = store
        .read_knowledge_document(
            std::slice::from_ref(&knowledge_base_id),
            None,
            &docx_document.id,
            0,
        )
        .expect("docx chunks");
    assert_eq!(
        docx_chunks[0].heading.as_deref(),
        Some("产品规范 > 登录流程")
    );
    assert!(docx_chunks[0].content.contains("安全会话"));

    let code_document = documents
        .iter()
        .find(|document| document.file_name == "session.rs")
        .expect("code document");
    let code_chunks = store
        .read_knowledge_document(
            std::slice::from_ref(&knowledge_base_id),
            None,
            &code_document.id,
            0,
        )
        .expect("code chunks");
    assert_eq!(code_chunks[0].content_kind, "code");
    assert_eq!(code_chunks[0].language.as_deref(), Some("rs"));
    assert_eq!(code_chunks[0].start_line, Some(1));
    assert_eq!(code_chunks[0].end_line, Some(3));
    assert!(
        code_chunks[0]
            .heading
            .as_deref()
            .is_some_and(|heading| heading.starts_with("pub fn create_session_token")),
    );
}

#[test]
fn pdf_chunks_preserve_one_based_page_numbers() {
    let data = tempdir().expect("data directory");
    let source = tempdir().expect("source directory");
    let pdf = source.path().join("pages.pdf");
    let mut document = Document::with_version("1.5");
    let pages_id = document.new_object_id();
    let font_id = document.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    });
    let resources_id = document.add_object(dictionary! {
        "Font" => dictionary! { "F1" => font_id },
    });
    let mut page_ids = Vec::new();
    for text in ["first page marker", "second page marker"] {
        let content = Content {
            operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec![Object::Name(b"F1".to_vec()), 12.into()]),
                Operation::new("Td", vec![72.into(), 720.into()]),
                Operation::new("Tj", vec![Object::string_literal(text)]),
                Operation::new("ET", vec![]),
            ],
        };
        let content_id = document.add_object(Stream::new(
            dictionary! {},
            content.encode().expect("encode PDF content"),
        ));
        page_ids.push(document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Resources" => resources_id,
            "Contents" => content_id,
        }));
    }
    document.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => page_ids.iter().copied().map(Object::Reference).collect::<Vec<_>>(),
            "Count" => i64::try_from(page_ids.len()).expect("page count"),
        }),
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    document.trailer.set("Root", catalog_id);
    document.compress();
    document.save(&pdf).expect("save PDF");

    let mut store = Store::open(data.path()).expect("store");
    let knowledge_base_id = store
        .create_knowledge_base("PDF 页码", "", &[])
        .expect("knowledge base");
    knowledge::add_managed_files(
        &mut store,
        &data.path().join("knowledge"),
        &knowledge_base_id,
        &[pdf.to_string_lossy().into_owned()],
    )
    .expect("index PDF");
    let indexed = store
        .knowledge_documents(&knowledge_base_id)
        .expect("PDF document");
    let chunks = store
        .read_knowledge_document(
            std::slice::from_ref(&knowledge_base_id),
            None,
            &indexed[0].id,
            0,
        )
        .expect("PDF chunks");
    assert_eq!(
        chunks
            .iter()
            .map(|chunk| chunk.page_number)
            .collect::<Vec<_>>(),
        vec![Some(1), Some(2)],
    );
    assert!(chunks[1].content.contains("second page marker"));
}

#[test]
fn interrupted_index_jobs_recover_paused_and_remain_retryable() {
    let data = tempdir().expect("data directory");
    let (knowledge_base_id, job_id) = {
        let mut store = Store::open(data.path()).expect("store");
        let knowledge_base_id = store
            .create_knowledge_base("任务恢复", "", &[])
            .expect("knowledge base");
        let job_id = store
            .create_knowledge_index_job(&knowledge_base_id, None, "rescan")
            .expect("index job");
        assert!(store.start_knowledge_index_job(&job_id).expect("start job"));
        (knowledge_base_id, job_id)
    };
    let mut reopened = Store::open(data.path()).expect("reopen store");
    let job = reopened
        .knowledge_index_jobs(&knowledge_base_id)
        .expect("recovered jobs")
        .into_iter()
        .find(|job| job.id == job_id)
        .expect("recovered job");
    assert_eq!(job.status, "paused");
    assert_eq!(job.last_error.as_deref(), Some("runtimeRestart"));
    assert!(
        reopened
            .start_knowledge_index_job(&job_id)
            .expect("resume job")
    );
    assert!(
        reopened
            .request_knowledge_index_job_cancel(&job_id)
            .expect("cancel job"),
    );
    assert!(
        reopened
            .update_knowledge_index_job_progress(&job_id, 1, 0, 0, 0, 0, 0)
            .expect("observe cancellation"),
    );
}

#[cfg(unix)]
#[test]
fn linked_knowledge_folder_never_follows_file_or_directory_symlinks() {
    use std::os::unix::fs::symlink;

    let data = tempdir().expect("data directory");
    let source = tempdir().expect("source directory");
    let outside = tempdir().expect("outside directory");
    fs::write(source.path().join("inside.txt"), "inside marker").expect("inside fixture");
    fs::write(outside.path().join("secret.txt"), "outside secret marker").expect("outside fixture");
    symlink(
        outside.path().join("secret.txt"),
        source.path().join("linked-secret.txt"),
    )
    .expect("file symlink");
    symlink(outside.path(), source.path().join("linked-directory")).expect("directory symlink");
    let mut store = Store::open(data.path()).expect("store");
    let knowledge_base_id = store
        .create_knowledge_base("Symlink safety", "", &[])
        .expect("knowledge base");
    knowledge::add_linked_folder(
        &mut store,
        &knowledge_base_id,
        &source.path().to_string_lossy(),
    )
    .expect("index linked folder");

    let documents = store
        .knowledge_documents(&knowledge_base_id)
        .expect("knowledge documents");
    assert_eq!(documents.len(), 1);
    assert_eq!(documents[0].file_name, "inside.txt");
    let outside_query = knowledge::search_query("outside secret").expect("outside query");
    assert!(
        store
            .search_knowledge(
                std::slice::from_ref(&knowledge_base_id),
                None,
                &outside_query,
                8,
            )
            .expect("outside search")
            .is_empty()
    );
}

#[test]
fn malicious_knowledge_files_are_bounded_and_record_parse_errors() {
    let data = tempdir().expect("data directory");
    let source = tempdir().expect("source directory");
    let invalid_utf8 = source.path().join("invalid.txt");
    fs::write(&invalid_utf8, [0xff, 0xfe, 0xfd]).expect("invalid UTF-8 fixture");
    let oversized = source.path().join("oversized.txt");
    File::create(&oversized)
        .and_then(|file| file.set_len(11 * 1024 * 1024))
        .expect("oversized sparse fixture");
    let docx = source.path().join("expansion.docx");
    let file = File::create(&docx).expect("DOCX fixture");
    let mut archive = zip::ZipWriter::new(file);
    archive
        .start_file(
            "word/document.xml",
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
        )
        .expect("DOCX body");
    let block = vec![b'a'; 1024 * 1024];
    for _ in 0..17 {
        archive.write_all(&block).expect("expanded DOCX body");
    }
    archive.finish().expect("finish DOCX");
    let mut store = Store::open(data.path()).expect("store");
    let knowledge_base_id = store
        .create_knowledge_base("Malicious files", "", &[])
        .expect("knowledge base");

    let result = knowledge::add_managed_files(
        &mut store,
        &data.path().join("knowledge"),
        &knowledge_base_id,
        &[
            invalid_utf8.to_string_lossy().into_owned(),
            oversized.to_string_lossy().into_owned(),
            docx.to_string_lossy().into_owned(),
        ],
    )
    .expect("malicious files are isolated as per-file errors");
    assert_eq!(result.indexed, 0);
    assert_eq!(result.errors, 3);
    let documents = store
        .knowledge_documents(&knowledge_base_id)
        .expect("error documents");
    assert_eq!(documents.len(), 2);
    assert!(
        documents
            .iter()
            .all(|document| document.parse_status == "error")
    );
    assert!(documents.iter().all(|document| document.chunk_count == 0));
}
