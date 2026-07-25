use serde::Deserialize;
use serde::Serialize;
use std::error::Error;
use std::fmt;
use std::io::Read;
use std::io::Write;
use sugarcode_state::EffectiveConfig;
use sugarcode_state::MAX_CONFIG_BYTES;
use sugarcode_state::ModelApiFormat;
use sugarcode_state::ModelConfig;
use sugarcode_state::ModelToken;
use sugarcode_state::SugarCodeHome;
use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelConfigCommandError {
    StdinRequired,
    InputTooLarge,
    InvalidInput,
    InvalidConfiguration,
    MissingConfiguration,
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
            Self::WriteFailed => "model configuration could not be saved",
        })
    }
}

impl Error for ModelConfigCommandError {}

pub fn set_model_config(
    home: &SugarCodeHome,
    input: &mut dyn Read,
    output: &mut dyn Write,
) -> Result<(), ModelConfigCommandError> {
    let mut bounded = input.take(MAX_CONFIG_BYTES + 1);
    let mut bytes = Vec::new();
    bounded
        .read_to_end(&mut bytes)
        .map_err(|_| ModelConfigCommandError::InvalidInput)?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(ModelConfigCommandError::InputTooLarge);
    }
    let input = serde_json::from_slice::<ModelConfigInput>(&bytes)
        .map_err(|_| ModelConfigCommandError::InvalidInput)?;
    let api_format = match input.api_format.as_str() {
        "openai-chat-completions" => ModelApiFormat::OpenAiChatCompletions,
        _ => return Err(ModelConfigCommandError::InvalidConfiguration),
    };
    let endpoint =
        Url::parse(&input.endpoint).map_err(|_| ModelConfigCommandError::InvalidConfiguration)?;
    let token = ModelToken::parse(input.token)
        .map_err(|_| ModelConfigCommandError::InvalidConfiguration)?;
    let model = ModelConfig::new(api_format, endpoint, input.model, token)
        .map_err(|_| ModelConfigCommandError::InvalidConfiguration)?;
    sugarcode_state::save_model_config(home, &model)
        .map_err(|_| ModelConfigCommandError::WriteFailed)?;
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
        has_token: model.token().is_some(),
    };
    serde_json::to_writer(&mut *output, &view).map_err(|_| ModelConfigCommandError::WriteFailed)?;
    writeln!(output).map_err(|_| ModelConfigCommandError::WriteFailed)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ModelConfigInput {
    api_format: String,
    endpoint: String,
    model: String,
    token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelConfigView<'a> {
    api_format: &'a str,
    endpoint: &'a str,
    model: &'a str,
    has_token: bool,
}
