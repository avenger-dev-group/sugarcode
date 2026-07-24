use crate::StateError;
use crate::SugarCodeHome;
use crate::resolve_sugarcode_home_from_process;
use std::error::Error;
use std::fmt;
use std::fs;
use std::io;
use std::path::Path;
use std::path::PathBuf;

pub const CONFIG_FILE_NAME: &str = "config.toml";
pub const CURRENT_CONFIG_SCHEMA_VERSION: u32 = 1;
pub const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveConfig {
    home: SugarCodeHome,
    config_path: PathBuf,
    schema_version: u32,
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
        .filter(|field| field.as_str() != "schema_version")
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

    Ok(EffectiveConfig {
        home,
        config_path,
        schema_version: CURRENT_CONFIG_SCHEMA_VERSION,
    })
}

fn default_config(home: SugarCodeHome, config_path: PathBuf) -> EffectiveConfig {
    EffectiveConfig {
        home,
        config_path,
        schema_version: CURRENT_CONFIG_SCHEMA_VERSION,
    }
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
