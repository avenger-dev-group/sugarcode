mod format;
mod replay;
mod repository;

pub(crate) use replay::parse_canonical_id;
pub use repository::RolloutRepository;

use std::error::Error;
use std::fmt;
use std::path::PathBuf;
use sugarcode_protocol::ItemId;
use sugarcode_protocol::ThreadId;
use sugarcode_protocol::TurnId;

pub const CURRENT_ROLLOUT_SCHEMA_VERSION: u32 = 1;
pub const MAX_ROLLOUT_FILES: usize = 10_000;
pub const MAX_ROLLOUT_FILE_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_ROLLOUT_RECORD_BYTES: usize = 1024 * 1024;
pub const MAX_ROLLOUT_RECORDS_PER_FILE: usize = 100_000;
pub const MAX_TOTAL_REPLAY_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_TOTAL_REPLAY_RECORDS: usize = 1_000_000;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IdSequences {
    pub thread: u64,
    pub turn: u64,
    pub item: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableThreadSnapshot {
    pub id: ThreadId,
    pub turns: Vec<DurableTurnSnapshot>,
    pub lifecycle: DurableThreadLifecycle,
    pub origin: Option<DurableThreadOrigin>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableThreadOrigin {
    pub parent_thread_id: ThreadId,
    pub parent_turn_id: TurnId,
    pub orchestration_id: String,
    pub task_id: String,
    pub role: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RolloutThreadState {
    pub snapshot: DurableThreadSnapshot,
    pub workspace_binding_id: Option<String>,
    pub last_record_sequence: u64,
    pub turn_record_sequences: Vec<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurableThreadLifecycle {
    Active,
    Archived,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableThreadSummary {
    pub id: ThreadId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableThreadPage {
    pub data: Vec<DurableThreadSummary>,
    pub next_cursor: Option<ThreadId>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableTurnSnapshot {
    pub id: TurnId,
    pub status: DurableTurnStatus,
    pub items: Vec<DurableItemSnapshot>,
    pub model: Option<DurableModelSelectionSnapshot>,
    pub context_compaction: Option<DurableContextCompaction>,
    pub workspace_instructions: Option<DurableWorkspaceInstructionsAudit>,
    pub workspace_skills: Option<DurableWorkspaceSkillsAudit>,
    pub error: Option<DurableTurnError>,
    pub usage: Option<DurableUsage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableModelSelectionSnapshot {
    pub profile_id: String,
    pub provider_family: String,
    pub wire_api: String,
    pub model_id: String,
    pub display_name: String,
    pub context_window_tokens: u32,
    pub effective_capabilities: DurableModelSelectionCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableModelSelectionCapabilities {
    pub tool_calls: bool,
    pub strict_tools: bool,
    pub parallel_tools: bool,
    pub image_input: bool,
    pub pdf_input: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableWorkspaceSkillsAudit {
    pub source: DurableWorkspaceSkillsSource,
    pub status: DurableWorkspaceSkillsStatus,
    pub discovered_count: u64,
    pub effective_count: u64,
    pub selected_count: u64,
    pub source_bytes: u64,
    pub inventory_bytes: u64,
    pub selected_bytes: u64,
    pub manifest_sha256: String,
    pub selection_sha256: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurableWorkspaceSkillsSource {
    RootToActiveScopeAgentsSkillsV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurableWorkspaceSkillsStatus {
    Absent,
    Present,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableContextCompaction {
    pub strategy: DurableContextCompactionStrategy,
    pub through_turn_id: TurnId,
    pub source_turns: u64,
    pub source_messages: u64,
    pub source_bytes: u64,
    pub source_sha256: String,
    pub message_bytes: u64,
    pub message_sha256: String,
    pub message: String,
    pub pre_context_bytes: u64,
    pub post_context_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurableContextCompactionStrategy {
    DeterministicExtractiveV1,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableWorkspaceInstructionsAudit {
    pub source: DurableWorkspaceInstructionsSource,
    pub status: DurableWorkspaceInstructionsStatus,
    pub bytes: Option<u64>,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurableWorkspaceInstructionsSource {
    RootAgentsMdV1,
    RootToActiveScopeAgentsMdV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurableWorkspaceInstructionsStatus {
    Absent,
    Present,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurableTurnStatus {
    InProgress,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurableTurnErrorKind {
    Authentication,
    InvalidRequest,
    RateLimited,
    Timeout,
    Transport,
    Disconnected,
    Server,
    Protocol,
    Incomplete,
    Filtered,
    UnsupportedOutput,
    UnsupportedToolArguments,
    OutputTooLarge,
    StateUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableTurnError {
    pub kind: DurableTurnErrorKind,
    pub retryable: bool,
    pub provider: Option<DurableProviderErrorMetadata>,
    pub tool_schema: Option<DurableToolSchemaError>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableProviderErrorMetadata {
    pub http_status: u16,
    pub code: Option<String>,
    pub request_id: Option<String>,
    pub retry_after: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableToolSchemaError {
    pub tool_name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DurableUsage {
    pub input_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableContentAsset {
    pub asset_id: String,
    pub sha256: String,
    pub media_type: String,
    pub original_name: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DurableUserContentPart {
    Text { text: String },
    Image { asset: DurableContentAsset },
    Document { asset: DurableContentAsset },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DurableItemSnapshot {
    UserMessage {
        id: ItemId,
        content: Vec<DurableUserContentPart>,
    },
    AgentMessage {
        id: ItemId,
        text: String,
    },
    AgentCommentary {
        id: ItemId,
        text: String,
    },
    AgentTask {
        id: ItemId,
        orchestration_id: String,
        task_id: String,
        client_task_key: String,
        child_thread_id: ThreadId,
        title: String,
        role: String,
        access: String,
        depends_on: Vec<String>,
        task_markdown: String,
    },
    AgentTaskAmendment {
        id: ItemId,
        orchestration_id: String,
        task_id: String,
        amendment_markdown: String,
    },
    AgentTaskResult {
        id: ItemId,
        orchestration_id: String,
        task_id: String,
        status: String,
        summary_markdown: String,
        duration_ms: u64,
    },
    ContextCompaction {
        id: ItemId,
        strategy: String,
        ordinal: u64,
        pre_context_bytes: u64,
        source_messages: u64,
        source_bytes: u64,
        source_sha256: String,
        outcome: Option<DurableActiveTurnCompactionOutcome>,
        summary: Option<DurableCompactionSummary>,
    },
    ToolCall {
        id: ItemId,
        call_id: String,
        name: String,
        arguments: serde_json::Value,
    },
    ToolValidationRejected {
        id: ItemId,
        call_id: String,
        name: String,
        kind: String,
        arguments_bytes: u64,
        arguments_sha256: String,
        edit_index: Option<u32>,
        hunk_index: Option<u32>,
        line: Option<u32>,
        expected_summary: Option<String>,
        actual_summary: Option<String>,
        suggested_action: String,
    },
    FileChange {
        id: ItemId,
        call_id: String,
        path: String,
        kind: String,
        diff: String,
        before_sha256: String,
        after_sha256: String,
        before_bytes: u64,
        after_bytes: u64,
        newline_style: String,
        final_newline: bool,
    },
    CommandApprovalRequest {
        id: ItemId,
        approval_id: String,
        call_id: String,
        command: String,
        arguments: Vec<String>,
        cwd: String,
        environment_policy: String,
        sandboxed: bool,
        sandbox_policy: Option<String>,
        workspace_write_policy: Option<String>,
        workspace_write_risk: Option<String>,
        network_policy: Option<String>,
    },
    CommandApprovalDecision {
        id: ItemId,
        approval_id: String,
        decision: String,
        workspace_write_risk_acknowledgement: Option<String>,
    },
    CommandExecutionAttempt {
        id: ItemId,
        approval_id: String,
        call_id: String,
    },
    McpToolCall {
        id: ItemId,
        call_id: String,
        name: String,
        arguments: serde_json::Value,
        arguments_bytes: u64,
        arguments_sha256: String,
        inventory_sha256: String,
    },
    McpToolCallApprovalRequest {
        id: ItemId,
        approval_id: String,
        call_id: String,
        name: String,
        arguments: serde_json::Value,
        arguments_bytes: u64,
        arguments_sha256: String,
        inventory_sha256: String,
    },
    McpToolCallApprovalDecision {
        id: ItemId,
        approval_id: String,
        decision: String,
    },
    McpToolExecutionAttempt {
        id: ItemId,
        approval_id: String,
        call_id: String,
        inventory_sha256: String,
    },
    McpToolResult {
        id: ItemId,
        call_id: String,
        name: String,
        result: DurableMcpToolResult,
    },
    ToolResult {
        id: ItemId,
        call_id: String,
        name: String,
        result: DurableToolResult,
    },
}

#[derive(Clone, PartialEq, Eq)]
pub struct DurableCompactionSummary(String);

impl DurableCompactionSummary {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<String> for DurableCompactionSummary {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl std::ops::Deref for DurableCompactionSummary {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        self.as_str()
    }
}

impl fmt::Debug for DurableCompactionSummary {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DurableCompactionSummary")
            .field("bytes", &self.0.len())
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DurableActiveTurnCompactionOutcome {
    Completed {
        post_context_bytes: u64,
        summary_bytes: u64,
        summary_sha256: String,
    },
    Failed {
        kind: String,
    },
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DurableMcpToolResult {
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DurableToolResult {
    Success { content: String, bytes: u64 },
    Error { kind: String },
    Process(DurableProcessResult),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableProcessResult {
    pub stdout: String,
    pub stderr: String,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub encoding: String,
    pub duration_ms: u64,
    pub outcome: DurableProcessOutcome,
    pub sandbox_policy: Option<String>,
    pub workspace_write_policy: Option<String>,
    pub network_policy: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DurableProcessOutcome {
    ExitCode { code: i64 },
    Signal { signal: i32 },
    TimedOut,
}

pub fn terminal_turn_record_fits(thread_id: &ThreadId, turn: &DurableTurnSnapshot) -> bool {
    format::encode_turn_completed(u64::MAX, thread_id, turn)
        .is_ok_and(|bytes| bytes.len() <= MAX_ROLLOUT_RECORD_BYTES)
}

impl DurableItemSnapshot {
    pub fn id(&self) -> &ItemId {
        match self {
            Self::UserMessage { id, .. }
            | Self::AgentMessage { id, .. }
            | Self::AgentCommentary { id, .. }
            | Self::AgentTask { id, .. }
            | Self::AgentTaskAmendment { id, .. }
            | Self::AgentTaskResult { id, .. }
            | Self::ContextCompaction { id, .. }
            | Self::ToolCall { id, .. }
            | Self::ToolValidationRejected { id, .. }
            | Self::FileChange { id, .. }
            | Self::CommandApprovalRequest { id, .. }
            | Self::CommandApprovalDecision { id, .. }
            | Self::CommandExecutionAttempt { id, .. }
            | Self::McpToolCall { id, .. }
            | Self::McpToolCallApprovalRequest { id, .. }
            | Self::McpToolCallApprovalDecision { id, .. }
            | Self::McpToolExecutionAttempt { id, .. }
            | Self::McpToolResult { id, .. }
            | Self::ToolResult { id, .. } => id,
        }
    }
}

pub(crate) fn valid_incremental_item(
    existing: &[DurableItemSnapshot],
    item: &DurableItemSnapshot,
) -> Result<(), &'static str> {
    if !valid_file_change_item(item) {
        return Err("invalidFileChangeItem");
    }
    if let DurableItemSnapshot::ToolValidationRejected {
        call_id,
        name,
        kind,
        arguments_bytes,
        arguments_sha256,
        suggested_action,
        ..
    } = item
        && (call_id.is_empty()
            || name.is_empty()
            || kind.is_empty()
            || *arguments_bytes > 96 * 1024
            || !valid_sha256(arguments_sha256)
            || suggested_action.is_empty())
    {
        return Err("invalidToolValidationRejected");
    }
    if !valid_mcp_item(existing, item) {
        return Err("invalidMcpToolItem");
    }
    if let DurableItemSnapshot::CommandApprovalRequest {
        workspace_write_policy,
        workspace_write_risk,
        ..
    } = item
    {
        if !matches!(
            workspace_write_policy.as_deref(),
            None | Some("commandWorkspaceWriteV1")
        ) || !matches!(
            workspace_write_risk.as_deref(),
            None | Some("nonTransactionalWorkspaceTreeV1")
        ) || (workspace_write_policy.is_none() && workspace_write_risk.is_some())
        {
            return Err("invalidCommandApprovalRisk");
        }
        return Ok(());
    }
    if let DurableItemSnapshot::CommandApprovalDecision {
        approval_id,
        decision,
        workspace_write_risk_acknowledgement,
        ..
    } = item
    {
        if !matches!(
            workspace_write_risk_acknowledgement.as_deref(),
            None | Some("nonTransactionalWorkspaceTreeV1")
        ) {
            return Err("invalidCommandApprovalRisk");
        }
        let mut matching_risk = None;
        let mut found_request = false;
        for existing_item in existing {
            if let DurableItemSnapshot::CommandApprovalRequest {
                approval_id: existing_approval_id,
                workspace_write_risk,
                ..
            } = existing_item
                && existing_approval_id == approval_id
            {
                if found_request {
                    return Err("invalidCommandApprovalRisk");
                }
                found_request = true;
                matching_risk = workspace_write_risk.as_deref();
            }
        }
        if !found_request
            || (decision == "approved"
                && workspace_write_risk_acknowledgement.as_deref() != matching_risk)
            || (decision != "approved" && workspace_write_risk_acknowledgement.is_some())
        {
            return Err("invalidCommandApprovalRisk");
        }
        return Ok(());
    }
    let DurableItemSnapshot::CommandExecutionAttempt {
        approval_id,
        call_id,
        ..
    } = item
    else {
        return Ok(());
    };
    let mut matching_call = None;
    let mut matching_request = None;
    let mut matching_decision = None;
    for existing_item in existing {
        match existing_item {
            DurableItemSnapshot::ToolCall {
                call_id: existing_call_id,
                name,
                arguments,
                ..
            } if existing_call_id == call_id && name == "shell/exec" => {
                if matching_call.is_some() {
                    return Err("invalidCommandExecutionAttempt");
                }
                matching_call = Some(arguments);
            }
            DurableItemSnapshot::CommandApprovalRequest {
                approval_id: existing_approval_id,
                call_id: existing_call_id,
                command,
                arguments,
                cwd,
                environment_policy,
                sandboxed,
                sandbox_policy,
                workspace_write_policy,
                workspace_write_risk,
                network_policy,
                ..
            } if existing_approval_id == approval_id && existing_call_id == call_id => {
                if matching_request.is_some() {
                    return Err("invalidCommandExecutionAttempt");
                }
                matching_request = Some((
                    command,
                    arguments,
                    cwd,
                    environment_policy,
                    sandboxed,
                    sandbox_policy,
                    workspace_write_policy,
                    workspace_write_risk,
                    network_policy,
                ));
            }
            DurableItemSnapshot::CommandApprovalDecision {
                approval_id: existing_approval_id,
                decision,
                workspace_write_risk_acknowledgement,
                ..
            } if existing_approval_id == approval_id => {
                if matching_decision.is_some() {
                    return Err("invalidCommandExecutionAttempt");
                }
                matching_decision = Some((decision, workspace_write_risk_acknowledgement));
            }
            DurableItemSnapshot::CommandExecutionAttempt {
                approval_id: existing_approval_id,
                call_id: existing_call_id,
                ..
            } if existing_approval_id == approval_id || existing_call_id == call_id => {
                return Err("invalidCommandExecutionAttempt");
            }
            DurableItemSnapshot::ToolResult {
                call_id: existing_call_id,
                ..
            } if existing_call_id == call_id => {
                return Err("invalidCommandExecutionAttempt");
            }
            _ => {}
        }
    }
    let Some(call_arguments) = matching_call else {
        return Err("invalidCommandExecutionAttempt");
    };
    let Some((
        request_command,
        request_arguments,
        cwd,
        environment_policy,
        sandboxed,
        sandbox_policy,
        workspace_write_policy,
        workspace_write_risk,
        network_policy,
    )) = matching_request
    else {
        return Err("invalidCommandExecutionAttempt");
    };
    let call_command = call_arguments
        .get("command")
        .and_then(serde_json::Value::as_str);
    let call_argv = call_arguments
        .get("arguments")
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect::<Vec<_>>()
        });
    let call_cwd = call_arguments
        .get("cwd")
        .and_then(serde_json::Value::as_str);
    if call_command != Some(request_command.as_str())
        || call_argv.as_deref()
            != Some(
                request_arguments
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>()
                    .as_slice(),
            )
        || call_cwd != Some(cwd.as_str())
        || environment_policy != "minimalV1"
        || !sandboxed
        || sandbox_policy.as_deref() != Some("filesystemReadOnlyV1")
        || !matches!(
            workspace_write_policy.as_deref(),
            None | Some("commandWorkspaceWriteV1")
        )
        || network_policy.as_deref() != Some("networkDeniedV1")
        || matching_decision.is_none_or(|(decision, acknowledgement)| {
            decision != "approved" || acknowledgement != workspace_write_risk
        })
    {
        return Err("invalidCommandExecutionAttempt");
    }
    Ok(())
}

fn valid_mcp_item(existing: &[DurableItemSnapshot], item: &DurableItemSnapshot) -> bool {
    match item {
        DurableItemSnapshot::McpToolCall {
            call_id,
            name,
            arguments,
            arguments_bytes,
            arguments_sha256,
            inventory_sha256,
            ..
        } => {
            let Ok(bytes) = serde_json::to_vec(arguments) else {
                return false;
            };
            let prior_calls = existing
                .iter()
                .filter_map(|item| match item {
                    DurableItemSnapshot::McpToolCall {
                        call_id,
                        name,
                        inventory_sha256,
                        ..
                    } => Some((call_id, name, inventory_sha256)),
                    _ => None,
                })
                .collect::<Vec<_>>();
            let Some(server_id) = mcp_server_id(name) else {
                return false;
            };
            arguments.is_object()
                && !call_id.is_empty()
                && call_id.len() <= 128
                && name.len() <= 128
                && bytes.len() <= 32 * 1024
                && *arguments_bytes == u64::try_from(bytes.len()).unwrap_or(u64::MAX)
                && arguments_sha256 == &sha256_bytes(&bytes)
                && valid_sha256(inventory_sha256)
                && prior_calls
                    .iter()
                    .filter(|(_, prior_name, _)| mcp_server_id(prior_name) == Some(server_id))
                    .all(|(_, _, prior_inventory)| *prior_inventory == inventory_sha256)
                && prior_calls
                    .iter()
                    .all(|(prior_call_id, _, _)| *prior_call_id != call_id)
        }
        DurableItemSnapshot::McpToolCallApprovalRequest {
            approval_id,
            call_id,
            name,
            arguments,
            arguments_bytes,
            arguments_sha256,
            inventory_sha256,
            ..
        } => {
            !approval_id.is_empty()
                && existing.iter().any(|item| {
                    matches!(
                        item,
                        DurableItemSnapshot::McpToolCall {
                            call_id: existing_call_id,
                            name: existing_name,
                            arguments: existing_arguments,
                            arguments_bytes: existing_arguments_bytes,
                            arguments_sha256: existing_arguments_sha256,
                            inventory_sha256: existing_inventory_sha256,
                            ..
                        } if existing_call_id == call_id
                            && existing_name == name
                            && existing_arguments == arguments
                            && existing_arguments_bytes == arguments_bytes
                            && existing_arguments_sha256 == arguments_sha256
                            && existing_inventory_sha256 == inventory_sha256
                    )
                })
                && !existing.iter().any(|item| {
                    matches!(
                        item,
                        DurableItemSnapshot::McpToolCallApprovalRequest {
                            approval_id: existing_approval_id,
                            call_id: existing_call_id,
                            ..
                        } if existing_approval_id == approval_id || existing_call_id == call_id
                    )
                })
                && !existing.iter().any(|item| {
                    matches!(
                        item,
                        DurableItemSnapshot::McpToolResult {
                            call_id: existing_call_id,
                            ..
                        } if existing_call_id == call_id
                    )
                })
        }
        DurableItemSnapshot::McpToolCallApprovalDecision {
            approval_id,
            decision,
            ..
        } => {
            matches!(
                decision.as_str(),
                "approved"
                    | "denied"
                    | "timedOut"
                    | "unsupported"
                    | "cancelled"
                    | "clientDisconnected"
            ) && existing.iter().any(|item| {
                matches!(
                    item,
                    DurableItemSnapshot::McpToolCallApprovalRequest {
                        approval_id: existing_approval_id,
                        ..
                    } if existing_approval_id == approval_id
                )
            }) && !existing.iter().any(|item| {
                matches!(
                    item,
                    DurableItemSnapshot::McpToolCallApprovalDecision {
                        approval_id: existing_approval_id,
                        ..
                    } if existing_approval_id == approval_id
                )
            }) && !existing.iter().any(|item| {
                matches!(
                    item,
                    DurableItemSnapshot::McpToolResult {
                        call_id,
                        ..
                    } if existing.iter().any(|candidate| {
                        matches!(
                            candidate,
                            DurableItemSnapshot::McpToolCallApprovalRequest {
                                approval_id: existing_approval_id,
                                call_id: existing_call_id,
                                ..
                            } if existing_approval_id == approval_id && existing_call_id == call_id
                        )
                    })
                )
            })
        }
        DurableItemSnapshot::McpToolExecutionAttempt {
            approval_id,
            call_id,
            inventory_sha256,
            ..
        } => {
            let approved = existing.iter().any(|item| {
                matches!(
                    item,
                    DurableItemSnapshot::McpToolCallApprovalDecision {
                        approval_id: existing_approval_id,
                        decision,
                        ..
                    } if existing_approval_id == approval_id && decision == "approved"
                )
            });
            let request = existing.iter().any(|item| {
                matches!(
                    item,
                    DurableItemSnapshot::McpToolCallApprovalRequest {
                        approval_id: existing_approval_id,
                        call_id: existing_call_id,
                        inventory_sha256: existing_inventory_sha256,
                        ..
                    } if existing_approval_id == approval_id
                        && existing_call_id == call_id
                        && existing_inventory_sha256 == inventory_sha256
                )
            });
            approved
                && request
                && !existing.iter().any(|item| {
                    matches!(
                        item,
                        DurableItemSnapshot::McpToolExecutionAttempt {
                            approval_id: existing_approval_id,
                            call_id: existing_call_id,
                            ..
                        } if existing_approval_id == approval_id || existing_call_id == call_id
                    )
                })
        }
        DurableItemSnapshot::McpToolResult {
            call_id,
            name,
            result,
            ..
        } => {
            let call = existing.iter().any(|item| {
                matches!(
                    item,
                    DurableItemSnapshot::McpToolCall {
                        call_id: existing_call_id,
                        name: existing_name,
                        ..
                    } if existing_call_id == call_id && existing_name == name
                )
            });
            let attempt = existing.iter().any(|item| {
                matches!(
                    item,
                    DurableItemSnapshot::McpToolExecutionAttempt {
                        call_id: existing_call_id,
                        ..
                    } if existing_call_id == call_id
                )
            });
            let no_prior_result = !existing.iter().any(|item| {
                matches!(
                    item,
                    DurableItemSnapshot::McpToolResult {
                        call_id: existing_call_id,
                        ..
                    } if existing_call_id == call_id
                )
            });
            let result_valid = match result {
                DurableMcpToolResult::Completed {
                    content,
                    observed_bytes,
                    canonical_bytes,
                    retained_bytes,
                    truncated,
                    sha256,
                    ..
                } => {
                    attempt
                        && *retained_bytes == u64::try_from(content.len()).unwrap_or(u64::MAX)
                        && valid_sha256(sha256)
                        && *observed_bytes > 0
                        && if *truncated {
                            *canonical_bytes > *retained_bytes
                        } else {
                            *canonical_bytes == *retained_bytes
                        }
                }
                DurableMcpToolResult::Error {
                    kind,
                    request_state,
                } => {
                    !kind.is_empty()
                        && kind.len() <= 64
                        && matches!(
                            request_state.as_str(),
                            "notSent" | "mayHaveStarted" | "responded"
                        )
                        && (request_state == "notSent" || attempt)
                }
            };
            call && no_prior_result && result_valid
        }
        _ => true,
    }
}

fn mcp_server_id(name: &str) -> Option<&str> {
    let identity = name.strip_prefix("mcp__")?;
    let (server_id, raw_name) = identity.split_once("__")?;
    let server_bytes = server_id.as_bytes();
    let valid_server = !server_bytes.is_empty()
        && server_bytes.len() <= 32
        && server_bytes[0].is_ascii_lowercase()
        && (server_bytes[server_bytes.len() - 1].is_ascii_lowercase()
            || server_bytes[server_bytes.len() - 1].is_ascii_digit())
        && server_bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-');
    let valid_tool = !raw_name.is_empty()
        && raw_name.len() <= 64
        && raw_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'));
    (valid_server && valid_tool).then_some(server_id)
}

fn sha256_bytes(bytes: &[u8]) -> String {
    use sha2::Digest;
    format!("{:x}", sha2::Sha256::digest(bytes))
}

pub(crate) fn valid_turn_items(items: &[DurableItemSnapshot]) -> bool {
    items
        .iter()
        .enumerate()
        .all(|(index, item)| valid_incremental_item(&items[..index], item).is_ok())
}

pub(crate) fn valid_workspace_instructions_audit(
    audit: Option<&DurableWorkspaceInstructionsAudit>,
) -> bool {
    let Some(audit) = audit else {
        return true;
    };
    match audit.source {
        DurableWorkspaceInstructionsSource::RootAgentsMdV1 => match audit.status {
            DurableWorkspaceInstructionsStatus::Absent => {
                audit.bytes.is_none() && audit.sha256.is_none()
            }
            DurableWorkspaceInstructionsStatus::Present => {
                audit.bytes.is_some_and(|bytes| bytes <= 32 * 1024)
                    && audit.sha256.as_deref().is_some_and(valid_sha256)
            }
        },
        DurableWorkspaceInstructionsSource::RootToActiveScopeAgentsMdV1 => {
            let status_is_valid = match audit.status {
                DurableWorkspaceInstructionsStatus::Absent => audit.bytes.is_none(),
                DurableWorkspaceInstructionsStatus::Present => {
                    audit.bytes.is_some_and(|bytes| bytes <= 32 * 1024)
                }
            };
            status_is_valid && audit.sha256.as_deref().is_some_and(valid_sha256)
        }
    }
}

pub(crate) fn valid_workspace_skills_audit(audit: Option<&DurableWorkspaceSkillsAudit>) -> bool {
    let Some(audit) = audit else {
        return true;
    };
    if audit.source != DurableWorkspaceSkillsSource::RootToActiveScopeAgentsSkillsV1
        || audit.discovered_count > 64
        || audit.effective_count > audit.discovered_count
        || audit.selected_count > audit.effective_count
        || audit.selected_count > 4
        || audit.source_bytes > 1024 * 1024
        || audit.inventory_bytes > 96 * 1024
        || audit.selected_bytes > 128 * 1024
        || !valid_sha256(&audit.manifest_sha256)
    {
        return false;
    }
    let status_is_valid = match audit.status {
        DurableWorkspaceSkillsStatus::Absent => {
            audit.discovered_count == 0
                && audit.effective_count == 0
                && audit.source_bytes == 0
                && audit.inventory_bytes == 0
                && audit.selected_count == 0
                && audit.selected_bytes == 0
        }
        DurableWorkspaceSkillsStatus::Present => {
            audit.discovered_count > 0
                && audit.effective_count > 0
                && audit.source_bytes > 0
                && audit.inventory_bytes > 0
        }
    };
    let selection_is_valid = if audit.selected_count == 0 {
        audit.selected_bytes == 0 && audit.selection_sha256.is_none()
    } else {
        audit.selected_bytes > 0 && audit.selection_sha256.as_deref().is_some_and(valid_sha256)
    };
    status_is_valid && selection_is_valid
}

pub(crate) fn valid_file_change_item(item: &DurableItemSnapshot) -> bool {
    match item {
        DurableItemSnapshot::ToolCall {
            name, arguments, ..
        } => {
            if !matches!(name.as_str(), "workspace/edit" | "workspace/apply-diff") {
                return true;
            }
            let Some(path) = arguments.get("path").and_then(serde_json::Value::as_str) else {
                return false;
            };
            let has_write = match name.as_str() {
                "workspace/edit" => arguments
                    .get("edits")
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|edits| !edits.is_empty()),
                "workspace/apply-diff" => arguments
                    .get("diff")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|diff| !diff.is_empty()),
                _ => false,
            };
            valid_patch_path(path)
                && has_write
                && serde_json::to_vec(arguments).is_ok_and(|encoded| encoded.len() <= 96 * 1024)
        }
        DurableItemSnapshot::FileChange {
            path,
            kind,
            diff,
            before_sha256,
            after_sha256,
            before_bytes,
            after_bytes,
            newline_style,
            ..
        } => {
            kind == "update"
                && matches!(newline_style.as_str(), "lf" | "crLf")
                && valid_patch_path(path)
                && valid_sha256(before_sha256)
                && valid_sha256(after_sha256)
                && *before_bytes <= 256 * 1024
                && *after_bytes <= 256 * 1024
                && !diff.is_empty()
                && diff.len() <= 192 * 1024
                && diff.lines().count() <= 5_000
                && diff.starts_with(&format!("--- a/{path}\n+++ b/{path}\n"))
        }
        _ => true,
    }
}

fn valid_patch_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1_024
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && !path.chars().any(char::is_control)
        && !path
            .split(['/', '\\'])
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

pub trait ThreadRepository: fmt::Debug + Send {
    fn id_sequences(&self) -> IdSequences;
    fn create_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError>;
    fn create_thread_with_origin(
        &mut self,
        thread_id: &ThreadId,
        _origin: &DurableThreadOrigin,
    ) -> Result<(), RolloutError> {
        self.create_thread(thread_id)
    }
    fn create_thread_snapshot(
        &mut self,
        snapshot: &DurableThreadSnapshot,
    ) -> Result<(), RolloutError>;
    fn append_completed_turn(
        &mut self,
        thread_id: &ThreadId,
        turn: &DurableTurnSnapshot,
    ) -> Result<(), RolloutError>;
    fn begin_turn(
        &mut self,
        _thread_id: &ThreadId,
        _turn: &DurableTurnSnapshot,
    ) -> Result<(), RolloutError> {
        Err(RolloutError::InvalidRecord {
            kind: "asynchronousTurnsUnsupported",
        })
    }
    fn finish_turn(
        &mut self,
        thread_id: &ThreadId,
        turn: &DurableTurnSnapshot,
    ) -> Result<(), RolloutError> {
        self.append_completed_turn(thread_id, turn)
    }
    fn append_turn_item(
        &mut self,
        _thread_id: &ThreadId,
        _turn_id: &TurnId,
        _item: &DurableItemSnapshot,
    ) -> Result<(), RolloutError> {
        Err(RolloutError::InvalidRecord {
            kind: "incrementalItemsUnsupported",
        })
    }
    fn complete_turn_item(
        &mut self,
        _thread_id: &ThreadId,
        _turn_id: &TurnId,
        _item: &DurableItemSnapshot,
    ) -> Result<(), RolloutError> {
        Err(RolloutError::InvalidRecord {
            kind: "incrementalItemsUnsupported",
        })
    }
    fn archive_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError>;
    fn unarchive_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError>;
    fn delete_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError>;
    fn load_thread(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Option<DurableThreadSnapshot>, RolloutError>;
    fn list_descendants(
        &self,
        _parent_thread_id: &ThreadId,
    ) -> Result<Vec<DurableThreadSnapshot>, RolloutError> {
        Err(RolloutError::InvalidRecord {
            kind: "descendantsUnsupported",
        })
    }
    fn list_threads(
        &mut self,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, RolloutError>;
    fn search_threads(
        &mut self,
        query: &str,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, RolloutError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RolloutDiagnostic {
    pub path: PathBuf,
    pub offset: u64,
    pub kind: &'static str,
}

impl fmt::Display for RolloutDiagnostic {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}: rollout {} at byte {}",
            self.path.display(),
            self.kind,
            self.offset
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectionDiagnostic {
    pub path: PathBuf,
    pub operation: &'static str,
    pub kind: &'static str,
}

impl fmt::Display for ProjectionDiagnostic {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let projection = self
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| name.contains("thread-search"))
            .map_or("thread discovery", |_| "thread search");
        write!(
            formatter,
            "{}: {projection} {} ({})",
            self.path.display(),
            self.operation,
            self.kind
        )
    }
}

#[derive(Debug)]
pub enum RolloutError {
    Busy {
        path: PathBuf,
    },
    Unavailable {
        path: PathBuf,
        kind: std::io::ErrorKind,
    },
    Corrupt(RolloutDiagnostic),
    LimitExceeded {
        path: PathBuf,
        kind: &'static str,
    },
    InvalidId {
        kind: &'static str,
    },
    InvalidRecord {
        kind: &'static str,
    },
    Collision {
        kind: &'static str,
    },
    Projection(ProjectionDiagnostic),
    Poisoned,
}

impl fmt::Display for RolloutError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Busy { path } => write!(formatter, "{}: rollout writer is busy", path.display()),
            Self::Unavailable { path, kind } => {
                write!(
                    formatter,
                    "{}: rollout state is unavailable ({kind:?})",
                    path.display()
                )
            }
            Self::Corrupt(diagnostic) => diagnostic.fmt(formatter),
            Self::LimitExceeded { path, kind } => {
                write!(
                    formatter,
                    "{}: rollout limit exceeded ({kind})",
                    path.display()
                )
            }
            Self::InvalidId { kind } => write!(formatter, "invalid {kind} ID"),
            Self::InvalidRecord { kind } => write!(formatter, "invalid rollout record ({kind})"),
            Self::Collision { kind } => write!(formatter, "duplicate {kind} ID"),
            Self::Projection(diagnostic) => diagnostic.fmt(formatter),
            Self::Poisoned => formatter.write_str("rollout state is unavailable"),
        }
    }
}

impl Error for RolloutError {}
