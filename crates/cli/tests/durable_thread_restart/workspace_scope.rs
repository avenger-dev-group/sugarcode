use super::*;

#[test]
fn restart_keeps_threads_bound_to_their_scope_and_uses_the_new_process_scope() {
    const PATCH_CALL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_scope_patch\",\"type\":\"function\",\"function\":{\"name\":\"workspace/apply-diff\",\"arguments\":\"{\\\"path\\\":\\\"notes.txt\\\",\\\"diff\\\":\\\"--- a/notes.txt\\\\n+++ b/notes.txt\\\\n@@ -1,3 +1,3 @@\\\\n one\\\\n-two\\\\n+scope-a\\\\n three\\\\n\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    const PATCH_FINAL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Scope A patched.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    const LIST_CALL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_scope_list\",\"type\":\"function\",\"function\":{\"name\":\"workspace/list\",\"arguments\":\"{\\\"path\\\":\\\".\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    const LIST_FINAL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Scope B listed.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );

    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("isolated workspace");
    fs::create_dir_all(workspace.path().join("projects/a")).expect("scope A");
    fs::create_dir_all(workspace.path().join("projects/b")).expect("scope B");
    fs::write(
        workspace.path().join("projects/a/notes.txt"),
        "one\ntwo\nthree\n",
    )
    .expect("scope A notes");
    fs::write(
        workspace.path().join("projects/b/notes.txt"),
        "scope-b-original\n",
    )
    .expect("scope B notes");
    fs::write(
        workspace.path().join("projects/b/scope-b-marker.txt"),
        "scope B\n",
    )
    .expect("scope B marker");

    let mut first = RunningServer::spawn_with_workspace_scope_write(
        home.path(),
        workspace.path(),
        "projects/a",
        vec![PATCH_CALL, PATCH_FINAL],
    );
    first.initialize();
    first.send(
        json!({"jsonrpc":"2.0","id":"thread","method":"thread/start","params":{}}),
        2,
    );
    let completed = first.send(
        json!({
            "jsonrpc":"2.0",
            "id":"scope-a-turn",
            "method":"turn/start",
            "params":{"threadId":"thr_0000000000000001","input":[{"type":"text","text":"Patch scope A"}]}
        }),
        14,
    );
    assert_eq!(completed[13]["params"]["turn"]["status"], "completed");
    first.finish();
    assert_eq!(
        fs::read_to_string(workspace.path().join("projects/a/notes.txt")).expect("scope A patched"),
        "one\nscope-a\nthree\n"
    );
    assert_eq!(
        fs::read_to_string(workspace.path().join("projects/b/notes.txt"))
            .expect("scope B untouched"),
        "scope-b-original\n"
    );

    let mut second = RunningServer::spawn_with_workspace_scope(
        home.path(),
        workspace.path(),
        "projects/b",
        vec![LIST_CALL, LIST_FINAL],
    );
    second.initialize();
    let resumed = second.send(
        json!({
            "jsonrpc":"2.0",
            "id":"resume",
            "method":"thread/resume",
            "params":{"threadId":"thr_0000000000000001"}
        }),
        1,
    );
    assert_eq!(resumed[0]["error"]["code"], -32004);

    let started = second.send(
        json!({"jsonrpc":"2.0","id":"thread-b","method":"thread/start","params":{}}),
        2,
    );
    let second_thread_id = started[0]["result"]["thread"]["id"]
        .as_str()
        .expect("scope B thread")
        .to_owned();

    let completed = second.send(
        json!({
            "jsonrpc":"2.0",
            "id":"scope-b-turn",
            "method":"turn/start",
            "params":{"threadId":second_thread_id,"input":[{"type":"text","text":"List current scope"}]}
        }),
        12,
    );
    assert_eq!(completed[11]["params"]["turn"]["status"], "completed");
    let requests = second.provider_requests();
    assert_eq!(requests.len(), 2);
    let list_result = requests[1]["messages"]
        .as_array()
        .expect("second-round messages")
        .iter()
        .rev()
        .find_map(|message| {
            (message["role"] == "tool")
                .then(|| message["content"].as_str())
                .flatten()
        })
        .expect("current scope tool result");
    let list_result: Value = serde_json::from_str(list_result).expect("list result JSON");
    assert_eq!(
        list_result,
        json!({
            "entries": [
                {"name": "notes.txt", "kind": "file"},
                {"name": "scope-b-marker.txt", "kind": "file"}
            ]
        })
    );
    assert_eq!(
        fs::read_to_string(workspace.path().join("projects/b/notes.txt"))
            .expect("scope B still untouched"),
        "scope-b-original\n"
    );
    second.finish();
}
