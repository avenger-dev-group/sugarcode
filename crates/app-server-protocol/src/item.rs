use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

use crate::CommandNetworkPolicy;
use crate::CommandSandboxPolicy;
use crate::CommandWorkspaceWritePolicy;
use crate::CommandWorkspaceWriteRisk;
use crate::TurnInputPart;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum AgentTaskRole {
    Explorer,
    Worker,
    Auditor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum AgentTaskAccess {
    ReadOnly,
    WorkspaceWrite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum AgentTaskStatus {
    Queued,
    Running,
    WaitingApproval,
    Completed,
    Failed,
    Interrupted,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(tag = "type", rename_all = "camelCase")]
pub enum Item {
    UserMessage {
        id: String,
        content: Vec<TurnInputPart>,
    },
    AgentMessage {
        id: String,
        text: String,
    },
    AgentCommentary {
        id: String,
        text: String,
    },
    AgentTask {
        id: String,
        #[serde(rename = "orchestrationId")]
        #[ts(rename = "orchestrationId")]
        orchestration_id: String,
        #[serde(rename = "taskId")]
        #[ts(rename = "taskId")]
        task_id: String,
        #[serde(rename = "clientTaskKey")]
        #[ts(rename = "clientTaskKey")]
        client_task_key: String,
        #[serde(rename = "childThreadId")]
        #[ts(rename = "childThreadId")]
        child_thread_id: String,
        title: String,
        role: AgentTaskRole,
        access: AgentTaskAccess,
        #[serde(rename = "dependsOn")]
        #[ts(rename = "dependsOn")]
        depends_on: Vec<String>,
        #[serde(rename = "taskMarkdown")]
        #[ts(rename = "taskMarkdown")]
        task_markdown: String,
    },
    AgentTaskAmendment {
        id: String,
        #[serde(rename = "orchestrationId")]
        #[ts(rename = "orchestrationId")]
        orchestration_id: String,
        #[serde(rename = "taskId")]
        #[ts(rename = "taskId")]
        task_id: String,
        #[serde(rename = "amendmentMarkdown")]
        #[ts(rename = "amendmentMarkdown")]
        amendment_markdown: String,
    },
    AgentTaskResult {
        id: String,
        #[serde(rename = "orchestrationId")]
        #[ts(rename = "orchestrationId")]
        orchestration_id: String,
        #[serde(rename = "taskId")]
        #[ts(rename = "taskId")]
        task_id: String,
        status: AgentTaskStatus,
        #[serde(rename = "summaryMarkdown")]
        #[ts(rename = "summaryMarkdown")]
        summary_markdown: String,
        #[serde(rename = "durationMs")]
        #[ts(rename = "durationMs")]
        duration_ms: u64,
    },
    ContextCompaction {
        id: String,
        strategy: ContextCompactionStrategy,
        ordinal: u64,
        #[serde(rename = "preContextBytes")]
        #[ts(rename = "preContextBytes")]
        pre_context_bytes: u64,
        #[serde(rename = "sourceMessages")]
        #[ts(rename = "sourceMessages")]
        source_messages: u64,
        #[serde(rename = "sourceBytes")]
        #[ts(rename = "sourceBytes")]
        source_bytes: u64,
        #[serde(rename = "sourceSha256")]
        #[ts(rename = "sourceSha256")]
        source_sha256: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        outcome: Option<ContextCompactionOutcome>,
    },
    ToolCall {
        id: String,
        #[serde(rename = "callId")]
        #[ts(rename = "callId")]
        call_id: String,
        name: String,
        arguments: serde_json::Value,
    },
    ToolValidationRejected {
        id: String,
        #[serde(rename = "callId")]
        #[ts(rename = "callId")]
        call_id: String,
        name: String,
        kind: String,
        #[serde(rename = "argumentsBytes")]
        #[ts(rename = "argumentsBytes")]
        arguments_bytes: u64,
        #[serde(rename = "argumentsSha256")]
        #[ts(rename = "argumentsSha256")]
        arguments_sha256: String,
        #[serde(rename = "editIndex", skip_serializing_if = "Option::is_none")]
        #[ts(rename = "editIndex", optional)]
        edit_index: Option<u32>,
        #[serde(rename = "hunkIndex", skip_serializing_if = "Option::is_none")]
        #[ts(rename = "hunkIndex", optional)]
        hunk_index: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        line: Option<u32>,
        #[serde(rename = "expectedSummary", skip_serializing_if = "Option::is_none")]
        #[ts(rename = "expectedSummary", optional)]
        expected_summary: Option<String>,
        #[serde(rename = "actualSummary", skip_serializing_if = "Option::is_none")]
        #[ts(rename = "actualSummary", optional)]
        actual_summary: Option<String>,
        #[serde(rename = "suggestedAction")]
        #[ts(rename = "suggestedAction")]
        suggested_action: String,
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
        #[serde(rename = "workspaceWritePolicy")]
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(rename = "workspaceWritePolicy")]
        #[ts(optional)]
        workspace_write_policy: Option<CommandWorkspaceWritePolicy>,
        #[serde(rename = "workspaceWriteRisk")]
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(rename = "workspaceWriteRisk")]
        #[ts(optional)]
        workspace_write_risk: Option<CommandWorkspaceWriteRisk>,
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
        #[serde(rename = "workspaceWriteRiskAcknowledgement")]
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(rename = "workspaceWriteRiskAcknowledgement")]
        #[ts(optional)]
        workspace_write_risk_acknowledgement: Option<CommandWorkspaceWriteRisk>,
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
    McpToolCall {
        id: String,
        #[serde(rename = "callId")]
        #[ts(rename = "callId")]
        call_id: String,
        name: String,
        #[ts(type = "JsonValue")]
        arguments: serde_json::Value,
        #[serde(rename = "argumentsBytes")]
        #[ts(rename = "argumentsBytes")]
        arguments_bytes: u64,
        #[serde(rename = "argumentsSha256")]
        #[ts(rename = "argumentsSha256")]
        arguments_sha256: String,
        #[serde(rename = "inventorySha256")]
        #[ts(rename = "inventorySha256")]
        inventory_sha256: String,
    },
    McpToolCallApprovalRequest {
        id: String,
        #[serde(rename = "approvalId")]
        #[ts(rename = "approvalId")]
        approval_id: String,
        #[serde(rename = "callId")]
        #[ts(rename = "callId")]
        call_id: String,
        name: String,
        #[ts(type = "JsonValue")]
        arguments: serde_json::Value,
        #[serde(rename = "argumentsBytes")]
        #[ts(rename = "argumentsBytes")]
        arguments_bytes: u64,
        #[serde(rename = "argumentsSha256")]
        #[ts(rename = "argumentsSha256")]
        arguments_sha256: String,
        #[serde(rename = "inventorySha256")]
        #[ts(rename = "inventorySha256")]
        inventory_sha256: String,
    },
    McpToolCallApprovalDecision {
        id: String,
        #[serde(rename = "approvalId")]
        #[ts(rename = "approvalId")]
        approval_id: String,
        decision: String,
    },
    McpToolExecutionAttempt {
        id: String,
        #[serde(rename = "approvalId")]
        #[ts(rename = "approvalId")]
        approval_id: String,
        #[serde(rename = "callId")]
        #[ts(rename = "callId")]
        call_id: String,
        #[serde(rename = "inventorySha256")]
        #[ts(rename = "inventorySha256")]
        inventory_sha256: String,
    },
    McpToolResult {
        id: String,
        #[serde(rename = "callId")]
        #[ts(rename = "callId")]
        call_id: String,
        name: String,
        result: McpToolResult,
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
pub enum ContextCompactionStrategy {
    ModelGeneratedActiveTurnV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(tag = "type", rename_all = "camelCase")]
pub enum ContextCompactionOutcome {
    Completed {
        #[serde(rename = "postContextBytes")]
        #[ts(rename = "postContextBytes")]
        post_context_bytes: u64,
        #[serde(rename = "summaryBytes")]
        #[ts(rename = "summaryBytes")]
        summary_bytes: u64,
        #[serde(rename = "summarySha256")]
        #[ts(rename = "summarySha256")]
        summary_sha256: String,
    },
    Failed {
        kind: String,
    },
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(tag = "type", rename_all = "camelCase")]
pub enum McpToolResult {
    Completed {
        content: String,
        is_error: bool,
        observed_bytes: u64,
        canonical_bytes: u64,
        retained_bytes: u64,
        truncated: bool,
        sha256: String,
        content_blocks: u64,
        structured_content: bool,
    },
    Error {
        kind: String,
        request_state: String,
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
        #[serde(rename = "workspaceWritePolicy")]
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(rename = "workspaceWritePolicy")]
        #[ts(optional)]
        workspace_write_policy: Option<CommandWorkspaceWritePolicy>,
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
    pub workspace_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub item: Item,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub agent_output: Option<AgentOutputRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentOutputRef {
    pub response_ordinal: u64,
    pub output_index: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentOutputDeltaNotification {
    pub workspace_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub output: AgentOutputRef,
    pub delta: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentOutputDiscardedNotification {
    pub workspace_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub output: AgentOutputRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentMessageDeltaNotification {
    pub workspace_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub delta: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ItemCompletedNotification {
    pub workspace_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub item: Item,
}
