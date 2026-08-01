use super::*;
use std::collections::BTreeSet;

pub(super) const MAX_CONSECUTIVE_APPROVAL_DENIALS: u8 = 3;
pub(super) const MAX_CONSECUTIVE_TOOL_ARGUMENT_ERRORS: u8 = 3;

#[derive(Debug, Default)]
pub(super) struct AgentLoopState {
    call_ids: BTreeSet<String>,
    consecutive_approval_denials: u8,
    last_tool_error_fingerprint: Option<String>,
    consecutive_tool_argument_errors: u8,
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
    }

    pub(super) fn reset_approval_denials(&mut self) {
        self.consecutive_approval_denials = 0;
    }

    pub(super) fn record_tool_argument_error(&mut self, fingerprint: String) -> bool {
        if self.last_tool_error_fingerprint.as_deref() == Some(&fingerprint) {
            self.consecutive_tool_argument_errors =
                self.consecutive_tool_argument_errors.saturating_add(1);
        } else {
            self.last_tool_error_fingerprint = Some(fingerprint);
            self.consecutive_tool_argument_errors = 1;
        }
        self.consecutive_tool_argument_errors >= MAX_CONSECUTIVE_TOOL_ARGUMENT_ERRORS
    }

    pub(super) fn reset_tool_argument_errors(&mut self) {
        self.last_tool_error_fingerprint = None;
        self.consecutive_tool_argument_errors = 0;
    }
}
