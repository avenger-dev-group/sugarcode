mod config;
mod content;
mod context_compaction;
mod home;
mod rollout;
mod thread_discovery;
mod thread_search;

pub use config::CONFIG_FILE_NAME;
pub use config::CURRENT_CONFIG_SCHEMA_VERSION;
pub use config::ConfigError;
pub use config::DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS;
pub use config::EffectiveConfig;
pub use config::MAX_CONFIG_BYTES;
pub use config::MAX_MCP_SERVERS;
pub use config::MAX_MODEL_API_KEY_BYTES;
pub use config::MAX_MODEL_CONNECTIONS;
pub use config::MAX_MODEL_CONTEXT_WINDOW_TOKENS;
pub use config::MAX_MODEL_DISPLAY_NAME_BYTES;
pub use config::MAX_MODEL_ID_BYTES;
pub use config::MAX_MODEL_NAME_BYTES;
pub use config::MAX_MODEL_PROFILES;
pub use config::MIN_MODEL_CONTEXT_WINDOW_TOKENS;
pub use config::McpServerConfig;
pub use config::McpStdioServerConfig;
pub use config::McpStreamableHttpServerConfig;
pub use config::ModelCapabilityMode;
pub use config::ModelCatalog;
pub use config::ModelConnection;
pub use config::ModelContinuationMode;
pub use config::ModelProfile;
pub use config::ModelProfileCapabilities;
pub use config::ModelProviderFamily;
pub use config::ModelWireApi;
pub use config::load_effective_config;
pub use config::load_effective_config_for_home;
pub use config::load_model_edit_config_for_home;
pub use config::load_runtime_config;
pub use config::load_runtime_config_for_home;
pub use config::save_mcp_config;
pub use config::save_model_catalog;
pub use content::ContentAsset;
pub use content::ContentAssetKind;
pub use content::ContentStore;
pub use content::ContentStoreError;
pub use content::MAX_IMAGE_BYTES;
pub use content::MAX_PDF_BYTES;
pub use content::MAX_PDF_PAGES;
pub use content::MAX_TEXT_BYTES;
pub use content::MAX_TURN_ATTACHMENT_BYTES;
pub use content::MAX_TURN_ATTACHMENTS;
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
pub use rollout::DurableActiveTurnCompactionOutcome;
pub use rollout::DurableCompactionSummary;
pub use rollout::DurableContentAsset;
pub use rollout::DurableContextCompaction;
pub use rollout::DurableContextCompactionStrategy;
pub use rollout::DurableItemSnapshot;
pub use rollout::DurableMcpToolResult;
pub use rollout::DurableModelProtocolCode;
pub use rollout::DurableModelProtocolDiagnostic;
pub use rollout::DurableModelProtocolStage;
pub use rollout::DurableModelSelectionCapabilities;
pub use rollout::DurableModelSelectionSnapshot;
pub use rollout::DurableProcessOutcome;
pub use rollout::DurableProcessResult;
pub use rollout::DurableProviderErrorMetadata;
pub use rollout::DurableThreadLifecycle;
pub use rollout::DurableThreadOrigin;
pub use rollout::DurableThreadPage;
pub use rollout::DurableThreadSnapshot;
pub use rollout::DurableThreadSummary;
pub use rollout::DurableToolResult;
pub use rollout::DurableToolSchemaError;
pub use rollout::DurableTurnError;
pub use rollout::DurableTurnErrorKind;
pub use rollout::DurableTurnSnapshot;
pub use rollout::DurableTurnStatus;
pub use rollout::DurableUsage;
pub use rollout::DurableUsageSample;
pub use rollout::DurableUsageSource;
pub use rollout::DurableUserContentPart;
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
pub use rollout::RolloutRepositoryStore;
pub use rollout::ThreadRepository;
pub use rollout::WorkspaceRolloutRepository;
pub use rollout::derive_thread_title;
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
