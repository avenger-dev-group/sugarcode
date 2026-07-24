mod config;
mod home;
mod rollout;
mod thread_discovery;
mod thread_search;

pub use config::CONFIG_FILE_NAME;
pub use config::CURRENT_CONFIG_SCHEMA_VERSION;
pub use config::ConfigError;
pub use config::EffectiveConfig;
pub use config::MAX_CONFIG_BYTES;
pub use config::load_effective_config;
pub use config::load_effective_config_for_home;
pub use home::HomeError;
pub use home::HomeResolutionInputs;
pub use home::HomeSource;
pub use home::SUGARCODE_HOME_ENV;
pub use home::SugarCodeHome;
pub use home::resolve_sugarcode_home;
pub use home::resolve_sugarcode_home_from_process;
pub use rollout::DurableItemSnapshot;
pub use rollout::DurableThreadLifecycle;
pub use rollout::DurableThreadPage;
pub use rollout::DurableThreadSnapshot;
pub use rollout::DurableThreadSummary;
pub use rollout::DurableTurnSnapshot;
pub use rollout::IdSequences;
pub use rollout::ProjectionDiagnostic;
pub use rollout::RolloutDiagnostic;
pub use rollout::RolloutError;
pub use rollout::RolloutRepository;
pub use rollout::ThreadRepository;

use std::error::Error;
use std::fmt;

#[derive(Debug)]
pub enum StateError {
    Home(HomeError),
    Config(ConfigError),
}

impl fmt::Display for StateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Home(error) => error.fmt(formatter),
            Self::Config(error) => error.fmt(formatter),
        }
    }
}

impl Error for StateError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Home(error) => Some(error),
            Self::Config(error) => Some(error),
        }
    }
}

impl From<HomeError> for StateError {
    fn from(error: HomeError) -> Self {
        Self::Home(error)
    }
}

impl From<ConfigError> for StateError {
    fn from(error: ConfigError) -> Self {
        Self::Config(error)
    }
}
