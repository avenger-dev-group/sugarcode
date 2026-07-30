use super::*;
use std::collections::BTreeSet;

pub(super) const MAX_MCP_TOOL_CALLS_PER_TURN: usize = 4;
pub(super) const MAX_CONSECUTIVE_APPROVAL_DENIALS: u8 = 3;

#[derive(Debug, Default)]
pub(super) struct AgentLoopState {
    call_ids: BTreeSet<String>,
    mcp_calls: usize,
    consecutive_approval_denials: u8,
}

impl AgentLoopState {
    pub(super) fn tools_for_round(&self, runtime: &CoreRuntime) -> Vec<ModelToolDefinition> {
        let mut tools = workspace_tool_definitions(runtime);
        if self.mcp_calls >= MAX_MCP_TOOL_CALLS_PER_TURN {
            tools.retain(|tool| !tool.name.starts_with("mcp__"));
        }
        tools
    }

    pub(super) fn observe_call(&mut self, call: &ModelToolCall) -> bool {
        if !self.call_ids.insert(call.id.clone()) {
            return false;
        }
        if call.name.starts_with("mcp__") {
            if self.mcp_calls >= MAX_MCP_TOOL_CALLS_PER_TURN {
                return false;
            }
            self.mcp_calls += 1;
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
}
