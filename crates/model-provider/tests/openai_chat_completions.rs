use futures_util::StreamExt;
use std::sync::Arc;
use sugarcode_model_provider::ModelErrorKind;
use sugarcode_model_provider::ModelEvent;
use sugarcode_model_provider::ModelMessage;
use sugarcode_model_provider::ModelProvider;
use sugarcode_model_provider::ModelRequest;
use sugarcode_model_provider::ModelRole;
use sugarcode_model_provider::OpenAiChatCompletionsProvider;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use url::Url;

const SUCCESS: &str = include_str!("fixtures/chat-completions-success.sse");
const UTF8: &str = include_str!("fixtures/chat-completions-utf8.sse");
const TERMINAL_ERROR: &str = include_str!("fixtures/chat-completions-terminal-error.sse");
const MALFORMED: &str = include_str!("fixtures/chat-completions-malformed.sse");
const DISCONNECT: &str = include_str!("fixtures/chat-completions-disconnect.sse");
const CANCELLATION: &str = include_str!("fixtures/chat-completions-cancellation.sse");

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
async fn utf8_survives_arbitrary_network_chunk_boundaries() {
    let bytes = UTF8.as_bytes().to_vec();
    let first_utf8 = bytes
        .windows("你".len())
        .position(|window| window == "你".as_bytes())
        .expect("UTF-8 fixture");
    let split_points = vec![1, 7, first_utf8 + 1, first_utf8 + 2, bytes.len() - 3];
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
    assert_eq!(error.kind(), ModelErrorKind::Transport);
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
        read_request(&mut socket).await;
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

fn provider(endpoint: Url) -> Arc<dyn ModelProvider> {
    Arc::new(
        OpenAiChatCompletionsProvider::new(endpoint, Some("fixture-token".to_string()))
            .expect("provider"),
    )
}

fn request() -> ModelRequest {
    ModelRequest {
        model: "fixture-model".to_string(),
        messages: vec![ModelMessage {
            role: ModelRole::User,
            text: "Hello".to_string(),
        }],
    }
}

async fn response_server(
    body: Vec<u8>,
    split_points: Vec<usize>,
) -> (Url, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind mock server");
    let address = listener.local_addr().expect("mock address");
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept request");
        read_request(&mut socket).await;
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
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

async fn read_request(socket: &mut TcpStream) {
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
    assert!(
        headers
            .to_ascii_lowercase()
            .contains("authorization: bearer fixture-token\r\n")
    );
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
}
