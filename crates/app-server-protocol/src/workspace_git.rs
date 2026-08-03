use schemars::JsonSchema;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::de;
use ts_rs::TS;

const MAX_PATH_BYTES: usize = 1_024;
const MAX_PATH_COMPONENTS: usize = 64;
const MAX_MUTATION_PATHS: usize = 100;
const MAX_COMMIT_MESSAGE_BYTES: usize = 64 * 1_024;
const MAX_IDENTITY_BYTES: usize = 256;

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct WorkspaceGitStatusParams {
    pub workspace_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum WorkspaceGitChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    TypeChanged,
    Conflicted,
    Untracked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum WorkspaceGitRepositoryState {
    Clean,
    Merge,
    Revert,
    RevertSequence,
    CherryPick,
    CherryPickSequence,
    Bisect,
    Rebase,
    RebaseInteractive,
    RebaseMerge,
    ApplyMailbox,
    ApplyMailboxOrRebase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum WorkspaceGitErrorKind {
    NotRepository,
    UnsupportedRepository,
    InvalidPath,
    Stale,
    NothingToCommit,
    TooLarge,
    UnsupportedPath,
    Unborn,
    Detached,
    RepositoryState,
    IndexLocked,
    Changed,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct WorkspaceGitStatusEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub index: Option<WorkspaceGitChangeKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub worktree: Option<WorkspaceGitChangeKind>,
    pub stageable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(tag = "status", rename_all = "camelCase")]
pub enum WorkspaceGitStatusResponse {
    Ready {
        revision: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        branch: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        head: Option<String>,
        repository_state: WorkspaceGitRepositoryState,
        mutation_allowed: bool,
        entries: Vec<WorkspaceGitStatusEntry>,
        staged_count: u32,
        unstaged_count: u32,
        unsupported_paths: u32,
    },
    Error {
        kind: WorkspaceGitErrorKind,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum WorkspaceGitDiffSource {
    Worktree,
    Index,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct WorkspaceGitDiffParams {
    pub workspace_id: String,
    pub expected_revision: String,
    #[schemars(length(min = 1, max = 1024))]
    pub path: String,
    pub source: WorkspaceGitDiffSource,
}

impl<'de> Deserialize<'de> for WorkspaceGitDiffParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields, rename_all = "camelCase")]
        struct Wire {
            workspace_id: String,
            expected_revision: String,
            path: String,
            source: WorkspaceGitDiffSource,
        }
        let wire = Wire::deserialize(deserializer)?;
        validate_revision(&wire.expected_revision).map_err(de::Error::custom)?;
        validate_path(&wire.path).map_err(de::Error::custom)?;
        Ok(Self {
            workspace_id: wire.workspace_id,
            expected_revision: wire.expected_revision,
            path: wire.path,
            source: wire.source,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(tag = "status", rename_all = "camelCase")]
pub enum WorkspaceGitDiffResponse {
    Ready {
        revision: String,
        path: String,
        source: WorkspaceGitDiffSource,
        content: String,
        additions: u32,
        deletions: u32,
    },
    Error {
        kind: WorkspaceGitErrorKind,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct WorkspaceGitMutationParams {
    pub workspace_id: String,
    pub expected_revision: String,
    #[schemars(length(min = 1, max = 100))]
    pub paths: Vec<String>,
}

impl<'de> Deserialize<'de> for WorkspaceGitMutationParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields, rename_all = "camelCase")]
        struct Wire {
            workspace_id: String,
            expected_revision: String,
            paths: Vec<String>,
        }
        let wire = Wire::deserialize(deserializer)?;
        validate_revision(&wire.expected_revision).map_err(de::Error::custom)?;
        if wire.paths.is_empty() || wire.paths.len() > MAX_MUTATION_PATHS {
            return Err(de::Error::custom(
                "paths must contain 1 through 100 entries",
            ));
        }
        let mut sorted = wire.paths.clone();
        sorted.sort();
        if sorted.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(de::Error::custom("paths must be unique"));
        }
        for path in &wire.paths {
            validate_path(path).map_err(de::Error::custom)?;
        }
        Ok(Self {
            workspace_id: wire.workspace_id,
            expected_revision: wire.expected_revision,
            paths: wire.paths,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(tag = "status", rename_all = "camelCase")]
pub enum WorkspaceGitMutationResponse {
    Applied {
        revision: String,
        paths: Vec<String>,
    },
    Error {
        kind: WorkspaceGitErrorKind,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct WorkspaceGitCommitParams {
    pub workspace_id: String,
    pub expected_revision: String,
    pub message: String,
    pub author_name: String,
    pub author_email: String,
}

impl<'de> Deserialize<'de> for WorkspaceGitCommitParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields, rename_all = "camelCase")]
        struct Wire {
            workspace_id: String,
            expected_revision: String,
            message: String,
            author_name: String,
            author_email: String,
        }
        let wire = Wire::deserialize(deserializer)?;
        validate_revision(&wire.expected_revision).map_err(de::Error::custom)?;
        if wire.message.trim().is_empty()
            || wire.message.len() > MAX_COMMIT_MESSAGE_BYTES
            || !valid_identity(&wire.author_name)
            || !valid_identity(&wire.author_email)
        {
            return Err(de::Error::custom("invalid Git commit identity or message"));
        }
        Ok(Self {
            workspace_id: wire.workspace_id,
            expected_revision: wire.expected_revision,
            message: wire.message,
            author_name: wire.author_name,
            author_email: wire.author_email,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(tag = "status", rename_all = "camelCase")]
pub enum WorkspaceGitCommitResponse {
    Committed {
        revision: String,
        old_head: String,
        new_head: String,
    },
    Error {
        kind: WorkspaceGitErrorKind,
    },
}

fn validate_revision(revision: &str) -> Result<(), &'static str> {
    if revision.len() != 64 || !revision.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("expectedRevision must be a 64-character hexadecimal revision");
    }
    Ok(())
}

fn validate_path(path: &str) -> Result<(), &'static str> {
    if path.is_empty()
        || path.len() > MAX_PATH_BYTES
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.chars().any(char::is_control)
    {
        return Err("invalid workspace-relative path");
    }
    let components = path.split(['/', '\\']).collect::<Vec<_>>();
    if components.len() > MAX_PATH_COMPONENTS
        || components
            .iter()
            .any(|component| component.is_empty() || matches!(*component, "." | ".."))
    {
        return Err("invalid workspace-relative path");
    }
    Ok(())
}

fn valid_identity(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_IDENTITY_BYTES && !value.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutations_require_unique_safe_paths_and_a_revision() {
        let revision = "a".repeat(64);
        assert!(
            serde_json::from_value::<WorkspaceGitMutationParams>(serde_json::json!({
                "workspaceId": "wsp_test",
                "expectedRevision": revision,
                "paths": ["src/lib.rs"]
            }))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<WorkspaceGitMutationParams>(serde_json::json!({
                "workspaceId": "wsp_test",
                "expectedRevision": "bad",
                "paths": ["../secret"]
            }))
            .is_err()
        );
    }
}
