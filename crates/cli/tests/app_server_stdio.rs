use serde_json::Value;
use serde_json::json;
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
fn initialization_happy_path_matches_golden_trace() {
    assert_golden("initialize-happy");
}

#[test]
fn initialization_failures_match_golden_trace() {
    assert_golden("initialize-errors");
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
    assert_golden_with_body(
        "turn-provider-error",
        include_str!("../../model-provider/tests/fixtures/terminal-error.sse"),
    );
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
    let _provider =
        MockProvider::start_with_bodies(sugarcode_home.path(), vec![TOOL_CALL, FINAL_ANSWER]);
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
    let _provider =
        MockProvider::start_with_bodies(sugarcode_home.path(), vec![TOOL_CALL, FINAL_ANSWER]);
    run_golden(
        "turn-workspace-list",
        &sugarcode_home,
        Some(workspace.path()),
    );
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
    let _provider =
        MockProvider::start_with_bodies(sugarcode_home.path(), vec![TOOL_CALL, FINAL_ANSWER]);
    run_golden(
        "turn-workspace-search",
        &sugarcode_home,
        Some(workspace.path()),
    );
}

#[test]
fn workspace_apply_patch_lifecycle_matches_golden_trace() {
    const TOOL_CALL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_patch_fixture\",\"type\":\"function\",\"function\":{\"name\":\"workspace/apply-patch\",\"arguments\":\"{\\\"path\\\":\\\"notes.txt\\\",\\\"patch\\\":\\\"@@ -1,3 +1,3 @@\\\\n one\\\\n-two\\\\n+second\\\\n three\\\\n\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
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
    let _provider =
        MockProvider::start_with_bodies(sugarcode_home.path(), vec![TOOL_CALL, FINAL_ANSWER]);
    run_golden_with_options(
        "turn-workspace-apply-patch",
        &sugarcode_home,
        Some(workspace.path()),
        true,
    );
    assert_eq!(
        fs::read_to_string(target).expect("read patched fixture"),
        "one\nsecond\nthree\n"
    );
}

#[test]
fn denied_shell_approval_matches_bidirectional_golden_trace() {
    let command = env!("CARGO_BIN_EXE_sugarcode");
    let arguments = serde_json::to_string(&json!({
        "command": command,
        "arguments": [],
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
fn real_cli_approval_executes_the_exact_bundled_argv() {
    let command = env!("CARGO_BIN_EXE_sugarcode");
    let arguments = serde_json::to_string(&json!({
        "command": command,
        "arguments": ["version"],
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
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Version checked.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    )
    .to_string();
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("isolated workspace");
    let _provider =
        MockProvider::start_with_owned_bodies(home.path(), vec![tool_call, final_answer]);
    let mut child = Command::new(command)
        .args(["app-server", "--stdio", "--workspace"])
        .arg(workspace.path())
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
                "clientInfo": {"name": "shell-real-test", "version": "1.0.0"},
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
            "params": {"threadId": thread_id, "input": "Check version"}
        }),
    );
    assert_eq!(read_json(&mut stdout)["id"], "turn");

    let mut process_result = None;
    loop {
        let message = read_json(&mut stdout);
        if message["method"] == "item/commandExecution/requestApproval" {
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
            && message["params"]["item"]["type"] == "toolResult"
        {
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
    assert!(
        process_result["stdout"]
            .as_str()
            .expect("stdout")
            .contains("sugarcode 1.0.0")
    );
    drop(stdin);
    let output = child.wait_with_output().expect("wait app-server");
    assert!(output.status.success(), "{output:?}");
    assert!(output.stderr.is_empty(), "{output:?}");
}

#[test]
fn missing_model_still_serves_threads_and_returns_stable_turn_error() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
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
                "clientInfo": {"name": "model-missing-test", "version": "1.0.0"}
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
    let turn = json!({
        "jsonrpc": "2.0",
        "id": "retry",
        "method": "turn/start",
        "params": {"threadId": thread_id, "input": "Hello"}
    });
    for _ in 0..2 {
        send_json(&mut stdin, turn.clone());
        let error = read_json(&mut stdout);
        assert_eq!(error["id"], "retry");
        assert_eq!(error["error"]["code"], -32007);
        assert!(error["error"].get("data").is_none());
    }
    drop(stdin);
    let output = child.wait_with_output().expect("wait for app-server");
    assert!(output.status.success(), "{output:?}");
    assert!(output.stderr.is_empty());
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
            "params": {"threadId": thread_id, "input": "Hello"}
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
        read_json(&mut stdout),
    ];
    assert_eq!(before_interrupt[0]["method"], "turn/started");
    assert_eq!(before_interrupt[1]["method"], "item/started");
    assert_eq!(before_interrupt[1]["params"]["item"]["type"], "userMessage");
    assert_eq!(before_interrupt[2]["method"], "item/completed");
    assert_eq!(before_interrupt[3]["method"], "item/started");
    assert_eq!(
        before_interrupt[3]["params"]["item"]["type"],
        "agentMessage"
    );
    assert_eq!(before_interrupt[4]["method"], "item/agentMessage/delta");
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
    assert_eq!(active_error["id"], "interrupt");
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
    let after_interrupt = [
        read_json(&mut stdout),
        read_json(&mut stdout),
        read_json(&mut stdout),
    ];
    assert_eq!(
        after_interrupt
            .iter()
            .filter(|message| message["id"] == "interrupt" && message["result"] == json!({}))
            .count(),
        1
    );
    assert_eq!(after_interrupt[0]["method"], "item/completed");
    assert_eq!(after_interrupt[1]["method"], "turn/completed");
    assert_eq!(after_interrupt[2]["id"], "interrupt");
    assert_eq!(
        after_interrupt
            .iter()
            .filter(|message| message["method"] == "item/completed")
            .count(),
        1
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
            "params": {"threadId": thread_id, "input": "Hello"}
        }),
    );
    assert_eq!(read_json(&mut stdout)["id"], "turn");
    for expected in [
        "turn/started",
        "item/started",
        "item/completed",
        "item/started",
        "item/agentMessage/delta",
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
    assert_eq!(trailing.len(), 2);
    assert_eq!(trailing[0]["method"], "item/completed");
    assert_eq!(trailing[1]["method"], "turn/completed");
    assert_eq!(trailing[1]["params"]["turn"]["status"], "interrupted");
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
    run_golden_with_options(name, sugarcode_home, workspace, false);
}

fn run_golden_with_options(
    name: &str,
    sugarcode_home: &tempfile::TempDir,
    workspace: Option<&std::path::Path>,
    allow_workspace_write: bool,
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
    let mut expected_index = 0usize;
    let mut actual = String::new();
    let input_lines = input.lines().collect::<Vec<_>>();
    for (input_index, input_line) in input_lines.iter().enumerate() {
        writeln!(stdin, "{input_line}").expect("write fixture input");
        stdin.flush().expect("flush fixture input");
        let expects_response = match serde_json::from_str::<Value>(input_line) {
            Err(_) => true,
            Ok(Value::Object(object)) => object.contains_key("method") && object.contains_key("id"),
            Ok(_) => true,
        };
        if !expects_response {
            if input_index + 1 == input_lines.len() {
                while expected_index < expected_values.len() {
                    let mut line = String::new();
                    assert!(
                        stdout.read_line(&mut line).expect("read terminal output") > 0,
                        "app-server closed before the golden terminal"
                    );
                    actual.push_str(&line);
                    expected_index += 1;
                }
            }
            continue;
        }
        loop {
            let mut line = String::new();
            assert!(
                stdout.read_line(&mut line).expect("read protocol output") > 0,
                "app-server closed before the golden response"
            );
            actual.push_str(&line);
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
    actual.push_str(&trailing);
    let output = child.wait_with_output().expect("wait for app-server");

    assert!(output.status.success(), "app-server failed: {output:?}");
    assert!(
        output.stderr.is_empty(),
        "protocol run wrote diagnostics to stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty(), "stdout was already captured");
    let actual = normalize_trace(&actual);
    let expected = normalize_trace(&expected);
    assert_eq!(actual, expected);
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
            let event = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n";
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
    let mut child = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["--home"])
        .arg(home)
        .args(["config", "model", "set", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn model config command");
    writeln!(
        child.stdin.take().expect("config stdin"),
        "{}",
        json!({
            "apiFormat": "openai-chat-completions",
            "endpoint": format!("http://{address}/v1/chat/completions"),
            "model": "fixture-model"
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

fn normalize_trace(output: &str) -> String {
    let mut normalized = String::new();
    for line in output.lines() {
        let mut value = serde_json::from_str::<Value>(line).expect("stdout line is JSON");
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
        scrub_command_paths(&mut value);
        normalized.push_str(&serde_json::to_string(&value).expect("normalized JSON serializes"));
        normalized.push('\n');
    }
    normalized
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
            for value in object.values_mut() {
                scrub_command_paths(value);
            }
        }
        _ => {}
    }
}
