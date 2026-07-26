use super::*;
use crate::approval::PendingCommandApproval;
use sugarcode_core::CommandApprovalOutcome;
use sugarcode_core::CommandApprovalRequest;
use tokio::sync::oneshot;

#[tokio::test]
async fn command_approval_request_correlates_one_client_response() {
    let mut session = approval_ready_session();
    let (response, receiver) = oneshot::channel();
    let message = session
        .process_approval_request(PendingCommandApproval {
            request: request("approval/one"),
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

    assert!(
        session
            .process_line(
                r#"{"jsonrpc":"2.0","id":"approval/one","result":{"decision":"approved"}}"#,
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

fn approval_ready_session() -> Session<Core> {
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
        thread_id: ThreadId::new("thr_0000000000000001"),
        turn_id: TurnId::new("turn_0000000000000001"),
        call_id: "call_1".to_string(),
        command: if cfg!(windows) {
            r"C:\Windows\System32\cmd.exe".to_string()
        } else {
            "/bin/echo".to_string()
        },
        arguments: vec!["hello".to_string()],
        cwd: ".".to_string(),
        environment_policy: "minimalV1".to_string(),
        sandboxed: true,
        sandbox_policy: sugarcode_protocol::CoreCommandSandboxPolicy::FilesystemReadOnlyV1,
    }
}
