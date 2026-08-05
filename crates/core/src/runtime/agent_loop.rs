use super::*;
use std::collections::BTreeSet;

pub(super) const MAX_CONSECUTIVE_APPROVAL_DENIALS: u8 = 3;
pub(super) const MAX_CONSECUTIVE_TOOL_ARGUMENT_ERRORS: u8 = 3;
pub(super) const MAX_CONSECUTIVE_TOOL_EXECUTION_ERRORS: u8 = 3;
pub(super) const MAX_TOTAL_NON_PROGRESS_ROUNDS: u8 = 4;
pub(super) const MAX_PREMATURE_FINAL_RECOVERIES: u8 = 1;

#[derive(Debug, Default)]
pub(super) struct AgentLoopState {
    call_ids: BTreeSet<String>,
    consecutive_approval_denials: u8,
    last_tool_validation_signature: Option<String>,
    consecutive_tool_argument_errors: u8,
    last_tool_execution_signature: Option<String>,
    consecutive_tool_execution_errors: u8,
    total_non_progress_rounds: u8,
    premature_final_recoveries: u8,
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

    pub(super) fn has_observed_tool_calls(&self) -> bool {
        !self.call_ids.is_empty()
    }

    pub(super) fn needs_completion_recovery(&self) -> bool {
        self.premature_final_recoveries > 0
    }

    pub(super) fn record_premature_final(&mut self) -> bool {
        self.premature_final_recoveries = self.premature_final_recoveries.saturating_add(1);
        self.premature_final_recoveries > MAX_PREMATURE_FINAL_RECOVERIES
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
        self.last_tool_validation_signature = Some(signature);
        self.consecutive_tool_argument_errors =
            self.consecutive_tool_argument_errors.saturating_add(1);
        self.consecutive_tool_argument_errors >= MAX_CONSECUTIVE_TOOL_ARGUMENT_ERRORS
            || self.record_non_progress()
    }

    pub(super) fn reset_tool_argument_errors(&mut self) {
        self.last_tool_validation_signature = None;
        self.consecutive_tool_argument_errors = 0;
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

    fn record_non_progress(&mut self) -> bool {
        self.total_non_progress_rounds = self.total_non_progress_rounds.saturating_add(1);
        self.total_non_progress_rounds >= MAX_TOTAL_NON_PROGRESS_ROUNDS
    }
}

pub(super) fn looks_like_unfinished_process_update(text: &str) -> bool {
    const MAX_CANDIDATE_BYTES: usize = 1_024;
    const CONTINUATION_CUES: &[&str] = &[
        "i will",
        "i'll ",
        "let me ",
        "now start",
        "now begin",
        "现在开始",
        "現在開始",
        "接下来",
        "接下來",
        "下一步",
        "将开始",
        "將開始",
    ];

    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_CANDIDATE_BYTES {
        return false;
    }
    let lowered = trimmed.to_lowercase();
    if !CONTINUATION_CUES.iter().any(|cue| lowered.contains(cue)) {
        return false;
    }
    let Some(last_line) = trimmed
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
    else {
        return false;
    };
    last_line.starts_with('#')
        || (last_line.len() > 4 && last_line.starts_with("**") && last_line.ends_with("**"))
}
