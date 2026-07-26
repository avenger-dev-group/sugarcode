use super::*;

#[test]
fn resumes_forks_and_continues_completed_workspace_search_history_across_two_processes() {
    const TOOL_CALL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_search_restart\",\"type\":\"function\",\"function\":{\"name\":\"workspace/search\",\"arguments\":\"{\\\"path\\\":\\\"src\\\",\\\"query\\\":\\\"needle\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    const FIRST_FINAL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"First search final.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    const CONTINUED_FINAL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Continued search final.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );

    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("isolated workspace");
    fs::create_dir(workspace.path().join("src")).expect("src");
    fs::write(
        workspace.path().join("src/private-search-marker.txt"),
        "first\nneedle stable\n",
    )
    .expect("search fixture");
    let mut first = RunningServer::spawn_with_workspace(
        home.path(),
        workspace.path(),
        vec![TOOL_CALL, FIRST_FINAL],
    );
    first.initialize();
    first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "thread",
            "method": "thread/start",
            "params": {}
        }),
        2,
    );
    let completed = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "search-turn",
            "method": "turn/start",
            "params": {
                "threadId": "thr_0000000000000001",
                "input": "Find the marker"
            }
        }),
        12,
    );
    assert_eq!(completed[11]["params"]["turn"]["status"], "completed");
    let first_requests = first.provider_requests();
    assert_eq!(first_requests.len(), 2);
    assert_eq!(
        first_requests[0]["tools"]
            .as_array()
            .expect("first-round tools")
            .iter()
            .map(|tool| tool["function"]["name"].as_str().expect("tool name"))
            .collect::<Vec<_>>(),
        vec!["workspace/read", "workspace/list", "workspace/search"]
    );
    assert!(first_requests[1].get("tools").is_none());
    let original_result = first_requests[1]["messages"][2]["content"]
        .as_str()
        .expect("workspace/search result")
        .to_string();
    assert_eq!(
        serde_json::from_str::<Value>(&original_result).expect("search result JSON"),
        json!({
            "matches": [
                {"path": "src/private-search-marker.txt", "line": 2}
            ],
            "truncated": false
        })
    );
    first.finish();

    fs::remove_file(workspace.path().join("src/private-search-marker.txt"))
        .expect("remove original fixture");
    fs::write(
        workspace.path().join("src/replacement.txt"),
        "needle replacement\n",
    )
    .expect("replacement fixture");

    let mut second =
        RunningServer::spawn_with_workspace(home.path(), workspace.path(), vec![CONTINUED_FINAL]);
    second.initialize();
    let resumed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "resume-search",
            "method": "thread/resume",
            "params": {"threadId": "thr_0000000000000001"}
        }),
        1,
    );
    let original_items = resumed[0]["result"]["turns"][0]["items"]
        .as_array()
        .expect("resumed items");
    assert_eq!(original_items.len(), 4);
    assert_eq!(original_items[1]["name"], "workspace/search");
    assert_eq!(original_items[1]["path"], "src");
    assert_eq!(original_items[1]["query"], "needle");
    assert_eq!(
        original_items[2]["result"]["content"],
        Value::String(original_result.clone())
    );

    let searched = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "search-tool-query",
            "method": "thread/search",
            "params": {"query": "needle"}
        }),
        1,
    );
    assert_eq!(searched[0]["result"]["data"], json!([]));

    let forked = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "fork-search",
            "method": "thread/fork",
            "params": {"threadId": "thr_0000000000000001"}
        }),
        2,
    );
    let fork_items = forked[0]["result"]["turns"][0]["items"]
        .as_array()
        .expect("fork items");
    assert_eq!(fork_items.len(), 4);
    for (source, forked) in original_items.iter().zip(fork_items) {
        assert_ne!(source["id"], forked["id"]);
        assert_eq!(source["type"], forked["type"]);
    }
    assert_eq!(fork_items[1]["query"], "needle");
    assert_eq!(
        fork_items[2]["result"]["content"],
        Value::String(original_result.clone())
    );

    let continued = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "continue-search",
            "method": "turn/start",
            "params": {"threadId": "thr_0000000000000002"}
        }),
        6,
    );
    assert_eq!(continued[5]["params"]["turn"]["status"], "completed");
    let continued_request = &second.provider_requests()[0];
    assert_eq!(
        continued_request["tools"]
            .as_array()
            .expect("continued tools")
            .iter()
            .map(|tool| tool["function"]["name"].as_str().expect("tool name"))
            .collect::<Vec<_>>(),
        vec!["workspace/read", "workspace/list", "workspace/search"]
    );
    assert_eq!(
        continued_request["messages"][1]["tool_calls"][0]["function"]["name"],
        "workspace/search"
    );
    assert_eq!(
        continued_request["messages"][1]["tool_calls"][0]["function"]["arguments"],
        Value::String("{\"path\":\"src\",\"query\":\"needle\"}".to_string())
    );
    assert_eq!(
        continued_request["messages"][2]["content"],
        Value::String(original_result)
    );
    assert!(!continued_request.to_string().contains("replacement.txt"));
    second.finish();
}
