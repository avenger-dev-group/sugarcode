use futures_util::StreamExt;
use ndarray::Array2;
use ort::{
    session::{Session, builder::GraphOptimizationLevel},
    value::Value,
};
use reqwest::header::RANGE;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use sysinfo::System;
use tokenizers::{PaddingParams, PaddingStrategy, Tokenizer, TruncationParams};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use crate::persistence::{KnowledgeEmbeddingInput, Store};
use crate::semantic_catalog::{
    DEFAULT_SEMANTIC_MODEL_ID, MULTILINGUAL_E5_SMALL, ModelFileDefinition, PoolingStrategy,
    SemanticModelDefinition, package_size as model_package_size, semantic_model,
};

const MODEL: &SemanticModelDefinition = &MULTILINGUAL_E5_SMALL;
const INDEX_DISK_BUDGET: u64 = 512 * 1024 * 1024;
const MANIFEST_SCHEMA_VERSION: u8 = 1;
const DOWNLOAD_ATTEMPTS: u8 = 3;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInspection {
    architecture: String,
    logical_cores: usize,
    total_memory_bytes: u64,
    available_memory_bytes: u64,
    available_disk_bytes: u64,
    required_disk_bytes: u64,
    supported: bool,
    recommended: bool,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticModelState {
    state: String,
    enabled: bool,
    model_id: String,
    version: String,
    revision: String,
    dimensions: u16,
    runtime: String,
    variant: String,
    downloaded_bytes: u64,
    total_bytes: u64,
    installed_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    device: DeviceInspection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledManifest {
    schema_version: u8,
    model_id: String,
    version: String,
    revision: String,
    dimensions: u16,
    runtime: String,
    variant: String,
    installed_at: u64,
    files: Vec<InstalledFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledFile {
    path: String,
    size: u64,
    sha256: String,
}

struct RuntimeState {
    phase: String,
    downloaded_bytes: u64,
    error: Option<String>,
    cancellation: Option<CancellationToken>,
}

struct LoadedModel {
    model: LocalEmbeddingModel,
    model_id: &'static str,
    model_version: &'static str,
    last_used_at: SystemTime,
}

struct LocalEmbeddingModel {
    tokenizer: Tokenizer,
    session: Session,
    needs_token_type_ids: bool,
    dimensions: usize,
    pooling: PoolingStrategy,
}

#[derive(Clone)]
pub struct SemanticModelManager {
    root: PathBuf,
    active_model: Arc<Mutex<&'static SemanticModelDefinition>>,
    state: Arc<Mutex<RuntimeState>>,
    loaded: Arc<Mutex<Option<LoadedModel>>>,
}

impl SemanticModelManager {
    pub fn open(data_directory: &Path) -> std::io::Result<Self> {
        let root = data_directory.join("models").join("semantic");
        std::fs::create_dir_all(&root)?;
        migrate_legacy_default_layout(&root)?;
        let model = semantic_model(DEFAULT_SEMANTIC_MODEL_ID).unwrap_or(MODEL);
        let ready = installed_manifest_path(&root, model).is_file()
            && validate_installed_layout(&root, model).is_ok();
        let downloaded_bytes = if ready {
            model_package_size(model)
        } else {
            resumable_bytes(&root, model)
        };
        let loaded = Arc::new(Mutex::new(None::<LoadedModel>));
        let weak_loaded = Arc::downgrade(&loaded);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_secs(60));
                let Some(loaded) = weak_loaded.upgrade() else {
                    break;
                };
                let mut guard = loaded
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if guard.as_ref().is_some_and(|model| {
                    model.last_used_at.elapsed().unwrap_or_default().as_secs() >= 5 * 60
                }) {
                    *guard = None;
                }
            }
        });
        Ok(Self {
            root,
            active_model: Arc::new(Mutex::new(model)),
            state: Arc::new(Mutex::new(RuntimeState {
                phase: if ready { "ready" } else { "notInstalled" }.to_owned(),
                downloaded_bytes,
                error: None,
                cancellation: None,
            })),
            loaded,
        })
    }

    pub fn inspect(&self) -> SemanticModelState {
        let model = self.active_model();
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let ready = state.phase == "ready";
        SemanticModelState {
            state: state.phase.clone(),
            enabled: ready,
            model_id: model.id.to_owned(),
            version: model.version.to_owned(),
            revision: model.revision.to_owned(),
            dimensions: model.dimensions,
            runtime: "ONNX Runtime CPU".to_owned(),
            variant: "INT8 优化".to_owned(),
            downloaded_bytes: state.downloaded_bytes.min(model_package_size(model)),
            total_bytes: model_package_size(model),
            installed_bytes: if ready { model_package_size(model) } else { 0 },
            error: state.error.clone(),
            device: inspect_device(&self.root, model),
        }
    }

    pub fn select_model(&self, model_id: &str) -> Result<(), String> {
        let model = semantic_model(model_id).ok_or_else(|| "未知的语义模型。".to_owned())?;
        {
            let state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.phase == "downloading" {
                return Err("请先取消正在进行的模型下载。".to_owned());
            }
        }
        *self
            .active_model
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = model;
        *self
            .loaded
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        let ready = installed_manifest_path(&self.root, model).is_file()
            && validate_installed_layout(&self.root, model).is_ok();
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.phase = if ready { "ready" } else { "notInstalled" }.to_owned();
        state.downloaded_bytes = if ready {
            model_package_size(model)
        } else {
            resumable_bytes(&self.root, model)
        };
        state.error = None;
        state.cancellation = None;
        Ok(())
    }

    pub async fn install(&self) -> Result<(), String> {
        let model = self.active_model();
        let device = inspect_device(&self.root, model);
        if !device.supported {
            return Err("当前 CPU 架构不受共享语义模型支持。".to_owned());
        }
        if device.available_disk_bytes < device.required_disk_bytes {
            return Err("可用磁盘空间不足，无法安全下载并校验共享模型。".to_owned());
        }
        let cancellation = CancellationToken::new();
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.phase == "downloading" {
                return Err("共享模型已经在下载。".to_owned());
            }
            if state.phase == "ready" {
                return Ok(());
            }
            state.phase = "downloading".to_owned();
            state.downloaded_bytes = resumable_bytes(&self.root, model);
            state.error = None;
            state.cancellation = Some(cancellation.clone());
        }

        let result = download_and_install(&self.root, model, &self.state, &cancellation).await;
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.cancellation = None;
        match result {
            Ok(()) => {
                state.phase = "ready".to_owned();
                state.downloaded_bytes = model_package_size(model);
                state.error = None;
                Ok(())
            }
            Err(InstallError::Cancelled) => {
                state.phase = "notInstalled".to_owned();
                state.downloaded_bytes = resumable_bytes(&self.root, model);
                state.error = None;
                Err("cancelled".to_owned())
            }
            Err(InstallError::Failure(message)) => {
                state.phase = "error".to_owned();
                state.downloaded_bytes = resumable_bytes(&self.root, model);
                state.error = Some(message.clone());
                Err(message)
            }
        }
    }

    pub fn cancel(&self) -> bool {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match &state.cancellation {
            Some(cancellation) => {
                cancellation.cancel();
                true
            }
            None => false,
        }
    }

    pub fn remove(&self) -> Result<(), String> {
        let model = self.active_model();
        {
            let state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.phase == "downloading" {
                return Err("请先取消正在进行的模型下载。".to_owned());
            }
        }
        *self
            .loaded
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        for path in [
            installed_directory(&self.root, model),
            staging_directory(&self.root, model),
        ] {
            if path.exists() {
                std::fs::remove_dir_all(&path).map_err(|error| error.to_string())?;
            }
        }
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.phase = "notInstalled".to_owned();
        state.downloaded_bytes = 0;
        state.error = None;
        Ok(())
    }

    pub fn is_ready(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .phase
            == "ready"
    }

    pub fn is_model_ready(&self, model_id: &str, model_version: &str) -> bool {
        semantic_model(model_id).is_some_and(|model| {
            model.version == model_version && validate_installed_layout(&self.root, model).is_ok()
        })
    }

    pub fn model_id(&self) -> &'static str {
        self.active_model().id
    }

    pub fn model_version(&self) -> &'static str {
        self.active_model().version
    }

    pub fn dimensions(&self) -> usize {
        usize::from(self.active_model().dimensions)
    }

    pub fn embed_passages(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let model = self.active_model();
        self.embed_with_prefix(model, model.passage_prefix, texts)
    }

    pub fn embed_query_for(
        &self,
        model_id: &str,
        model_version: &str,
        query: &str,
    ) -> Result<Vec<f32>, String> {
        let model = semantic_model(model_id).ok_or_else(|| "未知的语义模型。".to_owned())?;
        if model.version != model_version {
            return Err("语义模型版本与索引不匹配。".to_owned());
        }
        self.embed_with_prefix(model, model.query_prefix, &[query.to_owned()])?
            .into_iter()
            .next()
            .ok_or_else(|| "语义模型没有返回查询向量。".to_owned())
    }

    fn embed_with_prefix(
        &self,
        definition: &'static SemanticModelDefinition,
        prefix: &str,
        texts: &[String],
    ) -> Result<Vec<Vec<f32>>, String> {
        if texts.is_empty() || texts.len() > 16 {
            return Err("语义编码批次必须包含 1 到 16 条文本。".to_owned());
        }
        if validate_installed_layout(&self.root, definition).is_err() {
            return Err("共享语义模型尚未安装。".to_owned());
        }
        let device = inspect_device(&self.root, definition);
        if device.available_memory_bytes > 0 && device.available_memory_bytes < 1024 * 1024 * 1024 {
            return Err("当前可用内存不足，已回退全文检索。".to_owned());
        }
        let mut loaded = self
            .loaded
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if loaded.as_ref().is_none_or(|loaded| {
            loaded.model_id != definition.id || loaded.model_version != definition.version
        }) {
            *loaded = Some(LoadedModel {
                model: load_model(&self.root, definition)?,
                model_id: definition.id,
                model_version: definition.version,
                last_used_at: SystemTime::now(),
            });
        }
        let model = loaded.as_mut().expect("loaded model must exist");
        let inputs = texts
            .iter()
            .map(|text| format!("{prefix}{text}"))
            .collect::<Vec<_>>();
        let embeddings = model
            .model
            .embed(&inputs, adaptive_batch_size())
            .map_err(|error| format!("本地语义编码失败：{error}"))?;
        model.last_used_at = SystemTime::now();
        if embeddings
            .iter()
            .any(|embedding| embedding.len() != usize::from(definition.dimensions))
        {
            return Err("语义模型返回了不兼容的向量维度。".to_owned());
        }
        Ok(embeddings)
    }

    fn active_model(&self) -> &'static SemanticModelDefinition {
        *self
            .active_model
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub fn index_all_knowledge_bases(
    data_directory: &Path,
    manager: &SemanticModelManager,
) -> Result<usize, String> {
    if !manager.is_ready() {
        return Ok(0);
    }
    let knowledge_base_ids = Store::open_worker(data_directory)
        .map_err(|error| error.to_string())?
        .semantic_enabled_knowledge_base_ids()
        .map_err(|error| error.to_string())?;
    let mut indexed = 0usize;
    let mut first_error = None;
    for knowledge_base_id in knowledge_base_ids {
        match index_knowledge_base(data_directory, manager, &knowledge_base_id) {
            Ok(count) => indexed = indexed.saturating_add(count),
            Err(error) if first_error.is_none() => first_error = Some(error),
            Err(_) => {}
        }
    }
    if let Some(error) = first_error {
        return Err(error);
    }
    Ok(indexed)
}

pub fn index_knowledge_base(
    data_directory: &Path,
    manager: &SemanticModelManager,
    knowledge_base_id: &str,
) -> Result<usize, String> {
    if !manager.is_ready() {
        return Ok(0);
    }
    let model_id = manager.model_id();
    let model_version = manager.model_version();
    let mut store = Store::open_worker(data_directory).map_err(|error| error.to_string())?;
    store
        .set_knowledge_semantic_index_status(
            knowledge_base_id,
            model_id,
            model_version,
            "indexing",
            None,
        )
        .map_err(|error| error.to_string())?;
    let result = (|| {
        let mut indexed = 0usize;
        let mut paused = false;
        loop {
            let manually_paused = store
                .knowledge_retrieval_settings()
                .map_err(|error| error.to_string())?
                .index_paused;
            if crate::knowledge::agent_active()
                || manually_paused
                || semantic_index_resources_busy()
            {
                if !paused {
                    store
                        .set_knowledge_semantic_index_status(
                            knowledge_base_id,
                            model_id,
                            model_version,
                            "paused",
                            None,
                        )
                        .map_err(|error| error.to_string())?;
                    paused = true;
                }
                std::thread::sleep(std::time::Duration::from_secs(1));
                if !manager.is_ready() {
                    return Ok(indexed);
                }
                continue;
            }
            if paused {
                store
                    .set_knowledge_semantic_index_status(
                        knowledge_base_id,
                        model_id,
                        model_version,
                        "indexing",
                        None,
                    )
                    .map_err(|error| error.to_string())?;
                paused = false;
            }
            let chunks = store
                .knowledge_chunks_needing_embeddings(knowledge_base_id, model_id, model_version, 16)
                .map_err(|error| error.to_string())?;
            if chunks.is_empty() {
                break;
            }
            let texts = chunks
                .iter()
                .map(|chunk| chunk.content.clone())
                .collect::<Vec<_>>();
            let vectors = manager.embed_passages(&texts)?;
            if vectors.len() != chunks.len() {
                return Err("语义模型返回的向量数量不匹配。".to_owned());
            }
            let embeddings = chunks
                .into_iter()
                .zip(vectors)
                .map(|(chunk, vector)| KnowledgeEmbeddingInput {
                    chunk_id: chunk.id,
                    content_hash: chunk.content_hash,
                    vector,
                })
                .collect::<Vec<_>>();
            store
                .save_knowledge_embeddings(
                    knowledge_base_id,
                    model_id,
                    model_version,
                    manager.dimensions(),
                    &embeddings,
                )
                .map_err(|error| error.to_string())?;
            indexed = indexed.saturating_add(embeddings.len());
        }
        store
            .set_knowledge_semantic_index_status(
                knowledge_base_id,
                model_id,
                model_version,
                "ready",
                None,
            )
            .map_err(|error| error.to_string())?;
        Ok(indexed)
    })();
    if let Err(error) = &result {
        let message = error.chars().take(1_024).collect::<String>();
        let _ = store.set_knowledge_semantic_index_status(
            knowledge_base_id,
            model_id,
            model_version,
            "error",
            Some(&message),
        );
    }
    result
}

fn semantic_index_resources_busy() -> bool {
    let mut system = System::new();
    system.refresh_memory();
    if system.available_memory() > 0 && system.available_memory() < 768 * 1024 * 1024 {
        return true;
    }
    let logical_cores = std::thread::available_parallelism().map_or(1, usize::from) as f64;
    System::load_average().one > logical_cores * 1.25
}

impl LocalEmbeddingModel {
    fn embed(&mut self, texts: &[String], batch_size: usize) -> Result<Vec<Vec<f32>>, String> {
        let mut embeddings = Vec::with_capacity(texts.len());
        for batch in texts.chunks(batch_size.max(1)) {
            let inputs = batch.iter().map(String::as_str).collect::<Vec<_>>();
            let encodings = self
                .tokenizer
                .encode_batch(inputs, true)
                .map_err(|error| format!("文本分词失败：{error}"))?;
            let sequence_length = encodings
                .first()
                .map(|encoding| encoding.len())
                .ok_or_else(|| "分词器没有返回输入。".to_owned())?;
            let value_count = batch.len().saturating_mul(sequence_length);
            let mut input_ids = Vec::with_capacity(value_count);
            let mut attention_mask = Vec::with_capacity(value_count);
            let mut token_type_ids = Vec::with_capacity(value_count);
            for encoding in &encodings {
                input_ids.extend(encoding.get_ids().iter().map(|value| i64::from(*value)));
                attention_mask.extend(
                    encoding
                        .get_attention_mask()
                        .iter()
                        .map(|value| i64::from(*value)),
                );
                token_type_ids.extend(
                    encoding
                        .get_type_ids()
                        .iter()
                        .map(|value| i64::from(*value)),
                );
            }
            let input_ids = Array2::from_shape_vec((batch.len(), sequence_length), input_ids)
                .map_err(|error| error.to_string())?;
            let attention_mask_array =
                Array2::from_shape_vec((batch.len(), sequence_length), attention_mask)
                    .map_err(|error| error.to_string())?;
            let token_type_ids =
                Array2::from_shape_vec((batch.len(), sequence_length), token_type_ids)
                    .map_err(|error| error.to_string())?;
            let mut session_inputs = ort::inputs![
                "input_ids" => Value::from_array(input_ids).map_err(|error| error.to_string())?,
                "attention_mask" => Value::from_array(attention_mask_array.clone())
                    .map_err(|error| error.to_string())?,
            ];
            if self.needs_token_type_ids {
                session_inputs.push((
                    "token_type_ids".into(),
                    Value::from_array(token_type_ids)
                        .map_err(|error| error.to_string())?
                        .into(),
                ));
            }
            let outputs = self
                .session
                .run(session_inputs)
                .map_err(|error| error.to_string())?;
            let output = outputs
                .get("last_hidden_state")
                .unwrap_or_else(|| &outputs[0]);
            let (shape, values) = output
                .try_extract_tensor::<f32>()
                .map_err(|error| error.to_string())?;
            if shape.len() != 3
                || shape[0] as usize != batch.len()
                || shape[1] as usize != sequence_length
                || shape[2] as usize != self.dimensions
            {
                return Err(format!("语义模型返回了不兼容的输出形状：{shape:?}"));
            }
            let dimensions = self.dimensions;
            for batch_index in 0..batch.len() {
                let mut embedding = vec![0.0_f32; dimensions];
                match self.pooling {
                    PoolingStrategy::Cls => {
                        let offset = batch_index
                            .saturating_mul(sequence_length)
                            .saturating_mul(dimensions);
                        embedding.copy_from_slice(&values[offset..offset + dimensions]);
                    }
                    PoolingStrategy::Mean => {
                        let mut tokens = 0.0_f32;
                        for token_index in 0..sequence_length {
                            if attention_mask_array[(batch_index, token_index)] == 0 {
                                continue;
                            }
                            tokens += 1.0;
                            let offset = (batch_index * sequence_length + token_index)
                                .saturating_mul(dimensions);
                            for dimension in 0..dimensions {
                                embedding[dimension] += values[offset + dimension];
                            }
                        }
                        let divisor = tokens.max(1.0);
                        for value in &mut embedding {
                            *value /= divisor;
                        }
                    }
                }
                let norm = embedding
                    .iter()
                    .map(|value| value * value)
                    .sum::<f32>()
                    .sqrt()
                    .max(f32::EPSILON);
                for value in &mut embedding {
                    *value /= norm;
                }
                embeddings.push(embedding);
            }
        }
        Ok(embeddings)
    }
}

fn load_model(
    root: &Path,
    definition: &'static SemanticModelDefinition,
) -> Result<LocalEmbeddingModel, String> {
    let installed = installed_directory(root, definition);
    validate_installed_layout(root, definition)?;
    let config: serde_json::Value = serde_json::from_slice(
        &std::fs::read(installed.join("config.json")).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let tokenizer_config: serde_json::Value = serde_json::from_slice(
        &std::fs::read(installed.join("tokenizer_config.json"))
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let pad_id = config["pad_token_id"].as_u64().unwrap_or(0) as u32;
    let pad_token = tokenizer_config["pad_token"]
        .as_str()
        .unwrap_or("<pad>")
        .to_owned();
    let mut tokenizer = Tokenizer::from_file(installed.join("tokenizer.json"))
        .map_err(|error| format!("加载本地分词器失败：{error}"))?;
    tokenizer.with_padding(Some(PaddingParams {
        strategy: PaddingStrategy::BatchLongest,
        pad_id,
        pad_token,
        ..Default::default()
    }));
    tokenizer
        .with_truncation(Some(TruncationParams {
            max_length: 512,
            ..Default::default()
        }))
        .map_err(|error| format!("配置本地分词器失败：{error}"))?;
    let builder_error = |error: ort::Error<ort::session::builder::SessionBuilder>| {
        format!("加载本地语义模型失败：{error}")
    };
    let session = Session::builder()
        .map_err(|error| error.to_string())?
        .with_optimization_level(GraphOptimizationLevel::Disable)
        .map_err(builder_error)?
        .with_prepacking(false)
        .map_err(builder_error)?
        .with_memory_pattern(false)
        .map_err(builder_error)?
        .with_intra_threads(adaptive_intra_threads())
        .map_err(builder_error)?
        .commit_from_file(installed.join("model.onnx"))
        .map_err(|error| format!("加载本地语义模型失败：{error}"))?;
    let needs_token_type_ids = session
        .inputs()
        .iter()
        .any(|input| input.name() == "token_type_ids");
    Ok(LocalEmbeddingModel {
        tokenizer,
        session,
        needs_token_type_ids,
        dimensions: usize::from(definition.dimensions),
        pooling: definition.pooling,
    })
}

fn adaptive_batch_size() -> usize {
    match std::thread::available_parallelism().map_or(1, usize::from) {
        0..=2 => 4,
        3..=6 => 8,
        _ => 16,
    }
}

fn adaptive_intra_threads() -> usize {
    std::thread::available_parallelism()
        .map_or(1, usize::from)
        .div_ceil(2)
        .clamp(1, 4)
}

enum InstallError {
    Cancelled,
    Failure(String),
}

async fn download_and_install(
    root: &Path,
    model: &'static SemanticModelDefinition,
    state: &Arc<Mutex<RuntimeState>>,
    cancellation: &CancellationToken,
) -> Result<(), InstallError> {
    let staging = staging_directory(root, model);
    tokio::fs::create_dir_all(&staging)
        .await
        .map_err(|error| InstallError::Failure(error.to_string()))?;
    let client = reqwest::Client::builder()
        .user_agent("SugarCode/semantic-model")
        .build()
        .map_err(|error| InstallError::Failure(error.to_string()))?;

    let mut completed_before = 0_u64;
    for file in model.files {
        if cancellation.is_cancelled() {
            return Err(InstallError::Cancelled);
        }
        let final_path = staging.join(file.local_name);
        if valid_file_size(&final_path, file.size) {
            let verification_path = final_path.clone();
            let actual_hash = tokio::task::spawn_blocking(move || sha256_file(&verification_path))
                .await
                .map_err(|error| InstallError::Failure(error.to_string()))?
                .map_err(|error| InstallError::Failure(error.to_string()))?;
            if actual_hash == file.sha256 {
                completed_before += file.size;
                update_progress(state, completed_before, model_package_size(model));
                continue;
            }
            tokio::fs::remove_file(&final_path)
                .await
                .map_err(|error| InstallError::Failure(error.to_string()))?;
        }
        let mut attempt = 1;
        loop {
            match download_model_file(
                &client,
                &staging,
                file,
                completed_before,
                model_package_size(model),
                state,
                cancellation,
            )
            .await
            {
                Ok(()) => break,
                Err(InstallError::Cancelled) => return Err(InstallError::Cancelled),
                Err(error @ InstallError::Failure(_)) if attempt >= DOWNLOAD_ATTEMPTS => {
                    return Err(error);
                }
                Err(InstallError::Failure(_)) => {
                    let delay = std::time::Duration::from_millis(250 * u64::from(attempt));
                    tokio::select! {
                        _ = cancellation.cancelled() => return Err(InstallError::Cancelled),
                        () = tokio::time::sleep(delay) => {}
                    }
                    attempt += 1;
                }
            }
        }
        completed_before += file.size;
        update_progress(state, completed_before, model_package_size(model));
    }

    let manifest = InstalledManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        model_id: model.id.to_owned(),
        version: model.version.to_owned(),
        revision: model.revision.to_owned(),
        dimensions: model.dimensions,
        runtime: "onnxruntime-cpu".to_owned(),
        variant: "int8-optimized".to_owned(),
        installed_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        files: model
            .files
            .iter()
            .map(|file| InstalledFile {
                path: file.local_name.to_owned(),
                size: file.size,
                sha256: file.sha256.to_owned(),
            })
            .collect(),
    };
    let manifest_json = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| InstallError::Failure(error.to_string()))?;
    tokio::fs::write(staging.join("manifest.json"), manifest_json)
        .await
        .map_err(|error| InstallError::Failure(error.to_string()))?;

    let installed = installed_directory(root, model);
    let backup = model_root(root, model).join(format!("{}.backup", model.version));
    activate_staged_install(&staging, &installed, &backup).map_err(InstallError::Failure)?;
    Ok(())
}

async fn download_model_file(
    client: &reqwest::Client,
    staging: &Path,
    file: &ModelFileDefinition,
    completed_before: u64,
    package_size: u64,
    state: &Arc<Mutex<RuntimeState>>,
    cancellation: &CancellationToken,
) -> Result<(), InstallError> {
    let final_path = staging.join(file.local_name);
    let part_path = staging.join(format!("{}.part", file.local_name));
    let mut existing = file_size(&part_path).unwrap_or(0);
    if existing > file.size {
        tokio::fs::remove_file(&part_path)
            .await
            .map_err(|error| InstallError::Failure(error.to_string()))?;
        existing = 0;
    }
    if existing == file.size {
        let verification_path = part_path.clone();
        let actual_hash = tokio::task::spawn_blocking(move || sha256_file(&verification_path))
            .await
            .map_err(|error| InstallError::Failure(error.to_string()))?
            .map_err(|error| InstallError::Failure(error.to_string()))?;
        if actual_hash == file.sha256 {
            tokio::fs::rename(&part_path, &final_path)
                .await
                .map_err(|error| InstallError::Failure(error.to_string()))?;
            return Ok(());
        }
        tokio::fs::remove_file(&part_path)
            .await
            .map_err(|error| InstallError::Failure(error.to_string()))?;
        existing = 0;
    }
    update_progress(state, completed_before + existing, package_size);
    let url = format!(
        "https://huggingface.co/{}/resolve/{}/{}",
        file.repository, file.revision, file.remote_path
    );
    let mut request = client.get(url);
    if existing > 0 {
        request = request.header(RANGE, format!("bytes={existing}-"));
    }
    let response = tokio::select! {
        _ = cancellation.cancelled() => return Err(InstallError::Cancelled),
        result = request.send() => result
            .map_err(|error| InstallError::Failure(error.to_string()))?,
    };
    if !response.status().is_success() {
        return Err(InstallError::Failure(format!(
            "模型文件下载失败：HTTP {}",
            response.status()
        )));
    }
    let resumed = existing > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    if existing > 0 && !resumed {
        existing = 0;
    }
    let mut output = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(&part_path)
        .await
        .map_err(|error| InstallError::Failure(error.to_string()))?;
    let mut received = existing;
    let mut stream = response.bytes_stream();
    loop {
        tokio::select! {
            _ = cancellation.cancelled() => return Err(InstallError::Cancelled),
            chunk = stream.next() => match chunk {
                Some(Ok(bytes)) => {
                    output.write_all(&bytes).await
                        .map_err(|error| InstallError::Failure(error.to_string()))?;
                    received = received.saturating_add(bytes.len() as u64);
                    update_progress(
                        state,
                        completed_before + received.min(file.size),
                        package_size,
                    );
                }
                Some(Err(error)) => return Err(InstallError::Failure(error.to_string())),
                None => break,
            }
        }
    }
    output
        .flush()
        .await
        .map_err(|error| InstallError::Failure(error.to_string()))?;
    drop(output);
    if file_size(&part_path) != Some(file.size) {
        return Err(InstallError::Failure(format!(
            "模型文件大小校验失败：{}",
            file.local_name
        )));
    }
    let hash_path = part_path.clone();
    let actual_hash = tokio::task::spawn_blocking(move || sha256_file(&hash_path))
        .await
        .map_err(|error| InstallError::Failure(error.to_string()))?
        .map_err(|error| InstallError::Failure(error.to_string()))?;
    if actual_hash != file.sha256 {
        let _ = tokio::fs::remove_file(&part_path).await;
        return Err(InstallError::Failure(format!(
            "模型文件完整性校验失败：{}",
            file.local_name
        )));
    }
    tokio::fs::rename(&part_path, &final_path)
        .await
        .map_err(|error| InstallError::Failure(error.to_string()))?;
    Ok(())
}

fn activate_staged_install(staging: &Path, installed: &Path, backup: &Path) -> Result<(), String> {
    if backup.exists() {
        std::fs::remove_dir_all(backup).map_err(|error| error.to_string())?;
    }
    if installed.exists() {
        std::fs::rename(installed, backup).map_err(|error| error.to_string())?;
    }
    if let Err(error) = std::fs::rename(staging, installed) {
        if backup.exists() {
            let _ = std::fs::rename(backup, installed);
        }
        return Err(error.to_string());
    }
    if backup.exists() {
        let _ = std::fs::remove_dir_all(backup);
    }
    Ok(())
}

fn required_disk_bytes(model: &SemanticModelDefinition) -> u64 {
    model_package_size(model)
        .saturating_mul(2)
        .saturating_add(INDEX_DISK_BUDGET)
}

fn inspect_device(root: &Path, model: &SemanticModelDefinition) -> DeviceInspection {
    let mut system = System::new();
    system.refresh_memory();
    let architecture = std::env::consts::ARCH.to_owned();
    let supported = matches!(architecture.as_str(), "x86_64" | "aarch64");
    let logical_cores = std::thread::available_parallelism().map_or(1, usize::from);
    let total_memory_bytes = system.total_memory();
    let available_memory_bytes = system.available_memory();
    let available_disk_bytes = fs2::available_space(root).unwrap_or(0);
    let required_disk_bytes = required_disk_bytes(model);
    let mut warnings = Vec::new();
    if !supported {
        warnings.push("当前 CPU 架构不受支持，建议继续使用全文检索。".to_owned());
    }
    if total_memory_bytes < 8 * 1024 * 1024 * 1024 {
        warnings.push("设备内存低于 8GB，建议仅使用全文检索。".to_owned());
    }
    if logical_cores <= 2 {
        warnings.push("CPU 逻辑核心较少，建立语义索引可能较慢。".to_owned());
    }
    if available_memory_bytes > 0 && available_memory_bytes < 1024 * 1024 * 1024 {
        warnings.push("当前可用内存较少，模型加载时会自动退回全文检索。".to_owned());
    }
    if available_disk_bytes < required_disk_bytes {
        warnings.push("可用磁盘空间不足，暂时无法安装共享模型。".to_owned());
    }
    DeviceInspection {
        architecture,
        logical_cores,
        total_memory_bytes,
        available_memory_bytes,
        available_disk_bytes,
        required_disk_bytes,
        supported,
        recommended: supported
            && total_memory_bytes >= 8 * 1024 * 1024 * 1024
            && logical_cores > 2
            && available_disk_bytes >= required_disk_bytes,
        warnings,
    }
}

fn update_progress(state: &Arc<Mutex<RuntimeState>>, downloaded_bytes: u64, package_size: u64) {
    let mut state = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.downloaded_bytes = downloaded_bytes.min(package_size);
}

fn model_storage_key(model_id: &str) -> String {
    let digest = Sha256::digest(model_id.as_bytes());
    format!("model-{}", &format!("{digest:x}")[..24])
}

fn migrate_legacy_default_layout(root: &Path) -> std::io::Result<()> {
    let model = &MULTILINGUAL_E5_SMALL;
    let destination_root = model_root(root, model);
    for (legacy, destination) in [
        (root.join(model.version), installed_directory(root, model)),
        (
            root.join(format!("{}.download", model.version)),
            staging_directory(root, model),
        ),
    ] {
        if legacy.exists() && !destination.exists() {
            std::fs::create_dir_all(&destination_root)?;
            std::fs::rename(legacy, destination)?;
        }
    }
    Ok(())
}

fn model_root(root: &Path, model: &SemanticModelDefinition) -> PathBuf {
    root.join(model_storage_key(model.id))
}

fn installed_directory(root: &Path, model: &SemanticModelDefinition) -> PathBuf {
    model_root(root, model).join(model.version)
}

fn staging_directory(root: &Path, model: &SemanticModelDefinition) -> PathBuf {
    model_root(root, model).join(format!("{}.download", model.version))
}

fn installed_manifest_path(root: &Path, model: &SemanticModelDefinition) -> PathBuf {
    installed_directory(root, model).join("manifest.json")
}

fn validate_installed_layout(root: &Path, model: &SemanticModelDefinition) -> Result<(), String> {
    let manifest_data =
        std::fs::read(installed_manifest_path(root, model)).map_err(|error| error.to_string())?;
    let manifest: InstalledManifest =
        serde_json::from_slice(&manifest_data).map_err(|error| error.to_string())?;
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION
        || manifest.model_id != model.id
        || manifest.version != model.version
        || manifest.revision != model.revision
        || manifest.dimensions != model.dimensions
    {
        return Err("共享模型 manifest 与当前版本不兼容。".to_owned());
    }
    for file in model.files {
        if !valid_file_size(
            &installed_directory(root, model).join(file.local_name),
            file.size,
        ) {
            return Err(format!("共享模型文件缺失或大小不正确：{}", file.local_name));
        }
    }
    Ok(())
}

fn resumable_bytes(root: &Path, model: &SemanticModelDefinition) -> u64 {
    model
        .files
        .iter()
        .map(|file| {
            let staging = staging_directory(root, model);
            if valid_file_size(&staging.join(file.local_name), file.size) {
                file.size
            } else {
                file_size(&staging.join(format!("{}.part", file.local_name)))
                    .unwrap_or(0)
                    .min(file.size)
            }
        })
        .sum()
}

fn valid_file_size(path: &Path, expected: u64) -> bool {
    file_size(path) == Some(expected)
}

fn file_size(path: &Path) -> Option<u64> {
    path.metadata()
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut input = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sysinfo::{ProcessesToUpdate, System};
    use tempfile::tempdir;

    fn current_rss_bytes() -> u64 {
        let pid = sysinfo::get_current_pid().expect("current process id");
        let mut system = System::new();
        system.refresh_processes(ProcessesToUpdate::Some(&[pid]), false);
        system.process(pid).map_or(0, sysinfo::Process::memory)
    }

    #[test]
    fn package_metadata_is_consistent() {
        assert_eq!(model_package_size(MODEL), 135_392_178);
        assert!(MODEL.files.iter().all(|file| file.sha256.len() == 64));
        assert!(
            MODEL
                .files
                .iter()
                .all(|file| !file.local_name.contains('/'))
        );
    }

    #[test]
    fn partial_download_is_discovered_after_restart() {
        let directory = tempdir().expect("temporary directory");
        let root = directory.path().join("models").join("semantic");
        let staging = staging_directory(&root, MODEL);
        std::fs::create_dir_all(&staging).expect("staging directory");
        std::fs::write(staging.join("model.onnx.part"), [0_u8; 128]).expect("partial model");

        let manager = SemanticModelManager::open(directory.path()).expect("model manager");
        let inspection = manager.inspect();
        assert_eq!(inspection.state, "notInstalled");
        assert_eq!(inspection.downloaded_bytes, 128);
    }

    #[test]
    fn legacy_default_model_layout_is_atomically_reused_in_model_namespace() {
        let directory = tempdir().expect("temporary directory");
        let root = directory.path().join("models").join("semantic");
        let legacy_staging = root.join(format!("{}.download", MODEL.version));
        std::fs::create_dir_all(&legacy_staging).expect("legacy staging directory");
        std::fs::write(legacy_staging.join("model.onnx.part"), [0_u8; 256])
            .expect("legacy partial model");

        let manager = SemanticModelManager::open(directory.path()).expect("model manager");
        assert_eq!(manager.inspect().downloaded_bytes, 256);
        assert!(!legacy_staging.exists());
        assert!(
            staging_directory(&root, MODEL)
                .join("model.onnx.part")
                .is_file()
        );
    }

    #[test]
    fn compatible_install_is_reused_without_touching_siblings() {
        let directory = tempdir().expect("temporary directory");
        let root = directory.path().join("models").join("semantic");
        let installed = installed_directory(&root, MODEL);
        std::fs::create_dir_all(&installed).expect("installed directory");
        for file in MODEL.files {
            File::create(installed.join(file.local_name))
                .and_then(|output| output.set_len(file.size))
                .expect("sparse model file");
        }
        let manifest = InstalledManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            model_id: MODEL.id.to_owned(),
            version: MODEL.version.to_owned(),
            revision: MODEL.revision.to_owned(),
            dimensions: MODEL.dimensions,
            runtime: "onnxruntime-cpu".to_owned(),
            variant: "int8-optimized".to_owned(),
            installed_at: 1,
            files: MODEL
                .files
                .iter()
                .map(|file| InstalledFile {
                    path: file.local_name.to_owned(),
                    size: file.size,
                    sha256: file.sha256.to_owned(),
                })
                .collect(),
        };
        std::fs::write(
            installed_manifest_path(&root, MODEL),
            serde_json::to_vec(&manifest).expect("manifest JSON"),
        )
        .expect("manifest");
        let sibling = directory.path().join("keep-me");
        std::fs::write(&sibling, "untouched").expect("sibling marker");

        let manager = SemanticModelManager::open(directory.path()).expect("model manager");
        assert_eq!(manager.inspect().state, "ready");
        manager.remove().expect("remove model");
        assert_eq!(
            std::fs::read_to_string(sibling).expect("sibling marker"),
            "untouched"
        );
        assert_eq!(manager.inspect().state, "notInstalled");
    }

    #[test]
    fn model_activation_restores_the_previous_install_when_atomic_switch_fails() {
        let directory = tempdir().expect("temporary directory");
        let installed = directory.path().join("installed");
        let staging = directory.path().join("missing-staging");
        let backup = directory.path().join("backup");
        std::fs::create_dir(&installed).expect("installed directory");
        std::fs::write(installed.join("marker"), "old-version").expect("installed marker");

        assert!(activate_staged_install(&staging, &installed, &backup).is_err());
        assert_eq!(
            std::fs::read_to_string(installed.join("marker")).expect("restored marker"),
            "old-version"
        );
        assert!(!backup.exists());
    }

    #[test]
    fn model_disk_precheck_reserves_download_install_and_index_capacity() {
        assert_eq!(
            required_disk_bytes(MODEL),
            model_package_size(MODEL) * 2 + INDEX_DISK_BUDGET
        );
        assert!(required_disk_bytes(MODEL) > model_package_size(MODEL) * 2);
    }

    #[tokio::test]
    #[ignore = "downloads and loads every production semantic model"]
    async fn live_catalog_models_download_load_and_remove() {
        let directory = tempdir().expect("temporary directory");
        let manager = SemanticModelManager::open(directory.path()).expect("model manager");
        for definition in crate::semantic_catalog::SEMANTIC_MODELS {
            manager
                .select_model(definition.id)
                .expect("select catalog model");
            manager.install().await.expect("download and install model");
            assert!(manager.is_model_ready(definition.id, definition.version));
            let rss_before_load = current_rss_bytes();
            let vectors = manager
                .embed_passages(&["SugarCode semantic model verification".to_owned()])
                .expect("load model and embed a passage");
            let rss_after_load = current_rss_bytes();
            assert_eq!(vectors.len(), 1);
            assert_eq!(vectors[0].len(), usize::from(definition.dimensions));
            eprintln!(
                "SUGARCODE_MODEL_RSS model={} before_mb={:.1} after_mb={:.1} delta_mb={:.1}",
                definition.id,
                rss_before_load as f64 / 1_048_576.0,
                rss_after_load as f64 / 1_048_576.0,
                rss_after_load.saturating_sub(rss_before_load) as f64 / 1_048_576.0,
            );
            manager.remove().expect("remove verified model");
            assert_eq!(manager.inspect().state, "notInstalled");
        }
    }
}
