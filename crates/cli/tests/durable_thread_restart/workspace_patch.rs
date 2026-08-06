use super::*;

#[test]
fn resumes_forks_and_continues_patch_history_without_replaying_the_write() {
    const TOOL_CALL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_patch_restart\",\"type\":\"function\",\"function\":{\"name\":\"workspace/apply-patch\",\"arguments\":\"{\\\"patch\\\":\\\"*** Begin Patch\\\\n*** Update File: notes.txt\\\\n@@\\\\n-two\\\\n+second\\\\n*** End Patch\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    const FIRST_FINAL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Edit complete.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    const CONTINUED_FINAL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"History continued.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("isolated workspace");
    let target = workspace.path().join("notes.txt");
    fs::write(&target, "one\ntwo\nthree\n").expect("patch fixture");
    let mut first = RunningServer::spawn_with_workspace_write(
        home.path(),
        workspace.path(),
        vec![TOOL_CALL, FIRST_FINAL],
    );
    first.initialize();
    first.send(
        json!({"jsonrpc":"2.0","id":"thread","method":"thread/start","params":{}}),
        2,
    );
    let completed = first.send(
        json!({
            "jsonrpc":"2.0",
            "id":"patch-turn",
            "method":"turn/start",
            "params":{"threadId":"00000000-0000-7000-8000-000000000001","input":[{"type":"text","text":"Update the file"}]}
        }),
        14,
    );
    assert_eq!(completed[13]["params"]["turn"]["status"], "completed");
    assert_eq!(
        fs::read_to_string(&target).expect("patched file"),
        "one\nsecond\nthree\n"
    );
    first.finish();

    let mut second =
        RunningServer::spawn_with_workspace(home.path(), workspace.path(), vec![CONTINUED_FINAL]);
    second.initialize();
    let resumed = second.send(
        json!({
            "jsonrpc":"2.0",
            "id":"resume-patch",
            "method":"thread/resume",
            "params":{"threadId":"00000000-0000-7000-8000-000000000001"}
        }),
        1,
    );
    let items = resumed[0]["result"]["turns"][0]["items"]
        .as_array()
        .expect("resumed items");
    assert_eq!(items.len(), 5);
    assert_eq!(items[2]["type"], "fileChange");
    assert_eq!(items[2]["kind"], "update");
    assert_eq!(items[2]["newlineStyle"], "lf");

    let searched = second.send(
        json!({
            "jsonrpc":"2.0",
            "id":"search-diff",
            "method":"thread/search",
            "params":{"query":"second"}
        }),
        1,
    );
    assert_eq!(searched[0]["result"]["data"], json!([]));

    let forked = second.send(
        json!({
            "jsonrpc":"2.0",
            "id":"fork-patch",
            "method":"thread/fork",
            "params":{"threadId":"00000000-0000-7000-8000-000000000001"}
        }),
        2,
    );
    let fork_items = forked[0]["result"]["turns"][0]["items"]
        .as_array()
        .expect("fork items");
    assert_eq!(fork_items.len(), 5);
    assert_eq!(fork_items[2]["diff"], items[2]["diff"]);
    assert_ne!(fork_items[2]["id"], items[2]["id"]);

    let continued = second.send(
        json!({
            "jsonrpc":"2.0",
            "id":"continue-patch",
            "method":"turn/start",
            "params":{"threadId":"00000000-0000-7000-8000-000000000002"}
        }),
        6,
    );
    assert_eq!(continued[5]["params"]["turn"]["status"], "completed");
    let request = &second.provider_requests()[0];
    let replayed_call = request["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .find_map(|message| message["tool_calls"].as_array()?.first())
        .expect("replayed tool call");
    assert_eq!(replayed_call["function"]["name"], "apply_patch");
    let replayed_arguments: Value = serde_json::from_str(
        replayed_call["function"]["arguments"]
            .as_str()
            .expect("serialized tool arguments"),
    )
    .expect("replayed tool arguments");
    assert!(
        replayed_arguments["patch"]
            .as_str()
            .is_some_and(|patch| patch.contains("*** Update File: notes.txt"))
    );
    assert_eq!(
        fs::read_to_string(target).expect("file after restart"),
        "one\nsecond\nthree\n"
    );
    second.finish();
}
