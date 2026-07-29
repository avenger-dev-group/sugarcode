use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::error::Error;
use std::fmt;
use std::io::Read;
use std::io::Write;
use sugarcode_credential_store::CredentialReference;
use sugarcode_credential_store::CredentialStore;
use sugarcode_credential_store::CredentialStoreErrorKind;
use sugarcode_credential_store::MAX_SECRET_BYTES;
use sugarcode_credential_store::SecretValue;
use sugarcode_state::EffectiveConfig;
use sugarcode_state::MAX_CONFIG_BYTES;
use sugarcode_state::McpServerConfig;
use sugarcode_state::ModelApiFormat;
use sugarcode_state::ModelConfig;
use sugarcode_state::SugarCodeHome;
use url::Url;
use zeroize::Zeroizing;

const MODEL_CONFIG_CONTRACT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelConfigCommandError {
    StdinRequired,
    InputTooLarge,
    InvalidInput,
    InvalidConfiguration,
    RevisionMismatch,
    CredentialFailed(CredentialStoreErrorKind),
    WriteFailed,
}

impl fmt::Display for ModelConfigCommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::StdinRequired => {
                "model configuration input must be provided on standard input with --json"
            }
            Self::InputTooLarge => "model configuration input exceeds the size limit",
            Self::InvalidInput => "model configuration input is invalid",
            Self::InvalidConfiguration => "model configuration is invalid",
            Self::RevisionMismatch => "model configuration changed before it could be saved",
            Self::CredentialFailed(_) => "model credential could not be updated",
            Self::WriteFailed => "model configuration could not be saved",
        })
    }
}

impl Error for ModelConfigCommandError {}

pub fn validate_model_config(
    input: &mut dyn Read,
    output: &mut dyn Write,
) -> Result<(), ModelConfigCommandError> {
    let input = read_json::<ModelConfigValidationInput>(input)?;
    if input.contract_version != MODEL_CONFIG_CONTRACT_VERSION {
        return Err(ModelConfigCommandError::InvalidInput);
    }
    let model = parse_model(input.config)?;
    write_json(
        output,
        &ValidationReceipt {
            contract_version: MODEL_CONFIG_CONTRACT_VERSION,
            valid: true,
            config: ModelConfigView::from(&model),
        },
    )
}

pub fn set_model_config(
    home: &SugarCodeHome,
    store: &dyn CredentialStore,
    input: &mut dyn Read,
    output: &mut dyn Write,
) -> Result<(), ModelConfigCommandError> {
    let input = read_json::<ModelConfigSetInput>(input)?;
    if input.contract_version != MODEL_CONFIG_CONTRACT_VERSION {
        return Err(ModelConfigCommandError::InvalidInput);
    }
    let model = parse_model(input.config)?;
    let existing = sugarcode_state::load_effective_config_for_home(home.clone())
        .map_err(|_| ModelConfigCommandError::InvalidConfiguration)?;
    if config_revision(existing.model()) != input.expected_revision {
        return Err(ModelConfigCommandError::RevisionMismatch);
    }
    sugarcode_state::save_model_config(home, &model)
        .map_err(|_| ModelConfigCommandError::WriteFailed)?;
    inspect_model_config(home, store, output)
}

pub fn inspect_model_config(
    home: &SugarCodeHome,
    store: &dyn CredentialStore,
    output: &mut dyn Write,
) -> Result<(), ModelConfigCommandError> {
    let config = sugarcode_state::load_effective_config_for_home(home.clone())
        .map_err(|_| ModelConfigCommandError::InvalidConfiguration)?;
    let status = credential_status_for_model(store, config.model());
    write_json(
        output,
        &InspectionReceipt {
            contract_version: MODEL_CONFIG_CONTRACT_VERSION,
            revision: config_revision(config.model()),
            config: config.model().map(ModelConfigView::from),
            credential_status: status,
        },
    )
}

pub fn set_model_credential(
    store: &dyn CredentialStore,
    reference: &str,
    input: &mut dyn Read,
    output: &mut dyn Write,
) -> Result<(), ModelConfigCommandError> {
    let reference = CredentialReference::parse(reference)
        .map_err(|error| ModelConfigCommandError::CredentialFailed(error.kind()))?;
    let mut bytes = Zeroizing::new(Vec::with_capacity(MAX_SECRET_BYTES));
    input
        .take((MAX_SECRET_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| ModelConfigCommandError::InvalidInput)?;
    if bytes.is_empty()
        || bytes.len() > MAX_SECRET_BYTES
        || !bytes.iter().all(|byte| matches!(byte, 0x21..=0x7e))
    {
        return Err(ModelConfigCommandError::InvalidConfiguration);
    }
    let secret = SecretValue::from_zeroizing(bytes)
        .map_err(|error| ModelConfigCommandError::CredentialFailed(error.kind()))?;
    store
        .set(&reference, &secret)
        .map_err(|error| ModelConfigCommandError::CredentialFailed(error.kind()))?;
    write_credential_receipt(output, reference.as_str(), CredentialStatus::Present, None)
}

pub fn show_model_credential_status(
    store: &dyn CredentialStore,
    reference: &str,
    output: &mut dyn Write,
) -> Result<(), ModelConfigCommandError> {
    let reference = CredentialReference::parse(reference)
        .map_err(|error| ModelConfigCommandError::CredentialFailed(error.kind()))?;
    let status = credential_status(store, &reference);
    write_credential_receipt(output, reference.as_str(), status, None)
}

pub fn delete_model_credential(
    store: &dyn CredentialStore,
    reference: &str,
    output: &mut dyn Write,
) -> Result<(), ModelConfigCommandError> {
    let reference = CredentialReference::parse(reference)
        .map_err(|error| ModelConfigCommandError::CredentialFailed(error.kind()))?;
    let deleted = store
        .delete(&reference)
        .map_err(|error| ModelConfigCommandError::CredentialFailed(error.kind()))?;
    write_credential_receipt(
        output,
        reference.as_str(),
        CredentialStatus::Missing,
        Some(deleted),
    )
}

pub fn list_mcp_servers(
    config: &EffectiveConfig,
    output: &mut dyn Write,
) -> Result<(), ModelConfigCommandError> {
    let mut servers = config
        .mcp_servers()
        .iter()
        .map(|server| McpServerView {
            id: server.id(),
            transport: match server {
                McpServerConfig::Stdio(_) => "stdio",
                McpServerConfig::LoopbackStreamableHttp(_) => "loopbackStreamableHttp",
            },
        })
        .collect::<Vec<_>>();
    servers.sort_by(|left, right| left.id.as_bytes().cmp(right.id.as_bytes()));
    write_json(output, &McpServerInventoryView { servers })
}

fn read_json<T: for<'de> Deserialize<'de>>(
    input: &mut dyn Read,
) -> Result<T, ModelConfigCommandError> {
    let mut bounded = input.take(MAX_CONFIG_BYTES + 1);
    let mut bytes = Zeroizing::new(Vec::new());
    bounded
        .read_to_end(&mut bytes)
        .map_err(|_| ModelConfigCommandError::InvalidInput)?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(ModelConfigCommandError::InputTooLarge);
    }
    serde_json::from_slice(bytes.as_slice()).map_err(|_| ModelConfigCommandError::InvalidInput)
}

fn parse_model(input: ModelConfigInput) -> Result<ModelConfig, ModelConfigCommandError> {
    let api_format = match input.api_format.as_str() {
        "openai-chat-completions" => ModelApiFormat::OpenAiChatCompletions,
        _ => return Err(ModelConfigCommandError::InvalidConfiguration),
    };
    let endpoint =
        Url::parse(&input.endpoint).map_err(|_| ModelConfigCommandError::InvalidConfiguration)?;
    ModelConfig::new(
        api_format,
        endpoint,
        input.model,
        input.credential_reference,
    )
    .map_err(|_| ModelConfigCommandError::InvalidConfiguration)
}

fn config_revision(model: Option<&ModelConfig>) -> String {
    let mut hasher = Sha256::new();
    match model {
        None => hasher.update(b"model-config-v1:none"),
        Some(model) => {
            hasher.update(b"model-config-v1\0");
            hasher.update(model.api_format().as_str().as_bytes());
            hasher.update(b"\0");
            hasher.update(model.endpoint().as_str().as_bytes());
            hasher.update(b"\0");
            hasher.update(model.model().as_bytes());
            hasher.update(b"\0");
            if let Some(reference) = model.credential_reference() {
                hasher.update(reference.as_bytes());
            }
        }
    }
    format!("{:x}", hasher.finalize())
}

fn credential_status_for_model(
    store: &dyn CredentialStore,
    model: Option<&ModelConfig>,
) -> CredentialStatus {
    let Some(reference) = model.and_then(ModelConfig::credential_reference) else {
        return CredentialStatus::NotConfigured;
    };
    let Ok(reference) = CredentialReference::parse(reference) else {
        return CredentialStatus::Unavailable;
    };
    credential_status(store, &reference)
}

fn credential_status(
    store: &dyn CredentialStore,
    reference: &CredentialReference,
) -> CredentialStatus {
    match store.get(reference) {
        Ok(Some(_)) => CredentialStatus::Present,
        Ok(None) => CredentialStatus::Missing,
        Err(_) => CredentialStatus::Unavailable,
    }
}

fn write_credential_receipt(
    output: &mut dyn Write,
    reference: &str,
    status: CredentialStatus,
    deleted: Option<bool>,
) -> Result<(), ModelConfigCommandError> {
    write_json(
        output,
        &CredentialReceipt {
            contract_version: MODEL_CONFIG_CONTRACT_VERSION,
            reference,
            status,
            deleted,
        },
    )
}

fn write_json(
    output: &mut dyn Write,
    value: &impl Serialize,
) -> Result<(), ModelConfigCommandError> {
    serde_json::to_writer(&mut *output, value).map_err(|_| ModelConfigCommandError::WriteFailed)?;
    writeln!(output).map_err(|_| ModelConfigCommandError::WriteFailed)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ModelConfigValidationInput {
    contract_version: u32,
    config: ModelConfigInput,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ModelConfigSetInput {
    contract_version: u32,
    expected_revision: String,
    config: ModelConfigInput,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ModelConfigInput {
    api_format: String,
    endpoint: String,
    model: String,
    credential_reference: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ValidationReceipt<'a> {
    contract_version: u32,
    valid: bool,
    config: ModelConfigView<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InspectionReceipt<'a> {
    contract_version: u32,
    revision: String,
    config: Option<ModelConfigView<'a>>,
    credential_status: CredentialStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelConfigView<'a> {
    api_format: &'a str,
    endpoint: &'a str,
    model: &'a str,
    credential_reference: Option<&'a str>,
}

impl<'a> From<&'a ModelConfig> for ModelConfigView<'a> {
    fn from(model: &'a ModelConfig) -> Self {
        Self {
            api_format: model.api_format().as_str(),
            endpoint: model.endpoint().as_str(),
            model: model.model(),
            credential_reference: model.credential_reference(),
        }
    }
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
enum CredentialStatus {
    NotConfigured,
    Present,
    Missing,
    Unavailable,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialReceipt<'a> {
    contract_version: u32,
    reference: &'a str,
    status: CredentialStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    deleted: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McpServerInventoryView<'a> {
    servers: Vec<McpServerView<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McpServerView<'a> {
    id: &'a str,
    transport: &'static str,
}

#[cfg(test)]
#[path = "tests/config.rs"]
mod tests;
