use serde::Deserialize;
use serde::Serialize;
use std::error::Error;
use std::fmt;
use std::io::Read;
use std::io::Write;
use sugarcode_credential_store::CredentialReference;
use sugarcode_credential_store::CredentialStore;
use sugarcode_credential_store::CredentialStoreErrorKind;
use sugarcode_credential_store::MAX_SECRET_BYTES;
use sugarcode_credential_store::MODEL_TOKEN_CREDENTIAL_REFERENCE;
use sugarcode_credential_store::SecretValue;
use sugarcode_state::EffectiveConfig;
use sugarcode_state::MAX_CONFIG_BYTES;
use sugarcode_state::McpServerConfig;
use sugarcode_state::ModelApiFormat;
use sugarcode_state::ModelConfig;
use sugarcode_state::SugarCodeHome;
use url::Url;
use zeroize::Zeroizing;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelConfigCommandError {
    StdinRequired,
    InputTooLarge,
    InvalidInput,
    InvalidConfiguration,
    MissingConfiguration,
    CredentialFailed(CredentialStoreErrorKind),
    WriteFailed,
}

impl fmt::Display for ModelConfigCommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::StdinRequired => "model configuration input must be provided on standard input",
            Self::InputTooLarge => "model configuration input exceeds the size limit",
            Self::InvalidInput => "model configuration input is invalid",
            Self::InvalidConfiguration => "model configuration is invalid",
            Self::MissingConfiguration => "model configuration is not set",
            Self::CredentialFailed(_) => "model credential could not be updated",
            Self::WriteFailed => "model configuration could not be saved",
        })
    }
}

impl Error for ModelConfigCommandError {}

pub fn set_model_config(
    home: &SugarCodeHome,
    store: &dyn CredentialStore,
    input: &mut dyn Read,
    output: &mut dyn Write,
) -> Result<(), ModelConfigCommandError> {
    let mut bounded = input.take(MAX_CONFIG_BYTES + 1);
    let mut bytes = Zeroizing::new(Vec::new());
    bounded
        .read_to_end(&mut bytes)
        .map_err(|_| ModelConfigCommandError::InvalidInput)?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(ModelConfigCommandError::InputTooLarge);
    }
    let input = serde_json::from_slice::<ModelConfigInput>(bytes.as_slice())
        .map_err(|_| ModelConfigCommandError::InvalidInput)?;
    let ModelConfigInput {
        api_format,
        endpoint,
        model,
        token,
    } = input;
    let token = token.map(Zeroizing::new);
    let api_format = match api_format.as_str() {
        "openai-chat-completions" => ModelApiFormat::OpenAiChatCompletions,
        _ => return Err(ModelConfigCommandError::InvalidConfiguration),
    };
    let endpoint =
        Url::parse(&endpoint).map_err(|_| ModelConfigCommandError::InvalidConfiguration)?;
    let existing_reference = sugarcode_state::load_effective_config_for_home(home.clone())
        .map_err(|_| ModelConfigCommandError::InvalidConfiguration)?
        .model()
        .and_then(ModelConfig::credential_reference)
        .map(str::to_owned);
    let reference = CredentialReference::parse(MODEL_TOKEN_CREDENTIAL_REFERENCE)
        .expect("model token credential reference is valid");
    let (credential_reference, clear_credential) = match token {
        None => (existing_reference, false),
        Some(token) if token.is_empty() => (None, true),
        Some(token) => {
            if token.len() > MAX_SECRET_BYTES
                || !token.bytes().all(|byte| matches!(byte, 0x21..=0x7e))
            {
                return Err(ModelConfigCommandError::InvalidConfiguration);
            }
            let secret = SecretValue::from_zeroizing(Zeroizing::new(token.as_bytes().to_vec()))
                .map_err(|error| ModelConfigCommandError::CredentialFailed(error.kind()))?;
            store
                .set(&reference, &secret)
                .map_err(|error| ModelConfigCommandError::CredentialFailed(error.kind()))?;
            (Some(MODEL_TOKEN_CREDENTIAL_REFERENCE.to_string()), false)
        }
    };
    let model = ModelConfig::new(api_format, endpoint, model, credential_reference)
        .map_err(|_| ModelConfigCommandError::InvalidConfiguration)?;
    sugarcode_state::save_model_config(home, &model)
        .map_err(|_| ModelConfigCommandError::WriteFailed)?;
    if clear_credential {
        store
            .delete(&reference)
            .map_err(|error| ModelConfigCommandError::CredentialFailed(error.kind()))?;
    }
    writeln!(output, "Model configuration saved.").map_err(|_| ModelConfigCommandError::WriteFailed)
}

pub fn show_model_config(
    config: &EffectiveConfig,
    output: &mut dyn Write,
) -> Result<(), ModelConfigCommandError> {
    let model = config
        .model()
        .ok_or(ModelConfigCommandError::MissingConfiguration)?;
    let view = ModelConfigView {
        api_format: model.api_format().as_str(),
        endpoint: model.endpoint().as_str(),
        model: model.model(),
        has_token: model.credential_reference().is_some(),
    };
    serde_json::to_writer(&mut *output, &view).map_err(|_| ModelConfigCommandError::WriteFailed)?;
    writeln!(output).map_err(|_| ModelConfigCommandError::WriteFailed)
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
    serde_json::to_writer(&mut *output, &McpServerInventoryView { servers })
        .map_err(|_| ModelConfigCommandError::WriteFailed)?;
    writeln!(output).map_err(|_| ModelConfigCommandError::WriteFailed)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ModelConfigInput {
    api_format: String,
    endpoint: String,
    model: String,
    token: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelConfigView<'a> {
    api_format: &'a str,
    endpoint: &'a str,
    model: &'a str,
    has_token: bool,
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
