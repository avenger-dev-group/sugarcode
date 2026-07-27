use super::*;

const FIRST_INSTRUCTION: &str = "first private workspace instruction";
const SECOND_INSTRUCTION: &str = "second private workspace instruction";

#[test]
fn each_cli_process_snapshots_root_agents_and_keeps_it_out_of_public_protocol() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("isolated workspace");
    let agents = workspace.path().join("AGENTS.md");
    fs::write(&agents, FIRST_INSTRUCTION).expect("first instructions");
    let completed = include_str!("../../../model-provider/tests/fixtures/completed.sse");

    let mut first =
        RunningServer::spawn_with_workspace(home.path(), workspace.path(), vec![completed]);
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
    let first_public = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "first-turn",
            "method": "turn/start",
            "params": {
                "threadId": "thr_0000000000000001",
                "input": "first input"
            }
        }),
        8,
    );
    let first_request = &first.provider_requests()[0];
    assert_eq!(
        first_request["messages"],
        json!([
            {
                "role": "developer",
                "content": format!(
                    "Workspace instructions from the opened workspace root AGENTS.md (boundedWorkspaceInstructionsV1):\n\n{FIRST_INSTRUCTION}"
                )
            },
            {"role": "user", "content": "first input"}
        ])
    );
    let first_public = serde_json::to_string(&first_public).expect("public JSON");
    assert!(!first_public.contains(FIRST_INSTRUCTION));
    assert!(!first_public.contains("workspaceInstructions"));
    first.finish();

    fs::write(&agents, SECOND_INSTRUCTION).expect("second instructions");
    let mut second =
        RunningServer::spawn_with_workspace(home.path(), workspace.path(), vec![completed]);
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
    let second_public = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "second-turn",
            "method": "turn/start",
            "params": {
                "threadId": "thr_0000000000000001",
                "input": "second input"
            }
        }),
        8,
    );
    let second_request = &second.provider_requests()[0];
    assert_eq!(
        second_request["messages"],
        json!([
            {
                "role": "developer",
                "content": format!(
                    "Workspace instructions from the opened workspace root AGENTS.md (boundedWorkspaceInstructionsV1):\n\n{SECOND_INSTRUCTION}"
                )
            },
            {"role": "user", "content": "first input"},
            {
                "role": "assistant",
                "content": "SugarCode deterministic response."
            },
            {"role": "user", "content": "second input"}
        ])
    );
    let public_json =
        serde_json::to_string(&(resumed, second_public)).expect("combined public JSON");
    assert!(!public_json.contains(FIRST_INSTRUCTION));
    assert!(!public_json.contains(SECOND_INSTRUCTION));
    assert!(!public_json.contains("workspaceInstructions"));
    second.finish();

    let rollout = fs::read_to_string(home.path().join("rollouts/v1/thr_0000000000000001.jsonl"))
        .expect("rollout");
    assert!(rollout.contains("\"workspaceInstructions\""));
    assert!(!rollout.contains(FIRST_INSTRUCTION));
    assert!(!rollout.contains(SECOND_INSTRUCTION));
    assert!(!rollout.contains("\"content\""));
}

#[test]
fn scoped_agents_is_not_auto_discovered_but_can_be_read_as_ordinary_tool_data() {
    const ROOT_INSTRUCTION: &str = "root private instruction";
    const NESTED_INSTRUCTION: &str = "nested explicit tool content";
    const READ_CALL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_nested_agents\",\"type\":\"function\",\"function\":{\"name\":\"workspace/read\",\"arguments\":\"{\\\"path\\\":\\\"AGENTS.md\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    const FINAL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Nested file read.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );

    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("isolated workspace");
    fs::create_dir_all(workspace.path().join("projects/active")).expect("active scope");
    fs::write(workspace.path().join("AGENTS.md"), ROOT_INSTRUCTION).expect("root instructions");
    fs::write(
        workspace.path().join("projects/active/AGENTS.md"),
        NESTED_INSTRUCTION,
    )
    .expect("nested instructions");
    let mut server = RunningServer::spawn_with_workspace_scope(
        home.path(),
        workspace.path(),
        "projects/active",
        vec![READ_CALL, FINAL],
    );
    server.initialize();
    server.send(
        json!({"jsonrpc":"2.0","id":"thread","method":"thread/start","params":{}}),
        2,
    );
    let public = server.send(
        json!({
            "jsonrpc":"2.0",
            "id":"turn",
            "method":"turn/start",
            "params":{"threadId":"thr_0000000000000001","input":"Read nested AGENTS"}
        }),
        12,
    );
    assert_eq!(public[11]["params"]["turn"]["status"], "completed");
    let requests = server.provider_requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0]["messages"][0]["content"],
        format!(
            "Workspace instructions from the opened workspace root AGENTS.md (boundedWorkspaceInstructionsV1):\n\n{ROOT_INSTRUCTION}"
        )
    );
    assert!(
        !requests[0].to_string().contains(NESTED_INSTRUCTION),
        "nested AGENTS.md must not be auto-discovered"
    );
    let second_request = requests[1].to_string();
    assert!(second_request.contains(ROOT_INSTRUCTION));
    assert!(second_request.contains(NESTED_INSTRUCTION));
    server.finish();

    let rollout = fs::read_to_string(home.path().join("rollouts/v1/thr_0000000000000001.jsonl"))
        .expect("rollout");
    assert!(rollout.contains("\"source\":\"rootAgentsMdV1\""));
    assert!(rollout.contains(NESTED_INSTRUCTION));
    assert!(!rollout.contains(ROOT_INSTRUCTION));
}
