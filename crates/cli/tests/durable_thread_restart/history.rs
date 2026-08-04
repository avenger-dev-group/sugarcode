use super::*;

#[test]
fn resumes_completed_history_across_two_cli_processes() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let mut first = RunningServer::spawn(home.path());
    first.initialize();

    let thread_messages = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "thread-1",
            "method": "thread/start",
            "params": {}
        }),
        2,
    );
    let thread_id = thread_messages[0]["result"]["thread"]["id"]
        .as_str()
        .expect("thread id")
        .to_string();
    let turn_messages = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "turn-1",
            "method": "turn/start",
            "params": {"threadId": thread_id, "input": [{"type":"text","text":"Hello"}]}
        }),
        8,
    );
    let completed_turn = turn_messages[7]["params"]["turn"].clone();
    let completed_item = turn_messages[6]["params"]["item"].clone();
    first.finish();
    fs::remove_file(home.path().join("projections/v1/thread-discovery.sqlite3"))
        .expect("remove disposable projection");

    let mut second = RunningServer::spawn(home.path());
    second.initialize();
    let listed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "list-1",
            "method": "thread/list",
            "params": {}
        }),
        1,
    );
    assert_eq!(listed[0]["result"]["data"], json!([{"id": thread_id}]));
    assert_eq!(listed[0]["result"]["nextCursor"], Value::Null);
    let resumed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "resume-1",
            "method": "thread/resume",
            "params": {"threadId": thread_id}
        }),
        1,
    );
    assert_eq!(resumed[0]["result"]["thread"]["id"], thread_id);
    assert_eq!(resumed[0]["result"]["turns"][0]["id"], completed_turn["id"]);
    assert_eq!(
        resumed[0]["result"]["turns"][0]["status"],
        completed_turn["status"]
    );
    assert_eq!(resumed[0]["result"]["turns"][0]["items"][1], completed_item);

    let next_turn = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "turn-2",
            "method": "turn/start",
            "params": {"threadId": thread_id, "input": [{"type":"text","text":"Hello"}]}
        }),
        8,
    );
    assert_eq!(
        next_turn[0]["result"]["turn"]["id"],
        "00000000-0001-7000-8000-000000000002"
    );
    assert_eq!(
        next_turn[4]["params"]["item"]["id"],
        "00000000-0002-7000-8000-000000000004"
    );
    let second_requests = second.provider_requests();
    assert_eq!(
        second_requests[0]["tools"]
            .as_array()
            .expect("collaboration tools")
            .iter()
            .map(|tool| tool["function"]["name"].as_str().expect("tool name"))
            .collect::<Vec<_>>(),
        vec![
            "collaboration_dispatch",
            "collaboration_amend",
            "collaboration_wait",
            "collaboration_interrupt",
        ]
    );
    let messages = provider_messages_after_base_agent(&second_requests[0]);
    assert_eq!(
        messages,
        json!([
            {"role": "user", "content": "Hello"},
            {
                "role": "assistant",
                "content": "SugarCode deterministic response."
            },
            {"role": "user", "content": "Hello"}
        ])
        .as_array()
        .expect("expected messages")
    );
    second.finish();
}

#[test]
fn persisted_compaction_is_reused_after_a_real_cli_restart() {
    fn large_response() -> &'static str {
        let delta = "x".repeat(64 * 1024);
        let mut body = String::new();
        for _ in 0..8 {
            body.push_str(&format!(
                concat!(
                    "data: {{\"choices\":[{{\"index\":0,\"delta\":{{\"content\":\"{}\"}},",
                    "\"finish_reason\":null}}]}}\n\n"
                ),
                delta
            ));
        }
        body.push_str(concat!(
            "data: {\"choices\":[{\"index\":0,\"delta\":{},",
            "\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n"
        ));
        Box::leak(body.into_boxed_str())
    }

    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let mut responses = (0..6)
        .map(|_| MockResponse::Complete(large_response()))
        .collect::<Vec<_>>();
    responses.push(MockResponse::Complete(include_str!(
        "../../../model-provider/tests/fixtures/completed.sse"
    )));
    let mut first = RunningServer::spawn_with_responses(home.path(), responses);
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
    for turn in 1..=6 {
        let completed = first.send(
            json!({
                "jsonrpc": "2.0",
                "id": format!("large-{turn}"),
                "method": "turn/start",
                "params": {
                    "threadId": "00000000-0000-7000-8000-000000000001",
                    "input": [{"type":"text","text":"u"}]
                }
            }),
            8,
        );
        assert_eq!(completed[7]["params"]["turn"]["status"], "completed");
    }
    let checkpoint = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "checkpoint",
            "method": "turn/start",
            "params": {
                "threadId": "00000000-0000-7000-8000-000000000001",
                "input": [{"type":"text","text":"checkpoint"}]
            }
        }),
        8,
    );
    assert_eq!(checkpoint[7]["params"]["turn"]["status"], "completed");
    let first_requests = first.provider_requests();
    assert_eq!(first_requests.len(), 7);
    let checkpoint_messages = provider_messages_after_base_agent(&first_requests[6]);
    assert_eq!(checkpoint_messages[0]["role"], "user");
    assert!(
        checkpoint_messages[0]["content"]
            .as_str()
            .expect("compaction")
            .starts_with("SugarCode deterministic persisted compaction v1\n")
    );
    assert_eq!(checkpoint_messages[1]["content"], "checkpoint");
    first.finish();

    let rollout = fs::read_to_string(rollout_path(home.path(), 1)).expect("rollout");
    assert!(rollout.contains("\"contextCompaction\""));
    assert!(rollout.contains("\"deterministicExtractiveV1\""));

    let mut second = RunningServer::spawn(home.path());
    second.initialize();
    second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "resume",
            "method": "thread/resume",
            "params": {"threadId": "00000000-0000-7000-8000-000000000001"}
        }),
        1,
    );
    let continued = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "continued",
            "method": "turn/start",
            "params": {
                "threadId": "00000000-0000-7000-8000-000000000001",
                "input": [{"type":"text","text":"continued"}]
            }
        }),
        8,
    );
    assert_eq!(continued[7]["params"]["turn"]["status"], "completed");
    let request = &second.provider_requests()[0];
    let messages = provider_messages_after_base_agent(request);
    assert!(
        messages[0]["content"]
            .as_str()
            .expect("persisted compaction")
            .starts_with("SugarCode deterministic persisted compaction v1\n")
    );
    assert_eq!(messages[1]["content"], "checkpoint");
    assert_eq!(messages[2]["content"], "SugarCode deterministic response.");
    assert_eq!(messages[3]["content"], "continued");
    second.finish();
}

#[test]
fn resumes_forks_and_continues_completed_tool_history_in_a_second_cli_process() {
    const TOOL_CALL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_restart\",\"type\":\"function\",\"function\":{\"name\":\"workspace/read\",\"arguments\":\"{\\\"path\\\":\\\"context.txt\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    const FIRST_FINAL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"First final.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    const CONTINUED_FINAL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Continued final.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );

    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("isolated workspace");
    fs::write(workspace.path().join("context.txt"), "persisted context")
        .expect("workspace fixture");
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
            "id": "tool-turn",
            "method": "turn/start",
            "params": {
                "threadId": "00000000-0000-7000-8000-000000000001",
                "input": [{"type":"text","text":"Read context"}]
            }
        }),
        12,
    );
    assert_eq!(completed[11]["params"]["turn"]["status"], "completed");
    let first_requests = first.provider_requests();
    assert_eq!(first_requests.len(), 2);
    assert_eq!(
        first_requests[0]["tools"][0]["function"]["name"],
        "workspace_read"
    );
    assert_eq!(
        first_requests[1]["tools"][0]["function"]["name"], "workspace_read",
        "local tools remain available after a successful tool result"
    );
    first.finish();

    let mut second =
        RunningServer::spawn_with_workspace(home.path(), workspace.path(), vec![CONTINUED_FINAL]);
    second.initialize();
    let resumed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "resume",
            "method": "thread/resume",
            "params": {"threadId": "00000000-0000-7000-8000-000000000001"}
        }),
        1,
    );
    let original_items = resumed[0]["result"]["turns"][0]["items"]
        .as_array()
        .expect("resumed items");
    assert_eq!(original_items.len(), 4);
    assert_eq!(original_items[1]["type"], "toolCall");
    assert_eq!(original_items[2]["type"], "toolResult");

    let forked = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "fork",
            "method": "thread/fork",
            "params": {"threadId": "00000000-0000-7000-8000-000000000001"}
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

    let continued = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "continue",
            "method": "turn/start",
            "params": {"threadId": "00000000-0000-7000-8000-000000000002"}
        }),
        6,
    );
    assert_eq!(continued[5]["params"]["turn"]["status"], "completed");
    let continued_request = &second.provider_requests()[0];
    let messages = provider_messages_after_base_agent(continued_request);
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[1]["tool_calls"][0]["id"], "call_restart");
    assert_eq!(messages[2]["role"], "tool");
    assert_eq!(
        serde_json::from_str::<Value>(
            messages[2]["content"]
                .as_str()
                .expect("workspace/read provider result")
        )
        .expect("workspace/read JSON"),
        json!({
            "bytes": 17,
            "content": "persisted context",
            "sha256": "adf56cb221dbe0d08f03449f00b0cc2156cf34f4b9449326debcf31abce3660a"
        })
    );
    assert_eq!(messages[3]["content"], "First final.");
    second.finish();
}
