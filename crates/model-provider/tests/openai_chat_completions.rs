use futures_util::StreamExt;
use std::sync::Arc;
use sugarcode_model_provider::ModelErrorKind;
use sugarcode_model_provider::ModelEvent;
use sugarcode_model_provider::ModelMessage;
use sugarcode_model_provider::ModelProvider;
use sugarcode_model_provider::ModelRequest;
use sugarcode_model_provider::ModelRole;
use sugarcode_model_provider::ModelToolCall;
use sugarcode_model_provider::ModelToolDefinition;
use sugarcode_model_provider::OpenAiChatCompletionsProvider;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use url::Url;

const SUCCESS: &str = include_str!("fixtures/completed.sse");
const COMPLETED_CHUNKS: &str = include_str!("fixtures/completed.chunks.json");
const UTF8: &str = include_str!("fixtures/chat-completions-utf8.sse");
const TERMINAL_ERROR: &str = include_str!("fixtures/terminal-error.sse");
const MALFORMED: &str = include_str!("fixtures/malformed.sse");
const DISCONNECT: &str = include_str!("fixtures/chat-completions-disconnect.sse");
const CANCELLATION: &str = include_str!("fixtures/cancellable.sse");

#[tokio::test]
async fn recorded_success_stream_normalizes_text_and_usage() {
    let (endpoint, server) = response_server(SUCCESS.as_bytes().to_vec(), Vec::new()).await;
    let provider = provider(endpoint);
    let events = provider
        .stream(request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");

    assert_eq!(
        events,
        vec![
            Ok(ModelEvent::TextDelta(
                "SugarCode deterministic response.".to_string()
            )),
            Ok(ModelEvent::Usage(sugarcode_model_provider::ModelUsage {
                input_tokens: Some(1),
                output_tokens: Some(3),
                total_tokens: Some(4),
                ..Default::default()
            })),
            Ok(ModelEvent::Completed),
        ]
    );
}

#[tokio::test]
async fn fragmented_single_tool_call_is_assembled_into_one_typed_event() {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"workspace/\",\"arguments\":\"{\\\"path\\\":\\\"READ\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"read\",\"arguments\":\"ME.txt\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    let (endpoint, server) = response_server(body.as_bytes().to_vec(), Vec::new()).await;
    let events = provider(endpoint)
        .stream(tool_request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");

    assert_eq!(
        events,
        vec![
            Ok(ModelEvent::ToolCall(ModelToolCall {
                id: "call_1".to_string(),
                name: "workspace/read".to_string(),
                arguments: serde_json::json!({ "path": "README.txt" }),
            })),
            Ok(ModelEvent::Completed),
        ]
    );
}

#[tokio::test]
async fn structured_tool_call_error_matrix_is_stable_and_non_retryable() {
    let cases = [
        (
            concat!(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"function_call\":{\"name\":\"workspace/read\",\"arguments\":\"{}\"}},\"finish_reason\":\"function_call\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ModelErrorKind::UnsupportedOutput,
        ),
        (
            concat!(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"type\":\"function\",\"function\":{\"name\":\"workspace/read\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}\n\n",
                "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ModelErrorKind::Protocol,
        ),
        (
            concat!(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"workspace/read\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}\n\n",
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_2\"}]},\"finish_reason\":null}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ModelErrorKind::Protocol,
        ),
        (
            concat!(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"workspace/read\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ModelErrorKind::UnsupportedOutput,
        ),
        (
            concat!(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0},{\"index\":1}]},\"finish_reason\":null}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ModelErrorKind::UnsupportedOutput,
        ),
        (
            concat!(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"workspace/read\",\"arguments\":\"{\"}}]},\"finish_reason\":null}]}\n\n",
                "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ModelErrorKind::Protocol,
        ),
        (
            concat!(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"bad id\",\"type\":\"function\",\"function\":{\"name\":\"workspace/read\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ModelErrorKind::Protocol,
        ),
    ];
    for (body, expected) in cases {
        let (endpoint, server) = response_server(body.as_bytes().to_vec(), Vec::new()).await;
        let events = provider(endpoint)
            .stream(tool_request())
            .await
            .expect("stream starts")
            .collect::<Vec<_>>()
            .await;
        let error = events
            .last()
            .expect("terminal event")
            .as_ref()
            .expect_err("invalid tool output");
        server.await.expect("mock server");
        assert_eq!(error.kind(), expected);
        assert!(!error.retryable());
    }
}

#[tokio::test]
async fn oversized_tool_arguments_are_a_non_retryable_output_limit() {
    let arguments = "x".repeat(32 * 1024 + 1);
    let chunk = serde_json::json!({
        "choices": [{
            "index": 0,
            "delta": {
                "tool_calls": [{
                    "index": 0,
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "workspace/read",
                        "arguments": arguments,
                    }
                }]
            },
            "finish_reason": null
        }]
    });
    let body = format!("data: {chunk}\n\ndata: [DONE]\n\n");
    let (endpoint, server) = response_server(body.into_bytes(), Vec::new()).await;
    let error = provider(endpoint)
        .stream(tool_request())
        .await
        .expect("stream starts")
        .next()
        .await
        .expect("terminal event")
        .expect_err("oversized arguments");
    server.await.expect("mock server");
    assert_eq!(error.kind(), ModelErrorKind::OutputTooLarge);
    assert!(!error.retryable());
}

#[tokio::test]
async fn utf8_survives_arbitrary_network_chunk_boundaries() {
    let bytes = UTF8.as_bytes().to_vec();
    let first_utf8 = bytes
        .windows("你".len())
        .position(|window| window == "你".as_bytes())
        .expect("UTF-8 fixture");
    let mut split_points =
        serde_json::from_str::<Vec<usize>>(COMPLETED_CHUNKS).expect("chunk fixture");
    split_points.extend([first_utf8 + 1, first_utf8 + 2, bytes.len() - 3]);
    let (endpoint, server) = response_server(bytes, split_points).await;
    let provider = provider(endpoint);
    let events = provider
        .stream(request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");

    assert_eq!(
        events,
        vec![
            Ok(ModelEvent::TextDelta("你".to_string())),
            Ok(ModelEvent::TextDelta("好".to_string())),
            Ok(ModelEvent::Completed),
        ]
    );
}

#[tokio::test]
async fn recorded_terminal_error_is_redacted_and_retryable() {
    let (endpoint, server) = response_server(TERMINAL_ERROR.as_bytes().to_vec(), Vec::new()).await;
    let provider = provider(endpoint);
    let error = provider
        .stream(request())
        .await
        .expect("HTTP request succeeds")
        .next()
        .await
        .expect("terminal event")
        .expect_err("provider error");
    server.await.expect("mock server");

    assert_eq!(error.kind(), ModelErrorKind::Server);
    assert!(error.retryable());
    assert!(!error.to_string().contains("fixture payload"));
    assert!(!format!("{error:?}").contains("fixture payload"));
}

#[tokio::test]
async fn malformed_recorded_event_is_a_non_retryable_protocol_error() {
    let (endpoint, server) = response_server(MALFORMED.as_bytes().to_vec(), Vec::new()).await;
    let provider = provider(endpoint);
    let error = provider
        .stream(request())
        .await
        .expect("HTTP request succeeds")
        .next()
        .await
        .expect("terminal event")
        .expect_err("protocol error");
    server.await.expect("mock server");

    assert_eq!(error.kind(), ModelErrorKind::Protocol);
    assert!(!error.retryable());
}

#[test]
fn remote_plaintext_http_endpoint_is_rejected() {
    let endpoint =
        Url::parse("http://example.com/v1/chat/completions").expect("remote HTTP endpoint");
    let error = OpenAiChatCompletionsProvider::new(endpoint, None)
        .expect_err("remote plaintext HTTP must fail");
    assert_eq!(error.kind(), ModelErrorKind::InvalidRequest);
    assert!(!error.retryable());
}

#[tokio::test]
async fn non_event_stream_content_type_is_rejected() {
    let (endpoint, server) = response_server_with_options(
        SUCCESS.as_bytes().to_vec(),
        Vec::new(),
        "application/json",
        true,
    )
    .await;
    let error = match provider(endpoint).stream(request()).await {
        Ok(_) => panic!("non-SSE response must fail"),
        Err(error) => error,
    };
    server.await.expect("mock server");
    assert_eq!(error.kind(), ModelErrorKind::Protocol);
    assert!(!error.retryable());
}

#[tokio::test]
async fn empty_token_sends_no_authorization_header() {
    let (endpoint, server) = response_server_with_options(
        SUCCESS.as_bytes().to_vec(),
        Vec::new(),
        "text/event-stream",
        false,
    )
    .await;
    let provider =
        OpenAiChatCompletionsProvider::new(endpoint, Some(String::new())).expect("provider");
    let events = provider
        .stream(request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");
    assert!(matches!(events.last(), Some(Ok(ModelEvent::Completed))));
}

#[tokio::test]
async fn data_after_finish_reason_is_a_protocol_error() {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"late\"},\"finish_reason\":null}]}\n\n",
        "data: [DONE]\n\n"
    );
    let (endpoint, server) = response_server(body.as_bytes().to_vec(), Vec::new()).await;
    let error = provider(endpoint)
        .stream(request())
        .await
        .expect("stream starts")
        .next()
        .await
        .expect("terminal event")
        .expect_err("late data must fail");
    server.await.expect("mock server");
    assert_eq!(error.kind(), ModelErrorKind::Protocol);
}

#[tokio::test]
async fn usage_only_chunk_after_finish_reason_is_accepted_once() {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"done\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3,\"total_tokens\":5}}\n\n",
        "data: [DONE]\n\n"
    );
    let (endpoint, server) = response_server(body.as_bytes().to_vec(), Vec::new()).await;
    let events = provider(endpoint)
        .stream(request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");
    assert_eq!(
        events,
        vec![
            Ok(ModelEvent::TextDelta("done".to_string())),
            Ok(ModelEvent::Usage(sugarcode_model_provider::ModelUsage {
                input_tokens: Some(2),
                output_tokens: Some(3),
                total_tokens: Some(5),
                ..Default::default()
            })),
            Ok(ModelEvent::Completed),
        ]
    );
}

#[tokio::test]
async fn empty_completed_response_is_non_retryable_incomplete() {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    let (endpoint, server) = response_server(body.as_bytes().to_vec(), Vec::new()).await;
    let error = provider(endpoint)
        .stream(request())
        .await
        .expect("stream starts")
        .next()
        .await
        .expect("terminal event")
        .expect_err("empty response must fail");
    server.await.expect("mock server");
    assert_eq!(error.kind(), ModelErrorKind::Incomplete);
    assert!(!error.retryable());
}

#[tokio::test]
async fn mixed_content_and_tool_output_is_rejected_before_any_delta() {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"must-not-emit\",\"tool_calls\":[]},\"finish_reason\":null}]}\n\n",
        "data: [DONE]\n\n"
    );
    let (endpoint, server) = response_server(body.as_bytes().to_vec(), Vec::new()).await;
    let events = provider(endpoint)
        .stream(request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");
    assert_eq!(events.len(), 1);
    let error = events[0].as_ref().expect_err("unsupported output");
    assert_eq!(error.kind(), ModelErrorKind::UnsupportedOutput);
}

#[tokio::test]
async fn unsupported_secondary_choice_is_rejected_before_primary_delta() {
    let body = concat!(
        "data: {\"choices\":[",
        "{\"index\":0,\"delta\":{\"content\":\"must-not-emit\"},\"finish_reason\":null},",
        "{\"index\":1,\"delta\":{\"tool_calls\":[]},\"finish_reason\":\"tool_calls\"}",
        "]}\n\n",
        "data: [DONE]\n\n"
    );
    let (endpoint, server) = response_server(body.as_bytes().to_vec(), Vec::new()).await;
    let events = provider(endpoint)
        .stream(request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");
    assert_eq!(events.len(), 1);
    let error = events[0].as_ref().expect_err("unsupported output");
    assert_eq!(error.kind(), ModelErrorKind::UnsupportedOutput);
}

#[tokio::test]
async fn oversized_sse_event_is_rejected_without_unbounded_buffering() {
    let body = format!("data: {}\n\n", "x".repeat(256 * 1024));
    let (endpoint, server) = response_server(body.into_bytes(), Vec::new()).await;
    let error = provider(endpoint)
        .stream(request())
        .await
        .expect("stream starts")
        .next()
        .await
        .expect("terminal event")
        .expect_err("oversized event must fail");
    server.await.expect("mock server");
    assert_eq!(error.kind(), ModelErrorKind::Protocol);
}

#[tokio::test]
async fn http_statuses_map_to_stable_retryable_errors() {
    for (status, kind, retryable) in [
        (400, ModelErrorKind::InvalidRequest, false),
        (401, ModelErrorKind::Authentication, false),
        (408, ModelErrorKind::Timeout, true),
        (429, ModelErrorKind::RateLimited, true),
        (500, ModelErrorKind::Server, true),
    ] {
        let (endpoint, server) = status_server(status).await;
        let error = match provider(endpoint).stream(request()).await {
            Ok(_) => panic!("HTTP {status} must fail"),
            Err(error) => error,
        };
        server.await.expect("mock server");
        assert_eq!(error.kind(), kind, "HTTP {status}");
        assert_eq!(error.retryable(), retryable, "HTTP {status}");
    }
}

#[tokio::test]
async fn terminal_reason_matrix_maps_to_stable_non_retryable_errors() {
    for (terminal, kind) in [
        (
            "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"length\"}]}",
            ModelErrorKind::Incomplete,
        ),
        (
            "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"content_filter\"}]}",
            ModelErrorKind::Filtered,
        ),
        (
            "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}",
            ModelErrorKind::UnsupportedOutput,
        ),
        (
            "{\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[]},\"finish_reason\":null}]}",
            ModelErrorKind::UnsupportedOutput,
        ),
        (
            "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"fixture_unknown\"}]}",
            ModelErrorKind::Protocol,
        ),
    ] {
        let body = format!("data: {terminal}\n\ndata: [DONE]\n\n");
        let (endpoint, server) = response_server(body.into_bytes(), Vec::new()).await;
        let error = provider(endpoint)
            .stream(request())
            .await
            .expect("stream starts")
            .next()
            .await
            .expect("terminal event")
            .expect_err("terminal reason must fail");
        server.await.expect("mock server");
        assert_eq!(error.kind(), kind);
        assert!(!error.retryable());
    }
}

#[tokio::test]
async fn done_without_finish_reason_is_a_protocol_error() {
    let (endpoint, server) = response_server(b"data: [DONE]\n\n".to_vec(), Vec::new()).await;
    let error = provider(endpoint)
        .stream(request())
        .await
        .expect("stream starts")
        .next()
        .await
        .expect("terminal event")
        .expect_err("DONE without finish must fail");
    server.await.expect("mock server");
    assert_eq!(error.kind(), ModelErrorKind::Protocol);
    assert!(!error.retryable());
}

#[tokio::test]
async fn response_header_timeout_uses_virtual_time() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind header timeout server");
    let address = listener.local_addr().expect("header timeout address");
    let (accepted_tx, accepted_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (_socket, _) = listener.accept().await.expect("accept request");
        let _ = accepted_tx.send(());
        let _ = release_rx.await;
    });
    let endpoint =
        Url::parse(&format!("http://{address}/v1/chat/completions")).expect("mock endpoint");
    let client = tokio::spawn(async move { provider(endpoint).stream(request()).await });
    accepted_rx.await.expect("request accepted");
    tokio::time::pause();
    tokio::time::advance(std::time::Duration::from_secs(31)).await;
    let error = match client.await.expect("provider task") {
        Ok(_) => panic!("missing response headers must time out"),
        Err(error) => error,
    };
    let _ = release_tx.send(());
    server.await.expect("mock server");
    assert_eq!(error.kind(), ModelErrorKind::Timeout);
    assert!(error.retryable());
}

#[tokio::test]
async fn stream_idle_timeout_uses_virtual_time() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind idle timeout server");
    let address = listener.local_addr().expect("idle timeout address");
    let (headers_tx, headers_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept request");
        read_request(&mut socket, true).await;
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
            )
            .await
            .expect("write response headers");
        socket.flush().await.expect("flush response headers");
        let _ = headers_tx.send(());
        let _ = release_rx.await;
    });
    let endpoint =
        Url::parse(&format!("http://{address}/v1/chat/completions")).expect("mock endpoint");
    let client = tokio::spawn(async move { provider(endpoint).stream(request()).await });
    headers_rx.await.expect("headers sent");
    let mut stream = client.await.expect("provider task").expect("stream starts");
    tokio::task::yield_now().await;
    tokio::time::pause();
    let next = tokio::spawn(async move { stream.next().await });
    tokio::task::yield_now().await;
    tokio::time::advance(std::time::Duration::from_secs(61)).await;
    let error = next
        .await
        .expect("stream task")
        .expect("terminal event")
        .expect_err("idle stream must time out");
    let _ = release_tx.send(());
    server.await.expect("mock server");
    assert_eq!(error.kind(), ModelErrorKind::Timeout);
    assert!(error.retryable());
}

#[tokio::test]
async fn disconnect_before_done_is_retryable_transport_failure() {
    let (endpoint, server) = response_server(DISCONNECT.as_bytes().to_vec(), Vec::new()).await;
    let provider = provider(endpoint);
    let events = provider
        .stream(request())
        .await
        .expect("HTTP request succeeds")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");

    assert_eq!(events[0], Ok(ModelEvent::TextDelta("partial".to_string())));
    let error = *events[1].as_ref().expect_err("disconnect error");
    assert_eq!(error.kind(), ModelErrorKind::Disconnected);
    assert!(error.retryable());
}

#[tokio::test]
async fn truncated_http_body_after_delta_is_retryable_disconnect_not_protocol() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind truncated server");
    let address = listener.local_addr().expect("truncated server address");
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept request");
        read_request(&mut socket, true).await;
        let event = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n";
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    event.len() + 1024,
                    event
                )
                .as_bytes(),
            )
            .await
            .expect("write truncated response");
        socket.shutdown().await.expect("close truncated response");
    });
    let endpoint =
        Url::parse(&format!("http://{address}/v1/chat/completions")).expect("mock endpoint");
    let events = provider(endpoint)
        .stream(request())
        .await
        .expect("stream starts")
        .collect::<Vec<_>>()
        .await;
    server.await.expect("mock server");
    assert_eq!(events[0], Ok(ModelEvent::TextDelta("partial".to_string())));
    let error = events[1].as_ref().expect_err("disconnect");
    assert_eq!(error.kind(), ModelErrorKind::Disconnected);
    assert!(error.retryable());
}

#[tokio::test]
async fn dropping_the_stream_closes_the_upstream_response_without_sleep() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind mock server");
    let address = listener.local_addr().expect("mock address");
    let (closed_tx, closed_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept request");
        read_request(&mut socket, true).await;
        let event = CANCELLATION;
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{}\r\n",
                    event.len(),
                    event
                )
                .as_bytes(),
            )
            .await
            .expect("write partial stream");
        socket.flush().await.expect("flush partial stream");
        let mut byte = [0u8; 1];
        let result = socket.read(&mut byte).await;
        let _ = closed_tx.send(matches!(result, Ok(0) | Err(_)));
    });
    let endpoint =
        Url::parse(&format!("http://{address}/v1/chat/completions")).expect("mock endpoint");
    let provider = provider(endpoint);
    let mut stream = provider.stream(request()).await.expect("stream starts");
    assert_eq!(
        stream.next().await.expect("delta").expect("valid delta"),
        ModelEvent::TextDelta("partial".to_string())
    );
    drop(stream);

    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(2), closed_rx)
            .await
            .expect("upstream close deadline")
            .expect("close signal")
    );
    server.await.expect("mock server");
}

#[tokio::test]
async fn dropping_during_tool_argument_assembly_closes_upstream_without_an_event() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind mock server");
    let address = listener.local_addr().expect("mock address");
    let (fragment_tx, fragment_rx) = oneshot::channel();
    let (closed_tx, closed_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept request");
        read_request(&mut socket, true).await;
        let event = concat!(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[",
            "{\"index\":0,\"id\":\"call_partial\",\"type\":\"function\",\"function\":",
            "{\"name\":\"workspace/\",\"arguments\":\"{\\\"path\\\":\\\"partial\"}}",
            "]},\"finish_reason\":null}]}\n\n"
        );
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{}\r\n",
                    event.len(),
                    event
                )
                .as_bytes(),
            )
            .await
            .expect("write partial tool stream");
        socket.flush().await.expect("flush partial tool stream");
        let _ = fragment_tx.send(());
        let mut byte = [0u8; 1];
        let result = socket.read(&mut byte).await;
        let _ = closed_tx.send(matches!(result, Ok(0) | Err(_)));
    });
    let endpoint =
        Url::parse(&format!("http://{address}/v1/chat/completions")).expect("mock endpoint");
    let stream = provider(endpoint)
        .stream(tool_request())
        .await
        .expect("stream starts");
    fragment_rx.await.expect("fragment sent");
    tokio::task::yield_now().await;
    drop(stream);
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(2), closed_rx)
            .await
            .expect("upstream close deadline")
            .expect("close signal")
    );
    server.await.expect("mock server");
}

fn provider(endpoint: Url) -> Arc<dyn ModelProvider> {
    Arc::new(
        OpenAiChatCompletionsProvider::new(endpoint, Some("fixture-token".to_string()))
            .expect("provider"),
    )
}

fn request() -> ModelRequest {
    ModelRequest {
        model: "fixture-model".to_string(),
        messages: vec![ModelMessage::Text {
            role: ModelRole::User,
            text: "Hello".to_string(),
        }],
        tools: Vec::new(),
    }
}

fn tool_request() -> ModelRequest {
    let mut request = request();
    request.tools.push(ModelToolDefinition {
        name: "workspace/read".to_string(),
        description: "Read a workspace file".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": { "path": { "type": "string" } },
            "required": ["path"]
        }),
    });
    request
}

async fn response_server(
    body: Vec<u8>,
    split_points: Vec<usize>,
) -> (Url, tokio::task::JoinHandle<()>) {
    response_server_with_options(body, split_points, "text/event-stream", true).await
}

async fn response_server_with_options(
    body: Vec<u8>,
    split_points: Vec<usize>,
    content_type: &'static str,
    expect_auth: bool,
) -> (Url, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind mock server");
    let address = listener.local_addr().expect("mock address");
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept request");
        read_request(&mut socket, expect_auth).await;
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .expect("write response headers");
        let mut start = 0usize;
        for end in split_points
            .into_iter()
            .filter(|end| *end > 0 && *end < body.len())
            .chain(std::iter::once(body.len()))
        {
            if end <= start {
                continue;
            }
            socket
                .write_all(&body[start..end])
                .await
                .expect("write response chunk");
            start = end;
        }
        socket.flush().await.expect("flush response");
    });
    (
        Url::parse(&format!("http://{address}/v1/chat/completions")).expect("mock endpoint"),
        server,
    )
}

async fn status_server(status: u16) -> (Url, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind status server");
    let address = listener.local_addr().expect("status server address");
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept request");
        read_request(&mut socket, true).await;
        socket
            .write_all(
                format!(
                    "HTTP/1.1 {status} Fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .expect("write status response");
        socket.flush().await.expect("flush status response");
    });
    (
        Url::parse(&format!("http://{address}/v1/chat/completions")).expect("mock endpoint"),
        server,
    )
}

async fn read_request(socket: &mut TcpStream, expect_auth: bool) {
    let mut request = Vec::new();
    let mut buffer = [0u8; 4096];
    let header_end = loop {
        let read = socket.read(&mut buffer).await.expect("read request");
        assert!(read > 0, "request ended before headers");
        request.extend_from_slice(&buffer[..read]);
        if let Some(position) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
        assert!(request.len() <= 64 * 1024, "request headers too large");
    };
    let headers = String::from_utf8_lossy(&request[..header_end]);
    assert!(headers.starts_with("POST /v1/chat/completions HTTP/1.1\r\n"));
    let has_auth = headers
        .to_ascii_lowercase()
        .contains("authorization: bearer fixture-token\r\n");
    assert_eq!(has_auth, expect_auth);
    let content_length = headers
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length: ")
                .and_then(|value| value.parse::<usize>().ok())
        })
        .expect("content length");
    assert!(content_length <= 1024 * 1024);
    while request.len() - header_end < content_length {
        let read = socket.read(&mut buffer).await.expect("read request body");
        assert!(read > 0, "request body ended early");
        request.extend_from_slice(&buffer[..read]);
    }
    let body: serde_json::Value =
        serde_json::from_slice(&request[header_end..header_end + content_length])
            .expect("JSON request body");
    let keys = body
        .as_object()
        .expect("request object")
        .keys()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    let mut expected =
        std::collections::BTreeSet::from(["messages", "model", "stream", "stream_options"]);
    if body.get("tools").is_some() {
        expected.insert("tools");
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["function"]["name"], "workspace/read");
    }
    assert_eq!(keys, expected);
    assert_eq!(body["stream_options"]["include_usage"], true);
}
