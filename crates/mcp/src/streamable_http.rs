mod sse;

use crate::DiscoveryError;
use crate::DiscoveryErrorKind;
use crate::MAX_MESSAGE_BYTES;
use crate::MAX_MESSAGES;
use crate::MAX_STDOUT_BYTES;
use crate::MCP_PROTOCOL_VERSION;
use crate::McpCallErrorKind;
use crate::McpCallOutcome;
use crate::McpCallRequestState;
use crate::McpServerInventory;
use crate::PreparedMcpCall;
use crate::call;
use crate::protocol;
use crate::result;
use crate::transport;
use reqwest::header::ACCEPT;
use reqwest::header::CONTENT_TYPE;
use reqwest::header::HeaderMap;
use reqwest::header::HeaderName;
use reqwest::header::HeaderValue;
use reqwest::redirect::Policy;
use serde_json::Value;
use serde_json::json;
use std::fmt;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use url::Url;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(10);
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const EXECUTION_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_ENDPOINT_BYTES: usize = 1024;
const MAX_SESSION_ID_BYTES: usize = 1024;
const SESSION_HEADER: HeaderName = HeaderName::from_static("mcp-session-id");
const PROTOCOL_HEADER: HeaderName = HeaderName::from_static("mcp-protocol-version");

#[derive(Clone, PartialEq, Eq)]
pub struct LoopbackStreamableHttpServerSpec {
    id: String,
    endpoint: Url,
}

impl LoopbackStreamableHttpServerSpec {
    pub fn new(id: String, endpoint: String) -> Result<Self, &'static str> {
        let endpoint = validate_endpoint(&endpoint)?;
        Ok(Self { id, endpoint })
    }

    pub fn id(&self) -> &str {
        &self.id
    }
}

impl fmt::Debug for LoopbackStreamableHttpServerSpec {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LoopbackStreamableHttpServerSpec")
            .field("id", &self.id)
            .field("endpoint", &"<redacted>")
            .finish()
    }
}

pub(crate) async fn discover(
    spec: &LoopbackStreamableHttpServerSpec,
) -> Result<McpServerInventory, DiscoveryError> {
    tokio::time::timeout(DISCOVERY_TIMEOUT, async {
        let mut session = HttpSession::new(spec)?;
        let result = session.initialize_and_list().await;
        let shutdown = session.shutdown().await;
        match (result, shutdown) {
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
            (Ok(inventory), Ok(())) => Ok(inventory),
        }
    })
    .await
    .map_err(|_| error(spec, DiscoveryErrorKind::Timeout))?
}

pub(crate) async fn call(
    spec: &LoopbackStreamableHttpServerSpec,
    expected_inventory: &McpServerInventory,
    prepared: &PreparedMcpCall,
    cancellation: CancellationToken,
) -> McpCallOutcome {
    let mut session = match HttpSession::new(spec) {
        Ok(session) => session,
        Err(error) => return call::discovery_outcome(error, McpCallRequestState::NotSent),
    };
    let mut request_sent = false;
    let outcome = tokio::time::timeout(EXECUTION_TIMEOUT, async {
        let live_inventory = session.initialize_and_list().await?;
        if live_inventory.canonical_sha256() != expected_inventory.canonical_sha256()
            || prepared.inventory_sha256() != expected_inventory.canonical_sha256()
        {
            return Err(HttpCallFailure::Discovery(
                error(spec, DiscoveryErrorKind::InvalidToolInventory),
                McpCallRequestState::NotSent,
            ));
        }
        request_sent = true;
        let request = protocol::tools_call_request(prepared.raw_name(), prepared.arguments());
        let response = tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                let _ = session.post_accepted(&protocol::cancelled_notification()).await;
                return Err(HttpCallFailure::Cancelled);
            }
            response = tokio::time::timeout(CALL_TIMEOUT, session.post_request(&request, 3, false)) => {
                response
                    .map_err(|_| HttpCallFailure::Discovery(
                        error(spec, DiscoveryErrorKind::Timeout),
                        McpCallRequestState::MayHaveStarted,
                    ))?
                    .map_err(|error| HttpCallFailure::Discovery(
                        error,
                        McpCallRequestState::MayHaveStarted,
                    ))?
            }
        };
        if response.value.get("error").is_some() {
            return Err(HttpCallFailure::ServerError);
        }
        let result_value = response
            .value
            .get("result")
            .cloned()
            .ok_or_else(|| HttpCallFailure::Discovery(
                error(spec, DiscoveryErrorKind::InvalidJsonRpc),
                McpCallRequestState::MayHaveStarted,
            ))?;
        let tool = expected_inventory
            .tool_for_callable(prepared.callable_name())
            .ok_or(HttpCallFailure::Result(McpCallErrorKind::InventoryDrift))?;
        result::normalize(tool, result_value, response.observed_bytes)
            .map_err(HttpCallFailure::Result)
    })
    .await
    .unwrap_or_else(|_| {
        Err(HttpCallFailure::Discovery(
            error(spec, DiscoveryErrorKind::Timeout),
            if request_sent {
                McpCallRequestState::MayHaveStarted
            } else {
                McpCallRequestState::NotSent
            },
        ))
    });
    let shutdown = session.shutdown().await;
    match (outcome, shutdown) {
        (Ok(result), Ok(())) => McpCallOutcome::Completed(result),
        (Ok(_), Err(error)) => call::discovery_outcome(error, McpCallRequestState::Responded),
        (Err(HttpCallFailure::Cancelled), _) => McpCallOutcome::Error {
            kind: McpCallErrorKind::Cancelled,
            request_state: McpCallRequestState::MayHaveStarted,
        },
        (Err(HttpCallFailure::ServerError), _) => McpCallOutcome::Error {
            kind: McpCallErrorKind::ServerError,
            request_state: McpCallRequestState::Responded,
        },
        (Err(HttpCallFailure::Result(kind)), _) => McpCallOutcome::Error {
            kind,
            request_state: McpCallRequestState::Responded,
        },
        (Err(HttpCallFailure::Discovery(error, state)), _) => {
            if error.kind() == DiscoveryErrorKind::InvalidToolInventory
                && state == McpCallRequestState::NotSent
            {
                McpCallOutcome::Error {
                    kind: McpCallErrorKind::InventoryDrift,
                    request_state: state,
                }
            } else {
                call::discovery_outcome(error, state)
            }
        }
    }
}

enum HttpCallFailure {
    Cancelled,
    ServerError,
    Result(McpCallErrorKind),
    Discovery(DiscoveryError, McpCallRequestState),
}

impl From<DiscoveryError> for HttpCallFailure {
    fn from(error: DiscoveryError) -> Self {
        Self::Discovery(error, McpCallRequestState::NotSent)
    }
}

struct HttpResponse {
    value: Value,
    observed_bytes: usize,
}

struct HttpSession<'a> {
    spec: &'a LoopbackStreamableHttpServerSpec,
    client: reqwest::Client,
    session_id: Option<HeaderValue>,
    protocol_started: bool,
    body_bytes: usize,
    messages: usize,
}

impl<'a> HttpSession<'a> {
    fn new(spec: &'a LoopbackStreamableHttpServerSpec) -> Result<Self, DiscoveryError> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .retry(reqwest::retry::never())
            .referer(false)
            .connect_timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|_| error(spec, DiscoveryErrorKind::HttpTransport))?;
        Ok(Self {
            spec,
            client,
            session_id: None,
            protocol_started: false,
            body_bytes: 0,
            messages: 0,
        })
    }

    async fn initialize_and_list(&mut self) -> Result<McpServerInventory, DiscoveryError> {
        let initialize = self
            .post_request(&protocol::initialize_request(), 1, true)
            .await?;
        let initialize = initialize
            .value
            .get("result")
            .ok_or_else(|| self.error(DiscoveryErrorKind::InvalidJsonRpc))?;
        let (server_name, server_version) =
            protocol::validate_initialize(self.spec.id(), initialize)?;
        self.protocol_started = true;
        self.post_accepted(&protocol::initialized_notification())
            .await?;
        let list = self
            .post_request(&protocol::tools_list_request(), 2, false)
            .await?;
        let list = list
            .value
            .get("result")
            .ok_or_else(|| self.error(DiscoveryErrorKind::InvalidJsonRpc))?;
        let tools = protocol::validate_tools_list(self.spec.id(), list)?;
        McpServerInventory::from_protocol(self.spec.id(), server_name, server_version, tools)
    }

    async fn post_request(
        &mut self,
        value: &Value,
        expected_id: i64,
        initialize: bool,
    ) -> Result<HttpResponse, DiscoveryError> {
        let mut response = self.send_post(value).await?;
        if initialize {
            self.capture_session(response.headers())?;
        } else {
            self.reject_session_header(response.headers())?;
        }
        self.validate_success_status(response.status())?;
        let media_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(str::trim);
        match media_type {
            Some(media_type) if media_type.eq_ignore_ascii_case("application/json") => {
                let (value, bytes) = self.read_json(&mut response).await?;
                self.validate_expected_message(value, expected_id, bytes)
                    .await
            }
            Some(media_type) if media_type.eq_ignore_ascii_case("text/event-stream") => {
                self.read_sse_response(&mut response, expected_id).await
            }
            _ => Err(self.error(DiscoveryErrorKind::InvalidContentType)),
        }
    }

    async fn validate_expected_message(
        &mut self,
        value: Value,
        expected_id: i64,
        observed_bytes: usize,
    ) -> Result<HttpResponse, DiscoveryError> {
        let object = value
            .as_object()
            .ok_or_else(|| self.error(DiscoveryErrorKind::InvalidJsonRpc))?;
        if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Err(self.error(DiscoveryErrorKind::InvalidJsonRpc));
        }
        if let Some(method) = object.get("method").and_then(Value::as_str) {
            if object.contains_key("id") {
                if method != "ping" {
                    return Err(self.error(DiscoveryErrorKind::UnsupportedServerRequest));
                }
                let id = object
                    .get("id")
                    .cloned()
                    .ok_or_else(|| self.error(DiscoveryErrorKind::InvalidJsonRpc))?;
                self.post_accepted(&json!({"jsonrpc": "2.0", "id": id, "result": {}}))
                    .await?;
            } else if !matches!(
                method,
                "notifications/message" | "notifications/progress" | "notifications/cancelled"
            ) {
                return Err(self.error(DiscoveryErrorKind::InvalidJsonRpc));
            }
            return Err(self.error(DiscoveryErrorKind::InvalidJsonRpc));
        }
        if object.get("id").and_then(Value::as_i64) != Some(expected_id)
            || (!object.contains_key("result") && !object.contains_key("error"))
            || (object.contains_key("result") && object.contains_key("error"))
        {
            return Err(self.error(DiscoveryErrorKind::InvalidJsonRpc));
        }
        Ok(HttpResponse {
            value,
            observed_bytes,
        })
    }

    async fn read_sse_response(
        &mut self,
        response: &mut reqwest::Response,
        expected_id: i64,
    ) -> Result<HttpResponse, DiscoveryError> {
        let mut decoder = sse::SseDecoder::new();
        loop {
            while let Some(event) = decoder
                .next_event()
                .map_err(|_| self.error(DiscoveryErrorKind::InvalidSse))?
            {
                self.count_message()?;
                let value = parse_json(&event.data).map_err(|kind| self.error(kind))?;
                let object = value
                    .as_object()
                    .ok_or_else(|| self.error(DiscoveryErrorKind::InvalidJsonRpc))?;
                if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
                    return Err(self.error(DiscoveryErrorKind::InvalidJsonRpc));
                }
                if let Some(method) = object.get("method").and_then(Value::as_str) {
                    if object.contains_key("id") {
                        if method != "ping" {
                            return Err(self.error(DiscoveryErrorKind::UnsupportedServerRequest));
                        }
                        let id = object
                            .get("id")
                            .cloned()
                            .ok_or_else(|| self.error(DiscoveryErrorKind::InvalidJsonRpc))?;
                        self.post_accepted(&json!({"jsonrpc": "2.0", "id": id, "result": {}}))
                            .await?;
                    } else if !matches!(
                        method,
                        "notifications/message"
                            | "notifications/progress"
                            | "notifications/cancelled"
                    ) {
                        return Err(self.error(DiscoveryErrorKind::InvalidJsonRpc));
                    }
                    continue;
                }
                if object.get("id").and_then(Value::as_i64) != Some(expected_id)
                    || (!object.contains_key("result") && !object.contains_key("error"))
                    || (object.contains_key("result") && object.contains_key("error"))
                {
                    return Err(self.error(DiscoveryErrorKind::InvalidJsonRpc));
                }
                return Ok(HttpResponse {
                    value,
                    observed_bytes: event.raw_bytes,
                });
            }
            let chunk = response
                .chunk()
                .await
                .map_err(|error| self.request_error(error))?
                .ok_or_else(|| self.error(DiscoveryErrorKind::InvalidSse))?;
            self.count_body_bytes(chunk.len())?;
            decoder
                .push(&chunk)
                .map_err(|_| self.error(DiscoveryErrorKind::MessageTooLarge))?;
        }
    }

    async fn post_accepted(&mut self, value: &Value) -> Result<(), DiscoveryError> {
        let mut response = self.send_post(value).await?;
        self.reject_session_header(response.headers())?;
        if response.status() == reqwest::StatusCode::NOT_FOUND && self.session_id.is_some() {
            return Err(self.error(DiscoveryErrorKind::SessionExpired));
        }
        if response.status() != reqwest::StatusCode::ACCEPTED {
            return Err(self.error(DiscoveryErrorKind::HttpStatus));
        }
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| self.request_error(error))?
        {
            self.count_body_bytes(chunk.len())?;
            if !chunk.is_empty() {
                return Err(self.error(DiscoveryErrorKind::InvalidJsonRpc));
            }
        }
        Ok(())
    }

    async fn send_post(&self, value: &Value) -> Result<reqwest::Response, DiscoveryError> {
        let bytes = serde_json::to_vec(value)
            .map_err(|_| self.error(DiscoveryErrorKind::InvalidJsonRpc))?;
        if bytes.len() > MAX_MESSAGE_BYTES {
            return Err(self.error(DiscoveryErrorKind::MessageTooLarge));
        }
        let mut request = self
            .client
            .post(self.spec.endpoint.clone())
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json, text/event-stream")
            .body(bytes);
        if self.protocol_started {
            request = request.header(PROTOCOL_HEADER, MCP_PROTOCOL_VERSION);
        }
        if let Some(session_id) = self.session_id.as_ref() {
            request = request.header(SESSION_HEADER, session_id);
        }
        request
            .send()
            .await
            .map_err(|error| self.request_error(error))
    }

    async fn read_json(
        &mut self,
        response: &mut reqwest::Response,
    ) -> Result<(Value, usize), DiscoveryError> {
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| self.request_error(error))?
        {
            self.count_body_bytes(chunk.len())?;
            if body.len().saturating_add(chunk.len()) > MAX_MESSAGE_BYTES {
                return Err(self.error(DiscoveryErrorKind::MessageTooLarge));
            }
            body.extend_from_slice(&chunk);
        }
        self.count_message()?;
        let text =
            std::str::from_utf8(&body).map_err(|_| self.error(DiscoveryErrorKind::InvalidUtf8))?;
        let value = parse_json(text).map_err(|kind| self.error(kind))?;
        Ok((value, body.len()))
    }

    async fn shutdown(&mut self) -> Result<(), DiscoveryError> {
        let Some(session_id) = self.session_id.take() else {
            return Ok(());
        };
        let response = tokio::time::timeout(
            REQUEST_TIMEOUT,
            self.client
                .delete(self.spec.endpoint.clone())
                .header(PROTOCOL_HEADER, MCP_PROTOCOL_VERSION)
                .header(SESSION_HEADER, session_id)
                .send(),
        )
        .await
        .map_err(|_| self.error(DiscoveryErrorKind::Timeout))?
        .map_err(|error| self.request_error(error))?;
        self.reject_session_header(response.headers())?;
        if response.status().is_success()
            || response.status() == reqwest::StatusCode::METHOD_NOT_ALLOWED
        {
            Ok(())
        } else {
            Err(self.error(DiscoveryErrorKind::ShutdownFailed))
        }
    }

    fn capture_session(&mut self, headers: &HeaderMap) -> Result<(), DiscoveryError> {
        let mut values = headers.get_all(&SESSION_HEADER).iter();
        let Some(value) = values.next() else {
            return Ok(());
        };
        if values.next().is_some()
            || value.as_bytes().is_empty()
            || value.as_bytes().len() > MAX_SESSION_ID_BYTES
            || !value.as_bytes().iter().all(|byte| byte.is_ascii_graphic())
        {
            return Err(self.error(DiscoveryErrorKind::InvalidSession));
        }
        self.session_id = Some(value.clone());
        Ok(())
    }

    fn reject_session_header(&self, headers: &HeaderMap) -> Result<(), DiscoveryError> {
        if headers.contains_key(&SESSION_HEADER) {
            Err(self.error(DiscoveryErrorKind::InvalidSession))
        } else {
            Ok(())
        }
    }

    fn validate_success_status(&self, status: reqwest::StatusCode) -> Result<(), DiscoveryError> {
        if status == reqwest::StatusCode::NOT_FOUND && self.session_id.is_some() {
            Err(self.error(DiscoveryErrorKind::SessionExpired))
        } else if status.is_success() {
            Ok(())
        } else {
            Err(self.error(DiscoveryErrorKind::HttpStatus))
        }
    }

    fn count_body_bytes(&mut self, bytes: usize) -> Result<(), DiscoveryError> {
        self.body_bytes = self.body_bytes.saturating_add(bytes);
        if self.body_bytes > MAX_STDOUT_BYTES {
            Err(self.error(DiscoveryErrorKind::OutputTooLarge))
        } else {
            Ok(())
        }
    }

    fn count_message(&mut self) -> Result<(), DiscoveryError> {
        self.messages = self.messages.saturating_add(1);
        if self.messages > MAX_MESSAGES {
            Err(self.error(DiscoveryErrorKind::TooManyMessages))
        } else {
            Ok(())
        }
    }

    fn request_error(&self, error: reqwest::Error) -> DiscoveryError {
        self.error(if error.is_timeout() {
            DiscoveryErrorKind::Timeout
        } else {
            DiscoveryErrorKind::HttpTransport
        })
    }

    fn error(&self, kind: DiscoveryErrorKind) -> DiscoveryError {
        error(self.spec, kind)
    }
}

fn parse_json(text: &str) -> Result<Value, DiscoveryErrorKind> {
    let value = transport::parse_json_without_duplicates(text)
        .map_err(|_| DiscoveryErrorKind::InvalidJsonRpc)?;
    transport::validate_json_depth(&value, 1).map_err(|()| DiscoveryErrorKind::InvalidJsonRpc)?;
    Ok(value)
}

fn validate_endpoint(raw: &str) -> Result<Url, &'static str> {
    if raw.is_empty()
        || raw.len() > MAX_ENDPOINT_BYTES
        || raw
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte == b'\\')
        || raw.contains('?')
        || raw.contains('#')
    {
        return Err("invalid endpoint");
    }
    let authority_and_path = raw
        .strip_prefix("http://127.0.0.1:")
        .or_else(|| raw.strip_prefix("http://[::1]:"))
        .ok_or("invalid endpoint")?;
    let (port, path) = authority_and_path
        .split_once('/')
        .ok_or("invalid endpoint")?;
    if port.is_empty()
        || port.len() > 5
        || !port.bytes().all(|byte| byte.is_ascii_digit())
        || port.parse::<u16>().ok().filter(|port| *port != 0).is_none()
        || path.is_empty()
    {
        return Err("invalid endpoint");
    }
    let endpoint = Url::parse(raw).map_err(|_| "invalid endpoint")?;
    if endpoint.scheme() != "http"
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.port().is_none()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
        || endpoint.path() == "/"
    {
        return Err("invalid endpoint");
    }
    match endpoint.host() {
        Some(url::Host::Ipv4(address)) if address.is_loopback() => {}
        Some(url::Host::Ipv6(address)) if address == std::net::Ipv6Addr::LOCALHOST => {}
        _ => return Err("invalid endpoint"),
    }
    Ok(endpoint)
}

fn error(spec: &LoopbackStreamableHttpServerSpec, kind: DiscoveryErrorKind) -> DiscoveryError {
    DiscoveryError::new(spec.id(), kind)
}
