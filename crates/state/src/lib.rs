mod config;
mod context_compaction;
mod home;
mod rollout;
mod thread_discovery;
mod thread_search;

pub use config::CONFIG_FILE_NAME;
pub use config::CURRENT_CONFIG_SCHEMA_VERSION;
pub use config::ConfigError;
pub use config::EffectiveConfig;
pub use config::MAX_CONFIG_BYTES;
pub use config::MAX_CREDENTIAL_REFERENCE_BYTES;
pub use config::MAX_MODEL_NAME_BYTES;
pub use config::McpStdioServerConfig;
pub use config::ModelApiFormat;
pub use config::ModelConfig;
pub use config::load_effective_config;
pub use config::load_effective_config_for_home;
pub use config::save_model_config;
pub use context_compaction::MAX_CONTEXT_COMPACTION_MESSAGE_BYTES;
pub use context_compaction::build_context_compaction;
pub use context_compaction::validate_context_compaction;
pub use home::HomeError;
pub use home::HomeResolutionInputs;
pub use home::HomeSource;
pub use home::SUGARCODE_HOME_ENV;
pub use home::SugarCodeHome;
pub use home::resolve_sugarcode_home;
pub use home::resolve_sugarcode_home_from_process;
pub use rollout::DurableContextCompaction;
pub use rollout::DurableContextCompactionStrategy;
pub use rollout::DurableItemSnapshot;
pub use rollout::DurableProcessOutcome;
pub use rollout::DurableProcessResult;
pub use rollout::DurableThreadLifecycle;
pub use rollout::DurableThreadPage;
pub use rollout::DurableThreadSnapshot;
pub use rollout::DurableThreadSummary;
pub use rollout::DurableToolResult;
pub use rollout::DurableTurnError;
pub use rollout::DurableTurnErrorKind;
pub use rollout::DurableTurnSnapshot;
pub use rollout::DurableTurnStatus;
pub use rollout::DurableUsage;
pub use rollout::DurableWorkspaceInstructionsAudit;
pub use rollout::DurableWorkspaceInstructionsSource;
pub use rollout::DurableWorkspaceInstructionsStatus;
pub use rollout::DurableWorkspaceSkillsAudit;
pub use rollout::DurableWorkspaceSkillsSource;
pub use rollout::DurableWorkspaceSkillsStatus;
pub use rollout::IdSequences;
pub use rollout::ProjectionDiagnostic;
pub use rollout::RolloutDiagnostic;
pub use rollout::RolloutError;
pub use rollout::RolloutRepository;
pub use rollout::ThreadRepository;
pub use rollout::terminal_turn_record_fits;

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
