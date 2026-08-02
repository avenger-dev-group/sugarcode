use futures_util::StreamExt;
use serde_json::Value;
use std::collections::BTreeMap;
use sugarcode_model_provider::ModelContinuation;
use sugarcode_model_provider::ModelEvent;
use sugarcode_model_provider::ModelFinishReason;
use sugarcode_model_provider::ModelMessage;
use sugarcode_model_provider::ModelOutputItemKind;
use sugarcode_model_provider::ModelProvider;
use sugarcode_model_provider::ModelRequest;
use sugarcode_model_provider::ModelStrictToolsMode;
use sugarcode_model_provider::NativeModelProvider;
use sugarcode_model_provider::OpenAiChatCompletionsProvider;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use url::Url;
use zeroize::Zeroizing;

const RESPONSES_TEXT: &str = include_str!("fixtures/conformance/openai-responses-text.sse");
const CHAT_TEXT: &str = include_str!("fixtures/conformance/openai-chat-text.sse");
const ANTHROPIC_TEXT: &str = include_str!("fixtures/conformance/anthropic-text.sse");
const GEMINI_TEXT: &str = include_str!("fixtures/conformance/gemini-text.sse");

#[derive(Debug, PartialEq, Eq)]
struct CanonicalTextResult {
    preview: String,
    preview_indices: Vec<u32>,
    final_text: String,
    finish_reason: ModelFinishReason,
    continuation: ModelContinuation,
    usage_present: bool,
}

#[derive(Debug)]
struct CapturedRequest {
    target: String,
    headers: BTreeMap<String, String>,
    body: Value,
}

#[tokio::test]
async fn text_streams_across_all_four_wires_share_one_canonical_result() {
    let (responses_url, responses_capture, responses_server) =
        response_server(RESPONSES_TEXT).await;
    let responses = NativeModelProvider::openai_responses(
        responses_url,
        Some(Zeroizing::new("fixture-token".to_owned())),
        ModelStrictToolsMode::Disabled,
        false,
        1024,
    )
    .expect("Responses provider");
    let responses_result = collect_text(&responses).await;
    let responses_request = responses_capture.await.expect("Responses request");
    responses_server.await.expect("Responses server");

    let (chat_url, chat_capture, chat_server) = response_server(CHAT_TEXT).await;
    let chat = OpenAiChatCompletionsProvider::new(
        append_target(&chat_url, "chat/completions"),
        Some("fixture-token".to_owned()),
    )
    .expect("Chat provider");
    let chat_result = collect_text(&chat).await;
    let chat_request = chat_capture.await.expect("Chat request");
    chat_server.await.expect("Chat server");

    let (anthropic_url, anthropic_capture, anthropic_server) =
        response_server(ANTHROPIC_TEXT).await;
    let anthropic = NativeModelProvider::anthropic_messages(
        anthropic_url,
        Some(Zeroizing::new("fixture-token".to_owned())),
        ModelStrictToolsMode::Disabled,
        false,
        1024,
    )
    .expect("Anthropic provider");
    let anthropic_result = collect_text(&anthropic).await;
    let anthropic_request = anthropic_capture.await.expect("Anthropic request");
    anthropic_server.await.expect("Anthropic server");

    let (gemini_url, gemini_capture, gemini_server) = response_server(GEMINI_TEXT).await;
    let gemini = NativeModelProvider::gemini_generate_content(
        gemini_url,
        Some(Zeroizing::new("fixture-token".to_owned())),
        ModelStrictToolsMode::Disabled,
        false,
        1024,
    )
    .expect("Gemini provider");
    let gemini_result = collect_text(&gemini).await;
    let gemini_request = gemini_capture.await.expect("Gemini request");
    gemini_server.await.expect("Gemini server");

    let expected = CanonicalTextResult {
        preview: "fixture answer".to_owned(),
        preview_indices: vec![0, 0],
        final_text: "fixture answer".to_owned(),
        finish_reason: ModelFinishReason::Stop,
        continuation: ModelContinuation::Complete,
        usage_present: false,
    };
    assert_eq!(responses_result, expected);
    assert_eq!(chat_result, expected);
    assert_eq!(anthropic_result, expected);
    assert_eq!(gemini_result, expected);

    assert_request(
        &responses_request,
        "/v1/responses",
        "authorization",
        &["parallel_tool_calls", "previous_response_id"],
    );
    assert_eq!(responses_request.body["stream"], true);
    assert_eq!(responses_request.body["store"], false);

    assert_request(
        &chat_request,
        "/v1/chat/completions",
        "authorization",
        &["parallel_tool_calls", "stream_options"],
    );
    assert_eq!(chat_request.body["stream"], true);

    assert_request(
        &anthropic_request,
        "/v1/messages",
        "x-api-key",
        &["parallel_tool_calls", "stream_options"],
    );
    assert_eq!(anthropic_request.body["stream"], true);
    assert!(anthropic_request.headers.contains_key("anthropic-version"));

    assert_request(
        &gemini_request,
        "/v1/models/fixture-model:streamGenerateContent?alt=sse",
        "x-goog-api-key",
        &["parallel_tool_calls", "stream_options"],
    );
}

async fn collect_text(provider: &dyn ModelProvider) -> CanonicalTextResult {
    let mut stream = provider
        .stream(ModelRequest {
            model: "fixture-model".to_owned(),
            instructions: Vec::new(),
            messages: vec![ModelMessage::user_text("fixture prompt".to_owned())],
            tools: Vec::new(),
        })
        .await
        .expect("stream opens");
    let mut preview = String::new();
    let mut preview_indices = Vec::new();
    let mut response = None;
    while let Some(event) = stream.next().await {
        match event.expect("canonical event") {
            ModelEvent::OutputTextDelta {
                output_index,
                delta,
            } => {
                preview_indices.push(output_index);
                preview.push_str(&delta);
            }
            ModelEvent::ResponseCompleted(completed) => {
                assert!(response.replace(completed).is_none(), "one completion");
            }
            ModelEvent::Warning { .. } => {}
        }
    }
    let response = response.expect("completed response");
    let [item] = response.output.as_slice() else {
        panic!("one canonical output item");
    };
    let ModelOutputItemKind::AssistantText { text, .. } = &item.kind else {
        panic!("canonical text output");
    };
    CanonicalTextResult {
        preview,
        preview_indices,
        final_text: text.clone(),
        finish_reason: response.terminal.finish_reason,
        continuation: response.terminal.continuation,
        usage_present: response.usage.is_some(),
    }
}

fn assert_request(
    request: &CapturedRequest,
    target: &str,
    auth_header: &str,
    omitted_fields: &[&str],
) {
    assert_eq!(request.target, target);
    assert!(request.headers.contains_key(auth_header));
    for field in omitted_fields {
        assert!(
            request.body.get(field).is_none(),
            "{field} must be omitted from the conservative request"
        );
    }
}

fn append_target(base: &Url, target: &str) -> Url {
    let mut url = base.clone();
    url.set_path(&format!("{}/{}", url.path().trim_end_matches('/'), target));
    url
}

async fn response_server(
    body: &str,
) -> (
    Url,
    oneshot::Receiver<CapturedRequest>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind conformance server");
    let address = listener.local_addr().expect("conformance address");
    let body = body.as_bytes().to_vec();
    let (capture_tx, capture_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept request");
        let request = read_request(&mut socket).await;
        let _ = capture_tx.send(request);
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
        socket.write_all(&body).await.expect("write fixture");
        socket.flush().await.expect("flush fixture");
    });
    (
        Url::parse(&format!("http://{address}/v1")).expect("base URL"),
        capture_rx,
        server,
    )
}

async fn read_request(socket: &mut TcpStream) -> CapturedRequest {
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
    let headers_text = String::from_utf8_lossy(&request[..header_end]);
    let mut lines = headers_text.lines();
    let target = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .expect("request target")
        .to_owned();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_owned()))
        .collect::<BTreeMap<_, _>>();
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .expect("content length");
    assert!(content_length <= 1024 * 1024);
    while request.len() - header_end < content_length {
        let read = socket.read(&mut buffer).await.expect("read request body");
        assert!(read > 0, "request body ended early");
        request.extend_from_slice(&buffer[..read]);
    }
    let body = serde_json::from_slice(&request[header_end..header_end + content_length])
        .expect("JSON request");
    CapturedRequest {
        target,
        headers,
        body,
    }
}
