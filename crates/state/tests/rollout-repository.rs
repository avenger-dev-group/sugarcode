use serde_json::json;
use std::fs;
use std::io::Write;
use sugarcode_protocol::ItemId;
use sugarcode_protocol::ThreadId;
use sugarcode_protocol::TurnId;
use sugarcode_state::DurableItemSnapshot;
use sugarcode_state::DurableMcpToolResult;
use sugarcode_state::DurableProcessOutcome;
use sugarcode_state::DurableProcessResult;
use sugarcode_state::DurableThreadLifecycle;
use sugarcode_state::DurableThreadOrigin;
use sugarcode_state::DurableThreadSnapshot;
use sugarcode_state::DurableToolResult;
use sugarcode_state::DurableTurnSnapshot;
use sugarcode_state::DurableTurnStatus;
use sugarcode_state::DurableWorkspaceInstructionsAudit;
use sugarcode_state::DurableWorkspaceInstructionsSource;
use sugarcode_state::DurableWorkspaceInstructionsStatus;
use sugarcode_state::DurableWorkspaceSkillsAudit;
use sugarcode_state::DurableWorkspaceSkillsSource;
use sugarcode_state::DurableWorkspaceSkillsStatus;
use sugarcode_state::HomeResolutionInputs;
use sugarcode_state::RolloutError;
use sugarcode_state::RolloutRepository;
use sugarcode_state::ThreadRepository;
use sugarcode_state::resolve_sugarcode_home;
use tempfile::tempdir;

fn completed_turn(sequence: u64) -> DurableTurnSnapshot {
    DurableTurnSnapshot {
        model: None,
        id: TurnId::new(format!("turn_{sequence:016}")),
        status: DurableTurnStatus::Completed,
        items: vec![DurableItemSnapshot::AgentMessage {
            id: ItemId::new(format!("item_{sequence:016}")),
            text: "SugarCode deterministic response.".to_string(),
        }],
        context_compaction: None,
        workspace_instructions: None,
        workspace_skills: None,
        error: None,
        usage: None,
    }
}

fn started_text_turn() -> DurableTurnSnapshot {
    DurableTurnSnapshot {
        model: None,
        id: TurnId::new("turn_0000000000000001"),
        status: DurableTurnStatus::InProgress,
        items: vec![
            DurableItemSnapshot::UserMessage {
                id: ItemId::new("item_0000000000000001"),
                content: vec![sugarcode_state::DurableUserContentPart::Text {
                    text: "Hello".to_string(),
                }],
            },
            DurableItemSnapshot::AgentMessage {
                id: ItemId::new("item_0000000000000002"),
                text: String::new(),
            },
        ],
        context_compaction: None,
        workspace_instructions: None,
        workspace_skills: None,
        error: None,
        usage: None,
    }
}

fn resolved_temp_home(directory: &tempfile::TempDir) -> sugarcode_state::SugarCodeHome {
    resolve_sugarcode_home(HomeResolutionInputs {
        cli_override: Some(directory.path().to_path_buf()),
        ..Default::default()
    })
    .expect("resolve home")
}

#[path = "rollout_repository/corruption.rs"]
mod corruption;
#[path = "rollout_repository/fork.rs"]
mod fork;
#[path = "rollout_repository/lifecycle.rs"]
mod lifecycle;
#[path = "rollout_repository/mcp.rs"]
mod mcp;
#[path = "rollout_repository/projections.rs"]
mod projections;
#[path = "rollout_repository/turns.rs"]
mod turns;
#[path = "rollout_repository/workspace_binding.rs"]
mod workspace_binding;
