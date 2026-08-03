use super::*;

const ROOT_SKILL: &str = r#"---
name: review
description: "root review inventory marker"
---
root review body marker
"#;
const FIRST_SCOPED_SKILL: &str = r#"---
name: review
description: "first scoped review inventory marker"
---
first scoped review body marker
"#;
const SECOND_SCOPED_SKILL: &str = r#"---
name: review
description: "second scoped review inventory marker"
---
second scoped review body marker
"#;

#[test]
fn skills_are_process_snapshotted_resumed_forked_and_kept_out_of_public_state() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("isolated workspace");
    let active_scope = workspace.path().join("projects/active");
    let root_skill = workspace.path().join(".agents/skills/review");
    let scoped_skill = active_scope.join(".agents/skills/review");
    fs::create_dir_all(&root_skill).expect("root Skill directory");
    fs::create_dir_all(&scoped_skill).expect("scoped Skill directory");
    fs::write(root_skill.join("SKILL.md"), ROOT_SKILL).expect("root Skill");
    fs::write(scoped_skill.join("SKILL.md"), FIRST_SCOPED_SKILL).expect("first scoped Skill");

    let completed = include_str!("../../../model-provider/tests/fixtures/completed.sse");
    let mut first = RunningServer::spawn_with_workspace_scope(
        home.path(),
        workspace.path(),
        "projects/active",
        vec![completed, completed],
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
            "params":{"threadId":"00000000-0000-7000-8000-000000000001","input":[{"type":"text","text":"Apply $review"}]}
        }),
        8,
    );

    fs::write(scoped_skill.join("SKILL.md"), SECOND_SCOPED_SKILL)
        .expect("replace scoped Skill while process is running");
    let snapshotted_public = first.send(
        json!({
            "jsonrpc":"2.0",
            "id":"turn-two",
            "method":"turn/start",
            "params":{"threadId":"00000000-0000-7000-8000-000000000001","input":[{"type":"text","text":"Apply $review again"}]}
        }),
        8,
    );
    let first_requests = first.provider_requests();
    assert_eq!(first_requests.len(), 2);
    for request in &first_requests {
        let system = provider_system_instruction(request);
        assert!(system.contains("boundedLocalWorkspaceSkillsV1"));
        assert!(system.contains("first scoped review inventory marker"));
        assert!(!system.contains("root review inventory marker"));
        assert!(!system.contains("second scoped review inventory marker"));
        assert!(system.contains("first scoped review body marker"));
        assert!(!system.contains("root review body marker"));
        assert!(!system.contains("second scoped review body marker"));
    }
    assert_eq!(
        provider_messages_after_base_agent(&first_requests[0])[0]["content"],
        "Apply $review"
    );
    assert_eq!(
        provider_messages_after_base_agent(&first_requests[1])[2]["content"],
        "Apply $review again"
    );
    assert_public_redaction(&(first_public, snapshotted_public));
    first.finish();

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
            "params":{"threadId":"00000000-0000-7000-8000-000000000001"}
        }),
        1,
    );
    let restarted_public = second.send(
        json!({
            "jsonrpc":"2.0",
            "id":"turn-three",
            "method":"turn/start",
            "params":{"threadId":"00000000-0000-7000-8000-000000000001","input":[{"type":"text","text":"Apply current $review"}]}
        }),
        8,
    );
    let restarted_request = &second.provider_requests()[0];
    let system = provider_system_instruction(restarted_request);
    let messages = provider_messages_after_base_agent(restarted_request);
    assert!(system.contains("second scoped review inventory marker"));
    assert!(!system.contains("first scoped review inventory marker"));
    assert!(system.contains("second scoped review body marker"));
    assert!(!system.contains("first scoped review body marker"));
    assert_eq!(messages[4]["content"], "Apply current $review");

    let forked = second.send(
        json!({
            "jsonrpc":"2.0",
            "id":"fork",
            "method":"thread/fork",
            "params":{"threadId":"00000000-0000-7000-8000-000000000001"}
        }),
        2,
    );
    assert_eq!(
        forked[0]["result"]["thread"]["id"],
        "00000000-0000-7000-8000-000000000002"
    );
    let searched = second.send(
        json!({
            "jsonrpc":"2.0",
            "id":"search-private-skill",
            "method":"thread/search",
            "params":{"query":"second scoped review body marker"}
        }),
        1,
    );
    assert_eq!(searched[0]["result"]["data"], json!([]));
    assert_public_redaction(&(resumed, restarted_public, forked, searched));
    second.finish();

    let source_rollout = fs::read_to_string(rollout_path(home.path(), 1)).expect("source rollout");
    let fork_rollout = fs::read_to_string(rollout_path(home.path(), 2)).expect("fork rollout");
    for rollout in [&source_rollout, &fork_rollout] {
        assert!(rollout.contains("\"workspaceSkills\""));
        assert!(rollout.contains("\"source\":\"rootToActiveScopeAgentsSkillsV1\""));
        assert!(rollout.contains("\"discoveredCount\":2"));
        assert!(rollout.contains("\"effectiveCount\":1"));
        assert!(rollout.contains("\"selectedCount\":1"));
        assert!(rollout.contains("\"manifestSha256\""));
        assert!(rollout.contains("\"selectionSha256\""));
        assert!(!rollout.contains(".agents/skills"));
        assert!(!rollout.contains("SKILL.md"));
        assert_private_skill_data_absent(rollout);
    }
}

fn assert_public_redaction(value: &impl serde::Serialize) {
    let json = serde_json::to_string(value).expect("public JSON");
    assert!(!json.contains("workspaceSkills"));
    assert!(!json.contains(".agents/skills"));
    assert!(!json.contains("SKILL.md"));
    assert_private_skill_data_absent(&json);
}

fn assert_private_skill_data_absent(value: &str) {
    for private in [
        "root review inventory marker",
        "root review body marker",
        "first scoped review inventory marker",
        "first scoped review body marker",
        "second scoped review inventory marker",
        "second scoped review body marker",
    ] {
        assert!(!value.contains(private), "private Skill data leaked");
    }
}
