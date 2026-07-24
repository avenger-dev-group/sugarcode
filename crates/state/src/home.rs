use std::error::Error;
use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io;
use std::path::Path;
use std::path::PathBuf;

pub const SUGARCODE_HOME_ENV: &str = "SUGARCODE_HOME";
const DEFAULT_HOME_DIRECTORY_NAME: &str = ".sugarcode";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HomeSource {
    Cli,
    Environment,
    Default,
}

impl fmt::Display for HomeSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cli => formatter.write_str("--home"),
            Self::Environment => formatter.write_str(SUGARCODE_HOME_ENV),
            Self::Default => formatter.write_str("the operating-system user home"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SugarCodeHome {
    path: PathBuf,
    source: HomeSource,
}

impl SugarCodeHome {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub const fn source(&self) -> HomeSource {
        self.source
    }
}

#[derive(Debug, Clone, Default)]
pub struct HomeResolutionInputs {
    pub cli_override: Option<PathBuf>,
    pub environment_override: Option<OsString>,
    pub user_home: Option<PathBuf>,
}

#[derive(Debug)]
pub enum HomeError {
    UserHomeUnavailable,
    NotAbsolute {
        source: HomeSource,
    },
    Missing {
        source: HomeSource,
    },
    NotDirectory {
        source: HomeSource,
    },
    Unavailable {
        source: HomeSource,
        kind: io::ErrorKind,
    },
}

impl fmt::Display for HomeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UserHomeUnavailable => {
                formatter.write_str("could not determine the operating-system user home")
            }
            Self::NotAbsolute { source } => {
                write!(
                    formatter,
                    "SugarCode home from {source} must be an absolute path"
                )
            }
            Self::Missing { source } => {
                write!(formatter, "SugarCode home from {source} does not exist")
            }
            Self::NotDirectory { source } => {
                write!(formatter, "SugarCode home from {source} is not a directory")
            }
            Self::Unavailable { source, kind } => {
                write!(
                    formatter,
                    "SugarCode home from {source} is unavailable ({kind:?})"
                )
            }
        }
    }
}

impl Error for HomeError {}

pub fn resolve_sugarcode_home_from_process(
    cli_override: Option<PathBuf>,
) -> Result<SugarCodeHome, HomeError> {
    resolve_sugarcode_home(HomeResolutionInputs {
        cli_override,
        environment_override: std::env::var_os(SUGARCODE_HOME_ENV),
        user_home: dirs::home_dir(),
    })
}

pub fn resolve_sugarcode_home(inputs: HomeResolutionInputs) -> Result<SugarCodeHome, HomeError> {
    if let Some(path) = inputs.cli_override {
        return resolve_explicit_home(path, HomeSource::Cli);
    }

    if let Some(value) = inputs
        .environment_override
        .filter(|value| !value.is_empty())
    {
        return resolve_explicit_home(PathBuf::from(value), HomeSource::Environment);
    }

    let user_home = inputs.user_home.ok_or(HomeError::UserHomeUnavailable)?;
    let path = user_home.join(DEFAULT_HOME_DIRECTORY_NAME);
    if !path.is_absolute() {
        return Err(HomeError::NotAbsolute {
            source: HomeSource::Default,
        });
    }

    match fs::symlink_metadata(&path) {
        Ok(_) => resolve_existing_home(path, HomeSource::Default),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(SugarCodeHome {
            path,
            source: HomeSource::Default,
        }),
        Err(error) => Err(HomeError::Unavailable {
            source: HomeSource::Default,
            kind: error.kind(),
        }),
    }
}

fn resolve_explicit_home(path: PathBuf, source: HomeSource) -> Result<SugarCodeHome, HomeError> {
    if !path.is_absolute() {
        return Err(HomeError::NotAbsolute { source });
    }
    match fs::symlink_metadata(&path) {
        Ok(_) => resolve_existing_home(path, source),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Err(HomeError::Missing { source }),
        Err(error) => Err(HomeError::Unavailable {
            source,
            kind: error.kind(),
        }),
    }
}

fn resolve_existing_home(path: PathBuf, source: HomeSource) -> Result<SugarCodeHome, HomeError> {
    let metadata = fs::metadata(&path).map_err(|error| HomeError::Unavailable {
        source,
        kind: error.kind(),
    })?;
    if !metadata.is_dir() {
        return Err(HomeError::NotDirectory { source });
    }
    let path = fs::canonicalize(path).map_err(|error| HomeError::Unavailable {
        source,
        kind: error.kind(),
    })?;
    Ok(SugarCodeHome { path, source })
}
