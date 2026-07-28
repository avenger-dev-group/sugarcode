use serde_json::Value;
use serde_json::json;
use std::io::BufRead;
use std::io::Write;
use sugarcode_mcp::McpCallErrorKind;
use sugarcode_mcp::McpCallOutcome;
use sugarcode_mcp::McpCallRequestState;
use sugarcode_mcp::StdioServerSpec;
use tokio_util::sync::CancellationToken;

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.get(1).map(String::as_str) == Some("--fixture-server") {
        fixture_server(
            args.get(2).map(String::as_str).unwrap_or("ok"),
            args.get(3).map(String::as_str),
        );
        return;
    }
    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    runtime.block_on(async {
        real_call_reconnects_validates_and_normalizes().await;
        inventory_drift_never_sends_tools_call().await;
        cancellation_after_request_is_correlated_and_reaped().await;
        arguments_and_result_shapes_fail_closed().await;
        result_and_transport_failure_matrix_is_correlated().await;
    });
}

async fn real_call_reconnects_validates_and_normalizes() {
    let inventory = sugarcode_mcp::discover_stdio(&fixture_spec("ok", None))
        .await
        .expect("discover");
    let callable = inventory.callable_name("inspect").expect("callable");
    let prepared = sugarcode_mcp::prepare_call(
        &inventory,
        &callable,
        json!({"nested": {"z": 1, "a": true}}),
    )
    .expect("prepare");
    assert_eq!(
        prepared.arguments(),
        &json!({"nested": {"a": true, "z": 1}})
    );
    let outcome = sugarcode_mcp::call_stdio(
        &fixture_spec("ok", None),
        &inventory,
        &prepared,
        CancellationToken::new(),
    )
    .await;
    let McpCallOutcome::Completed(result) = outcome else {
        panic!("completed result");
    };
    assert!(!result.is_error());
    assert_eq!(
        serde_json::from_str::<Value>(result.content()).expect("normalized"),
        json!({
            "isError": false,
            "structuredContent": {"ok": true},
            "text": ["called"]
        })
    );
    assert_eq!(result.content_blocks(), 1);
    assert!(result.has_structured_content());
    assert_eq!(result.sha256().len(), 64);
}

async fn inventory_drift_never_sends_tools_call() {
    let marker = tempfile::NamedTempFile::new().expect("marker");
    let inventory = sugarcode_mcp::discover_stdio(&fixture_spec("ok", None))
        .await
        .expect("discover");
    let callable = inventory.callable_name("inspect").expect("callable");
    let prepared = sugarcode_mcp::prepare_call(&inventory, &callable, json!({})).expect("prepare");
    let outcome = sugarcode_mcp::call_stdio(
        &fixture_spec("drift", marker.path().to_str()),
        &inventory,
        &prepared,
        CancellationToken::new(),
    )
    .await;
    assert!(matches!(
        outcome,
        McpCallOutcome::Error {
            kind: McpCallErrorKind::InventoryDrift,
            request_state: McpCallRequestState::NotSent,
        }
    ));
    assert!(std::fs::read(marker.path()).expect("marker").is_empty());
}

async fn cancellation_after_request_is_correlated_and_reaped() {
    let directory = tempfile::tempdir().expect("directory");
    let marker = directory.path().join("called");
    let inventory = sugarcode_mcp::discover_stdio(&fixture_spec("ok", None))
        .await
        .expect("discover");
    let callable = inventory.callable_name("inspect").expect("callable");
    let prepared = sugarcode_mcp::prepare_call(&inventory, &callable, json!({})).expect("prepare");
    let cancellation = CancellationToken::new();
    let task = tokio::spawn({
        let cancellation = cancellation.clone();
        let spec = fixture_spec("hang-call", marker.to_str());
        async move { sugarcode_mcp::call_stdio(&spec, &inventory, &prepared, cancellation).await }
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !marker.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("call marker");
    cancellation.cancel();
    assert!(matches!(
        task.await.expect("call task"),
        McpCallOutcome::Error {
            kind: McpCallErrorKind::Cancelled,
            request_state: McpCallRequestState::MayHaveStarted,
        }
    ));
}

async fn arguments_and_result_shapes_fail_closed() {
    let inventory = sugarcode_mcp::discover_stdio(&fixture_spec("ok", None))
        .await
        .expect("discover");
    let callable = inventory.callable_name("inspect").expect("callable");
    assert_eq!(
        sugarcode_mcp::prepare_call(&inventory, &callable, json!({"nested": "wrong"}))
            .expect_err("schema mismatch"),
        McpCallErrorKind::InputSchemaMismatch
    );
    let prepared = sugarcode_mcp::prepare_call(&inventory, &callable, json!({})).expect("prepare");
    let outcome = sugarcode_mcp::call_stdio(
        &fixture_spec("image-result", None),
        &inventory,
        &prepared,
        CancellationToken::new(),
    )
    .await;
    assert!(matches!(
        outcome,
        McpCallOutcome::Error {
            kind: McpCallErrorKind::UnsupportedContent,
            request_state: McpCallRequestState::Responded,
        }
    ));
}

async fn result_and_transport_failure_matrix_is_correlated() {
    let inventory = sugarcode_mcp::discover_stdio(&fixture_spec("ok", None))
        .await
        .expect("discover");
    let callable = inventory.callable_name("inspect").expect("callable");
    let prepared = sugarcode_mcp::prepare_call(&inventory, &callable, json!({})).expect("prepare");

    let completed = sugarcode_mcp::call_stdio(
        &fixture_spec("is-error", None),
        &inventory,
        &prepared,
        CancellationToken::new(),
    )
    .await;
    assert!(matches!(
        completed,
        McpCallOutcome::Completed(result) if result.is_error()
    ));

    for (mode, expected_kind, expected_state) in [
        (
            "schema-mismatch",
            McpCallErrorKind::OutputSchemaMismatch,
            McpCallRequestState::Responded,
        ),
        (
            "invalid-shape",
            McpCallErrorKind::InvalidResult,
            McpCallRequestState::Responded,
        ),
        (
            "result-overflow",
            McpCallErrorKind::ResultTooLarge,
            McpCallRequestState::Responded,
        ),
        (
            "duplicate-result",
            McpCallErrorKind::InvalidJsonRpc,
            McpCallRequestState::MayHaveStarted,
        ),
        (
            "message-overflow",
            McpCallErrorKind::MessageTooLarge,
            McpCallRequestState::MayHaveStarted,
        ),
        (
            "stderr-overflow",
            McpCallErrorKind::StderrTooLarge,
            McpCallRequestState::MayHaveStarted,
        ),
        (
            "eof-after-call",
            McpCallErrorKind::UnexpectedEof,
            McpCallRequestState::MayHaveStarted,
        ),
    ] {
        let outcome = sugarcode_mcp::call_stdio(
            &fixture_spec(mode, None),
            &inventory,
            &prepared,
            CancellationToken::new(),
        )
        .await;
        assert!(
            matches!(
                outcome,
                McpCallOutcome::Error {
                    kind,
                    request_state,
                } if kind == expected_kind && request_state == expected_state
            ),
            "{mode}: {outcome:?}"
        );
    }
}

fn fixture_spec(mode: &str, marker: Option<&str>) -> StdioServerSpec {
    let mut argv = vec!["--fixture-server".to_owned(), mode.to_owned()];
    if let Some(marker) = marker {
        argv.push(marker.to_owned());
    }
    StdioServerSpec::new(
        "fixture".to_owned(),
        std::env::current_exe().expect("current executable"),
        argv,
        std::env::current_dir().expect("cwd"),
    )
}

fn fixture_server(mode: &str, marker: Option<&str>) {
    let mut input = std::io::BufReader::new(std::io::stdin().lock());
    let mut output = std::io::stdout().lock();
    assert_eq!(read_message(&mut input)["method"], "initialize");
    write_message(
        &mut output,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "protocolVersion": sugarcode_mcp::MCP_PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "tool-fixture", "version": "1.0.0"}
            }
        }),
    );
    assert_eq!(
        read_message(&mut input)["method"],
        "notifications/initialized"
    );
    assert_eq!(read_message(&mut input)["method"], "tools/list");
    let description = if mode == "drift" {
        "changed"
    } else {
        "inspect"
    };
    write_message(
        &mut output,
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "result": {
                "tools": [{
                    "name": "inspect",
                    "description": description,
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "nested": {
                                "type": "object",
                                "properties": {
                                    "a": {"type": "boolean"},
                                    "z": {"type": "integer"}
                                },
                                "required": ["a", "z"]
                            }
                        },
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
        }),
    );
    if mode == "drift" {
        if let Some(marker) = marker {
            let mut line = String::new();
            if input.read_line(&mut line).expect("EOF") != 0 {
                std::fs::write(marker, b"tools/call received").expect("marker");
            }
        }
        return;
    }
    let call = match read_optional_message(&mut input) {
        Some(call) => call,
        None => return,
    };
    assert_eq!(call["id"], 3);
    assert_eq!(call["method"], "tools/call");
    assert_eq!(call["params"]["name"], "inspect");
    if mode == "hang-call" {
        std::fs::write(marker.expect("marker"), b"called").expect("marker");
        let cancelled = read_message(&mut input);
        assert_eq!(cancelled["method"], "notifications/cancelled");
        wait_for_eof(&mut input);
        return;
    }
    if mode == "duplicate-result" {
        output
            .write_all(
                b"{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"content\":[],\"content\":[]}}\n",
            )
            .expect("duplicate result");
        output.flush().expect("flush");
        wait_for_eof(&mut input);
        return;
    }
    if mode == "message-overflow" {
        output
            .write_all(&vec![b'x'; sugarcode_mcp::MAX_MESSAGE_BYTES + 1])
            .expect("large message");
        output.write_all(b"\n").expect("newline");
        output.flush().expect("flush");
        wait_for_eof(&mut input);
        return;
    }
    if mode == "stderr-overflow" {
        let mut stderr = std::io::stderr().lock();
        stderr
            .write_all(&vec![b'e'; sugarcode_mcp::MAX_STDERR_BYTES + 1])
            .expect("large stderr");
        stderr.flush().expect("flush stderr");
        wait_for_eof(&mut input);
        return;
    }
    if mode == "eof-after-call" {
        return;
    }
    let content = if mode == "image-result" {
        json!([{"type": "image", "data": "AAAA", "mimeType": "image/png"}])
    } else if mode == "invalid-shape" {
        json!([{"type": "text", "text": 7}])
    } else {
        json!([{"type": "text", "text": "called"}])
    };
    let structured_content = match mode {
        "schema-mismatch" => json!({"ok": "wrong"}),
        "result-overflow" => json!({"ok": true, "padding": "x".repeat(
            sugarcode_mcp::MAX_STRUCTURED_RESULT_BYTES
        )}),
        _ => json!({"ok": true}),
    };
    write_message(
        &mut output,
        &json!({
            "jsonrpc": "2.0",
            "id": 3,
            "result": {
                "content": content,
                "structuredContent": structured_content,
                "isError": mode == "is-error"
            }
        }),
    );
    wait_for_eof(&mut input);
}

fn read_message(input: &mut impl BufRead) -> Value {
    read_optional_message(input).expect("message")
}

fn read_optional_message(input: &mut impl BufRead) -> Option<Value> {
    let mut line = String::new();
    if input.read_line(&mut line).expect("read") == 0 {
        return None;
    }
    Some(serde_json::from_str(&line).expect("JSON"))
}

fn write_message(output: &mut impl Write, value: &Value) {
    serde_json::to_writer(&mut *output, value).expect("JSON");
    output.write_all(b"\n").expect("newline");
    output.flush().expect("flush");
}

fn wait_for_eof(input: &mut impl BufRead) {
    assert!(read_optional_message(input).is_none());
}
