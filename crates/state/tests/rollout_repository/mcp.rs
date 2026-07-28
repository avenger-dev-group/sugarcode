use super::*;
use sha2::{Digest, Sha256};

#[test]
fn approved_attempt_without_result_recovers_once_as_interrupted_and_preserves_audit() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    let items = approved_attempt_items();
    {
        let mut repository = RolloutRepository::open(&home).expect("repository");
        repository.create_thread(&thread_id).expect("thread");
        begin_mcp_turn(&mut repository, &thread_id);
        for item in &items[1..] {
            repository
                .append_turn_item(&thread_id, &TurnId::new("turn_0000000000000001"), item)
                .expect("MCP audit item");
        }
    }

    let repository = RolloutRepository::open(&home).expect("recover");
    let snapshot = repository
        .load_thread(&thread_id)
        .expect("load")
        .expect("thread");
    assert_eq!(snapshot.turns[0].status, DurableTurnStatus::Interrupted);
    assert_eq!(snapshot.turns[0].items, items);
    assert!(
        !snapshot.turns[0]
            .items
            .iter()
            .any(|item| matches!(item, DurableItemSnapshot::McpToolResult { .. }))
    );
    assert!(
        repository
            .diagnostics()
            .iter()
            .any(|diagnostic| diagnostic.kind == "danglingTurnRecovered")
    );
    drop(repository);

    let reopened = RolloutRepository::open(&home).expect("stable recovery");
    assert!(
        !reopened
            .diagnostics()
            .iter()
            .any(|diagnostic| diagnostic.kind == "danglingTurnRecovered")
    );
}

#[test]
fn denied_call_cannot_cross_attempt_barrier_and_terminal_equality_is_exact() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    let mut repository = RolloutRepository::open(&home).expect("repository");
    repository.create_thread(&thread_id).expect("thread");
    begin_mcp_turn(&mut repository, &thread_id);
    let mut items = approved_attempt_items();
    items[3] = DurableItemSnapshot::McpToolCallApprovalDecision {
        id: ItemId::new("item_0000000000000004"),
        approval_id: "approval/mcp".to_string(),
        decision: "denied".to_string(),
    };
    for item in &items[1..4] {
        repository
            .append_turn_item(&thread_id, &TurnId::new("turn_0000000000000001"), item)
            .expect("pre-attempt item");
    }
    let rollout = directory
        .path()
        .join("rollouts/v1/thr_0000000000000001.jsonl");
    let before = fs::read(&rollout).expect("before invalid attempt");
    assert!(matches!(
        repository.append_turn_item(&thread_id, &TurnId::new("turn_0000000000000001"), &items[4],),
        Err(RolloutError::InvalidRecord {
            kind: "invalidMcpToolItem"
        })
    ));
    assert_eq!(fs::read(&rollout).expect("after invalid attempt"), before);

    let result = DurableItemSnapshot::McpToolResult {
        id: ItemId::new("item_0000000000000005"),
        call_id: "call_mcp".to_string(),
        name: "mcp__fixture__inspect".to_string(),
        result: DurableMcpToolResult::Error {
            kind: "approvalDenied".to_string(),
            request_state: "notSent".to_string(),
        },
    };
    repository
        .append_turn_item(&thread_id, &TurnId::new("turn_0000000000000001"), &result)
        .expect("denied result");
    let next_call = completed_call_items(2).remove(0);
    assert!(matches!(
        repository.append_turn_item(
            &thread_id,
            &TurnId::new("turn_0000000000000001"),
            &next_call,
        ),
        Err(RolloutError::InvalidRecord {
            kind: "invalidMcpToolItem"
        })
    ));
    items.truncate(4);
    items.push(result);
    repository
        .finish_turn(
            &thread_id,
            &DurableTurnSnapshot {
                id: TurnId::new("turn_0000000000000001"),
                status: DurableTurnStatus::Completed,
                items: items.clone(),
                context_compaction: None,
                workspace_instructions: None,
                workspace_skills: None,
                error: None,
                usage: None,
            },
        )
        .expect("terminal");
    drop(repository);

    let repository = RolloutRepository::open(&home).expect("replay");
    assert_eq!(
        repository
            .load_thread(&thread_id)
            .expect("load")
            .expect("thread")
            .turns[0]
            .items,
        items
    );
}

#[test]
fn four_completed_calls_are_valid_but_duplicate_and_fifth_calls_are_rejected() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let thread_id = ThreadId::new("thr_0000000000000001");
    let turn_id = TurnId::new("turn_0000000000000001");
    let mut repository = RolloutRepository::open(&home).expect("repository");
    repository.create_thread(&thread_id).expect("thread");
    begin_mcp_turn(&mut repository, &thread_id);

    for ordinal in 1..=4 {
        for item in completed_call_items(ordinal) {
            repository
                .append_turn_item(&thread_id, &turn_id, &item)
                .expect("sequential MCP item");
        }
    }

    let rollout = directory
        .path()
        .join("rollouts/v1/thr_0000000000000001.jsonl");
    let before = fs::read(&rollout).expect("before invalid call");
    let fifth = completed_call_items(5).remove(0);
    assert!(matches!(
        repository.append_turn_item(&thread_id, &turn_id, &fifth),
        Err(RolloutError::InvalidRecord {
            kind: "invalidMcpToolItem"
        })
    ));
    let mut duplicate = completed_call_items(5).remove(0);
    if let DurableItemSnapshot::McpToolCall { call_id, .. } = &mut duplicate {
        *call_id = "call_mcp_4".to_string();
    }
    assert!(matches!(
        repository.append_turn_item(&thread_id, &turn_id, &duplicate),
        Err(RolloutError::InvalidRecord {
            kind: "invalidMcpToolItem"
        })
    ));
    assert_eq!(fs::read(&rollout).expect("after invalid calls"), before);
}

fn begin_mcp_turn(repository: &mut RolloutRepository, thread_id: &ThreadId) {
    repository
        .begin_turn(
            thread_id,
            &DurableTurnSnapshot {
                id: TurnId::new("turn_0000000000000001"),
                status: DurableTurnStatus::InProgress,
                items: vec![DurableItemSnapshot::UserMessage {
                    id: ItemId::new("item_0000000000000001"),
                    text: "Use MCP".to_string(),
                }],
                context_compaction: None,
                workspace_instructions: None,
                workspace_skills: None,
                error: None,
                usage: None,
            },
        )
        .expect("begin turn");
}

fn approved_attempt_items() -> Vec<DurableItemSnapshot> {
    let arguments = serde_json::json!({"value": ["arbitrary", 2]});
    let bytes = serde_json::to_vec(&arguments).expect("arguments");
    let arguments_sha256 = format!("{:x}", Sha256::digest(&bytes));
    vec![
        DurableItemSnapshot::UserMessage {
            id: ItemId::new("item_0000000000000001"),
            text: "Use MCP".to_string(),
        },
        DurableItemSnapshot::McpToolCall {
            id: ItemId::new("item_0000000000000002"),
            call_id: "call_mcp".to_string(),
            name: "mcp__fixture__inspect".to_string(),
            arguments: arguments.clone(),
            arguments_bytes: bytes.len() as u64,
            arguments_sha256: arguments_sha256.clone(),
            inventory_sha256: "b".repeat(64),
        },
        DurableItemSnapshot::McpToolCallApprovalRequest {
            id: ItemId::new("item_0000000000000003"),
            approval_id: "approval/mcp".to_string(),
            call_id: "call_mcp".to_string(),
            name: "mcp__fixture__inspect".to_string(),
            arguments,
            arguments_bytes: bytes.len() as u64,
            arguments_sha256,
            inventory_sha256: "b".repeat(64),
        },
        DurableItemSnapshot::McpToolCallApprovalDecision {
            id: ItemId::new("item_0000000000000004"),
            approval_id: "approval/mcp".to_string(),
            decision: "approved".to_string(),
        },
        DurableItemSnapshot::McpToolExecutionAttempt {
            id: ItemId::new("item_0000000000000005"),
            approval_id: "approval/mcp".to_string(),
            call_id: "call_mcp".to_string(),
            inventory_sha256: "b".repeat(64),
        },
    ]
}

fn completed_call_items(ordinal: u64) -> Vec<DurableItemSnapshot> {
    let arguments = serde_json::json!({"value": format!("value-{ordinal}")});
    let bytes = serde_json::to_vec(&arguments).expect("arguments");
    let arguments_sha256 = format!("{:x}", Sha256::digest(&bytes));
    let content = format!(r#"{{"isError":false,"ordinal":{ordinal}}}"#);
    let result_sha256 = format!("{:x}", Sha256::digest(content.as_bytes()));
    let item = |offset| ItemId::new(format!("item_{:016}", 2 + (ordinal - 1) * 5 + offset));
    let call_id = format!("call_mcp_{ordinal}");
    let approval_id = format!("approval/mcp/{ordinal}");
    vec![
        DurableItemSnapshot::McpToolCall {
            id: item(0),
            call_id: call_id.clone(),
            name: "mcp__fixture__inspect".to_string(),
            arguments: arguments.clone(),
            arguments_bytes: bytes.len() as u64,
            arguments_sha256: arguments_sha256.clone(),
            inventory_sha256: "b".repeat(64),
        },
        DurableItemSnapshot::McpToolCallApprovalRequest {
            id: item(1),
            approval_id: approval_id.clone(),
            call_id: call_id.clone(),
            name: "mcp__fixture__inspect".to_string(),
            arguments,
            arguments_bytes: bytes.len() as u64,
            arguments_sha256,
            inventory_sha256: "b".repeat(64),
        },
        DurableItemSnapshot::McpToolCallApprovalDecision {
            id: item(2),
            approval_id: approval_id.clone(),
            decision: "approved".to_string(),
        },
        DurableItemSnapshot::McpToolExecutionAttempt {
            id: item(3),
            approval_id,
            call_id: call_id.clone(),
            inventory_sha256: "b".repeat(64),
        },
        DurableItemSnapshot::McpToolResult {
            id: item(4),
            call_id,
            name: "mcp__fixture__inspect".to_string(),
            result: DurableMcpToolResult::Completed {
                content: content.clone(),
                is_error: false,
                observed_bytes: content.len() as u64,
                canonical_bytes: content.len() as u64,
                retained_bytes: content.len() as u64,
                truncated: false,
                sha256: result_sha256,
                content_blocks: 1,
                structured_content: false,
            },
        },
    ]
}
