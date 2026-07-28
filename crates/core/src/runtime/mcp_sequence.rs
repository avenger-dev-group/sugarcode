use super::*;
use std::collections::BTreeSet;

pub(super) const MAX_MCP_TOOL_CALLS_PER_TURN: usize = 4;
pub(super) const MAX_PROVIDER_ROUNDS: u8 = 5;
pub(super) const MCP_RESULT_RECEIPT_RESERVE_BYTES: usize = 2 * 1024;

#[derive(Debug, Default)]
pub(super) struct McpSequence {
    active: bool,
    can_continue: bool,
    call_ids: BTreeSet<String>,
}

impl McpSequence {
    pub(super) fn tools_for_round(
        &self,
        runtime: &CoreRuntime,
        round: u8,
    ) -> Vec<ModelToolDefinition> {
        if round == 0 {
            workspace_tool_definitions(runtime)
        } else if self.active
            && self.can_continue
            && self.call_ids.len() < MAX_MCP_TOOL_CALLS_PER_TURN
        {
            mcp_tool_definitions(runtime)
        } else {
            Vec::new()
        }
    }

    pub(super) fn observe_call(&mut self, round: u8, call: &ModelToolCall) -> bool {
        if !call.name.starts_with("mcp__") {
            return round == 0 && !self.active && self.call_ids.is_empty();
        }
        if round > 0
            && (!self.active
                || !self.can_continue
                || self.call_ids.len() >= MAX_MCP_TOOL_CALLS_PER_TURN)
        {
            return false;
        }
        if !self.call_ids.insert(call.id.clone()) {
            return false;
        }
        self.active = true;
        self.can_continue = false;
        true
    }

    pub(super) fn record_result(&mut self, completed: bool) {
        self.can_continue = completed;
    }
}
