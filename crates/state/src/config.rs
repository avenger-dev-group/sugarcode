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
pub const MAX_MODEL_TOKEN_BYTES: usize = 2048;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelApiFormat {
    OpenAiChatCompletions,
}

impl ModelApiFormat {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OpenAiChatCompletions => "openai-chat-completions",
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ModelToken(Zeroizing<String>);

impl ModelToken {
    pub fn parse(value: String) -> Result<Option<Self>, &'static str> {
        if value.is_empty() {
            return Ok(None);
        }
        if value.len() > MAX_MODEL_TOKEN_BYTES {
            return Err("tokenTooLarge");
        }
        if !value.bytes().all(|byte| matches!(byte, 0x21..=0x7e)) {
            return Err("invalidToken");
        }
        Ok(Some(Self(Zeroizing::new(value))))
    }

    pub fn expose(&self) -> &str {
        self.0.as_str()
    }
}

impl fmt::Debug for ModelToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ModelToken(<redacted>)")
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ModelConfig {
    api_format: ModelApiFormat,
    endpoint: Url,
    model: String,
    token: Option<ModelToken>,
}

impl ModelConfig {
    pub fn new(
        api_format: ModelApiFormat,
        endpoint: Url,
        model: String,
        token: Option<ModelToken>,
    ) -> Result<Self, &'static str> {
        validate_endpoint(api_format, &endpoint)?;
        validate_model(&model)?;
        Ok(Self {
            api_format,
            endpoint,
            model,
            token,
        })
    }

    pub const fn api_format(&self) -> ModelApiFormat {
        self.api_format
    }

    pub fn endpoint(&self) -> &Url {
        &self.endpoint
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub fn token(&self) -> Option<&ModelToken> {
        self.token.as_ref()
    }
}

impl fmt::Debug for ModelConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ModelConfig")
            .field("api_format", &self.api_format)
            .field("endpoint", &"<redacted>")
            .field("model", &"<redacted>")
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct EffectiveConfig {
    home: SugarCodeHome,
    config_path: PathBuf,
    schema_version: u32,
    model: Option<ModelConfig>,
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

    pub fn model(&self) -> Option<&ModelConfig> {
        self.model.as_ref()
    }
}

impl fmt::Debug for EffectiveConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EffectiveConfig")
            .field("home", &self.home)
            .field("config_path", &self.config_path)
            .field("schema_version", &self.schema_version)
            .field("model", &self.model)
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

pub fn load_effective_config_for_home(home: SugarCodeHome) -> Result<EffectiveConfig, ConfigError> {
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

    let target_metadata = if metadata.file_type().is_symlink() {
        fs::metadata(&config_path).map_err(|error| ConfigError::Unreadable {
            path: config_path.clone(),
            kind: error.kind(),
        })?
    } else {
        metadata
    };
    if !target_metadata.is_file() {
        return Err(ConfigError::NotRegularFile { path: config_path });
    }
    if target_metadata.len() > MAX_CONFIG_BYTES {
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
        .filter(|field| !matches!(field.as_str(), "schema_version" | "model"))
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

    let model = match table.get("model") {
        None => None,
        Some(value) => Some(parse_model_config(value, contents, &config_path)?),
    };

    Ok(EffectiveConfig {
        home,
        config_path,
        schema_version: CURRENT_CONFIG_SCHEMA_VERSION,
        model,
    })
}

fn default_config(home: SugarCodeHome, config_path: PathBuf) -> EffectiveConfig {
    EffectiveConfig {
        home,
        config_path,
        schema_version: CURRENT_CONFIG_SCHEMA_VERSION,
        model: None,
    }
}

pub fn save_model_config(
    home: &SugarCodeHome,
    model: &ModelConfig,
) -> Result<EffectiveConfig, ConfigError> {
    ensure_config_home(home)?;
    let config_path = home.path().join(CONFIG_FILE_NAME);
    reject_unsafe_config_target(&config_path)?;
    let encoded = encode_model_config(model)?;
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
    temp.persist(&config_path)
        .map_err(|error| ConfigError::WriteFailed {
            path: config_path.clone(),
            kind: error.error.kind(),
        })?;
    sync_config_parent(&config_path)?;
    load_effective_config_for_home(home.clone())
}

fn ensure_config_home(home: &SugarCodeHome) -> Result<(), ConfigError> {
    match fs::symlink_metadata(home.path()) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
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

fn parse_model_config(
    value: &toml::Value,
    contents: &str,
    path: &Path,
) -> Result<ModelConfig, ConfigError> {
    let table = value
        .as_table()
        .ok_or_else(|| invalid_model_field(path, contents, "model", "expectedTable"))?;
    let mut unknown = table
        .keys()
        .filter(|key| !matches!(key.as_str(), "api_format" | "endpoint" | "model" | "token"))
        .cloned()
        .collect::<Vec<_>>();
    unknown.sort();
    if let Some(field) = unknown.first() {
        let (line, column) = field_position(contents, field);
        return Err(ConfigError::UnknownField {
            path: path.to_path_buf(),
            field: format!("model.{field}"),
            line,
            column,
        });
    }

    let api_format = required_model_string(table, "api_format", contents, path)?;
    let api_format = match api_format {
        "openai-chat-completions" => ModelApiFormat::OpenAiChatCompletions,
        _ => {
            return Err(invalid_model_field(
                path,
                contents,
                "api_format",
                "unsupportedApiFormat",
            ));
        }
    };
    let endpoint = required_model_string(table, "endpoint", contents, path)?;
    let endpoint = Url::parse(endpoint)
        .map_err(|_| invalid_model_field(path, contents, "endpoint", "invalidEndpoint"))?;
    validate_endpoint(api_format, &endpoint)
        .map_err(|kind| invalid_model_field(path, contents, "endpoint", kind))?;
    let model = required_model_string(table, "model", contents, path)?.to_owned();
    validate_model(&model).map_err(|kind| invalid_model_field(path, contents, "model", kind))?;
    let token = match table.get("token") {
        None => None,
        Some(toml::Value::String(token)) => ModelToken::parse(token.clone())
            .map_err(|kind| invalid_model_field(path, contents, "token", kind))?,
        Some(_) => {
            return Err(invalid_model_field(
                path,
                contents,
                "token",
                "expectedString",
            ));
        }
    };
    ModelConfig::new(api_format, endpoint, model, token)
        .map_err(|kind| invalid_model_field(path, contents, "model", kind))
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

fn validate_endpoint(api_format: ModelApiFormat, endpoint: &Url) -> Result<(), &'static str> {
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
    if api_format == ModelApiFormat::OpenAiChatCompletions
        && !endpoint.path().ends_with("/chat/completions")
    {
        return Err("invalidEndpointPath");
    }
    Ok(())
}

fn validate_model(model: &str) -> Result<(), &'static str> {
    if model.is_empty() || model.len() > MAX_MODEL_NAME_BYTES {
        return Err("invalidModel");
    }
    if model.chars().any(char::is_control) {
        return Err("invalidModel");
    }
    Ok(())
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

fn encode_model_config(model: &ModelConfig) -> Result<String, ConfigError> {
    let mut output = format!(
        "schema_version = {}\n\n[model]\napi_format = {}\nendpoint = {}\nmodel = {}\n",
        CURRENT_CONFIG_SCHEMA_VERSION,
        toml_string(model.api_format.as_str()),
        toml_string(model.endpoint.as_str()),
        toml_string(model.model())
    );
    if let Some(token) = model.token() {
        output.push_str("token = ");
        output.push_str(&toml_string(token.expose()));
        output.push('\n');
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

fn sync_config_parent(path: &Path) -> Result<(), ConfigError> {
    #[cfg(unix)]
    {
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
