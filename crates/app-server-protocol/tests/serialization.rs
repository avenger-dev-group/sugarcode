use serde_json::json;
use sugarcode_app_server_protocol::AgentMessageDeltaNotification;
use sugarcode_app_server_protocol::AgentOutputDeltaNotification;
use sugarcode_app_server_protocol::AgentOutputDiscardedNotification;
use sugarcode_app_server_protocol::AgentOutputRef;
use sugarcode_app_server_protocol::AgentTaskAccess;
use sugarcode_app_server_protocol::AgentTaskRole;
use sugarcode_app_server_protocol::AgentTaskStatus;
use sugarcode_app_server_protocol::CommandApprovalParams;
use sugarcode_app_server_protocol::CommandNetworkPolicy;
use sugarcode_app_server_protocol::CommandSandboxPolicy;
use sugarcode_app_server_protocol::CommandWorkspaceWritePolicy;
use sugarcode_app_server_protocol::CommandWorkspaceWriteRisk;
use sugarcode_app_server_protocol::ContextCompactionOutcome;
use sugarcode_app_server_protocol::ContextCompactionStrategy;
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
use sugarcode_app_server_protocol::McpToolCallApprovalParams;
use sugarcode_app_server_protocol::ModelProtocolCode;
use sugarcode_app_server_protocol::ModelProtocolDiagnostic;
use sugarcode_app_server_protocol::ModelProtocolStage;
use sugarcode_app_server_protocol::ModelProviderFamily;
use sugarcode_app_server_protocol::ModelSelectionCapabilities;
use sugarcode_app_server_protocol::ModelSelectionSnapshot;
use sugarcode_app_server_protocol::ModelWireApi;
use sugarcode_app_server_protocol::RequestId;
use sugarcode_app_server_protocol::Thread;
use sugarcode_app_server_protocol::ThreadArchiveParams;
use sugarcode_app_server_protocol::ThreadArchiveResponse;
use sugarcode_app_server_protocol::ThreadDeleteParams;
use sugarcode_app_server_protocol::ThreadDeleteResponse;
use sugarcode_app_server_protocol::ThreadDescendantsListParams;
use sugarcode_app_server_protocol::ThreadDescendantsListResponse;
use sugarcode_app_server_protocol::ThreadForkParams;
use sugarcode_app_server_protocol::ThreadForkResponse;
use sugarcode_app_server_protocol::ThreadListParams;
use sugarcode_app_server_protocol::ThreadListResponse;
use sugarcode_app_server_protocol::ThreadOrigin;
use sugarcode_app_server_protocol::ThreadResumeParams;
use sugarcode_app_server_protocol::ThreadResumeResponse;
use sugarcode_app_server_protocol::ThreadSearchParams;
use sugarcode_app_server_protocol::ThreadSearchResponse;
use sugarcode_app_server_protocol::ThreadStartParams;
use sugarcode_app_server_protocol::ThreadStartResponse;
use sugarcode_app_server_protocol::ThreadStartedNotification;
use sugarcode_app_server_protocol::ThreadUnarchiveParams;
use sugarcode_app_server_protocol::ThreadUnarchiveResponse;
use sugarcode_app_server_protocol::TokenUsage;
use sugarcode_app_server_protocol::TokenUsageSample;
use sugarcode_app_server_protocol::TokenUsageSource;
use sugarcode_app_server_protocol::TokenUsageUpdatedNotification;
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
use sugarcode_app_server_protocol::TurnWarningCode;
use sugarcode_app_server_protocol::TurnWarningNotification;

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
    let legacy_error = serde_json::from_value::<TurnError>(json!({
        "kind": "protocol",
        "retryable": false
    }))
    .expect("v1 error without optional diagnostic");
    assert_eq!(legacy_error.protocol, None);
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
fn routed_lifecycle_and_approval_payloads_require_workspace_id() {
    let thread_id = "00000000-0000-7000-8000-000000000001";
    let turn_id = "00000000-0001-7000-8000-000000000001";
    let item_id = "00000000-0002-7000-8000-000000000001";
    let turn = json!({"id": turn_id, "status": "inProgress"});
    let item = json!({"type": "agentMessage", "id": item_id, "text": ""});
    let usage = json!({
        "lastRequest": {},
        "turnTotal": {},
        "requestCount": 1,
        "contextWindowTokens": 4096,
        "source": "estimated"
    });

    macro_rules! missing_workspace_fails {
        ($type:ty, $value:expr) => {
            assert!(
                serde_json::from_value::<$type>($value).is_err(),
                concat!(stringify!($type), " accepted a missing workspaceId")
            );
        };
    }

    missing_workspace_fails!(
        TurnStartedNotification,
        json!({"threadId": thread_id, "turn": turn})
    );
    missing_workspace_fails!(
        ItemStartedNotification,
        json!({"threadId": thread_id, "turnId": turn_id, "item": item})
    );
    missing_workspace_fails!(
        AgentOutputDeltaNotification,
        json!({
            "threadId": thread_id,
            "turnId": turn_id,
            "output": {"responseOrdinal": 1, "outputIndex": 0},
            "delta": "partial"
        })
    );
    missing_workspace_fails!(
        AgentOutputDiscardedNotification,
        json!({
            "threadId": thread_id,
            "turnId": turn_id,
            "output": {"responseOrdinal": 1, "outputIndex": 0}
        })
    );
    missing_workspace_fails!(
        AgentMessageDeltaNotification,
        json!({
            "threadId": thread_id,
            "turnId": turn_id,
            "itemId": item_id,
            "delta": "partial"
        })
    );
    missing_workspace_fails!(
        ItemCompletedNotification,
        json!({"threadId": thread_id, "turnId": turn_id, "item": item})
    );
    missing_workspace_fails!(
        TokenUsageUpdatedNotification,
        json!({"threadId": thread_id, "turnId": turn_id, "usage": usage})
    );
    missing_workspace_fails!(
        TurnWarningNotification,
        json!({
            "threadId": thread_id,
            "turnId": turn_id,
            "code": "providerManagedContinuationFallback"
        })
    );
    missing_workspace_fails!(
        TurnCompletedNotification,
        json!({
            "threadId": thread_id,
            "turn": {"id": turn_id, "status": "completed"}
        })
    );
    missing_workspace_fails!(
        CommandApprovalParams,
        json!({
            "approvalId": "approval/test",
            "threadId": thread_id,
            "turnId": turn_id,
            "callId": "call_test",
            "description": "Run a command",
            "command": "pwd",
            "arguments": [],
            "cwd": ".",
            "approvalScope": "command",
            "environmentPolicy": "hostInheritedV1",
            "sandboxed": true,
            "sandboxPolicy": "filesystemReadOnlyV1",
            "networkPolicy": "networkDeniedV1"
        })
    );
    missing_workspace_fails!(
        McpToolCallApprovalParams,
        json!({
            "approvalId": "approval/mcp",
            "threadId": thread_id,
            "turnId": turn_id,
            "callId": "call_mcp",
            "name": "server/tool",
            "arguments": {},
            "argumentsBytes": 2,
            "argumentsSha256": "0".repeat(64),
            "inventorySha256": "1".repeat(64)
        })
    );
}

#[test]
fn mcp_approval_protocol_is_provider_neutral_strict_and_json_capable() {
    let params = sugarcode_app_server_protocol::McpToolCallApprovalParams {
        approval_id: "approval/mcp".to_string(),
        workspace_id: "workspace-test".to_string(),
        thread_id: "00000000-0000-7000-8000-000000000001".to_string(),
        turn_id: "00000000-0001-7000-8000-000000000001".to_string(),
        call_id: "call_mcp".to_string(),
        name: "mcp__fixture__inspect".to_string(),
        arguments: json!({"array": [true, null, 7], "object": {"z": "value"}}),
        arguments_bytes: 52,
        arguments_sha256: "a".repeat(64),
        inventory_sha256: "b".repeat(64),
        source_agent: None,
    };
    let value = serde_json::to_value(&params).expect("params serialize");
    assert_eq!(value["name"], "mcp__fixture__inspect");
    assert_eq!(
        value["arguments"],
        json!({"array": [true, null, 7], "object": {"z": "value"}})
    );
    assert_eq!(
        serde_json::from_value::<sugarcode_app_server_protocol::McpToolCallApprovalParams>(
            value.clone()
        )
        .expect("round trip"),
        params
    );
    let mut unknown = value;
    unknown["serverExecutable"] = json!("/private/server");
    assert!(
        serde_json::from_value::<sugarcode_app_server_protocol::McpToolCallApprovalParams>(unknown)
            .is_err()
    );
    assert!(
        serde_json::from_value::<sugarcode_app_server_protocol::McpToolCallApprovalResponse>(
            json!({"decision": "approved", "remember": true})
        )
        .is_err()
    );
}

#[test]
fn mcp_approval_bidirectional_fixtures_match_public_types() {
    let request: serde_json::Value = serde_json::from_str(include_str!(
        "../../../protocol-fixtures/app-server/v1/mcp-tool-call-approval.request.json"
    ))
    .expect("request fixture");
    assert_eq!(request["method"], "item/mcpToolCall/requestApproval");
    serde_json::from_value::<sugarcode_app_server_protocol::McpToolCallApprovalParams>(
        request["params"].clone(),
    )
    .expect("request params fixture");

    let response: serde_json::Value = serde_json::from_str(include_str!(
        "../../../protocol-fixtures/app-server/v1/mcp-tool-call-approval.response.json"
    ))
    .expect("response fixture");
    assert_eq!(response["id"], request["id"]);
    assert_eq!(
        serde_json::from_value::<sugarcode_app_server_protocol::McpToolCallApprovalResponse>(
            response["result"].clone(),
        )
        .expect("response fixture")
        .decision,
        sugarcode_app_server_protocol::McpToolCallApprovalResponseDecision::Approved
    );
}

#[test]
fn mcp_items_keep_call_approval_attempt_and_result_distinct() {
    let items = [
        Item::McpToolCall {
            id: "00000000-0002-7000-8000-000000000001".to_string(),
            call_id: "call_mcp".to_string(),
            name: "mcp__fixture__inspect".to_string(),
            arguments: json!({"value": ["arbitrary", 2]}),
            arguments_bytes: 25,
            arguments_sha256: "a".repeat(64),
            inventory_sha256: "b".repeat(64),
        },
        Item::McpToolCallApprovalRequest {
            id: "00000000-0002-7000-8000-000000000002".to_string(),
            approval_id: "approval/mcp".to_string(),
            call_id: "call_mcp".to_string(),
            name: "mcp__fixture__inspect".to_string(),
            arguments: json!({"value": ["arbitrary", 2]}),
            arguments_bytes: 25,
            arguments_sha256: "a".repeat(64),
            inventory_sha256: "b".repeat(64),
        },
        Item::McpToolCallApprovalDecision {
            id: "00000000-0002-7000-8000-000000000003".to_string(),
            approval_id: "approval/mcp".to_string(),
            decision: "approved".to_string(),
        },
        Item::McpToolExecutionAttempt {
            id: "00000000-0002-7000-8000-000000000004".to_string(),
            approval_id: "approval/mcp".to_string(),
            call_id: "call_mcp".to_string(),
            inventory_sha256: "b".repeat(64),
        },
        Item::McpToolResult {
            id: "00000000-0002-7000-8000-000000000005".to_string(),
            call_id: "call_mcp".to_string(),
            name: "mcp__fixture__inspect".to_string(),
            result: sugarcode_app_server_protocol::McpToolResult::Completed {
                content: r#"{"isError":false,"text":["called"]}"#.to_string(),
                is_error: false,
                observed_bytes: 128,
                canonical_bytes: 39,
                retained_bytes: 39,
                truncated: false,
                sha256: "c".repeat(64),
                content_blocks: 1,
                structured_content: false,
            },
        },
    ];
    let types = items
        .iter()
        .map(|item| {
            let value = serde_json::to_value(item).expect("item serializes");
            let decoded = serde_json::from_value::<Item>(value.clone()).expect("item round trip");
            assert_eq!(&decoded, item);
            value["type"].as_str().expect("item type").to_string()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        types,
        [
            "mcpToolCall",
            "mcpToolCallApprovalRequest",
            "mcpToolCallApprovalDecision",
            "mcpToolExecutionAttempt",
            "mcpToolResult",
        ]
    );
}

#[test]
fn file_change_item_serializes_a_bounded_update_review() {
    let item = Item::FileChange {
        id: "00000000-0002-7000-8000-000000000003".to_string(),
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
fn context_compaction_item_exposes_receipts_without_summary_text() {
    let item = Item::ContextCompaction {
        id: "00000000-0002-7000-8000-000000000003".to_string(),
        strategy: ContextCompactionStrategy::ModelGeneratedActiveTurnV1,
        ordinal: 1,
        pre_context_bytes: 3_200_000,
        source_messages: 24,
        source_bytes: 2_700_000,
        source_sha256: "a".repeat(64),
        outcome: Some(ContextCompactionOutcome::Completed {
            post_context_bytes: 900_000,
            summary_bytes: 512,
            summary_sha256: "b".repeat(64),
        }),
    };
    let value = serde_json::to_value(&item).expect("compaction serializes");
    assert_eq!(value["type"], "contextCompaction");
    assert_eq!(value["strategy"], "modelGeneratedActiveTurnV1");
    assert_eq!(value["outcome"]["type"], "completed");
    assert!(value.get("summary").is_none());
    assert_eq!(
        serde_json::from_value::<Item>(value).expect("round trip"),
        item
    );
}

#[test]
fn collaboration_items_and_descendant_origin_are_provider_neutral() {
    let orchestration_id =
        "orch/00000000-0000-7000-8000-000000000001/00000000-0001-7000-8000-000000000001"
            .to_string();
    let task_id = format!("{orchestration_id}/writer");
    let items = vec![
        Item::AgentTask {
            id: "00000000-0002-7000-8000-000000000010".to_string(),
            orchestration_id: orchestration_id.clone(),
            task_id: task_id.clone(),
            client_task_key: "writer".to_string(),
            child_thread_id: "00000000-0000-7000-8000-000000000002".to_string(),
            title: "Implement the slice".to_string(),
            role: AgentTaskRole::Worker,
            access: AgentTaskAccess::WorkspaceWrite,
            depends_on: vec!["explore".to_string()],
            task_markdown: "# Objective\nImplement.".to_string(),
        },
        Item::AgentTaskAmendment {
            id: "00000000-0002-7000-8000-000000000011".to_string(),
            orchestration_id: orchestration_id.clone(),
            task_id: task_id.clone(),
            amendment_markdown: "Preserve the public boundary.".to_string(),
        },
        Item::AgentTaskResult {
            id: "00000000-0002-7000-8000-000000000012".to_string(),
            orchestration_id: orchestration_id.clone(),
            task_id: task_id.clone(),
            status: AgentTaskStatus::Completed,
            summary_markdown: "Implemented and verified.".to_string(),
            duration_ms: 1_250,
        },
    ];
    let descendant = ThreadResumeResponse {
        thread: Thread {
            id: "00000000-0000-7000-8000-000000000002".to_string(),
            workspace_id: "workspace-test".to_string(),
            title: None,
            origin: Some(ThreadOrigin::Subagent {
                parent_thread_id: "00000000-0000-7000-8000-000000000001".to_string(),
                parent_turn_id: "00000000-0001-7000-8000-000000000001".to_string(),
                orchestration_id: orchestration_id.clone(),
                task_id: task_id.clone(),
                role: AgentTaskRole::Worker,
            }),
        },
        turns: vec![TurnSnapshot {
            model: None,
            id: "00000000-0001-7000-8000-000000000002".to_string(),
            status: TurnSnapshotStatus::Completed,
            items: items.clone(),
            error: None,
            usage: None,
        }],
    };
    let value = serde_json::to_value(ThreadDescendantsListResponse {
        data: vec![descendant],
    })
    .expect("descendants serialize");
    assert_eq!(value["data"][0]["thread"]["origin"]["type"], "subagent");
    assert_eq!(value["data"][0]["thread"]["origin"]["role"], "worker");
    assert_eq!(
        value["data"][0]["turns"][0]["items"][0]["type"],
        "agentTask"
    );
    assert_eq!(
        serde_json::from_value::<ThreadDescendantsListResponse>(value)
            .expect("descendants round trip")
            .data
            .len(),
        1
    );
    assert_eq!(
        serde_json::from_value::<ThreadDescendantsListParams>(json!({
            "threadId": "00000000-0000-7000-8000-000000000001"
        }))
        .expect("canonical descendant params")
        .thread_id,
        "00000000-0000-7000-8000-000000000001"
    );
}

#[test]
fn descendant_list_bidirectional_fixtures_match_public_types() {
    let request: serde_json::Value = serde_json::from_str(include_str!(
        "../../../protocol-fixtures/app-server/v1/thread-descendants-list.request.json"
    ))
    .expect("descendants request fixture");
    assert_eq!(request["method"], "thread/descendants/list");
    serde_json::from_value::<ThreadDescendantsListParams>(request["params"].clone())
        .expect("descendants request params");

    let response: serde_json::Value = serde_json::from_str(include_str!(
        "../../../protocol-fixtures/app-server/v1/thread-descendants-list.response.json"
    ))
    .expect("descendants response fixture");
    assert_eq!(response["id"], request["id"]);
    let descendants =
        serde_json::from_value::<ThreadDescendantsListResponse>(response["result"].clone())
            .expect("descendants response");
    assert_eq!(descendants.data.len(), 1);
    assert!(matches!(
        descendants.data[0].thread.origin,
        Some(ThreadOrigin::Subagent {
            role: AgentTaskRole::Explorer,
            ..
        })
    ));
}

#[test]
fn thread_start_types_use_the_public_thread_dto() {
    let thread = Thread {
        id: "00000000-0000-7000-8000-000000000001".to_string(),
        workspace_id: "workspace-test".to_string(),
        title: None,
        origin: None,
    };

    assert_eq!(
        serde_json::to_value(ThreadStartResponse {
            thread: thread.clone(),
        })
        .expect("response serializes"),
        json!({
            "thread": {
                "id": "00000000-0000-7000-8000-000000000001",
                "workspaceId": "workspace-test"
            }
        })
    );
    assert_eq!(
        serde_json::to_value(ThreadStartedNotification { thread })
            .expect("notification serializes"),
        json!({
            "thread": {
                "id": "00000000-0000-7000-8000-000000000001",
                "workspaceId": "workspace-test"
            }
        })
    );
}

#[test]
fn thread_start_params_require_a_workspace_id() {
    assert!(
        serde_json::from_value::<ThreadStartParams>(json!({"workspaceId": "wsp_fixture"})).is_ok()
    );
    for invalid in [
        json!(null),
        json!([]),
        json!("invalid"),
        json!({"model": "not-supported-yet"}),
    ] {
        assert!(
            serde_json::from_value::<ThreadStartParams>(invalid).is_err(),
            "missing, unknown, or non-object params must be rejected"
        );
    }
}

#[test]
fn thread_archive_uses_a_canonical_thread_id_and_empty_response() {
    assert_eq!(
        serde_json::from_value::<ThreadArchiveParams>(json!({
            "threadId": "00000000-0000-7000-8000-000000000001"
        }))
        .expect("valid params"),
        ThreadArchiveParams {
            thread_id: "00000000-0000-7000-8000-000000000001".to_string()
        }
    );
    assert_eq!(
        serde_json::to_value(ThreadArchiveResponse {}).expect("response serializes"),
        json!({})
    );
    for invalid in [
        json!({}),
        json!({"threadId": ""}),
        json!({"threadId": "00000000-0000-4000-8000-000000000099"}),
        json!({"threadId": "../00000000-0000-7000-8000-000000000001"}),
        json!({"threadId": "00000000-0000-7000-8000-0000000000001"}),
        json!({"threadId": "00000000-0000-7000-8000-000000000001", "includeArchived": true}),
    ] {
        assert!(serde_json::from_value::<ThreadArchiveParams>(invalid).is_err());
    }
}

#[test]
fn thread_unarchive_uses_its_own_canonical_params_and_empty_response() {
    assert_eq!(
        serde_json::from_value::<ThreadUnarchiveParams>(json!({
            "threadId": "00000000-0000-7000-8000-000000000001"
        }))
        .expect("valid params"),
        ThreadUnarchiveParams {
            thread_id: "00000000-0000-7000-8000-000000000001".to_string()
        }
    );
    assert_eq!(
        serde_json::to_value(ThreadUnarchiveResponse {}).expect("response serializes"),
        json!({})
    );
    for invalid in [
        json!({}),
        json!({"threadId": ""}),
        json!({"threadId": "00000000-0000-4000-8000-000000000099"}),
        json!({"threadId": "../00000000-0000-7000-8000-000000000001"}),
        json!({"threadId": "00000000-0000-7000-8000-0000000000001"}),
        json!({"threadId": "00000000-0000-7000-8000-000000000001", "resume": true}),
    ] {
        assert!(serde_json::from_value::<ThreadUnarchiveParams>(invalid).is_err());
    }
}

#[test]
fn thread_delete_uses_its_own_canonical_params_and_empty_response() {
    assert_eq!(
        serde_json::from_value::<ThreadDeleteParams>(json!({
            "threadId": "00000000-0000-7000-8000-000000000001"
        }))
        .expect("valid params"),
        ThreadDeleteParams {
            thread_id: "00000000-0000-7000-8000-000000000001".to_string()
        }
    );
    assert_eq!(
        serde_json::to_value(ThreadDeleteResponse {}).expect("response serializes"),
        json!({})
    );
    for invalid in [
        json!({}),
        json!({"threadId": ""}),
        json!({"threadId": "00000000-0000-4000-8000-000000000099"}),
        json!({"threadId": "../00000000-0000-7000-8000-000000000001"}),
        json!({"threadId": "00000000-0000-7000-8000-0000000000001"}),
        json!({"threadId": "00000000-0000-7000-8000-000000000001", "purge": true}),
    ] {
        assert!(serde_json::from_value::<ThreadDeleteParams>(invalid).is_err());
    }
}

#[test]
fn thread_fork_uses_canonical_source_and_returns_a_complete_new_snapshot() {
    assert_eq!(
        serde_json::from_value::<ThreadForkParams>(json!({
            "threadId": "00000000-0000-7000-8000-000000000001"
        }))
        .expect("valid params"),
        ThreadForkParams {
            thread_id: "00000000-0000-7000-8000-000000000001".to_string()
        }
    );
    let response = ThreadForkResponse {
        thread: Thread {
            id: "00000000-0000-7000-8000-000000000002".to_string(),
            workspace_id: "workspace-test".to_string(),
            title: None,
            origin: None,
        },
        turns: vec![TurnSnapshot {
            model: None,
            id: "00000000-0001-7000-8000-000000000002".to_string(),
            status: TurnSnapshotStatus::Completed,
            items: vec![Item::AgentMessage {
                id: "00000000-0002-7000-8000-000000000002".to_string(),
                text: "SugarCode deterministic response.".to_string(),
            }],
            error: None,
            usage: None,
        }],
    };
    assert_eq!(
        serde_json::to_value(response).expect("response serializes"),
        json!({
            "thread": {
                "id": "00000000-0000-7000-8000-000000000002",
                "workspaceId": "workspace-test"
            },
            "turns": [{
                "id": "00000000-0001-7000-8000-000000000002",
                "status": "completed",
                "items": [{
                    "type": "agentMessage",
                    "id": "00000000-0002-7000-8000-000000000002",
                    "text": "SugarCode deterministic response."
                }]
            }]
        })
    );
    for invalid in [
        json!({}),
        json!({"threadId": ""}),
        json!({"threadId": "00000000-0000-4000-8000-000000000099"}),
        json!({"threadId": "../00000000-0000-7000-8000-000000000001"}),
        json!({"threadId": "00000000-0000-7000-8000-0000000000001"}),
        json!({"threadId": "00000000-0000-7000-8000-000000000001", "turnId": "turn_1"}),
        json!({"threadId": "00000000-0000-7000-8000-000000000001", "sourceThreadId": true}),
    ] {
        assert!(serde_json::from_value::<ThreadForkParams>(invalid).is_err());
    }
}

#[test]
fn thread_list_params_are_bounded_and_canonical() {
    assert_eq!(
        serde_json::from_value::<ThreadListParams>(json!({
            "workspaceId": "wsp_fixture",
            "cursor": "00000000-0000-7000-8000-000000000009",
            "limit": 25
        }))
        .expect("valid page"),
        ThreadListParams {
            workspace_id: "wsp_fixture".to_string(),
            cursor: Some("00000000-0000-7000-8000-000000000009".to_string()),
            limit: Some(25),
        }
    );
    for invalid in [
        json!(null),
        json!([]),
        json!({"limit": 0}),
        json!({"limit": 101}),
        json!({"workspaceId": "wsp_fixture", "cursor": "00000000-0000-4000-8000-000000000099"}),
        json!({"cursor": "00000000-0000-7000-8000-000000000009", "search": "later"}),
    ] {
        assert!(serde_json::from_value::<ThreadListParams>(invalid).is_err());
    }
}

#[test]
fn thread_list_response_contains_only_durable_identity_and_cursor() {
    assert_eq!(
        serde_json::to_value(ThreadListResponse {
            data: vec![Thread {
                id: "00000000-0000-7000-8000-000000000010".to_string(),
                workspace_id: "workspace-test".to_string(),
                title: Some("修复登录流程".to_string()),
                origin: None,
            }],
            next_cursor: Some("00000000-0000-7000-8000-000000000010".to_string()),
        })
        .expect("response serializes"),
        json!({
            "data": [{
                "id": "00000000-0000-7000-8000-000000000010",
                "workspaceId": "workspace-test",
                "title": "修复登录流程"
            }],
            "nextCursor": "00000000-0000-7000-8000-000000000010"
        })
    );
}

#[test]
fn thread_search_params_are_bounded_trimmed_and_canonical() {
    assert_eq!(
        serde_json::from_value::<ThreadSearchParams>(json!({
            "workspaceId": "wsp_fixture",
            "query": "  SugarCode release  ",
            "cursor": "00000000-0000-7000-8000-000000000009",
            "limit": 25
        }))
        .expect("valid search"),
        ThreadSearchParams {
            workspace_id: "wsp_fixture".to_string(),
            query: "SugarCode release".to_string(),
            cursor: Some("00000000-0000-7000-8000-000000000009".to_string()),
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
        json!({"workspaceId": "wsp_fixture", "query": "valid", "cursor": "00000000-0000-4000-8000-000000000099"}),
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
                id: "00000000-0000-7000-8000-000000000010".to_string(),
                workspace_id: "workspace-test".to_string(),
                title: Some("修复登录流程".to_string()),
                origin: None,
            }],
            next_cursor: Some("00000000-0000-7000-8000-000000000010".to_string()),
        })
        .expect("response serializes"),
        json!({
            "data": [{
                "id": "00000000-0000-7000-8000-000000000010",
                "workspaceId": "workspace-test",
                "title": "修复登录流程"
            }],
            "nextCursor": "00000000-0000-7000-8000-000000000010"
        })
    );
}

#[test]
fn turn_start_types_use_the_public_turn_dto() {
    let turn = Turn {
        model: Some(ModelSelectionSnapshot {
            profile_id: "model_primary".to_string(),
            provider_family: ModelProviderFamily::Openai,
            wire_api: ModelWireApi::OpenaiChatCompletions,
            model_id: "fixture-model".to_string(),
            display_name: "Fixture model".to_string(),
            context_window_tokens: 131_072,
            effective_capabilities: ModelSelectionCapabilities {
                tool_calls: true,
                strict_tools: true,
                parallel_tools: true,
                image_input: true,
                pdf_input: false,
            },
        }),
        id: "00000000-0001-7000-8000-000000000001".to_string(),
        status: TurnStatus::InProgress,
        error: None,
        usage: None,
    };

    assert_eq!(
        serde_json::to_value(TurnStartResponse { turn: turn.clone() })
            .expect("response serializes"),
        json!({
            "turn": {
                "id": "00000000-0001-7000-8000-000000000001",
                "model": {
                    "profileId": "model_primary",
                    "providerFamily": "openai",
                    "wireApi": "openaiChatCompletions",
                    "modelId": "fixture-model",
                    "displayName": "Fixture model",
                    "contextWindowTokens": 131072,
                    "effectiveCapabilities": {
                        "toolCalls": true,
                        "strictTools": true,
                        "parallelTools": true,
                        "imageInput": true,
                        "pdfInput": false
                    }
                },
                "status": "inProgress"
            }
        })
    );
    assert_eq!(
        serde_json::to_value(TurnStartedNotification {
            workspace_id: "workspace-test".to_string(),
            thread_id: "00000000-0000-7000-8000-000000000001".to_string(),
            turn,
        })
        .expect("notification serializes"),
        json!({
            "workspaceId": "workspace-test",
            "threadId": "00000000-0000-7000-8000-000000000001",
            "turn": {
                "id": "00000000-0001-7000-8000-000000000001",
                "model": {
                    "profileId": "model_primary",
                    "providerFamily": "openai",
                    "wireApi": "openaiChatCompletions",
                    "modelId": "fixture-model",
                    "displayName": "Fixture model",
                    "contextWindowTokens": 131072,
                    "effectiveCapabilities": {
                        "toolCalls": true,
                        "strictTools": true,
                        "parallelTools": true,
                        "imageInput": true,
                        "pdfInput": false
                    }
                },
                "status": "inProgress"
            }
        })
    );
}

#[test]
fn agent_message_item_lifecycle_types_preserve_correlation_and_text() {
    let thread_id = "00000000-0000-7000-8000-000000000001".to_string();
    let turn_id = "00000000-0001-7000-8000-000000000001".to_string();
    let item_id = "00000000-0002-7000-8000-000000000001".to_string();
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
            workspace_id: "workspace-test".to_string(),
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            item: started_item,
            agent_output: None,
        })
        .expect("item/started serializes"),
        json!({
            "workspaceId": "workspace-test",
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
            workspace_id: "workspace-test".to_string(),
            thread_id: "00000000-0000-7000-8000-000000000001".to_string(),
            turn_id: "00000000-0001-7000-8000-000000000001".to_string(),
            item_id: "00000000-0002-7000-8000-000000000001".to_string(),
            delta: "SugarCode deterministic response.".to_string(),
        })
        .expect("agent message delta serializes"),
        json!({
            "workspaceId": "workspace-test",
            "threadId": "00000000-0000-7000-8000-000000000001",
            "turnId": "00000000-0001-7000-8000-000000000001",
            "itemId": "00000000-0002-7000-8000-000000000001",
            "delta": "SugarCode deterministic response."
        })
    );
    assert_eq!(
        serde_json::to_value(ItemCompletedNotification {
            workspace_id: "workspace-test".to_string(),
            thread_id: "00000000-0000-7000-8000-000000000001".to_string(),
            turn_id: "00000000-0001-7000-8000-000000000001".to_string(),
            item: completed_item,
        })
        .expect("item/completed serializes"),
        json!({
            "workspaceId": "workspace-test",
            "threadId": "00000000-0000-7000-8000-000000000001",
            "turnId": "00000000-0001-7000-8000-000000000001",
            "item": {
                "type": "agentMessage",
                "id": "00000000-0002-7000-8000-000000000001",
                "text": "SugarCode deterministic response."
            }
        })
    );
    assert_eq!(
        serde_json::to_value(TurnCompletedNotification {
            workspace_id: "workspace-test".to_string(),
            thread_id: "00000000-0000-7000-8000-000000000001".to_string(),
            turn: Turn {
                model: None,
                id: "00000000-0001-7000-8000-000000000001".to_string(),
                status: TurnStatus::Completed,
                error: None,
                usage: None,
            },
        })
        .expect("turn/completed serializes"),
        json!({
            "workspaceId": "workspace-test",
            "threadId": "00000000-0000-7000-8000-000000000001",
            "turn": {
                "id": "00000000-0001-7000-8000-000000000001",
                "status": "completed"
            }
        })
    );
}

#[test]
fn provisional_agent_output_fixture_is_additive_and_provider_neutral() {
    let fixture = include_str!(
        "../../../protocol-fixtures/app-server/v1/agent-output-delta.notification.json"
    );
    let value: serde_json::Value = serde_json::from_str(fixture).expect("valid fixture JSON");
    let params = value.get("params").cloned().expect("notification params");
    assert_eq!(
        serde_json::from_value::<AgentOutputDeltaNotification>(params)
            .expect("Agent output notification"),
        AgentOutputDeltaNotification {
            workspace_id: "workspace-test".to_string(),
            thread_id: "00000000-0000-7000-8000-000000000001".to_string(),
            turn_id: "00000000-0001-7000-8000-000000000001".to_string(),
            output: AgentOutputRef {
                response_ordinal: 2,
                output_index: 0,
            },
            delta: "Inspecting the workspace".to_string(),
        }
    );
}

#[test]
fn discarded_agent_output_fixture_closes_a_provider_neutral_preview() {
    let fixture = include_str!(
        "../../../protocol-fixtures/app-server/v1/agent-output-discarded.notification.json"
    );
    let value: serde_json::Value = serde_json::from_str(fixture).expect("valid fixture JSON");
    let params = value.get("params").cloned().expect("notification params");
    assert_eq!(
        serde_json::from_value::<AgentOutputDiscardedNotification>(params)
            .expect("discarded Agent output notification"),
        AgentOutputDiscardedNotification {
            workspace_id: "workspace-test".to_string(),
            thread_id: "00000000-0000-7000-8000-000000000001".to_string(),
            turn_id: "00000000-0001-7000-8000-000000000001".to_string(),
            output: AgentOutputRef {
                response_ordinal: 1,
                output_index: 0,
            },
        }
    );
}

#[test]
fn agent_commentary_item_lifecycle_preserves_process_text() {
    let item = Item::AgentCommentary {
        id: "00000000-0002-7000-8000-000000000002".to_string(),
        text: "I will inspect the workspace first.".to_string(),
    };

    assert_eq!(
        serde_json::to_value(ItemStartedNotification {
            workspace_id: "workspace-test".to_string(),
            thread_id: "00000000-0000-7000-8000-000000000001".to_string(),
            turn_id: "00000000-0001-7000-8000-000000000001".to_string(),
            item: item.clone(),
            agent_output: None,
        })
        .expect("commentary item/started serializes"),
        json!({
            "workspaceId": "workspace-test",
            "threadId": "00000000-0000-7000-8000-000000000001",
            "turnId": "00000000-0001-7000-8000-000000000001",
            "item": {
                "type": "agentCommentary",
                "id": "00000000-0002-7000-8000-000000000002",
                "text": "I will inspect the workspace first."
            }
        })
    );
    assert_eq!(
        serde_json::from_value::<Item>(
            serde_json::to_value(item.clone()).expect("commentary serializes")
        )
        .expect("commentary round trip"),
        item
    );
}

#[test]
fn tool_items_use_provider_neutral_camel_case_public_fields() {
    assert_eq!(
        serde_json::to_value(Item::ToolCall {
            id: "00000000-0002-7000-8000-000000000002".to_string(),
            call_id: "call_1".to_string(),
            name: "workspace/read".to_string(),
            arguments: json!({"path": "README.txt"}),
        })
        .expect("tool call serializes"),
        json!({
            "type": "toolCall",
            "id": "00000000-0002-7000-8000-000000000002",
            "callId": "call_1",
            "name": "workspace/read",
            "arguments": {"path": "README.txt"}
        })
    );
    assert_eq!(
        serde_json::to_value(Item::ToolCall {
            id: "00000000-0002-7000-8000-000000000004".to_string(),
            call_id: "call_2".to_string(),
            name: "workspace/search".to_string(),
            arguments: json!({"path": "src", "query": "needle"}),
        })
        .expect("search tool call serializes"),
        json!({
            "type": "toolCall",
            "id": "00000000-0002-7000-8000-000000000004",
            "callId": "call_2",
            "name": "workspace/search",
            "arguments": {"path": "src", "query": "needle"}
        })
    );
    assert_eq!(
        serde_json::to_value(Item::ToolResult {
            id: "00000000-0002-7000-8000-000000000003".to_string(),
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
            "id": "00000000-0002-7000-8000-000000000003",
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
fn tool_validation_rejection_is_a_distinct_diagnostic_item() {
    let item = Item::ToolValidationRejected {
        id: "00000000-0002-7000-8000-000000000003".to_string(),
        call_id: "call_edit".to_string(),
        name: "workspace/edit".to_string(),
        kind: "expectedMismatch".to_string(),
        arguments_bytes: 128,
        arguments_sha256: "a".repeat(64),
        edit_index: Some(2),
        hunk_index: None,
        line: Some(7),
        expected_summary: Some("bytes=3 sha256=bbbb".to_string()),
        actual_summary: Some("bytes=4 sha256=cccc".to_string()),
        suggested_action: "Refresh the file and retry the edit.".to_string(),
    };
    assert_eq!(
        serde_json::to_value(item).expect("validation item serializes"),
        json!({
            "type": "toolValidationRejected",
            "id": "00000000-0002-7000-8000-000000000003",
            "callId": "call_edit",
            "name": "workspace/edit",
            "kind": "expectedMismatch",
            "argumentsBytes": 128,
            "argumentsSha256": "a".repeat(64),
            "editIndex": 2,
            "line": 7,
            "expectedSummary": "bytes=3 sha256=bbbb",
            "actualSummary": "bytes=4 sha256=cccc",
            "suggestedAction": "Refresh the file and retry the edit."
        })
    );
}

#[test]
fn shell_approval_and_process_results_are_provider_neutral() {
    assert_eq!(
        serde_json::to_value(Item::CommandApprovalRequest {
            id: "00000000-0002-7000-8000-000000000003".to_string(),
            approval_id: "approval/one".to_string(),
            call_id: "call_shell".to_string(),
            command: "/bin/echo".to_string(),
            arguments: vec!["ok".to_string()],
            cwd: ".".to_string(),
            environment_policy: "minimalV1".to_string(),
            sandboxed: true,
            sandbox_policy: Some(CommandSandboxPolicy::FilesystemReadOnlyV1),
            workspace_write_policy: Some(CommandWorkspaceWritePolicy::CommandWorkspaceWriteV1,),
            network_policy: Some(CommandNetworkPolicy::NetworkDeniedV1),
            workspace_write_risk: Some(CommandWorkspaceWriteRisk::NonTransactionalWorkspaceTreeV1,),
        })
        .expect("approval request serializes"),
        json!({
            "type": "commandApprovalRequest",
            "id": "00000000-0002-7000-8000-000000000003",
            "approvalId": "approval/one",
            "callId": "call_shell",
            "command": "/bin/echo",
            "arguments": ["ok"],
            "cwd": ".",
            "environmentPolicy": "minimalV1",
            "sandboxed": true,
            "sandboxPolicy": "filesystemReadOnlyV1",
            "workspaceWritePolicy": "commandWorkspaceWriteV1",
            "networkPolicy": "networkDeniedV1",
            "workspaceWriteRisk": "nonTransactionalWorkspaceTreeV1"
        })
    );
    assert_eq!(
        serde_json::to_value(Item::CommandApprovalDecision {
            id: "00000000-0002-7000-8000-000000000004".to_string(),
            approval_id: "approval/one".to_string(),
            decision: "approved".to_string(),
            workspace_write_risk_acknowledgement: Some(
                CommandWorkspaceWriteRisk::NonTransactionalWorkspaceTreeV1,
            ),
        })
        .expect("approval decision serializes"),
        json!({
            "type": "commandApprovalDecision",
            "id": "00000000-0002-7000-8000-000000000004",
            "approvalId": "approval/one",
            "decision": "approved",
            "workspaceWriteRiskAcknowledgement": "nonTransactionalWorkspaceTreeV1"
        })
    );
    assert_eq!(
        serde_json::to_value(Item::CommandExecutionAttempt {
            id: "00000000-0002-7000-8000-000000000005".to_string(),
            approval_id: "approval/one".to_string(),
            call_id: "call_shell".to_string(),
        })
        .expect("execution attempt serializes"),
        json!({
            "type": "commandExecutionAttempt",
            "id": "00000000-0002-7000-8000-000000000005",
            "approvalId": "approval/one",
            "callId": "call_shell"
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
            workspace_write_policy: Some(CommandWorkspaceWritePolicy::CommandWorkspaceWriteV1,),
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
            "workspaceWritePolicy": "commandWorkspaceWriteV1",
            "networkPolicy": "networkDeniedV1"
        })
    );
}

#[test]
fn turn_start_params_require_thread_id_and_accept_ordered_content_input() {
    assert_eq!(
        serde_json::from_value::<TurnStartParams>(json!({
            "threadId": "00000000-0000-7000-8000-000000000001",
            "input": [{"type": "text", "text": "Hello"}],
            "modelProfileId": "model_primary"
        }))
        .expect("valid params"),
        TurnStartParams {
            model_profile_id: Some("model_primary".to_string()),
            thread_id: "00000000-0000-7000-8000-000000000001".to_string(),
            input: Some(vec![sugarcode_app_server_protocol::TurnInputPart::Text {
                text: "Hello".to_string(),
            }]),
        }
    );
    assert_eq!(
        serde_json::from_value::<TurnStartParams>(json!({
            "threadId": "00000000-0000-7000-8000-000000000001"
        }))
        .expect("optional input"),
        TurnStartParams {
            model_profile_id: None,
            thread_id: "00000000-0000-7000-8000-000000000001".to_string(),
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
        json!({"threadId": "00000000-0000-7000-8000-000000000001", "input": []}),
        json!({"threadId": "00000000-0000-7000-8000-000000000001", "modelProfileId": ""}),
        json!({"threadId": "00000000-0000-7000-8000-000000000001", "modelProfileId": "bad id"}),
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
            "threadId": "00000000-0000-7000-8000-000000000001",
            "turnId": "00000000-0001-7000-8000-000000000001"
        }))
        .expect("valid interrupt"),
        TurnInterruptParams {
            thread_id: "00000000-0000-7000-8000-000000000001".to_string(),
            turn_id: "00000000-0001-7000-8000-000000000001".to_string(),
        }
    );
    assert!(
        serde_json::from_value::<TurnInterruptParams>(json!({
            "threadId": "00000000-0000-7000-8000-000000000001",
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
            model: None,
            id: "00000000-0001-7000-8000-000000000001".to_string(),
            status: TurnStatus::Failed,
            error: Some(TurnError {
                kind: TurnErrorKind::RateLimited,
                retryable: true,
                provider: None,
                protocol: Some(ModelProtocolDiagnostic {
                    stage: ModelProtocolStage::OutputNormalization,
                    code: ModelProtocolCode::AmbiguousOutputReconciliation,
                    event_type: Some("response.completed".to_string()),
                    shape_sha256: "a".repeat(64),
                }),
                tool_schema: None,
            }),
            usage: None,
        })
        .expect("failed turn"),
        json!({
            "id": "00000000-0001-7000-8000-000000000001",
            "status": "failed",
            "error": {
                "kind": "rateLimited",
                "retryable": true,
                "protocol": {
                    "stage": "outputNormalization",
                    "code": "ambiguousOutputReconciliation",
                    "eventType": "response.completed",
                    "shapeSha256": "a".repeat(64)
                }
            }
        })
    );
}

#[test]
fn protocol_error_fixture_is_provider_neutral_and_additive() {
    let fixture = include_str!("../../../protocol-fixtures/app-server/v1/turn-protocol-error.json");
    let error: TurnError = serde_json::from_str(fixture).expect("protocol error fixture");
    assert_eq!(error.kind, TurnErrorKind::Protocol);
    let diagnostic = error.protocol.expect("protocol diagnostic");
    assert_eq!(diagnostic.stage, ModelProtocolStage::ResponseAssembly);
    assert_eq!(diagnostic.code, ModelProtocolCode::OutputIndexMismatch);
    assert_eq!(diagnostic.event_type.as_deref(), Some("response.completed"));
    assert_eq!(diagnostic.shape_sha256, "c".repeat(64));
}

#[test]
fn token_usage_and_continuation_fallback_warning_are_provider_neutral() {
    let sample = TokenUsageSample {
        input_tokens: Some(60_000),
        cached_input_tokens: Some(2_000),
        output_tokens: Some(1_000),
        reasoning_tokens: Some(800),
        total_tokens: Some(61_000),
    };
    assert_eq!(
        serde_json::to_value(TokenUsageUpdatedNotification {
            workspace_id: "workspace-test".to_string(),
            thread_id: "00000000-0000-7000-8000-000000000001".to_string(),
            turn_id: "00000000-0001-7000-8000-000000000001".to_string(),
            usage: TokenUsage {
                last_request: sample,
                turn_total: sample,
                request_count: 2,
                context_window_tokens: 200_000,
                source: TokenUsageSource::Provider,
            },
        })
        .expect("usage notification"),
        json!({
            "workspaceId": "workspace-test",
            "threadId": "00000000-0000-7000-8000-000000000001",
            "turnId": "00000000-0001-7000-8000-000000000001",
            "usage": {
                "lastRequest": {
                    "inputTokens": 60_000,
                    "cachedInputTokens": 2_000,
                    "outputTokens": 1_000,
                    "reasoningTokens": 800,
                    "totalTokens": 61_000
                },
                "turnTotal": {
                    "inputTokens": 60_000,
                    "cachedInputTokens": 2_000,
                    "outputTokens": 1_000,
                    "reasoningTokens": 800,
                    "totalTokens": 61_000
                },
                "requestCount": 2,
                "contextWindowTokens": 200_000,
                "source": "provider"
            }
        })
    );
    assert_eq!(
        serde_json::to_value(TurnWarningNotification {
            workspace_id: "workspace-test".to_string(),
            thread_id: "00000000-0000-7000-8000-000000000001".to_string(),
            turn_id: "00000000-0001-7000-8000-000000000001".to_string(),
            code: TurnWarningCode::ProviderManagedContinuationFallback,
        })
        .expect("warning notification"),
        json!({
            "workspaceId": "workspace-test",
            "threadId": "00000000-0000-7000-8000-000000000001",
            "turnId": "00000000-0001-7000-8000-000000000001",
            "code": "providerManagedContinuationFallback"
        })
    );
    assert_eq!(
        serde_json::to_value(TurnWarningNotification {
            workspace_id: "workspace-test".to_string(),
            thread_id: "00000000-0000-7000-8000-000000000001".to_string(),
            turn_id: "00000000-0001-7000-8000-000000000001".to_string(),
            code: TurnWarningCode::HistoricalContextDowngraded,
        })
        .expect("historical downgrade warning"),
        json!({
            "workspaceId": "workspace-test",
            "threadId": "00000000-0000-7000-8000-000000000001",
            "turnId": "00000000-0001-7000-8000-000000000001",
            "code": "historicalContextDowngraded"
        })
    );
}

#[test]
fn thread_resume_returns_a_complete_snapshot() {
    let response = ThreadResumeResponse {
        thread: Thread {
            id: "00000000-0000-7000-8000-000000000001".to_string(),
            workspace_id: "workspace-test".to_string(),
            title: None,
            origin: None,
        },
        turns: vec![TurnSnapshot {
            model: None,
            id: "00000000-0001-7000-8000-000000000001".to_string(),
            status: TurnSnapshotStatus::Completed,
            items: vec![Item::AgentMessage {
                id: "00000000-0002-7000-8000-000000000001".to_string(),
                text: "SugarCode deterministic response.".to_string(),
            }],
            error: None,
            usage: None,
        }],
    };
    assert_eq!(
        serde_json::to_value(response).expect("response serializes"),
        json!({
            "thread": {
                "id": "00000000-0000-7000-8000-000000000001",
                "workspaceId": "workspace-test"
            },
            "turns": [{
                "id": "00000000-0001-7000-8000-000000000001",
                "status": "completed",
                "items": [{
                    "type": "agentMessage",
                    "id": "00000000-0002-7000-8000-000000000001",
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
            "workspaceId": "wsp_fixture",
            "threadId": "00000000-0000-7000-8000-000000000001"
        }))
        .expect("valid params"),
        ThreadResumeParams {
            thread_id: "00000000-0000-7000-8000-000000000001".to_string(),
            workspace_id: "wsp_fixture".to_string(),
        }
    );
    for invalid in [
        json!({}),
        json!({"threadId": ""}),
        json!({"workspaceId": "wsp_fixture", "threadId": "00000000-0000-4000-8000-000000000099"}),
        json!({"threadId": "../00000000-0000-7000-8000-000000000001"}),
        json!({"threadId": "00000000-0000-7000-8000-0000000000001"}),
        json!({"threadId": "00000000-0000-7000-8000-000000000001", "path": "/tmp"}),
    ] {
        assert!(serde_json::from_value::<ThreadResumeParams>(invalid).is_err());
    }
}
