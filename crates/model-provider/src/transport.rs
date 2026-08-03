use crate::ModelError;
use crate::ModelErrorKind;
use eventsource_stream::EventStreamError;
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use reqwest::StatusCode;
use reqwest::header::CONTENT_TYPE;
use reqwest::header::HeaderMap;
use reqwest::header::RETRY_AFTER;
use serde_json::Value;
use std::io;
use std::time::Duration;
use tokio::sync::mpsc;
use url::Url;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_SSE_EVENT_BYTES: usize = crate::MAX_PROVIDER_RESPONSE_BYTES;
const RECORD_CAPACITY: usize = 16;
const MAX_ERROR_BYTES: usize = 16 * 1024;

#[derive(Debug)]
pub(crate) struct SseRecord {
    pub event: String,
    pub data: String,
}

pub(crate) fn client() -> Result<reqwest::Client, ModelError> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| ModelError::new(ModelErrorKind::Transport, true))
}

pub(crate) fn valid_base_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

pub fn append_path(base_url: &Url, suffix: &str) -> Result<Url, ModelError> {
    let mut url = base_url.clone();
    let base = url.path().trim_end_matches('/');
    url.set_path(&format!("{base}/{}", suffix.trim_start_matches('/')));
    Ok(url)
}

pub(crate) fn require_event_stream(response: &reqwest::Response) -> Result<(), ModelError> {
    let is_event_stream = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("text/event-stream"))
        });
    if is_event_stream {
        Ok(())
    } else {
        Err(ModelError::new(ModelErrorKind::Protocol, false))
    }
}

pub(crate) fn map_reqwest_error(error: reqwest::Error) -> ModelError {
    if error.is_timeout() {
        ModelError::new(ModelErrorKind::Timeout, true)
    } else {
        ModelError::new(ModelErrorKind::Transport, true)
    }
}

pub(crate) async fn provider_error(response: reqwest::Response) -> ModelError {
    let status = response.status();
    let request_id = provider_request_id(response.headers());
    let retry_after = header_text(response.headers(), RETRY_AFTER.as_str());
    let mut body = Vec::new();
    let mut chunks = response.bytes_stream();
    while body.len() < MAX_ERROR_BYTES {
        let Some(chunk) = chunks.next().await else {
            break;
        };
        let Ok(chunk) = chunk else {
            return ModelError::new(ModelErrorKind::Transport, true);
        };
        let remaining = MAX_ERROR_BYTES.saturating_sub(body.len());
        body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
    }
    let provider_code = provider_error_code(&body);
    map_status(status, &body).with_provider_metadata(
        status.as_u16(),
        provider_code.as_deref(),
        request_id.as_deref(),
        retry_after.as_deref(),
    )
}

fn map_status(status: StatusCode, body: &[u8]) -> ModelError {
    let text = String::from_utf8_lossy(body).to_ascii_lowercase();
    if matches!(
        status,
        StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY | StatusCode::PAYLOAD_TOO_LARGE
    ) && [
        "context_length_exceeded",
        "maximum context length",
        "context window",
        "too many tokens",
        "input token count",
    ]
    .iter()
    .any(|marker| text.contains(marker))
    {
        return ModelError::new(ModelErrorKind::ContextLengthExceeded, false);
    }
    match status.as_u16() {
        401 | 403 => ModelError::new(ModelErrorKind::Authentication, false),
        408 => ModelError::new(ModelErrorKind::Timeout, true),
        413 => ModelError::new(ModelErrorKind::ProviderRequestTooLarge, false),
        429 => ModelError::new(ModelErrorKind::RateLimited, true),
        400..=499 => ModelError::new(ModelErrorKind::InvalidRequest, false),
        500..=599 => ModelError::new(ModelErrorKind::Server, true),
        _ => ModelError::new(ModelErrorKind::Server, false),
    }
}

fn provider_request_id(headers: &HeaderMap) -> Option<String> {
    ["x-request-id", "request-id", "x-goog-request-id"]
        .into_iter()
        .find_map(|name| header_text(headers, name))
}

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned)
}

fn provider_error_code(body: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(body).ok()?;
    ["/error/code", "/error/type", "/error/status", "/type"]
        .into_iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
        .map(ToOwned::to_owned)
}

pub(crate) fn sse_records(
    response: reqwest::Response,
) -> mpsc::Receiver<Result<SseRecord, ModelError>> {
    let (sender, receiver) = mpsc::channel(RECORD_CAPACITY);
    tokio::spawn(async move {
        let mut event_bytes = 0usize;
        let mut suffix = [0u8; 4];
        let bounded_bytes = response.bytes_stream().map(move |chunk| {
            let chunk = chunk.map_err(io::Error::other)?;
            for byte in chunk.iter().copied() {
                event_bytes = event_bytes.saturating_add(1);
                suffix.rotate_left(1);
                suffix[3] = byte;
                if suffix[2..] == *b"\n\n" || suffix[2..] == *b"\r\r" || suffix == *b"\r\n\r\n" {
                    event_bytes = 0;
                } else if event_bytes > MAX_SSE_EVENT_BYTES {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "SSE event exceeds the size limit",
                    ));
                }
            }
            Ok(chunk)
        });
        let mut stream = bounded_bytes.eventsource();
        loop {
            let next = tokio::select! {
                _ = sender.closed() => return,
                next = tokio::time::timeout(STREAM_IDLE_TIMEOUT, stream.next()) => next,
            };
            let result = match next {
                Err(_) => Err(ModelError::new(ModelErrorKind::Timeout, true)),
                Ok(None) => return,
                Ok(Some(Ok(event))) => Ok(SseRecord {
                    event: event.event,
                    data: event.data,
                }),
                Ok(Some(Err(error))) => Err(match error {
                    EventStreamError::Transport(error)
                        if error.kind() == io::ErrorKind::InvalidData =>
                    {
                        ModelError::new(ModelErrorKind::ProviderResponseTooLarge, false)
                    }
                    EventStreamError::Utf8(_) | EventStreamError::Parser(_) => {
                        ModelError::new(ModelErrorKind::Protocol, false)
                    }
                    EventStreamError::Transport(_) => {
                        ModelError::new(ModelErrorKind::Disconnected, true)
                    }
                }),
            };
            let terminal = result.is_err();
            if sender.send(result).await.is_err() || terminal {
                return;
            }
        }
    });
    receiver
}
