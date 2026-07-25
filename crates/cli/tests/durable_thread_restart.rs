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
use std::process::Child;
use std::process::ChildStdin;
use std::process::ChildStdout;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::thread;
use std::thread::JoinHandle;

struct RunningServer {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    provider: MockProvider,
}

impl RunningServer {
    fn spawn(home: &Path) -> Self {
        let provider = MockProvider::start(home);
        let mut child = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
            .arg("--home")
            .arg(home)
            .args(["app-server", "--stdio"])
            .env_remove("SUGARCODE_HOME")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn app-server");
        let stdin = child.stdin.take().expect("child stdin");
        let stdout = BufReader::new(child.stdout.take().expect("child stdout"));
        Self {
            child,
            stdin,
            stdout,
            provider,
        }
    }

    fn send(&mut self, message: Value, output_lines: usize) -> Vec<Value> {
        writeln!(self.stdin, "{message}").expect("write request");
        self.stdin.flush().expect("flush request");
        (0..output_lines)
            .map(|_| {
                let mut line = String::new();
                let bytes = self.stdout.read_line(&mut line).expect("read response");
                assert!(bytes > 0, "app-server closed before expected response");
                serde_json::from_str(&line).expect("response JSON")
            })
            .collect()
    }

    fn initialize(&mut self) {
        let response = self.send(
            json!({
                "jsonrpc": "2.0",
                "id": "initialize",
                "method": "initialize",
                "params": {
                    "protocolVersion": 1,
                    "clientInfo": {
                        "name": "restart-test",
                        "version": "1.0.0"
                    }
                }
            }),
            1,
        );
        assert_eq!(response[0]["id"], "initialize");
        self.send(json!({"jsonrpc": "2.0", "method": "initialized"}), 0);
    }

    fn provider_requests(&self) -> Vec<Value> {
        self.provider.requests()
    }

    fn finish(self) {
        let stderr = self.finish_with_diagnostics();
        assert!(stderr.is_empty(), "unexpected diagnostics: {stderr}");
    }

    fn finish_with_diagnostics(mut self) -> String {
        drop(self.stdin);
        let mut remaining_stdout = String::new();
        self.stdout
            .read_to_string(&mut remaining_stdout)
            .expect("drain stdout");
        assert!(remaining_stdout.is_empty(), "unexpected protocol output");
        let status = self.child.wait().expect("wait for app-server");
        let mut stderr = String::new();
        self.child
            .stderr
            .take()
            .expect("child stderr")
            .read_to_string(&mut stderr)
            .expect("read stderr");
        assert!(status.success(), "app-server failed: {status:?}: {stderr}");
        stderr
    }
}

struct MockProvider {
    address: std::net::SocketAddr,
    stop: Arc<AtomicBool>,
    requests: Arc<Mutex<Vec<Value>>>,
    thread: Option<JoinHandle<()>>,
}

impl MockProvider {
    fn start(home: &Path) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind mock provider");
        let address = listener.local_addr().expect("mock provider address");
        configure_model(home, address);
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let thread_stop = stop.clone();
        let thread_requests = requests.clone();
        let thread = thread::spawn(move || {
            while !thread_stop.load(Ordering::Acquire) {
                let (mut stream, _) = listener.accept().expect("accept provider request");
                if thread_stop.load(Ordering::Acquire) {
                    break;
                }
                let request = serve_recorded_response(&mut stream);
                thread_requests.lock().expect("request lock").push(request);
            }
        });
        Self {
            address,
            stop,
            requests,
            thread: Some(thread),
        }
    }

    fn requests(&self) -> Vec<Value> {
        self.requests.lock().expect("request lock").clone()
    }
}

fn configure_model(home: &Path, address: std::net::SocketAddr) {
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

impl Drop for MockProvider {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = TcpStream::connect(self.address);
        if let Some(thread) = self.thread.take() {
            thread.join().expect("join mock provider");
        }
    }
}

fn serve_recorded_response(stream: &mut TcpStream) -> Value {
    let mut request = Vec::new();
    let mut buffer = [0u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut buffer).expect("read provider request");
        assert!(read > 0, "provider request ended before headers");
        request.extend_from_slice(&buffer[..read]);
        if let Some(position) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
        assert!(
            request.len() <= 64 * 1024,
            "provider request headers too large"
        );
    };
    let headers = String::from_utf8_lossy(&request[..header_end]);
    assert!(headers.starts_with("POST /v1/chat/completions HTTP/1.1\r\n"));
    assert!(!headers.to_ascii_lowercase().contains("authorization:"));
    let content_length = headers
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length: ")
                .and_then(|value| value.parse::<usize>().ok())
        })
        .expect("provider content length");
    assert!(content_length <= 1024 * 1024);
    while request.len() - header_end < content_length {
        let read = stream
            .read(&mut buffer)
            .expect("read provider request body");
        assert!(read > 0, "provider request body ended early");
        request.extend_from_slice(&buffer[..read]);
    }
    let request_body: Value =
        serde_json::from_slice(&request[header_end..header_end + content_length])
            .expect("provider request JSON");
    assert_eq!(request_body["stream"], true);
    assert_eq!(request_body["stream_options"]["include_usage"], true);
    for forbidden in [
        "tools",
        "tool_choice",
        "response_format",
        "modalities",
        "audio",
    ] {
        assert!(request_body.get(forbidden).is_none(), "{forbidden}");
    }
    let body = include_str!("../../model-provider/tests/fixtures/completed.sse");
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
    .expect("write provider response");
    stream.flush().expect("flush provider response");
    request_body
}

#[test]
fn resumes_completed_history_across_two_cli_processes() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let mut first = RunningServer::spawn(home.path());
    first.initialize();

    let thread_messages = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "thread-1",
            "method": "thread/start",
            "params": {}
        }),
        2,
    );
    let thread_id = thread_messages[0]["result"]["thread"]["id"]
        .as_str()
        .expect("thread id")
        .to_string();
    let turn_messages = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "turn-1",
            "method": "turn/start",
            "params": {"threadId": thread_id, "input": "Hello"}
        }),
        8,
    );
    let completed_turn = turn_messages[7]["params"]["turn"].clone();
    let completed_item = turn_messages[6]["params"]["item"].clone();
    first.finish();
    fs::remove_file(home.path().join("projections/v1/thread-discovery.sqlite3"))
        .expect("remove disposable projection");

    let mut second = RunningServer::spawn(home.path());
    second.initialize();
    let listed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "list-1",
            "method": "thread/list",
            "params": {}
        }),
        1,
    );
    assert_eq!(listed[0]["result"]["data"], json!([{"id": thread_id}]));
    assert_eq!(listed[0]["result"]["nextCursor"], Value::Null);
    let resumed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "resume-1",
            "method": "thread/resume",
            "params": {"threadId": thread_id}
        }),
        1,
    );
    assert_eq!(resumed[0]["result"]["thread"]["id"], thread_id);
    assert_eq!(resumed[0]["result"]["turns"][0]["id"], completed_turn["id"]);
    assert_eq!(
        resumed[0]["result"]["turns"][0]["status"],
        completed_turn["status"]
    );
    assert_eq!(resumed[0]["result"]["turns"][0]["items"][1], completed_item);

    let next_turn = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "turn-2",
            "method": "turn/start",
            "params": {"threadId": thread_id, "input": "Hello"}
        }),
        8,
    );
    assert_eq!(
        next_turn[0]["result"]["turn"]["id"],
        "turn_0000000000000002"
    );
    assert_eq!(
        next_turn[4]["params"]["item"]["id"],
        "item_0000000000000004"
    );
    assert_eq!(
        second.provider_requests()[0]["messages"],
        json!([
            {"role": "user", "content": "Hello"},
            {
                "role": "assistant",
                "content": "SugarCode deterministic response."
            },
            {"role": "user", "content": "Hello"}
        ])
    );
    second.finish();
}

#[test]
fn forks_complete_history_across_processes_with_independent_lifecycle_and_ids() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let mut first = RunningServer::spawn(home.path());
    first.initialize();

    first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "source",
            "method": "thread/start"
        }),
        2,
    );
    for sequence in 1..=2 {
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": format!("source-turn-{sequence}"),
                "method": "turn/start",
                "params": {"threadId": "thr_0000000000000001", "input": "Hello"}
            }),
            8,
        );
    }

    let source_rollout = home.path().join("rollouts/v1/thr_0000000000000001.jsonl");
    let source_before_fork = fs::read(&source_rollout).expect("read source rollout before fork");
    let forked = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "fork",
            "method": "thread/fork",
            "params": {"threadId": "thr_0000000000000001"}
        }),
        2,
    );
    assert_eq!(forked[0]["result"]["thread"]["id"], "thr_0000000000000002");
    assert_eq!(
        forked[0]["result"]["turns"][0]["id"],
        "turn_0000000000000003"
    );
    assert_eq!(
        forked[0]["result"]["turns"][0]["items"][0]["id"],
        "item_0000000000000005"
    );
    assert_eq!(
        forked[0]["result"]["turns"][1]["id"],
        "turn_0000000000000004"
    );
    assert_eq!(
        forked[0]["result"]["turns"][1]["items"][0]["id"],
        "item_0000000000000007"
    );
    assert_eq!(forked[1]["method"], "thread/started");
    assert_eq!(
        fs::read(&source_rollout).expect("read source rollout after fork"),
        source_before_fork,
        "forking must not append to or rewrite the source rollout"
    );

    assert_eq!(
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": "archive-fork",
                "method": "thread/archive",
                "params": {"threadId": "thr_0000000000000002"}
            }),
            1,
        )[0]["result"],
        json!({})
    );
    assert_eq!(
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": "resume-hidden-fork",
                "method": "thread/resume",
                "params": {"threadId": "thr_0000000000000002"}
            }),
            1,
        )[0]["error"]["code"],
        -32004
    );
    assert_eq!(
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": "resume-source",
                "method": "thread/resume",
                "params": {"threadId": "thr_0000000000000001"}
            }),
            1,
        )[0]["result"]["turns"]
            .as_array()
            .expect("source turns")
            .len(),
        2
    );
    assert_eq!(
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": "unarchive-fork",
                "method": "thread/unarchive",
                "params": {"threadId": "thr_0000000000000002"}
            }),
            1,
        )[0]["result"],
        json!({})
    );
    assert_eq!(
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": "delete-source",
                "method": "thread/delete",
                "params": {"threadId": "thr_0000000000000001"}
            }),
            1,
        )[0]["result"],
        json!({})
    );
    let continued = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "continue-fork",
            "method": "turn/start",
            "params": {"threadId": "thr_0000000000000002", "input": "Hello"}
        }),
        8,
    );
    assert_eq!(
        continued[0]["result"]["turn"]["id"],
        "turn_0000000000000005"
    );
    assert_eq!(
        continued[4]["params"]["item"]["id"],
        "item_0000000000000010"
    );
    first.finish();

    let projections = home.path().join("projections/v1");
    fs::remove_file(projections.join("thread-discovery.sqlite3"))
        .expect("remove discovery projection");
    let search_projection = projections.join("thread-search.sqlite3");
    let sentinel = "fork-search-corruption-secret-must-not-leak";
    fs::write(&search_projection, sentinel).expect("corrupt search projection");

    let mut second = RunningServer::spawn(home.path());
    second.initialize();
    let listed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "list-after-restart",
            "method": "thread/list"
        }),
        1,
    );
    assert_eq!(
        listed[0]["result"]["data"],
        json!([{"id": "thr_0000000000000002"}])
    );
    let searched = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "search-after-restart",
            "method": "thread/search",
            "params": {"query": "SugarCode deterministic"}
        }),
        1,
    );
    assert_eq!(
        searched[0]["result"]["data"],
        json!([{"id": "thr_0000000000000002"}])
    );
    let resumed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "resume-fork-after-restart",
            "method": "thread/resume",
            "params": {"threadId": "thr_0000000000000002"}
        }),
        1,
    );
    assert_eq!(
        resumed[0]["result"]["turns"]
            .as_array()
            .expect("fork turns")
            .len(),
        3
    );
    for (index, sequence) in (3..=5).enumerate() {
        assert_eq!(
            resumed[0]["result"]["turns"][index]["id"],
            format!("turn_{sequence:016}")
        );
        assert_eq!(
            resumed[0]["result"]["turns"][index]["items"][0]["id"],
            format!("item_{:016}", sequence * 2 - 1)
        );
    }
    assert_eq!(
        second.send(
            json!({
                "jsonrpc": "2.0",
                "id": "fork-deleted-source",
                "method": "thread/fork",
                "params": {"threadId": "thr_0000000000000001"}
            }),
            1,
        )[0]["error"]["code"],
        -32004
    );
    let next_turn = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "fork-turn-after-restart",
            "method": "turn/start",
            "params": {"threadId": "thr_0000000000000002", "input": "Hello"}
        }),
        8,
    );
    assert_eq!(
        next_turn[0]["result"]["turn"]["id"],
        "turn_0000000000000006"
    );
    assert_eq!(
        next_turn[4]["params"]["item"]["id"],
        "item_0000000000000012"
    );
    let next_thread = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "next-thread",
            "method": "thread/start"
        }),
        2,
    );
    assert_eq!(
        next_thread[0]["result"]["thread"]["id"],
        "thr_0000000000000003"
    );
    let other_turn = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "other-turn",
            "method": "turn/start",
            "params": {"threadId": "thr_0000000000000003", "input": "Hello"}
        }),
        8,
    );
    assert_eq!(
        other_turn[0]["result"]["turn"]["id"],
        "turn_0000000000000007"
    );
    assert_eq!(
        other_turn[4]["params"]["item"]["id"],
        "item_0000000000000014"
    );

    let stderr = second.finish_with_diagnostics();
    assert!(stderr.contains("thread-search.sqlite3"));
    assert!(stderr.contains("thread search rebuild"));
    assert!(stderr.contains("invalidHeaderRecovered"));
    assert!(!stderr.contains(sentinel));
    assert!(!stderr.contains("SugarCode deterministic response."));
}

#[test]
fn rebuilds_an_invalid_projection_then_lists_and_resumes_without_leaking_contents() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let mut first = RunningServer::spawn(home.path());
    first.initialize();
    let started = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "thread-1",
            "method": "thread/start"
        }),
        2,
    );
    let thread_id = started[0]["result"]["thread"]["id"]
        .as_str()
        .expect("thread id")
        .to_string();
    let lifecycle = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "turn-1",
            "method": "turn/start",
            "params": {"threadId": thread_id, "input": "Hello"}
        }),
        8,
    );
    let expected_item = lifecycle[6]["params"]["item"].clone();
    first.finish();

    let projection = home.path().join("projections/v1/thread-discovery.sqlite3");
    let sentinel = "projection-secret-must-not-leak";
    fs::write(&projection, sentinel).expect("replace projection with invalid header");

    let mut second = RunningServer::spawn(home.path());
    second.initialize();
    let listed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "list",
            "method": "thread/list"
        }),
        1,
    );
    assert_eq!(listed[0]["result"]["data"], json!([{"id": thread_id}]));
    let resumed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "resume",
            "method": "thread/resume",
            "params": {"threadId": thread_id}
        }),
        1,
    );
    assert_eq!(resumed[0]["result"]["turns"][0]["items"][1], expected_item);
    let stderr = second.finish_with_diagnostics();
    assert!(stderr.contains("thread-discovery.sqlite3"));
    assert!(stderr.contains("thread discovery rebuild"));
    assert!(stderr.contains("invalidHeaderRecovered"));
    assert!(!stderr.contains(sentinel));
    assert!(!stderr.contains("SugarCode deterministic response."));
}

#[test]
fn rebuilds_search_across_processes_without_affecting_list_or_resume() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let mut first = RunningServer::spawn(home.path());
    first.initialize();
    for sequence in 1..=3 {
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": format!("thread-{sequence}"),
                "method": "thread/start",
                "params": {}
            }),
            2,
        );
        if sequence < 3 {
            first.send(
                json!({
                    "jsonrpc": "2.0",
                    "id": format!("turn-{sequence}"),
                    "method": "turn/start",
                    "params": {
                        "threadId": format!("thr_{sequence:016}"),
                        "input": "Hello"
                    }
                }),
                8,
            );
        }
    }
    first.finish();

    let projection = home.path().join("projections/v1/thread-search.sqlite3");
    let corruption_sentinel = "search-corruption-secret-must-not-leak";
    fs::write(&projection, corruption_sentinel).expect("corrupt search projection");

    let mut second = RunningServer::spawn(home.path());
    second.initialize();
    let query_sentinel = "private-query-sentinel";
    let empty = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "private-search",
            "method": "thread/search",
            "params": {"query": query_sentinel}
        }),
        1,
    );
    assert_eq!(empty[0]["result"]["data"], json!([]));
    let searched = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "search",
            "method": "thread/search",
            "params": {"query": "SugarCode deterministic", "limit": 50}
        }),
        1,
    );
    assert_eq!(
        searched[0]["result"]["data"],
        json!([
            {"id": "thr_0000000000000002"},
            {"id": "thr_0000000000000001"}
        ])
    );
    assert_eq!(searched[0]["result"]["nextCursor"], Value::Null);

    let listed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "list",
            "method": "thread/list"
        }),
        1,
    );
    assert_eq!(
        listed[0]["result"]["data"]
            .as_array()
            .expect("threads")
            .len(),
        3
    );
    let resumed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "resume",
            "method": "thread/resume",
            "params": {"threadId": "thr_0000000000000001"}
        }),
        1,
    );
    assert_eq!(
        resumed[0]["result"]["turns"][0]["items"][1]["text"],
        "SugarCode deterministic response."
    );

    let stderr = second.finish_with_diagnostics();
    assert!(stderr.contains("thread-search.sqlite3"));
    assert!(stderr.contains("thread search rebuild"));
    assert!(stderr.contains("invalidHeaderRecovered"));
    assert!(!stderr.contains(corruption_sentinel));
    assert!(!stderr.contains(query_sentinel));
    assert!(
        !fs::read(&projection)
            .expect("read rebuilt projection")
            .windows(query_sentinel.len())
            .any(|window| window == query_sentinel.as_bytes())
    );
}

#[test]
fn archives_across_two_processes_and_rebuilds_both_projections_from_rollouts() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let mut first = RunningServer::spawn(home.path());
    first.initialize();
    for sequence in 1..=3 {
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": format!("thread-{sequence}"),
                "method": "thread/start",
                "params": {}
            }),
            2,
        );
        if sequence < 3 {
            first.send(
                json!({
                    "jsonrpc": "2.0",
                    "id": format!("turn-{sequence}"),
                    "method": "turn/start",
                    "params": {"threadId": format!("thr_{sequence:016}"), "input": "Hello"}
                }),
                8,
            );
        }
    }

    let archived = "thr_0000000000000002";
    let archive = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "archive",
            "method": "thread/archive",
            "params": {"threadId": archived}
        }),
        1,
    );
    assert_eq!(archive[0]["result"], json!({}));
    let idempotent = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "archive-again",
            "method": "thread/archive",
            "params": {"threadId": archived}
        }),
        1,
    );
    assert_eq!(idempotent[0]["result"], json!({}));
    assert_active_archive_views(&mut first, "first");
    first.finish();

    let projections = home.path().join("projections/v1");
    fs::remove_file(projections.join("thread-discovery.sqlite3"))
        .expect("remove discovery projection");
    let search_projection = projections.join("thread-search.sqlite3");
    let sentinel = "archived-search-corruption-secret-must-not-leak";
    fs::write(&search_projection, sentinel).expect("corrupt search projection");

    let mut second = RunningServer::spawn(home.path());
    second.initialize();
    assert_active_archive_views(&mut second, "second");
    let resumed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "resume-active",
            "method": "thread/resume",
            "params": {"threadId": "thr_0000000000000001"}
        }),
        1,
    );
    assert_eq!(
        resumed[0]["result"]["turns"][0]["items"][1]["text"],
        "SugarCode deterministic response."
    );
    let next = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "thread-4",
            "method": "thread/start",
            "params": {}
        }),
        2,
    );
    assert_eq!(next[0]["result"]["thread"]["id"], "thr_0000000000000004");
    let next_turn = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "turn-3",
            "method": "turn/start",
            "params": {"threadId": "thr_0000000000000004", "input": "Hello"}
        }),
        8,
    );
    assert_eq!(
        next_turn[0]["result"]["turn"]["id"],
        "turn_0000000000000003"
    );
    assert_eq!(
        next_turn[4]["params"]["item"]["id"],
        "item_0000000000000006"
    );

    let stderr = second.finish_with_diagnostics();
    assert!(stderr.contains("thread-search.sqlite3"));
    assert!(stderr.contains("thread search rebuild"));
    assert!(stderr.contains("invalidHeaderRecovered"));
    assert!(!stderr.contains(sentinel));
    assert!(!stderr.contains("SugarCode deterministic response."));
}

#[test]
fn unarchives_across_two_processes_and_rebuilds_both_projections_from_rollouts() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let mut first = RunningServer::spawn(home.path());
    first.initialize();
    for sequence in 1..=2 {
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": format!("thread-{sequence}"),
                "method": "thread/start",
                "params": {}
            }),
            2,
        );
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": format!("turn-{sequence}"),
                "method": "turn/start",
                "params": {"threadId": format!("thr_{sequence:016}"), "input": "Hello"}
            }),
            8,
        );
    }

    let restored = "thr_0000000000000002";
    assert_eq!(
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": "archive",
                "method": "thread/archive",
                "params": {"threadId": restored}
            }),
            1,
        )[0]["result"],
        json!({})
    );
    let hidden = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "hidden-list",
            "method": "thread/list"
        }),
        1,
    );
    assert_eq!(
        hidden[0]["result"]["data"],
        json!([{"id": "thr_0000000000000001"}])
    );
    assert_eq!(
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": "unarchive",
                "method": "thread/unarchive",
                "params": {"threadId": restored}
            }),
            1,
        )[0]["result"],
        json!({})
    );
    let restored_list = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "restored-list",
            "method": "thread/list"
        }),
        1,
    );
    assert_eq!(
        restored_list[0]["result"]["data"],
        json!([
            {"id": "thr_0000000000000002"},
            {"id": "thr_0000000000000001"}
        ])
    );
    let turn_after_restore = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "turn-after-restore",
            "method": "turn/start",
            "params": {"threadId": restored, "input": "Hello"}
        }),
        8,
    );
    assert_eq!(
        turn_after_restore[0]["result"]["turn"]["id"],
        "turn_0000000000000003"
    );
    first.finish();

    let projections = home.path().join("projections/v1");
    fs::remove_file(projections.join("thread-discovery.sqlite3"))
        .expect("remove discovery projection");
    let search_projection = projections.join("thread-search.sqlite3");
    let sentinel = "unarchive-search-corruption-secret-must-not-leak";
    fs::write(&search_projection, sentinel).expect("corrupt search projection");

    let mut second = RunningServer::spawn(home.path());
    second.initialize();
    let listed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "list-after-restart",
            "method": "thread/list"
        }),
        1,
    );
    assert_eq!(
        listed[0]["result"]["data"],
        json!([
            {"id": "thr_0000000000000002"},
            {"id": "thr_0000000000000001"}
        ])
    );
    let searched = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "search-after-restart",
            "method": "thread/search",
            "params": {"query": "SugarCode deterministic"}
        }),
        1,
    );
    assert_eq!(
        searched[0]["result"]["data"],
        json!([
            {"id": "thr_0000000000000002"},
            {"id": "thr_0000000000000001"}
        ])
    );
    let resumed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "resume-after-restart",
            "method": "thread/resume",
            "params": {"threadId": restored}
        }),
        1,
    );
    assert_eq!(
        resumed[0]["result"]["turns"]
            .as_array()
            .expect("restored turns")
            .len(),
        2
    );
    assert_eq!(
        resumed[0]["result"]["turns"][0]["id"],
        "turn_0000000000000002"
    );
    assert_eq!(
        resumed[0]["result"]["turns"][1]["id"],
        "turn_0000000000000003"
    );
    let next_turn = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "turn-after-restart",
            "method": "turn/start",
            "params": {"threadId": restored, "input": "Hello"}
        }),
        8,
    );
    assert_eq!(
        next_turn[0]["result"]["turn"]["id"],
        "turn_0000000000000004"
    );
    assert_eq!(
        next_turn[4]["params"]["item"]["id"],
        "item_0000000000000008"
    );

    let stderr = second.finish_with_diagnostics();
    assert!(stderr.contains("thread-search.sqlite3"));
    assert!(stderr.contains("thread search rebuild"));
    assert!(stderr.contains("invalidHeaderRecovered"));
    assert!(!stderr.contains(sentinel));
    assert!(!stderr.contains("SugarCode deterministic response."));
}

#[test]
fn deletes_across_two_processes_and_rebuilds_both_projections_from_rollouts() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let mut first = RunningServer::spawn(home.path());
    first.initialize();
    for sequence in 1..=3 {
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": format!("thread-{sequence}"),
                "method": "thread/start",
                "params": {}
            }),
            2,
        );
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": format!("turn-{sequence}"),
                "method": "turn/start",
                "params": {"threadId": format!("thr_{sequence:016}"), "input": "Hello"}
            }),
            8,
        );
    }

    assert_eq!(
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": "delete-active",
                "method": "thread/delete",
                "params": {"threadId": "thr_0000000000000001"}
            }),
            1,
        )[0]["result"],
        json!({})
    );
    assert_eq!(
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": "archive",
                "method": "thread/archive",
                "params": {"threadId": "thr_0000000000000002"}
            }),
            1,
        )[0]["result"],
        json!({})
    );
    assert_eq!(
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": "delete-archived",
                "method": "thread/delete",
                "params": {"threadId": "thr_0000000000000002"}
            }),
            1,
        )[0]["result"],
        json!({})
    );
    assert_eq!(
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": "delete-again",
                "method": "thread/delete",
                "params": {"threadId": "thr_0000000000000001"}
            }),
            1,
        )[0]["result"],
        json!({})
    );
    assert_deleted_views(&mut first, "first");
    first.finish();

    let projections = home.path().join("projections/v1");
    fs::remove_file(projections.join("thread-discovery.sqlite3"))
        .expect("remove discovery projection");
    let search_projection = projections.join("thread-search.sqlite3");
    let sentinel = "deleted-search-corruption-secret-must-not-leak";
    fs::write(&search_projection, sentinel).expect("corrupt search projection");

    let mut second = RunningServer::spawn(home.path());
    second.initialize();
    assert_deleted_views(&mut second, "second");
    for (request_id, method) in [
        ("resume-deleted", "thread/resume"),
        ("archive-deleted", "thread/archive"),
        ("unarchive-deleted", "thread/unarchive"),
        ("turn-deleted", "turn/start"),
    ] {
        let params = if method == "turn/start" {
            json!({"threadId": "thr_0000000000000001", "input": "Hello"})
        } else {
            json!({"threadId": "thr_0000000000000001"})
        };
        let response = second.send(
            json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params
            }),
            1,
        );
        assert_eq!(response[0]["error"]["code"], -32004);
        assert_eq!(
            response[0]["error"]["data"],
            json!({"threadId": "thr_0000000000000001"})
        );
    }

    let next = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "thread-4",
            "method": "thread/start",
            "params": {}
        }),
        2,
    );
    assert_eq!(next[0]["result"]["thread"]["id"], "thr_0000000000000004");
    let next_turn = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "turn-4",
            "method": "turn/start",
            "params": {"threadId": "thr_0000000000000004", "input": "Hello"}
        }),
        8,
    );
    assert_eq!(
        next_turn[0]["result"]["turn"]["id"],
        "turn_0000000000000004"
    );
    assert_eq!(
        next_turn[4]["params"]["item"]["id"],
        "item_0000000000000008"
    );

    let stderr = second.finish_with_diagnostics();
    assert!(stderr.contains("thread-search.sqlite3"));
    assert!(stderr.contains("thread search rebuild"));
    assert!(stderr.contains("invalidHeaderRecovered"));
    assert!(!stderr.contains(sentinel));
    assert!(!stderr.contains("SugarCode deterministic response."));
}

fn assert_deleted_views(server: &mut RunningServer, request_prefix: &str) {
    let listed = server.send(
        json!({
            "jsonrpc": "2.0",
            "id": format!("{request_prefix}-list"),
            "method": "thread/list"
        }),
        1,
    );
    assert_eq!(
        listed[0]["result"]["data"],
        json!([{"id": "thr_0000000000000003"}])
    );
    let searched = server.send(
        json!({
            "jsonrpc": "2.0",
            "id": format!("{request_prefix}-search"),
            "method": "thread/search",
            "params": {"query": "SugarCode deterministic"}
        }),
        1,
    );
    assert_eq!(
        searched[0]["result"]["data"],
        json!([{"id": "thr_0000000000000003"}])
    );
}

fn assert_active_archive_views(server: &mut RunningServer, request_prefix: &str) {
    let listed = server.send(
        json!({
            "jsonrpc": "2.0",
            "id": format!("{request_prefix}-list"),
            "method": "thread/list"
        }),
        1,
    );
    assert_eq!(
        listed[0]["result"]["data"],
        json!([
            {"id": "thr_0000000000000003"},
            {"id": "thr_0000000000000001"}
        ])
    );
    let searched = server.send(
        json!({
            "jsonrpc": "2.0",
            "id": format!("{request_prefix}-search"),
            "method": "thread/search",
            "params": {"query": "SugarCode deterministic"}
        }),
        1,
    );
    assert_eq!(
        searched[0]["result"]["data"],
        json!([{"id": "thr_0000000000000001"}])
    );
    let resume_archived = server.send(
        json!({
            "jsonrpc": "2.0",
            "id": format!("{request_prefix}-resume-archived"),
            "method": "thread/resume",
            "params": {"threadId": "thr_0000000000000002"}
        }),
        1,
    );
    assert_eq!(resume_archived[0]["error"]["code"], -32004);
    assert_eq!(
        resume_archived[0]["error"]["data"],
        json!({"threadId": "thr_0000000000000002"})
    );
}

#[test]
fn rejects_a_second_app_server_using_the_same_home() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let mut first = RunningServer::spawn(home.path());
    first.initialize();

    let second = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .arg("--home")
        .arg(home.path())
        .args(["app-server", "--stdio"])
        .env_remove("SUGARCODE_HOME")
        .stdin(Stdio::null())
        .output()
        .expect("run second app-server");
    assert!(!second.status.success());
    assert!(second.stdout.is_empty());
    let stderr = String::from_utf8(second.stderr).expect("UTF-8 stderr");
    assert!(stderr.contains("rollout writer is busy"));

    first.finish();
}
