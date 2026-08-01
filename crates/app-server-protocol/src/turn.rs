use schemars::JsonSchema;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::de;
use ts_rs::TS;

use crate::AssetDescriptor;
use crate::AssetKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum TurnStatus {
    InProgress,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum TurnErrorKind {
    Authentication,
    ContextWindowExceeded,
    InvalidRequest,
    RateLimited,
    Timeout,
    Transport,
    Disconnected,
    Server,
    Protocol,
    Incomplete,
    Filtered,
    UnsupportedOutput,
    UnsupportedToolArguments,
    ProviderRequestTooLarge,
    ProviderResponseTooLarge,
    OutputTooLarge,
    StateUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct TurnError {
    pub kind: TurnErrorKind,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub provider: Option<ProviderErrorMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tool_schema: Option<ToolSchemaError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ProviderErrorMetadata {
    pub http_status: u16,
    pub code: Option<String>,
    pub request_id: Option<String>,
    pub retry_after: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ToolSchemaError {
    pub tool_name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum ModelProviderFamily {
    Openai,
    Anthropic,
    Gemini,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum ModelWireApi {
    OpenaiResponses,
    OpenaiChatCompletions,
    AnthropicMessages,
    GeminiGenerateContent,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ModelSelectionCapabilities {
    pub tool_calls: bool,
    pub strict_tools: bool,
    pub parallel_tools: bool,
    pub image_input: bool,
    pub pdf_input: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ModelSelectionSnapshot {
    pub profile_id: String,
    pub provider_family: ModelProviderFamily,
    pub wire_api: ModelWireApi,
    pub model_id: String,
    pub display_name: String,
    pub context_window_tokens: u32,
    pub effective_capabilities: ModelSelectionCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    pub status: TurnStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<ModelSelectionSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<TurnError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub usage: Option<TokenUsage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum TokenUsageSource {
    Provider,
    Estimated,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct TokenUsageSample {
    pub input_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct TokenUsage {
    pub last_request: TokenUsageSample,
    pub turn_total: TokenUsageSample,
    pub request_count: u64,
    pub context_window_tokens: u32,
    pub source: TokenUsageSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct TokenUsageUpdatedNotification {
    pub thread_id: String,
    pub turn_id: String,
    pub usage: TokenUsage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum TurnWarningCode {
    ProviderManagedContinuationFallback,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct TurnWarningNotification {
    pub thread_id: String,
    pub turn_id: String,
    pub code: TurnWarningCode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct TurnStartParams {
    pub thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub input: Option<Vec<TurnInputPart>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model_profile_id: Option<String>,
}

impl<'de> Deserialize<'de> for TurnStartParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let params = TurnStartParamsWire::deserialize(deserializer)?;
        if params.thread_id.trim().is_empty() {
            return Err(de::Error::custom("threadId must not be blank"));
        }
        if let Some(input) = params.input.as_ref() {
            validate_turn_input(input).map_err(de::Error::custom)?;
        }
        if params.model_profile_id.as_ref().is_some_and(|profile_id| {
            profile_id.is_empty()
                || profile_id.len() > 64
                || !profile_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        }) {
            return Err(de::Error::custom("modelProfileId is invalid"));
        }
        Ok(Self {
            thread_id: params.thread_id,
            input: params.input,
            model_profile_id: params.model_profile_id,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TurnStartParamsWire {
    thread_id: String,
    input: Option<Vec<TurnInputPart>>,
    model_profile_id: Option<String>,
}

pub const MAX_TURN_INPUT_BYTES: usize = 64 * 1024;
pub const MAX_TURN_ATTACHMENTS: usize = 10;
pub const MAX_TURN_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
#[ts(tag = "type", rename_all = "camelCase")]
pub enum TurnInputPart {
    Text { text: String },
    Image { asset: AssetDescriptor },
    Document { asset: AssetDescriptor },
}

fn validate_turn_input(input: &[TurnInputPart]) -> Result<(), &'static str> {
    if input.is_empty() {
        return Err("input must contain at least one content part");
    }
    let mut text_bytes = 0usize;
    let mut attachment_count = 0usize;
    let mut attachment_bytes = 0u64;
    let mut has_non_blank_text = false;
    for part in input {
        match part {
            TurnInputPart::Text { text } => {
                text_bytes = text_bytes
                    .checked_add(text.len())
                    .ok_or("input is too large")?;
                has_non_blank_text |= !text.trim().is_empty();
            }
            TurnInputPart::Image { asset } => {
                validate_asset(asset, AssetKind::Image)?;
                attachment_count += 1;
                attachment_bytes = attachment_bytes
                    .checked_add(u64::from(asset.size_bytes))
                    .ok_or("attachments are too large")?;
            }
            TurnInputPart::Document { asset } => {
                if !matches!(asset.kind, AssetKind::Pdf | AssetKind::Text) {
                    return Err("document part has the wrong asset kind");
                }
                validate_asset(asset, asset.kind)?;
                attachment_count += 1;
                attachment_bytes = attachment_bytes
                    .checked_add(u64::from(asset.size_bytes))
                    .ok_or("attachments are too large")?;
            }
        }
    }
    if text_bytes > MAX_TURN_INPUT_BYTES {
        return Err("input text is too large");
    }
    if attachment_count > MAX_TURN_ATTACHMENTS {
        return Err("too many attachments");
    }
    if attachment_bytes > MAX_TURN_ATTACHMENT_BYTES {
        return Err("attachments are too large");
    }
    if attachment_count == 0 && !has_non_blank_text {
        return Err("input must contain text or an attachment");
    }
    Ok(())
}

fn validate_asset(asset: &AssetDescriptor, expected_kind: AssetKind) -> Result<(), &'static str> {
    if asset.kind != expected_kind {
        return Err("content part has the wrong asset kind");
    }
    if asset.asset_id != format!("ast_{}", asset.sha256)
        || asset.sha256.len() != 64
        || !asset
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("asset identity is invalid");
    }
    if asset.original_name.is_empty()
        || asset.original_name.len() > 255
        || asset.original_name.chars().any(char::is_control)
        || asset.original_name.contains(['/', '\\'])
    {
        return Err("asset originalName is invalid");
    }
    if asset.size_bytes == 0 || asset.media_type.is_empty() {
        return Err("asset metadata is invalid");
    }
    match expected_kind {
        AssetKind::Image if !asset.media_type.starts_with("image/") => {
            Err("image asset MIME type is invalid")
        }
        AssetKind::Pdf if asset.media_type != "application/pdf" => {
            Err("PDF asset MIME type is invalid")
        }
        AssetKind::Text if !asset.media_type.starts_with("text/") => {
            Err("text asset MIME type is invalid")
        }
        _ => Ok(()),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct TurnStartResponse {
    pub turn: Turn,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct TurnStartedNotification {
    pub thread_id: String,
    pub turn: Turn,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct TurnCompletedNotification {
    pub thread_id: String,
    pub turn: Turn,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct TurnInterruptParams {
    pub thread_id: String,
    pub turn_id: String,
}

impl<'de> Deserialize<'de> for TurnInterruptParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let params = TurnInterruptParamsWire::deserialize(deserializer)?;
        if params.thread_id.trim().is_empty() || params.turn_id.trim().is_empty() {
            return Err(de::Error::custom("turn identifiers must not be blank"));
        }
        Ok(Self {
            thread_id: params.thread_id,
            turn_id: params.turn_id,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TurnInterruptParamsWire {
    thread_id: String,
    turn_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
pub struct TurnInterruptResponse {}
