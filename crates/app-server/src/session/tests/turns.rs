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
                "input": [{"type":"text","text":"Hello"}]
            }
        })
        .to_string(),
    );

    let values = messages
        .iter()
        .map(|message| serde_json::to_value(message).expect("message serializes"))
        .collect::<Vec<_>>();
    assert_eq!(values.len(), 6);
    let turn_id = values[0]["result"]["turn"]["id"].as_str().expect("turn id");
    let item_id = values[2]["params"]["item"]["id"].as_str().expect("item id");
    assert!(TurnId::parse(turn_id).is_ok());
    assert!(ItemId::parse(item_id).is_ok());
    assert_eq!(values[0]["result"]["turn"]["status"], "inProgress");
    for value in &values[1..] {
        assert_eq!(value["params"]["threadId"], thread_id);
    }
    assert_eq!(values[1]["params"]["turn"]["id"], turn_id);
    assert_eq!(values[2]["params"]["turnId"], turn_id);
    assert_eq!(values[3]["params"]["itemId"], item_id);
    assert_eq!(values[4]["params"]["item"]["id"], item_id);
    assert_eq!(values[5]["params"]["turn"]["id"], turn_id);
    assert_eq!(values[5]["params"]["turn"]["status"], "completed");
}

#[test]
fn turn_start_rejects_invalid_params_without_accepting_the_request_id() {
    let mut session = ready_session(Core::new());
    let thread_messages =
        session.process_line(r#"{"jsonrpc":"2.0","id":"thread-1","method":"thread/start"}"#);
    let thread_id = response_thread_id(&thread_messages).to_string();

    let mut invalid = session.process_line(
        r#"{"jsonrpc":"2.0","id":"retry","method":"turn/start","params":{"threadId":" ","input":[{"type":"text","text":"Hello"}]}}"#,
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
                "input": [{"type":"text","text":"Hello"}]
            }
        })
        .to_string(),
    );
    assert!(TurnId::parse(response_turn_id(&messages)).is_ok());
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
            "input": [{"type":"text","text":"Hello"}]
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
    let thread_id = start_test_thread(&mut session, "thread-1");
    let turn = start_test_turn(&mut session, "turn-1", &thread_id);
    let turn_id = response_turn_id(&turn).to_owned();
    let mut interrupted = session.process_line(
        &json!({
            "jsonrpc":"2.0", "id":"retry", "method":"turn/interrupt",
            "params":{"threadId":thread_id, "turnId":turn_id}
        })
        .to_string(),
    );
    let JsonRpcMessage::Error(error) = interrupted.pop().expect("turn error") else {
        panic!("expected turn-not-active");
    };
    assert_eq!(error.error.code, ERROR_TURN_NOT_ACTIVE);

    let messages =
        session.process_line(r#"{"jsonrpc":"2.0","id":"retry","method":"thread/start"}"#);
    let next_thread_id = response_thread_id(&messages);
    assert!(ThreadId::parse(next_thread_id).is_ok());
    assert_ne!(next_thread_id, thread_id);
}

#[test]
fn turn_start_rejects_missing_thread_without_accepting_the_request_id() {
    let mut session = ready_session(Core::new());

    let mut missing = session.process_line(
        r#"{"jsonrpc":"2.0","id":"retry","method":"turn/start","params":{"threadId":"00000000-0000-7000-8000-000000000099","input":[{"type":"text","text":"Hello"}]}}"#,
    );
    let JsonRpcMessage::Error(error) = missing.pop().expect("missing thread response") else {
        panic!("expected error");
    };
    assert_eq!(error.error.code, ERROR_THREAD_NOT_FOUND);
    assert_eq!(
        error.error.data,
        Some(json!({"threadId": "00000000-0000-7000-8000-000000000099"}))
    );

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
                "input": [{"type":"text","text":"Hello"}]
            }
        })
        .to_string(),
    );
    assert!(TurnId::parse(response_turn_id(&messages)).is_ok());
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

    let mut turn_ids = HashSet::new();
    for (id, thread_id) in [
        ("turn-1", first_thread_id.as_str()),
        ("turn-2", first_thread_id.as_str()),
        ("turn-3", second_thread_id.as_str()),
    ] {
        let messages = session.process_line(
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "turn/start",
                "params": {
                    "threadId": thread_id,
                    "input": [{"type":"text","text":"Hello"}]
                }
            })
            .to_string(),
        );
        let turn_id = response_turn_id(&messages);
        assert!(TurnId::parse(turn_id).is_ok());
        assert!(
            turn_ids.insert(turn_id.to_owned()),
            "turn IDs must be unique"
        );
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
    let first_thread_id = response_thread_id(&first).to_owned();
    assert!(ThreadId::parse(&first_thread_id).is_ok());

    let mut duplicate = session
        .process_line(r#"{"jsonrpc":"2.0","id":"start-1","method":"thread/start","params":{}}"#);
    let JsonRpcMessage::Error(error) = duplicate.pop().expect("duplicate response") else {
        panic!("expected error");
    };
    assert_eq!(error.error.code, ERROR_DUPLICATE_REQUEST);

    let second = session
        .process_line(r#"{"jsonrpc":"2.0","id":"start-2","method":"thread/start","params":{}}"#);
    let second_thread_id = response_thread_id(&second);
    assert!(ThreadId::parse(second_thread_id).is_ok());
    assert_ne!(second_thread_id, first_thread_id);
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
                "input": [{"type":"text","text":"Hello"}]
            }
        })
        .to_string(),
    );
    let JsonRpcMessage::Error(error) = duplicate.pop().expect("duplicate response") else {
        panic!("expected error");
    };
    assert_eq!(error.error.code, ERROR_DUPLICATE_REQUEST);

    let turn = start_test_turn(&mut session, "turn-1", &thread_id);
    let first_turn_id = response_turn_id(&turn).to_owned();
    let turn_request = json!({
        "jsonrpc":"2.0", "id":"turn-1", "method":"turn/start",
        "params":{"threadId":thread_id, "input":[{"type":"text","text":"Hello"}]}
    })
    .to_string();
    let mut repeated = session.process_line(&turn_request);
    let JsonRpcMessage::Error(error) = repeated.pop().expect("duplicate response") else {
        panic!("expected error");
    };
    assert_eq!(error.error.code, ERROR_DUPLICATE_REQUEST);

    let second_turn = start_test_turn(&mut session, "turn-2", &thread_id);
    let second_turn_id = response_turn_id(&second_turn);
    assert!(TurnId::parse(second_turn_id).is_ok());
    assert_ne!(second_turn_id, first_turn_id);
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
        r#"{"jsonrpc":"2.0","id":"archive","method":"thread/archive","params":{"threadId":"00000000-0000-7000-8000-000000000001"}}"#,
        r#"{"jsonrpc":"2.0","id":"unarchive","method":"thread/unarchive","params":{"threadId":"00000000-0000-7000-8000-000000000001"}}"#,
        r#"{"jsonrpc":"2.0","id":"delete","method":"thread/delete","params":{"workspaceId":"unbound","threadId":"00000000-0000-7000-8000-000000000001"}}"#,
        r#"{"jsonrpc":"2.0","id":"fork","method":"thread/fork","params":{"threadId":"00000000-0000-7000-8000-000000000001"}}"#,
        r#"{"jsonrpc":"2.0","id":"resume","method":"thread/resume","params":{"threadId":"00000000-0000-7000-8000-000000000001"}}"#,
        r#"{"jsonrpc":"2.0","id":"turn","method":"turn/start","params":{"threadId":"00000000-0000-7000-8000-000000000001","input":[{"type":"text","text":"Hello"}]}}"#,
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
    let request = r#"{"jsonrpc":"2.0","id":"archive","method":"thread/archive","params":{"threadId":"00000000-0000-7000-8000-000000000001"}}"#;

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
    let request = r#"{"jsonrpc":"2.0","id":"turn","method":"turn/start","params":{"threadId":"00000000-0000-7000-8000-000000000001","input":[{"type":"text","text":"Hello"}]}}"#;

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
    let request = r#"{"jsonrpc":"2.0","id":"unarchive","method":"thread/unarchive","params":{"threadId":"00000000-0000-7000-8000-000000000001"}}"#;

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
    let request = r#"{"jsonrpc":"2.0","id":"fork","method":"thread/fork","params":{"threadId":"00000000-0000-7000-8000-000000000001"}}"#;

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
    let request = r#"{"jsonrpc":"2.0","id":"delete","method":"thread/delete","params":{"workspaceId":"unbound","threadId":"00000000-0000-7000-8000-000000000001"}}"#;

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
            r#"{"jsonrpc":"2.0","id":"turn-1","method":"turn/start","params":{"threadId":"00000000-0000-7000-8000-000000000010","input":[{"type":"text","text":"Hello"}]}}"#,
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
            r#"{"jsonrpc":"2.0","id":"turn-1","method":"turn/start","params":{"threadId":"00000000-0000-7000-8000-000000000010","input":[{"type":"text","text":"Hello"}]}}"#,
        );

        assert_eq!(messages.len(), 1);
        let JsonRpcMessage::Error(error) = messages.pop().expect("internal error response") else {
            panic!("expected error");
        };
        assert_eq!(error.error.code, ERROR_INTERNAL);
    }
}
