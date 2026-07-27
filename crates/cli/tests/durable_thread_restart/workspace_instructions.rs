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
fn scoped_agents_are_ordered_redacted_and_refreshed_only_by_a_new_process() {
    const ROOT_INSTRUCTION: &str = "root private instruction";
    const MIDDLE_INSTRUCTION: &str = "middle private instruction";
    const FIRST_LEAF_INSTRUCTION: &str = "first leaf private instruction";
    const SECOND_LEAF_INSTRUCTION: &str = "second leaf private instruction";

    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("isolated workspace");
    fs::create_dir_all(workspace.path().join("projects/active")).expect("active scope");
    fs::write(workspace.path().join("AGENTS.md"), ROOT_INSTRUCTION).expect("root instructions");
    fs::write(
        workspace.path().join("projects/AGENTS.md"),
        MIDDLE_INSTRUCTION,
    )
    .expect("middle instructions");
    let leaf = workspace.path().join("projects/active/AGENTS.md");
    fs::write(&leaf, FIRST_LEAF_INSTRUCTION).expect("first leaf instructions");
    let completed = include_str!("../../../model-provider/tests/fixtures/completed.sse");
    let mut first = RunningServer::spawn_with_workspace_scope(
        home.path(),
        workspace.path(),
        "projects/active",
        vec![completed],
    );
    first.initialize();
    first.send(
        json!({"jsonrpc":"2.0","id":"thread","method":"thread/start","params":{}}),
        2,
    );
    let first_public = first.send(
        json!({
            "jsonrpc":"2.0",
            "id":"turn-one",
            "method":"turn/start",
            "params":{"threadId":"thr_0000000000000001","input":"apply scoped rules"}
        }),
        8,
    );
    let first_request = &first.provider_requests()[0];
    let first_developer = first_request["messages"][0]["content"]
        .as_str()
        .expect("developer message");
    assert!(first_developer.contains("boundedNestedWorkspaceInstructionsV1"));
    assert!(
        first_developer.contains("the later, deeper entry overrides the earlier, shallower entry")
    );
    let root_index = first_developer
        .find("--- AGENTS.md: AGENTS.md ---")
        .expect("root label");
    let middle_index = first_developer
        .find("--- AGENTS.md: projects/AGENTS.md ---")
        .expect("middle label");
    let leaf_index = first_developer
        .find("--- AGENTS.md: projects/active/AGENTS.md ---")
        .expect("leaf label");
    assert!(root_index < middle_index && middle_index < leaf_index);
    assert!(first_developer.contains(ROOT_INSTRUCTION));
    assert!(first_developer.contains(MIDDLE_INSTRUCTION));
    assert!(first_developer.contains(FIRST_LEAF_INSTRUCTION));
    let first_public = serde_json::to_string(&first_public).expect("public JSON");
    assert!(!first_public.contains(ROOT_INSTRUCTION));
    assert!(!first_public.contains(MIDDLE_INSTRUCTION));
    assert!(!first_public.contains(FIRST_LEAF_INSTRUCTION));
    first.finish();

    fs::write(&leaf, SECOND_LEAF_INSTRUCTION).expect("second leaf instructions");
    let mut second = RunningServer::spawn_with_workspace_scope(
        home.path(),
        workspace.path(),
        "projects/active",
        vec![completed],
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
    let second_public = second.send(
        json!({
            "jsonrpc":"2.0",
            "id":"turn-two",
            "method":"turn/start",
            "params":{"threadId":"thr_0000000000000001","input":"apply current rules"}
        }),
        8,
    );
    let second_request = &second.provider_requests()[0];
    let second_developer = second_request["messages"][0]["content"]
        .as_str()
        .expect("developer message");
    assert!(second_developer.contains(SECOND_LEAF_INSTRUCTION));
    assert!(!second_developer.contains(FIRST_LEAF_INSTRUCTION));
    let public = serde_json::to_string(&(resumed, second_public)).expect("public JSON");
    assert!(!public.contains(ROOT_INSTRUCTION));
    assert!(!public.contains(MIDDLE_INSTRUCTION));
    assert!(!public.contains(FIRST_LEAF_INSTRUCTION));
    assert!(!public.contains(SECOND_LEAF_INSTRUCTION));
    assert!(!public.contains("workspaceInstructions"));
    second.finish();

    let rollout = fs::read_to_string(workspace.path().join("projects/active/AGENTS.md"))
        .expect("live leaf remains readable");
    assert_eq!(rollout, SECOND_LEAF_INSTRUCTION);
    let rollout = fs::read_to_string(home.path().join("rollouts/v1/thr_0000000000000001.jsonl"))
        .expect("rollout");
    assert!(rollout.contains("\"source\":\"rootToActiveScopeAgentsMdV1\""));
    assert!(!rollout.contains(ROOT_INSTRUCTION));
    assert!(!rollout.contains(MIDDLE_INSTRUCTION));
    assert!(!rollout.contains(FIRST_LEAF_INSTRUCTION));
    assert!(!rollout.contains(SECOND_LEAF_INSTRUCTION));
    assert!(!rollout.contains("projects/active"));
}
