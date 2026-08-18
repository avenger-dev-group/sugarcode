use serde::Serialize;

pub(crate) const FULL_TEXT_PLAN_ID: &str = "fullText";
pub(crate) const DEFAULT_SEMANTIC_MODEL_ID: &str = "intfloat/multilingual-e5-small";
pub(crate) const MINIMUM_APP_VERSION: &str = "3.3.2";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PoolingStrategy {
    Cls,
    Mean,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelFileDefinition {
    pub(crate) repository: &'static str,
    pub(crate) revision: &'static str,
    pub(crate) remote_path: &'static str,
    pub(crate) local_name: &'static str,
    pub(crate) size: u64,
    pub(crate) sha256: &'static str,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SemanticModelDefinition {
    pub(crate) id: &'static str,
    pub(crate) name: &'static str,
    pub(crate) description: &'static str,
    pub(crate) language: &'static str,
    pub(crate) version: &'static str,
    pub(crate) revision: &'static str,
    pub(crate) dimensions: u16,
    pub(crate) minimum_app_version: &'static str,
    pub(crate) query_prefix: &'static str,
    pub(crate) passage_prefix: &'static str,
    pub(crate) pooling: PoolingStrategy,
    pub(crate) files: &'static [ModelFileDefinition],
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RetrievalPlanDefinition {
    pub(crate) id: &'static str,
    pub(crate) name: &'static str,
    pub(crate) description: &'static str,
    pub(crate) language: &'static str,
    pub(crate) download_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model: Option<&'static SemanticModelDefinition>,
}

const BGE_FILES: &[ModelFileDefinition] = &[
    ModelFileDefinition {
        repository: "Xenova/bge-small-zh-v1.5",
        revision: "75c43b069aac4d136ba6bc1122f995fedcfd2781",
        remote_path: "config.json",
        local_name: "config.json",
        size: 716,
        sha256: "d4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f",
    },
    ModelFileDefinition {
        repository: "Xenova/bge-small-zh-v1.5",
        revision: "75c43b069aac4d136ba6bc1122f995fedcfd2781",
        remote_path: "onnx/model_quantized.onnx",
        local_name: "model.onnx",
        size: 24_010_842,
        sha256: "15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc",
    },
    ModelFileDefinition {
        repository: "Xenova/bge-small-zh-v1.5",
        revision: "75c43b069aac4d136ba6bc1122f995fedcfd2781",
        remote_path: "special_tokens_map.json",
        local_name: "special_tokens_map.json",
        size: 125,
        sha256: "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3",
    },
    ModelFileDefinition {
        repository: "Xenova/bge-small-zh-v1.5",
        revision: "75c43b069aac4d136ba6bc1122f995fedcfd2781",
        remote_path: "tokenizer.json",
        local_name: "tokenizer.json",
        size: 439_125,
        sha256: "48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26",
    },
    ModelFileDefinition {
        repository: "Xenova/bge-small-zh-v1.5",
        revision: "75c43b069aac4d136ba6bc1122f995fedcfd2781",
        remote_path: "tokenizer_config.json",
        local_name: "tokenizer_config.json",
        size: 367,
        sha256: "e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a",
    },
];

const MULTILINGUAL_E5_FILES: &[ModelFileDefinition] = &[
    ModelFileDefinition {
        repository: "intfloat/multilingual-e5-small",
        revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
        remote_path: "onnx/config.json",
        local_name: "config.json",
        size: 653,
        sha256: "bbb7c1333fc4b3e27fbc9cd5d2070aabcc1d4dfb99917c3633e772f97545a6b6",
    },
    ModelFileDefinition {
        repository: "Xenova/multilingual-e5-small",
        revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
        remote_path: "onnx/model_quantized.onnx",
        local_name: "model.onnx",
        size: 118_308_185,
        sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
    },
    ModelFileDefinition {
        repository: "intfloat/multilingual-e5-small",
        revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
        remote_path: "onnx/special_tokens_map.json",
        local_name: "special_tokens_map.json",
        size: 167,
        sha256: "d05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7",
    },
    ModelFileDefinition {
        repository: "intfloat/multilingual-e5-small",
        revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
        remote_path: "onnx/tokenizer.json",
        local_name: "tokenizer.json",
        size: 17_082_730,
        sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
    },
    ModelFileDefinition {
        repository: "intfloat/multilingual-e5-small",
        revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
        remote_path: "onnx/tokenizer_config.json",
        local_name: "tokenizer_config.json",
        size: 443,
        sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
    },
];

const SNOWFLAKE_FILES: &[ModelFileDefinition] = &[
    ModelFileDefinition {
        repository: "Snowflake/snowflake-arctic-embed-xs",
        revision: "d8c86521100d3556476a063fc2342036d45c106f",
        remote_path: "config.json",
        local_name: "config.json",
        size: 737,
        sha256: "d7d071046ab952af96b7abad788db7ab3fc997b465e1b9914ff39707092254ec",
    },
    ModelFileDefinition {
        repository: "Snowflake/snowflake-arctic-embed-xs",
        revision: "d8c86521100d3556476a063fc2342036d45c106f",
        remote_path: "onnx/model_quantized.onnx",
        local_name: "model.onnx",
        size: 22_972_992,
        sha256: "e6aa5e656466a73d7c3111e9a3378bd13e5b93af30eaac2b3f13fd56692589a1",
    },
    ModelFileDefinition {
        repository: "Snowflake/snowflake-arctic-embed-xs",
        revision: "d8c86521100d3556476a063fc2342036d45c106f",
        remote_path: "special_tokens_map.json",
        local_name: "special_tokens_map.json",
        size: 695,
        sha256: "5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a",
    },
    ModelFileDefinition {
        repository: "Snowflake/snowflake-arctic-embed-xs",
        revision: "d8c86521100d3556476a063fc2342036d45c106f",
        remote_path: "tokenizer.json",
        local_name: "tokenizer.json",
        size: 711_649,
        sha256: "91f1def9b9391fdabe028cd3f3fcc4efd34e5d1f08c3bf2de513ebb5911a1854",
    },
    ModelFileDefinition {
        repository: "Snowflake/snowflake-arctic-embed-xs",
        revision: "d8c86521100d3556476a063fc2342036d45c106f",
        remote_path: "tokenizer_config.json",
        local_name: "tokenizer_config.json",
        size: 1_433,
        sha256: "9ca59277519f6e3692c8685e26b94d4afca2d5438deff66483db495e48735810",
    },
];

pub(crate) const BGE_SMALL_ZH: SemanticModelDefinition = SemanticModelDefinition {
    id: "BAAI/bge-small-zh-v1.5",
    name: "轻量中文",
    description: "面向中文资料和查询优化的轻量语义检索。",
    language: "zh",
    version: "1.5-int8-2026-08-18",
    revision: "75c43b069aac4d136ba6bc1122f995fedcfd2781",
    dimensions: 512,
    minimum_app_version: MINIMUM_APP_VERSION,
    query_prefix: "为这个句子生成表示以用于检索相关文章：",
    passage_prefix: "",
    pooling: PoolingStrategy::Cls,
    files: BGE_FILES,
};

pub(crate) const MULTILINGUAL_E5_SMALL: SemanticModelDefinition = SemanticModelDefinition {
    id: DEFAULT_SEMANTIC_MODEL_ID,
    name: "多语言",
    description: "适合中英文混合资料和跨语言查询的通用方案。",
    language: "multilingual",
    version: "2026-04-02",
    revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
    dimensions: 384,
    minimum_app_version: MINIMUM_APP_VERSION,
    query_prefix: "query: ",
    passage_prefix: "passage: ",
    pooling: PoolingStrategy::Mean,
    files: MULTILINGUAL_E5_FILES,
};

pub(crate) const SNOWFLAKE_ARCTIC_EMBED_XS: SemanticModelDefinition = SemanticModelDefinition {
    id: "Snowflake/snowflake-arctic-embed-xs",
    name: "轻量英文",
    description: "面向英文代码与文档的紧凑语义检索模型。",
    language: "en",
    version: "1-int8-2026-08-18",
    revision: "d8c86521100d3556476a063fc2342036d45c106f",
    dimensions: 384,
    minimum_app_version: MINIMUM_APP_VERSION,
    query_prefix: "Represent this sentence for searching relevant passages: ",
    passage_prefix: "",
    pooling: PoolingStrategy::Cls,
    files: SNOWFLAKE_FILES,
};

pub(crate) const SEMANTIC_MODELS: &[SemanticModelDefinition] = &[
    BGE_SMALL_ZH,
    MULTILINGUAL_E5_SMALL,
    SNOWFLAKE_ARCTIC_EMBED_XS,
];

pub(crate) const RETRIEVAL_PLANS: &[RetrievalPlanDefinition] = &[
    RetrievalPlanDefinition {
        id: FULL_TEXT_PLAN_ID,
        name: "全文检索",
        description: "无需下载模型，始终可用。",
        language: "all",
        download_bytes: 0,
        model: None,
    },
    RetrievalPlanDefinition {
        id: "BAAI/bge-small-zh-v1.5",
        name: "轻量中文",
        description: "面向中文资料和查询优化的轻量语义检索。",
        language: "zh",
        download_bytes: package_size(&BGE_SMALL_ZH),
        model: Some(&BGE_SMALL_ZH),
    },
    RetrievalPlanDefinition {
        id: DEFAULT_SEMANTIC_MODEL_ID,
        name: "多语言",
        description: "适合中英文混合资料和跨语言查询的通用方案。",
        language: "multilingual",
        download_bytes: package_size(&MULTILINGUAL_E5_SMALL),
        model: Some(&MULTILINGUAL_E5_SMALL),
    },
    RetrievalPlanDefinition {
        id: "Snowflake/snowflake-arctic-embed-xs",
        name: "轻量英文",
        description: "面向英文代码与文档的紧凑语义检索模型。",
        language: "en",
        download_bytes: package_size(&SNOWFLAKE_ARCTIC_EMBED_XS),
        model: Some(&SNOWFLAKE_ARCTIC_EMBED_XS),
    },
];

pub(crate) const fn package_size(model: &SemanticModelDefinition) -> u64 {
    let mut total = 0;
    let mut index = 0;
    while index < model.files.len() {
        total += model.files[index].size;
        index += 1;
    }
    total
}

pub(crate) fn semantic_model(model_id: &str) -> Option<&'static SemanticModelDefinition> {
    SEMANTIC_MODELS.iter().find(|model| model.id == model_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn catalog_has_four_stable_non_placeholder_plans() {
        assert_eq!(RETRIEVAL_PLANS.len(), 4);
        assert_eq!(RETRIEVAL_PLANS[0].id, FULL_TEXT_PLAN_ID);
        assert_eq!(RETRIEVAL_PLANS[0].download_bytes, 0);
        let mut ids = HashSet::new();
        for plan in RETRIEVAL_PLANS {
            assert!(ids.insert(plan.id));
            if let Some(model) = plan.model {
                assert_eq!(plan.id, model.id);
                assert!(model.dimensions > 0);
                assert_eq!(model.minimum_app_version, MINIMUM_APP_VERSION);
                assert_eq!(plan.download_bytes, package_size(model));
                assert!(
                    model
                        .files
                        .iter()
                        .any(|file| file.local_name == "model.onnx")
                );
                assert!(model.files.iter().all(|file| {
                    file.size > 0
                        && file.sha256.len() == 64
                        && !file.local_name.contains('/')
                        && file.revision.len() == 40
                }));
            }
        }
        assert_eq!(BGE_SMALL_ZH.dimensions, 512);
        assert_eq!(MULTILINGUAL_E5_SMALL.dimensions, 384);
        assert_eq!(SNOWFLAKE_ARCTIC_EMBED_XS.dimensions, 384);
    }
}
