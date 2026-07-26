use serde_json::json;
use sugarcode_app_server_protocol::AgentMessageDeltaNotification;
use sugarcode_app_server_protocol::CommandNetworkPolicy;
use sugarcode_app_server_protocol::CommandSandboxPolicy;
use sugarcode_app_server_protocol::ERROR_PARSE;
use sugarcode_app_server_protocol::FileChangeKind;
use sugarcode_app_server_protocol::FileChangeNewlineStyle;
use sugarcode_app_server_protocol::Item;
use sugarcode_app_server_protocol::ItemCompletedNotification;
use sugarcode_app_server_protocol::ItemStartedNotification;
use sugarcode_app_server_protocol::JsonRpcError;
use sugarcode_app_server_protocol::JsonRpcErrorObject;
use sugarcode_app_server_protocol::JsonRpcMessage;
use sugarcode_app_server_protocol::JsonRpcVersion;
use sugarcode_app_server_protocol::RequestId;
use sugarcode_app_server_protocol::Thread;
use sugarcode_app_server_protocol::ThreadArchiveParams;
use sugarcode_app_server_protocol::ThreadArchiveResponse;
use sugarcode_app_server_protocol::ThreadDeleteParams;
use sugarcode_app_server_protocol::ThreadDeleteResponse;
use sugarcode_app_server_protocol::ThreadForkParams;
use sugarcode_app_server_protocol::ThreadForkResponse;
use sugarcode_app_server_protocol::ThreadListParams;
use sugarcode_app_server_protocol::ThreadListResponse;
use sugarcode_app_server_protocol::ThreadResumeParams;
use sugarcode_app_server_protocol::ThreadResumeResponse;
use sugarcode_app_server_protocol::ThreadSearchParams;
use sugarcode_app_server_protocol::ThreadSearchResponse;
use sugarcode_app_server_protocol::ThreadStartParams;
use sugarcode_app_server_protocol::ThreadStartResponse;
use sugarcode_app_server_protocol::ThreadStartedNotification;
use sugarcode_app_server_protocol::ThreadUnarchiveParams;
use sugarcode_app_server_protocol::ThreadUnarchiveResponse;
use sugarcode_app_server_protocol::ToolResult;
use sugarcode_app_server_protocol::Turn;
use sugarcode_app_server_protocol::TurnCompletedNotification;
use sugarcode_app_server_protocol::TurnError;
use sugarcode_app_server_protocol::TurnErrorKind;
use sugarcode_app_server_protocol::TurnInterruptParams;
use sugarcode_app_server_protocol::TurnInterruptResponse;
use sugarcode_app_server_protocol::TurnSnapshot;
use sugarcode_app_server_protocol::TurnSnapshotStatus;
use sugarcode_app_server_protocol::TurnStartParams;
use sugarcode_app_server_protocol::TurnStartResponse;
use sugarcode_app_server_protocol::TurnStartedNotification;
use sugarcode_app_server_protocol::TurnStatus;

#[test]
fn error_envelope_uses_json_rpc_2_and_null_unknown_id() {
    let message = JsonRpcMessage::Error(JsonRpcError {
        jsonrpc: JsonRpcVersion::V2,
        id: None,
        error: JsonRpcErrorObject {
            code: ERROR_PARSE,
            message: "Parse error".to_string(),
            data: None,
        },
    });

    assert_eq!(
        serde_json::to_value(message).expect("message serializes"),
        json!({
            "jsonrpc": "2.0",
            "id": null,
            "error": {
                "code": -32700,
                "message": "Parse error"
            }
        })
    );
}

#[test]
fn request_ids_support_strings_and_integers() {
    for id in [
        RequestId::String("request-1".to_string()),
        RequestId::Integer(7),
    ] {
        let encoded = serde_json::to_string(&id).expect("id serializes");
        let decoded = serde_json::from_str::<RequestId>(&encoded).expect("id deserializes");
        assert_eq!(decoded, id);
    }
}

#[test]
fn file_change_item_serializes_a_bounded_update_review() {
    let item = Item::FileChange {
        id: "item_0000000000000003".to_string(),
        call_id: "call_patch".to_string(),
        path: "src/lib.rs".to_string(),
        kind: FileChangeKind::Update,
        diff: "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,1 +1,1 @@\n-old\n+new\n".to_string(),
        before_sha256: "a".repeat(64),
        after_sha256: "b".repeat(64),
        before_bytes: 4,
        after_bytes: 4,
        newline_style: FileChangeNewlineStyle::Lf,
        final_newline: true,
    };
    let value = serde_json::to_value(&item).expect("file change serializes");
    assert_eq!(value["type"], "fileChange");
    assert_eq!(value["kind"], "update");
    assert_eq!(value["newlineStyle"], "lf");
    assert_eq!(value["callId"], "call_patch");
    assert_eq!(
        serde_json::from_value::<Item>(value).expect("round trip"),
        item
    );
}

#[test]
fn thread_start_types_use_the_public_thread_dto() {
    let thread = Thread {
        id: "thr_0000000000000001".to_string(),
    };

    assert_eq!(
        serde_json::to_value(ThreadStartResponse {
            thread: thread.clone(),
        })
        .expect("response serializes"),
        json!({
            "thread": {
                "id": "thr_0000000000000001"
            }
        })
    );
    assert_eq!(
        serde_json::to_value(ThreadStartedNotification { thread })
            .expect("notification serializes"),
        json!({
            "thread": {
                "id": "thr_0000000000000001"
            }
        })
    );
}

#[test]
fn thread_start_params_accept_only_an_empty_object() {
    assert!(serde_json::from_value::<ThreadStartParams>(json!({})).is_ok());
    for invalid in [
        json!(null),
        json!([]),
        json!("invalid"),
        json!({"model": "not-supported-yet"}),
    ] {
        assert!(
            serde_json::from_value::<ThreadStartParams>(invalid).is_err(),
            "non-empty or non-object params must be rejected"
        );
    }
}

#[test]
fn thread_archive_uses_a_canonical_thread_id_and_empty_response() {
    assert_eq!(
        serde_json::from_value::<ThreadArchiveParams>(json!({
            "threadId": "thr_0000000000000001"
        }))
        .expect("valid params"),
        ThreadArchiveParams {
            thread_id: "thr_0000000000000001".to_string()
        }
    );
    assert_eq!(
        serde_json::to_value(ThreadArchiveResponse {}).expect("response serializes"),
        json!({})
    );
    for invalid in [
        json!({}),
        json!({"threadId": ""}),
        json!({"threadId": "thr_missing"}),
        json!({"threadId": "../thr_0000000000000001"}),
        json!({"threadId": "thr_00000000000000001"}),
        json!({"threadId": "thr_0000000000000001", "includeArchived": true}),
    ] {
        assert!(serde_json::from_value::<ThreadArchiveParams>(invalid).is_err());
    }
}

#[test]
fn thread_unarchive_uses_its_own_canonical_params_and_empty_response() {
    assert_eq!(
        serde_json::from_value::<ThreadUnarchiveParams>(json!({
            "threadId": "thr_0000000000000001"
        }))
        .expect("valid params"),
        ThreadUnarchiveParams {
            thread_id: "thr_0000000000000001".to_string()
        }
    );
    assert_eq!(
        serde_json::to_value(ThreadUnarchiveResponse {}).expect("response serializes"),
        json!({})
    );
    for invalid in [
        json!({}),
        json!({"threadId": ""}),
        json!({"threadId": "thr_missing"}),
        json!({"threadId": "../thr_0000000000000001"}),
        json!({"threadId": "thr_00000000000000001"}),
        json!({"threadId": "thr_0000000000000001", "resume": true}),
    ] {
        assert!(serde_json::from_value::<ThreadUnarchiveParams>(invalid).is_err());
    }
}

#[test]
fn thread_delete_uses_its_own_canonical_params_and_empty_response() {
    assert_eq!(
        serde_json::from_value::<ThreadDeleteParams>(json!({
            "threadId": "thr_0000000000000001"
        }))
        .expect("valid params"),
        ThreadDeleteParams {
            thread_id: "thr_0000000000000001".to_string()
        }
    );
    assert_eq!(
        serde_json::to_value(ThreadDeleteResponse {}).expect("response serializes"),
        json!({})
    );
    for invalid in [
        json!({}),
        json!({"threadId": ""}),
        json!({"threadId": "thr_missing"}),
        json!({"threadId": "../thr_0000000000000001"}),
        json!({"threadId": "thr_00000000000000001"}),
        json!({"threadId": "thr_0000000000000001", "purge": true}),
    ] {
        assert!(serde_json::from_value::<ThreadDeleteParams>(invalid).is_err());
    }
}

#[test]
fn thread_fork_uses_canonical_source_and_returns_a_complete_new_snapshot() {
    assert_eq!(
        serde_json::from_value::<ThreadForkParams>(json!({
            "threadId": "thr_0000000000000001"
        }))
        .expect("valid params"),
        ThreadForkParams {
            thread_id: "thr_0000000000000001".to_string()
        }
    );
    let response = ThreadForkResponse {
        thread: Thread {
            id: "thr_0000000000000002".to_string(),
        },
        turns: vec![TurnSnapshot {
            id: "turn_0000000000000002".to_string(),
            status: TurnSnapshotStatus::Completed,
            items: vec![Item::AgentMessage {
                id: "item_0000000000000002".to_string(),
                text: "SugarCode deterministic response.".to_string(),
            }],
            error: None,
        }],
    };
    assert_eq!(
        serde_json::to_value(response).expect("response serializes"),
        json!({
            "thread": {"id": "thr_0000000000000002"},
            "turns": [{
                "id": "turn_0000000000000002",
                "status": "completed",
                "items": [{
                    "type": "agentMessage",
                    "id": "item_0000000000000002",
                    "text": "SugarCode deterministic response."
                }]
            }]
        })
    );
    for invalid in [
        json!({}),
        json!({"threadId": ""}),
        json!({"threadId": "thr_missing"}),
        json!({"threadId": "../thr_0000000000000001"}),
        json!({"threadId": "thr_00000000000000001"}),
        json!({"threadId": "thr_0000000000000001", "turnId": "turn_1"}),
        json!({"threadId": "thr_0000000000000001", "sourceThreadId": true}),
    ] {
        assert!(serde_json::from_value::<ThreadForkParams>(invalid).is_err());
    }
}

#[test]
fn thread_list_params_are_bounded_and_canonical() {
    assert_eq!(
        serde_json::from_value::<ThreadListParams>(json!({})).expect("defaults"),
        ThreadListParams::default()
    );
    assert_eq!(
        serde_json::from_value::<ThreadListParams>(json!({
            "cursor": "thr_0000000000000009",
            "limit": 25
        }))
        .expect("valid page"),
        ThreadListParams {
            cursor: Some("thr_0000000000000009".to_string()),
            limit: Some(25),
        }
    );
    for invalid in [
        json!(null),
        json!([]),
        json!({"limit": 0}),
        json!({"limit": 101}),
        json!({"cursor": "thr_missing"}),
        json!({"cursor": "thr_0000000000000009", "search": "later"}),
    ] {
        assert!(serde_json::from_value::<ThreadListParams>(invalid).is_err());
    }
}

#[test]
fn thread_list_response_contains_only_durable_identity_and_cursor() {
    assert_eq!(
        serde_json::to_value(ThreadListResponse {
            data: vec![Thread {
                id: "thr_0000000000000010".to_string(),
            }],
            next_cursor: Some("thr_0000000000000010".to_string()),
        })
        .expect("response serializes"),
        json!({
            "data": [{"id": "thr_0000000000000010"}],
            "nextCursor": "thr_0000000000000010"
        })
    );
}

#[test]
fn thread_search_params_are_bounded_trimmed_and_canonical() {
    assert_eq!(
        serde_json::from_value::<ThreadSearchParams>(json!({
            "query": "  SugarCode release  ",
            "cursor": "thr_0000000000000009",
            "limit": 25
        }))
        .expect("valid search"),
        ThreadSearchParams {
            query: "SugarCode release".to_string(),
            cursor: Some("thr_0000000000000009".to_string()),
            limit: Some(25),
        }
    );
    for invalid in [
        json!({}),
        json!({"query": ""}),
        json!({"query": "   "}),
        json!({"query": "private\nquery"}),
        json!({"query": "x".repeat(257)}),
        json!({"query": "界".repeat(86)}),
        json!({"query": (0..17).map(|_| "term").collect::<Vec<_>>().join(" ")}),
        json!({"query": "valid", "limit": 0}),
        json!({"query": "valid", "limit": 101}),
        json!({"query": "valid", "cursor": "thr_missing"}),
        json!({"query": "valid", "score": true}),
    ] {
        assert!(serde_json::from_value::<ThreadSearchParams>(invalid).is_err());
    }
}

#[test]
fn thread_search_response_exposes_only_thread_identity_and_cursor() {
    assert_eq!(
        serde_json::to_value(ThreadSearchResponse {
            data: vec![Thread {
                id: "thr_0000000000000010".to_string(),
            }],
            next_cursor: Some("thr_0000000000000010".to_string()),
        })
        .expect("response serializes"),
        json!({
            "data": [{"id": "thr_0000000000000010"}],
            "nextCursor": "thr_0000000000000010"
        })
    );
}

#[test]
fn turn_start_types_use_the_public_turn_dto() {
    let turn = Turn {
        id: "turn_0000000000000001".to_string(),
        status: TurnStatus::InProgress,
        error: None,
    };

    assert_eq!(
        serde_json::to_value(TurnStartResponse { turn: turn.clone() })
            .expect("response serializes"),
        json!({
            "turn": {
                "id": "turn_0000000000000001",
                "status": "inProgress"
            }
        })
    );
    assert_eq!(
        serde_json::to_value(TurnStartedNotification {
            thread_id: "thr_0000000000000001".to_string(),
            turn,
        })
        .expect("notification serializes"),
        json!({
            "threadId": "thr_0000000000000001",
            "turn": {
                "id": "turn_0000000000000001",
                "status": "inProgress"
            }
        })
    );
}

#[test]
fn agent_message_item_lifecycle_types_preserve_correlation_and_text() {
    let thread_id = "thr_0000000000000001".to_string();
    let turn_id = "turn_0000000000000001".to_string();
    let item_id = "item_0000000000000001".to_string();
    let started_item = Item::AgentMessage {
        id: item_id.clone(),
        text: String::new(),
    };
    let completed_item = Item::AgentMessage {
        id: item_id.clone(),
        text: "SugarCode deterministic response.".to_string(),
    };

    assert_eq!(
        serde_json::to_value(ItemStartedNotification {
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            item: started_item,
        })
        .expect("item/started serializes"),
        json!({
            "threadId": thread_id,
            "turnId": turn_id,
            "item": {
                "type": "agentMessage",
                "id": item_id,
                "text": ""
            }
        })
    );
    assert_eq!(
        serde_json::to_value(AgentMessageDeltaNotification {
            thread_id: "thr_0000000000000001".to_string(),
            turn_id: "turn_0000000000000001".to_string(),
            item_id: "item_0000000000000001".to_string(),
            delta: "SugarCode deterministic response.".to_string(),
        })
        .expect("agent message delta serializes"),
        json!({
            "threadId": "thr_0000000000000001",
            "turnId": "turn_0000000000000001",
            "itemId": "item_0000000000000001",
            "delta": "SugarCode deterministic response."
        })
    );
    assert_eq!(
        serde_json::to_value(ItemCompletedNotification {
            thread_id: "thr_0000000000000001".to_string(),
            turn_id: "turn_0000000000000001".to_string(),
            item: completed_item,
        })
        .expect("item/completed serializes"),
        json!({
            "threadId": "thr_0000000000000001",
            "turnId": "turn_0000000000000001",
            "item": {
                "type": "agentMessage",
                "id": "item_0000000000000001",
                "text": "SugarCode deterministic response."
            }
        })
    );
    assert_eq!(
        serde_json::to_value(TurnCompletedNotification {
            thread_id: "thr_0000000000000001".to_string(),
            turn: Turn {
                id: "turn_0000000000000001".to_string(),
                status: TurnStatus::Completed,
                error: None,
            },
        })
        .expect("turn/completed serializes"),
        json!({
            "threadId": "thr_0000000000000001",
            "turn": {
                "id": "turn_0000000000000001",
                "status": "completed"
            }
        })
    );
}

#[test]
fn tool_items_use_provider_neutral_camel_case_public_fields() {
    assert_eq!(
        serde_json::to_value(Item::ToolCall {
            id: "item_0000000000000002".to_string(),
            call_id: "call_1".to_string(),
            name: "workspace/read".to_string(),
            path: "README.txt".to_string(),
            query: None,
            command: None,
            arguments: None,
        })
        .expect("tool call serializes"),
        json!({
            "type": "toolCall",
            "id": "item_0000000000000002",
            "callId": "call_1",
            "name": "workspace/read",
            "path": "README.txt"
        })
    );
    assert_eq!(
        serde_json::to_value(Item::ToolCall {
            id: "item_0000000000000004".to_string(),
            call_id: "call_2".to_string(),
            name: "workspace/search".to_string(),
            path: "src".to_string(),
            query: Some("needle".to_string()),
            command: None,
            arguments: None,
        })
        .expect("search tool call serializes"),
        json!({
            "type": "toolCall",
            "id": "item_0000000000000004",
            "callId": "call_2",
            "name": "workspace/search",
            "path": "src",
            "query": "needle"
        })
    );
    assert_eq!(
        serde_json::to_value(Item::ToolResult {
            id: "item_0000000000000003".to_string(),
            call_id: "call_1".to_string(),
            name: "workspace/read".to_string(),
            result: ToolResult::Success {
                content: "context".to_string(),
                bytes: 7,
            },
        })
        .expect("tool result serializes"),
        json!({
            "type": "toolResult",
            "id": "item_0000000000000003",
            "callId": "call_1",
            "name": "workspace/read",
            "result": {
                "type": "success",
                "content": "context",
                "bytes": 7
            }
        })
    );
    assert_eq!(
        serde_json::to_value(ToolResult::Error {
            kind: "resultTooLarge".to_string(),
        })
        .expect("tool error serializes"),
        json!({
            "type": "error",
            "kind": "resultTooLarge"
        })
    );
}

#[test]
fn shell_approval_and_process_results_are_provider_neutral() {
    assert_eq!(
        serde_json::to_value(Item::CommandApprovalRequest {
            id: "item_0000000000000003".to_string(),
            approval_id: "approval/one".to_string(),
            call_id: "call_shell".to_string(),
            command: "/bin/echo".to_string(),
            arguments: vec!["ok".to_string()],
            cwd: ".".to_string(),
            environment_policy: "minimalV1".to_string(),
            sandboxed: true,
            sandbox_policy: Some(CommandSandboxPolicy::FilesystemReadOnlyV1),
            network_policy: Some(CommandNetworkPolicy::NetworkDeniedV1),
        })
        .expect("approval request serializes"),
        json!({
            "type": "commandApprovalRequest",
            "id": "item_0000000000000003",
            "approvalId": "approval/one",
            "callId": "call_shell",
            "command": "/bin/echo",
            "arguments": ["ok"],
            "cwd": ".",
            "environmentPolicy": "minimalV1",
            "sandboxed": true,
            "sandboxPolicy": "filesystemReadOnlyV1",
            "networkPolicy": "networkDeniedV1"
        })
    );
    assert_eq!(
        serde_json::to_value(ToolResult::Process {
            stdout: "ok\n".to_string(),
            stderr: String::new(),
            stdout_bytes: 3,
            stderr_bytes: 0,
            stdout_truncated: false,
            stderr_truncated: false,
            encoding: "utf8Lossy".to_string(),
            duration_ms: 2,
            outcome: sugarcode_app_server_protocol::ProcessOutcome::ExitCode { code: 0 },
            sandbox_policy: Some(CommandSandboxPolicy::FilesystemReadOnlyV1),
            network_policy: Some(CommandNetworkPolicy::NetworkDeniedV1),
        })
        .expect("process result serializes"),
        json!({
            "type": "process",
            "stdout": "ok\n",
            "stderr": "",
            "stdoutBytes": 3,
            "stderrBytes": 0,
            "stdoutTruncated": false,
            "stderrTruncated": false,
            "encoding": "utf8Lossy",
            "durationMs": 2,
            "outcome": {"type": "exitCode", "code": 0},
            "sandboxPolicy": "filesystemReadOnlyV1",
            "networkPolicy": "networkDeniedV1"
        })
    );
}

#[test]
fn turn_start_params_require_thread_id_and_accept_optional_text_input() {
    assert_eq!(
        serde_json::from_value::<TurnStartParams>(json!({
            "threadId": "thr_0000000000000001",
            "input": "Hello"
        }))
        .expect("valid params"),
        TurnStartParams {
            thread_id: "thr_0000000000000001".to_string(),
            input: Some("Hello".to_string()),
        }
    );
    assert_eq!(
        serde_json::from_value::<TurnStartParams>(json!({
            "threadId": "thr_0000000000000001"
        }))
        .expect("optional input"),
        TurnStartParams {
            thread_id: "thr_0000000000000001".to_string(),
            input: None,
        }
    );

    for invalid in [
        json!(null),
        json!([]),
        json!("invalid"),
        json!({}),
        json!({"threadId": null}),
        json!({"threadId": ""}),
        json!({"threadId": "   "}),
        json!({"threadId": "thr_0000000000000001", "input": []}),
    ] {
        assert!(
            serde_json::from_value::<TurnStartParams>(invalid).is_err(),
            "missing, blank, or unknown turn/start params must be rejected"
        );
    }
}

#[test]
fn turn_interrupt_is_strict_and_terminal_errors_are_provider_neutral() {
    assert_eq!(
        serde_json::from_value::<TurnInterruptParams>(json!({
            "threadId": "thr_0000000000000001",
            "turnId": "turn_0000000000000001"
        }))
        .expect("valid interrupt"),
        TurnInterruptParams {
            thread_id: "thr_0000000000000001".to_string(),
            turn_id: "turn_0000000000000001".to_string(),
        }
    );
    assert!(
        serde_json::from_value::<TurnInterruptParams>(json!({
            "threadId": "thr_0000000000000001",
            "turnId": " ",
        }))
        .is_err()
    );
    assert_eq!(
        serde_json::to_value(TurnInterruptResponse {}).expect("empty response"),
        json!({})
    );
    assert_eq!(
        serde_json::to_value(Turn {
            id: "turn_0000000000000001".to_string(),
            status: TurnStatus::Failed,
            error: Some(TurnError {
                kind: TurnErrorKind::RateLimited,
                retryable: true,
            }),
        })
        .expect("failed turn"),
        json!({
            "id": "turn_0000000000000001",
            "status": "failed",
            "error": {"kind": "rateLimited", "retryable": true}
        })
    );
}

#[test]
fn thread_resume_returns_a_complete_snapshot() {
    let response = ThreadResumeResponse {
        thread: Thread {
            id: "thr_0000000000000001".to_string(),
        },
        turns: vec![TurnSnapshot {
            id: "turn_0000000000000001".to_string(),
            status: TurnSnapshotStatus::Completed,
            items: vec![Item::AgentMessage {
                id: "item_0000000000000001".to_string(),
                text: "SugarCode deterministic response.".to_string(),
            }],
            error: None,
        }],
    };
    assert_eq!(
        serde_json::to_value(response).expect("response serializes"),
        json!({
            "thread": {"id": "thr_0000000000000001"},
            "turns": [{
                "id": "turn_0000000000000001",
                "status": "completed",
                "items": [{
                    "type": "agentMessage",
                    "id": "item_0000000000000001",
                    "text": "SugarCode deterministic response."
                }]
            }]
        })
    );
}

#[test]
fn thread_resume_requires_a_canonical_thread_id() {
    assert_eq!(
        serde_json::from_value::<ThreadResumeParams>(json!({
            "threadId": "thr_0000000000000001"
        }))
        .expect("valid params"),
        ThreadResumeParams {
            thread_id: "thr_0000000000000001".to_string()
        }
    );
    for invalid in [
        json!({}),
        json!({"threadId": ""}),
        json!({"threadId": "thr_missing"}),
        json!({"threadId": "../thr_0000000000000001"}),
        json!({"threadId": "thr_00000000000000001"}),
        json!({"threadId": "thr_0000000000000001", "path": "/tmp"}),
    ] {
        assert!(serde_json::from_value::<ThreadResumeParams>(invalid).is_err());
    }
}
