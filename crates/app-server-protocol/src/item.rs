use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

use crate::CommandNetworkPolicy;
use crate::CommandSandboxPolicy;

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
    FileChange {
        id: String,
        #[serde(rename = "callId")]
        #[ts(rename = "callId")]
        call_id: String,
        path: String,
        kind: FileChangeKind,
        diff: String,
        #[serde(rename = "beforeSha256")]
        #[ts(rename = "beforeSha256")]
        before_sha256: String,
        #[serde(rename = "afterSha256")]
        #[ts(rename = "afterSha256")]
        after_sha256: String,
        #[serde(rename = "beforeBytes")]
        #[ts(rename = "beforeBytes")]
        before_bytes: u64,
        #[serde(rename = "afterBytes")]
        #[ts(rename = "afterBytes")]
        after_bytes: u64,
        #[serde(rename = "newlineStyle")]
        #[ts(rename = "newlineStyle")]
        newline_style: FileChangeNewlineStyle,
        #[serde(rename = "finalNewline")]
        #[ts(rename = "finalNewline")]
        final_newline: bool,
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
        #[serde(rename = "sandboxPolicy")]
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(rename = "sandboxPolicy")]
        #[ts(optional)]
        sandbox_policy: Option<CommandSandboxPolicy>,
        #[serde(rename = "networkPolicy")]
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(rename = "networkPolicy")]
        #[ts(optional)]
        network_policy: Option<CommandNetworkPolicy>,
    },
    CommandApprovalDecision {
        id: String,
        #[serde(rename = "approvalId")]
        #[ts(rename = "approvalId")]
        approval_id: String,
        decision: String,
    },
    CommandExecutionAttempt {
        id: String,
        #[serde(rename = "approvalId")]
        #[ts(rename = "approvalId")]
        approval_id: String,
        #[serde(rename = "callId")]
        #[ts(rename = "callId")]
        call_id: String,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum FileChangeKind {
    Update,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum FileChangeNewlineStyle {
    Lf,
    CrLf,
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
        #[serde(rename = "sandboxPolicy")]
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(rename = "sandboxPolicy")]
        #[ts(optional)]
        sandbox_policy: Option<CommandSandboxPolicy>,
        #[serde(rename = "networkPolicy")]
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(rename = "networkPolicy")]
        #[ts(optional)]
        network_policy: Option<CommandNetworkPolicy>,
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
