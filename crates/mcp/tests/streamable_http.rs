use serde_json::Value;
use serde_json::json;
use std::sync::Arc;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn loopback_streamable_http_completes_json_sse_session_discovery_and_call() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let (endpoint, server) = start_fixture(Arc::clone(&requests), FixtureMode::Success).await;
    let spec = sugarcode_mcp::LoopbackStreamableHttpServerSpec::new("fixture".to_owned(), endpoint)
        .expect("spec");

    let inventory = sugarcode_mcp::discover_loopback_streamable_http(&spec)
        .await
        .expect("discovery");
    assert_eq!(inventory.server_id(), "fixture");
    assert_eq!(inventory.tools()[0].name(), "inspect");
    let prepared =
        sugarcode_mcp::prepare_call(&inventory, "mcp__fixture__inspect", json!({"value": 7}))
            .expect("prepare");
    let result = sugarcode_mcp::call_loopback_streamable_http(
        &spec,
        &inventory,
        &prepared,
        CancellationToken::new(),
    )
    .await;
    assert!(
        matches!(
            result,
            sugarcode_mcp::McpCallOutcome::Completed(ref result)
                if result.content().contains("called") && !result.is_error()
        ),
        "{result:?}"
    );
    server.await.expect("fixture");

    let requests = requests.lock().await;
    assert_eq!(requests.len(), 9);
    assert!(
        requests.iter().all(|request| {
            request.request_target == "/mcp"
                && !request.authorization
                && !request.cookie
                && !request.proxy_authorization
        }),
        "HTTP MCP must use origin-form loopback requests without ambient credentials"
    );
    assert_eq!(requests[0].http_method, "POST");
    assert_eq!(requests[0].rpc_method.as_deref(), Some("initialize"));
    assert!(requests[0].session_id.is_none());
    assert!(requests[0].protocol_version.is_none());
    assert_eq!(
        requests[1].rpc_method.as_deref(),
        Some("notifications/initialized")
    );
    assert_eq!(requests[1].session_id.as_deref(), Some("session-1"));
    assert_eq!(
        requests[1].protocol_version.as_deref(),
        Some(sugarcode_mcp::MCP_PROTOCOL_VERSION)
    );
    assert_eq!(requests[3].http_method, "DELETE");
    assert_eq!(requests[3].session_id.as_deref(), Some("session-1"));
    assert_eq!(requests[4].rpc_method.as_deref(), Some("initialize"));
    assert!(requests[4].session_id.is_none());
    assert!(requests[4].protocol_version.is_none());
    assert_eq!(requests[6].rpc_method.as_deref(), Some("tools/list"));
    assert_eq!(requests[7].rpc_method.as_deref(), Some("tools/call"));
    assert_eq!(requests[7].session_id.as_deref(), Some("session-2"));
    assert_eq!(requests[8].http_method, "DELETE");
}

#[tokio::test]
async fn loopback_streamable_http_fails_closed_on_bad_status_content_type_and_sse() {
    for (mode, expected) in [
        (
            FixtureMode::Redirect,
            sugarcode_mcp::DiscoveryErrorKind::HttpStatus,
        ),
        (
            FixtureMode::BadContentType,
            sugarcode_mcp::DiscoveryErrorKind::InvalidContentType,
        ),
        (
            FixtureMode::TruncatedSse,
            sugarcode_mcp::DiscoveryErrorKind::InvalidSse,
        ),
        (
            FixtureMode::LegacyEndpointEvent,
            sugarcode_mcp::DiscoveryErrorKind::InvalidSse,
        ),
        (
            FixtureMode::InvalidSession,
            sugarcode_mcp::DiscoveryErrorKind::InvalidSession,
        ),
    ] {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (endpoint, server) = start_fixture(Arc::clone(&requests), mode).await;
        let spec =
            sugarcode_mcp::LoopbackStreamableHttpServerSpec::new("fixture".to_owned(), endpoint)
                .expect("spec");
        let error = sugarcode_mcp::discover_loopback_streamable_http(&spec)
            .await
            .expect_err("discovery must fail");
        assert_eq!(error.kind(), expected, "{mode:?}");
        server.await.expect("fixture");
        assert_eq!(requests.lock().await.len(), 1, "{mode:?}");
    }
}

#[tokio::test]
async fn loopback_streamable_http_session_expiration_is_stable_and_not_retried() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let (endpoint, server) =
        start_fixture(Arc::clone(&requests), FixtureMode::SessionExpired).await;
    let spec = sugarcode_mcp::LoopbackStreamableHttpServerSpec::new("fixture".to_owned(), endpoint)
        .expect("spec");
    let error = sugarcode_mcp::discover_loopback_streamable_http(&spec)
        .await
        .expect_err("expired session");
    assert_eq!(
        error.kind(),
        sugarcode_mcp::DiscoveryErrorKind::SessionExpired
    );
    server.await.expect("fixture");
    let requests = requests.lock().await;
    assert_eq!(requests.len(), 3);
    assert_eq!(
        requests[1].rpc_method.as_deref(),
        Some("notifications/initialized")
    );
    assert_eq!(requests[2].http_method, "DELETE");
}

#[tokio::test]
async fn loopback_streamable_http_revalidates_inventory_without_call_fallback() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let (endpoint, server) = start_fixture(Arc::clone(&requests), FixtureMode::Drift).await;
    let spec = sugarcode_mcp::LoopbackStreamableHttpServerSpec::new("fixture".to_owned(), endpoint)
        .expect("spec");
    let inventory = sugarcode_mcp::discover_loopback_streamable_http(&spec)
        .await
        .expect("discovery");
    let prepared =
        sugarcode_mcp::prepare_call(&inventory, "mcp__fixture__inspect", json!({"value": 7}))
            .expect("prepare");
    let outcome = sugarcode_mcp::call_loopback_streamable_http(
        &spec,
        &inventory,
        &prepared,
        CancellationToken::new(),
    )
    .await;
    assert!(
        matches!(
            outcome,
            sugarcode_mcp::McpCallOutcome::Error {
                kind: sugarcode_mcp::McpCallErrorKind::InventoryDrift,
                request_state: sugarcode_mcp::McpCallRequestState::NotSent,
            }
        ),
        "{outcome:?}"
    );
    server.await.expect("fixture");
    let requests = requests.lock().await;
    assert_eq!(requests.len(), 8);
    assert!(
        requests
            .iter()
            .all(|request| request.rpc_method.as_deref() != Some("tools/call"))
    );
}

#[tokio::test]
async fn loopback_streamable_http_cancellation_is_correlated_and_cleans_up_session() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let (endpoint, server) = start_fixture(Arc::clone(&requests), FixtureMode::Cancel).await;
    let spec = sugarcode_mcp::LoopbackStreamableHttpServerSpec::new("fixture".to_owned(), endpoint)
        .expect("spec");
    let inventory = sugarcode_mcp::discover_loopback_streamable_http(&spec)
        .await
        .expect("discovery");
    let prepared =
        sugarcode_mcp::prepare_call(&inventory, "mcp__fixture__inspect", json!({"value": 7}))
            .expect("prepare");
    let cancellation = CancellationToken::new();
    let task = tokio::spawn({
        let spec = spec.clone();
        let inventory = inventory.clone();
        let prepared = prepared.clone();
        let cancellation = cancellation.clone();
        async move {
            sugarcode_mcp::call_loopback_streamable_http(&spec, &inventory, &prepared, cancellation)
                .await
        }
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if requests.lock().await.len() >= 8 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("tools/call reaches fixture");
    cancellation.cancel();
    let outcome = task.await.expect("call task");
    assert!(
        matches!(
            outcome,
            sugarcode_mcp::McpCallOutcome::Error {
                kind: sugarcode_mcp::McpCallErrorKind::Cancelled,
                request_state: sugarcode_mcp::McpCallRequestState::MayHaveStarted,
            }
        ),
        "{outcome:?}"
    );
    server.await.expect("fixture");
    let requests = requests.lock().await;
    assert_eq!(requests.len(), 10);
    assert_eq!(
        requests[8].rpc_method.as_deref(),
        Some("notifications/cancelled")
    );
    assert_eq!(requests[9].http_method, "DELETE");
}

#[test]
fn loopback_streamable_http_spec_rejects_non_literal_or_ambient_authority() {
    for endpoint in [
        "https://127.0.0.1:443/mcp",
        "http://localhost:43123/mcp",
        "http://127.0.0.2:43123/mcp",
        "http://127.1:43123/mcp",
        "http://[::ffff:127.0.0.1]:43123/mcp",
        "http://127.0.0.1/mcp",
        "http://127.0.0.1:43123/",
        "http://127.0.0.1:43123/mcp?secret=x",
        "http://user@127.0.0.1:43123/mcp",
    ] {
        assert!(
            sugarcode_mcp::LoopbackStreamableHttpServerSpec::new(
                "fixture".to_owned(),
                endpoint.to_owned()
            )
            .is_err(),
            "{endpoint}"
        );
    }
}

#[derive(Debug, Clone, Copy)]
enum FixtureMode {
    Success,
    Redirect,
    BadContentType,
    TruncatedSse,
    LegacyEndpointEvent,
    InvalidSession,
    SessionExpired,
    Drift,
    Cancel,
}

#[derive(Debug)]
struct CapturedRequest {
    http_method: String,
    request_target: String,
    rpc_method: Option<String>,
    session_id: Option<String>,
    protocol_version: Option<String>,
    authorization: bool,
    cookie: bool,
    proxy_authorization: bool,
}

async fn start_fixture(
    requests: Arc<Mutex<Vec<CapturedRequest>>>,
    mode: FixtureMode,
) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address = listener.local_addr().expect("address");
    let expected_requests = match mode {
        FixtureMode::Success => 9,
        FixtureMode::Drift => 8,
        FixtureMode::Cancel => 10,
        FixtureMode::SessionExpired => 3,
        _ => 1,
    };
    let server = tokio::spawn(async move {
        for index in 0..expected_requests {
            let (mut stream, _) = listener.accept().await.expect("accept");
            let request = read_request(&mut stream).await;
            requests.lock().await.push(request);
            if matches!(mode, FixtureMode::Cancel) && index == 7 {
                tokio::spawn(async move {
                    let mut buffer = [0_u8; 64];
                    while stream.read(&mut buffer).await.unwrap_or(0) != 0 {}
                });
                continue;
            }
            let response = fixture_response(mode, index);
            stream.write_all(&response).await.expect("response");
            stream.shutdown().await.expect("shutdown");
        }
    });
    (format!("http://{address}/mcp"), server)
}

fn fixture_response(mode: FixtureMode, index: usize) -> Vec<u8> {
    if index == 0 {
        match mode {
            FixtureMode::Redirect => {
                return response("302 Found", &[("Location", "http://127.0.0.1:9/mcp")], b"");
            }
            FixtureMode::BadContentType => {
                return response("200 OK", &[("Content-Type", "text/plain")], b"invalid");
            }
            FixtureMode::TruncatedSse => {
                return response(
                    "200 OK",
                    &[("Content-Type", "text/event-stream")],
                    b"data: {\"jsonrpc\":\"2.0\",\"id\":1",
                );
            }
            FixtureMode::LegacyEndpointEvent => {
                return response(
                    "200 OK",
                    &[("Content-Type", "text/event-stream")],
                    b"event: endpoint\ndata: /messages\n\n",
                );
            }
            FixtureMode::InvalidSession => {
                return response(
                    "200 OK",
                    &[
                        ("Content-Type", "application/json"),
                        ("Mcp-Session-Id", "one"),
                        ("Mcp-Session-Id", "two"),
                    ],
                    &serde_json::to_vec(&initialize_response()).expect("JSON"),
                );
            }
            FixtureMode::Success => {}
            FixtureMode::Drift => {}
            FixtureMode::Cancel => {}
            FixtureMode::SessionExpired => {}
        }
    }
    match index {
        0 => response(
            "200 OK",
            &[
                ("Content-Type", "application/json"),
                ("Mcp-Session-Id", "session-1"),
            ],
            &serde_json::to_vec(&initialize_response()).expect("JSON"),
        ),
        1 if matches!(mode, FixtureMode::SessionExpired) => response("404 Not Found", &[], b""),
        1 | 5 => response("202 Accepted", &[], b""),
        2 if matches!(mode, FixtureMode::SessionExpired) => response("200 OK", &[], b""),
        2 => sse_response(&tools_list_response()),
        3 => response("200 OK", &[], b""),
        8 if matches!(mode, FixtureMode::Cancel) => response("202 Accepted", &[], b""),
        8 => response("200 OK", &[], b""),
        9 if matches!(mode, FixtureMode::Cancel) => response("200 OK", &[], b""),
        4 => {
            let data = sse_body(&initialize_response());
            response(
                "200 OK",
                &[
                    ("Content-Type", "text/event-stream; charset=utf-8"),
                    ("Mcp-Session-Id", "session-2"),
                ],
                data.as_bytes(),
            )
        }
        6 => {
            let list = if matches!(mode, FixtureMode::Drift) {
                tools_list_response_with_name("changed")
            } else {
                tools_list_response()
            };
            response(
                "200 OK",
                &[("Content-Type", "application/json; charset=utf-8")],
                &serde_json::to_vec(&list).expect("JSON"),
            )
        }
        7 if matches!(mode, FixtureMode::Drift) => response("200 OK", &[], b""),
        7 => sse_response(&json!({
            "jsonrpc": "2.0",
            "id": 3,
            "result": {
                "content": [{"type": "text", "text": "called"}],
                "structuredContent": {"ok": true},
                "isError": false
            }
        })),
        _ => unreachable!(),
    }
}

fn initialize_response() -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
            "protocolVersion": sugarcode_mcp::MCP_PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "http-fixture", "version": "1.0.0"}
        }
    })
}

fn tools_list_response() -> Value {
    tools_list_response_with_name("inspect")
}

fn tools_list_response_with_name(name: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 2,
        "result": {
            "tools": [{
                "name": name,
                "description": "inspect",
                "inputSchema": {
                    "type": "object",
                    "properties": {"value": {"type": "integer"}},
                    "required": ["value"],
                    "additionalProperties": false
                },
                "outputSchema": {
                    "type": "object",
                    "properties": {"ok": {"type": "boolean"}},
                    "required": ["ok"],
                    "additionalProperties": false
                }
            }]
        }
    })
}

fn sse_response(value: &Value) -> Vec<u8> {
    let body = sse_body(value);
    response(
        "200 OK",
        &[("Content-Type", "text/event-stream")],
        body.as_bytes(),
    )
}

fn sse_body(value: &Value) -> String {
    format!("event: message\ndata: {value}\n\n")
}

fn response(status: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
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

async fn read_request(stream: &mut tokio::net::TcpStream) -> CapturedRequest {
    let mut bytes = Vec::new();
    let header_end = loop {
        let mut chunk = [0_u8; 1024];
        let read = stream.read(&mut chunk).await.expect("read");
        assert_ne!(read, 0, "request EOF");
        bytes.extend_from_slice(&chunk[..read]);
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let headers = std::str::from_utf8(&bytes[..header_end]).expect("headers");
    let mut lines = headers.split("\r\n");
    let request_line = lines.next().expect("request line");
    let mut request_parts = request_line.split_whitespace();
    let http_method = request_parts.next().expect("method").to_owned();
    let request_target = request_parts.next().expect("target").to_owned();
    let mut content_length = 0_usize;
    let mut session_id = None;
    let mut protocol_version = None;
    let mut authorization = false;
    let mut cookie = false;
    let mut proxy_authorization = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        match name.to_ascii_lowercase().as_str() {
            "content-length" => content_length = value.trim().parse().expect("length"),
            "mcp-session-id" => session_id = Some(value.trim().to_owned()),
            "mcp-protocol-version" => protocol_version = Some(value.trim().to_owned()),
            "authorization" => authorization = true,
            "cookie" => cookie = true,
            "proxy-authorization" => proxy_authorization = true,
            _ => {}
        }
    }
    while bytes.len() < header_end + content_length {
        let mut chunk = [0_u8; 1024];
        let read = stream.read(&mut chunk).await.expect("body");
        assert_ne!(read, 0, "body EOF");
        bytes.extend_from_slice(&chunk[..read]);
    }
    let body = &bytes[header_end..header_end + content_length];
    let rpc_method = if body.is_empty() {
        None
    } else {
        serde_json::from_slice::<Value>(body)
            .expect("request JSON")
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    CapturedRequest {
        http_method,
        request_target,
        rpc_method,
        session_id,
        protocol_version,
        authorization,
        cookie,
        proxy_authorization,
    }
}
