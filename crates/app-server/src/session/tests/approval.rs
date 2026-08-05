use super::*;
use sugarcode_agent_runtime::PendingCommandApproval;
use sugarcode_agent_runtime::PendingMcpToolApproval;
use sugarcode_core::CommandApprovalOutcome;
use sugarcode_core::CommandApprovalRequest;
use sugarcode_core::McpToolApprovalOutcome;
use sugarcode_core::McpToolApprovalRequest;
use tokio::sync::oneshot;

#[tokio::test]
async fn command_approval_request_correlates_one_client_response() {
    let mut session = approval_ready_session();
    let (response, receiver) = oneshot::channel();
    let mut command_request = request("approval/one");
    command_request.workspace_write_policy =
        Some(sugarcode_protocol::CoreCommandWorkspaceWritePolicy::CommandWorkspaceWriteV1);
    command_request.workspace_write_risk =
        Some(sugarcode_protocol::CoreCommandWorkspaceWriteRisk::NonTransactionalWorkspaceTreeV1);
    let message = session
        .process_approval_request(PendingCommandApproval {
            request: command_request,
            response,
        })
        .expect("server request");
    let JsonRpcMessage::Request(request) = message else {
        panic!("expected server request");
    };
    assert_eq!(request.id, RequestId::String("approval/one".to_string()));
    assert_eq!(request.method, "item/commandExecution/requestApproval");
    assert_eq!(
        request
            .params
            .as_ref()
            .and_then(|params| params.get("sandboxed"))
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        request
            .params
            .as_ref()
            .and_then(|params| params.get("sandboxPolicy"))
            .and_then(Value::as_str),
        Some("filesystemReadOnlyV1")
    );
    assert_eq!(
        request
            .params
            .as_ref()
            .and_then(|params| params.get("workspaceWritePolicy"))
            .and_then(Value::as_str),
        Some("commandWorkspaceWriteV1")
    );
    assert_eq!(
        request
            .params
            .as_ref()
            .and_then(|params| params.get("workspaceWriteRisk"))
            .and_then(Value::as_str),
        Some("nonTransactionalWorkspaceTreeV1")
    );
    assert_eq!(
        request
            .params
            .as_ref()
            .and_then(|params| params.get("networkPolicy"))
            .and_then(Value::as_str),
        Some("networkDeniedV1")
    );

    assert!(
        session
            .process_line(
                r#"{"jsonrpc":"2.0","id":"approval/one","result":{"decision":"approved","workspaceWriteRiskAcknowledgement":"nonTransactionalWorkspaceTreeV1"}}"#,
            )
            .is_empty()
    );
    assert_eq!(
        receiver.await.expect("approval response"),
        CommandApprovalOutcome::Approved
    );
    assert!(
        session
            .process_line(
                r#"{"jsonrpc":"2.0","id":"approval/one","result":{"decision":"denied"}}"#,
            )
            .is_empty()
    );
}

#[tokio::test]
async fn client_without_capability_never_receives_approval_request() {
    let mut session = ready_session(Core::new());
    let (response, receiver) = oneshot::channel();
    assert!(
        session
            .process_approval_request(PendingCommandApproval {
                request: request("approval/unsupported"),
                response,
            })
            .is_none()
    );
    assert_eq!(
        receiver.await.expect("unsupported response"),
        CommandApprovalOutcome::Unsupported
    );
}

#[tokio::test]
async fn workspace_write_requires_separate_client_capability() {
    let mut session = command_approval_only_session();
    let (response, receiver) = oneshot::channel();
    let mut command_request = request("approval/write-unsupported");
    command_request.workspace_write_policy =
        Some(sugarcode_protocol::CoreCommandWorkspaceWritePolicy::CommandWorkspaceWriteV1);
    command_request.workspace_write_risk =
        Some(sugarcode_protocol::CoreCommandWorkspaceWriteRisk::NonTransactionalWorkspaceTreeV1);

    assert!(
        session
            .process_approval_request(PendingCommandApproval {
                request: command_request,
                response,
            })
            .is_none()
    );
    assert_eq!(
        receiver.await.expect("unsupported response"),
        CommandApprovalOutcome::Unsupported
    );
}

#[tokio::test]
async fn workspace_write_policy_and_risk_must_be_present_together() {
    for (policy, risk) in [
        (
            Some(sugarcode_protocol::CoreCommandWorkspaceWritePolicy::CommandWorkspaceWriteV1),
            None,
        ),
        (
            None,
            Some(
                sugarcode_protocol::CoreCommandWorkspaceWriteRisk::NonTransactionalWorkspaceTreeV1,
            ),
        ),
    ] {
        let mut session = approval_ready_session();
        let (response, receiver) = oneshot::channel();
        let mut command_request = request("approval/inconsistent");
        command_request.workspace_write_policy = policy;
        command_request.workspace_write_risk = risk;
        assert!(
            session
                .process_approval_request(PendingCommandApproval {
                    request: command_request,
                    response,
                })
                .is_none()
        );
        assert_eq!(
            receiver.await.expect("unsupported response"),
            CommandApprovalOutcome::Unsupported
        );
    }
}

#[tokio::test]
async fn workspace_write_approval_without_exact_risk_acknowledgement_is_denied() {
    for result in [
        r#"{"decision":"approved"}"#,
        r#"{"decision":"approved","workspaceWriteRiskAcknowledgement":"unknownRiskV1"}"#,
    ] {
        let mut session = approval_ready_session();
        let (response, receiver) = oneshot::channel();
        let mut command_request = request("approval/write-risk");
        command_request.workspace_write_policy =
            Some(sugarcode_protocol::CoreCommandWorkspaceWritePolicy::CommandWorkspaceWriteV1);
        command_request.workspace_write_risk = Some(
            sugarcode_protocol::CoreCommandWorkspaceWriteRisk::NonTransactionalWorkspaceTreeV1,
        );
        assert!(
            session
                .process_approval_request(PendingCommandApproval {
                    request: command_request,
                    response,
                })
                .is_some()
        );

        let response_line =
            format!(r#"{{"jsonrpc":"2.0","id":"approval/write-risk","result":{result}}}"#);
        assert!(session.process_line(&response_line).is_empty());
        assert_eq!(
            receiver.await.expect("approval response"),
            CommandApprovalOutcome::Denied
        );
    }
}

#[tokio::test]
async fn read_only_approval_remains_backward_compatible_without_risk_acknowledgement() {
    let mut session = command_approval_only_session();
    let (response, receiver) = oneshot::channel();
    assert!(
        session
            .process_approval_request(PendingCommandApproval {
                request: request("approval/read-only"),
                response,
            })
            .is_some()
    );
    assert!(
        session
            .process_line(
                r#"{"jsonrpc":"2.0","id":"approval/read-only","result":{"decision":"approved"}}"#,
            )
            .is_empty()
    );
    assert_eq!(
        receiver.await.expect("approval response"),
        CommandApprovalOutcome::Approved
    );
}

#[tokio::test]
async fn mcp_approval_requires_explicit_client_capability() {
    let capability = sugarcode_core::McpToolCapability::default();
    let mut session = Session::with_core_and_mcp_capability(Core::new(), capability.clone());
    assert_eq!(session.process_line(&initialize_line(1)).len(), 1);
    assert!(
        session
            .process_line(r#"{"jsonrpc":"2.0","method":"initialized"}"#)
            .is_empty()
    );
    assert!(!capability.is_enabled());

    let (response, receiver) = oneshot::channel();
    assert!(
        session
            .process_mcp_approval_request(PendingMcpToolApproval {
                request: mcp_request("approval/mcp-hidden"),
                response,
            })
            .is_none()
    );
    assert_eq!(
        receiver.await.expect("unsupported response"),
        McpToolApprovalOutcome::Unsupported
    );
}

#[tokio::test]
async fn mcp_approval_correlates_exact_request_and_defaults_malformed_response_to_deny() {
    for (result, expected) in [
        (
            r#"{"decision":"approved"}"#,
            McpToolApprovalOutcome::Approved,
        ),
        (
            r#"{"decision":"approved","unexpected":true}"#,
            McpToolApprovalOutcome::Denied,
        ),
    ] {
        let capability = sugarcode_core::McpToolCapability::default();
        let mut session = Session::with_core_and_mcp_capability(Core::new(), capability.clone());
        assert_eq!(
            session
                .process_line(
                    r#"{"jsonrpc":"2.0","id":"init-mcp","method":"initialize","params":{"protocolVersion":1,"clientInfo":{"name":"test-client","version":"1.0.0"},"capabilities":{"mcpToolCallApprovals":true}}}"#,
                )
                .len(),
            1
        );
        assert!(
            session
                .process_line(r#"{"jsonrpc":"2.0","method":"initialized"}"#)
                .is_empty()
        );
        assert!(capability.is_enabled());

        let (response, receiver) = oneshot::channel();
        let message = session
            .process_mcp_approval_request(PendingMcpToolApproval {
                request: mcp_request("approval/mcp-one"),
                response,
            })
            .expect("server request");
        let JsonRpcMessage::Request(request) = message else {
            panic!("expected server request");
        };
        assert_eq!(
            request.id,
            RequestId::String("approval/mcp-one".to_string())
        );
        assert_eq!(request.method, "item/mcpToolCall/requestApproval");
        let params = request.params.expect("approval params");
        assert_eq!(params["name"], "mcp__fixture__inspect");
        assert_eq!(params["arguments"], json!({"value": ["arbitrary", 2]}));
        assert_eq!(params["argumentsBytes"], 25);
        assert_eq!(params["argumentsSha256"], "a".repeat(64));
        assert_eq!(params["inventorySha256"], "b".repeat(64));

        let line = format!(r#"{{"jsonrpc":"2.0","id":"approval/mcp-one","result":{result}}}"#);
        assert!(session.process_line(&line).is_empty());
        assert_eq!(receiver.await.expect("approval response"), expected);
    }
}

fn approval_ready_session() -> Session<Core> {
    let mut session = Session::new();
    assert_eq!(
        session
            .process_line(
                r#"{"jsonrpc":"2.0","id":"init-approval","method":"initialize","params":{"protocolVersion":1,"clientInfo":{"name":"test-client","version":"1.0.0"},"capabilities":{"commandApprovals":true,"commandWorkspaceWriteApprovals":true}}}"#,
            )
            .len(),
        1
    );
    assert!(
        session
            .process_line(r#"{"jsonrpc":"2.0","method":"initialized"}"#)
            .is_empty()
    );
    session
}

fn command_approval_only_session() -> Session<Core> {
    let mut session = Session::new();
    assert_eq!(
        session
            .process_line(
                r#"{"jsonrpc":"2.0","id":"init-approval","method":"initialize","params":{"protocolVersion":1,"clientInfo":{"name":"test-client","version":"1.0.0"},"capabilities":{"commandApprovals":true}}}"#,
            )
            .len(),
        1
    );
    assert!(
        session
            .process_line(r#"{"jsonrpc":"2.0","method":"initialized"}"#)
            .is_empty()
    );
    session
}

fn request(approval_id: &str) -> CommandApprovalRequest {
    CommandApprovalRequest {
        approval_id: approval_id.to_string(),
        thread_id: ThreadId::parse("00000000-0000-7000-8000-000000000001")
            .expect("valid thread UUIDv7"),
        turn_id: TurnId::parse("00000000-0001-7000-8000-000000000001").expect("valid turn UUIDv7"),
        call_id: "call_1".to_string(),
        description: "Print a greeting.".to_string(),
        command: if cfg!(windows) {
            r"C:\Windows\System32\cmd.exe".to_string()
        } else {
            "/bin/echo".to_string()
        },
        arguments: vec!["hello".to_string()],
        cwd: ".".to_string(),
        environment_policy: "minimalV1".to_string(),
        sandboxed: true,
        sandbox_policy: Some(sugarcode_protocol::CoreCommandSandboxPolicy::FilesystemReadOnlyV1),
        workspace_write_policy: None,
        workspace_write_risk: None,
        network_policy: Some(sugarcode_protocol::CoreCommandNetworkPolicy::NetworkDeniedV1),
    }
}

fn mcp_request(approval_id: &str) -> McpToolApprovalRequest {
    McpToolApprovalRequest {
        approval_id: approval_id.to_string(),
        thread_id: ThreadId::parse("00000000-0000-7000-8000-000000000001")
            .expect("valid thread UUIDv7"),
        turn_id: TurnId::parse("00000000-0001-7000-8000-000000000001").expect("valid turn UUIDv7"),
        call_id: "call_mcp".to_string(),
        name: "mcp__fixture__inspect".to_string(),
        arguments: json!({"value": ["arbitrary", 2]}),
        arguments_bytes: 25,
        arguments_sha256: "a".repeat(64),
        inventory_sha256: "b".repeat(64),
    }
}
