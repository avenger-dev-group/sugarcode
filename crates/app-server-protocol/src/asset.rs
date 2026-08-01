use schemars::JsonSchema;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::de;
use ts_rs::TS;

pub const MAX_ASSET_IMPORT_BASE64_BYTES: usize = 27_962_032;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AssetImportParams {
    pub file_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub media_type: Option<String>,
    pub data: String,
}

impl<'de> Deserialize<'de> for AssetImportParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let params = AssetImportParamsWire::deserialize(deserializer)?;
        if params.file_name.is_empty()
            || params.file_name.len() > 255
            || params.file_name.chars().any(char::is_control)
            || params.file_name.contains(['/', '\\'])
        {
            return Err(de::Error::custom("fileName is invalid"));
        }
        if params.media_type.as_ref().is_some_and(|media_type| {
            media_type.is_empty()
                || media_type.len() > 127
                || !media_type.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'+' | b'-' | b'.')
                })
        }) {
            return Err(de::Error::custom("mediaType is invalid"));
        }
        if params.data.is_empty() || params.data.len() > MAX_ASSET_IMPORT_BASE64_BYTES {
            return Err(de::Error::custom("data is empty or too large"));
        }
        Ok(Self {
            file_name: params.file_name,
            media_type: params.media_type,
            data: params.data,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AssetImportParamsWire {
    file_name: String,
    media_type: Option<String>,
    data: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum AssetKind {
    Image,
    Pdf,
    Text,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AssetDescriptor {
    pub asset_id: String,
    pub sha256: String,
    pub media_type: String,
    pub original_name: String,
    pub size_bytes: u32,
    pub kind: AssetKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pdf_pages: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AssetImportResponse {
    pub asset: AssetDescriptor,
}
