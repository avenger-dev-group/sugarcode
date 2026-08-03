use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread;
use std::thread::JoinHandle;

#[test]
fn command_workspace_write_requires_an_explicit_workspace() {
    let output = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["app-server", "--stdio", "--allow-command-workspace-write"])
        .output()
        .expect("run CLI argument validation");
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("--workspace <DIR>"),
        "{output:?}"
    );
}

#[test]
fn workspace_scope_requires_an_explicit_workspace() {
    let output = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["app-server", "--stdio", "--workspace-scope", "src"])
        .output()
        .expect("run CLI argument validation");
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("--workspace <DIR>"),
        "{output:?}"
    );
}

#[test]
fn invalid_workspace_scope_fails_before_serving_protocol() {
    let sugarcode_home = tempfile::tempdir().expect("isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("isolated workspace");
    configure_model(
        sugarcode_home.path(),
        "127.0.0.1:1".parse().expect("fixture endpoint"),
    );

    let output = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["--home"])
        .arg(sugarcode_home.path())
        .args(["app-server", "--stdio", "--workspace"])
        .arg(workspace.path())
        .args(["--workspace-scope", "missing"])
        .env_remove("SUGARCODE_HOME")
        .stdin(Stdio::null())
        .output()
        .expect("run invalid workspace scope");
    assert!(!output.status.success(), "{output:?}");
    assert!(output.stdout.is_empty(), "{output:?}");
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        "sugarcode: NotFound\n"
    );
}

#[test]
fn invalid_root_agents_file_fails_before_serving_protocol() {
    let sugarcode_home = tempfile::tempdir().expect("isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("isolated workspace");
    fs::write(workspace.path().join("AGENTS.md"), b"invalid\0instruction")
        .expect("invalid instructions");
    configure_model(
        sugarcode_home.path(),
        "127.0.0.1:1".parse().expect("fixture endpoint"),
    );

    let output = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["--home"])
        .arg(sugarcode_home.path())
        .args(["app-server", "--stdio", "--workspace"])
        .arg(workspace.path())
        .env_remove("SUGARCODE_HOME")
        .stdin(Stdio::null())
        .output()
        .expect("run invalid workspace instructions");
    assert!(!output.status.success(), "{output:?}");
    assert!(output.stdout.is_empty(), "{output:?}");
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        "sugarcode: InvalidEncoding\n"
    );
    assert!(!String::from_utf8_lossy(&output.stderr).contains("instruction"));
}

#[test]
fn invalid_workspace_skill_fails_before_serving_protocol_with_redacted_diagnostics() {
    let sugarcode_home = tempfile::tempdir().expect("isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("isolated workspace");
    let private = "private-skill-startup-sentinel";
    let skill = workspace.path().join(".agents/skills/review/SKILL.md");
    fs::create_dir_all(skill.parent().expect("Skill parent")).expect("Skill directory");
    fs::write(
        &skill,
        format!("---\nname: review\ndescription: Review\n---\n{private}\0"),
    )
    .expect("invalid Skill");
    configure_model(
        sugarcode_home.path(),
        "127.0.0.1:1".parse().expect("fixture endpoint"),
    );

    let output = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["--home"])
        .arg(sugarcode_home.path())
        .args(["app-server", "--stdio", "--workspace"])
        .arg(workspace.path())
        .env_remove("SUGARCODE_HOME")
        .stdin(Stdio::null())
        .output()
        .expect("run invalid workspace Skill");
    assert!(!output.status.success(), "{output:?}");
    assert!(output.stdout.is_empty(), "{output:?}");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(stderr, "sugarcode: InvalidEncoding\n");
    assert!(!stderr.contains(private));
    assert!(!stderr.contains("SKILL.md"));
    assert!(!stderr.contains(".agents"));
}

#[test]
#[cfg(not(target_os = "linux"))]
fn unsupported_command_workspace_write_omits_shell_without_fallback() {
    let sugarcode_home = tempfile::tempdir().expect("isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("isolated workspace");
    configure_model(
        sugarcode_home.path(),
        "127.0.0.1:1".parse().expect("fixture endpoint"),
    );
    let output = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["app-server", "--stdio", "--workspace"])
        .arg(workspace.path())
        .arg("--allow-command-workspace-write")
        .env("SUGARCODE_HOME", sugarcode_home.path())
        .stdin(Stdio::null())
        .output()
        .expect("run unsupported command workspace-write mode");
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        "sugarcode: shell/exec unavailable: sandboxUnavailable\n"
    );
}

#[test]
fn initialization_happy_path_matches_golden_trace() {
    assert_golden("initialize-happy");
}

#[test]
fn initialization_failures_match_golden_trace() {
    assert_golden("initialize-errors");
}

#[test]
fn multi_workspace_app_server_opens_and_routes_independent_contexts() {
    let sugarcode_home = tempfile::tempdir().expect("isolated SugarCode home");
    let provider = BlockingMockProvider::start(sugarcode_home.path());
    let workspace_a = tempfile::tempdir().expect("workspace A");
    let workspace_b = tempfile::tempdir().expect("workspace B");
    let workspace_chat = tempfile::tempdir().expect("chat workspace");
    fs::write(workspace_a.path().join("only-a.txt"), "a").expect("workspace A fixture");
    fs::write(workspace_b.path().join("only-b.txt"), "b").expect("workspace B fixture");
    let mut child = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["app-server", "--stdio", "--multi-workspace"])
        .env("SUGARCODE_HOME", sugarcode_home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn multi-workspace app-server");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));
    send_json(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": "initialize",
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientInfo": {"name": "multi-workspace-test", "version": "1.0.0"}
            }
        }),
    );
    let initialized = read_json(&mut stdout);
    assert_eq!(
        initialized["result"]["capabilities"]["workspaceBrowser"],
        true
    );
    assert!(initialized["result"].get("workspace").is_none());
    send_json(
        &mut stdin,
        json!({"jsonrpc": "2.0", "method": "initialized"}),
    );

    let open = |stdin: &mut std::process::ChildStdin,
                stdout: &mut BufReader<std::process::ChildStdout>,
                id: &str,
                root: &std::path::Path,
                workspace_type: &str|
     -> String {
        send_json(
            stdin,
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "workspace/open",
                "params": {
                    "root": root,
                    "workspaceType": workspace_type,
                    "allowWorkspaceWrite": false,
                    "allowCommandWorkspaceWrite": false
                }
            }),
        );
        read_json(stdout)["result"]["workspaceId"]
            .as_str()
            .expect("workspace ID")
            .to_owned()
    };
    let workspace_id_a = open(
        &mut stdin,
        &mut stdout,
        "open-a",
        workspace_a.path(),
        "project",
    );
    let workspace_id_b = open(
        &mut stdin,
        &mut stdout,
        "open-b",
        workspace_b.path(),
        "project",
    );
    assert_ne!(workspace_id_a, workspace_id_b);
    assert!(!workspace_id_a.contains(workspace_a.path().to_string_lossy().as_ref()));

    let mut thread_ids = Vec::new();
    for (suffix, workspace_id) in [("a", &workspace_id_a), ("b", &workspace_id_b)] {
        send_json(
            &mut stdin,
            json!({
                "jsonrpc": "2.0",
                "id": format!("thread-{suffix}"),
                "method": "thread/start",
                "params": {"workspaceId": workspace_id}
            }),
        );
        let response = read_json(&mut stdout);
        assert_eq!(response["id"], format!("thread-{suffix}"));
        thread_ids.push(
            response["result"]["thread"]["id"]
                .as_str()
                .expect("thread ID")
                .to_owned(),
        );
        let started = read_json(&mut stdout);
        assert_eq!(started["method"], "thread/started");
        assert_eq!(
            started["params"]["thread"]["workspaceId"],
            workspace_id.as_str()
        );
    }

    send_json(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": "list-a",
            "method": "workspace/list",
            "params": {"workspaceId": workspace_id_a, "path": ""}
        }),
    );
    let listed = read_json(&mut stdout);
    assert_eq!(listed["result"]["entries"][0]["name"], "only-a.txt");
    assert!(!listed.to_string().contains("only-b.txt"));

    send_json(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": "turn-a",
            "method": "turn/start",
            "params": {
                "threadId": thread_ids[0],
                "input": [{"type":"text","text":"Keep workspace A busy"}]
            }
        }),
    );
    assert_eq!(read_json(&mut stdout)["id"], "turn-a");
    for expected_method in [
        "turn/started",
        "item/started",
        "item/completed",
        "turn/agentOutput/delta",
    ] {
        let notification = read_json(&mut stdout);
        assert_eq!(notification["method"], expected_method);
        assert_eq!(notification["params"]["workspaceId"], workspace_id_a);
        assert_eq!(notification["params"]["threadId"], thread_ids[0]);
    }
    provider.wait_until_delta_sent();

    send_json(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": "turn-b",
            "method": "turn/start",
            "params": {
                "threadId": thread_ids[1],
                "input": [{"type":"text","text":"Keep workspace B busy"}]
            }
        }),
    );
    assert_eq!(read_json(&mut stdout)["id"], "turn-b");
    for expected_method in ["turn/started", "item/started", "item/completed"] {
        let notification = read_json(&mut stdout);
        assert_eq!(notification["method"], expected_method);
        assert_eq!(notification["params"]["workspaceId"], workspace_id_b);
        assert_eq!(notification["params"]["threadId"], thread_ids[1]);
    }

    let workspace_id_chat = open(
        &mut stdin,
        &mut stdout,
        "open-chat",
        workspace_chat.path(),
        "isolatedChat",
    );
    assert_ne!(workspace_id_chat, workspace_id_a);
    assert_ne!(workspace_id_chat, workspace_id_b);
    send_json(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": "thread-chat",
            "method": "thread/start",
            "params": {"workspaceId": workspace_id_chat}
        }),
    );
    assert_eq!(read_json(&mut stdout)["id"], "thread-chat");
    let chat_started = read_json(&mut stdout);
    assert_eq!(chat_started["method"], "thread/started");
    assert_eq!(
        chat_started["params"]["thread"]["workspaceId"],
        workspace_id_chat
    );

    drop(stdin);
    provider.wait_until_connection_closed();
    assert!(child.wait().expect("wait app-server").success());
}

#[test]
fn thread_start_happy_path_matches_golden_trace() {
    assert_golden("thread-start-happy");
}

#[test]
fn thread_start_failures_match_golden_trace() {
    assert_golden("thread-start-errors");
}

#[test]
fn turn_start_happy_path_matches_golden_trace() {
    assert_golden("turn-start-happy");
}

#[test]
fn turn_start_failures_match_golden_trace() {
    assert_golden("turn-start-errors");
}

#[test]
fn provider_terminal_error_matches_golden_trace() {
    const NON_STREAMING_SERVER_ERROR: &str = concat!(
        "{\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\"},",
        "\"finish_reason\":\"insufficient_system_resource\"}]}"
    );
    let sugarcode_home = tempfile::tempdir().expect("create isolated SugarCode home");
    let _provider = MockProvider::start_with_bodies(
        sugarcode_home.path(),
        vec![
            include_str!("../../model-provider/tests/fixtures/terminal-error.sse"),
            NON_STREAMING_SERVER_ERROR,
        ],
    );
    run_golden("turn-provider-error", &sugarcode_home, None);
}

#[test]
fn workspace_read_tool_lifecycle_matches_golden_trace() {
    const TOOL_CALL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_fixture\",\"type\":\"function\",\"function\":{\"name\":\"workspace/read\",\"arguments\":\"{\\\"path\\\":\\\"context.txt\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    const FINAL_ANSWER: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Read succeeded.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    let sugarcode_home = tempfile::tempdir().expect("create isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("create isolated workspace");
    fs::write(workspace.path().join("context.txt"), "fixture context")
        .expect("write workspace fixture");
    let _provider = MockProvider::start_with_owned_bodies(
        sugarcode_home.path(),
        vec![
            with_fixture_usage(TOOL_CALL),
            with_fixture_usage(FINAL_ANSWER),
        ],
    );
    run_golden(
        "turn-workspace-read",
        &sugarcode_home,
        Some(workspace.path()),
    );
}

#[test]
fn workspace_list_tool_lifecycle_matches_golden_trace() {
    const TOOL_CALL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_list_fixture\",\"type\":\"function\",\"function\":{\"name\":\"workspace/list\",\"arguments\":\"{\\\"path\\\":\\\".\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    const FINAL_ANSWER: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"List succeeded.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    let sugarcode_home = tempfile::tempdir().expect("create isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("create isolated workspace");
    fs::write(workspace.path().join("zeta.txt"), "zeta").expect("write zeta fixture");
    fs::write(workspace.path().join("Alpha.txt"), "alpha").expect("write alpha fixture");
    fs::create_dir(workspace.path().join("src")).expect("write directory fixture");
    fs::write(workspace.path().join("src/nested.txt"), "nested").expect("write nested fixture");
    let _provider = MockProvider::start_with_owned_bodies(
        sugarcode_home.path(),
        vec![
            with_fixture_usage(TOOL_CALL),
            with_fixture_usage(FINAL_ANSWER),
        ],
    );
    run_golden(
        "turn-workspace-list",
        &sugarcode_home,
        Some(workspace.path()),
    );
}

#[test]
fn desktop_workspace_browser_matches_golden_trace() {
    let sugarcode_home = tempfile::tempdir().expect("create isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("create isolated workspace");
    fs::write(workspace.path().join("README.md"), "# Fixture\n").expect("write README");
    fs::create_dir(workspace.path().join("src")).expect("create src");
    run_golden_with_options(
        "workspace-browser-happy",
        &sugarcode_home,
        Some(workspace.path()),
        false,
        false,
        true,
    );
}

#[test]
fn desktop_workspace_git_status_diff_stage_unstage_commit_uses_real_cli() {
    let sugarcode_home = tempfile::tempdir().expect("create isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("create isolated Git workspace");
    configure_model(
        sugarcode_home.path(),
        "127.0.0.1:1".parse().expect("fixture endpoint"),
    );
    let repository = git2::Repository::init(workspace.path()).expect("initialize repository");
    fs::write(workspace.path().join("tracked.txt"), "before\n").expect("write tracked file");
    let mut index = repository.index().expect("index");
    index
        .add_path(std::path::Path::new("tracked.txt"))
        .expect("stage initial file");
    index.write().expect("write index");
    let tree_oid = index.write_tree().expect("tree");
    let tree = repository.find_tree(tree_oid).expect("find tree");
    let signature =
        git2::Signature::now("SugarCode Test", "test@example.invalid").expect("signature");
    repository
        .commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
        .expect("initial commit");
    drop(tree);
    drop(repository);
    fs::write(workspace.path().join("tracked.txt"), "after\n").expect("modify tracked file");

    let mut child = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["--home"])
        .arg(sugarcode_home.path())
        .args(["app-server", "--stdio", "--workspace"])
        .arg(workspace.path())
        .env_remove("SUGARCODE_HOME")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn real CLI");
    let mut stdin = child.stdin.take().expect("CLI stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("CLI stdout"));

    let initialized = exchange(
        &mut stdin,
        &mut stdout,
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientInfo": {"name": "git-acceptance", "version": "1.0.0"}
            }
        }),
    );
    assert_eq!(initialized["result"]["capabilities"]["workspaceGit"], true);
    writeln!(
        stdin,
        "{}",
        json!({"jsonrpc": "2.0", "method": "initialized"})
    )
    .expect("write initialized");
    stdin.flush().expect("flush initialized");

    let status = exchange(
        &mut stdin,
        &mut stdout,
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "workspace/git/status",
            "params": {}
        }),
    );
    assert_eq!(status["result"]["status"], "ready");
    assert_eq!(status["result"]["unstagedCount"], 1);
    let revision = status["result"]["revision"]
        .as_str()
        .expect("status revision")
        .to_string();

    let diff = exchange(
        &mut stdin,
        &mut stdout,
        json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "workspace/git/diff",
            "params": {
                "expectedRevision": revision,
                "path": "tracked.txt",
                "source": "worktree"
            }
        }),
    );
    assert!(
        diff["result"]["content"]
            .as_str()
            .expect("diff content")
            .contains("+after")
    );

    let stage = exchange(
        &mut stdin,
        &mut stdout,
        json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "workspace/git/stage",
            "params": {
                "expectedRevision": revision,
                "paths": ["tracked.txt"]
            }
        }),
    );
    let staged_revision = stage["result"]["revision"]
        .as_str()
        .expect("stage revision")
        .to_string();
    let unstage = exchange(
        &mut stdin,
        &mut stdout,
        json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "workspace/git/unstage",
            "params": {
                "expectedRevision": staged_revision,
                "paths": ["tracked.txt"]
            }
        }),
    );
    let unstaged_revision = unstage["result"]["revision"]
        .as_str()
        .expect("unstage revision")
        .to_string();
    let restage = exchange(
        &mut stdin,
        &mut stdout,
        json!({
            "jsonrpc": "2.0",
            "id": 6,
            "method": "workspace/git/stage",
            "params": {
                "expectedRevision": unstaged_revision,
                "paths": ["tracked.txt"]
            }
        }),
    );
    let commit = exchange(
        &mut stdin,
        &mut stdout,
        json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "workspace/git/commit",
            "params": {
                "expectedRevision": restage["result"]["revision"],
                "message": "update tracked file",
                "authorName": "SugarCode Test",
                "authorEmail": "test@example.invalid"
            }
        }),
    );
    assert_eq!(commit["result"]["status"], "committed");
    let expected_head = commit["result"]["newHead"]
        .as_str()
        .expect("commit oid")
        .to_string();

    drop(stdin);
    let output = child.wait_with_output().expect("wait for real CLI");
    assert!(output.status.success(), "{output:?}");
    let reopened = git2::Repository::open(workspace.path()).expect("reopen repository");
    assert_eq!(
        reopened
            .head()
            .expect("head")
            .target()
            .expect("head oid")
            .to_string(),
        expected_head
    );
}

fn exchange(
    stdin: &mut std::process::ChildStdin,
    stdout: &mut BufReader<std::process::ChildStdout>,
    request: Value,
) -> Value {
    writeln!(stdin, "{request}").expect("write JSON-RPC request");
    stdin.flush().expect("flush JSON-RPC request");
    let mut line = String::new();
    stdout.read_line(&mut line).expect("read JSON-RPC response");
    assert!(!line.is_empty(), "CLI closed before responding");
    serde_json::from_str(&line).expect("parse JSON-RPC response")
}

#[test]
fn workspace_search_tool_lifecycle_matches_golden_trace() {
    const TOOL_CALL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_search_fixture\",\"type\":\"function\",\"function\":{\"name\":\"workspace/search\",\"arguments\":\"{\\\"path\\\":\\\"src\\\",\\\"query\\\":\\\"needle\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    const FINAL_ANSWER: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Search succeeded.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    let sugarcode_home = tempfile::tempdir().expect("create isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("create isolated workspace");
    fs::create_dir(workspace.path().join("src")).expect("create src");
    fs::write(workspace.path().join("src/lib.rs"), "first\nneedle here\n")
        .expect("write search fixture");
    let _provider = MockProvider::start_with_owned_bodies(
        sugarcode_home.path(),
        vec![
            with_fixture_usage(TOOL_CALL),
            with_fixture_usage(FINAL_ANSWER),
        ],
    );
    run_golden(
        "turn-workspace-search",
        &sugarcode_home,
        Some(workspace.path()),
    );
}

#[test]
fn workspace_apply_diff_lifecycle_matches_golden_trace() {
    const TOOL_CALL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_patch_fixture\",\"type\":\"function\",\"function\":{\"name\":\"workspace/apply-diff\",\"arguments\":\"{\\\"path\\\":\\\"notes.txt\\\",\\\"diff\\\":\\\"--- a/notes.txt\\\\n+++ b/notes.txt\\\\n@@ -1,3 +1,3 @@\\\\n one\\\\n-two\\\\n+second\\\\n three\\\\n\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    const FINAL_ANSWER: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Patch succeeded.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    let sugarcode_home = tempfile::tempdir().expect("create isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("create isolated workspace");
    let target = workspace.path().join("notes.txt");
    fs::write(&target, "one\ntwo\nthree\n").expect("write patch fixture");
    let _provider = MockProvider::start_with_owned_bodies(
        sugarcode_home.path(),
        vec![
            with_fixture_usage(TOOL_CALL),
            with_fixture_usage(FINAL_ANSWER),
        ],
    );
    run_golden_with_options(
        "turn-workspace-apply-diff",
        &sugarcode_home,
        Some(workspace.path()),
        true,
        false,
        true,
    );
    assert_eq!(
        fs::read_to_string(target).expect("read patched fixture"),
        "one\nsecond\nthree\n"
    );
}

#[test]
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn denied_shell_approval_matches_bidirectional_golden_trace() {
    let command = "/fixture/denied-command";
    let arguments = serde_json::to_string(&json!({
        "description": "Run the denied approval fixture.",
        "command": command,
        "argvJson": "[]",
        "cwd": "."
    }))
    .expect("shell arguments");
    let tool_call = format!(
        "data: {}\n\ndata: {{\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n",
        json!({
            "choices": [{
                "index": 0,
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_shell_fixture",
                        "type": "function",
                        "function": {
                            "name": "shell/exec",
                            "arguments": arguments
                        }
                    }]
                },
                "finish_reason": Value::Null
            }]
        })
    );
    let final_answer = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Command denied.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    )
    .to_string();
    let sugarcode_home = tempfile::tempdir().expect("create isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("create isolated workspace");
    let _provider =
        MockProvider::start_with_owned_bodies(sugarcode_home.path(), vec![tool_call, final_answer]);
    run_golden(
        "turn-shell-approval-denied",
        &sugarcode_home,
        Some(workspace.path()),
    );
}

#[test]
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn approved_shell_approval_matches_execution_attempt_golden_trace() {
    let sugarcode_executable = PathBuf::from(env!("CARGO_BIN_EXE_sugarcode"));
    let sugarcode_directory = sugarcode_executable
        .parent()
        .expect("SugarCode test binary directory");
    let mut command_search_path = vec![sugarcode_directory.to_path_buf()];
    if let Some(host_path) = std::env::var_os("PATH") {
        command_search_path.extend(std::env::split_paths(&host_path));
    }
    let command_search_path =
        std::env::join_paths(command_search_path).expect("construct command search path");
    let arguments = serde_json::to_string(&json!({
        "description": "Check the SugarCode version.",
        "command": "/usr/bin/env",
        "argvJson": "[\"sugarcode\",\"version\"]",
        "cwd": "."
    }))
    .expect("shell arguments");
    let tool_call = format!(
        "data: {}\n\ndata: {{\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n",
        json!({
            "choices": [{
                "index": 0,
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_shell_fixture",
                        "type": "function",
                        "function": {
                            "name": "shell/exec",
                            "arguments": arguments
                        }
                    }]
                },
                "finish_reason": Value::Null
            }]
        })
    );
    let final_answer = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Version checked.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    )
    .to_string();
    let sugarcode_home = tempfile::tempdir().expect("create isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("create isolated workspace");
    let _provider =
        MockProvider::start_with_owned_bodies(sugarcode_home.path(), vec![tool_call, final_answer]);
    run_golden_with_options_and_environment(
        "turn-shell-approval-approved",
        &sugarcode_home,
        Some(workspace.path()),
        false,
        false,
        true,
        &[("PATH", command_search_path)],
    );
}

#[test]
#[cfg(target_os = "linux")]
fn informed_workspace_write_approval_mutates_the_real_workspace_and_matches_golden() {
    let command = env!("CARGO_BIN_EXE_sugarcode");
    let arguments = serde_json::to_string(&json!({
        "description": "Update the workspace acceptance fixtures.",
        "command": command,
        "argvJson": "[\"__command-workspace-write-acceptance\"]",
        "cwd": "."
    }))
    .expect("shell arguments");
    let tool_call = format!(
        "data: {}\n\ndata: {{\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n",
        json!({
            "choices": [{
                "index": 0,
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_workspace_write_fixture",
                        "type": "function",
                        "function": {
                            "name": "shell/exec",
                            "arguments": arguments
                        }
                    }]
                },
                "finish_reason": Value::Null
            }]
        })
    );
    let final_answer = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Workspace command completed.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    )
    .to_string();
    let sugarcode_home = tempfile::tempdir().expect("create isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("create isolated workspace");
    fs::write(workspace.path().join("updated.txt"), "before\n").expect("updated fixture");
    fs::write(workspace.path().join("deleted.txt"), "delete\n").expect("deleted fixture");
    fs::write(workspace.path().join("rename-source.txt"), "rename\n").expect("rename fixture");
    fs::write(workspace.path().join("hardlink-source.txt"), "link\n").expect("hardlink fixture");
    fs::write(workspace.path().join("symlink-target.txt"), "target\n").expect("symlink fixture");
    let _provider =
        MockProvider::start_with_owned_bodies(sugarcode_home.path(), vec![tool_call, final_answer]);

    run_golden_with_options(
        "turn-shell-workspace-write-informed",
        &sugarcode_home,
        Some(workspace.path()),
        false,
        true,
        true,
    );

    assert_eq!(
        fs::read_to_string(workspace.path().join("updated.txt")).expect("updated result"),
        "after\n"
    );
    assert_eq!(
        fs::read_to_string(workspace.path().join("created.txt")).expect("created result"),
        "created\n"
    );
    assert!(!workspace.path().join("deleted.txt").exists());
    assert!(!workspace.path().join("rename-source.txt").exists());
    assert_eq!(
        fs::read_to_string(workspace.path().join("renamed.txt")).expect("renamed result"),
        "rename\n"
    );
    assert_eq!(
        fs::read_to_string(workspace.path().join("hardlink-created.txt")).expect("hardlink result"),
        "link\n"
    );
    assert_eq!(
        fs::read_link(workspace.path().join("symlink-created.txt")).expect("symlink result"),
        std::path::PathBuf::from("symlink-target.txt")
    );
    assert_eq!(
        fs::read(workspace.path().join("binary.bin")).expect("binary result"),
        [0_u8, 159, 146, 150, 255]
    );
}

#[test]
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn approved_command_stays_bound_to_the_original_workspace_scope() {
    let command = "/bin/cat";
    let arguments = serde_json::to_string(&json!({
        "description": "Read the workspace marker file.",
        "command": command,
        "arguments": ["marker.txt"],
        "cwd": "."
    }))
    .expect("shell arguments");
    let tool_call = format!(
        "data: {}\n\ndata: {{\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n",
        json!({
            "choices": [{
                "index": 0,
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_shell_real",
                        "type": "function",
                        "function": {
                            "name": "shell/exec",
                            "arguments": arguments
                        }
                    }]
                },
                "finish_reason": Value::Null
            }]
        })
    );
    let final_answer = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Marker checked.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    )
    .to_string();
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let workspace_parent = tempfile::tempdir().expect("isolated workspace parent");
    let workspace = workspace_parent.path().join("workspace");
    let active_scope = workspace.join("active");
    let moved_scope = workspace.join("moved-active");
    let replacement = workspace_parent.path().join("replacement");
    fs::create_dir(&workspace).expect("create workspace root");
    fs::create_dir(&active_scope).expect("create active scope");
    fs::create_dir(&replacement).expect("create replacement");
    fs::write(active_scope.join("marker.txt"), "original").expect("write original marker");
    fs::write(replacement.join("marker.txt"), "replacement").expect("write replacement marker");
    let _provider =
        MockProvider::start_with_owned_bodies(home.path(), vec![tool_call, final_answer]);
    let mut child = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["app-server", "--stdio", "--workspace"])
        .arg(&workspace)
        .args(["--workspace-scope", "active"])
        .env("SUGARCODE_HOME", home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn app-server");
    let mut stdin = child.stdin.take().expect("child stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("child stdout"));
    send_json(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": "initialize",
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientInfo": {"name": "shell-root-binding-test", "version": "1.0.0"},
                "capabilities": {"commandApprovals": true}
            }
        }),
    );
    assert_eq!(read_json(&mut stdout)["id"], "initialize");
    send_json(
        &mut stdin,
        json!({"jsonrpc": "2.0", "method": "initialized"}),
    );
    send_json(
        &mut stdin,
        json!({"jsonrpc": "2.0", "id": "thread", "method": "thread/start"}),
    );
    let thread = read_json(&mut stdout);
    let thread_id = thread["result"]["thread"]["id"]
        .as_str()
        .expect("thread id")
        .to_string();
    assert_eq!(read_json(&mut stdout)["method"], "thread/started");
    send_json(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": "turn",
            "method": "turn/start",
            "params": {"threadId": thread_id, "input": [{"type":"text","text":"Read marker"}]}
        }),
    );
    assert_eq!(read_json(&mut stdout)["id"], "turn");

    let mut process_result = None;
    let mut saw_execution_attempt = false;
    loop {
        let message = read_json(&mut stdout);
        if message["method"] == "item/commandExecution/requestApproval" {
            assert_eq!(message["params"]["sandboxed"], true);
            assert_eq!(message["params"]["sandboxPolicy"], "filesystemReadOnlyV1");
            assert_eq!(message["params"]["networkPolicy"], "networkDeniedV1");
            fs::rename(&active_scope, &moved_scope).expect("move original scope");
            std::os::unix::fs::symlink(&replacement, &active_scope)
                .expect("replace scope path with symlink");
            send_json(
                &mut stdin,
                json!({
                    "jsonrpc": "2.0",
                    "id": message["id"].clone(),
                    "result": {"decision": "approved"}
                }),
            );
        }
        if message["method"] == "item/completed"
            && message["params"]["item"]["type"] == "commandExecutionAttempt"
        {
            saw_execution_attempt = true;
        }
        if message["method"] == "item/completed"
            && message["params"]["item"]["type"] == "toolResult"
        {
            assert!(saw_execution_attempt, "attempt must precede process result");
            process_result = Some(message["params"]["item"]["result"].clone());
        }
        if message["method"] == "turn/completed" {
            assert_eq!(message["params"]["turn"]["status"], "completed");
            break;
        }
    }
    let process_result = process_result.expect("process result");
    assert_eq!(process_result["type"], "process");
    assert_eq!(process_result["outcome"]["type"], "exitCode");
    assert_eq!(process_result["outcome"]["code"], 0);
    assert_eq!(process_result["sandboxPolicy"], "filesystemReadOnlyV1");
    assert_eq!(process_result["networkPolicy"], "networkDeniedV1");
    assert_eq!(process_result["stdout"], "original");
    drop(stdin);
    let output = child.wait_with_output().expect("wait app-server");
    assert!(output.status.success(), "{output:?}");
    assert!(output.stderr.is_empty(), "{output:?}");
}

#[test]
fn model_configuration_is_resolved_per_turn_without_restarting_app_server() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("isolated workspace");
    fs::write(
        home.path().join("config.toml"),
        "schema_version = 1\n\
         [model]\n\
         api_format = \"openai-chat-completions\"\n\
         endpoint = \"https://example.com/v1/chat/completions\"\n\
         model = \"fixture-model\"\n\
         api_key = \"invalid key\"\n",
    )
    .expect("invalid model config");
    let mut child = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["--home"])
        .arg(home.path())
        .args(["app-server", "--stdio", "--workspace"])
        .arg(workspace.path())
        .env_remove("SUGARCODE_HOME")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn app-server");
    let mut stdin = child.stdin.take().expect("child stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("child stdout"));
    send_json(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": "initialize",
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientInfo": {"name": "model-missing-test", "version": "1.0.0"}
            }
        }),
    );
    let initialized = read_json(&mut stdout);
    assert_eq!(initialized["id"], "initialize");
    assert_eq!(
        initialized["result"]["capabilities"]["workspaceBrowser"],
        true
    );
    send_json(
        &mut stdin,
        json!({"jsonrpc": "2.0", "method": "initialized"}),
    );
    send_json(
        &mut stdin,
        json!({"jsonrpc": "2.0", "id": "thread", "method": "thread/start"}),
    );
    let thread = read_json(&mut stdout);
    let thread_id = thread["result"]["thread"]["id"]
        .as_str()
        .expect("thread id")
        .to_string();
    assert_eq!(read_json(&mut stdout)["method"], "thread/started");
    send_json(
        &mut stdin,
        json!({
        "jsonrpc": "2.0",
        "id": "missing-model",
        "method": "turn/start",
        "params": {"threadId": thread_id, "input": [{"type":"text","text":"Hello"}]}
        }),
    );
    let missing_model = read_json(&mut stdout);
    assert_eq!(missing_model["id"], "missing-model");
    assert_eq!(missing_model["error"]["message"], "Model unavailable");

    let _provider = MockProvider::start_with_body(
        home.path(),
        include_str!("../../model-provider/tests/fixtures/completed.sse"),
    );
    send_json(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": "configured-model",
            "method": "turn/start",
            "params": {"threadId": thread_id, "input": [{"type":"text","text":"Hello again"}]}
        }),
    );
    assert_eq!(read_json(&mut stdout)["id"], "configured-model");
    loop {
        let message = read_json(&mut stdout);
        if message["method"] == "turn/completed" {
            assert_eq!(message["params"]["turn"]["status"], "completed");
            break;
        }
    }
    drop(stdin);
    let output = child.wait_with_output().expect("wait for app-server");
    assert!(output.status.success(), "{output:?}");
    let expected_stderr = if cfg!(windows) {
        "sugarcode: shell/exec unavailable: sandboxUnavailable\n"
    } else {
        ""
    };
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        expected_stderr,
        "unexpected protocol diagnostics"
    );
}

#[test]
fn cli_interrupt_closes_http_stream_and_emits_one_interrupted_terminal() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let provider = BlockingMockProvider::start(home.path());
    let mut child = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["--home"])
        .arg(home.path())
        .args(["app-server", "--stdio"])
        .env_remove("SUGARCODE_HOME")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn app-server");
    let mut stdin = child.stdin.take().expect("child stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("child stdout"));

    send_json(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": "initialize",
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientInfo": {"name": "interrupt-test", "version": "1.0.0"}
            }
        }),
    );
    assert_eq!(read_json(&mut stdout)["id"], "initialize");
    send_json(
        &mut stdin,
        json!({"jsonrpc": "2.0", "method": "initialized"}),
    );
    send_json(
        &mut stdin,
        json!({"jsonrpc": "2.0", "id": "thread", "method": "thread/start"}),
    );
    let thread_response = read_json(&mut stdout);
    let thread_id = thread_response["result"]["thread"]["id"]
        .as_str()
        .expect("thread id")
        .to_string();
    assert_eq!(read_json(&mut stdout)["method"], "thread/started");
    send_json(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": "turn",
            "method": "turn/start",
            "params": {"threadId": thread_id, "input": [{"type":"text","text":"Hello"}]}
        }),
    );
    let turn_response = read_json(&mut stdout);
    let turn_id = turn_response["result"]["turn"]["id"]
        .as_str()
        .expect("turn id")
        .to_string();
    let before_interrupt = [
        read_json(&mut stdout),
        read_json(&mut stdout),
        read_json(&mut stdout),
        read_json(&mut stdout),
    ];
    assert_eq!(before_interrupt[0]["method"], "turn/started");
    assert_eq!(before_interrupt[1]["method"], "item/started");
    assert_eq!(before_interrupt[1]["params"]["item"]["type"], "userMessage");
    assert_eq!(before_interrupt[2]["method"], "item/completed");
    assert_eq!(before_interrupt[3]["method"], "turn/agentOutput/delta");
    provider.wait_until_delta_sent();

    send_json(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": "interrupt",
            "method": "thread/fork",
            "params": {"threadId": thread_id}
        }),
    );
    let active_error = read_json(&mut stdout);
    assert_eq!(active_error["id"], "interrupt", "{active_error}");
    assert_eq!(active_error["error"]["code"], -32009);
    assert_eq!(active_error["error"]["data"]["turnId"], turn_id);

    send_json(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": "interrupt",
            "method": "turn/interrupt",
            "params": {"threadId": thread_id, "turnId": turn_id}
        }),
    );
    let after_interrupt = [read_json(&mut stdout), read_json(&mut stdout)];
    assert_eq!(
        after_interrupt
            .iter()
            .filter(|message| message["id"] == "interrupt" && message["result"] == json!({}))
            .count(),
        1
    );
    assert_eq!(after_interrupt[0]["method"], "turn/completed");
    assert_eq!(after_interrupt[1]["id"], "interrupt");
    assert_eq!(
        after_interrupt
            .iter()
            .filter(|message| message["method"] == "item/completed")
            .count(),
        0
    );
    let terminal = after_interrupt
        .iter()
        .find(|message| message["method"] == "turn/completed")
        .expect("turn terminal");
    assert_eq!(terminal["params"]["turn"]["status"], "interrupted");
    provider.wait_until_connection_closed();

    drop(stdin);
    let status = child.wait().expect("wait for app-server");
    assert!(status.success(), "{status:?}");
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .expect("stderr")
        .read_to_string(&mut stderr)
        .expect("read stderr");
    assert!(stderr.is_empty(), "unexpected diagnostics: {stderr}");
}

#[test]
fn stdin_eof_interrupts_active_stream_flushes_terminal_and_replays_it_once() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let provider = BlockingMockProvider::start(home.path());
    let mut child = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["--home"])
        .arg(home.path())
        .args(["app-server", "--stdio"])
        .env_remove("SUGARCODE_HOME")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn app-server");
    let mut stdin = child.stdin.take().expect("child stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("child stdout"));

    send_json(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": "initialize",
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientInfo": {"name": "eof-test", "version": "1.0.0"}
            }
        }),
    );
    assert_eq!(read_json(&mut stdout)["id"], "initialize");
    send_json(
        &mut stdin,
        json!({"jsonrpc": "2.0", "method": "initialized"}),
    );
    send_json(
        &mut stdin,
        json!({"jsonrpc": "2.0", "id": "thread", "method": "thread/start"}),
    );
    let thread_response = read_json(&mut stdout);
    let thread_id = thread_response["result"]["thread"]["id"]
        .as_str()
        .expect("thread id")
        .to_string();
    assert_eq!(read_json(&mut stdout)["method"], "thread/started");
    send_json(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": "turn",
            "method": "turn/start",
            "params": {"threadId": thread_id, "input": [{"type":"text","text":"Hello"}]}
        }),
    );
    assert_eq!(read_json(&mut stdout)["id"], "turn");
    for expected in [
        "turn/started",
        "item/started",
        "item/completed",
        "turn/agentOutput/delta",
    ] {
        assert_eq!(read_json(&mut stdout)["method"], expected);
    }
    provider.wait_until_delta_sent();

    drop(stdin);
    let mut trailing = String::new();
    stdout
        .read_to_string(&mut trailing)
        .expect("drain shutdown output");
    let trailing = trailing
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("shutdown JSON"))
        .collect::<Vec<_>>();
    assert_eq!(trailing.len(), 1);
    assert_eq!(trailing[0]["method"], "turn/completed");
    assert_eq!(
        trailing[0]["params"]["turn"]["status"], "interrupted",
        "{trailing:?}"
    );
    provider.wait_until_connection_closed();
    assert!(child.wait().expect("wait app-server").success());
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .expect("stderr")
        .read_to_string(&mut stderr)
        .expect("read stderr");
    assert!(stderr.is_empty(), "{stderr}");
    drop(provider);

    let mut restarted = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["--home"])
        .arg(home.path())
        .args(["app-server", "--stdio"])
        .env_remove("SUGARCODE_HOME")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("restart app-server");
    let mut restarted_stdin = restarted.stdin.take().expect("restart stdin");
    let mut restarted_stdout = BufReader::new(restarted.stdout.take().expect("restart stdout"));
    send_json(
        &mut restarted_stdin,
        json!({
            "jsonrpc": "2.0",
            "id": "initialize",
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientInfo": {"name": "eof-restart-test", "version": "1.0.0"}
            }
        }),
    );
    assert_eq!(read_json(&mut restarted_stdout)["id"], "initialize");
    send_json(
        &mut restarted_stdin,
        json!({"jsonrpc": "2.0", "method": "initialized"}),
    );
    send_json(
        &mut restarted_stdin,
        json!({
            "jsonrpc": "2.0",
            "id": "resume",
            "method": "thread/resume",
            "params": {"threadId": thread_id}
        }),
    );
    let resumed = read_json(&mut restarted_stdout);
    assert_eq!(
        resumed["result"]["turns"].as_array().expect("turns").len(),
        1
    );
    assert_eq!(resumed["result"]["turns"][0]["status"], "interrupted");
    drop(restarted_stdin);
    assert!(
        restarted
            .wait()
            .expect("wait restarted app-server")
            .success()
    );
}

#[test]
fn thread_resume_failures_match_golden_trace() {
    assert_golden("thread-resume-errors");
}

#[test]
fn thread_list_happy_path_matches_golden_trace() {
    assert_golden("thread-list-happy");
}

#[test]
fn thread_list_failures_match_golden_trace() {
    assert_golden("thread-list-errors");
}

#[test]
fn thread_search_happy_path_matches_golden_trace() {
    assert_golden("thread-search-happy");
}

#[test]
fn thread_search_failures_match_golden_trace() {
    assert_golden("thread-search-errors");
}

#[test]
fn thread_archive_happy_path_matches_golden_trace() {
    assert_golden("thread-archive-happy");
}

#[test]
fn thread_archive_failures_match_golden_trace() {
    assert_golden("thread-archive-errors");
}

#[test]
fn thread_unarchive_happy_path_matches_golden_trace() {
    assert_golden("thread-unarchive-happy");
}

#[test]
fn thread_unarchive_failures_match_golden_trace() {
    assert_golden("thread-unarchive-errors");
}

#[test]
fn thread_delete_happy_path_matches_golden_trace() {
    assert_golden("thread-delete-happy");
}

#[test]
fn thread_delete_failures_match_golden_trace() {
    assert_golden("thread-delete-errors");
}

#[test]
fn thread_fork_happy_path_matches_golden_trace() {
    assert_golden("thread-fork-happy");
}

#[test]
fn thread_fork_failures_match_golden_trace() {
    assert_golden("thread-fork-errors");
}

fn assert_golden(name: &str) {
    assert_golden_with_body(
        name,
        include_str!("../../model-provider/tests/fixtures/completed.sse"),
    );
}

fn assert_golden_with_body(name: &str, provider_body: &'static str) {
    let sugarcode_home = tempfile::tempdir().expect("create isolated SugarCode home");
    let _provider = MockProvider::start_with_body(sugarcode_home.path(), provider_body);
    run_golden(name, &sugarcode_home, None);
}

fn run_golden(name: &str, sugarcode_home: &tempfile::TempDir, workspace: Option<&std::path::Path>) {
    run_golden_with_options(
        name,
        sugarcode_home,
        workspace,
        false,
        false,
        workspace.is_some(),
    );
}

fn run_golden_with_options(
    name: &str,
    sugarcode_home: &tempfile::TempDir,
    workspace: Option<&std::path::Path>,
    allow_workspace_write: bool,
    allow_command_workspace_write: bool,
    expect_windows_shell_unavailable: bool,
) {
    run_golden_with_options_and_environment(
        name,
        sugarcode_home,
        workspace,
        allow_workspace_write,
        allow_command_workspace_write,
        expect_windows_shell_unavailable,
        &[],
    );
}

fn run_golden_with_options_and_environment(
    name: &str,
    sugarcode_home: &tempfile::TempDir,
    workspace: Option<&std::path::Path>,
    allow_workspace_write: bool,
    allow_command_workspace_write: bool,
    expect_windows_shell_unavailable: bool,
    environment: &[(&str, std::ffi::OsString)],
) {
    let fixture_root =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../protocol-fixtures/app-server/v1");
    let input = fs::read_to_string(fixture_root.join(format!("{name}.stdin.jsonl")))
        .expect("read golden stdin");
    let expected = fs::read_to_string(fixture_root.join(format!("{name}.stdout.jsonl")))
        .expect("read golden stdout");

    let mut command = Command::new(env!("CARGO_BIN_EXE_sugarcode"));
    command.args(["app-server", "--stdio"]);
    if let Some(workspace) = workspace {
        command.arg("--workspace").arg(workspace);
    }
    if allow_workspace_write {
        command.arg("--allow-workspace-write");
    }
    if allow_command_workspace_write {
        command.arg("--allow-command-workspace-write");
    }
    for (name, value) in environment {
        command.env(name, value);
    }
    let mut child = command
        .env("SUGARCODE_HOME", sugarcode_home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn sugarcode app-server");
    let mut stdin = child.stdin.take().expect("child stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("child stdout"));
    let expected_values = expected
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("golden output JSON"))
        .collect::<Vec<_>>();
    let mut expected_to_actual_ids = BTreeMap::new();
    let mut actual_to_expected_ids = BTreeMap::new();
    let mut expected_index = 0usize;
    let mut actual = String::new();
    let input_lines = input.lines().collect::<Vec<_>>();
    for (input_index, input_line) in input_lines.iter().enumerate() {
        let mut input_value = serde_json::from_str::<Value>(input_line);
        let resolved_input_line = match &mut input_value {
            Ok(resolved_input) => {
                replace_mapped_ids(resolved_input, &expected_to_actual_ids);
                serde_json::to_string(resolved_input).expect("resolved golden input serializes")
            }
            Err(_) => (*input_line).to_string(),
        };
        let response_id = match &input_value {
            Ok(Value::Object(object))
                if object.get("method").is_none()
                    && (object.contains_key("result") || object.contains_key("error")) =>
            {
                object.get("id")
            }
            _ => None,
        };
        if let Some(response_id) = response_id {
            loop {
                let line = read_golden_protocol_line(&mut stdout, "golden server request");
                let server_message = serde_json::from_str::<Value>(line.trim_end())
                    .expect("golden server request JSON");
                actual.push_str(&canonicalize_golden_line(
                    &line,
                    &expected_values[expected_index],
                    &mut expected_to_actual_ids,
                    &mut actual_to_expected_ids,
                ));
                expected_index += 1;
                if server_message.get("id") == Some(response_id)
                    && server_message.get("method").is_some()
                {
                    break;
                }
            }
        }
        writeln!(stdin, "{resolved_input_line}").expect("write fixture input");
        stdin.flush().expect("flush fixture input");
        let expects_response = match input_value {
            Err(_) => true,
            Ok(Value::Object(object)) => object.contains_key("method") && object.contains_key("id"),
            Ok(_) => true,
        };
        if !expects_response {
            if input_index + 1 == input_lines.len() {
                while expected_index < expected_values.len() {
                    let line = read_golden_protocol_line(&mut stdout, "golden terminal");
                    actual.push_str(&canonicalize_golden_line(
                        &line,
                        &expected_values[expected_index],
                        &mut expected_to_actual_ids,
                        &mut actual_to_expected_ids,
                    ));
                    expected_index += 1;
                }
            }
            continue;
        }
        loop {
            let line = read_golden_protocol_line(&mut stdout, "golden response");
            actual.push_str(&canonicalize_golden_line(
                &line,
                &expected_values[expected_index],
                &mut expected_to_actual_ids,
                &mut actual_to_expected_ids,
            ));
            expected_index += 1;
            if expected_index >= expected_values.len()
                || expected_values[expected_index].get("id").is_some()
            {
                break;
            }
        }
    }
    drop(stdin);
    let mut trailing = String::new();
    stdout
        .read_to_string(&mut trailing)
        .expect("drain protocol output");
    for line in trailing.lines() {
        actual.push_str(&canonicalize_golden_line(
            line,
            &expected_values[expected_index],
            &mut expected_to_actual_ids,
            &mut actual_to_expected_ids,
        ));
        expected_index += 1;
    }
    let output = child.wait_with_output().expect("wait for app-server");

    assert!(output.status.success(), "app-server failed: {output:?}");
    let expected_stderr = if cfg!(windows) && expect_windows_shell_unavailable {
        "sugarcode: shell/exec unavailable: sandboxUnavailable\n"
    } else {
        ""
    };
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        expected_stderr,
        "unexpected protocol diagnostics"
    );
    assert!(output.stdout.is_empty(), "stdout was already captured");
    if allow_command_workspace_write {
        assert!(
            actual
                .matches(r#""workspaceWritePolicy":"commandWorkspaceWriteV1""#)
                .count()
                >= 4,
            "workspace-write policy is missing from the approval and process audit: {actual}"
        );
    }
    let actual = normalize_trace(&actual);
    let expected = normalize_trace(&expected);
    assert_eq!(actual, expected);
}

fn canonicalize_golden_line(
    line: &str,
    expected: &Value,
    expected_to_actual: &mut BTreeMap<String, String>,
    actual_to_expected: &mut BTreeMap<String, String>,
) -> String {
    let mut actual =
        serde_json::from_str::<Value>(line.trim_end()).expect("golden protocol line JSON");
    learn_uuid_mappings(expected, &actual, expected_to_actual, actual_to_expected);
    replace_mapped_ids(&mut actual, actual_to_expected);
    format!(
        "{}\n",
        serde_json::to_string(&actual).expect("canonical golden line serializes")
    )
}

fn learn_uuid_mappings(
    expected: &Value,
    actual: &Value,
    expected_to_actual: &mut BTreeMap<String, String>,
    actual_to_expected: &mut BTreeMap<String, String>,
) {
    match (expected, actual) {
        (Value::String(expected), Value::String(actual))
            if expected != actual
                && is_canonical_uuid_v7(expected)
                && is_canonical_uuid_v7(actual) =>
        {
            if let Some(mapped) = expected_to_actual.insert(expected.clone(), actual.clone()) {
                assert_eq!(mapped, *actual, "golden UUID placeholder changed identity");
            }
            if let Some(mapped) = actual_to_expected.insert(actual.clone(), expected.clone()) {
                assert_eq!(mapped, *expected, "generated UUID was reused");
            }
        }
        (Value::Array(expected), Value::Array(actual)) => {
            for (expected, actual) in expected.iter().zip(actual) {
                learn_uuid_mappings(expected, actual, expected_to_actual, actual_to_expected);
            }
        }
        (Value::Object(expected), Value::Object(actual)) => {
            for (key, expected) in expected {
                if let Some(actual) = actual.get(key) {
                    learn_uuid_mappings(expected, actual, expected_to_actual, actual_to_expected);
                }
            }
        }
        _ => {}
    }
}

fn replace_mapped_ids(value: &mut Value, replacements: &BTreeMap<String, String>) {
    match value {
        Value::String(value) => {
            for (from, to) in replacements {
                if value.contains(from) {
                    *value = value.replace(from, to);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                replace_mapped_ids(value, replacements);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                replace_mapped_ids(value, replacements);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn is_canonical_uuid_v7(value: &str) -> bool {
    value.len() == 36
        && value.as_bytes().get(14) == Some(&b'7')
        && matches!(value.as_bytes().get(19), Some(b'8' | b'9' | b'a' | b'b'))
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
        })
}

struct MockProvider {
    address: std::net::SocketAddr,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl MockProvider {
    fn start_with_body(home: &std::path::Path, body: &'static str) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind mock provider");
        let address = listener.local_addr().expect("mock provider address");
        configure_model(home, address);
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let thread = thread::spawn(move || {
            while !thread_stop.load(Ordering::Acquire) {
                let (mut stream, _) = listener.accept().expect("accept provider request");
                if thread_stop.load(Ordering::Acquire) {
                    break;
                }
                serve_recorded_response(&mut stream, body);
            }
        });
        Self {
            address,
            stop,
            thread: Some(thread),
        }
    }

    fn start_with_bodies(home: &std::path::Path, bodies: Vec<&'static str>) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind mock provider");
        let address = listener.local_addr().expect("mock provider address");
        configure_model(home, address);
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let thread = thread::spawn(move || {
            let mut bodies = bodies.into_iter();
            while !thread_stop.load(Ordering::Acquire) {
                let (mut stream, _) = listener.accept().expect("accept provider request");
                if thread_stop.load(Ordering::Acquire) {
                    break;
                }
                let body = bodies.next().expect("recorded provider response");
                serve_recorded_response(&mut stream, body);
            }
        });
        Self {
            address,
            stop,
            thread: Some(thread),
        }
    }

    fn start_with_owned_bodies(home: &std::path::Path, bodies: Vec<String>) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind mock provider");
        let address = listener.local_addr().expect("mock provider address");
        configure_model(home, address);
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let thread = thread::spawn(move || {
            let mut bodies = bodies.into_iter();
            while !thread_stop.load(Ordering::Acquire) {
                let (mut stream, _) = listener.accept().expect("accept provider request");
                if thread_stop.load(Ordering::Acquire) {
                    break;
                }
                let body = bodies.next().expect("recorded provider response");
                serve_recorded_response(&mut stream, &body);
            }
        });
        Self {
            address,
            stop,
            thread: Some(thread),
        }
    }
}

fn with_fixture_usage(body: &str) -> String {
    body.replacen(
        "data: [DONE]\n\n",
        concat!(
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1,",
            "\"completion_tokens\":3,\"total_tokens\":4}}\n\n",
            "data: [DONE]\n\n"
        ),
        1,
    )
}

impl Drop for MockProvider {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = TcpStream::connect(self.address);
        if let Some(thread) = self.thread.take() {
            thread.join().expect("join mock provider");
        }
    }
}

fn serve_recorded_response(stream: &mut TcpStream, body: &str) {
    let mut request = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        let read = stream.read(&mut buffer).expect("read provider request");
        assert!(read > 0, "provider request ended before headers");
        request.extend_from_slice(&buffer[..read]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        assert!(
            request.len() <= 64 * 1024,
            "provider request headers too large"
        );
    }
    let headers = String::from_utf8_lossy(&request);
    assert!(headers.starts_with("POST /v1/chat/completions HTTP/1.1\r\n"));
    assert!(!headers.to_ascii_lowercase().contains("authorization:"));
    let header_end = request
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("complete provider headers")
        + 4;
    let content_length = headers
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length: ")
                .and_then(|value| value.parse::<usize>().ok())
        })
        .expect("provider content length");
    assert!(
        content_length <= 1024 * 1024,
        "provider request body too large"
    );
    while request.len() - header_end < content_length {
        let read = stream
            .read(&mut buffer)
            .expect("read provider request body");
        assert!(read > 0, "provider request body ended early");
        request.extend_from_slice(&buffer[..read]);
    }
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
    .expect("write provider response");
    stream.flush().expect("flush provider response");
}

struct BlockingMockProvider {
    delta_sent: mpsc::Receiver<()>,
    connection_closed: mpsc::Receiver<()>,
    thread: Option<JoinHandle<()>>,
}

impl BlockingMockProvider {
    fn start(home: &std::path::Path) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind blocking provider");
        let address = listener.local_addr().expect("blocking provider address");
        configure_model(home, address);
        let (delta_tx, delta_sent) = mpsc::channel();
        let (closed_tx, connection_closed) = mpsc::channel();
        let thread = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept provider request");
            read_provider_request(&mut stream);
            let event = format!(
                "data: {{\"choices\":[{{\"index\":0,\"delta\":{{\"content\":\"{}\"}},\"finish_reason\":null}}]}}\n\n",
                "partial".repeat(80)
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{}\r\n",
                event.len(),
                event
            )
            .expect("write partial response");
            stream.flush().expect("flush partial response");
            delta_tx.send(()).expect("signal delta");
            let mut byte = [0u8; 1];
            let closed = matches!(stream.read(&mut byte), Ok(0) | Err(_));
            assert!(closed, "upstream connection remained open");
            closed_tx.send(()).expect("signal close");
        });
        Self {
            delta_sent,
            connection_closed,
            thread: Some(thread),
        }
    }

    fn wait_until_delta_sent(&self) {
        self.delta_sent
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("provider delta deadline");
    }

    fn wait_until_connection_closed(&self) {
        self.connection_closed
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("provider close deadline");
    }
}

impl Drop for BlockingMockProvider {
    fn drop(&mut self) {
        if let Some(thread) = self.thread.take() {
            thread.join().expect("join blocking provider");
        }
    }
}

fn read_provider_request(stream: &mut TcpStream) {
    let mut request = Vec::new();
    let mut buffer = [0u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut buffer).expect("read provider request");
        assert!(read > 0, "provider request ended before headers");
        request.extend_from_slice(&buffer[..read]);
        if let Some(position) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
    };
    let headers = String::from_utf8_lossy(&request[..header_end]);
    let content_length = headers
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length: ")
                .and_then(|value| value.parse::<usize>().ok())
        })
        .expect("content length");
    while request.len() - header_end < content_length {
        let read = stream
            .read(&mut buffer)
            .expect("read provider request body");
        assert!(read > 0, "provider request body ended early");
        request.extend_from_slice(&buffer[..read]);
    }
}

fn configure_model(home: &std::path::Path, address: std::net::SocketAddr) {
    let inspection = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["--home"])
        .arg(home)
        .args(["config", "model", "inspect", "--json"])
        .output()
        .expect("inspect model config");
    assert!(inspection.status.success());
    let revision =
        serde_json::from_slice::<Value>(&inspection.stdout).expect("model inspection")["revision"]
            .clone();
    let mut child = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["--home"])
        .arg(home)
        .args(["config", "model", "set", "--stdin", "--json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn model config command");
    writeln!(
        child.stdin.take().expect("config stdin"),
        "{}",
        json!({
            "contractVersion": 1,
            "expectedRevision": revision,
            "config": {
                "defaultProfileId": "model_fixture",
                "connections": [{
                    "id": "conn_fixture",
                    "providerFamily": "openai",
                    "displayName": "Fixture provider",
                    "baseUrl": format!("http://{address}/v1"),
                    "enabled": true,
                    "wireApi": "openaiChatCompletions"
                }],
                "profiles": [{
                    "id": "model_fixture",
                    "connectionId": "conn_fixture",
                    "displayName": "Fixture model",
                    "modelId": "fixture-model"
                }]
            },
            "credentialUpdates": [{
                "connectionId": "conn_fixture",
                "action": "preserve"
            }]
        })
    )
    .expect("write model config");
    let output = child.wait_with_output().expect("wait for model config");
    assert!(
        output.status.success(),
        "model config failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
}

fn send_json(stdin: &mut impl Write, value: Value) {
    writeln!(stdin, "{value}").expect("write JSON-RPC request");
    stdin.flush().expect("flush JSON-RPC request");
}

fn read_json(stdout: &mut impl BufRead) -> Value {
    let mut line = String::new();
    assert!(
        stdout.read_line(&mut line).expect("read JSON-RPC output") > 0,
        "app-server closed before response"
    );
    serde_json::from_str(&line).expect("JSON-RPC output")
}

fn read_golden_protocol_line(stdout: &mut impl BufRead, expected: &str) -> String {
    loop {
        let mut line = String::new();
        assert!(
            stdout.read_line(&mut line).expect("read protocol output") > 0,
            "app-server closed before the {expected}"
        );
        let value = serde_json::from_str::<Value>(&line).expect("protocol output JSON");
        if value.get("method").and_then(Value::as_str) != Some("turn/agentOutput/delta") {
            return line;
        }
    }
}

fn normalize_trace(output: &str) -> String {
    let mut normalized = String::new();
    for line in output.lines() {
        let mut value = serde_json::from_str::<Value>(line).expect("stdout line is JSON");
        if value.get("method").and_then(Value::as_str) == Some("turn/agentOutput/delta") {
            continue;
        }
        if value.get("method").and_then(Value::as_str) == Some("item/started")
            && let Some(params) = value.get_mut("params").and_then(Value::as_object_mut)
        {
            params.remove("agentOutput");
        }
        if let Some(platform) = value
            .get_mut("result")
            .and_then(|result| result.get_mut("platform"))
        {
            *platform = json!({
                "arch": "<arch>",
                "family": "<family>",
                "os": "<os>"
            });
        }
        if let Some(binding) = value
            .get_mut("result")
            .and_then(|result| result.get_mut("workspace"))
            .and_then(|workspace| workspace.get_mut("id"))
        {
            *binding = Value::String("<workspace-binding>".to_string());
        }
        scrub_workspace_bindings(&mut value);
        scrub_command_paths(&mut value);
        normalized.push_str(&serde_json::to_string(&value).expect("normalized JSON serializes"));
        normalized.push('\n');
    }
    normalized
}

fn scrub_workspace_bindings(value: &mut Value) {
    match value {
        Value::Array(values) => {
            for value in values {
                scrub_workspace_bindings(value);
            }
        }
        Value::Object(values) => {
            if let Some(workspace_id) = values.get_mut("workspaceId") {
                *workspace_id = Value::String("<workspace-binding>".to_string());
            }
            for value in values.values_mut() {
                scrub_workspace_bindings(value);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}

fn scrub_command_paths(value: &mut Value) {
    match value {
        Value::Array(values) => {
            for value in values {
                scrub_command_paths(value);
            }
        }
        Value::Object(object) => {
            if object.contains_key("command") {
                object.insert(
                    "command".to_string(),
                    Value::String("<command>".to_string()),
                );
            }
            if object.get("type").and_then(Value::as_str) == Some("process") {
                object.insert("durationMs".to_string(), json!(0));
            }
            for value in object.values_mut() {
                scrub_command_paths(value);
            }
        }
        _ => {}
    }
}
