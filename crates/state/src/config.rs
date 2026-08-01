use crate::StateError;
use crate::SugarCodeHome;
use crate::resolve_sugarcode_home_from_process;
use std::error::Error;
use std::fmt;
use std::fs;
use std::io;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use tempfile::NamedTempFile;
use url::Url;
use zeroize::Zeroizing;

pub const CONFIG_FILE_NAME: &str = "config.toml";
pub const CURRENT_CONFIG_SCHEMA_VERSION: u32 = 1;
pub const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
pub const MAX_MODEL_NAME_BYTES: usize = 256;
pub const MAX_MODEL_API_KEY_BYTES: usize = 2 * 1024;
pub const MAX_MODEL_CONNECTIONS: usize = 16;
pub const MAX_MODEL_PROFILES: usize = 128;
pub const MAX_MODEL_ID_BYTES: usize = 64;
pub const MAX_MODEL_DISPLAY_NAME_BYTES: usize = 128;
pub const MIN_MODEL_CONTEXT_WINDOW_TOKENS: u32 = 4_096;
pub const MAX_MODEL_CONTEXT_WINDOW_TOKENS: u32 = 2_097_152;
pub const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS: u32 = 131_072;
pub const MAX_MCP_SERVERS: usize = 2;
pub const MAX_MCP_SERVER_ID_BYTES: usize = 32;
pub const MAX_MCP_PATH_BYTES: usize = 1024;
pub const MAX_MCP_ENDPOINT_BYTES: usize = 1024;
pub const MAX_MCP_ARG_COUNT: usize = 32;
pub const MAX_MCP_ARG_BYTES: usize = 8 * 1024;
pub const MAX_MCP_ARGV_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelProviderFamily {
    OpenAi,
    Anthropic,
    Gemini,
}

impl ModelProviderFamily {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelWireApi {
    OpenAiResponses,
    OpenAiChatCompletions,
    AnthropicMessages,
    GeminiGenerateContent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelContinuationMode {
    LocalReplay,
    ProviderManaged,
}

impl ModelContinuationMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::LocalReplay => "localReplay",
            Self::ProviderManaged => "providerManaged",
        }
    }
}

impl ModelWireApi {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OpenAiResponses => "openaiResponses",
            Self::OpenAiChatCompletions => "openaiChatCompletions",
            Self::AnthropicMessages => "anthropicMessages",
            Self::GeminiGenerateContent => "geminiGenerateContent",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelCapabilityMode {
    Auto,
    Enabled,
    Disabled,
}

impl ModelCapabilityMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Enabled => "enabled",
            Self::Disabled => "disabled",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelProfileCapabilities {
    tool_calls: ModelCapabilityMode,
    strict_tools: ModelCapabilityMode,
    parallel_tools: ModelCapabilityMode,
    image_input: ModelCapabilityMode,
    pdf_input: ModelCapabilityMode,
}

impl ModelProfileCapabilities {
    pub const fn new(
        tool_calls: ModelCapabilityMode,
        strict_tools: ModelCapabilityMode,
        parallel_tools: ModelCapabilityMode,
        image_input: ModelCapabilityMode,
        pdf_input: ModelCapabilityMode,
    ) -> Self {
        Self {
            tool_calls,
            strict_tools,
            parallel_tools,
            image_input,
            pdf_input,
        }
    }
}

impl Default for ModelProfileCapabilities {
    fn default() -> Self {
        Self::new(
            ModelCapabilityMode::Auto,
            ModelCapabilityMode::Auto,
            ModelCapabilityMode::Auto,
            ModelCapabilityMode::Auto,
            ModelCapabilityMode::Auto,
        )
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ModelConnection {
    id: String,
    provider_family: ModelProviderFamily,
    display_name: String,
    base_url: Url,
    enabled: bool,
    wire_api: ModelWireApi,
    continuation_mode: ModelContinuationMode,
    api_key: Option<Zeroizing<String>>,
}

impl ModelConnection {
    pub fn new(
        id: String,
        provider_family: ModelProviderFamily,
        display_name: String,
        base_url: Url,
        enabled: bool,
        wire_api: ModelWireApi,
        api_key: Option<String>,
    ) -> Result<Self, &'static str> {
        validate_model_id(&id)?;
        validate_model_display_name(&display_name)?;
        validate_model_base_url(&base_url)?;
        if let Some(api_key) = api_key.as_deref() {
            validate_model_api_key(api_key)?;
        }
        validate_wire_api(provider_family, wire_api)?;
        Ok(Self {
            id,
            provider_family,
            display_name,
            base_url,
            enabled,
            wire_api,
            continuation_mode: ModelContinuationMode::LocalReplay,
            api_key: api_key.map(Zeroizing::new),
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub const fn provider_family(&self) -> ModelProviderFamily {
        self.provider_family
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub fn base_url(&self) -> &Url {
        &self.base_url
    }

    pub const fn enabled(&self) -> bool {
        self.enabled
    }

    pub const fn wire_api(&self) -> ModelWireApi {
        self.wire_api
    }

    pub const fn continuation_mode(&self) -> ModelContinuationMode {
        self.continuation_mode
    }

    pub fn with_continuation_mode(mut self, mode: ModelContinuationMode) -> Self {
        self.continuation_mode = if self.wire_api == ModelWireApi::OpenAiResponses {
            mode
        } else {
            ModelContinuationMode::LocalReplay
        };
        self
    }

    pub fn api_key(&self) -> Option<&str> {
        self.api_key.as_deref().map(String::as_str)
    }
}

impl fmt::Debug for ModelConnection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ModelConnection")
            .field("id", &self.id)
            .field("provider_family", &self.provider_family)
            .field("display_name", &self.display_name)
            .field("base_url", &"<redacted>")
            .field("enabled", &self.enabled)
            .field("wire_api", &self.wire_api)
            .field("continuation_mode", &self.continuation_mode)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelProfile {
    id: String,
    connection_id: String,
    display_name: String,
    model_id: String,
    context_window_tokens: Option<u32>,
    capabilities: ModelProfileCapabilities,
}

impl ModelProfile {
    pub fn new(
        id: String,
        connection_id: String,
        display_name: String,
        model_id: String,
        context_window_tokens: Option<u32>,
        capabilities: ModelProfileCapabilities,
    ) -> Result<Self, &'static str> {
        validate_model_id(&id)?;
        validate_model_id(&connection_id)?;
        validate_model_display_name(&display_name)?;
        validate_model_name(&model_id)?;
        if context_window_tokens.is_some_and(|value| {
            !(MIN_MODEL_CONTEXT_WINDOW_TOKENS..=MAX_MODEL_CONTEXT_WINDOW_TOKENS).contains(&value)
        }) {
            return Err("invalidContextWindow");
        }
        Ok(Self {
            id,
            connection_id,
            display_name,
            model_id,
            context_window_tokens,
            capabilities,
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn connection_id(&self) -> &str {
        &self.connection_id
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub fn model_id(&self) -> &str {
        &self.model_id
    }

    pub const fn context_window_tokens(&self) -> Option<u32> {
        self.context_window_tokens
    }

    pub const fn effective_context_window_tokens(&self) -> u32 {
        match self.context_window_tokens {
            Some(value) => value,
            None => DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
        }
    }

    pub const fn tool_calls(&self) -> ModelCapabilityMode {
        self.capabilities.tool_calls
    }

    pub const fn strict_tools(&self) -> ModelCapabilityMode {
        self.capabilities.strict_tools
    }

    pub const fn parallel_tools(&self) -> ModelCapabilityMode {
        self.capabilities.parallel_tools
    }

    pub const fn image_input(&self) -> ModelCapabilityMode {
        self.capabilities.image_input
    }

    pub const fn pdf_input(&self) -> ModelCapabilityMode {
        self.capabilities.pdf_input
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelCatalog {
    default_profile_id: String,
    connections: Vec<ModelConnection>,
    profiles: Vec<ModelProfile>,
}

impl ModelCatalog {
    pub fn new(
        default_profile_id: String,
        connections: Vec<ModelConnection>,
        profiles: Vec<ModelProfile>,
    ) -> Result<Self, &'static str> {
        validate_model_id(&default_profile_id)?;
        if connections.is_empty() || connections.len() > MAX_MODEL_CONNECTIONS {
            return Err("invalidConnectionCount");
        }
        if profiles.is_empty() || profiles.len() > MAX_MODEL_PROFILES {
            return Err("invalidProfileCount");
        }
        let mut connection_ids = std::collections::BTreeSet::new();
        if connections
            .iter()
            .any(|connection| !connection_ids.insert(connection.id()))
        {
            return Err("duplicateConnectionId");
        }
        let mut profile_ids = std::collections::BTreeSet::new();
        if profiles.iter().any(|profile| {
            !profile_ids.insert(profile.id()) || !connection_ids.contains(profile.connection_id())
        }) {
            return Err("invalidProfileReference");
        }
        for profile in &profiles {
            let connection = connections
                .iter()
                .find(|connection| connection.id() == profile.connection_id())
                .ok_or("invalidProfileReference")?;
            if connection.wire_api() == ModelWireApi::OpenAiChatCompletions
                && profile.pdf_input() == ModelCapabilityMode::Enabled
            {
                return Err("capabilityWireApiMismatch");
            }
        }
        let Some(default_profile) = profiles
            .iter()
            .find(|profile| profile.id() == default_profile_id)
        else {
            return Err("invalidDefaultProfile");
        };
        let default_connection = connections
            .iter()
            .find(|connection| connection.id() == default_profile.connection_id())
            .ok_or("invalidDefaultProfile")?;
        if !default_connection.enabled() {
            return Err("disabledDefaultConnection");
        }
        Ok(Self {
            default_profile_id,
            connections,
            profiles,
        })
    }

    pub fn default_profile_id(&self) -> &str {
        &self.default_profile_id
    }

    pub fn connections(&self) -> &[ModelConnection] {
        &self.connections
    }

    pub fn profiles(&self) -> &[ModelProfile] {
        &self.profiles
    }

    pub fn profile(&self, id: &str) -> Option<&ModelProfile> {
        self.profiles.iter().find(|profile| profile.id() == id)
    }

    pub fn connection(&self, id: &str) -> Option<&ModelConnection> {
        self.connections
            .iter()
            .find(|connection| connection.id() == id)
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct McpStdioServerConfig {
    id: String,
    executable: PathBuf,
    argv: Vec<String>,
    cwd: PathBuf,
}

impl McpStdioServerConfig {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn executable(&self) -> &Path {
        &self.executable
    }

    pub fn argv(&self) -> &[String] {
        &self.argv
    }

    pub fn cwd(&self) -> &Path {
        &self.cwd
    }
}

impl fmt::Debug for McpStdioServerConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("McpStdioServerConfig")
            .field("id", &self.id)
            .field("executable", &"<redacted>")
            .field("argv", &"<redacted>")
            .field("cwd", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct McpStreamableHttpServerConfig {
    id: String,
    endpoint: Url,
}

impl McpStreamableHttpServerConfig {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn endpoint(&self) -> &Url {
        &self.endpoint
    }
}

impl fmt::Debug for McpStreamableHttpServerConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("McpStreamableHttpServerConfig")
            .field("id", &self.id)
            .field("endpoint", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub enum McpServerConfig {
    Stdio(McpStdioServerConfig),
    LoopbackStreamableHttp(McpStreamableHttpServerConfig),
}

impl McpServerConfig {
    pub fn id(&self) -> &str {
        match self {
            Self::Stdio(server) => server.id(),
            Self::LoopbackStreamableHttp(server) => server.id(),
        }
    }

    pub fn as_stdio(&self) -> Option<&McpStdioServerConfig> {
        match self {
            Self::Stdio(server) => Some(server),
            Self::LoopbackStreamableHttp(_) => None,
        }
    }

    pub fn as_loopback_streamable_http(&self) -> Option<&McpStreamableHttpServerConfig> {
        match self {
            Self::Stdio(_) => None,
            Self::LoopbackStreamableHttp(server) => Some(server),
        }
    }

    pub fn stdio(
        id: String,
        executable: PathBuf,
        argv: Vec<String>,
        cwd: PathBuf,
    ) -> Result<Self, &'static str> {
        if !valid_mcp_server_id(&id) {
            return Err("invalidServerId");
        }
        validate_mcp_path(&executable)?;
        validate_mcp_path(&cwd)?;
        if argv.len() > MAX_MCP_ARG_COUNT {
            return Err("tooManyArguments");
        }
        let mut total = 0_usize;
        for argument in &argv {
            if argument.len() > MAX_MCP_ARG_BYTES || argument.chars().any(char::is_control) {
                return Err("invalidArgument");
            }
            total = total.saturating_add(argument.len());
        }
        if total > MAX_MCP_ARGV_BYTES {
            return Err("argumentsTooLarge");
        }
        Ok(Self::Stdio(McpStdioServerConfig {
            id,
            executable,
            argv,
            cwd,
        }))
    }

    pub fn loopback_streamable_http(id: String, endpoint: &str) -> Result<Self, &'static str> {
        if !valid_mcp_server_id(&id) {
            return Err("invalidServerId");
        }
        Ok(Self::LoopbackStreamableHttp(
            McpStreamableHttpServerConfig {
                id,
                endpoint: validate_loopback_streamable_http_endpoint(endpoint)?,
            },
        ))
    }
}

impl fmt::Debug for McpServerConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Stdio(server) => server.fmt(formatter),
            Self::LoopbackStreamableHttp(server) => server.fmt(formatter),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct EffectiveConfig {
    home: SugarCodeHome,
    config_path: PathBuf,
    schema_version: u32,
    models: Option<ModelCatalog>,
    mcp_servers: Vec<McpServerConfig>,
}

impl EffectiveConfig {
    pub fn home(&self) -> &SugarCodeHome {
        &self.home
    }

    pub fn config_path(&self) -> &Path {
        &self.config_path
    }

    pub const fn schema_version(&self) -> u32 {
        self.schema_version
    }

    pub fn models(&self) -> Option<&ModelCatalog> {
        self.models.as_ref()
    }

    pub fn mcp_servers(&self) -> &[McpServerConfig] {
        &self.mcp_servers
    }
}

impl fmt::Debug for EffectiveConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EffectiveConfig")
            .field("home", &self.home)
            .field("config_path", &self.config_path)
            .field("schema_version", &self.schema_version)
            .field("models", &self.models)
            .field("mcp_servers", &self.mcp_servers)
            .finish()
    }
}

#[derive(Debug)]
pub enum ConfigError {
    Unreadable {
        path: PathBuf,
        kind: io::ErrorKind,
    },
    NotRegularFile {
        path: PathBuf,
    },
    TooLarge {
        path: PathBuf,
    },
    InvalidUtf8 {
        path: PathBuf,
    },
    InvalidToml {
        path: PathBuf,
        line: usize,
        column: usize,
    },
    UnknownField {
        path: PathBuf,
        field: String,
        line: usize,
        column: usize,
    },
    InvalidSchemaVersion {
        path: PathBuf,
        line: usize,
        column: usize,
    },
    UnsupportedSchemaVersion {
        path: PathBuf,
        version: i64,
        line: usize,
        column: usize,
    },
    InvalidModelField {
        path: PathBuf,
        field: &'static str,
        kind: &'static str,
        line: usize,
        column: usize,
    },
    InvalidMcpField {
        path: PathBuf,
        field: String,
        kind: &'static str,
        line: usize,
        column: usize,
    },
    WriteFailed {
        path: PathBuf,
        kind: io::ErrorKind,
    },
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreadable { path, kind } => {
                write!(
                    formatter,
                    "{}: configuration is unreadable ({kind:?})",
                    path.display()
                )
            }
            Self::NotRegularFile { path } => {
                write!(
                    formatter,
                    "{}: configuration is not a regular file",
                    path.display()
                )
            }
            Self::TooLarge { path } => {
                write!(
                    formatter,
                    "{}: configuration exceeds the {} byte limit",
                    path.display(),
                    MAX_CONFIG_BYTES
                )
            }
            Self::InvalidUtf8 { path } => {
                write!(formatter, "{}: configuration is not UTF-8", path.display())
            }
            Self::InvalidToml { path, line, column } => {
                write!(
                    formatter,
                    "{}:{line}:{column}: invalid TOML configuration",
                    path.display()
                )
            }
            Self::UnknownField {
                path,
                field,
                line,
                column,
            } => {
                write!(
                    formatter,
                    "{}:{line}:{column}: unknown configuration field `{field}`",
                    path.display()
                )
            }
            Self::InvalidSchemaVersion { path, line, column } => {
                write!(
                    formatter,
                    "{}:{line}:{column}: schema_version must be the integer 1",
                    path.display()
                )
            }
            Self::UnsupportedSchemaVersion {
                path,
                version,
                line,
                column,
            } => {
                write!(
                    formatter,
                    "{}:{line}:{column}: unsupported configuration schema version {version}",
                    path.display()
                )
            }
            Self::InvalidModelField {
                path,
                field,
                kind,
                line,
                column,
            } => write!(
                formatter,
                "{}:{line}:{column}: invalid model configuration field `{field}` ({kind})",
                path.display()
            ),
            Self::InvalidMcpField {
                path,
                field,
                kind,
                line,
                column,
            } => write!(
                formatter,
                "{}:{line}:{column}: invalid MCP configuration field `{field}` ({kind})",
                path.display()
            ),
            Self::WriteFailed { path, kind } => {
                write!(
                    formatter,
                    "{}: configuration could not be saved ({kind:?})",
                    path.display()
                )
            }
        }
    }
}

impl Error for ConfigError {}

pub fn load_effective_config(cli_home: Option<PathBuf>) -> Result<EffectiveConfig, StateError> {
    let home = resolve_sugarcode_home_from_process(cli_home)?;
    Ok(load_effective_config_for_home(home)?)
}

/// Loads the process-wide configuration needed to start a SugarCode surface.
///
/// Model configuration is deliberately not parsed here. A model is selected
/// and validated when a Turn starts, so a broken or missing model entry cannot
/// prevent the CLI, workspace, history, settings, or other local capabilities
/// from becoming available.
pub fn load_runtime_config(cli_home: Option<PathBuf>) -> Result<EffectiveConfig, StateError> {
    let home = resolve_sugarcode_home_from_process(cli_home)?;
    Ok(load_runtime_config_for_home(home)?)
}

pub fn load_effective_config_for_home(home: SugarCodeHome) -> Result<EffectiveConfig, ConfigError> {
    load_config_for_home(home, true)
}

pub fn load_runtime_config_for_home(home: SugarCodeHome) -> Result<EffectiveConfig, ConfigError> {
    load_config_for_home(home, false)
}

/// Loads a valid model when possible, but treats only an invalid model section
/// as empty so model settings can repair it without discarding valid MCP
/// configuration from the same file.
pub fn load_model_edit_config_for_home(
    home: SugarCodeHome,
) -> Result<EffectiveConfig, ConfigError> {
    match load_effective_config_for_home(home.clone()) {
        Ok(config) => Ok(config),
        Err(error) if is_model_section_error(&error) => load_runtime_config_for_home(home),
        Err(error) => Err(error),
    }
}

fn is_model_section_error(error: &ConfigError) -> bool {
    match error {
        ConfigError::InvalidModelField { .. } => true,
        ConfigError::UnknownField { field, .. } => {
            field == "model"
                || field.starts_with("model.")
                || field == "models"
                || field.starts_with("models.")
        }
        _ => false,
    }
}

fn load_config_for_home(
    home: SugarCodeHome,
    include_model: bool,
) -> Result<EffectiveConfig, ConfigError> {
    let config_path = home.path().join(CONFIG_FILE_NAME);
    let metadata = match fs::symlink_metadata(&config_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(default_config(home, config_path));
        }
        Err(error) => {
            return Err(ConfigError::Unreadable {
                path: config_path,
                kind: error.kind(),
            });
        }
    };

    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ConfigError::NotRegularFile { path: config_path });
    }
    if metadata.len() > MAX_CONFIG_BYTES {
        return Err(ConfigError::TooLarge { path: config_path });
    }

    let bytes = fs::read(&config_path).map_err(|error| ConfigError::Unreadable {
        path: config_path.clone(),
        kind: error.kind(),
    })?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(ConfigError::TooLarge { path: config_path });
    }
    let contents = std::str::from_utf8(&bytes).map_err(|_| ConfigError::InvalidUtf8 {
        path: config_path.clone(),
    })?;
    if contents.trim().is_empty() {
        return Ok(default_config(home, config_path));
    }
    let parsed = toml::from_str::<toml::Value>(contents).map_err(|error| {
        let (line, column) = error
            .span()
            .map(|span| text_position(contents, span.start))
            .unwrap_or((1, 1));
        ConfigError::InvalidToml {
            path: config_path.clone(),
            line,
            column,
        }
    })?;
    let Some(table) = parsed.as_table() else {
        return Err(ConfigError::InvalidToml {
            path: config_path,
            line: 1,
            column: 1,
        });
    };

    let mut unknown_fields = table
        .keys()
        .filter(|field| {
            !matches!(
                field.as_str(),
                "schema_version" | "model" | "models" | "mcp"
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    unknown_fields.sort();
    if let Some(field) = unknown_fields.into_iter().next() {
        let (line, column) = field_position(contents, &field);
        return Err(ConfigError::UnknownField {
            path: config_path,
            field,
            line,
            column,
        });
    }

    let schema_version = match table.get("schema_version") {
        None => i64::from(CURRENT_CONFIG_SCHEMA_VERSION),
        Some(toml::Value::Integer(version)) => *version,
        Some(_) => {
            let (line, column) = field_position(contents, "schema_version");
            return Err(ConfigError::InvalidSchemaVersion {
                path: config_path,
                line,
                column,
            });
        }
    };
    if schema_version != i64::from(CURRENT_CONFIG_SCHEMA_VERSION) {
        let (line, column) = field_position(contents, "schema_version");
        return Err(ConfigError::UnsupportedSchemaVersion {
            path: config_path,
            version: schema_version,
            line,
            column,
        });
    }

    if include_model && table.contains_key("model") {
        let (line, column) = field_position(contents, "model");
        return Err(ConfigError::UnknownField {
            path: config_path,
            field: "model".to_owned(),
            line,
            column,
        });
    }
    let models = if include_model {
        match table.get("models") {
            None => None,
            Some(value) => Some(parse_model_catalog(value, contents, &config_path)?),
        }
    } else {
        None
    };
    let mcp_servers = match table.get("mcp") {
        None => Vec::new(),
        Some(value) => parse_mcp_config(value, contents, &config_path)?,
    };

    Ok(EffectiveConfig {
        home,
        config_path,
        schema_version: CURRENT_CONFIG_SCHEMA_VERSION,
        models,
        mcp_servers,
    })
}

fn default_config(home: SugarCodeHome, config_path: PathBuf) -> EffectiveConfig {
    EffectiveConfig {
        home,
        config_path,
        schema_version: CURRENT_CONFIG_SCHEMA_VERSION,
        models: None,
        mcp_servers: Vec::new(),
    }
}

pub fn save_model_catalog(
    home: &SugarCodeHome,
    models: &ModelCatalog,
) -> Result<EffectiveConfig, ConfigError> {
    let existing = load_model_edit_config_for_home(home.clone())?;
    save_config(home, Some(models), existing.mcp_servers())
}

pub fn save_mcp_config(
    home: &SugarCodeHome,
    mcp_servers: &[McpServerConfig],
) -> Result<EffectiveConfig, ConfigError> {
    if mcp_servers.len() > MAX_MCP_SERVERS {
        return Err(ConfigError::WriteFailed {
            path: home.path().join(CONFIG_FILE_NAME),
            kind: io::ErrorKind::InvalidInput,
        });
    }
    let mut ids = std::collections::BTreeSet::new();
    if mcp_servers.iter().any(|server| !ids.insert(server.id())) {
        return Err(ConfigError::WriteFailed {
            path: home.path().join(CONFIG_FILE_NAME),
            kind: io::ErrorKind::InvalidInput,
        });
    }
    let existing = load_model_edit_config_for_home(home.clone())?;
    save_config(home, existing.models(), mcp_servers)
}

fn save_config(
    home: &SugarCodeHome,
    models: Option<&ModelCatalog>,
    mcp_servers: &[McpServerConfig],
) -> Result<EffectiveConfig, ConfigError> {
    ensure_config_home(home)?;
    let config_path = home.path().join(CONFIG_FILE_NAME);
    reject_unsafe_config_target(&config_path)?;
    let encoded = encode_config(models, mcp_servers)?;
    if encoded.len() as u64 > MAX_CONFIG_BYTES {
        return Err(ConfigError::WriteFailed {
            path: config_path,
            kind: io::ErrorKind::InvalidInput,
        });
    }
    let mut temp =
        NamedTempFile::new_in(home.path()).map_err(|error| ConfigError::WriteFailed {
            path: config_path.clone(),
            kind: error.kind(),
        })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| ConfigError::WriteFailed {
                path: config_path.clone(),
                kind: error.kind(),
            })?;
    }
    temp.write_all(encoded.as_bytes())
        .map_err(|error| ConfigError::WriteFailed {
            path: config_path.clone(),
            kind: error.kind(),
        })?;
    temp.flush().map_err(|error| ConfigError::WriteFailed {
        path: config_path.clone(),
        kind: error.kind(),
    })?;
    temp.as_file()
        .sync_all()
        .map_err(|error| ConfigError::WriteFailed {
            path: config_path.clone(),
            kind: error.kind(),
        })?;
    persist_config_temp(temp, &config_path)?;
    sync_config_parent(&config_path)?;
    load_effective_config_for_home(home.clone())
}

fn persist_config_temp(temp: NamedTempFile, config_path: &Path) -> Result<(), ConfigError> {
    #[cfg(not(windows))]
    {
        temp.persist(config_path)
            .map_err(|error| ConfigError::WriteFailed {
                path: config_path.to_path_buf(),
                kind: error.error.kind(),
            })?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
        use windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING;
        use windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH;
        use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
        use windows_sys::Win32::Storage::FileSystem::SetFileAttributesW;

        let temp_path = temp
            .path()
            .as_os_str()
            .encode_wide()
            .chain([0])
            .collect::<Vec<_>>();
        let target_path = config_path
            .as_os_str()
            .encode_wide()
            .chain([0])
            .collect::<Vec<_>>();
        let moved = unsafe {
            SetFileAttributesW(temp_path.as_ptr(), FILE_ATTRIBUTE_NORMAL) != 0
                && MoveFileExW(
                    temp_path.as_ptr(),
                    target_path.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                ) != 0
        };
        if !moved {
            return Err(ConfigError::WriteFailed {
                path: config_path.to_path_buf(),
                kind: io::Error::last_os_error().kind(),
            });
        }
    }
    Ok(())
}

fn ensure_config_home(home: &SugarCodeHome) -> Result<(), ConfigError> {
    match fs::symlink_metadata(home.path()) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o777 != 0o700 {
                    fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).map_err(
                        |error| ConfigError::WriteFailed {
                            path: home.path().to_path_buf(),
                            kind: error.kind(),
                        },
                    )?;
                }
            }
            Ok(())
        }
        Ok(_) => Err(ConfigError::WriteFailed {
            path: home.path().to_path_buf(),
            kind: io::ErrorKind::NotADirectory,
        }),
        Err(error)
            if error.kind() == io::ErrorKind::NotFound
                && home.source() == crate::HomeSource::Default =>
        {
            fs::create_dir_all(home.path()).map_err(|error| ConfigError::WriteFailed {
                path: home.path().to_path_buf(),
                kind: error.kind(),
            })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).map_err(
                    |error| ConfigError::WriteFailed {
                        path: home.path().to_path_buf(),
                        kind: error.kind(),
                    },
                )?;
            }
            Ok(())
        }
        Err(error) => Err(ConfigError::WriteFailed {
            path: home.path().to_path_buf(),
            kind: error.kind(),
        }),
    }
}

fn parse_model_catalog(
    value: &toml::Value,
    contents: &str,
    path: &Path,
) -> Result<ModelCatalog, ConfigError> {
    let table = value
        .as_table()
        .ok_or_else(|| invalid_model_field(path, contents, "models", "expectedTable"))?;
    let mut unknown = table
        .keys()
        .filter(|key| {
            !matches!(
                key.as_str(),
                "default_profile_id" | "connections" | "profiles"
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    unknown.sort();
    if let Some(field) = unknown.first() {
        let (line, column) = field_position(contents, field);
        return Err(ConfigError::UnknownField {
            path: path.to_path_buf(),
            field: format!("models.{field}"),
            line,
            column,
        });
    }

    let default_profile_id =
        required_model_string(table, "default_profile_id", contents, path)?.to_owned();
    let connections = table
        .get("connections")
        .ok_or_else(|| invalid_model_field(path, contents, "connections", "missingField"))?
        .as_array()
        .ok_or_else(|| invalid_model_field(path, contents, "connections", "expectedArray"))?;
    if connections.is_empty() || connections.len() > MAX_MODEL_CONNECTIONS {
        return Err(invalid_model_field(
            path,
            contents,
            "connections",
            "invalidConnectionCount",
        ));
    }
    let connections = connections
        .iter()
        .map(|value| parse_model_connection(value, contents, path))
        .collect::<Result<Vec<_>, _>>()?;
    let profiles = table
        .get("profiles")
        .ok_or_else(|| invalid_model_field(path, contents, "profiles", "missingField"))?
        .as_array()
        .ok_or_else(|| invalid_model_field(path, contents, "profiles", "expectedArray"))?;
    if profiles.is_empty() || profiles.len() > MAX_MODEL_PROFILES {
        return Err(invalid_model_field(
            path,
            contents,
            "profiles",
            "invalidProfileCount",
        ));
    }
    let profiles = profiles
        .iter()
        .map(|value| parse_model_profile(value, contents, path))
        .collect::<Result<Vec<_>, _>>()?;
    ModelCatalog::new(default_profile_id, connections, profiles)
        .map_err(|kind| invalid_model_field(path, contents, "models", kind))
}

fn parse_model_connection(
    value: &toml::Value,
    contents: &str,
    path: &Path,
) -> Result<ModelConnection, ConfigError> {
    let table = value
        .as_table()
        .ok_or_else(|| invalid_model_field(path, contents, "connections", "expectedTable"))?;
    reject_unknown_model_fields(
        table,
        &[
            "id",
            "provider_family",
            "display_name",
            "base_url",
            "enabled",
            "wire_api",
            "continuation_mode",
            "api_key",
        ],
        "models.connections",
        contents,
        path,
    )?;
    let id = required_model_string(table, "id", contents, path)?.to_owned();
    let provider_family = match required_model_string(table, "provider_family", contents, path)? {
        "openai" => ModelProviderFamily::OpenAi,
        "anthropic" => ModelProviderFamily::Anthropic,
        "gemini" => ModelProviderFamily::Gemini,
        _ => {
            return Err(invalid_model_field(
                path,
                contents,
                "provider_family",
                "unsupportedProviderFamily",
            ));
        }
    };
    let display_name = required_model_string(table, "display_name", contents, path)?.to_owned();
    let base_url = Url::parse(required_model_string(table, "base_url", contents, path)?)
        .map_err(|_| invalid_model_field(path, contents, "base_url", "invalidEndpoint"))?;
    let enabled = table
        .get("enabled")
        .ok_or_else(|| invalid_model_field(path, contents, "enabled", "missingField"))?
        .as_bool()
        .ok_or_else(|| invalid_model_field(path, contents, "enabled", "expectedBoolean"))?;
    let wire_api = match table.get("wire_api") {
        None => {
            return Err(invalid_model_field(
                path,
                contents,
                "wire_api",
                "missingField",
            ));
        }
        Some(toml::Value::String(value)) => parse_wire_api(value)
            .map_err(|kind| invalid_model_field(path, contents, "wire_api", kind))?,
        Some(_) => {
            return Err(invalid_model_field(
                path,
                contents,
                "wire_api",
                "expectedString",
            ));
        }
    };
    let api_key = match table.get("api_key") {
        None => None,
        Some(toml::Value::String(value)) => Some(value.clone()),
        Some(_) => {
            return Err(invalid_model_field(
                path,
                contents,
                "api_key",
                "expectedString",
            ));
        }
    };
    let continuation_mode = match table.get("continuation_mode") {
        None => ModelContinuationMode::LocalReplay,
        Some(toml::Value::String(value)) => match value.as_str() {
            "localReplay" => ModelContinuationMode::LocalReplay,
            "providerManaged" => ModelContinuationMode::ProviderManaged,
            _ => {
                return Err(invalid_model_field(
                    path,
                    contents,
                    "continuation_mode",
                    "unsupportedContinuationMode",
                ));
            }
        },
        Some(_) => {
            return Err(invalid_model_field(
                path,
                contents,
                "continuation_mode",
                "expectedString",
            ));
        }
    };
    ModelConnection::new(
        id,
        provider_family,
        display_name,
        base_url,
        enabled,
        wire_api,
        api_key,
    )
    .map(|connection| connection.with_continuation_mode(continuation_mode))
    .map_err(|kind| invalid_model_field(path, contents, "connections", kind))
}

fn parse_model_profile(
    value: &toml::Value,
    contents: &str,
    path: &Path,
) -> Result<ModelProfile, ConfigError> {
    let table = value
        .as_table()
        .ok_or_else(|| invalid_model_field(path, contents, "profiles", "expectedTable"))?;
    reject_unknown_model_fields(
        table,
        &[
            "id",
            "connection_id",
            "display_name",
            "model_id",
            "context_window_tokens",
            "tool_calls",
            "strict_tools",
            "parallel_tools",
            "image_input",
            "pdf_input",
        ],
        "models.profiles",
        contents,
        path,
    )?;
    let context_window_tokens = match table.get("context_window_tokens") {
        None => None,
        Some(toml::Value::Integer(value)) => Some(u32::try_from(*value).map_err(|_| {
            invalid_model_field(
                path,
                contents,
                "context_window_tokens",
                "invalidContextWindow",
            )
        })?),
        Some(_) => {
            return Err(invalid_model_field(
                path,
                contents,
                "context_window_tokens",
                "expectedInteger",
            ));
        }
    };
    let tool_calls = optional_capability_mode(table, "tool_calls", contents, path)?;
    let strict_tools = optional_capability_mode(table, "strict_tools", contents, path)?;
    let parallel_tools = optional_capability_mode(table, "parallel_tools", contents, path)?;
    let image_input = optional_capability_mode(table, "image_input", contents, path)?;
    let pdf_input = optional_capability_mode(table, "pdf_input", contents, path)?;
    ModelProfile::new(
        required_model_string(table, "id", contents, path)?.to_owned(),
        required_model_string(table, "connection_id", contents, path)?.to_owned(),
        required_model_string(table, "display_name", contents, path)?.to_owned(),
        required_model_string(table, "model_id", contents, path)?.to_owned(),
        context_window_tokens,
        ModelProfileCapabilities::new(
            tool_calls,
            strict_tools,
            parallel_tools,
            image_input,
            pdf_input,
        ),
    )
    .map_err(|kind| invalid_model_field(path, contents, "profiles", kind))
}

fn reject_unknown_model_fields(
    table: &toml::map::Map<String, toml::Value>,
    allowed: &[&str],
    prefix: &str,
    contents: &str,
    path: &Path,
) -> Result<(), ConfigError> {
    let mut unknown = table
        .keys()
        .filter(|key| !allowed.contains(&key.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    unknown.sort();
    if let Some(field) = unknown.first() {
        return Err(unknown_field(
            path,
            contents,
            format!("{prefix}.{field}"),
            field,
        ));
    }
    Ok(())
}

fn parse_wire_api(value: &str) -> Result<ModelWireApi, &'static str> {
    match value {
        "openaiResponses" => Ok(ModelWireApi::OpenAiResponses),
        "openaiChatCompletions" => Ok(ModelWireApi::OpenAiChatCompletions),
        "anthropicMessages" => Ok(ModelWireApi::AnthropicMessages),
        "geminiGenerateContent" => Ok(ModelWireApi::GeminiGenerateContent),
        _ => Err("unsupportedWireApi"),
    }
}

fn optional_capability_mode(
    table: &toml::map::Map<String, toml::Value>,
    field: &'static str,
    contents: &str,
    path: &Path,
) -> Result<ModelCapabilityMode, ConfigError> {
    match table.get(field) {
        None => Ok(ModelCapabilityMode::Auto),
        Some(toml::Value::String(value)) => match value.as_str() {
            "auto" => Ok(ModelCapabilityMode::Auto),
            "enabled" => Ok(ModelCapabilityMode::Enabled),
            "disabled" => Ok(ModelCapabilityMode::Disabled),
            _ => Err(invalid_model_field(
                path,
                contents,
                field,
                "unsupportedCapabilityMode",
            )),
        },
        Some(_) => Err(invalid_model_field(path, contents, field, "expectedString")),
    }
}

fn parse_mcp_config(
    value: &toml::Value,
    contents: &str,
    path: &Path,
) -> Result<Vec<McpServerConfig>, ConfigError> {
    let table = value
        .as_table()
        .ok_or_else(|| invalid_mcp_field(path, contents, "mcp", "expectedTable"))?;
    let mut unknown = table
        .keys()
        .filter(|key| key.as_str() != "servers")
        .cloned()
        .collect::<Vec<_>>();
    unknown.sort();
    if let Some(field) = unknown.first() {
        return Err(unknown_field(path, contents, format!("mcp.{field}"), field));
    }
    let Some(servers) = table.get("servers") else {
        return Err(invalid_mcp_field(
            path,
            contents,
            "mcp.servers",
            "missingField",
        ));
    };
    let servers = servers
        .as_array()
        .ok_or_else(|| invalid_mcp_field(path, contents, "mcp.servers", "expectedArray"))?;
    if servers.len() > MAX_MCP_SERVERS {
        return Err(invalid_mcp_field(
            path,
            contents,
            "mcp.servers",
            "tooManyServers",
        ));
    }

    let servers = servers
        .iter()
        .enumerate()
        .map(|(index, server)| parse_mcp_server(server, index, contents, path))
        .collect::<Result<Vec<_>, _>>()?;
    let mut ids = std::collections::BTreeSet::new();
    for (index, server) in servers.iter().enumerate() {
        if !ids.insert(server.id()) {
            return Err(invalid_mcp_field(
                path,
                contents,
                &format!("mcp.servers[{index}].id"),
                "duplicateServerId",
            ));
        }
    }
    Ok(servers)
}

fn parse_mcp_server(
    value: &toml::Value,
    index: usize,
    contents: &str,
    path: &Path,
) -> Result<McpServerConfig, ConfigError> {
    let prefix = format!("mcp.servers[{index}]");
    let table = value
        .as_table()
        .ok_or_else(|| invalid_mcp_field(path, contents, &prefix, "expectedTable"))?;
    let id = required_mcp_string(table, "id", &prefix, contents, path)?;
    if !valid_mcp_server_id(id) {
        return Err(invalid_mcp_field(
            path,
            contents,
            &format!("{prefix}.id"),
            "invalidServerId",
        ));
    }
    let transport = required_mcp_string(table, "transport", &prefix, contents, path)?;
    match transport {
        "stdio" => parse_mcp_stdio_server(table, id, &prefix, contents, path),
        "streamable-http" => parse_mcp_streamable_http_server(table, id, &prefix, contents, path),
        _ => Err(invalid_mcp_field(
            path,
            contents,
            &format!("{prefix}.transport"),
            "unsupportedTransport",
        )),
    }
}

fn parse_mcp_stdio_server(
    table: &toml::map::Map<String, toml::Value>,
    id: &str,
    prefix: &str,
    contents: &str,
    path: &Path,
) -> Result<McpServerConfig, ConfigError> {
    reject_unknown_mcp_server_fields(
        table,
        &["id", "transport", "executable", "argv", "cwd"],
        prefix,
        contents,
        path,
    )?;
    let executable = required_mcp_path(table, "executable", prefix, contents, path)?;
    let cwd = required_mcp_path(table, "cwd", prefix, contents, path)?;
    let argv_field = format!("{prefix}.argv");
    let argv = table
        .get("argv")
        .ok_or_else(|| invalid_mcp_field(path, contents, &argv_field, "missingField"))?
        .as_array()
        .ok_or_else(|| invalid_mcp_field(path, contents, &argv_field, "expectedArray"))?;
    if argv.len() > MAX_MCP_ARG_COUNT {
        return Err(invalid_mcp_field(
            path,
            contents,
            &argv_field,
            "tooManyArguments",
        ));
    }
    let mut argv_bytes = 0_usize;
    let argv = argv
        .iter()
        .map(|value| {
            let value = value.as_str().ok_or_else(|| {
                invalid_mcp_field(path, contents, &argv_field, "expectedStringArray")
            })?;
            if value.len() > MAX_MCP_ARG_BYTES
                || value.chars().any(|character| character.is_control())
            {
                return Err(invalid_mcp_field(
                    path,
                    contents,
                    &argv_field,
                    "invalidArgument",
                ));
            }
            argv_bytes = argv_bytes.saturating_add(value.len());
            Ok(value.to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if argv_bytes > MAX_MCP_ARGV_BYTES {
        return Err(invalid_mcp_field(
            path,
            contents,
            &argv_field,
            "argumentsTooLarge",
        ));
    }

    Ok(McpServerConfig::Stdio(McpStdioServerConfig {
        id: id.to_owned(),
        executable,
        argv,
        cwd,
    }))
}

fn parse_mcp_streamable_http_server(
    table: &toml::map::Map<String, toml::Value>,
    id: &str,
    prefix: &str,
    contents: &str,
    path: &Path,
) -> Result<McpServerConfig, ConfigError> {
    reject_unknown_mcp_server_fields(
        table,
        &["id", "transport", "endpoint"],
        prefix,
        contents,
        path,
    )?;
    let endpoint = required_mcp_string(table, "endpoint", prefix, contents, path)?;
    let endpoint = validate_loopback_streamable_http_endpoint(endpoint)
        .map_err(|kind| invalid_mcp_field(path, contents, &format!("{prefix}.endpoint"), kind))?;
    Ok(McpServerConfig::LoopbackStreamableHttp(
        McpStreamableHttpServerConfig {
            id: id.to_owned(),
            endpoint,
        },
    ))
}

fn reject_unknown_mcp_server_fields(
    table: &toml::map::Map<String, toml::Value>,
    allowed: &[&str],
    prefix: &str,
    contents: &str,
    path: &Path,
) -> Result<(), ConfigError> {
    let mut unknown = table
        .keys()
        .filter(|key| !allowed.contains(&key.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    unknown.sort();
    if let Some(field) = unknown.first() {
        return Err(unknown_field(
            path,
            contents,
            format!("{prefix}.{field}"),
            field,
        ));
    }
    Ok(())
}

fn validate_loopback_streamable_http_endpoint(raw: &str) -> Result<Url, &'static str> {
    if raw.is_empty()
        || raw.len() > MAX_MCP_ENDPOINT_BYTES
        || raw
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte == b'\\')
        || raw.contains(['?', '#'])
    {
        return Err("invalidEndpoint");
    }
    let authority_and_path = raw
        .strip_prefix("http://127.0.0.1:")
        .or_else(|| raw.strip_prefix("http://[::1]:"))
        .ok_or("invalidEndpoint")?;
    let (port, path) = authority_and_path
        .split_once('/')
        .ok_or("invalidEndpoint")?;
    if port.is_empty()
        || port.len() > 5
        || !port.bytes().all(|byte| byte.is_ascii_digit())
        || port.parse::<u16>().ok().filter(|port| *port != 0).is_none()
        || path.is_empty()
    {
        return Err("invalidEndpoint");
    }
    let endpoint = Url::parse(raw).map_err(|_| "invalidEndpoint")?;
    if endpoint.scheme() != "http"
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.port().is_none()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
        || endpoint.path() == "/"
    {
        return Err("invalidEndpoint");
    }
    match endpoint.host() {
        Some(url::Host::Ipv4(address)) if address.is_loopback() => {}
        Some(url::Host::Ipv6(address)) if address == std::net::Ipv6Addr::LOCALHOST => {}
        _ => return Err("invalidEndpoint"),
    }
    Ok(endpoint)
}

fn required_mcp_string<'a>(
    table: &'a toml::map::Map<String, toml::Value>,
    field: &str,
    prefix: &str,
    contents: &str,
    path: &Path,
) -> Result<&'a str, ConfigError> {
    let full_field = format!("{prefix}.{field}");
    table
        .get(field)
        .ok_or_else(|| invalid_mcp_field(path, contents, &full_field, "missingField"))?
        .as_str()
        .ok_or_else(|| invalid_mcp_field(path, contents, &full_field, "expectedString"))
}

fn required_mcp_path(
    table: &toml::map::Map<String, toml::Value>,
    field: &str,
    prefix: &str,
    contents: &str,
    path: &Path,
) -> Result<PathBuf, ConfigError> {
    let full_field = format!("{prefix}.{field}");
    let value = required_mcp_string(table, field, prefix, contents, path)?;
    if value.is_empty() || value.len() > MAX_MCP_PATH_BYTES || value.chars().any(char::is_control) {
        return Err(invalid_mcp_field(
            path,
            contents,
            &full_field,
            "invalidPath",
        ));
    }
    let value = PathBuf::from(value);
    if validate_mcp_path(&value).is_err() {
        return Err(invalid_mcp_field(
            path,
            contents,
            &full_field,
            "pathMustBeExplicitAbsolute",
        ));
    }
    Ok(value)
}

fn validate_mcp_path(path: &Path) -> Result<(), &'static str> {
    let value = path.to_str().ok_or("invalidPath")?;
    if value.is_empty() || value.len() > MAX_MCP_PATH_BYTES || value.chars().any(char::is_control) {
        return Err("invalidPath");
    }
    if !path.is_absolute() || has_forbidden_windows_path_prefix(path) {
        return Err("pathMustBeExplicitAbsolute");
    }
    Ok(())
}

fn valid_mcp_server_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_MCP_SERVER_ID_BYTES
        && bytes[0].is_ascii_lowercase()
        && bytes[bytes.len() - 1].is_ascii_lowercase_or_digit()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase_or_digit() || *byte == b'-')
}

trait AsciiLowercaseOrDigit {
    fn is_ascii_lowercase_or_digit(&self) -> bool;
}

impl AsciiLowercaseOrDigit for u8 {
    fn is_ascii_lowercase_or_digit(&self) -> bool {
        self.is_ascii_lowercase() || self.is_ascii_digit()
    }
}

fn has_forbidden_windows_path_prefix(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::path::Component;
        use std::path::Prefix;
        matches!(
            path.components().next(),
            Some(Component::Prefix(prefix))
                if matches!(
                    prefix.kind(),
                    Prefix::UNC(..)
                        | Prefix::Verbatim(..)
                        | Prefix::DeviceNS(..)
                        | Prefix::VerbatimUNC(..)
                        | Prefix::VerbatimDisk(..)
                )
        )
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

fn invalid_mcp_field(path: &Path, contents: &str, field: &str, kind: &'static str) -> ConfigError {
    let lookup = field.rsplit('.').next().unwrap_or(field);
    let (line, column) = field_position(contents, lookup);
    ConfigError::InvalidMcpField {
        path: path.to_path_buf(),
        field: field.to_owned(),
        kind,
        line,
        column,
    }
}

fn unknown_field(path: &Path, contents: &str, full_field: String, lookup: &str) -> ConfigError {
    let (line, column) = field_position(contents, lookup);
    ConfigError::UnknownField {
        path: path.to_path_buf(),
        field: full_field,
        line,
        column,
    }
}

fn required_model_string<'a>(
    table: &'a toml::map::Map<String, toml::Value>,
    field: &'static str,
    contents: &str,
    path: &Path,
) -> Result<&'a str, ConfigError> {
    match table.get(field) {
        Some(toml::Value::String(value)) => Ok(value),
        Some(_) => Err(invalid_model_field(path, contents, field, "expectedString")),
        None => Err(invalid_model_field(path, contents, field, "missingField")),
    }
}

fn validate_model_base_url(endpoint: &Url) -> Result<(), &'static str> {
    if !matches!(endpoint.scheme(), "http" | "https") {
        return Err("unsupportedEndpointScheme");
    }
    if endpoint.host_str().is_none()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
    {
        return Err("unsafeEndpoint");
    }
    Ok(())
}

fn validate_wire_api(
    provider_family: ModelProviderFamily,
    wire_api: ModelWireApi,
) -> Result<(), &'static str> {
    match (provider_family, wire_api) {
        (
            ModelProviderFamily::OpenAi,
            ModelWireApi::OpenAiResponses | ModelWireApi::OpenAiChatCompletions,
        )
        | (ModelProviderFamily::Anthropic, ModelWireApi::AnthropicMessages)
        | (ModelProviderFamily::Gemini, ModelWireApi::GeminiGenerateContent) => Ok(()),
        _ => Err("wireApiProviderMismatch"),
    }
}

fn validate_model_id(id: &str) -> Result<(), &'static str> {
    if id.is_empty()
        || id.len() > MAX_MODEL_ID_BYTES
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err("invalidId");
    }
    Ok(())
}

fn validate_model_display_name(display_name: &str) -> Result<(), &'static str> {
    if display_name.trim().is_empty()
        || display_name.len() > MAX_MODEL_DISPLAY_NAME_BYTES
        || display_name.chars().any(char::is_control)
    {
        return Err("invalidDisplayName");
    }
    Ok(())
}

fn validate_model_name(model: &str) -> Result<(), &'static str> {
    if model.is_empty() || model.len() > MAX_MODEL_NAME_BYTES {
        return Err("invalidModel");
    }
    if model.chars().any(char::is_control) {
        return Err("invalidModel");
    }
    Ok(())
}

fn validate_model_api_key(api_key: &str) -> Result<(), &'static str> {
    if api_key.is_empty()
        || api_key.len() > MAX_MODEL_API_KEY_BYTES
        || !api_key.bytes().all(|byte| matches!(byte, 0x21..=0x7e))
    {
        Err("invalidApiKey")
    } else {
        Ok(())
    }
}

fn invalid_model_field(
    path: &Path,
    contents: &str,
    field: &'static str,
    kind: &'static str,
) -> ConfigError {
    let (line, column) = field_position(contents, field);
    ConfigError::InvalidModelField {
        path: path.to_path_buf(),
        field,
        kind,
        line,
        column,
    }
}

fn encode_config(
    models: Option<&ModelCatalog>,
    mcp_servers: &[McpServerConfig],
) -> Result<String, ConfigError> {
    let mut output = format!("schema_version = {}\n", CURRENT_CONFIG_SCHEMA_VERSION);
    if let Some(models) = models {
        output.push_str("\n[models]\ndefault_profile_id = ");
        output.push_str(&toml_string(models.default_profile_id()));
        output.push('\n');
        for connection in models.connections() {
            output.push_str("\n[[models.connections]]\nid = ");
            output.push_str(&toml_string(connection.id()));
            output.push_str("\nprovider_family = ");
            output.push_str(&toml_string(connection.provider_family().as_str()));
            output.push_str("\ndisplay_name = ");
            output.push_str(&toml_string(connection.display_name()));
            output.push_str("\nbase_url = ");
            output.push_str(&toml_string(connection.base_url().as_str()));
            output.push_str("\nenabled = ");
            output.push_str(if connection.enabled() {
                "true"
            } else {
                "false"
            });
            output.push_str("\nwire_api = ");
            output.push_str(&toml_string(connection.wire_api().as_str()));
            if connection.wire_api() == ModelWireApi::OpenAiResponses {
                output.push_str("\ncontinuation_mode = ");
                output.push_str(&toml_string(connection.continuation_mode().as_str()));
            }
            output.push('\n');
            if let Some(api_key) = connection.api_key() {
                output.push_str("api_key = ");
                output.push_str(&toml_string(api_key));
                output.push('\n');
            }
        }
        for profile in models.profiles() {
            output.push_str("\n[[models.profiles]]\nid = ");
            output.push_str(&toml_string(profile.id()));
            output.push_str("\nconnection_id = ");
            output.push_str(&toml_string(profile.connection_id()));
            output.push_str("\ndisplay_name = ");
            output.push_str(&toml_string(profile.display_name()));
            output.push_str("\nmodel_id = ");
            output.push_str(&toml_string(profile.model_id()));
            output.push('\n');
            if let Some(context_window_tokens) = profile.context_window_tokens() {
                output.push_str("context_window_tokens = ");
                output.push_str(&context_window_tokens.to_string());
                output.push('\n');
            }
            output.push_str("tool_calls = ");
            output.push_str(&toml_string(profile.tool_calls().as_str()));
            output.push('\n');
            output.push_str("strict_tools = ");
            output.push_str(&toml_string(profile.strict_tools().as_str()));
            output.push_str("\nparallel_tools = ");
            output.push_str(&toml_string(profile.parallel_tools().as_str()));
            output.push_str("\nimage_input = ");
            output.push_str(&toml_string(profile.image_input().as_str()));
            output.push_str("\npdf_input = ");
            output.push_str(&toml_string(profile.pdf_input().as_str()));
            output.push('\n');
        }
    }
    for server in mcp_servers {
        output.push_str("\n[[mcp.servers]]\n");
        output.push_str("id = ");
        output.push_str(&toml_string(server.id()));
        match server {
            McpServerConfig::Stdio(server) => {
                output.push_str("\ntransport = \"stdio\"\nexecutable = ");
                output.push_str(&toml_string(&server.executable().to_string_lossy()));
                output.push_str("\nargv = [");
                for (index, argument) in server.argv().iter().enumerate() {
                    if index != 0 {
                        output.push_str(", ");
                    }
                    output.push_str(&toml_string(argument));
                }
                output.push_str("]\ncwd = ");
                output.push_str(&toml_string(&server.cwd().to_string_lossy()));
                output.push('\n');
            }
            McpServerConfig::LoopbackStreamableHttp(server) => {
                output.push_str("\ntransport = \"streamable-http\"\nendpoint = ");
                output.push_str(&toml_string(server.endpoint().as_str()));
                output.push('\n');
            }
        }
    }
    Ok(output)
}

fn toml_string(value: &str) -> String {
    toml::Value::String(value.to_owned()).to_string()
}

fn reject_unsafe_config_target(path: &Path) -> Result<(), ConfigError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(ConfigError::NotRegularFile {
                path: path.to_path_buf(),
            })
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ConfigError::WriteFailed {
            path: path.to_path_buf(),
            kind: error.kind(),
        }),
    }
}

fn sync_config_parent(_path: &Path) -> Result<(), ConfigError> {
    #[cfg(unix)]
    {
        let path = _path;
        let parent = path.parent().ok_or_else(|| ConfigError::WriteFailed {
            path: path.to_path_buf(),
            kind: io::ErrorKind::InvalidInput,
        })?;
        fs::File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(|error| ConfigError::WriteFailed {
                path: path.to_path_buf(),
                kind: error.kind(),
            })?;
    }
    Ok(())
}

fn text_position(contents: &str, byte_offset: usize) -> (usize, usize) {
    let offset = byte_offset.min(contents.len());
    let prefix = &contents[..offset];
    let line = prefix.bytes().filter(|byte| *byte == b'\n').count() + 1;
    let line_start = prefix.rfind('\n').map_or(0, |index| index + 1);
    let column = prefix[line_start..].chars().count() + 1;
    (line, column)
}

fn field_position(contents: &str, field: &str) -> (usize, usize) {
    for (line_index, line) in contents.lines().enumerate() {
        let trimmed = line.trim_start();
        let column = line.len() - trimmed.len() + 1;
        let key = if let Some(table) = trimmed.strip_prefix('[') {
            table
                .trim_start_matches('[')
                .split([']', '.'])
                .next()
                .unwrap_or_default()
                .trim()
                .trim_matches(['"', '\''])
        } else {
            trimmed
                .split_once('=')
                .map(|(key, _)| key.trim().trim_matches(['"', '\'']))
                .unwrap_or_default()
        };
        if key == field {
            return (line_index + 1, column);
        }
    }
    (1, 1)
}
