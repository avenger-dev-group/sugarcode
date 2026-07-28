use crate::MAX_CALL_ARGUMENT_NODES;
use crate::MAX_JSON_DEPTH;
use crate::MAX_RESULT_CONTENT_BLOCKS;
use crate::MAX_STRUCTURED_RESULT_BYTES;
use crate::McpCallErrorKind;
use crate::McpToolDefinition;
use serde_json::Map;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpNormalizedResult {
    content: String,
    is_error: bool,
    observed_bytes: u64,
    canonical_bytes: u64,
    sha256: String,
    content_blocks: u64,
    structured_content: bool,
}

impl McpNormalizedResult {
    pub fn content(&self) -> &str {
        &self.content
    }

    pub const fn is_error(&self) -> bool {
        self.is_error
    }

    pub const fn observed_bytes(&self) -> u64 {
        self.observed_bytes
    }

    pub const fn canonical_bytes(&self) -> u64 {
        self.canonical_bytes
    }

    pub fn sha256(&self) -> &str {
        &self.sha256
    }

    pub const fn content_blocks(&self) -> u64 {
        self.content_blocks
    }

    pub const fn has_structured_content(&self) -> bool {
        self.structured_content
    }
}

pub(crate) fn normalize(
    tool: &McpToolDefinition,
    result: Value,
    observed_bytes: usize,
) -> Result<McpNormalizedResult, McpCallErrorKind> {
    let object = result.as_object().ok_or(McpCallErrorKind::InvalidResult)?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "content" | "structuredContent" | "isError" | "_meta"
        )
    }) {
        return Err(McpCallErrorKind::InvalidResult);
    }
    let content = object
        .get("content")
        .and_then(Value::as_array)
        .ok_or(McpCallErrorKind::InvalidResult)?;
    if content.len() > MAX_RESULT_CONTENT_BLOCKS {
        return Err(McpCallErrorKind::ResultTooLarge);
    }
    let mut texts = Vec::with_capacity(content.len());
    for block in content {
        let block = block.as_object().ok_or(McpCallErrorKind::InvalidResult)?;
        if block.len() != 2
            || block.get("type").and_then(Value::as_str) != Some("text")
            || !block.contains_key("text")
        {
            return Err(if block.get("type").and_then(Value::as_str).is_some() {
                McpCallErrorKind::UnsupportedContent
            } else {
                McpCallErrorKind::InvalidResult
            });
        }
        let text = block
            .get("text")
            .and_then(Value::as_str)
            .ok_or(McpCallErrorKind::InvalidResult)?;
        texts.push(Value::String(text.to_owned()));
    }
    let structured = match object.get("structuredContent") {
        None => None,
        Some(value) if value.is_object() => {
            validate_value_bounds(value)?;
            let canonical = canonicalize(value);
            if serde_json::to_vec(&canonical)
                .map_err(|_| McpCallErrorKind::InvalidResult)?
                .len()
                > MAX_STRUCTURED_RESULT_BYTES
            {
                return Err(McpCallErrorKind::ResultTooLarge);
            }
            Some(canonical)
        }
        Some(_) => return Err(McpCallErrorKind::InvalidResult),
    };
    if let Some(schema) = tool.output_schema() {
        let structured = structured
            .as_ref()
            .ok_or(McpCallErrorKind::OutputSchemaMismatch)?;
        let validator =
            jsonschema::validator_for(schema).map_err(|_| McpCallErrorKind::InvalidResult)?;
        if !validator.is_valid(structured) {
            return Err(McpCallErrorKind::OutputSchemaMismatch);
        }
    }
    let is_error = match object.get("isError") {
        None => false,
        Some(Value::Bool(value)) => *value,
        Some(_) => return Err(McpCallErrorKind::InvalidResult),
    };
    let content_blocks = u64::try_from(texts.len()).unwrap_or(u64::MAX);
    let mut normalized = Map::new();
    normalized.insert("isError".to_owned(), Value::Bool(is_error));
    normalized.insert("text".to_owned(), Value::Array(texts));
    if let Some(structured) = structured.as_ref() {
        normalized.insert("structuredContent".to_owned(), structured.clone());
    }
    let canonical = serde_json::to_vec(&Value::Object(normalized))
        .map_err(|_| McpCallErrorKind::InvalidResult)?;
    let canonical_bytes = u64::try_from(canonical.len()).unwrap_or(u64::MAX);
    let content =
        String::from_utf8(canonical.clone()).map_err(|_| McpCallErrorKind::InvalidResult)?;
    Ok(McpNormalizedResult {
        content,
        is_error,
        observed_bytes: u64::try_from(observed_bytes).unwrap_or(u64::MAX),
        canonical_bytes,
        sha256: format!("{:x}", Sha256::digest(&canonical)),
        content_blocks,
        structured_content: structured.is_some(),
    })
}

pub(crate) fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(canonicalize).collect()),
        Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
            let mut canonical = Map::new();
            for key in keys {
                canonical.insert(key.clone(), canonicalize(&object[key]));
            }
            Value::Object(canonical)
        }
        _ => value.clone(),
    }
}

pub(crate) fn validate_value_bounds(value: &Value) -> Result<(), McpCallErrorKind> {
    let mut nodes = 0_usize;
    validate_node(value, 1, &mut nodes)
}

fn validate_node(value: &Value, depth: usize, nodes: &mut usize) -> Result<(), McpCallErrorKind> {
    *nodes = nodes.saturating_add(1);
    if depth > MAX_JSON_DEPTH || *nodes > MAX_CALL_ARGUMENT_NODES {
        return Err(McpCallErrorKind::ValueTooComplex);
    }
    match value {
        Value::Array(values) => {
            for value in values {
                validate_node(value, depth + 1, nodes)?;
            }
        }
        Value::Object(object) => {
            for value in object.values() {
                validate_node(value, depth + 1, nodes)?;
            }
        }
        _ => {}
    }
    Ok(())
}
