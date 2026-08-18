use crate::persistence::{
    KnowledgeChunkInput, KnowledgeEmbeddingInput, KnowledgeHybridSearchRequest, Store,
};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use tempfile::tempdir;

fn percentile(samples: &mut [Duration], percentile: usize) -> Duration {
    samples.sort_unstable();
    samples[(samples.len().saturating_sub(1) * percentile) / 100]
}

fn chunks(count: usize, namespace: usize) -> Vec<KnowledgeChunkInput> {
    (0..count)
        .map(|index| {
            let marker = if index % 997 == 0 {
                "releasepipeline searchable marker"
            } else {
                "ordinary indexed knowledge"
            };
            let content = format!("{marker} namespace {namespace} chunk {index}");
            KnowledgeChunkInput {
                ordinal: i64::try_from(index).expect("chunk ordinal"),
                heading: Some(format!("Section {}", index / 20)),
                page_number: None,
                content_kind: "text".to_owned(),
                language: None,
                start_line: None,
                end_line: None,
                estimated_tokens: 12,
                search_text: content.clone(),
                content_hash: format!("{:x}", Sha256::digest(content.as_bytes())),
                content,
            }
        })
        .collect()
}

fn add_benchmark_base(store: &mut Store, count: usize, namespace: usize) -> String {
    let knowledge_base_id = store
        .create_knowledge_base(&format!("Benchmark {namespace}"), "", &[])
        .expect("benchmark knowledge base");
    let source_id = store
        .create_knowledge_source(
            &knowledge_base_id,
            "managedFile",
            &format!("benchmark-{namespace}.txt"),
            &format!("benchmark-{namespace}.txt"),
        )
        .expect("benchmark source");
    let input = chunks(count, namespace);
    store
        .replace_knowledge_document(
            &knowledge_base_id,
            &source_id,
            &format!("benchmark-{namespace}.txt"),
            &format!("benchmark-{namespace}.txt"),
            "text/plain",
            i64::try_from(count * 64).expect("fixture bytes"),
            1,
            &"a".repeat(64),
            None,
            &input,
        )
        .expect("insert benchmark chunks");
    knowledge_base_id
}

#[test]
#[ignore = "performance benchmark"]
fn benchmark_full_text_search_over_fifty_thousand_chunks() {
    let directory = tempdir().expect("benchmark directory");
    let opened_at = Instant::now();
    let mut store = Store::open(directory.path()).expect("store");
    let cold_open = opened_at.elapsed();
    let fixture_started = Instant::now();
    let knowledge_base_id = add_benchmark_base(&mut store, 50_000, 1);
    let fixture_duration = fixture_started.elapsed();
    let ids = [knowledge_base_id];
    store
        .search_knowledge(&ids, None, "releasepipeline", 8)
        .expect("warm full-text search");
    let mut samples = Vec::with_capacity(30);
    for _ in 0..30 {
        let started = Instant::now();
        let hits = store
            .search_knowledge(&ids, None, "releasepipeline", 8)
            .expect("full-text search");
        assert!(!hits.is_empty());
        samples.push(started.elapsed());
    }
    let p50 = percentile(&mut samples.clone(), 50);
    let p95 = percentile(&mut samples, 95);
    eprintln!(
        "SUGARCODE_BENCH full_text_50k cold_open_ms={} fixture_ms={} p50_ms={} p95_ms={}",
        cold_open.as_millis(),
        fixture_duration.as_millis(),
        p50.as_micros() as f64 / 1_000.0,
        p95.as_micros() as f64 / 1_000.0,
    );
    assert!(
        p95 < Duration::from_millis(250),
        "50k FTS p95 exceeded 250 ms: {p95:?}"
    );
}

#[test]
#[ignore = "performance benchmark"]
fn benchmark_multi_knowledge_base_hybrid_search() {
    const DIMENSIONS: usize = 32;
    let directory = tempdir().expect("benchmark directory");
    let mut store = Store::open(directory.path()).expect("store");
    let knowledge_base_ids = (0..4)
        .map(|namespace| add_benchmark_base(&mut store, 2_500, namespace))
        .collect::<Vec<_>>();
    let vector = vec![1.0_f32 / (DIMENSIONS as f32).sqrt(); DIMENSIONS];
    for knowledge_base_id in &knowledge_base_ids {
        loop {
            let pending = store
                .knowledge_chunks_needing_embeddings(knowledge_base_id, "benchmark-model", "v1", 16)
                .expect("pending embeddings");
            if pending.is_empty() {
                break;
            }
            let embeddings = pending
                .into_iter()
                .map(|chunk| KnowledgeEmbeddingInput {
                    chunk_id: chunk.id,
                    content_hash: chunk.content_hash,
                    vector: vector.clone(),
                })
                .collect::<Vec<_>>();
            store
                .save_knowledge_embeddings(
                    knowledge_base_id,
                    "benchmark-model",
                    "v1",
                    DIMENSIONS,
                    &embeddings,
                )
                .expect("save benchmark embeddings");
        }
    }
    store
        .search_knowledge_hybrid(KnowledgeHybridSearchRequest {
            knowledge_base_ids: &knowledge_base_ids,
            semantic_knowledge_base_ids: &knowledge_base_ids,
            workspace_id: None,
            query: "releasepipeline",
            query_vector: &vector,
            model_id: "benchmark-model",
            model_version: "v1",
            limit: 8,
        })
        .expect("warm hybrid search");
    let mut samples = Vec::with_capacity(20);
    for _ in 0..20 {
        let started = Instant::now();
        let hits = store
            .search_knowledge_hybrid(KnowledgeHybridSearchRequest {
                knowledge_base_ids: &knowledge_base_ids,
                semantic_knowledge_base_ids: &knowledge_base_ids,
                workspace_id: None,
                query: "releasepipeline",
                query_vector: &vector,
                model_id: "benchmark-model",
                model_version: "v1",
                limit: 8,
            })
            .expect("hybrid search");
        assert!(!hits.is_empty());
        samples.push(started.elapsed());
    }
    let p50 = percentile(&mut samples.clone(), 50);
    let p95 = percentile(&mut samples, 95);
    eprintln!(
        "SUGARCODE_BENCH hybrid_4kb_10k_32d p50_ms={} p95_ms={}",
        p50.as_micros() as f64 / 1_000.0,
        p95.as_micros() as f64 / 1_000.0,
    );
    assert!(
        p95 < Duration::from_millis(750),
        "hybrid p95 exceeded 750 ms: {p95:?}"
    );
}

fn quantize_int8(vector: &[f32]) -> (Vec<i8>, f32) {
    let maximum = vector.iter().copied().map(f32::abs).fold(0.0_f32, f32::max);
    let scale = (maximum / 127.0).max(f32::EPSILON);
    (
        vector
            .iter()
            .map(|value| (value / scale).round().clamp(-127.0, 127.0) as i8)
            .collect(),
        scale,
    )
}

#[test]
fn int8_vector_storage_evaluation_preserves_cosine_scores() {
    let mut state = 0x5eed_u64;
    let vectors = (0..1_000)
        .map(|_| {
            let mut vector = (0..384)
                .map(|_| {
                    state = state
                        .wrapping_mul(6_364_136_223_846_793_005)
                        .wrapping_add(1);
                    ((state >> 32) as u32) as f32 / u32::MAX as f32 * 2.0 - 1.0
                })
                .collect::<Vec<_>>();
            let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
            for value in &mut vector {
                *value /= norm;
            }
            vector
        })
        .collect::<Vec<_>>();
    let query = &vectors[0];
    let exact = vectors
        .iter()
        .map(|vector| vector.iter().zip(query).map(|(a, b)| a * b).sum::<f32>())
        .collect::<Vec<_>>();
    let approximate = vectors
        .iter()
        .map(|vector| {
            let (quantized, scale) = quantize_int8(vector);
            quantized
                .iter()
                .zip(query)
                .map(|(value, query)| f32::from(*value) * scale * query)
                .sum::<f32>()
        })
        .collect::<Vec<_>>();
    let maximum_error = exact
        .iter()
        .zip(&approximate)
        .map(|(left, right)| (left - right).abs())
        .fold(0.0_f32, f32::max);
    let mut exact_order = (0..vectors.len()).collect::<Vec<_>>();
    exact_order.sort_by(|left, right| exact[*right].total_cmp(&exact[*left]));
    let mut approximate_order = (0..vectors.len()).collect::<Vec<_>>();
    approximate_order.sort_by(|left, right| approximate[*right].total_cmp(&approximate[*left]));
    let overlap = approximate_order[..10]
        .iter()
        .filter(|index| exact_order[..10].contains(index))
        .count();
    eprintln!(
        "SUGARCODE_VECTOR_EVAL dimensions=384 samples=1000 fp32_bytes={} int8_bytes={} max_dot_error={maximum_error:.6} recall_at_10={overlap}/10",
        384 * 4,
        384 + 4,
    );
    assert!(maximum_error < 0.01);
    assert!(overlap >= 9);
}
