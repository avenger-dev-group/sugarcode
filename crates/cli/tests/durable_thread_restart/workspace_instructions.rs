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
