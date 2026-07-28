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
    approved_model_driven_call_completes_real_cli_round_trip();
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
}

fn approved_model_driven_call_completes_real_cli_round_trip() {
    const TOOL_CALL: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_mcp_fixture\",\"type\":\"function\",\"function\":{\"name\":\"mcp__fixture__inspect\",\"arguments\":\"{\\\"value\\\":[\\\"arbitrary\\\",2]}\"}}]},\"finish_reason\":null}]}\n\n",
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
    let provider = CallProvider::start(home.path(), [TOOL_CALL, FINAL_ANSWER]);
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

    let mut saw_attempt = false;
    let approval_id = loop {
        let message = read_json(&mut stdout);
        assert!(message.get("error").is_none(), "protocol error: {message}");
        if message["method"] == "item/completed"
            && message["params"]["item"]["type"] == "mcpToolExecutionAttempt"
        {
            saw_attempt = true;
        }
        if message["method"] == "item/mcpToolCall/requestApproval" {
            assert!(!saw_attempt, "attempt must follow approval");
            assert_eq!(
                message["params"]["arguments"],
                json!({"value": ["arbitrary", 2]})
            );
            break message["id"].as_str().expect("approval id").to_owned();
        }
        if matches!(
            message["method"].as_str(),
            Some("turn/failed" | "turn/interrupted" | "server/runtimeFailed")
        ) {
            panic!("unexpected terminal message: {message}");
        }
    };
    assert!(
        !marker.exists(),
        "server must not be called before approval response"
    );
    send_json(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": approval_id,
            "result": {"decision": "approved"}
        }),
    );

    let mut completed_types = Vec::new();
    loop {
        let message = read_json(&mut stdout);
        assert!(message.get("error").is_none(), "protocol error: {message}");
        if message["method"] == "item/completed" {
            completed_types.push(
                message["params"]["item"]["type"]
                    .as_str()
                    .expect("item type")
                    .to_owned(),
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
    assert!(marker.exists(), "real MCP tools/call marker");
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
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["tools"].as_array().map(Vec::len), Some(1));
    assert_eq!(
        requests[0]["tools"][0]["function"]["name"],
        "mcp__fixture__inspect"
    );
    assert!(
        requests[1]["messages"]
            .as_array()
            .expect("second messages")
            .iter()
            .any(|message| {
                message["role"] == "tool"
                    && message["tool_call_id"] == "call_mcp_fixture"
                    && message["content"]
                        .as_str()
                        .is_some_and(|content| content.contains("\"text\":[\"called\"]"))
            }),
        "normalized MCP result must be projected to the provider"
    );
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

fn fixture_server(mode: &str, marker: Option<&str>) {
    assert!(std::env::var_os("PATH").is_none());
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
                    "name": "inspect",
                    "description": "discovery only",
                    "inputSchema": {"type": "object"}
                }]
            }
        }),
    );
    if mode == "call" {
        let call = read_message(&mut input);
        assert_eq!(call["id"], 3);
        assert_eq!(call["method"], "tools/call");
        assert_eq!(call["params"]["name"], "inspect");
        assert_eq!(
            call["params"]["arguments"],
            json!({"value": ["arbitrary", 2]})
        );
        fs::write(marker.expect("call marker"), b"called").expect("write call marker");
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

struct CallProvider {
    requests: mpsc::Receiver<Value>,
    thread: thread::JoinHandle<()>,
}

impl CallProvider {
    fn start(home: &Path, bodies: [&'static str; 2]) -> Self {
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
    let mut child = sugarcode(home)
        .args(["config", "model", "set", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn model config");
    send_json(
        &mut child.stdin.take().expect("config stdin"),
        json!({
            "apiFormat": "openai-chat-completions",
            "endpoint": format!("http://{address}/v1/chat/completions"),
            "model": "fixture-model"
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

fn write_message(output: &mut impl Write, value: &Value) {
    serde_json::to_writer(&mut *output, value).expect("JSON");
    output.write_all(b"\n").expect("newline");
    output.flush().expect("flush");
}

fn wait_for_eof(input: &mut impl BufRead) {
    let mut line = String::new();
    assert_eq!(input.read_line(&mut line).expect("EOF"), 0);
}
