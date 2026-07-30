use super::*;

pub(super) struct RunningServer {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    provider: MockProvider,
    expects_sandbox_unavailable: bool,
}

impl RunningServer {
    pub(super) fn spawn(home: &Path) -> Self {
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
            expects_sandbox_unavailable: false,
        }
    }

    pub(super) fn spawn_with_workspace(
        home: &Path,
        workspace: &Path,
        provider_bodies: Vec<&'static str>,
    ) -> Self {
        let provider = MockProvider::start_with_bodies(home, provider_bodies);
        let mut child = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
            .arg("--home")
            .arg(home)
            .args(["app-server", "--stdio", "--workspace"])
            .arg(workspace)
            .env_remove("SUGARCODE_HOME")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn app-server with workspace");
        let stdin = child.stdin.take().expect("child stdin");
        let stdout = BufReader::new(child.stdout.take().expect("child stdout"));
        Self {
            child,
            stdin,
            stdout,
            provider,
            expects_sandbox_unavailable: cfg!(windows),
        }
    }

    pub(super) fn spawn_with_workspace_scope(
        home: &Path,
        workspace: &Path,
        scope: &str,
        provider_bodies: Vec<&'static str>,
    ) -> Self {
        let provider = MockProvider::start_with_bodies(home, provider_bodies);
        let mut child = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
            .arg("--home")
            .arg(home)
            .args(["app-server", "--stdio", "--workspace"])
            .arg(workspace)
            .args(["--workspace-scope", scope])
            .env_remove("SUGARCODE_HOME")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn app-server with workspace scope");
        let stdin = child.stdin.take().expect("child stdin");
        let stdout = BufReader::new(child.stdout.take().expect("child stdout"));
        Self {
            child,
            stdin,
            stdout,
            provider,
            expects_sandbox_unavailable: cfg!(windows),
        }
    }

    pub(super) fn spawn_with_workspace_write(
        home: &Path,
        workspace: &Path,
        provider_bodies: Vec<&'static str>,
    ) -> Self {
        let provider = MockProvider::start_with_bodies(home, provider_bodies);
        let mut child = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
            .arg("--home")
            .arg(home)
            .args([
                "app-server",
                "--stdio",
                "--workspace",
                workspace.to_str().expect("UTF-8 workspace path"),
                "--allow-workspace-write",
            ])
            .env_remove("SUGARCODE_HOME")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn app-server with workspace writes");
        let stdin = child.stdin.take().expect("child stdin");
        let stdout = BufReader::new(child.stdout.take().expect("child stdout"));
        Self {
            child,
            stdin,
            stdout,
            provider,
            expects_sandbox_unavailable: cfg!(windows),
        }
    }

    pub(super) fn spawn_with_workspace_scope_write(
        home: &Path,
        workspace: &Path,
        scope: &str,
        provider_bodies: Vec<&'static str>,
    ) -> Self {
        let provider = MockProvider::start_with_bodies(home, provider_bodies);
        let mut child = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
            .arg("--home")
            .arg(home)
            .args(["app-server", "--stdio", "--workspace"])
            .arg(workspace)
            .args(["--workspace-scope", scope, "--allow-workspace-write"])
            .env_remove("SUGARCODE_HOME")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn app-server with scoped workspace writes");
        let stdin = child.stdin.take().expect("child stdin");
        let stdout = BufReader::new(child.stdout.take().expect("child stdout"));
        Self {
            child,
            stdin,
            stdout,
            provider,
            expects_sandbox_unavailable: cfg!(windows),
        }
    }

    pub(super) fn spawn_with_responses(home: &Path, provider_responses: Vec<MockResponse>) -> Self {
        let provider = MockProvider::start_with_responses(home, provider_responses);
        let mut child = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
            .arg("--home")
            .arg(home)
            .args(["app-server", "--stdio"])
            .env_remove("SUGARCODE_HOME")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn app-server with provider responses");
        let stdin = child.stdin.take().expect("child stdin");
        let stdout = BufReader::new(child.stdout.take().expect("child stdout"));
        Self {
            child,
            stdin,
            stdout,
            provider,
            expects_sandbox_unavailable: false,
        }
    }

    pub(super) fn send(&mut self, message: Value, output_lines: usize) -> Vec<Value> {
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

    pub(super) fn initialize(&mut self) {
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

    pub(super) fn provider_requests(&self) -> Vec<Value> {
        self.provider.requests()
    }

    pub(super) fn finish(self) {
        let expects_sandbox_unavailable = self.expects_sandbox_unavailable;
        let stderr = self.finish_with_diagnostics();
        let expected = if expects_sandbox_unavailable {
            "sugarcode: shell/exec unavailable: sandboxUnavailable\n"
        } else {
            ""
        };
        assert_eq!(stderr, expected, "unexpected diagnostics");
    }

    pub(super) fn finish_with_diagnostics(mut self) -> String {
        drop(self.stdin);
        self.provider.stop();
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

pub(super) struct MockProvider {
    address: std::net::SocketAddr,
    stop: Arc<AtomicBool>,
    requests: Arc<Mutex<Vec<Value>>>,
    thread: Option<JoinHandle<()>>,
}

#[derive(Clone, Copy)]
pub(super) enum MockResponse {
    Complete(&'static str),
    HoldOpen(&'static str),
}

impl MockProvider {
    pub(super) fn start(home: &Path) -> Self {
        Self::start_inner(home, None)
    }

    pub(super) fn start_with_bodies(home: &Path, bodies: Vec<&'static str>) -> Self {
        Self::start_with_responses(
            home,
            bodies.into_iter().map(MockResponse::Complete).collect(),
        )
    }

    pub(super) fn start_with_responses(home: &Path, responses: Vec<MockResponse>) -> Self {
        Self::start_inner(home, Some(VecDeque::from(responses)))
    }

    pub(super) fn start_inner(home: &Path, responses: Option<VecDeque<MockResponse>>) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind mock provider");
        let address = listener.local_addr().expect("mock provider address");
        configure_model(home, address);
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let thread_stop = stop.clone();
        let thread_requests = requests.clone();
        let mut responses = responses;
        let thread = thread::spawn(move || {
            while !thread_stop.load(Ordering::Acquire) {
                let (mut stream, _) = listener.accept().expect("accept provider request");
                if thread_stop.load(Ordering::Acquire) {
                    break;
                }
                let response = responses.as_mut().map_or_else(
                    || {
                        MockResponse::Complete(include_str!(
                            "../../../model-provider/tests/fixtures/completed.sse"
                        ))
                    },
                    |responses| responses.pop_front().expect("recorded provider response"),
                );
                let request = read_recorded_request(&mut stream);
                thread_requests.lock().expect("request lock").push(request);
                match response {
                    MockResponse::Complete(body) => {
                        write_recorded_response(&mut stream, body);
                    }
                    MockResponse::HoldOpen(body) => {
                        write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: keep-alive\r\n\r\n{body}"
                        )
                        .expect("write held provider response");
                        stream.flush().expect("flush held provider response");
                        while !thread_stop.load(Ordering::Acquire) {
                            thread::sleep(std::time::Duration::from_millis(10));
                        }
                    }
                }
            }
        });
        Self {
            address,
            stop,
            requests,
            thread: Some(thread),
        }
    }

    pub(super) fn requests(&self) -> Vec<Value> {
        self.requests.lock().expect("request lock").clone()
    }

    pub(super) fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        let _ = TcpStream::connect(self.address);
    }
}

pub(super) fn configure_model(home: &Path, address: std::net::SocketAddr) {
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
                "apiFormat": "openai-chat-completions",
                "endpoint": format!("http://{address}/v1/chat/completions"),
                "model": "fixture-model",
                "credentialReference": null
            }
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
        self.stop();
        if let Some(thread) = self.thread.take() {
            thread.join().expect("join mock provider");
        }
    }
}

pub(super) fn read_recorded_request(stream: &mut TcpStream) -> Value {
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
    assert!(content_length <= 4 * 1024 * 1024);
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
    for forbidden in ["response_format", "modalities", "audio"] {
        assert!(request_body.get(forbidden).is_none(), "{forbidden}");
    }
    request_body
}

pub(super) fn write_recorded_response(stream: &mut TcpStream, body: &str) {
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
    .expect("write provider response");
    stream.flush().expect("flush provider response");
}

pub(super) fn assert_deleted_views(server: &mut RunningServer, request_prefix: &str) {
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

pub(super) fn assert_active_archive_views(server: &mut RunningServer, request_prefix: &str) {
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

pub(super) fn provider_messages_after_base_agent(request: &Value) -> &[Value] {
    let messages = request["messages"].as_array().expect("provider messages");
    let base = messages.first().expect("built-in base agent message");
    assert_eq!(base["role"], "developer");
    let content = base["content"]
        .as_str()
        .expect("built-in base agent content");
    assert!(content.starts_with("You are SugarCode, a coding agent"));
    for section in [
        "# Instruction authority",
        "# Autonomy and completion",
        "# Tool protocol and boundaries",
        "# Engineering workflow",
        "# Final response",
    ] {
        assert!(
            content.contains(section),
            "built-in base agent prompt missing {section}"
        );
    }
    &messages[1..]
}
