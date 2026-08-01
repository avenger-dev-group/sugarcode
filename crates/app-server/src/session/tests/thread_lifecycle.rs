use super::*;

#[test]
fn thread_start_returns_response_then_notification() {
    let mut session = ready_session(Core::new());

    let messages =
        session.process_line(r#"{"jsonrpc":"2.0","id":"start-1","method":"thread/start"}"#);

    assert_eq!(
        messages
            .into_iter()
            .map(|message| serde_json::to_value(message).expect("message serializes"))
            .collect::<Vec<_>>(),
        vec![
            json!({
                "jsonrpc": "2.0",
                "id": "start-1",
                "result": {
                    "thread": {
                        "id": "thr_0000000000000001"
                    }
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "method": "thread/started",
                "params": {
                    "thread": {
                        "id": "thr_0000000000000001"
                    }
                }
            }),
        ]
    );
}

#[test]
fn thread_resume_returns_the_complete_snapshot_without_notifications() {
    let mut session = ready_session(Core::new());
    session
        .process_line(r#"{"jsonrpc":"2.0","id":"thread-1","method":"thread/start","params":{}}"#);
    session.process_line(
        r#"{"jsonrpc":"2.0","id":"turn-1","method":"turn/start","params":{"threadId":"thr_0000000000000001","input":[{"type":"text","text":"Hello"}]}}"#,
    );

    let messages = session.process_line(
        r#"{"jsonrpc":"2.0","id":"resume-1","method":"thread/resume","params":{"threadId":"thr_0000000000000001"}}"#,
    );
    assert_eq!(messages.len(), 1);
    assert_eq!(
        serde_json::to_value(&messages[0]).expect("message serializes"),
        json!({
            "jsonrpc": "2.0",
            "id": "resume-1",
            "result": {
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
            }
        })
    );
}

#[test]
fn thread_fork_returns_a_complete_remapped_snapshot_then_started_notification() {
    let mut session = ready_session(Core::new());
    session
        .process_line(r#"{"jsonrpc":"2.0","id":"thread-1","method":"thread/start","params":{}}"#);
    session.process_line(
        r#"{"jsonrpc":"2.0","id":"turn-1","method":"turn/start","params":{"threadId":"thr_0000000000000001","input":[{"type":"text","text":"Hello"}]}}"#,
    );
    session.process_line(
        r#"{"jsonrpc":"2.0","id":"turn-2","method":"turn/start","params":{"threadId":"thr_0000000000000001","input":[{"type":"text","text":"Hello"}]}}"#,
    );

    let messages = session.process_line(
        r#"{"jsonrpc":"2.0","id":"fork-1","method":"thread/fork","params":{"threadId":"thr_0000000000000001"}}"#,
    );
    assert_eq!(
        messages
            .into_iter()
            .map(|message| serde_json::to_value(message).expect("message serializes"))
            .collect::<Vec<_>>(),
        vec![
            json!({
                "jsonrpc": "2.0",
                "id": "fork-1",
                "result": {
                    "thread": {"id": "thr_0000000000000002"},
                    "turns": [
                        {
                            "id": "turn_0000000000000003",
                            "status": "completed",
                            "items": [{
                                "type": "agentMessage",
                                "id": "item_0000000000000003",
                                "text": "SugarCode deterministic response."
                            }]
                        },
                        {
                            "id": "turn_0000000000000004",
                            "status": "completed",
                            "items": [{
                                "type": "agentMessage",
                                "id": "item_0000000000000004",
                                "text": "SugarCode deterministic response."
                            }]
                        }
                    ]
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "method": "thread/started",
                "params": {
                    "thread": {"id": "thr_0000000000000002"}
                }
            }),
        ]
    );
}

#[test]
fn thread_fork_validates_and_requires_an_active_source_before_consuming_request_id() {
    let mut session = ready_session(Core::new());

    for params in [
        json!({"threadId": "thr_missing"}),
        json!({"sourceThreadId": "thr_0000000000000001"}),
        json!({"threadId": "thr_0000000000000001", "turnId": "turn_0000000000000001"}),
    ] {
        let messages = session.process_line(
            &json!({
                "jsonrpc": "2.0",
                "id": "retry",
                "method": "thread/fork",
                "params": params
            })
            .to_string(),
        );
        let JsonRpcMessage::Error(error) = &messages[0] else {
            panic!("expected fork error");
        };
        assert!(
            error.error.code == ERROR_INVALID_PARAMS || error.error.code == ERROR_THREAD_NOT_FOUND
        );
    }

    session
        .process_line(r#"{"jsonrpc":"2.0","id":"thread-1","method":"thread/start","params":{}}"#);
    session.process_line(
        r#"{"jsonrpc":"2.0","id":"archive","method":"thread/archive","params":{"threadId":"thr_0000000000000001"}}"#,
    );
    let archived = session.process_line(
        r#"{"jsonrpc":"2.0","id":"retry","method":"thread/fork","params":{"threadId":"thr_0000000000000001"}}"#,
    );
    let JsonRpcMessage::Error(error) = &archived[0] else {
        panic!("expected archived source error");
    };
    assert_eq!(error.error.code, ERROR_THREAD_NOT_FOUND);

    session.process_line(
        r#"{"jsonrpc":"2.0","id":"unarchive","method":"thread/unarchive","params":{"threadId":"thr_0000000000000001"}}"#,
    );
    let success = session.process_line(
        r#"{"jsonrpc":"2.0","id":"retry","method":"thread/fork","params":{"threadId":"thr_0000000000000001"}}"#,
    );
    assert_eq!(response_thread_id(&success), "thr_0000000000000002");

    let duplicate = session.process_line(
        r#"{"jsonrpc":"2.0","id":"retry","method":"thread/fork","params":{"threadId":"thr_0000000000000001"}}"#,
    );
    let JsonRpcMessage::Error(error) = &duplicate[0] else {
        panic!("expected duplicate error");
    };
    assert_eq!(error.error.code, ERROR_DUPLICATE_REQUEST);
}

#[test]
fn thread_archive_excludes_the_thread_and_is_idempotent() {
    let mut session = ready_session(Core::new());
    session
        .process_line(r#"{"jsonrpc":"2.0","id":"thread-1","method":"thread/start","params":{}}"#);
    session.process_line(
        r#"{"jsonrpc":"2.0","id":"turn-1","method":"turn/start","params":{"threadId":"thr_0000000000000001","input":[{"type":"text","text":"Hello"}]}}"#,
    );

    for request_id in ["archive-1", "archive-2"] {
        let messages = session.process_line(
            &json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "thread/archive",
                "params": {"threadId": "thr_0000000000000001"}
            })
            .to_string(),
        );
        assert_eq!(
            serde_json::to_value(&messages[0]).expect("message serializes"),
            json!({"jsonrpc": "2.0", "id": request_id, "result": {}})
        );
    }

    let list =
        session.process_line(r#"{"jsonrpc":"2.0","id":"list","method":"thread/list","params":{}}"#);
    let JsonRpcMessage::Response(list) = &list[0] else {
        panic!("expected list response");
    };
    assert_eq!(list.result, json!({"data": [], "nextCursor": null}));

    let search = session.process_line(
        r#"{"jsonrpc":"2.0","id":"search","method":"thread/search","params":{"query":"SugarCode"}}"#,
    );
    let JsonRpcMessage::Response(search) = &search[0] else {
        panic!("expected search response");
    };
    assert_eq!(search.result, json!({"data": [], "nextCursor": null}));

    for method in ["thread/resume", "turn/start"] {
        let params = if method == "turn/start" {
            json!({"threadId": "thr_0000000000000001", "input": [{"type":"text","text":"Hello"}]})
        } else {
            json!({"threadId": "thr_0000000000000001"})
        };
        let messages = session.process_line(
            &json!({
                "jsonrpc": "2.0",
                "id": format!("{method}-after-archive"),
                "method": method,
                "params": params
            })
            .to_string(),
        );
        let JsonRpcMessage::Error(error) = &messages[0] else {
            panic!("expected not found error");
        };
        assert_eq!(error.error.code, ERROR_THREAD_NOT_FOUND);
    }
}

#[test]
fn thread_archive_rejects_invalid_and_missing_targets_without_consuming_request_id() {
    let mut session = ready_session(Core::new());

    for params in [
        json!({"threadId": "thr_missing"}),
        json!({"threadId": "thr_0000000000000001", "path": "/tmp"}),
    ] {
        let messages = session.process_line(
            &json!({
                "jsonrpc": "2.0",
                "id": "retry",
                "method": "thread/archive",
                "params": params
            })
            .to_string(),
        );
        let JsonRpcMessage::Error(error) = &messages[0] else {
            panic!("expected archive error");
        };
        assert!(
            error.error.code == ERROR_INVALID_PARAMS || error.error.code == ERROR_THREAD_NOT_FOUND
        );
    }

    session
        .process_line(r#"{"jsonrpc":"2.0","id":"thread-1","method":"thread/start","params":{}}"#);
    let success = session.process_line(
        r#"{"jsonrpc":"2.0","id":"retry","method":"thread/archive","params":{"threadId":"thr_0000000000000001"}}"#,
    );
    assert!(matches!(success[0], JsonRpcMessage::Response(_)));

    let duplicate = session.process_line(
        r#"{"jsonrpc":"2.0","id":"retry","method":"thread/archive","params":{"threadId":"thr_0000000000000001"}}"#,
    );
    let JsonRpcMessage::Error(error) = &duplicate[0] else {
        panic!("expected duplicate error");
    };
    assert_eq!(error.error.code, ERROR_DUPLICATE_REQUEST);
}

#[test]
fn thread_unarchive_restores_list_search_resume_and_turn_start() {
    let mut session = ready_session(Core::new());
    session
        .process_line(r#"{"jsonrpc":"2.0","id":"thread-1","method":"thread/start","params":{}}"#);
    session.process_line(
        r#"{"jsonrpc":"2.0","id":"turn-1","method":"turn/start","params":{"threadId":"thr_0000000000000001","input":[{"type":"text","text":"Hello"}]}}"#,
    );
    session.process_line(
        r#"{"jsonrpc":"2.0","id":"archive","method":"thread/archive","params":{"threadId":"thr_0000000000000001"}}"#,
    );

    let restored = session.process_line(
        r#"{"jsonrpc":"2.0","id":"unarchive","method":"thread/unarchive","params":{"threadId":"thr_0000000000000001"}}"#,
    );
    assert_eq!(
        serde_json::to_value(&restored[0]).expect("message serializes"),
        json!({"jsonrpc": "2.0", "id": "unarchive", "result": {}})
    );

    for (id, method, params) in [
        ("list", "thread/list", json!({})),
        ("search", "thread/search", json!({"query": "SugarCode"})),
        (
            "resume",
            "thread/resume",
            json!({"threadId": "thr_0000000000000001"}),
        ),
        (
            "turn-2",
            "turn/start",
            json!({"threadId": "thr_0000000000000001", "input": [{"type":"text","text":"Hello"}]}),
        ),
    ] {
        let messages = session.process_line(
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params
            })
            .to_string(),
        );
        assert!(
            matches!(messages[0], JsonRpcMessage::Response(_)),
            "{method} must succeed after unarchive"
        );
    }
}

#[test]
fn thread_unarchive_validates_before_consuming_and_active_noop_consumes_request_id() {
    let mut session = ready_session(Core::new());
    for params in [
        json!({"threadId": "thr_missing"}),
        json!({"threadId": "thr_0000000000000001", "resume": true}),
    ] {
        let messages = session.process_line(
            &json!({
                "jsonrpc": "2.0",
                "id": "retry",
                "method": "thread/unarchive",
                "params": params
            })
            .to_string(),
        );
        let JsonRpcMessage::Error(error) = &messages[0] else {
            panic!("expected unarchive error");
        };
        assert!(
            error.error.code == ERROR_INVALID_PARAMS || error.error.code == ERROR_THREAD_NOT_FOUND
        );
    }
    session
        .process_line(r#"{"jsonrpc":"2.0","id":"thread-1","method":"thread/start","params":{}}"#);
    let success = session.process_line(
        r#"{"jsonrpc":"2.0","id":"retry","method":"thread/unarchive","params":{"threadId":"thr_0000000000000001"}}"#,
    );
    assert!(matches!(success[0], JsonRpcMessage::Response(_)));
    let duplicate = session.process_line(
        r#"{"jsonrpc":"2.0","id":"retry","method":"thread/unarchive","params":{"threadId":"thr_0000000000000001"}}"#,
    );
    let JsonRpcMessage::Error(error) = &duplicate[0] else {
        panic!("expected duplicate error");
    };
    assert_eq!(error.error.code, ERROR_DUPLICATE_REQUEST);
}

#[test]
fn thread_delete_is_terminal_for_active_and_archived_threads() {
    let mut session = ready_session(Core::new());
    for (thread_request, turn_request) in [("thread-1", "turn-1"), ("thread-2", "turn-2")] {
        session.process_line(
            &json!({"jsonrpc": "2.0", "id": thread_request, "method": "thread/start"}).to_string(),
        );
        session.process_line(
            &json!({
                "jsonrpc": "2.0",
                "id": turn_request,
                "method": "turn/start",
                "params": {
                    "threadId": format!("thr_000000000000000{}", &thread_request[7..]),
                    "input": [{"type":"text","text":"Hello"}]
                }
            })
            .to_string(),
        );
    }
    session.process_line(
        r#"{"jsonrpc":"2.0","id":"archive","method":"thread/archive","params":{"threadId":"thr_0000000000000002"}}"#,
    );

    for (request_id, thread_id) in [
        ("delete-active", "thr_0000000000000001"),
        ("delete-archived", "thr_0000000000000002"),
        ("delete-again", "thr_0000000000000001"),
    ] {
        let messages = session.process_line(
            &json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "thread/delete",
                "params": {"threadId": thread_id}
            })
            .to_string(),
        );
        assert_eq!(
            serde_json::to_value(&messages[0]).expect("message serializes"),
            json!({"jsonrpc": "2.0", "id": request_id, "result": {}})
        );
    }

    for (request_id, method) in [
        ("resume-deleted", "thread/resume"),
        ("archive-deleted", "thread/archive"),
        ("unarchive-deleted", "thread/unarchive"),
        ("turn-deleted", "turn/start"),
    ] {
        let params = if method == "turn/start" {
            json!({"threadId": "thr_0000000000000001", "input": [{"type":"text","text":"Hello"}]})
        } else {
            json!({"threadId": "thr_0000000000000001"})
        };
        let messages = session.process_line(
            &json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params
            })
            .to_string(),
        );
        let JsonRpcMessage::Error(error) = &messages[0] else {
            panic!("{method} must reject a deleted thread");
        };
        assert_eq!(error.error.code, ERROR_THREAD_NOT_FOUND);
    }
}

#[test]
fn thread_delete_validates_before_consuming_its_request_id() {
    let mut session = ready_session(Core::new());
    for params in [
        json!({"threadId": "thr_missing"}),
        json!({"threadId": "thr_0000000000000001", "force": true}),
    ] {
        let messages = session.process_line(
            &json!({
                "jsonrpc": "2.0",
                "id": "retry",
                "method": "thread/delete",
                "params": params
            })
            .to_string(),
        );
        let JsonRpcMessage::Error(error) = &messages[0] else {
            panic!("expected delete error");
        };
        assert!(
            error.error.code == ERROR_INVALID_PARAMS || error.error.code == ERROR_THREAD_NOT_FOUND
        );
    }
    session
        .process_line(r#"{"jsonrpc":"2.0","id":"thread-1","method":"thread/start","params":{}}"#);
    let success = session.process_line(
        r#"{"jsonrpc":"2.0","id":"retry","method":"thread/delete","params":{"threadId":"thr_0000000000000001"}}"#,
    );
    assert!(matches!(success[0], JsonRpcMessage::Response(_)));
    let duplicate = session.process_line(
        r#"{"jsonrpc":"2.0","id":"retry","method":"thread/delete","params":{"threadId":"thr_0000000000000001"}}"#,
    );
    let JsonRpcMessage::Error(error) = &duplicate[0] else {
        panic!("expected duplicate error");
    };
    assert_eq!(error.error.code, ERROR_DUPLICATE_REQUEST);
}

#[test]
fn invalid_params_do_not_reach_core() {
    let mut session = ready_session(Core::new());

    let mut invalid = session.process_line(
        r#"{"jsonrpc":"2.0","id":"bad","method":"thread/start","params":{"model":"later"}}"#,
    );
    let JsonRpcMessage::Error(error) = invalid.pop().expect("invalid params response") else {
        panic!("expected error");
    };
    assert_eq!(error.error.code, ERROR_INVALID_PARAMS);

    let messages = session
        .process_line(r#"{"jsonrpc":"2.0","id":"good","method":"thread/start","params":{}}"#);
    assert_eq!(response_thread_id(&messages), "thr_0000000000000001");
}
