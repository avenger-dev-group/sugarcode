use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::error::Error;
use std::fmt;
use std::io::Read;
use std::io::Write;
use std::path::PathBuf;
use sugarcode_state::EffectiveConfig;
use sugarcode_state::MAX_CONFIG_BYTES;
use sugarcode_state::McpServerConfig;
use sugarcode_state::ModelCapabilityMode;
use sugarcode_state::ModelCatalog;
use sugarcode_state::ModelConnection;
use sugarcode_state::ModelProfile;
use sugarcode_state::ModelProfileCapabilities;
use sugarcode_state::ModelProviderFamily;
use sugarcode_state::ModelWireApi;
use sugarcode_state::SugarCodeHome;
use url::Url;
use zeroize::Zeroizing;

const MODEL_CONFIG_CONTRACT_VERSION: u32 = 1;
const MCP_CONFIG_CONTRACT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelConfigCommandError {
    StdinRequired,
    InputTooLarge,
    InvalidInput,
    InvalidConfiguration,
    RevisionMismatch,
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
            Self::WriteFailed => "model configuration could not be saved",
        })
    }
}

impl Error for ModelConfigCommandError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpConfigCommandError {
    StdinRequired,
    InputTooLarge,
    InvalidInput,
    InvalidConfiguration,
    RevisionMismatch,
    WriteFailed,
}

impl fmt::Display for McpConfigCommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::StdinRequired => {
                "MCP configuration input must be provided on standard input with --json"
            }
            Self::InputTooLarge => "MCP configuration input exceeds the size limit",
            Self::InvalidInput => "MCP configuration input is invalid",
            Self::InvalidConfiguration => "MCP configuration is invalid",
            Self::RevisionMismatch => "MCP configuration changed before it could be saved",
            Self::WriteFailed => "MCP configuration could not be saved",
        })
    }
}

impl Error for McpConfigCommandError {}

pub fn validate_model_config(
    input: &mut dyn Read,
    output: &mut dyn Write,
) -> Result<(), ModelConfigCommandError> {
    let input = read_json::<ModelConfigValidationInput>(input)?;
    if input.contract_version != MODEL_CONFIG_CONTRACT_VERSION {
        return Err(ModelConfigCommandError::InvalidInput);
    }
    let catalog = parse_model_catalog(input.config, None)?;
    write_json(
        output,
        &ValidationReceipt {
            contract_version: MODEL_CONFIG_CONTRACT_VERSION,
            valid: true,
            config: ModelCatalogView::from(&catalog),
        },
    )
}

pub fn set_model_config(
    home: &SugarCodeHome,
    input: &mut dyn Read,
    output: &mut dyn Write,
) -> Result<(), ModelConfigCommandError> {
    let input = read_json::<ModelConfigSetInput>(input)?;
    if input.contract_version != MODEL_CONFIG_CONTRACT_VERSION {
        return Err(ModelConfigCommandError::InvalidInput);
    }
    let existing = sugarcode_state::load_model_edit_config_for_home(home.clone())
        .map_err(|_| ModelConfigCommandError::InvalidConfiguration)?;
    if config_revision(existing.models()) != input.expected_revision {
        return Err(ModelConfigCommandError::RevisionMismatch);
    }
    let catalog = parse_model_catalog(
        input.config,
        Some(&resolve_credential_updates(
            existing.models(),
            input.credential_updates,
        )?),
    )?;
    sugarcode_state::save_model_catalog(home, &catalog)
        .map_err(|_| ModelConfigCommandError::WriteFailed)?;
    inspect_model_config(home, output)
}

pub fn inspect_model_config(
    home: &SugarCodeHome,
    output: &mut dyn Write,
) -> Result<(), ModelConfigCommandError> {
    let config = sugarcode_state::load_model_edit_config_for_home(home.clone())
        .map_err(|_| ModelConfigCommandError::InvalidConfiguration)?;
    write_json(
        output,
        &InspectionReceipt {
            contract_version: MODEL_CONFIG_CONTRACT_VERSION,
            revision: config_revision(config.models()),
            config: config.models().map(ModelCatalogView::from),
            credential_statuses: credential_statuses(config.models()),
        },
    )
}

pub async fn discover_model_config(
    home: &SugarCodeHome,
    connection_id: &str,
    output: &mut dyn Write,
) -> Result<(), ModelConfigCommandError> {
    let config = sugarcode_state::load_effective_config_for_home(home.clone())
        .map_err(|_| ModelConfigCommandError::InvalidConfiguration)?;
    let connection = config
        .models()
        .and_then(|catalog| catalog.connection(connection_id))
        .filter(|connection| connection.enabled())
        .ok_or(ModelConfigCommandError::InvalidConfiguration)?;
    let protocol = match connection.wire_api() {
        ModelWireApi::OpenAiResponses | ModelWireApi::OpenAiChatCompletions => {
            sugarcode_model_provider::ModelDiscoveryProtocol::OpenAi
        }
        ModelWireApi::AnthropicMessages => {
            sugarcode_model_provider::ModelDiscoveryProtocol::Anthropic
        }
        ModelWireApi::GeminiGenerateContent => {
            sugarcode_model_provider::ModelDiscoveryProtocol::Gemini
        }
    };
    let models = sugarcode_model_provider::discover_models(
        connection.base_url(),
        connection
            .api_key()
            .map(|api_key| Zeroizing::new(api_key.to_owned())),
        protocol,
    )
    .await
    .map_err(|_| ModelConfigCommandError::InvalidConfiguration)?;
    write_json(
        output,
        &ModelDiscoveryReceipt {
            connection_id,
            models: models
                .iter()
                .map(|model| DiscoveredModelView {
                    model_id: &model.model_id,
                    display_name: &model.display_name,
                    context_window_tokens: model.context_window_tokens,
                })
                .collect(),
        },
    )
}

pub fn delete_model_api_key(
    home: &SugarCodeHome,
    connection_id: &str,
    expected_revision: &str,
    output: &mut dyn Write,
) -> Result<bool, ModelConfigCommandError> {
    let existing = sugarcode_state::load_model_edit_config_for_home(home.clone())
        .map_err(|_| ModelConfigCommandError::InvalidConfiguration)?;
    if config_revision(existing.models()) != expected_revision {
        return Err(ModelConfigCommandError::RevisionMismatch);
    }
    let Some(existing_catalog) = existing.models() else {
        inspect_model_config(home, output)?;
        return Ok(false);
    };
    let Some(existing_connection) = existing_catalog.connection(connection_id) else {
        return Err(ModelConfigCommandError::InvalidConfiguration);
    };
    if existing_connection.api_key().is_none() {
        inspect_model_config(home, output)?;
        return Ok(false);
    }
    let connections = existing_catalog
        .connections()
        .iter()
        .map(|connection| {
            clone_connection(
                connection,
                if connection.id() == connection_id {
                    None
                } else {
                    connection.api_key().map(ToOwned::to_owned)
                },
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let catalog = ModelCatalog::new(
        existing_catalog.default_profile_id().to_owned(),
        connections,
        existing_catalog.profiles().to_vec(),
    )
    .map_err(|_| ModelConfigCommandError::InvalidConfiguration)?;
    sugarcode_state::save_model_catalog(home, &catalog)
        .map_err(|_| ModelConfigCommandError::WriteFailed)?;
    inspect_model_config(home, output)?;
    Ok(true)
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

pub fn inspect_mcp_config(
    home: &SugarCodeHome,
    output: &mut dyn Write,
) -> Result<(), McpConfigCommandError> {
    let config = sugarcode_state::load_effective_config_for_home(home.clone())
        .map_err(|_| McpConfigCommandError::InvalidConfiguration)?;
    write_mcp_receipt(output, config.mcp_servers())
}

pub fn validate_mcp_config(
    input: &mut dyn Read,
    output: &mut dyn Write,
) -> Result<(), McpConfigCommandError> {
    let input = read_mcp_json::<McpConfigValidationInput>(input)?;
    if input.contract_version != MCP_CONFIG_CONTRACT_VERSION {
        return Err(McpConfigCommandError::InvalidInput);
    }
    let servers = parse_mcp_servers(input.servers)?;
    write_mcp_json(
        output,
        &McpConfigValidationReceipt {
            contract_version: MCP_CONFIG_CONTRACT_VERSION,
            valid: true,
            revision: mcp_config_revision(&servers),
            servers: mcp_server_views(&servers),
        },
    )
}

pub fn set_mcp_config(
    home: &SugarCodeHome,
    input: &mut dyn Read,
    output: &mut dyn Write,
) -> Result<(), McpConfigCommandError> {
    let input = read_mcp_json::<McpConfigSetInput>(input)?;
    if input.contract_version != MCP_CONFIG_CONTRACT_VERSION {
        return Err(McpConfigCommandError::InvalidInput);
    }
    let servers = parse_mcp_servers(input.servers)?;
    let existing = sugarcode_state::load_effective_config_for_home(home.clone())
        .map_err(|_| McpConfigCommandError::InvalidConfiguration)?;
    if mcp_config_revision(existing.mcp_servers()) != input.expected_revision {
        return Err(McpConfigCommandError::RevisionMismatch);
    }
    sugarcode_state::save_mcp_config(home, &servers)
        .map_err(|_| McpConfigCommandError::WriteFailed)?;
    inspect_mcp_config(home, output)
}

fn parse_mcp_servers(
    inputs: Vec<McpServerInput>,
) -> Result<Vec<McpServerConfig>, McpConfigCommandError> {
    if inputs.len() > sugarcode_state::MAX_MCP_SERVERS {
        return Err(McpConfigCommandError::InvalidConfiguration);
    }
    let mut servers = inputs
        .into_iter()
        .map(|input| match input {
            McpServerInput::Stdio {
                id,
                executable,
                argv,
                cwd,
            } => McpServerConfig::stdio(id, PathBuf::from(executable), argv, PathBuf::from(cwd)),
            McpServerInput::LoopbackStreamableHttp { id, endpoint } => {
                McpServerConfig::loopback_streamable_http(id, &endpoint)
            }
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| McpConfigCommandError::InvalidConfiguration)?;
    servers.sort_by(|left, right| left.id().as_bytes().cmp(right.id().as_bytes()));
    if servers.windows(2).any(|pair| pair[0].id() == pair[1].id()) {
        return Err(McpConfigCommandError::InvalidConfiguration);
    }
    Ok(servers)
}

fn write_mcp_receipt(
    output: &mut dyn Write,
    servers: &[McpServerConfig],
) -> Result<(), McpConfigCommandError> {
    let mut servers = servers.to_vec();
    servers.sort_by(|left, right| left.id().as_bytes().cmp(right.id().as_bytes()));
    write_mcp_json(
        output,
        &McpConfigInspectionReceipt {
            contract_version: MCP_CONFIG_CONTRACT_VERSION,
            revision: mcp_config_revision(&servers),
            servers: mcp_server_views(&servers),
        },
    )
}

fn mcp_config_revision(servers: &[McpServerConfig]) -> String {
    let mut servers = servers.iter().collect::<Vec<_>>();
    servers.sort_by(|left, right| left.id().as_bytes().cmp(right.id().as_bytes()));
    let mut hasher = Sha256::new();
    hasher.update(b"mcp-config-v1\0");
    for server in servers {
        hasher.update(server.id().as_bytes());
        hasher.update(b"\0");
        match server {
            McpServerConfig::Stdio(server) => {
                hasher.update(b"stdio\0");
                hasher.update(server.executable().as_os_str().as_encoded_bytes());
                hasher.update(b"\0");
                for argument in server.argv() {
                    hasher.update(argument.as_bytes());
                    hasher.update(b"\0");
                }
                hasher.update(b"\0");
                hasher.update(server.cwd().as_os_str().as_encoded_bytes());
            }
            McpServerConfig::LoopbackStreamableHttp(server) => {
                hasher.update(b"loopbackStreamableHttp\0");
                hasher.update(server.endpoint().as_str().as_bytes());
            }
        }
        hasher.update(b"\0");
    }
    format!("{:x}", hasher.finalize())
}

fn mcp_server_views(servers: &[McpServerConfig]) -> Vec<McpServerConfigView<'_>> {
    servers
        .iter()
        .map(|server| match server {
            McpServerConfig::Stdio(server) => McpServerConfigView::Stdio {
                id: server.id(),
                executable: server.executable().to_string_lossy(),
                argv: server.argv(),
                cwd: server.cwd().to_string_lossy(),
            },
            McpServerConfig::LoopbackStreamableHttp(server) => {
                McpServerConfigView::LoopbackStreamableHttp {
                    id: server.id(),
                    endpoint: server.endpoint().as_str(),
                }
            }
        })
        .collect()
}

fn read_mcp_json<T: for<'de> Deserialize<'de>>(
    input: &mut dyn Read,
) -> Result<T, McpConfigCommandError> {
    let mut bounded = input.take(MAX_CONFIG_BYTES + 1);
    let mut bytes = Zeroizing::new(Vec::new());
    bounded
        .read_to_end(&mut bytes)
        .map_err(|_| McpConfigCommandError::InvalidInput)?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(McpConfigCommandError::InputTooLarge);
    }
    serde_json::from_slice(bytes.as_slice()).map_err(|_| McpConfigCommandError::InvalidInput)
}

fn write_mcp_json(
    output: &mut dyn Write,
    value: &impl Serialize,
) -> Result<(), McpConfigCommandError> {
    serde_json::to_writer(&mut *output, value).map_err(|_| McpConfigCommandError::WriteFailed)?;
    writeln!(output).map_err(|_| McpConfigCommandError::WriteFailed)
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

fn parse_model_catalog(
    input: ModelCatalogInput,
    credentials: Option<&[(String, Option<String>)]>,
) -> Result<ModelCatalog, ModelConfigCommandError> {
    if let Some(credentials) = credentials {
        let connection_ids = input
            .connections
            .iter()
            .map(|connection| connection.id.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        let credential_ids = credentials
            .iter()
            .map(|(connection_id, _)| connection_id.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        if connection_ids != credential_ids || credentials.len() != input.connections.len() {
            return Err(ModelConfigCommandError::InvalidConfiguration);
        }
    }
    let connections = input
        .connections
        .into_iter()
        .map(|connection| {
            let provider_family = parse_provider_family(&connection.provider_family)?;
            let wire_api = parse_wire_api(&connection.wire_api)?;
            let base_url = Url::parse(&connection.base_url)
                .map_err(|_| ModelConfigCommandError::InvalidConfiguration)?;
            let continuation_mode = match connection.continuation_mode.as_deref() {
                None | Some("localReplay") => sugarcode_state::ModelContinuationMode::LocalReplay,
                Some("providerManaged") => sugarcode_state::ModelContinuationMode::ProviderManaged,
                Some(_) => return Err(ModelConfigCommandError::InvalidConfiguration),
            };
            let api_key = match credentials {
                None => None,
                Some(credentials) => credentials
                    .iter()
                    .find(|(id, _)| id == &connection.id)
                    .ok_or(ModelConfigCommandError::InvalidConfiguration)?
                    .1
                    .clone(),
            };
            let connection = ModelConnection::new(
                connection.id,
                provider_family,
                connection.display_name,
                base_url,
                connection.enabled,
                wire_api,
                api_key,
            )
            .map_err(|_| ModelConfigCommandError::InvalidConfiguration)?;
            Ok(connection.with_continuation_mode(continuation_mode))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let profiles = input
        .profiles
        .into_iter()
        .map(|profile| {
            ModelProfile::new(
                profile.id,
                profile.connection_id,
                profile.display_name,
                profile.model_id,
                profile.context_window_tokens,
                ModelProfileCapabilities::new(
                    parse_capability_mode(profile.tool_calls.as_deref())?,
                    parse_capability_mode(profile.strict_tools.as_deref())?,
                    parse_capability_mode(profile.parallel_tools.as_deref())?,
                    parse_capability_mode(profile.image_input.as_deref())?,
                    parse_capability_mode(profile.pdf_input.as_deref())?,
                ),
            )
            .map_err(|_| ModelConfigCommandError::InvalidConfiguration)
        })
        .collect::<Result<Vec<_>, _>>()?;
    ModelCatalog::new(input.default_profile_id, connections, profiles)
        .map_err(|_| ModelConfigCommandError::InvalidConfiguration)
}

fn parse_provider_family(value: &str) -> Result<ModelProviderFamily, ModelConfigCommandError> {
    match value {
        "openai" => Ok(ModelProviderFamily::OpenAi),
        "anthropic" => Ok(ModelProviderFamily::Anthropic),
        "gemini" => Ok(ModelProviderFamily::Gemini),
        _ => Err(ModelConfigCommandError::InvalidConfiguration),
    }
}

fn parse_wire_api(value: &str) -> Result<ModelWireApi, ModelConfigCommandError> {
    match value {
        "openaiResponses" => Ok(ModelWireApi::OpenAiResponses),
        "openaiChatCompletions" => Ok(ModelWireApi::OpenAiChatCompletions),
        "anthropicMessages" => Ok(ModelWireApi::AnthropicMessages),
        "geminiGenerateContent" => Ok(ModelWireApi::GeminiGenerateContent),
        _ => Err(ModelConfigCommandError::InvalidConfiguration),
    }
}

fn parse_capability_mode(
    value: Option<&str>,
) -> Result<ModelCapabilityMode, ModelConfigCommandError> {
    match value.unwrap_or("auto") {
        "auto" => Ok(ModelCapabilityMode::Auto),
        "enabled" => Ok(ModelCapabilityMode::Enabled),
        "disabled" => Ok(ModelCapabilityMode::Disabled),
        _ => Err(ModelConfigCommandError::InvalidConfiguration),
    }
}

fn config_revision(models: Option<&ModelCatalog>) -> String {
    let mut hasher = Sha256::new();
    match models {
        None => hasher.update(b"model-catalog-v1:none"),
        Some(models) => {
            hasher.update(b"model-catalog-v1\0");
            hasher.update(models.default_profile_id().as_bytes());
            hasher.update(b"\0");
            for connection in models.connections() {
                hasher.update(connection.id().as_bytes());
                hasher.update(b"\0");
                hasher.update(connection.provider_family().as_str().as_bytes());
                hasher.update(b"\0");
                hasher.update(connection.display_name().as_bytes());
                hasher.update(b"\0");
                hasher.update(connection.base_url().as_str().as_bytes());
                hasher.update(b"\0");
                hasher.update([u8::from(connection.enabled())]);
                hasher.update(connection.wire_api().as_str().as_bytes());
                hasher.update(b"\0");
                hasher.update(connection.continuation_mode().as_str().as_bytes());
                hasher.update(b"\0");
                if let Some(api_key) = connection.api_key() {
                    hasher.update(api_key.as_bytes());
                }
                hasher.update(b"\0");
            }
            for profile in models.profiles() {
                hasher.update(profile.id().as_bytes());
                hasher.update(b"\0");
                hasher.update(profile.connection_id().as_bytes());
                hasher.update(b"\0");
                hasher.update(profile.display_name().as_bytes());
                hasher.update(b"\0");
                hasher.update(profile.model_id().as_bytes());
                hasher.update(b"\0");
                hasher.update(
                    profile
                        .context_window_tokens()
                        .map_or_else(|| "-".to_owned(), |value| value.to_string())
                        .as_bytes(),
                );
                hasher.update(b"\0");
                hasher.update(profile.tool_calls().as_str().as_bytes());
                hasher.update(b"\0");
                hasher.update(profile.strict_tools().as_str().as_bytes());
                hasher.update(b"\0");
                hasher.update(profile.parallel_tools().as_str().as_bytes());
                hasher.update(b"\0");
                hasher.update(profile.image_input().as_str().as_bytes());
                hasher.update(b"\0");
                hasher.update(profile.pdf_input().as_str().as_bytes());
                hasher.update(b"\0");
            }
        }
    }
    format!("{:x}", hasher.finalize())
}

fn credential_statuses(models: Option<&ModelCatalog>) -> Vec<CredentialStatusView<'_>> {
    models
        .into_iter()
        .flat_map(ModelCatalog::connections)
        .map(|connection| CredentialStatusView {
            connection_id: connection.id(),
            status: if connection.api_key().is_some() {
                ApiKeyStatus::Present
            } else {
                ApiKeyStatus::NotConfigured
            },
        })
        .collect()
}

fn resolve_credential_updates(
    existing: Option<&ModelCatalog>,
    updates: Vec<ModelCredentialUpdate>,
) -> Result<Vec<(String, Option<String>)>, ModelConfigCommandError> {
    let mut seen = std::collections::BTreeSet::new();
    let mut resolved = Vec::with_capacity(updates.len());
    for update in updates {
        let (connection_id, api_key) = match update {
            ModelCredentialUpdate::Preserve { connection_id } => {
                let api_key = existing
                    .and_then(|catalog| catalog.connection(&connection_id))
                    .and_then(ModelConnection::api_key)
                    .map(ToOwned::to_owned);
                (connection_id, api_key)
            }
            ModelCredentialUpdate::Set {
                connection_id,
                value,
            } => (connection_id, Some(value)),
            ModelCredentialUpdate::Delete { connection_id } => (connection_id, None),
        };
        if !seen.insert(connection_id.clone()) {
            return Err(ModelConfigCommandError::InvalidConfiguration);
        }
        resolved.push((connection_id, api_key));
    }
    Ok(resolved)
}

fn clone_connection(
    connection: &ModelConnection,
    api_key: Option<String>,
) -> Result<ModelConnection, ModelConfigCommandError> {
    ModelConnection::new(
        connection.id().to_owned(),
        connection.provider_family(),
        connection.display_name().to_owned(),
        connection.base_url().clone(),
        connection.enabled(),
        connection.wire_api(),
        api_key,
    )
    .map_err(|_| ModelConfigCommandError::InvalidConfiguration)
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
    config: ModelCatalogInput,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ModelConfigSetInput {
    contract_version: u32,
    expected_revision: String,
    config: ModelCatalogInput,
    credential_updates: Vec<ModelCredentialUpdate>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ModelCatalogInput {
    default_profile_id: String,
    connections: Vec<ModelConnectionInput>,
    profiles: Vec<ModelProfileInput>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ModelConnectionInput {
    id: String,
    provider_family: String,
    display_name: String,
    base_url: String,
    enabled: bool,
    wire_api: String,
    continuation_mode: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ModelProfileInput {
    id: String,
    connection_id: String,
    display_name: String,
    model_id: String,
    context_window_tokens: Option<u32>,
    tool_calls: Option<String>,
    strict_tools: Option<String>,
    parallel_tools: Option<String>,
    image_input: Option<String>,
    pdf_input: Option<String>,
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    deny_unknown_fields,
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum ModelCredentialUpdate {
    Preserve {
        connection_id: String,
    },
    Set {
        connection_id: String,
        value: String,
    },
    Delete {
        connection_id: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ValidationReceipt<'a> {
    contract_version: u32,
    valid: bool,
    config: ModelCatalogView<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InspectionReceipt<'a> {
    contract_version: u32,
    revision: String,
    config: Option<ModelCatalogView<'a>>,
    credential_statuses: Vec<CredentialStatusView<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelCatalogView<'a> {
    default_profile_id: &'a str,
    connections: Vec<ModelConnectionView<'a>>,
    profiles: Vec<ModelProfileView<'a>>,
}

impl<'a> From<&'a ModelCatalog> for ModelCatalogView<'a> {
    fn from(models: &'a ModelCatalog) -> Self {
        Self {
            default_profile_id: models.default_profile_id(),
            connections: models
                .connections()
                .iter()
                .map(ModelConnectionView::from)
                .collect(),
            profiles: models
                .profiles()
                .iter()
                .map(ModelProfileView::from)
                .collect(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelConnectionView<'a> {
    id: &'a str,
    provider_family: &'a str,
    display_name: &'a str,
    base_url: &'a str,
    enabled: bool,
    wire_api: &'a str,
    continuation_mode: &'a str,
}

impl<'a> From<&'a ModelConnection> for ModelConnectionView<'a> {
    fn from(connection: &'a ModelConnection) -> Self {
        Self {
            id: connection.id(),
            provider_family: connection.provider_family().as_str(),
            display_name: connection.display_name(),
            base_url: connection.base_url().as_str(),
            enabled: connection.enabled(),
            wire_api: connection.wire_api().as_str(),
            continuation_mode: connection.continuation_mode().as_str(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelProfileView<'a> {
    id: &'a str,
    connection_id: &'a str,
    display_name: &'a str,
    model_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_window_tokens: Option<u32>,
    tool_calls: &'a str,
    strict_tools: &'a str,
    parallel_tools: &'a str,
    image_input: &'a str,
    pdf_input: &'a str,
}

impl<'a> From<&'a ModelProfile> for ModelProfileView<'a> {
    fn from(profile: &'a ModelProfile) -> Self {
        Self {
            id: profile.id(),
            connection_id: profile.connection_id(),
            display_name: profile.display_name(),
            model_id: profile.model_id(),
            context_window_tokens: profile.context_window_tokens(),
            tool_calls: profile.tool_calls().as_str(),
            strict_tools: profile.strict_tools().as_str(),
            parallel_tools: profile.parallel_tools().as_str(),
            image_input: profile.image_input().as_str(),
            pdf_input: profile.pdf_input().as_str(),
        }
    }
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
enum ApiKeyStatus {
    NotConfigured,
    Present,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialStatusView<'a> {
    connection_id: &'a str,
    status: ApiKeyStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelDiscoveryReceipt<'a> {
    connection_id: &'a str,
    models: Vec<DiscoveredModelView<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveredModelView<'a> {
    model_id: &'a str,
    display_name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_window_tokens: Option<u32>,
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct McpConfigValidationInput {
    contract_version: u32,
    servers: Vec<McpServerInput>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct McpConfigSetInput {
    contract_version: u32,
    expected_revision: String,
    servers: Vec<McpServerInput>,
}

#[derive(Deserialize)]
#[serde(tag = "transport", deny_unknown_fields, rename_all = "camelCase")]
enum McpServerInput {
    Stdio {
        id: String,
        executable: String,
        argv: Vec<String>,
        cwd: String,
    },
    LoopbackStreamableHttp {
        id: String,
        endpoint: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McpConfigInspectionReceipt<'a> {
    contract_version: u32,
    revision: String,
    servers: Vec<McpServerConfigView<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McpConfigValidationReceipt<'a> {
    contract_version: u32,
    valid: bool,
    revision: String,
    servers: Vec<McpServerConfigView<'a>>,
}

#[derive(Serialize)]
#[serde(tag = "transport", rename_all = "camelCase")]
enum McpServerConfigView<'a> {
    Stdio {
        id: &'a str,
        executable: std::borrow::Cow<'a, str>,
        argv: &'a [String],
        cwd: std::borrow::Cow<'a, str>,
    },
    LoopbackStreamableHttp {
        id: &'a str,
        endpoint: &'a str,
    },
}

#[cfg(test)]
#[path = "tests/config.rs"]
mod tests;
