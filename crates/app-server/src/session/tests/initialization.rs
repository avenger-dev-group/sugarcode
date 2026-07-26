use super::*;

#[test]
fn initialization_requires_acknowledgement() {
    let mut session = Session::new();
    assert_eq!(session.process_line(&initialize_line(1)).len(), 1);
    assert_eq!(session.state(), SessionState::AwaitingInitialized);

    let mut response =
        session.process_line(r#"{"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}"#);
    let JsonRpcMessage::Error(error) = response.pop().expect("error response") else {
        panic!("expected error");
    };
    assert_eq!(error.error.code, ERROR_NOT_INITIALIZED);

    assert!(
        session
            .process_line(r#"{"jsonrpc":"2.0","method":"initialized"}"#)
            .is_empty()
    );
    assert_eq!(session.state(), SessionState::Ready);
}

#[test]
fn incompatible_version_does_not_commit_session() {
    let mut session = Session::new();
    let mut response = session.process_line(&initialize_line(2));
    let JsonRpcMessage::Error(error) = response.pop().expect("error response") else {
        panic!("expected error");
    };
    assert_eq!(error.error.code, ERROR_UNSUPPORTED_PROTOCOL_VERSION);
    assert_eq!(session.state(), SessionState::Uninitialized);
}

#[test]
fn duplicate_initialize_is_rejected() {
    let mut session = Session::new();
    session.process_line(&initialize_line(1));
    let mut response = session.process_line(&initialize_line(1));
    let JsonRpcMessage::Error(error) = response.pop().expect("error response") else {
        panic!("expected error");
    };
    assert_eq!(error.error.code, ERROR_ALREADY_INITIALIZED);
}
