use serde_json::Value;
use serde_json::json;
use std::fs;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::net::TcpStream;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread;
use std::thread::JoinHandle;

const FIRST_ANSWER: &str = concat!(
    "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"First answer.\"},\"finish_reason\":null}]}\n\n",
    "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
    "data: [DONE]\n\n"
);
const SECOND_ANSWER: &str = concat!(
    "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Second answer.\"},\"finish_reason\":null}]}\n\n",
    "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
    "data: [DONE]\n\n"
);

#[test]
fn json_exec_creates_and_explicitly_resumes_one_durable_thread_from_stdin() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let _provider = MockProvider::start(
        home.path(),
        vec![FIRST_ANSWER.to_string(), SECOND_ANSWER.to_string()],
    );

    let first = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .arg("--home")
        .arg(home.path())
        .args(["exec", "--json", "first prompt"])
        .env_remove("SUGARCODE_HOME")
        .output()
        .expect("run new exec");
    assert_eq!(first.status.code(), Some(0), "{first:?}");
    assert!(first.stderr.is_empty(), "{first:?}");
    let first_records = json_lines(&first.stdout);
    assert_contiguous_v1(&first_records);
    assert_eq!(first_records[0]["type"], "runStarted");
    assert_eq!(first_records[0]["mode"], "new");
    assert_eq!(
        first_records.last().expect("finished")["status"],
        "completed"
    );
    let thread_id = first_records[0]["threadId"]
        .as_str()
        .expect("thread id")
        .to_string();
    assert!(
        first_records.iter().any(|record| {
            record["event"]["kind"] == "agentMessageDelta"
                && record["event"]["delta"] == "First answer."
        }),
        "{first_records:?}"
    );

    let mut child = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .arg("--home")
        .arg(home.path())
        .args(["exec", "--json", "--resume", &thread_id])
        .env_remove("SUGARCODE_HOME")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn resumed exec");
    child
        .stdin
        .take()
        .expect("exec stdin")
        .write_all(b"second prompt")
        .expect("write stdin prompt");
    let second = child.wait_with_output().expect("wait resumed exec");
    assert_eq!(second.status.code(), Some(0), "{second:?}");
    assert!(second.stderr.is_empty(), "{second:?}");
    let second_records = json_lines(&second.stdout);
    assert_contiguous_v1(&second_records);
    assert_eq!(second_records[0]["mode"], "resume");
    assert_eq!(second_records[0]["threadId"], thread_id);
    assert!(
        second_records.iter().any(|record| {
            record["event"]["kind"] == "agentMessageDelta"
                && record["event"]["delta"] == "Second answer."
        }),
        "{second_records:?}"
    );
}

#[test]
fn human_exec_keeps_results_on_stdout_and_diagnostics_on_stderr() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let _provider = MockProvider::start(home.path(), vec![FIRST_ANSWER.to_string()]);
    let output = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .arg("--home")
        .arg(home.path())
        .args(["exec", "hello"])
        .env_remove("SUGARCODE_HOME")
        .output()
        .expect("run human exec");
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert!(output.stderr.is_empty(), "{output:?}");
    let stdout = String::from_utf8(output.stdout).expect("UTF-8 human output");
    assert!(stdout.starts_with("Thread: thr_"), "{stdout}");
    assert!(stdout.contains("First answer."), "{stdout}");
    assert!(stdout.ends_with("Status: completed\n"), "{stdout}");
}

#[test]
fn exec_input_configuration_and_turn_failures_have_deterministic_codes() {
    let invalid = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["exec", "--json", "   "])
        .env_remove("SUGARCODE_HOME")
        .output()
        .expect("run invalid exec");
    assert_eq!(invalid.status.code(), Some(2), "{invalid:?}");
    assert_eq!(json_lines(&invalid.stdout)[0]["category"], "input");
    assert_eq!(
        String::from_utf8_lossy(&invalid.stderr),
        "sugarcode exec: invalid prompt\n"
    );

    let no_model_home = tempfile::tempdir().expect("isolated no-model home");
    let no_model = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .arg("--home")
        .arg(no_model_home.path())
        .args(["exec", "--json", "hello"])
        .env_remove("SUGARCODE_HOME")
        .output()
        .expect("run no-model exec");
    assert_eq!(no_model.status.code(), Some(3), "{no_model:?}");
    assert_eq!(
        json_lines(&no_model.stdout)
            .last()
            .expect("configuration error")["category"],
        "configuration"
    );
    assert_eq!(
        String::from_utf8_lossy(&no_model.stderr),
        "sugarcode exec: model unavailable\n"
    );

    let failed_home = tempfile::tempdir().expect("isolated failed-turn home");
    let _provider = MockProvider::start(
        failed_home.path(),
        vec![include_str!("../../model-provider/tests/fixtures/terminal-error.sse").to_string()],
    );
    let failed = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .arg("--home")
        .arg(failed_home.path())
        .args(["exec", "--json", "fail"])
        .env_remove("SUGARCODE_HOME")
        .output()
        .expect("run failed exec");
    assert_eq!(failed.status.code(), Some(4), "{failed:?}");
    let records = json_lines(&failed.stdout);
    assert!(records.iter().any(|record| {
        record["event"]["kind"] == "turnFailed" && record["event"]["errorKind"] == "server"
    }));
    assert_eq!(
        records.last().expect("failure terminal")["status"],
        "failed"
    );
    assert_eq!(
        String::from_utf8_lossy(&failed.stderr),
        "sugarcode exec: turn failed\n"
    );
}

#[test]
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn noninteractive_command_approval_is_denied_without_execution() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let workspace = tempfile::tempdir().expect("isolated workspace");
    let arguments = serde_json::to_string(&json!({
        "command": env!("CARGO_BIN_EXE_sugarcode"),
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
                        "id": "call_exec_denied",
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
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Denied safely.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    let _provider = MockProvider::start(home.path(), vec![tool_call, final_answer.to_string()]);
    let output = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .arg("--home")
        .arg(home.path())
        .args(["exec", "--json", "--workspace"])
        .arg(workspace.path())
        .arg("run a command")
        .env_remove("SUGARCODE_HOME")
        .output()
        .expect("run denied approval exec");
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    let records = json_lines(&output.stdout);
    assert!(records.iter().any(|record| {
        record["event"]["item"]["kind"] == "commandApprovalDecision"
            && record["event"]["item"]["decision"] == "denied"
    }));
    assert!(
        !records
            .iter()
            .any(|record| { record["event"]["item"]["kind"] == "commandExecutionAttempt" })
    );
}

#[test]
#[cfg(unix)]
fn closed_stdout_is_a_broken_pipe_exit_and_never_becomes_success() {
    use std::os::fd::FromRawFd;

    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let _provider = MockProvider::start(home.path(), Vec::new());
    let mut descriptors = [-1; 2];
    // SAFETY: `pipe` initializes both descriptors on success. The read end is
    // closed before spawn, and ownership of the write end moves into `File`.
    assert_eq!(unsafe { libc::pipe(descriptors.as_mut_ptr()) }, 0);
    // SAFETY: the descriptor was returned by `pipe` and has not been closed.
    assert_eq!(unsafe { libc::close(descriptors[0]) }, 0);
    // SAFETY: the write descriptor is valid and transferred exactly once.
    let write_end = unsafe { fs::File::from_raw_fd(descriptors[1]) };
    let output = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .arg("--home")
        .arg(home.path())
        .args(["exec", "--json", "hello"])
        .env_remove("SUGARCODE_HOME")
        .stdout(Stdio::from(write_end))
        .stderr(Stdio::piped())
        .output()
        .expect("run broken-pipe exec");
    assert_eq!(output.status.code(), Some(6), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("output unavailable"),
        "{output:?}"
    );
}

#[test]
#[cfg(unix)]
fn interrupt_signal_closes_provider_and_persists_interrupted_terminal() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let provider = BlockingMockProvider::start(home.path());
    let child = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .arg("--home")
        .arg(home.path())
        .args(["exec", "--json", "wait"])
        .env_remove("SUGARCODE_HOME")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn signal exec");
    provider.wait_until_delta_sent();
    // SAFETY: the child PID belongs to the process just spawned by this test.
    assert_eq!(unsafe { libc::kill(child.id() as i32, libc::SIGINT) }, 0);
    let output = child.wait_with_output().expect("wait interrupted exec");
    assert_eq!(output.status.code(), Some(5), "{output:?}");
    let records = json_lines(&output.stdout);
    assert!(
        records
            .iter()
            .any(|record| { record["event"]["kind"] == "turnInterrupted" })
    );
    assert_eq!(
        records.last().expect("interrupted terminal")["status"],
        "interrupted"
    );
    provider.wait_until_connection_closed();
}

fn json_lines(bytes: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(|line| serde_json::from_str(line).expect("JSON Lines record"))
        .collect()
}

fn assert_contiguous_v1(records: &[Value]) {
    assert!(!records.is_empty());
    for (index, record) in records.iter().enumerate() {
        assert_eq!(record["version"], 1);
        assert_eq!(record["sequence"], (index + 1) as u64);
    }
}

struct MockProvider {
    address: std::net::SocketAddr,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl MockProvider {
    fn start(home: &std::path::Path, bodies: Vec<String>) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind mock provider");
        let address = listener.local_addr().expect("mock provider address");
        configure_model(home, address);
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
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
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("provider delta deadline");
    }

    fn wait_until_connection_closed(&self) {
        self.connection_closed
            .recv_timeout(std::time::Duration::from_secs(5))
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

fn serve_recorded_response(stream: &mut TcpStream, body: &str) {
    read_provider_request(stream);
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
    .expect("write provider response");
    stream.flush().expect("flush provider response");
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
        assert!(request.len() <= 64 * 1024);
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
        .arg("--home")
        .arg(home)
        .args(["config", "model", "inspect", "--json"])
        .output()
        .expect("inspect model config");
    assert!(inspection.status.success(), "{inspection:?}");
    let revision =
        serde_json::from_slice::<Value>(&inspection.stdout).expect("model inspection")["revision"]
            .clone();
    let mut child = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .arg("--home")
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
                "apiFormat": "openai-chat-completions",
                "endpoint": format!("http://{address}/v1/chat/completions"),
                "model": "fixture-model",
                "credentialReference": Value::Null
            }
        })
    )
    .expect("write model config");
    let output = child.wait_with_output().expect("wait model config");
    assert!(output.status.success(), "{output:?}");
    assert!(output.stderr.is_empty(), "{output:?}");
}
