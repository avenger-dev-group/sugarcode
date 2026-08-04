use super::*;

pub(super) struct RunningServer {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    provider: MockProvider,
    expects_sandbox_unavailable: bool,
    ids: IdNormalizer,
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
            ids: IdNormalizer::from_home(home),
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
            ids: IdNormalizer::from_home(home),
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
            ids: IdNormalizer::from_home(home),
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
            ids: IdNormalizer::from_home(home),
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
            ids: IdNormalizer::from_home(home),
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
            ids: IdNormalizer::from_home(home),
        }
    }

    pub(super) fn send(&mut self, mut message: Value, output_lines: usize) -> Vec<Value> {
        self.ids.resolve_request(&mut message);
        writeln!(self.stdin, "{message}").expect("write request");
        self.stdin.flush().expect("flush request");
        (0..output_lines)
            .map(|_| {
                loop {
                    let mut line = String::new();
                    let bytes = self.stdout.read_line(&mut line).expect("read response");
                    assert!(bytes > 0, "app-server closed before expected response");
                    let value = serde_json::from_str::<Value>(&line).expect("response JSON");
                    if !is_transient_notification(&value) {
                        break self.ids.normalize_response(value);
                    }
                }
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
        assert!(
            remaining_stdout.lines().all(|line| {
                serde_json::from_str::<Value>(line)
                    .is_ok_and(|value| is_transient_notification(&value))
            }),
            "unexpected protocol output"
        );
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

pub(super) fn rollout_path(home: &Path, ordinal: usize) -> std::path::PathBuf {
    assert!(ordinal > 0, "rollout ordinal is one-based");
    let mut paths = fs::read_dir(home.join("rollouts/v1"))
        .expect("rollout directory")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "jsonl")
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths
        .get(ordinal - 1)
        .cloned()
        .unwrap_or_else(|| panic!("missing rollout at ordinal {ordinal}"))
}

#[derive(Clone, Copy)]
enum IdKind {
    Thread,
    Turn,
    Item,
}

#[derive(Default)]
struct IdNormalizer {
    thread_actual_to_fixed: BTreeMap<String, String>,
    thread_fixed_to_actual: BTreeMap<String, String>,
    turn_actual_to_fixed: BTreeMap<String, String>,
    turn_fixed_to_actual: BTreeMap<String, String>,
    item_actual_to_fixed: BTreeMap<String, String>,
    item_fixed_to_actual: BTreeMap<String, String>,
}

impl IdNormalizer {
    fn from_home(home: &Path) -> Self {
        let mut collected = CollectedIds::default();
        let rollouts = home.join("rollouts/v1");
        if let Ok(entries) = fs::read_dir(rollouts) {
            for entry in entries.flatten() {
                let Ok(contents) = fs::read_to_string(entry.path()) else {
                    continue;
                };
                for line in contents.lines() {
                    if let Ok(value) = serde_json::from_str::<Value>(line) {
                        collect_structured_ids(&value, None, &mut collected);
                    }
                }
            }
        }
        let mut normalizer = Self::default();
        for id in collected.threads {
            normalizer.learn(IdKind::Thread, &id);
        }
        for id in collected.turns {
            normalizer.learn(IdKind::Turn, &id);
        }
        for id in collected.items {
            normalizer.learn(IdKind::Item, &id);
        }
        normalizer
    }

    fn resolve_request(&self, value: &mut Value) {
        replace_id_strings(value, &self.thread_fixed_to_actual);
        replace_id_strings(value, &self.turn_fixed_to_actual);
        replace_id_strings(value, &self.item_fixed_to_actual);
    }

    fn normalize_response(&mut self, mut value: Value) -> Value {
        self.discover(&value, None);
        replace_id_strings(&mut value, &self.thread_actual_to_fixed);
        replace_id_strings(&mut value, &self.turn_actual_to_fixed);
        replace_id_strings(&mut value, &self.item_actual_to_fixed);
        remove_workspace_ids(&mut value);
        value
    }

    fn discover(&mut self, value: &Value, context: Option<IdKind>) {
        match value {
            Value::Array(values) => {
                for value in values {
                    self.discover(value, context);
                }
            }
            Value::Object(values) => {
                if let Some(kind) = context
                    && let Some(id) = values.get("id").and_then(Value::as_str)
                {
                    self.learn(kind, id);
                } else if let Some(id) = values.get("id").and_then(Value::as_str) {
                    let kind = if values.contains_key("workspaceId") {
                        Some(IdKind::Thread)
                    } else if values.contains_key("status") {
                        Some(IdKind::Turn)
                    } else if values.contains_key("type") {
                        Some(IdKind::Item)
                    } else {
                        None
                    };
                    if let Some(kind) = kind {
                        self.learn(kind, id);
                    }
                }
                for (key, value) in values {
                    match key.as_str() {
                        "threadId" | "parentThreadId" => {
                            if let Some(id) = value.as_str() {
                                self.learn(IdKind::Thread, id);
                            }
                        }
                        "turnId" | "parentTurnId" | "throughTurnId" => {
                            if let Some(id) = value.as_str() {
                                self.learn(IdKind::Turn, id);
                            }
                        }
                        "itemId" => {
                            if let Some(id) = value.as_str() {
                                self.learn(IdKind::Item, id);
                            }
                        }
                        "thread" => self.discover(value, Some(IdKind::Thread)),
                        "turn" => self.discover(value, Some(IdKind::Turn)),
                        "item" => self.discover(value, Some(IdKind::Item)),
                        "turns" => self.discover(value, Some(IdKind::Turn)),
                        "items" => self.discover(value, Some(IdKind::Item)),
                        _ => self.discover(value, None),
                    }
                }
            }
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
        }
    }

    fn learn(&mut self, kind: IdKind, actual: &str) {
        if !is_uuid_v7(actual) {
            return;
        }
        let (actual_to_fixed, fixed_to_actual, group) = match kind {
            IdKind::Thread => (
                &mut self.thread_actual_to_fixed,
                &mut self.thread_fixed_to_actual,
                0,
            ),
            IdKind::Turn => (
                &mut self.turn_actual_to_fixed,
                &mut self.turn_fixed_to_actual,
                1,
            ),
            IdKind::Item => (
                &mut self.item_actual_to_fixed,
                &mut self.item_fixed_to_actual,
                2,
            ),
        };
        if actual_to_fixed.contains_key(actual) {
            return;
        }
        let fixed = format!(
            "00000000-{group:04}-7000-8000-{:012}",
            actual_to_fixed.len() + 1
        );
        actual_to_fixed.insert(actual.to_string(), fixed.clone());
        fixed_to_actual.insert(fixed, actual.to_string());
    }
}

#[derive(Default)]
struct CollectedIds {
    threads: BTreeSet<String>,
    turns: BTreeSet<String>,
    items: BTreeSet<String>,
}

fn collect_structured_ids(value: &Value, context: Option<IdKind>, ids: &mut CollectedIds) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_structured_ids(value, context, ids);
            }
        }
        Value::Object(values) => {
            if let Some(kind) = context
                && let Some(id) = values.get("id").and_then(Value::as_str)
            {
                collect_id(kind, id, ids);
            }
            for (key, value) in values {
                match key.as_str() {
                    "threadId" | "parentThreadId" => {
                        if let Some(id) = value.as_str() {
                            collect_id(IdKind::Thread, id, ids);
                        }
                    }
                    "turnId" | "parentTurnId" | "throughTurnId" => {
                        if let Some(id) = value.as_str() {
                            collect_id(IdKind::Turn, id, ids);
                        }
                    }
                    "itemId" => {
                        if let Some(id) = value.as_str() {
                            collect_id(IdKind::Item, id, ids);
                        }
                    }
                    "thread" => collect_structured_ids(value, Some(IdKind::Thread), ids),
                    "turn" => collect_structured_ids(value, Some(IdKind::Turn), ids),
                    "item" => collect_structured_ids(value, Some(IdKind::Item), ids),
                    "turns" => collect_structured_ids(value, Some(IdKind::Turn), ids),
                    "items" => collect_structured_ids(value, Some(IdKind::Item), ids),
                    _ => collect_structured_ids(value, None, ids),
                }
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}

fn collect_id(kind: IdKind, id: &str, ids: &mut CollectedIds) {
    if !is_uuid_v7(id) {
        return;
    }
    match kind {
        IdKind::Thread => &mut ids.threads,
        IdKind::Turn => &mut ids.turns,
        IdKind::Item => &mut ids.items,
    }
    .insert(id.to_string());
}

fn replace_id_strings(value: &mut Value, replacements: &BTreeMap<String, String>) {
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
                replace_id_strings(value, replacements);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                replace_id_strings(value, replacements);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn remove_workspace_ids(value: &mut Value) {
    match value {
        Value::Array(values) => {
            for value in values {
                remove_workspace_ids(value);
            }
        }
        Value::Object(values) => {
            values.remove("workspaceId");
            for value in values.values_mut() {
                remove_workspace_ids(value);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}

fn is_uuid_v7(value: &str) -> bool {
    value.len() == 36
        && value.as_bytes().get(14) == Some(&b'7')
        && matches!(value.as_bytes().get(19), Some(b'8' | b'9' | b'a' | b'b'))
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
        })
}

fn is_transient_notification(value: &Value) -> bool {
    matches!(
        value.get("method").and_then(Value::as_str),
        Some("turn/agentOutput/delta" | "thread/tokenUsage/updated")
    )
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
                let Some(request) = read_recorded_request(&mut stream) else {
                    continue;
                };
                let response = responses.as_mut().map_or_else(
                    || {
                        MockResponse::Complete(include_str!(
                            "../../../model-provider/tests/fixtures/completed.sse"
                        ))
                    },
                    |responses| responses.pop_front().expect("recorded provider response"),
                );
                thread_requests.lock().expect("request lock").push(request);
                match response {
                    MockResponse::Complete(body) => {
                        write_recorded_response(&mut stream, body);
                    }
                    MockResponse::HoldOpen(body) => {
                        let write_result = write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: keep-alive\r\n\r\n{body}"
                        )
                        .and_then(|()| stream.flush());
                        if let Err(error) = write_result
                            && !matches!(
                                error.kind(),
                                std::io::ErrorKind::BrokenPipe
                                    | std::io::ErrorKind::ConnectionReset
                                    | std::io::ErrorKind::ConnectionAborted
                            )
                        {
                            panic!("write held provider response: {error}");
                        }
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

impl Drop for MockProvider {
    fn drop(&mut self) {
        self.stop();
        if let Some(thread) = self.thread.take() {
            thread.join().expect("join mock provider");
        }
    }
}

pub(super) fn read_recorded_request(stream: &mut TcpStream) -> Option<Value> {
    let mut request = Vec::new();
    let mut buffer = [0u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut buffer).expect("read provider request");
        if read == 0 && request.is_empty() {
            return None;
        }
        assert!(read > 0, "provider request ended during headers");
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
    for forbidden in ["stream_options", "response_format", "modalities", "audio"] {
        assert!(request_body.get(forbidden).is_none(), "{forbidden}");
    }
    Some(request_body)
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
        json!([{"id": "00000000-0000-7000-8000-000000000003"}])
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
        json!([{"id": "00000000-0000-7000-8000-000000000003"}])
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
            {"id": "00000000-0000-7000-8000-000000000003"},
            {"id": "00000000-0000-7000-8000-000000000001"}
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
        json!([{"id": "00000000-0000-7000-8000-000000000001"}])
    );
    let resume_archived = server.send(
        json!({
            "jsonrpc": "2.0",
            "id": format!("{request_prefix}-resume-archived"),
            "method": "thread/resume",
            "params": {"threadId": "00000000-0000-7000-8000-000000000002"}
        }),
        1,
    );
    assert_eq!(resume_archived[0]["error"]["code"], -32004);
    assert_eq!(
        resume_archived[0]["error"]["data"],
        json!({"threadId": "00000000-0000-7000-8000-000000000002"})
    );
}

pub(super) fn provider_system_instruction(request: &Value) -> &str {
    let messages = request["messages"].as_array().expect("provider messages");
    let base = messages.first().expect("built-in base agent message");
    assert_eq!(base["role"], "system");
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
    content
}

pub(super) fn provider_messages_after_base_agent(request: &Value) -> &[Value] {
    provider_system_instruction(request);
    let messages = request["messages"].as_array().expect("provider messages");
    &messages[1..]
}
