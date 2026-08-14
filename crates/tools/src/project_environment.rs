use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const PROJECT_ENVIRONMENT_CONFIG_PATH: &str = ".sugarcode/project.json";
pub const MAX_PROJECT_ENVIRONMENT_CONFIG_BYTES: usize = 64 * 1024;
pub const MAX_PROJECT_ENVIRONMENT_SCRIPT_BYTES: usize = 32 * 1024;
pub const MAX_PROJECT_ENVIRONMENT_ACTIONS: usize = 32;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectEnvironmentConfig {
    pub schema_version: u8,
    #[serde(default)]
    pub setup: PlatformScript,
    #[serde(default)]
    pub environment: PlatformScript,
    #[serde(default)]
    pub actions: Vec<ProjectEnvironmentAction>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformScript {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub macos: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub windows: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectEnvironmentAction {
    pub id: String,
    pub label: String,
    pub command: PlatformScript,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedProjectEnvironmentConfig {
    pub config_path: String,
    pub config_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup_script: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment_script: Option<String>,
    pub actions: Vec<ResolvedProjectEnvironmentAction>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedProjectEnvironmentAction {
    pub id: String,
    pub label: String,
    pub command: String,
}

pub fn parse_project_environment_config(
    content: &str,
) -> Result<ResolvedProjectEnvironmentConfig, String> {
    if content.len() > MAX_PROJECT_ENVIRONMENT_CONFIG_BYTES {
        return Err("project environment configuration exceeds 64 KiB".to_owned());
    }
    let config: ProjectEnvironmentConfig = serde_json::from_str(content)
        .map_err(|error| format!("project environment configuration is invalid: {error}"))?;
    if config.schema_version != 1 {
        return Err("project environment schemaVersion must be 1".to_owned());
    }
    if config.actions.len() > MAX_PROJECT_ENVIRONMENT_ACTIONS {
        return Err("project environment declares too many actions".to_owned());
    }
    validate_platform_script(&config.setup)?;
    validate_platform_script(&config.environment)?;
    let mut action_ids = std::collections::BTreeSet::new();
    for action in &config.actions {
        if action.id.is_empty()
            || action.id.len() > 64
            || !action
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            || action.label.trim().is_empty()
            || action.label.len() > 128
            || !action_ids.insert(action.id.as_str())
        {
            return Err("project environment action metadata is invalid".to_owned());
        }
        validate_platform_script(&action.command)?;
    }
    let mut hasher = Sha256::new();
    hasher.update(b"sugarcode-project-environment-v1\0");
    // Git may materialize the same committed file with CRLF in a Windows
    // worktree even when the trusted source workspace used LF. Treat that
    // checkout-only transformation as the same configuration while keeping
    // every other byte significant for trust invalidation.
    hasher.update(content.replace("\r\n", "\n").as_bytes());
    Ok(ResolvedProjectEnvironmentConfig {
        config_path: PROJECT_ENVIRONMENT_CONFIG_PATH.to_owned(),
        config_hash: format!("{:x}", hasher.finalize()),
        setup_script: resolve_platform_script(&config.setup),
        environment_script: resolve_platform_script(&config.environment),
        actions: config
            .actions
            .into_iter()
            .filter_map(|action| {
                resolve_platform_script(&action.command).map(|command| {
                    ResolvedProjectEnvironmentAction {
                        id: action.id,
                        label: action.label,
                        command,
                    }
                })
            })
            .collect(),
    })
}

fn validate_platform_script(script: &PlatformScript) -> Result<(), String> {
    for value in [&script.default, &script.macos, &script.windows]
        .into_iter()
        .flatten()
    {
        if value.is_empty()
            || value.len() > MAX_PROJECT_ENVIRONMENT_SCRIPT_BYTES
            || value.contains('\0')
        {
            return Err("project environment script is empty or exceeds its limit".to_owned());
        }
    }
    Ok(())
}

fn resolve_platform_script(script: &PlatformScript) -> Option<String> {
    #[cfg(target_os = "macos")]
    let selected = script.macos.as_ref().or(script.default.as_ref());
    #[cfg(windows)]
    let selected = script.windows.as_ref().or(script.default.as_ref());
    #[cfg(not(any(target_os = "macos", windows)))]
    let selected = script.default.as_ref();
    selected.cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_platform_scripts_and_hashes_content_portably() {
        let content = r#"{
          "schemaVersion": 1,
          "setup": { "default": "npm install", "macos": "pnpm install" },
          "environment": { "default": "export TOOL_HOME=/fixture" },
          "actions": [{ "id": "verify", "label": "Verify", "command": { "default": "npm test" } }]
        }"#;
        let parsed = parse_project_environment_config(content).expect("project environment");
        #[cfg(target_os = "macos")]
        assert_eq!(parsed.setup_script.as_deref(), Some("pnpm install"));
        #[cfg(not(target_os = "macos"))]
        assert_eq!(parsed.setup_script.as_deref(), Some("npm install"));
        assert_eq!(parsed.actions[0].id, "verify");
        assert_eq!(parsed.config_hash.len(), 64);
        assert_eq!(
            parsed.config_hash,
            parse_project_environment_config(&content.replace('\n', "\r\n"))
                .expect("CRLF config")
                .config_hash
        );
        assert_ne!(
            parsed.config_hash,
            parse_project_environment_config(&format!("{content}\n"))
                .expect("changed config")
                .config_hash
        );
    }

    #[test]
    fn rejects_unknown_fields_duplicate_actions_and_oversized_scripts() {
        assert!(
            parse_project_environment_config(r#"{"schemaVersion":1,"unexpected":true}"#).is_err()
        );
        assert!(parse_project_environment_config(
            r#"{"schemaVersion":1,"actions":[{"id":"same","label":"One","command":{"default":"one"}},{"id":"same","label":"Two","command":{"default":"two"}}]}"#
        )
        .is_err());
        let oversized = "x".repeat(MAX_PROJECT_ENVIRONMENT_SCRIPT_BYTES + 1);
        assert!(
            parse_project_environment_config(&format!(
                r#"{{"schemaVersion":1,"setup":{{"default":"{oversized}"}}}}"#
            ))
            .is_err()
        );
    }
}
