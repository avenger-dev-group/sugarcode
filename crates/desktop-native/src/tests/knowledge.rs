use std::fs;

use tempfile::tempdir;

use crate::knowledge;
use crate::persistence::{KnowledgeEmbeddingInput, Store};

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
    knowledge::add_managed_files(
        &mut store,
        &data.path().join("knowledge"),
        &knowledge_base_id,
        &[file.to_string_lossy().into_owned()],
    )
    .expect("index file");
    let chunks = store
        .knowledge_chunks_needing_embeddings(&knowledge_base_id, "test-model", 16)
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
        .save_knowledge_embeddings(&knowledge_base_id, "test-model", &inputs)
        .expect("save embeddings");
    store
        .set_knowledge_semantic_index_status(&knowledge_base_id, "test-model", "ready", None)
        .expect("semantic ready");
    assert!(
        store
            .semantic_indexes_ready(std::slice::from_ref(&knowledge_base_id), "test-model",)
            .expect("semantic status")
    );
    let query = knowledge::search_query("备份回滚").expect("fts query");
    let hits = store
        .search_knowledge_hybrid(
            std::slice::from_ref(&knowledge_base_id),
            None,
            &query,
            &vec![1.0 / 384_f32.sqrt(); 384],
            "test-model",
            8,
        )
        .expect("hybrid search");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].citation, "K1");
    assert!(hits[0].content.contains("回滚方案"));
}
