use super::*;

#[test]
fn thread_list_is_descending_bounded_and_cursor_paginated() {
    let mut session = ready_session(Core::new());
    let mut thread_ids = Vec::new();
    for id in ["start-1", "start-2", "start-3"] {
        let messages = session.process_line(&format!(
            r#"{{"jsonrpc":"2.0","id":"{id}","method":"thread/start","params":{{}}}}"#
        ));
        assert_eq!(messages.len(), 2);
        thread_ids.push(response_thread_id(&messages).to_owned());
    }

    let first = session.process_line(
        r#"{"jsonrpc":"2.0","id":"list-1","method":"thread/list","params":{"limit":2}}"#,
    );
    let JsonRpcMessage::Response(first) = &first[0] else {
        panic!("expected list response");
    };
    assert_eq!(
        first.result,
        json!({
            "data": [
                {"id": thread_ids[2], "workspaceId": "unbound"},
                {"id": thread_ids[1], "workspaceId": "unbound"}
            ],
            "nextCursor": thread_ids[1]
        })
    );

    let second = session.process_line(
        &json!({
            "jsonrpc": "2.0", "id": "list-2", "method": "thread/list",
            "params": {"cursor": thread_ids[1], "limit": 2}
        })
        .to_string(),
    );
    let JsonRpcMessage::Response(second) = &second[0] else {
        panic!("expected second list response");
    };
    assert_eq!(
        second.result,
        json!({
            "data": [{"id": thread_ids[0], "workspaceId": "unbound"}],
            "nextCursor": null
        })
    );
}

#[test]
fn thread_list_rejects_invalid_params_and_maps_state_failure() {
    let mut session = ready_session(Core::new());
    for (index, params) in [
        r#"{"limit":0}"#,
        r#"{"limit":101}"#,
        r#"{"cursor":"thr_0000000000000099"}"#,
        r#"{"search":"later"}"#,
    ]
    .into_iter()
    .enumerate()
    {
        let messages = session.process_line(&format!(
            r#"{{"jsonrpc":"2.0","id":"invalid-{index}","method":"thread/list","params":{params}}}"#
        ));
        let JsonRpcMessage::Error(error) = &messages[0] else {
            panic!("expected invalid params");
        };
        assert_eq!(error.error.code, ERROR_INVALID_PARAMS);
    }

    let mut unavailable = ready_session(StateUnavailableCore);
    let messages =
        unavailable.process_line(r#"{"jsonrpc":"2.0","id":"list","method":"thread/list"}"#);
    let JsonRpcMessage::Error(error) = &messages[0] else {
        panic!("expected state error");
    };
    assert_eq!(error.error.code, ERROR_STATE_UNAVAILABLE);
}

#[test]
fn thread_search_returns_only_matching_threads_in_stable_id_order() {
    let mut session = ready_session(Core::new());
    let mut thread_ids = Vec::new();
    for sequence in 1..=3 {
        let started = session.process_line(&format!(
            r#"{{"jsonrpc":"2.0","id":"start-{sequence}","method":"thread/start","params":{{}}}}"#
        ));
        let thread_id = response_thread_id(&started).to_owned();
        thread_ids.push(thread_id.clone());
        if sequence < 3 {
            session.process_line(
                &json!({
                    "jsonrpc": "2.0", "id": format!("turn-{sequence}"),
                    "method": "turn/start",
                    "params": {"threadId": thread_id, "input": [{"type":"text","text":"Hello"}]}
                })
                .to_string(),
            );
        }
    }

    let first = session.process_line(
        r#"{"jsonrpc":"2.0","id":"search-1","method":"thread/search","params":{"query":"SugarCode response","limit":1}}"#,
    );
    let JsonRpcMessage::Response(first) = &first[0] else {
        panic!("expected search response");
    };
    assert_eq!(
        first.result,
        json!({
            "data": [{"id": thread_ids[1], "workspaceId": "unbound"}],
            "nextCursor": thread_ids[1]
        })
    );

    let second = session.process_line(
        &json!({
            "jsonrpc":"2.0", "id":"search-2", "method":"thread/search",
            "params":{"query":"SugarCode response", "cursor":thread_ids[1], "limit":1}
        })
        .to_string(),
    );
    let JsonRpcMessage::Response(second) = &second[0] else {
        panic!("expected second search response");
    };
    assert_eq!(
        second.result,
        json!({
            "data": [{"id": thread_ids[0], "workspaceId": "unbound"}],
            "nextCursor": null
        })
    );
}

#[test]
fn thread_search_rejects_invalid_params_and_redacts_state_failures() {
    let mut session = ready_session(Core::new());
    for (index, params) in [
        r#"{}"#,
        r#"{"query":""}"#,
        r#"{"query":"private\nquery"}"#,
        r#"{"query":"valid","limit":0}"#,
        r#"{"query":"valid","limit":101}"#,
        r#"{"query":"valid","cursor":"thr_0000000000000099"}"#,
        r#"{"query":"valid","score":true}"#,
    ]
    .into_iter()
    .enumerate()
    {
        let messages = session.process_line(&format!(
            r#"{{"jsonrpc":"2.0","id":"invalid-search-{index}","method":"thread/search","params":{params}}}"#
        ));
        let JsonRpcMessage::Error(error) = &messages[0] else {
            panic!("expected invalid params");
        };
        assert_eq!(error.error.code, ERROR_INVALID_PARAMS);
        assert!(error.error.data.is_none());
    }

    let mut unavailable = ready_session(StateUnavailableCore);
    let messages = unavailable.process_line(
        r#"{"jsonrpc":"2.0","id":"search","method":"thread/search","params":{"query":"private-query-sentinel"}}"#,
    );
    let JsonRpcMessage::Error(error) = &messages[0] else {
        panic!("expected state error");
    };
    assert_eq!(error.error.code, ERROR_STATE_UNAVAILABLE);
    assert_eq!(error.error.message, "State unavailable");
    assert!(error.error.data.is_none());
    assert!(
        !serde_json::to_string(error)
            .expect("serialize")
            .contains("private-query-sentinel")
    );
}
