use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct McpToolCallApprovalParams {
    pub approval_id: String,
    pub workspace_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub call_id: String,
    pub name: String,
    #[ts(type = "JsonValue")]
    pub arguments: serde_json::Value,
    pub arguments_bytes: u64,
    pub arguments_sha256: String,
    pub inventory_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source_agent: Option<crate::ApprovalSourceAgent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum McpToolCallApprovalResponseDecision {
    Approved,
    Denied,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct McpToolCallApprovalResponse {
    pub decision: McpToolCallApprovalResponseDecision,
}
