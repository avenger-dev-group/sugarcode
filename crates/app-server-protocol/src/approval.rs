use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum CommandSandboxPolicy {
    FilesystemReadOnlyV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct CommandApprovalParams {
    pub approval_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub call_id: String,
    pub command: String,
    pub arguments: Vec<String>,
    pub cwd: String,
    pub approval_scope: String,
    pub environment_policy: String,
    pub sandboxed: bool,
    pub sandbox_policy: CommandSandboxPolicy,
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
}
