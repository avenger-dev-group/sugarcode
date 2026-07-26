use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(tag = "type", rename_all = "camelCase")]
pub enum Item {
    UserMessage {
        id: String,
        text: String,
    },
    AgentMessage {
        id: String,
        text: String,
    },
    ToolCall {
        id: String,
        #[serde(rename = "callId")]
        #[ts(rename = "callId")]
        call_id: String,
        name: String,
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        query: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        command: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        arguments: Option<Vec<String>>,
    },
    CommandApprovalRequest {
        id: String,
        #[serde(rename = "approvalId")]
        #[ts(rename = "approvalId")]
        approval_id: String,
        #[serde(rename = "callId")]
        #[ts(rename = "callId")]
        call_id: String,
        command: String,
        arguments: Vec<String>,
        cwd: String,
        #[serde(rename = "environmentPolicy")]
        #[ts(rename = "environmentPolicy")]
        environment_policy: String,
        sandboxed: bool,
    },
    CommandApprovalDecision {
        id: String,
        #[serde(rename = "approvalId")]
        #[ts(rename = "approvalId")]
        approval_id: String,
        decision: String,
    },
    ToolResult {
        id: String,
        #[serde(rename = "callId")]
        #[ts(rename = "callId")]
        call_id: String,
        name: String,
        result: ToolResult,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(tag = "type", rename_all = "camelCase")]
pub enum ToolResult {
    Success {
        content: String,
        bytes: u64,
    },
    Error {
        kind: String,
    },
    Process {
        stdout: String,
        stderr: String,
        #[serde(rename = "stdoutBytes")]
        #[ts(rename = "stdoutBytes")]
        stdout_bytes: u64,
        #[serde(rename = "stderrBytes")]
        #[ts(rename = "stderrBytes")]
        stderr_bytes: u64,
        #[serde(rename = "stdoutTruncated")]
        #[ts(rename = "stdoutTruncated")]
        stdout_truncated: bool,
        #[serde(rename = "stderrTruncated")]
        #[ts(rename = "stderrTruncated")]
        stderr_truncated: bool,
        encoding: String,
        #[serde(rename = "durationMs")]
        #[ts(rename = "durationMs")]
        duration_ms: u64,
        outcome: ProcessOutcome,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(tag = "type", rename_all = "camelCase")]
pub enum ProcessOutcome {
    ExitCode { code: i64 },
    Signal { signal: i32 },
    TimedOut,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ItemStartedNotification {
    pub thread_id: String,
    pub turn_id: String,
    pub item: Item,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentMessageDeltaNotification {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub delta: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ItemCompletedNotification {
    pub thread_id: String,
    pub turn_id: String,
    pub item: Item,
}
