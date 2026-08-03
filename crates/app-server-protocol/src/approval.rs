use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct ApprovalSourceAgent {
    pub task_id: String,
    pub role: crate::AgentTaskRole,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum CommandSandboxPolicy {
    FilesystemReadOnlyV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum CommandNetworkPolicy {
    NetworkDeniedV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum CommandWorkspaceWritePolicy {
    CommandWorkspaceWriteV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum CommandWorkspaceWriteRisk {
    NonTransactionalWorkspaceTreeV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct CommandApprovalParams {
    pub approval_id: String,
    pub workspace_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub call_id: String,
    pub description: String,
    pub command: String,
    pub arguments: Vec<String>,
    pub cwd: String,
    pub approval_scope: String,
    pub environment_policy: String,
    pub sandboxed: bool,
    pub sandbox_policy: CommandSandboxPolicy,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source_agent: Option<ApprovalSourceAgent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace_write_policy: Option<CommandWorkspaceWritePolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace_write_risk: Option<CommandWorkspaceWriteRisk>,
    pub network_policy: CommandNetworkPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum CommandApprovalResponseDecision {
    Approved,
    Denied,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct CommandApprovalResponse {
    pub decision: CommandApprovalResponseDecision,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace_write_risk_acknowledgement: Option<CommandWorkspaceWriteRisk>,
}
