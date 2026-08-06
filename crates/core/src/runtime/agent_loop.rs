use super::*;
use std::collections::BTreeSet;

pub(super) const MAX_CONSECUTIVE_APPROVAL_DENIALS: u8 = 3;
pub(super) const MAX_CONSECUTIVE_TOOL_ARGUMENT_ERRORS: u8 = 3;
pub(super) const MAX_CONSECUTIVE_TOOL_EXECUTION_ERRORS: u8 = 3;
pub(super) const MAX_TOTAL_NON_PROGRESS_ROUNDS: u8 = 4;
pub(super) const MAX_TOOL_ARGUMENT_RECOVERY_FINAL_REJECTIONS: u8 = 1;

#[derive(Debug, Default)]
pub(super) struct AgentLoopState {
    call_ids: BTreeSet<String>,
    consecutive_approval_denials: u8,
    last_tool_validation_signature: Option<String>,
    consecutive_tool_argument_errors: u8,
    pending_tool_argument_correction: bool,
    last_tool_execution_signature: Option<String>,
    consecutive_tool_execution_errors: u8,
    total_non_progress_rounds: u8,
    tool_argument_recovery_final_rejections: u8,
}

impl AgentLoopState {
    pub(super) fn tools_for_round(
        &self,
        runtime: &CoreRuntime,
        thread_id: &ThreadId,
    ) -> Vec<ModelToolDefinition> {
        let mut tools = workspace_tool_definitions(runtime);
        if runtime.collaboration.is_child_thread(thread_id) {
            if runtime.collaboration.access_for_child(thread_id) == Some(AgentAccess::ReadOnly) {
                tools.retain(|tool| {
                    matches!(
                        tool.name.as_str(),
                        "workspace/read" | "workspace/list" | "workspace/search"
                    )
                });
            }
        } else {
            tools.extend(runtime.collaboration.tool_definitions());
        }
        tools
    }

    pub(super) fn observe_call(&mut self, call: &ModelToolCall) -> bool {
        if !self.call_ids.insert(call.id.clone()) {
            return false;
        }
        true
    }

    pub(super) fn record_approval_denied(&mut self) -> bool {
        self.consecutive_approval_denials = self.consecutive_approval_denials.saturating_add(1);
        self.consecutive_approval_denials >= MAX_CONSECUTIVE_APPROVAL_DENIALS
            || self.record_non_progress()
    }

    pub(super) fn reset_approval_denials(&mut self) {
        self.consecutive_approval_denials = 0;
    }

    pub(super) fn record_tool_argument_error(&mut self, signature: String) -> bool {
        if self.last_tool_validation_signature.as_deref() == Some(&signature) {
            self.consecutive_tool_argument_errors =
                self.consecutive_tool_argument_errors.saturating_add(1);
        } else {
            self.last_tool_validation_signature = Some(signature);
            self.consecutive_tool_argument_errors = 1;
        }
        self.consecutive_tool_argument_errors >= MAX_CONSECUTIVE_TOOL_ARGUMENT_ERRORS
            || self.record_non_progress()
    }

    pub(super) fn require_tool_argument_correction(&mut self) {
        self.pending_tool_argument_correction = true;
    }

    pub(super) fn record_valid_tool_arguments(&mut self, calls: &[ModelToolCall]) {
        if !calls.is_empty() {
            self.pending_tool_argument_correction = false;
            self.tool_argument_recovery_final_rejections = 0;
        }
        self.last_tool_validation_signature = None;
        self.consecutive_tool_argument_errors = 0;
    }

    pub(super) fn needs_tool_argument_recovery(&self) -> bool {
        self.pending_tool_argument_correction
    }

    pub(super) fn record_tool_argument_recovery_final(&mut self) -> bool {
        self.tool_argument_recovery_final_rejections = self
            .tool_argument_recovery_final_rejections
            .saturating_add(1);
        self.tool_argument_recovery_final_rejections > MAX_TOOL_ARGUMENT_RECOVERY_FINAL_REJECTIONS
            || self.record_non_progress()
    }

    pub(super) fn record_tool_execution_error(&mut self, signature: String) -> bool {
        if self.last_tool_execution_signature.as_deref() == Some(&signature) {
            self.consecutive_tool_execution_errors =
                self.consecutive_tool_execution_errors.saturating_add(1);
        } else {
            self.last_tool_execution_signature = Some(signature);
            self.consecutive_tool_execution_errors = 1;
        }
        self.consecutive_tool_execution_errors >= MAX_CONSECUTIVE_TOOL_EXECUTION_ERRORS
            || self.record_non_progress()
    }

    pub(super) fn reset_tool_execution_errors(&mut self) {
        self.last_tool_execution_signature = None;
        self.consecutive_tool_execution_errors = 0;
    }

    pub(super) fn record_progress(&mut self) {
        self.total_non_progress_rounds = 0;
    }

    fn record_non_progress(&mut self) -> bool {
        self.total_non_progress_rounds = self.total_non_progress_rounds.saturating_add(1);
        self.total_non_progress_rounds >= MAX_TOTAL_NON_PROGRESS_ROUNDS
    }
}
