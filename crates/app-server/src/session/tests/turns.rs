use super::*;

#[test]
fn turn_start_returns_response_then_complete_lifecycle() {
    let mut session = ready_session(Core::new());
    let thread_messages =
        session.process_line(r#"{"jsonrpc":"2.0","id":"thread-1","method":"thread/start"}"#);
    let thread_id = response_thread_id(&thread_messages).to_string();

    let messages = session.process_line(
        &json!({
            "jsonrpc": "2.0",
            "id": "turn-1",
            "method": "turn/start",
            "params": {
                "threadId": thread_id,
                "input": "Hello"
            }
        })
        .to_string(),
    );

    assert_eq!(
        messages
            .into_iter()
            .map(|message| serde_json::to_value(message).expect("message serializes"))
            .collect::<Vec<_>>(),
        vec![
            json!({
                "jsonrpc": "2.0",
                "id": "turn-1",
                "result": {
                    "turn": {
                        "id": "turn_0000000000000001",
                        "status": "inProgress"
                    }
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "method": "turn/started",
                "params": {
                    "threadId": "thr_0000000000000001",
                    "turn": {
                        "id": "turn_0000000000000001",
                        "status": "inProgress"
                    }
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "method": "item/started",
                "params": {
                    "threadId": "thr_0000000000000001",
                    "turnId": "turn_0000000000000001",
                    "item": {
                        "type": "agentMessage",
                        "id": "item_0000000000000001",
                        "text": ""
                    }
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "method": "item/agentMessage/delta",
                "params": {
                    "threadId": "thr_0000000000000001",
                    "turnId": "turn_0000000000000001",
                    "itemId": "item_0000000000000001",
                    "delta": "SugarCode deterministic response."
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "method": "item/completed",
                "params": {
                    "threadId": "thr_0000000000000001",
                    "turnId": "turn_0000000000000001",
                    "item": {
                        "type": "agentMessage",
                        "id": "item_0000000000000001",
                        "text": "SugarCode deterministic response."
                    }
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "method": "turn/completed",
                "params": {
                    "threadId": "thr_0000000000000001",
                    "turn": {
                        "id": "turn_0000000000000001",
                        "status": "completed"
                    }
                }
            }),
        ]
    );
}

#[test]
fn turn_start_rejects_invalid_params_without_accepting_the_request_id() {
    let mut session = ready_session(Core::new());
    let thread_messages =
        session.process_line(r#"{"jsonrpc":"2.0","id":"thread-1","method":"thread/start"}"#);
    let thread_id = response_thread_id(&thread_messages).to_string();

    let mut invalid = session.process_line(
        r#"{"jsonrpc":"2.0","id":"retry","method":"turn/start","params":{"threadId":" ","input":"Hello"}}"#,
    );
    let JsonRpcMessage::Error(error) = invalid.pop().expect("invalid params response") else {
        panic!("expected error");
    };
    assert_eq!(error.error.code, ERROR_INVALID_PARAMS);

    let messages = session.process_line(
        &json!({
            "jsonrpc": "2.0",
            "id": "retry",
            "method": "turn/start",
            "params": {
                "threadId": thread_id,
                "input": "Hello"
            }
        })
        .to_string(),
    );
    assert_eq!(response_turn_id(&messages), "turn_0000000000000001");
}

#[test]
fn missing_model_allows_thread_crud_and_returns_stable_reusable_error() {
    let (runtime, _events) = CoreRuntime::without_model(Core::new());
    let mut session = ready_session(runtime);
    let thread_messages =
        session.process_line(r#"{"jsonrpc":"2.0","id":"thread-1","method":"thread/start"}"#);
    let thread_id = response_thread_id(&thread_messages).to_string();
    let request = json!({
        "jsonrpc": "2.0",
        "id": "retry",
        "method": "turn/start",
        "params": {
            "threadId": thread_id,
            "input": "Hello"
        }
    })
    .to_string();

    for _ in 0..2 {
        let mut messages = session.process_line(&request);
        let JsonRpcMessage::Error(error) = messages.pop().expect("model error") else {
            panic!("expected model unavailable");
        };
        assert_eq!(error.error.code, ERROR_MODEL_UNAVAILABLE);
        assert!(error.error.data.is_none());
    }
}

#[test]
fn terminal_interrupt_returns_turn_not_active_without_consuming_request_id() {
    let mut session = ready_session(Core::new());
    session.process_line(r#"{"jsonrpc":"2.0","id":"thread-1","method":"thread/start"}"#);
    session.process_line(
        r#"{"jsonrpc":"2.0","id":"turn-1","method":"turn/start","params":{"threadId":"thr_0000000000000001","input":"Hello"}}"#,
    );
    let mut interrupted = session.process_line(
        r#"{"jsonrpc":"2.0","id":"retry","method":"turn/interrupt","params":{"threadId":"thr_0000000000000001","turnId":"turn_0000000000000001"}}"#,
    );
    let JsonRpcMessage::Error(error) = interrupted.pop().expect("turn error") else {
        panic!("expected turn-not-active");
    };
    assert_eq!(error.error.code, ERROR_TURN_NOT_ACTIVE);

    let messages =
        session.process_line(r#"{"jsonrpc":"2.0","id":"retry","method":"thread/start"}"#);
    assert_eq!(response_thread_id(&messages), "thr_0000000000000002");
}

#[test]
fn turn_start_rejects_missing_thread_without_accepting_the_request_id() {
    let mut session = ready_session(Core::new());

    let mut missing = session.process_line(
        r#"{"jsonrpc":"2.0","id":"retry","method":"turn/start","params":{"threadId":"thr_missing","input":"Hello"}}"#,
    );
    let JsonRpcMessage::Error(error) = missing.pop().expect("missing thread response") else {
        panic!("expected error");
    };
    assert_eq!(error.error.code, ERROR_THREAD_NOT_FOUND);
    assert_eq!(error.error.data, Some(json!({"threadId": "thr_missing"})));

    let thread_messages =
        session.process_line(r#"{"jsonrpc":"2.0","id":"thread-1","method":"thread/start"}"#);
    let thread_id = response_thread_id(&thread_messages).to_string();
    let messages = session.process_line(
        &json!({
            "jsonrpc": "2.0",
            "id": "retry",
            "method": "turn/start",
            "params": {
                "threadId": thread_id,
                "input": "Hello"
            }
        })
        .to_string(),
    );
    assert_eq!(response_turn_id(&messages), "turn_0000000000000001");
}

#[test]
fn starts_consecutive_turns_in_the_same_thread_and_turns_in_other_threads() {
    let mut session = ready_session(Core::new());
    let first_thread =
        session.process_line(r#"{"jsonrpc":"2.0","id":"thread-1","method":"thread/start"}"#);
    let first_thread_id = response_thread_id(&first_thread).to_string();
    let second_thread =
        session.process_line(r#"{"jsonrpc":"2.0","id":"thread-2","method":"thread/start"}"#);
    let second_thread_id = response_thread_id(&second_thread).to_string();

    for (id, thread_id, expected_turn_id) in [
        ("turn-1", first_thread_id.as_str(), "turn_0000000000000001"),
        ("turn-2", first_thread_id.as_str(), "turn_0000000000000002"),
        ("turn-3", second_thread_id.as_str(), "turn_0000000000000003"),
    ] {
        let messages = session.process_line(
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "turn/start",
                "params": {
                    "threadId": thread_id,
                    "input": "Hello"
                }
            })
            .to_string(),
        );
        assert_eq!(response_turn_id(&messages), expected_turn_id);
        assert_eq!(
            notification_thread_id(&messages),
            thread_id,
            "turn notification must identify its owning thread"
        );
    }
}

#[test]
fn duplicate_accepted_request_id_does_not_create_another_thread() {
    let mut session = ready_session(Core::new());

    let first = session
        .process_line(r#"{"jsonrpc":"2.0","id":"start-1","method":"thread/start","params":{}}"#);
    assert_eq!(response_thread_id(&first), "thr_0000000000000001");

    let mut duplicate = session
        .process_line(r#"{"jsonrpc":"2.0","id":"start-1","method":"thread/start","params":{}}"#);
    let JsonRpcMessage::Error(error) = duplicate.pop().expect("duplicate response") else {
        panic!("expected error");
    };
    assert_eq!(error.error.code, ERROR_DUPLICATE_REQUEST);

    let second = session
        .process_line(r#"{"jsonrpc":"2.0","id":"start-2","method":"thread/start","params":{}}"#);
    assert_eq!(response_thread_id(&second), "thr_0000000000000002");
}

#[test]
fn accepted_request_ids_are_shared_across_lifecycle_methods() {
    let mut session = ready_session(Core::new());

    let first = session
        .process_line(r#"{"jsonrpc":"2.0","id":"shared","method":"thread/start","params":{}}"#);
    let thread_id = response_thread_id(&first).to_string();

    let mut duplicate = session.process_line(
        &json!({
            "jsonrpc": "2.0",
            "id": "shared",
            "method": "turn/start",
            "params": {
                "threadId": thread_id,
                "input": "Hello"
            }
        })
        .to_string(),
    );
    let JsonRpcMessage::Error(error) = duplicate.pop().expect("duplicate response") else {
        panic!("expected error");
    };
    assert_eq!(error.error.code, ERROR_DUPLICATE_REQUEST);

    let turn = session.process_line(
        r#"{"jsonrpc":"2.0","id":"turn-1","method":"turn/start","params":{"threadId":"thr_0000000000000001","input":"Hello"}}"#,
    );
    assert_eq!(response_turn_id(&turn), "turn_0000000000000001");
    let mut repeated = session.process_line(
        r#"{"jsonrpc":"2.0","id":"turn-1","method":"turn/start","params":{"threadId":"thr_0000000000000001","input":"Hello"}}"#,
    );
    let JsonRpcMessage::Error(error) = repeated.pop().expect("duplicate response") else {
        panic!("expected error");
    };
    assert_eq!(error.error.code, ERROR_DUPLICATE_REQUEST);

    let second_turn = session.process_line(
        r#"{"jsonrpc":"2.0","id":"turn-2","method":"turn/start","params":{"threadId":"thr_0000000000000001","input":"Hello"}}"#,
    );
    assert_eq!(response_turn_id(&second_turn), "turn_0000000000000002");
}

#[test]
fn core_failure_returns_internal_error_without_notification() {
    let mut session = ready_session(FailingCore);

    let mut messages = session
        .process_line(r#"{"jsonrpc":"2.0","id":"start-1","method":"thread/start","params":{}}"#);

    assert_eq!(messages.len(), 1);
    let JsonRpcMessage::Error(error) = messages.pop().expect("internal error response") else {
        panic!("expected error");
    };
    assert_eq!(error.id, Some(RequestId::String("start-1".to_string())));
    assert_eq!(error.error.code, ERROR_INTERNAL);
    assert_eq!(error.error.message, "Internal error");
    assert!(error.error.data.is_none());
}

#[test]
fn durable_state_failures_use_the_stable_public_error_without_details() {
    for request in [
        r#"{"jsonrpc":"2.0","id":"start","method":"thread/start","params":{}}"#,
        r#"{"jsonrpc":"2.0","id":"archive","method":"thread/archive","params":{"threadId":"thr_0000000000000001"}}"#,
        r#"{"jsonrpc":"2.0","id":"unarchive","method":"thread/unarchive","params":{"threadId":"thr_0000000000000001"}}"#,
        r#"{"jsonrpc":"2.0","id":"delete","method":"thread/delete","params":{"threadId":"thr_0000000000000001"}}"#,
        r#"{"jsonrpc":"2.0","id":"fork","method":"thread/fork","params":{"threadId":"thr_0000000000000001"}}"#,
        r#"{"jsonrpc":"2.0","id":"resume","method":"thread/resume","params":{"threadId":"thr_0000000000000001"}}"#,
        r#"{"jsonrpc":"2.0","id":"turn","method":"turn/start","params":{"threadId":"thr_0000000000000001","input":"Hello"}}"#,
    ] {
        let mut session = ready_session(StateUnavailableCore);
        let mut messages = session.process_line(request);
        assert_eq!(messages.len(), 1);
        let JsonRpcMessage::Error(error) = messages.pop().expect("state error response") else {
            panic!("expected error");
        };
        assert_eq!(error.error.code, ERROR_STATE_UNAVAILABLE);
        assert_eq!(error.error.message, "State unavailable");
        assert!(error.error.data.is_none());
    }
}

#[test]
fn an_uncertain_archive_attempt_consumes_its_request_id() {
    let mut session = ready_session(StateUnavailableCore);
    let request = r#"{"jsonrpc":"2.0","id":"archive","method":"thread/archive","params":{"threadId":"thr_0000000000000001"}}"#;

    let first = session.process_line(request);
    let JsonRpcMessage::Error(error) = &first[0] else {
        panic!("expected state error");
    };
    assert_eq!(error.error.code, ERROR_STATE_UNAVAILABLE);

    let second = session.process_line(request);
    let JsonRpcMessage::Error(error) = &second[0] else {
        panic!("expected duplicate error");
    };
    assert_eq!(error.error.code, ERROR_DUPLICATE_REQUEST);
}

#[test]
fn an_uncertain_turn_start_attempt_consumes_its_request_id() {
    let mut session = ready_session(StateUnavailableCore);
    let request = r#"{"jsonrpc":"2.0","id":"turn","method":"turn/start","params":{"threadId":"thr_0000000000000001","input":"Hello"}}"#;

    let first = session.process_line(request);
    let JsonRpcMessage::Error(error) = &first[0] else {
        panic!("expected state error");
    };
    assert_eq!(error.error.code, ERROR_STATE_UNAVAILABLE);

    let second = session.process_line(request);
    let JsonRpcMessage::Error(error) = &second[0] else {
        panic!("expected duplicate error");
    };
    assert_eq!(error.error.code, ERROR_DUPLICATE_REQUEST);
}

#[test]
fn an_uncertain_unarchive_attempt_consumes_its_request_id() {
    let mut session = ready_session(StateUnavailableCore);
    let request = r#"{"jsonrpc":"2.0","id":"unarchive","method":"thread/unarchive","params":{"threadId":"thr_0000000000000001"}}"#;

    let first = session.process_line(request);
    let JsonRpcMessage::Error(error) = &first[0] else {
        panic!("expected state error");
    };
    assert_eq!(error.error.code, ERROR_STATE_UNAVAILABLE);

    let second = session.process_line(request);
    let JsonRpcMessage::Error(error) = &second[0] else {
        panic!("expected duplicate error");
    };
    assert_eq!(error.error.code, ERROR_DUPLICATE_REQUEST);
}

#[test]
fn an_uncertain_fork_attempt_consumes_its_request_id() {
    let mut session = ready_session(StateUnavailableCore);
    let request = r#"{"jsonrpc":"2.0","id":"fork","method":"thread/fork","params":{"threadId":"thr_0000000000000001"}}"#;

    let first = session.process_line(request);
    let JsonRpcMessage::Error(error) = &first[0] else {
        panic!("expected state error");
    };
    assert_eq!(error.error.code, ERROR_STATE_UNAVAILABLE);

    let second = session.process_line(request);
    let JsonRpcMessage::Error(error) = &second[0] else {
        panic!("expected duplicate error");
    };
    assert_eq!(error.error.code, ERROR_DUPLICATE_REQUEST);
}

#[test]
fn an_uncertain_delete_attempt_consumes_its_request_id() {
    let mut session = ready_session(StateUnavailableCore);
    let request = r#"{"jsonrpc":"2.0","id":"delete","method":"thread/delete","params":{"threadId":"thr_0000000000000001"}}"#;

    let first = session.process_line(request);
    let JsonRpcMessage::Error(error) = &first[0] else {
        panic!("expected state error");
    };
    assert_eq!(error.error.code, ERROR_STATE_UNAVAILABLE);

    let second = session.process_line(request);
    let JsonRpcMessage::Error(error) = &second[0] else {
        panic!("expected duplicate error");
    };
    assert_eq!(error.error.code, ERROR_DUPLICATE_REQUEST);
}

#[test]
fn mismatched_core_request_id_returns_internal_error() {
    let mut session = ready_session(MismatchedCore);

    let mut messages = session
        .process_line(r#"{"jsonrpc":"2.0","id":"start-1","method":"thread/start","params":{}}"#);

    assert_eq!(messages.len(), 1);
    let JsonRpcMessage::Error(error) = messages.pop().expect("internal error response") else {
        panic!("expected error");
    };
    assert_eq!(error.error.code, ERROR_INTERNAL);
}

#[test]
fn turn_start_failure_returns_internal_error_without_notification() {
    for behavior in [TurnCoreBehavior::Fail, TurnCoreBehavior::AdvanceFail] {
        let mut session = ready_session(TurnCore::new(behavior));

        let mut messages = session.process_line(
            r#"{"jsonrpc":"2.0","id":"turn-1","method":"turn/start","params":{"threadId":"thr_existing","input":"Hello"}}"#,
        );

        assert_eq!(messages.len(), 1);
        let JsonRpcMessage::Error(error) = messages.pop().expect("internal error response") else {
            panic!("expected error");
        };
        assert_eq!(error.error.code, ERROR_INTERNAL);
        assert_eq!(error.error.message, "Internal error");
        assert!(error.error.data.is_none());
    }
}

#[test]
fn mismatched_turn_event_correlation_returns_internal_error() {
    for behavior in [
        TurnCoreBehavior::WrongRequest,
        TurnCoreBehavior::WrongThread,
        TurnCoreBehavior::WrongEvent,
        TurnCoreBehavior::WrongCompletedText,
    ] {
        let mut session = ready_session(TurnCore::new(behavior));
        let mut messages = session.process_line(
            r#"{"jsonrpc":"2.0","id":"turn-1","method":"turn/start","params":{"threadId":"thr_existing","input":"Hello"}}"#,
        );

        assert_eq!(messages.len(), 1);
        let JsonRpcMessage::Error(error) = messages.pop().expect("internal error response") else {
            panic!("expected error");
        };
        assert_eq!(error.error.code, ERROR_INTERNAL);
    }
}
