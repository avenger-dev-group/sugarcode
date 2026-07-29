use serde_json::Value;
use serde_json::json;
use std::fs;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::net::TcpStream;
use std::path::Path;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::thread;
use tempfile::tempdir;

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.get(1).map(String::as_str) == Some("--fixture-server") {
        fixture_server(
            args.get(2).map(String::as_str).unwrap_or("ok"),
            args.get(3).map(String::as_str),
        );
        return;
    }

    selected_server_completes_real_cli_discovery();
    configured_server_is_inert_without_explicit_selection();
    selection_and_discovery_fail_before_rollout_open();
    streamable_http_selection_is_single_and_not_mixed();
    streamable_http_ignores_environment_proxy();
    approved_model_driven_call_completes_real_cli_round_trip();
    approved_streamable_http_call_completes_real_cli_round_trip();
    multiple_selected_servers_complete_one_cross_server_turn();
    selected_server_failure_never_falls_back_to_another_server();
}

fn streamable_http_ignores_environment_proxy() {
    let home = tempdir().expect("home");
    let fixture = HttpMcpFixture::start(4);
    fs::write(
        home.path().join("config.toml"),
        format!(
            "[[mcp.servers]]\n\
             id = \"http-fixture\"\n\
             transport = \"streamable-http\"\n\
             endpoint = \"http://{}/mcp\"\n",
            fixture.address
        ),
    )
    .expect("write HTTP MCP config");
    let output = sugarcode(home.path())
        .args(["app-server", "--stdio", "--mcp-server", "http-fixture"])
        .env("HTTP_PROXY", "http://127.0.0.1:9")
        .env("HTTPS_PROXY", "http://127.0.0.1:9")
        .env("ALL_PROXY", "http://127.0.0.1:9")
        .env("NO_PROXY", "")
        .output()
        .expect("run SugarCode");
    assert!(
        output.status.success(),
        "HTTP MCP must bypass environment proxies: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    fixture.finish();
}

fn streamable_http_selection_is_single_and_not_mixed() {
    let executable = std::env::current_exe().expect("test executable");
    let cwd = std::env::current_dir().expect("cwd");
    let inert_home = tempdir().expect("home");
    fs::write(
        inert_home.path().join("config.toml"),
        "[[mcp.servers]]\n\
         id = \"http-inert\"\n\
         transport = \"streamable-http\"\n\
         endpoint = \"http://127.0.0.1:9/mcp\"\n",
    )
    .expect("write inert HTTP config");
    let output = sugarcode(inert_home.path())
        .args(["app-server", "--stdio"])
        .output()
        .expect("run SugarCode");
    assert!(
        output.status.success(),
        "unselected HTTP config must remain inert: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    for config in [
        format!(
            "[[mcp.servers]]\n\
             id = \"stdio-fixture\"\n\
             transport = \"stdio\"\n\
             executable = {}\n\
             argv = [\"--fixture-server\", \"ok\"]\n\
             cwd = {}\n\
             [[mcp.servers]]\n\
             id = \"http-fixture\"\n\
             transport = \"streamable-http\"\n\
             endpoint = \"http://127.0.0.1:9/mcp\"\n",
            toml::Value::String(executable.to_string_lossy().into_owned()),
            toml::Value::String(cwd.to_string_lossy().into_owned()),
        ),
        "[[mcp.servers]]\n\
         id = \"http-one\"\n\
         transport = \"streamable-http\"\n\
         endpoint = \"http://127.0.0.1:9/mcp\"\n\
         [[mcp.servers]]\n\
         id = \"http-two\"\n\
         transport = \"streamable-http\"\n\
         endpoint = \"http://127.0.0.1:10/mcp\"\n"
            .to_owned(),
    ] {
        let home = tempdir().expect("home");
        fs::write(home.path().join("config.toml"), config).expect("write config");
        let ids = if fs::read_to_string(home.path().join("config.toml"))
            .expect("config")
            .contains("stdio-fixture")
        {
            ["stdio-fixture", "http-fixture"]
        } else {
            ["http-one", "http-two"]
        };
        let output = sugarcode(home.path())
            .args([
                "app-server",
                "--stdio",
                "--mcp-server",
                ids[0],
                "--mcp-server",
                ids[1],
            ])
            .output()
            .expect("run SugarCode");
        assert!(!output.status.success());
        assert_eq!(
            fs::read_dir(home.path())
                .expect("read home")
                .map(|entry| entry.expect("entry").file_name())
                .collect::<Vec<_>>(),
            vec![std::ffi::OsString::from("config.toml")],
            "invalid HTTP selection must fail before rollout open"
        );
    }
}

fn approved_streamable_http_call_completes_real_cli_round_trip() {
    const TOOL_CALL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_http_fixture_1\",\"type\":\"function\",\"function\":{\"name\":\"mcp__http-fixture__inspect\",\"arguments\":\"{\\\"value\\\":7}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    const FINAL_ANSWER: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"HTTP MCP completed.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );

    let home = tempdir().expect("home");
    let fixture = HttpMcpFixture::start(9);
    fs::write(
        home.path().join("config.toml"),
        format!(
            "schema_version = 1\n\
             [[mcp.servers]]\n\
             id = \"http-fixture\"\n\
             transport = \"streamable-http\"\n\
             endpoint = \"http://{}/mcp\"\n",
            fixture.address
        ),
    )
    .expect("write HTTP MCP config");
    let provider = CallProvider::start(home.path(), [TOOL_CALL, FINAL_ANSWER]);
    let mut child = sugarcode(home.path())
        .args(["app-server", "--stdio", "--mcp-server", "http-fixture"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn SugarCode");
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
                "clientInfo": {"name": "fixture-client", "version": "1.0.0"},
                "capabilities": {"mcpToolCallApprovals": true}
            }
        }),
    );
    assert_eq!(
        read_json(&mut stdout)["result"]["capabilities"]["mcpToolCallApprovals"],
        true
    );
    send_json(
        &mut stdin,
        json!({"jsonrpc": "2.0", "method": "initialized"}),
    );
    send_json(
        &mut stdin,
        json!({"jsonrpc": "2.0", "id": "thread", "method": "thread/start", "params": {}}),
    );
    let thread = read_json(&mut stdout);
    let thread_id = thread["result"]["thread"]["id"]
        .as_str()
        .expect("thread id")
        .to_owned();
    assert_eq!(read_json(&mut stdout)["method"], "thread/started");
    send_json(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": "turn",
            "method": "turn/start",
            "params": {"threadId": thread_id, "input": "Use loopback HTTP MCP."}
        }),
    );

    let mut approved = false;
    let mut attempted = false;
    let mut resulted = false;
    loop {
        let message = read_json(&mut stdout);
        assert!(message.get("error").is_none(), "protocol error: {message}");
        if message["method"] == "item/mcpToolCall/requestApproval" {
            assert!(!approved);
            assert_eq!(
                fixture.requests.lock().expect("requests").len(),
                4,
                "only eager discovery may reach the endpoint before approval"
            );
            let approval_id = message["id"].as_str().expect("approval id").to_owned();
            send_json(
                &mut stdin,
                json!({
                    "jsonrpc": "2.0",
                    "id": approval_id,
                    "result": {"decision": "approved"}
                }),
            );
            approved = true;
        }
        if message["method"] == "item/completed"
            && message["params"]["item"]["type"] == "mcpToolExecutionAttempt"
        {
            assert!(approved);
            attempted = true;
        }
        if message["method"] == "item/completed"
            && message["params"]["item"]["type"] == "mcpToolResult"
        {
            assert!(attempted);
            resulted = true;
        }
        if message["method"] == "turn/completed" {
            break;
        }
        if matches!(
            message["method"].as_str(),
            Some("turn/failed" | "turn/interrupted" | "server/runtimeFailed")
        ) {
            panic!("unexpected terminal message: {message}");
        }
    }
    assert!(approved && attempted && resulted);
    drop(stdin);
    let output = child.wait_with_output().expect("wait for SugarCode");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty(), "{output:?}");

    let provider_requests = provider.finish();
    assert_eq!(provider_requests.len(), 2);
    assert_eq!(
        provider_requests[0]["tools"][0]["function"]["name"],
        "mcp__http-fixture__inspect"
    );
    assert!(
        provider_requests[1]["messages"]
            .as_array()
            .expect("messages")
            .iter()
            .any(|message| {
                message["role"] == "tool"
                    && message["tool_call_id"] == "call_http_fixture_1"
                    && message["content"]
                        .as_str()
                        .is_some_and(|content| content.contains("\"text\":[\"called\"]"))
            }),
        "the next provider round must retain the exact call/result association"
    );
    fixture.finish();
}

fn selected_server_completes_real_cli_discovery() {
    let home = tempdir().expect("home");
    write_config(
        home.path(),
        "ok",
        std::env::current_exe().expect("test executable"),
    );
    let output = sugarcode(home.path())
        .args(["app-server", "--stdio", "--mcp-server", "fixture"])
        .output()
        .expect("run SugarCode");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn configured_server_is_inert_without_explicit_selection() {
    let home = tempdir().expect("home");
    write_config(
        home.path(),
        "ok",
        home.path().join("does-not-exist-mcp-server"),
    );
    let output = sugarcode(home.path())
        .args(["app-server", "--stdio"])
        .output()
        .expect("run SugarCode");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn selection_and_discovery_fail_before_rollout_open() {
    for (selected, mode) in [("missing", "ok"), ("fixture", "bad-version")] {
        let home = tempdir().expect("home");
        write_config(
            home.path(),
            mode,
            std::env::current_exe().expect("test executable"),
        );
        let output = sugarcode(home.path())
            .args(["app-server", "--stdio", "--mcp-server", selected])
            .output()
            .expect("run SugarCode");
        assert!(!output.status.success());
        let entries = fs::read_dir(home.path())
            .expect("read home")
            .map(|entry| entry.expect("entry").file_name())
            .collect::<Vec<_>>();
        assert_eq!(entries, vec![std::ffi::OsString::from("config.toml")]);
    }

    let home = tempdir().expect("home");
    write_multiple_config(
        home.path(),
        [("alpha", "ok", None), ("beta", "bad-version", None)],
    );
    let output = sugarcode(home.path())
        .args([
            "app-server",
            "--stdio",
            "--mcp-server",
            "alpha",
            "--mcp-server",
            "beta",
        ])
        .output()
        .expect("run SugarCode");
    assert!(!output.status.success());
    assert_eq!(
        fs::read_dir(home.path())
            .expect("read home")
            .map(|entry| entry.expect("entry").file_name())
            .collect::<Vec<_>>(),
        vec![std::ffi::OsString::from("config.toml")],
        "one failed selected server must fail the complete frozen set before rollout open"
    );

    let home = tempdir().expect("home");
    write_config(
        home.path(),
        "ok",
        std::env::current_exe().expect("test executable"),
    );
    let output = sugarcode(home.path())
        .args([
            "app-server",
            "--stdio",
            "--mcp-server",
            "fixture",
            "--mcp-server",
            "fixture",
        ])
        .output()
        .expect("run SugarCode");
    assert!(!output.status.success());
    assert_eq!(
        fs::read_dir(home.path())
            .expect("read home")
            .map(|entry| entry.expect("entry").file_name())
            .collect::<Vec<_>>(),
        vec![std::ffi::OsString::from("config.toml")],
        "duplicate selection must fail before rollout open"
    );
}

fn approved_model_driven_call_completes_real_cli_round_trip() {
    const FIRST_TOOL_CALL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_mcp_fixture_1\",\"type\":\"function\",\"function\":{\"name\":\"mcp__fixture__inspect\",\"arguments\":\"{\\\"value\\\":[\\\"arbitrary\\\",2]}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    const SECOND_TOOL_CALL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_mcp_fixture_2\",\"type\":\"function\",\"function\":{\"name\":\"mcp__fixture__inspect\",\"arguments\":\"{\\\"value\\\":[\\\"arbitrary\\\",2]}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    const FINAL_ANSWER: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"MCP completed.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );

    let home = tempdir().expect("home");
    let marker_directory = tempdir().expect("marker directory");
    let marker = marker_directory.path().join("called");
    write_config_with_marker(
        home.path(),
        "call",
        std::env::current_exe().expect("test executable"),
        Some(&marker),
    );
    let provider = CallProvider::start(
        home.path(),
        [FIRST_TOOL_CALL, SECOND_TOOL_CALL, FINAL_ANSWER],
    );
    let mut child = sugarcode(home.path())
        .args(["app-server", "--stdio", "--mcp-server", "fixture"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn SugarCode");
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
                "clientInfo": {"name": "fixture-client", "version": "1.0.0"},
                "capabilities": {"mcpToolCallApprovals": true}
            }
        }),
    );
    let initialize = read_json(&mut stdout);
    assert_eq!(
        initialize["result"]["capabilities"]["mcpToolCallApprovals"],
        true
    );
    send_json(
        &mut stdin,
        json!({"jsonrpc": "2.0", "method": "initialized"}),
    );
    send_json(
        &mut stdin,
        json!({"jsonrpc": "2.0", "id": "thread", "method": "thread/start", "params": {}}),
    );
    let thread_response = read_json(&mut stdout);
    let thread_id = thread_response["result"]["thread"]["id"]
        .as_str()
        .expect("thread id")
        .to_owned();
    assert_eq!(
        read_json(&mut stdout)["method"],
        "thread/started",
        "thread notification"
    );
    send_json(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": "turn",
            "method": "turn/start",
            "params": {"threadId": thread_id, "input": "Use MCP."}
        }),
    );

    let mut approval_count = 0usize;
    let mut attempt_count = 0usize;
    let mut result_count = 0usize;
    let mut completed_types = Vec::new();
    loop {
        let message = read_json(&mut stdout);
        assert!(message.get("error").is_none(), "protocol error: {message}");
        if message["method"] == "item/completed"
            && message["params"]["item"]["type"] == "mcpToolExecutionAttempt"
        {
            attempt_count += 1;
        }
        if message["method"] == "item/completed"
            && message["params"]["item"]["type"] == "mcpToolResult"
        {
            result_count += 1;
        }
        if message["method"] == "item/completed" {
            completed_types.push(
                message["params"]["item"]["type"]
                    .as_str()
                    .expect("item type")
                    .to_owned(),
            );
        }
        if message["method"] == "item/mcpToolCall/requestApproval" {
            assert_eq!(
                attempt_count, approval_count,
                "attempt must follow its matching approval"
            );
            assert_eq!(
                result_count, approval_count,
                "next approval must follow the prior durable result"
            );
            assert_eq!(
                message["params"]["arguments"],
                json!({"value": ["arbitrary", 2]})
            );
            let prior_calls = fs::read_to_string(&marker)
                .ok()
                .map_or(0, |content| content.lines().count());
            assert_eq!(
                prior_calls, approval_count,
                "a fresh server must not be called before approval"
            );
            let approval_id = message["id"].as_str().expect("approval id").to_owned();
            send_json(
                &mut stdin,
                json!({
                    "jsonrpc": "2.0",
                    "id": approval_id,
                    "result": {"decision": "approved"}
                }),
            );
            approval_count += 1;
        }
        if message["method"] == "turn/completed" {
            break;
        }
        if matches!(
            message["method"].as_str(),
            Some("turn/failed" | "turn/interrupted" | "server/runtimeFailed")
        ) {
            panic!("unexpected terminal message: {message}");
        }
    }
    assert_eq!(approval_count, 2);
    assert_eq!(attempt_count, 2);
    assert_eq!(result_count, 2);
    assert_eq!(
        fs::read_to_string(&marker)
            .expect("real MCP tools/call marker")
            .lines()
            .count(),
        2,
        "each call must use a fresh MCP process"
    );
    assert!(
        completed_types
            .iter()
            .any(|kind| kind == "mcpToolExecutionAttempt")
    );
    assert!(completed_types.iter().any(|kind| kind == "mcpToolResult"));

    drop(stdin);
    let output = child.wait_with_output().expect("wait for SugarCode");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty(), "{output:?}");

    let requests = provider.finish();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[0]["tools"].as_array().map(Vec::len), Some(1));
    assert_eq!(
        requests[0]["tools"][0]["function"]["name"],
        "mcp__fixture__inspect"
    );
    assert_eq!(requests[1]["tools"].as_array().map(Vec::len), Some(1));
    assert_eq!(requests[2]["tools"].as_array().map(Vec::len), Some(1));
    for (request_index, expected_results) in [(1, 1), (2, 2)] {
        let messages = requests[request_index]["messages"]
            .as_array()
            .expect("provider messages");
        assert_eq!(
            messages
                .iter()
                .filter(|message| {
                    message["role"] == "tool"
                        && message["content"]
                            .as_str()
                            .is_some_and(|content| content.contains("\"text\":[\"called\"]"))
                })
                .count(),
            expected_results,
            "each provider round must contain every prior correlated MCP result"
        );
    }
}

fn multiple_selected_servers_complete_one_cross_server_turn() {
    const ALPHA_CALL_1: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_alpha_1\",\"type\":\"function\",\"function\":{\"name\":\"mcp__alpha__inspect\",\"arguments\":\"{\\\"value\\\":\\\"alpha-one\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    const BETA_CALL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_beta_1\",\"type\":\"function\",\"function\":{\"name\":\"mcp__beta__inspect\",\"arguments\":\"{\\\"value\\\":\\\"beta\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    const ALPHA_CALL_2: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_alpha_2\",\"type\":\"function\",\"function\":{\"name\":\"mcp__alpha__inspect\",\"arguments\":\"{\\\"value\\\":\\\"alpha-two\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    const FINAL_ANSWER: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Both MCP servers completed.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );

    let home = tempdir().expect("home");
    let marker_directory = tempdir().expect("marker directory");
    let alpha_marker = marker_directory.path().join("alpha-called");
    let beta_marker = marker_directory.path().join("beta-called");
    write_multiple_config(
        home.path(),
        [
            ("beta", "call", Some(beta_marker.as_path())),
            ("alpha", "call", Some(alpha_marker.as_path())),
        ],
    );
    let provider = CallProvider::start(
        home.path(),
        [ALPHA_CALL_1, BETA_CALL, ALPHA_CALL_2, FINAL_ANSWER],
    );
    let mut child = sugarcode(home.path())
        .args([
            "app-server",
            "--stdio",
            "--mcp-server",
            "beta",
            "--mcp-server",
            "alpha",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn SugarCode");
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
                "clientInfo": {"name": "fixture-client", "version": "1.0.0"},
                "capabilities": {"mcpToolCallApprovals": true}
            }
        }),
    );
    assert_eq!(
        read_json(&mut stdout)["result"]["capabilities"]["mcpToolCallApprovals"],
        true
    );
    send_json(
        &mut stdin,
        json!({"jsonrpc": "2.0", "method": "initialized"}),
    );
    send_json(
        &mut stdin,
        json!({"jsonrpc": "2.0", "id": "thread", "method": "thread/start", "params": {}}),
    );
    let thread = read_json(&mut stdout);
    let thread_id = thread["result"]["thread"]["id"]
        .as_str()
        .expect("thread id")
        .to_owned();
    assert_eq!(read_json(&mut stdout)["method"], "thread/started");
    send_json(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": "turn",
            "method": "turn/start",
            "params": {"threadId": thread_id, "input": "Use both MCP servers in order."}
        }),
    );

    let mut approval_names = Vec::new();
    let mut inventory_hashes = Vec::new();
    let mut durable_results = 0usize;
    loop {
        let message = read_json(&mut stdout);
        assert!(message.get("error").is_none(), "protocol error: {message}");
        if message["method"] == "item/completed"
            && message["params"]["item"]["type"] == "mcpToolResult"
        {
            durable_results += 1;
        }
        if message["method"] == "item/mcpToolCall/requestApproval" {
            assert_eq!(
                durable_results,
                approval_names.len(),
                "each cross-server proposal must follow the prior durable result"
            );
            approval_names.push(
                message["params"]["name"]
                    .as_str()
                    .expect("callable name")
                    .to_owned(),
            );
            inventory_hashes.push(
                message["params"]["inventorySha256"]
                    .as_str()
                    .expect("inventory hash")
                    .to_owned(),
            );
            let approval_id = message["id"].as_str().expect("approval id");
            send_json(
                &mut stdin,
                json!({
                    "jsonrpc": "2.0",
                    "id": approval_id,
                    "result": {"decision": "approved"}
                }),
            );
        }
        if message["method"] == "turn/completed" {
            break;
        }
        if matches!(
            message["method"].as_str(),
            Some("turn/failed" | "turn/interrupted" | "server/runtimeFailed")
        ) {
            panic!("unexpected terminal message: {message}");
        }
    }
    assert_eq!(
        approval_names,
        [
            "mcp__alpha__inspect",
            "mcp__beta__inspect",
            "mcp__alpha__inspect"
        ]
    );
    assert_eq!(durable_results, 3);
    assert_eq!(inventory_hashes[0], inventory_hashes[2]);
    assert_ne!(inventory_hashes[0], inventory_hashes[1]);
    assert_eq!(
        fs::read_to_string(&alpha_marker)
            .expect("alpha calls")
            .lines()
            .count(),
        2
    );
    assert_eq!(
        fs::read_to_string(&beta_marker)
            .expect("beta calls")
            .lines()
            .count(),
        1
    );

    drop(stdin);
    let output = child.wait_with_output().expect("wait for SugarCode");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty(), "{output:?}");

    let requests = provider.finish();
    assert_eq!(requests.len(), 4);
    for request in &requests {
        let names = request["tools"]
            .as_array()
            .expect("stable MCP definitions")
            .iter()
            .map(|tool| tool["function"]["name"].as_str().expect("tool name"))
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            ["mcp__alpha__inspect", "mcp__beta__inspect"],
            "built-in-free MCP definitions must sort by raw ASCII server ID"
        );
    }
    for (request_index, expected_results) in [(1, 1), (2, 2), (3, 3)] {
        let messages = requests[request_index]["messages"]
            .as_array()
            .expect("provider messages");
        assert_eq!(
            messages
                .iter()
                .filter(|message| message["role"] == "tool")
                .count(),
            expected_results,
            "every round must retain exact prior call/result correlation"
        );
    }
}

fn selected_server_failure_never_falls_back_to_another_server() {
    const BETA_CALL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_beta_failure\",\"type\":\"function\",\"function\":{\"name\":\"mcp__beta__inspect\",\"arguments\":\"{\\\"value\\\":\\\"beta\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    const FINAL_ANSWER: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"MCP failure observed.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );

    for (mode, expected_kind) in [
        ("drift", "inventoryDrift"),
        ("crash", "abnormalExit"),
        ("timeout", "timeout"),
    ] {
        let home = tempdir().expect("home");
        let marker_directory = tempdir().expect("marker directory");
        let alpha_marker = marker_directory.path().join("alpha-called");
        let beta_marker = marker_directory.path().join("beta-state");
        write_multiple_config(
            home.path(),
            [
                ("alpha", "call", Some(alpha_marker.as_path())),
                ("beta", mode, Some(beta_marker.as_path())),
            ],
        );
        let provider = CallProvider::start(home.path(), [BETA_CALL, FINAL_ANSWER]);
        let mut child = sugarcode(home.path())
            .args([
                "app-server",
                "--stdio",
                "--mcp-server",
                "alpha",
                "--mcp-server",
                "beta",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn SugarCode");
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
                    "clientInfo": {"name": "fixture-client", "version": "1.0.0"},
                    "capabilities": {"mcpToolCallApprovals": true}
                }
            }),
        );
        assert_eq!(
            read_json(&mut stdout)["result"]["capabilities"]["mcpToolCallApprovals"],
            true
        );
        send_json(
            &mut stdin,
            json!({"jsonrpc": "2.0", "method": "initialized"}),
        );
        send_json(
            &mut stdin,
            json!({"jsonrpc": "2.0", "id": "thread", "method": "thread/start", "params": {}}),
        );
        let thread = read_json(&mut stdout);
        let thread_id = thread["result"]["thread"]["id"]
            .as_str()
            .expect("thread id")
            .to_owned();
        assert_eq!(read_json(&mut stdout)["method"], "thread/started");
        send_json(
            &mut stdin,
            json!({
                "jsonrpc": "2.0",
                "id": "turn",
                "method": "turn/start",
                "params": {"threadId": thread_id, "input": "Call beta only."}
            }),
        );

        let mut result_kind = None;
        loop {
            let message = read_json(&mut stdout);
            if message["method"] == "item/mcpToolCall/requestApproval" {
                let approval_id = message["id"].as_str().expect("approval id");
                send_json(
                    &mut stdin,
                    json!({
                        "jsonrpc": "2.0",
                        "id": approval_id,
                        "result": {"decision": "approved"}
                    }),
                );
            }
            if message["method"] == "item/completed"
                && message["params"]["item"]["type"] == "mcpToolResult"
            {
                result_kind = message["params"]["item"]["result"]["kind"]
                    .as_str()
                    .map(str::to_owned);
            }
            if message["method"] == "turn/completed" {
                break;
            }
            if matches!(
                message["method"].as_str(),
                Some("turn/failed" | "turn/interrupted" | "server/runtimeFailed")
            ) {
                panic!("unexpected terminal message: {message}");
            }
        }
        if mode == "crash" {
            assert!(
                matches!(
                    result_kind.as_deref(),
                    Some("abnormalExit" | "unexpectedEof")
                ),
                "crash must remain a stable fail-closed transport result: {result_kind:?}"
            );
        } else {
            assert_eq!(result_kind.as_deref(), Some(expected_kind));
        }
        assert!(
            !alpha_marker.exists(),
            "a bound beta failure must never invoke the available alpha server"
        );

        drop(stdin);
        let output = child.wait_with_output().expect("wait for SugarCode");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let requests = provider.finish();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0]["tools"].as_array().map(Vec::len), Some(2));
        assert!(
            requests[1]["tools"]
                .as_array()
                .is_none_or(|tools| tools.is_empty()),
            "transport and drift failures must close the sequence without server fallback"
        );
    }
}

fn sugarcode(home: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_sugarcode"));
    command.arg("--home").arg(home);
    command
}

fn write_config(home: &Path, mode: &str, executable: impl AsRef<Path>) {
    write_config_with_marker(home, mode, executable, None);
}

fn write_config_with_marker(
    home: &Path,
    mode: &str,
    executable: impl AsRef<Path>,
    marker: Option<&Path>,
) {
    let cwd = std::env::current_dir().expect("cwd");
    let mut argv = vec![
        toml::Value::String("--fixture-server".to_owned()),
        toml::Value::String(mode.to_owned()),
    ];
    if let Some(marker) = marker {
        argv.push(toml::Value::String(marker.to_string_lossy().into_owned()));
    }
    fs::write(
        home.join("config.toml"),
        format!(
            "schema_version = 1\n\
             [[mcp.servers]]\n\
             id = \"fixture\"\n\
             transport = \"stdio\"\n\
             executable = {}\n\
             argv = {}\n\
             cwd = {}\n",
            toml::Value::String(executable.as_ref().to_string_lossy().into_owned()),
            toml::Value::Array(argv),
            toml::Value::String(cwd.to_string_lossy().into_owned()),
        ),
    )
    .expect("write config");
}

fn write_multiple_config<const N: usize>(home: &Path, servers: [(&str, &str, Option<&Path>); N]) {
    let executable = std::env::current_exe().expect("test executable");
    let cwd = std::env::current_dir().expect("cwd");
    let mut config = "schema_version = 1\n".to_string();
    for (id, mode, marker) in servers {
        let mut argv = vec![
            toml::Value::String("--fixture-server".to_owned()),
            toml::Value::String(mode.to_owned()),
        ];
        if let Some(marker) = marker {
            argv.push(toml::Value::String(marker.to_string_lossy().into_owned()));
        }
        config.push_str(&format!(
            "[[mcp.servers]]\n\
             id = {}\n\
             transport = \"stdio\"\n\
             executable = {}\n\
             argv = {}\n\
             cwd = {}\n",
            toml::Value::String(id.to_owned()),
            toml::Value::String(executable.to_string_lossy().into_owned()),
            toml::Value::Array(argv),
            toml::Value::String(cwd.to_string_lossy().into_owned()),
        ));
    }
    fs::write(home.join("config.toml"), config).expect("write config");
}

fn fixture_server(mode: &str, marker: Option<&str>) {
    assert!(std::env::var_os("PATH").is_none());
    let drifted = mode == "drift" && marker.is_some_and(|path| Path::new(path).exists());
    if mode == "drift" {
        let mut state = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(marker.expect("drift state marker"))
            .expect("open drift state marker");
        writeln!(state, "start").expect("write drift state marker");
    }
    let mut input = std::io::BufReader::new(std::io::stdin().lock());
    let mut output = std::io::stdout().lock();
    let initialize = read_message(&mut input);
    assert_eq!(initialize["method"], "initialize");
    let version = if mode == "bad-version" {
        "2024-11-05"
    } else {
        sugarcode_mcp::MCP_PROTOCOL_VERSION
    };
    write_message(
        &mut output,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "protocolVersion": version,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "cli-fixture", "version": "1.0.0"}
            }
        }),
    );
    if mode == "bad-version" {
        wait_for_eof(&mut input);
        return;
    }
    assert_eq!(
        read_message(&mut input)["method"],
        "notifications/initialized"
    );
    assert_eq!(read_message(&mut input)["method"], "tools/list");
    write_message(
        &mut output,
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "result": {
                "tools": [{
                    "name": if drifted { "changed" } else { "inspect" },
                    "description": "discovery only",
                    "inputSchema": {"type": "object"}
                }]
            }
        }),
    );
    if matches!(mode, "call" | "crash" | "timeout") {
        let Some(call) = read_optional_message(&mut input) else {
            return;
        };
        assert_eq!(call["id"], 3);
        assert_eq!(call["method"], "tools/call");
        assert_eq!(call["params"]["name"], "inspect");
        assert!(
            call["params"]["arguments"]["value"].is_array()
                || call["params"]["arguments"]["value"].is_string()
        );
        let mut marker = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(marker.expect("call marker"))
            .expect("open call marker");
        writeln!(marker, "called").expect("write call marker");
        if mode == "crash" {
            std::process::exit(7);
        }
        if mode == "timeout" {
            wait_for_eof(&mut input);
            return;
        }
        write_message(
            &mut output,
            &json!({
                "jsonrpc": "2.0",
                "id": 3,
                "result": {
                    "content": [{"type": "text", "text": "called"}],
                    "structuredContent": {"ok": true},
                    "isError": false
                }
            }),
        );
    }
    wait_for_eof(&mut input);
}

struct HttpMcpFixture {
    address: std::net::SocketAddr,
    expected_requests: usize,
    requests: Arc<Mutex<Vec<HttpMcpRequest>>>,
    thread: thread::JoinHandle<()>,
}

impl HttpMcpFixture {
    fn start(expected_requests: usize) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind HTTP MCP");
        let address = listener.local_addr().expect("HTTP MCP address");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        let thread = thread::spawn(move || {
            for index in 0..expected_requests {
                let (mut stream, _) = listener.accept().expect("accept HTTP MCP");
                let request = read_http_mcp_request(&mut stream);
                validate_http_mcp_request(index, &request);
                recorded.lock().expect("requests").push(request);
                let response = http_mcp_response(index);
                stream.write_all(&response).expect("HTTP MCP response");
                stream.flush().expect("HTTP MCP flush");
            }
        });
        Self {
            address,
            expected_requests,
            requests,
            thread,
        }
    }

    fn finish(self) {
        self.thread.join().expect("HTTP MCP thread");
        assert_eq!(
            self.requests.lock().expect("requests").len(),
            self.expected_requests
        );
    }
}

#[derive(Debug)]
struct HttpMcpRequest {
    http_method: String,
    rpc_method: Option<String>,
    session_id: Option<String>,
    protocol_version: Option<String>,
}

fn validate_http_mcp_request(index: usize, request: &HttpMcpRequest) {
    let expected_rpc = match index {
        0 | 4 => Some("initialize"),
        1 | 5 => Some("notifications/initialized"),
        2 | 6 => Some("tools/list"),
        7 => Some("tools/call"),
        3 | 8 => None,
        _ => unreachable!(),
    };
    assert_eq!(
        request.rpc_method.as_deref(),
        expected_rpc,
        "request {index}"
    );
    assert_eq!(
        request.http_method,
        if matches!(index, 3 | 8) {
            "DELETE"
        } else {
            "POST"
        }
    );
    if matches!(index, 0 | 4) {
        assert!(request.session_id.is_none());
        assert!(request.protocol_version.is_none());
    } else {
        assert_eq!(
            request.session_id.as_deref(),
            Some(if index < 4 { "session-1" } else { "session-2" })
        );
        assert_eq!(
            request.protocol_version.as_deref(),
            Some(sugarcode_mcp::MCP_PROTOCOL_VERSION)
        );
    }
}

fn http_mcp_response(index: usize) -> Vec<u8> {
    let initialize = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
            "protocolVersion": sugarcode_mcp::MCP_PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "cli-http-fixture", "version": "1.0.0"}
        }
    });
    let list = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "result": {
            "tools": [{
                "name": "inspect",
                "description": "HTTP inspect",
                "inputSchema": {
                    "type": "object",
                    "properties": {"value": {"type": "integer"}},
                    "required": ["value"],
                    "additionalProperties": false
                }
            }]
        }
    });
    let call = json!({
        "jsonrpc": "2.0",
        "id": 3,
        "result": {
            "content": [{"type": "text", "text": "called"}],
            "structuredContent": {"ok": true},
            "isError": false
        }
    });
    match index {
        0 => http_response(
            "200 OK",
            &[
                ("Content-Type", "application/json"),
                ("Mcp-Session-Id", "session-1"),
            ],
            initialize.to_string().as_bytes(),
        ),
        1 | 5 => http_response("202 Accepted", &[], b""),
        2 => http_sse_response(&list, &[]),
        3 | 8 => http_response("200 OK", &[], b""),
        4 => http_sse_response(&initialize, &[("Mcp-Session-Id", "session-2")]),
        6 => http_response(
            "200 OK",
            &[("Content-Type", "application/json")],
            list.to_string().as_bytes(),
        ),
        7 => http_sse_response(&call, &[]),
        _ => unreachable!(),
    }
}

fn http_sse_response(value: &Value, extra_headers: &[(&str, &str)]) -> Vec<u8> {
    let body = format!("event: message\ndata: {value}\n\n");
    let mut headers = vec![("Content-Type", "text/event-stream")];
    headers.extend_from_slice(extra_headers);
    http_response("200 OK", &headers, body.as_bytes())
}

fn http_response(status: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    )
    .into_bytes();
    for (name, value) in headers {
        response.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());
    }
    response.extend_from_slice(b"\r\n");
    response.extend_from_slice(body);
    response
}

fn read_http_mcp_request(stream: &mut TcpStream) -> HttpMcpRequest {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut buffer).expect("HTTP MCP request");
        assert_ne!(read, 0, "HTTP MCP headers");
        request.extend_from_slice(&buffer[..read]);
        if let Some(position) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
            break position + 4;
        }
    };
    let headers = std::str::from_utf8(&request[..header_end]).expect("HTTP MCP headers");
    let mut lines = headers.split("\r\n");
    let http_method = lines
        .next()
        .expect("request line")
        .split_whitespace()
        .next()
        .expect("HTTP method")
        .to_owned();
    let mut content_length = 0_usize;
    let mut session_id = None;
    let mut protocol_version = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        match name.to_ascii_lowercase().as_str() {
            "content-length" => content_length = value.trim().parse().expect("content length"),
            "mcp-session-id" => session_id = Some(value.trim().to_owned()),
            "mcp-protocol-version" => protocol_version = Some(value.trim().to_owned()),
            _ => {}
        }
    }
    while request.len() - header_end < content_length {
        let read = stream.read(&mut buffer).expect("HTTP MCP body");
        assert_ne!(read, 0, "HTTP MCP body EOF");
        request.extend_from_slice(&buffer[..read]);
    }
    let body = &request[header_end..header_end + content_length];
    let rpc_method = if body.is_empty() {
        None
    } else {
        serde_json::from_slice::<Value>(body)
            .expect("HTTP MCP JSON")
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    HttpMcpRequest {
        http_method,
        rpc_method,
        session_id,
        protocol_version,
    }
}

struct CallProvider {
    requests: mpsc::Receiver<Value>,
    thread: thread::JoinHandle<()>,
}

impl CallProvider {
    fn start<const N: usize>(home: &Path, bodies: [&'static str; N]) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind provider");
        configure_model(home, listener.local_addr().expect("provider address"));
        let (sender, requests) = mpsc::channel();
        let thread = thread::spawn(move || {
            for body in bodies {
                let (mut stream, _) = listener.accept().expect("accept provider");
                sender
                    .send(read_provider_request(&mut stream))
                    .expect("record request");
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .expect("provider response");
                stream.flush().expect("provider flush");
            }
        });
        Self { requests, thread }
    }

    fn finish(self) -> Vec<Value> {
        self.thread.join().expect("provider thread");
        self.requests.try_iter().collect()
    }
}

fn configure_model(home: &Path, address: std::net::SocketAddr) {
    let inspection = sugarcode(home)
        .args(["config", "model", "inspect", "--json"])
        .output()
        .expect("inspect model config");
    assert!(inspection.status.success());
    let revision =
        serde_json::from_slice::<Value>(&inspection.stdout).expect("model inspection")["revision"]
            .clone();
    let mut child = sugarcode(home)
        .args(["config", "model", "set", "--stdin", "--json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn model config");
    send_json(
        &mut child.stdin.take().expect("config stdin"),
        json!({
            "contractVersion": 1,
            "expectedRevision": revision,
            "config": {
                "apiFormat": "openai-chat-completions",
                "endpoint": format!("http://{address}/v1/chat/completions"),
                "model": "fixture-model",
                "credentialReference": null
            }
        }),
    );
    let output = child.wait_with_output().expect("model config");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn read_provider_request(stream: &mut TcpStream) -> Value {
    let mut request = Vec::new();
    let mut buffer = [0u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut buffer).expect("provider request");
        assert_ne!(read, 0, "provider headers");
        request.extend_from_slice(&buffer[..read]);
        if let Some(position) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
            break position + 4;
        }
    };
    let headers = String::from_utf8_lossy(&request[..header_end]);
    let length = headers
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length: ")
                .and_then(|value| value.parse::<usize>().ok())
        })
        .expect("content length");
    while request.len() - header_end < length {
        let read = stream.read(&mut buffer).expect("provider body");
        assert_ne!(read, 0, "provider body");
        request.extend_from_slice(&buffer[..read]);
    }
    serde_json::from_slice(&request[header_end..header_end + length]).expect("provider JSON")
}

fn send_json(output: &mut impl Write, value: Value) {
    writeln!(output, "{value}").expect("write JSON");
    output.flush().expect("flush JSON");
}

fn read_json(input: &mut impl BufRead) -> Value {
    let mut line = String::new();
    assert_ne!(input.read_line(&mut line).expect("read JSON"), 0);
    serde_json::from_str(&line).expect("JSON")
}

fn read_message(input: &mut impl BufRead) -> Value {
    let mut line = String::new();
    assert_ne!(input.read_line(&mut line).expect("read"), 0);
    serde_json::from_str(&line).expect("JSON")
}

fn read_optional_message(input: &mut impl BufRead) -> Option<Value> {
    let mut line = String::new();
    (input.read_line(&mut line).expect("read") != 0)
        .then(|| serde_json::from_str(&line).expect("JSON"))
}

fn write_message(output: &mut impl Write, value: &Value) {
    serde_json::to_writer(&mut *output, value).expect("JSON");
    output.write_all(b"\n").expect("newline");
    output.flush().expect("flush");
}

fn wait_for_eof(input: &mut impl BufRead) {
    let mut line = String::new();
    assert_eq!(input.read_line(&mut line).expect("EOF"), 0);
}
