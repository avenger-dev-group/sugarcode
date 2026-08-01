use super::*;

#[test]
fn resumes_forks_and_continues_completed_workspace_list_history_across_two_processes() {
    const TOOL_CALL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_list_restart\",\"type\":\"function\",\"function\":{\"name\":\"workspace/list\",\"arguments\":\"{\\\"path\\\":\\\".\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    const FIRST_FINAL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"First list final.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    const CONTINUED_FINAL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Continued list final.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );

    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("isolated workspace");
    fs::write(workspace.path().join("private-listed-marker.txt"), "listed")
        .expect("listed fixture");
    fs::create_dir(workspace.path().join("src")).expect("directory fixture");
    fs::write(workspace.path().join("src/nested.txt"), "nested").expect("nested fixture");
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
            "id": "list-turn",
            "method": "turn/start",
            "params": {
                "threadId": "thr_0000000000000001",
                "input": [{"type":"text","text":"List the workspace"}]
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
        expected_workspace_tools()
    );
    assert_eq!(
        first_requests[1]["tools"]
            .as_array()
            .expect("second-round tools")
            .iter()
            .map(|tool| tool["function"]["name"].as_str().expect("tool name"))
            .collect::<Vec<_>>(),
        expected_workspace_tools(),
        "local tools remain available after a successful list"
    );
    let second_round_messages = provider_messages_after_base_agent(&first_requests[1]);
    let original_result = second_round_messages[2]["content"]
        .as_str()
        .expect("workspace/list result")
        .to_string();
    assert_eq!(
        serde_json::from_str::<Value>(&original_result).expect("list result JSON"),
        json!({
            "entries": [
                {"name": "private-listed-marker.txt", "kind": "file"},
                {"name": "src", "kind": "directory"}
            ]
        })
    );
    first.finish();

    fs::remove_file(workspace.path().join("private-listed-marker.txt"))
        .expect("remove original fixture");
    fs::write(workspace.path().join("replacement.txt"), "replacement")
        .expect("replacement fixture");

    let mut second =
        RunningServer::spawn_with_workspace(home.path(), workspace.path(), vec![CONTINUED_FINAL]);
    second.initialize();
    let resumed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "resume-list",
            "method": "thread/resume",
            "params": {"threadId": "thr_0000000000000001"}
        }),
        1,
    );
    let original_items = resumed[0]["result"]["turns"][0]["items"]
        .as_array()
        .expect("resumed items");
    assert_eq!(original_items.len(), 4);
    assert_eq!(original_items[1]["name"], "workspace/list");
    assert_eq!(original_items[1]["arguments"]["path"], ".");
    assert_eq!(
        original_items[2]["result"]["content"],
        Value::String(original_result.clone())
    );

    let searched = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "search-list-result",
            "method": "thread/search",
            "params": {"query": "private-listed-marker.txt"}
        }),
        1,
    );
    assert_eq!(searched[0]["result"]["data"], json!([]));

    let forked = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "fork-list",
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
    assert_eq!(
        fork_items[2]["result"]["content"],
        Value::String(original_result.clone())
    );

    let continued = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "continue-list",
            "method": "turn/start",
            "params": {"threadId": "thr_0000000000000002"}
        }),
        6,
    );
    assert_eq!(continued[5]["params"]["turn"]["status"], "completed");
    let continued_request = &second.provider_requests()[0];
    let continued_messages = provider_messages_after_base_agent(continued_request);
    assert_eq!(
        continued_request["tools"]
            .as_array()
            .expect("continued tools")
            .iter()
            .map(|tool| tool["function"]["name"].as_str().expect("tool name"))
            .collect::<Vec<_>>(),
        expected_workspace_tools()
    );
    assert_eq!(
        continued_messages[1]["tool_calls"][0]["function"]["name"],
        "workspace_list"
    );
    assert_eq!(
        continued_messages[2]["content"],
        Value::String(original_result)
    );
    assert!(!continued_request.to_string().contains("replacement.txt"));
    second.finish();
}

fn expected_workspace_tools() -> Vec<&'static str> {
    let mut tools = vec!["workspace_read", "workspace_list", "workspace_search"];
    if !cfg!(windows) {
        tools.push("shell_exec");
    }
    tools.extend([
        "collaboration_dispatch",
        "collaboration_amend",
        "collaboration_wait",
        "collaboration_interrupt",
    ]);
    tools
}

#[test]
fn failed_and_interrupted_turns_resume_but_do_not_enter_search_fork_or_history() {
    const FAILED_PARTIAL: &str = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"failed private marker\"},\"finish_reason\":null}]}\n\n";
    const INTERRUPTED_PARTIAL: &str = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"interrupted private marker\"},\"finish_reason\":null}]}\n\n";

    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let mut first = RunningServer::spawn_with_responses(
        home.path(),
        vec![
            MockResponse::Complete(include_str!(
                "../../../model-provider/tests/fixtures/completed.sse"
            )),
            MockResponse::Complete(FAILED_PARTIAL),
            MockResponse::HoldOpen(INTERRUPTED_PARTIAL),
        ],
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
            "id": "completed",
            "method": "turn/start",
            "params": {
                "threadId": "thr_0000000000000001",
                "input": [{"type":"text","text":"completed searchable marker"}]
            }
        }),
        8,
    );
    assert_eq!(completed[7]["params"]["turn"]["status"], "completed");
    let failed = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "failed",
            "method": "turn/start",
            "params": {
                "threadId": "thr_0000000000000001",
                "input": [{"type":"text","text":"failed private marker"}]
            }
        }),
        5,
    );
    assert_eq!(failed[4]["params"]["turn"]["status"], "failed");
    assert_eq!(failed[4]["params"]["turn"]["error"]["kind"], "disconnected");
    let interrupted_opening = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "interrupted",
            "method": "turn/start",
            "params": {
                "threadId": "thr_0000000000000001",
                "input": [{"type":"text","text":"interrupted private marker"}]
            }
        }),
        4,
    );
    assert_eq!(
        interrupted_opening[0]["result"]["turn"]["status"],
        "inProgress"
    );
    let interrupted = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "interrupt",
            "method": "turn/interrupt",
            "params": {
                "threadId": "thr_0000000000000001",
                "turnId": "turn_0000000000000003"
            }
        }),
        2,
    );
    assert_eq!(
        interrupted
            .iter()
            .filter(|message| message["id"] == "interrupt" && message["result"] == json!({}))
            .count(),
        1
    );
    assert_eq!(
        interrupted
            .iter()
            .filter(|message| message["params"]["turn"]["status"] == "interrupted")
            .count(),
        1
    );
    first.finish();

    let mut second = RunningServer::spawn(home.path());
    second.initialize();
    let resumed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "resume",
            "method": "thread/resume",
            "params": {"threadId": "thr_0000000000000001"}
        }),
        1,
    );
    assert_eq!(
        resumed[0]["result"]["turns"]
            .as_array()
            .expect("resumed turns")
            .iter()
            .map(|turn| turn["status"].as_str().expect("turn status"))
            .collect::<Vec<_>>(),
        vec!["completed", "failed", "interrupted"]
    );
    for (query, expected) in [
        (
            "SugarCode deterministic",
            json!([{
                "id": "thr_0000000000000001",
                "title": "completed searchable marker"
            }]),
        ),
        ("failed private marker", json!([])),
        ("interrupted private marker", json!([])),
    ] {
        let searched = second.send(
            json!({
                "jsonrpc": "2.0",
                "id": format!("search-{query}"),
                "method": "thread/search",
                "params": {"query": query}
            }),
            1,
        );
        assert_eq!(searched[0]["result"]["data"], expected);
    }

    let forked = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "fork",
            "method": "thread/fork",
            "params": {"threadId": "thr_0000000000000001"}
        }),
        2,
    );
    let fork_turns = forked[0]["result"]["turns"].as_array().expect("fork turns");
    assert_eq!(fork_turns.len(), 1);
    assert_eq!(fork_turns[0]["status"], "completed");
    second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "continue",
            "method": "turn/start",
            "params": {"threadId": "thr_0000000000000002"}
        }),
        6,
    );
    let requests = second.provider_requests();
    assert_eq!(requests.len(), 1);
    let continued_messages = provider_messages_after_base_agent(&requests[0]);
    assert_eq!(continued_messages.len(), 2);
    let serialized_messages =
        serde_json::to_string(continued_messages).expect("serialize messages");
    assert!(!serialized_messages.contains("failed private marker"));
    assert!(!serialized_messages.contains("interrupted private marker"));
    second.finish();
}
