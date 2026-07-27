use sha2::Digest;
use sha2::Sha256;
use sugarcode_protocol::ItemId;
use sugarcode_protocol::TurnId;
use sugarcode_state::DurableItemSnapshot;
use sugarcode_state::DurableToolResult;
use sugarcode_state::DurableTurnSnapshot;
use sugarcode_state::DurableTurnStatus;
use sugarcode_state::MAX_CONTEXT_COMPACTION_MESSAGE_BYTES;
use sugarcode_state::build_context_compaction;
use sugarcode_state::validate_context_compaction;

fn completed_turn(items: Vec<DurableItemSnapshot>) -> DurableTurnSnapshot {
    DurableTurnSnapshot {
        id: TurnId::new("turn_0000000000000001"),
        status: DurableTurnStatus::Completed,
        items,
        context_compaction: None,
        workspace_instructions: None,
        error: None,
        usage: None,
    }
}

#[test]
fn tool_history_becomes_a_deterministic_receipt_without_raw_output() {
    let raw_output = "private raw tool output that must not survive compaction";
    let turn = completed_turn(vec![
        DurableItemSnapshot::UserMessage {
            id: ItemId::new("item_0000000000000001"),
            text: "Inspect src/lib.rs".to_string(),
        },
        DurableItemSnapshot::ToolCall {
            id: ItemId::new("item_0000000000000002"),
            call_id: "call_1".to_string(),
            name: "workspace/read".to_string(),
            path: "src/lib.rs".to_string(),
            query: None,
            patch: None,
            command: None,
            arguments: None,
        },
        DurableItemSnapshot::FileChange {
            id: ItemId::new("item_0000000000000003"),
            call_id: "call_1".to_string(),
            path: "src/lib.rs".to_string(),
            kind: "audit-only".to_string(),
            diff: "audit-only".to_string(),
            before_sha256: "a".repeat(64),
            after_sha256: "b".repeat(64),
            before_bytes: 1,
            after_bytes: 1,
            newline_style: "lf".to_string(),
            final_newline: true,
        },
        DurableItemSnapshot::ToolResult {
            id: ItemId::new("item_0000000000000004"),
            call_id: "call_1".to_string(),
            name: "workspace/read".to_string(),
            result: DurableToolResult::Success {
                content: raw_output.to_string(),
                bytes: raw_output.len() as u64,
            },
        },
        DurableItemSnapshot::AgentMessage {
            id: ItemId::new("item_0000000000000005"),
            text: "Inspection complete.".to_string(),
        },
    ]);

    let first = build_context_compaction(std::slice::from_ref(&turn), 4_000_000, 30_000)
        .expect("compaction");
    let second = build_context_compaction(std::slice::from_ref(&turn), 4_000_000, 30_000)
        .expect("same compaction");

    assert_eq!(first, second);
    assert_eq!(first.source_turns, 1);
    assert_eq!(first.source_messages, 3);
    assert!(first.message.contains("\"name\":\"workspace/read\""));
    assert!(first.message.contains("\"contentBytes\":"));
    assert!(first.message.contains("\"contentSha256\":"));
    assert!(!first.message.contains(raw_output));
    assert!(!first.message.contains("audit-only"));
    assert!(validate_context_compaction(&[turn], &first));
}

#[test]
fn extractive_tail_truncation_is_utf8_safe_and_exactly_bounded() {
    let turn = completed_turn(vec![DurableItemSnapshot::AgentMessage {
        id: ItemId::new("item_0000000000000001"),
        text: "糖".repeat(MAX_CONTEXT_COMPACTION_MESSAGE_BYTES),
    }]);
    let compaction = build_context_compaction(std::slice::from_ref(&turn), 4_000_000, 30_000)
        .expect("compaction");

    assert!(compaction.message.len() <= MAX_CONTEXT_COMPACTION_MESSAGE_BYTES);
    assert!(compaction.message.len() >= MAX_CONTEXT_COMPACTION_MESSAGE_BYTES - 3);
    assert!(compaction.message.contains("truncated:true\n"));
    assert!(std::str::from_utf8(compaction.message.as_bytes()).is_ok());
    assert_eq!(
        compaction.message_sha256,
        format!("{:x}", Sha256::digest(compaction.message.as_bytes()))
    );
    assert!(validate_context_compaction(&[turn], &compaction));
}
