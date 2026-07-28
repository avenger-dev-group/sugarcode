use crate::DiscoveryError;
use crate::DiscoveryErrorKind;
use crate::MAX_JSON_DEPTH;
use crate::MAX_MESSAGE_BYTES;
use crate::MAX_MESSAGES;
use crate::MAX_STDOUT_BYTES;
use crate::inventory::StdioServerSpec;
use crate::process::ManagedProcess;
use serde::Deserialize;
use serde::de::MapAccess;
use serde::de::SeqAccess;
use serde::de::Visitor;
use serde_json::Value;
use std::collections::BTreeSet;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use tokio::process::ChildStdin;
use tokio::process::ChildStdout;
use tokio::sync::Notify;

pub(crate) struct JsonRpcTransport {
    server_id: String,
    process: Option<ManagedProcess>,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    stdout_bytes: usize,
    messages: usize,
    last_message_bytes: usize,
    stderr_signal: Arc<Notify>,
}

impl JsonRpcTransport {
    pub(crate) fn spawn(spec: &StdioServerSpec) -> Result<Self, DiscoveryError> {
        let mut process = ManagedProcess::spawn(spec)?;
        let stdin = process.take_stdin();
        let stdout = BufReader::new(process.take_stdout());
        let stderr_signal = process.stderr_signal();
        Ok(Self {
            server_id: spec.id.clone(),
            process: Some(process),
            stdin,
            stdout,
            stdout_bytes: 0,
            messages: 0,
            last_message_bytes: 0,
            stderr_signal,
        })
    }

    pub(crate) async fn send(&mut self, value: &Value) -> Result<(), DiscoveryError> {
        let mut bytes = serde_json::to_vec(value).map_err(|_| self.invalid_rpc())?;
        if bytes.len() > MAX_MESSAGE_BYTES {
            return Err(self.error(DiscoveryErrorKind::MessageTooLarge));
        }
        bytes.push(b'\n');
        self.stdin
            .write_all(&bytes)
            .await
            .map_err(|_| self.process_error())?;
        self.stdin.flush().await.map_err(|_| self.process_error())
    }

    pub(crate) async fn receive(&mut self, timeout: Duration) -> Result<Value, DiscoveryError> {
        let stderr_signal = Arc::clone(&self.stderr_signal);
        tokio::time::timeout(timeout, async {
            tokio::select! {
                result = self.receive_inner() => result,
                () = stderr_signal.notified() => {
                    Err(DiscoveryError::new(
                        &self.server_id,
                        DiscoveryErrorKind::StderrTooLarge,
                    ))
                }
            }
        })
        .await
        .map_err(|_| self.error(DiscoveryErrorKind::Timeout))?
    }

    async fn receive_inner(&mut self) -> Result<Value, DiscoveryError> {
        if self.messages >= MAX_MESSAGES {
            return Err(self.error(DiscoveryErrorKind::TooManyMessages));
        }
        let mut bytes = Vec::new();
        loop {
            let available = match self.stdout.fill_buf().await {
                Ok(available) => available,
                Err(_) => return Err(self.process_error()),
            };
            if available.is_empty() {
                return Err(self.process_error());
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let consumed = newline.map_or(available.len(), |index| index + 1);
            if bytes.len().saturating_add(consumed) > MAX_MESSAGE_BYTES {
                return Err(self.error(DiscoveryErrorKind::MessageTooLarge));
            }
            bytes.extend_from_slice(&available[..consumed]);
            self.stdout.consume(consumed);
            if newline.is_some() {
                break;
            }
        }
        self.stdout_bytes = self.stdout_bytes.saturating_add(bytes.len());
        self.last_message_bytes = bytes.len();
        if self.stdout_bytes > MAX_STDOUT_BYTES {
            return Err(self.error(DiscoveryErrorKind::OutputTooLarge));
        }
        self.messages += 1;
        if self
            .process
            .as_ref()
            .is_some_and(ManagedProcess::stderr_exceeded)
        {
            return Err(self.error(DiscoveryErrorKind::StderrTooLarge));
        }
        if bytes.last() == Some(&b'\n') {
            bytes.pop();
        }
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
        let text =
            std::str::from_utf8(&bytes).map_err(|_| self.error(DiscoveryErrorKind::InvalidUtf8))?;
        let value = parse_json_without_duplicates(text).map_err(|_| self.invalid_rpc())?;
        validate_json_depth(&value, 1).map_err(|()| self.invalid_rpc())?;
        Ok(value)
    }

    pub(crate) async fn shutdown(mut self) -> Result<(), DiscoveryError> {
        self.stdin.shutdown().await.ok();
        drop(self.stdin);
        self.process
            .take()
            .expect("managed process is present")
            .shutdown()
            .await
    }

    pub(crate) fn server_id(&self) -> &str {
        &self.server_id
    }

    pub(crate) fn last_message_bytes(&self) -> usize {
        self.last_message_bytes
    }

    fn process_error(&mut self) -> DiscoveryError {
        if self
            .process
            .as_ref()
            .is_some_and(ManagedProcess::stderr_exceeded)
        {
            return self.error(DiscoveryErrorKind::StderrTooLarge);
        }
        self.process
            .as_mut()
            .and_then(ManagedProcess::try_status_error)
            .unwrap_or_else(|| self.error(DiscoveryErrorKind::UnexpectedEof))
    }

    fn invalid_rpc(&self) -> DiscoveryError {
        self.error(DiscoveryErrorKind::InvalidJsonRpc)
    }

    fn error(&self, kind: DiscoveryErrorKind) -> DiscoveryError {
        DiscoveryError::new(&self.server_id, kind)
    }
}

fn parse_json_without_duplicates(text: &str) -> Result<Value, serde_json::Error> {
    struct StrictValue(Value);

    impl<'de> Deserialize<'de> for StrictValue {
        fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
        where
            D: serde::Deserializer<'de>,
        {
            deserializer.deserialize_any(StrictValueVisitor)
        }
    }

    struct StrictValueVisitor;

    impl<'de> Visitor<'de> for StrictValueVisitor {
        type Value = StrictValue;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a JSON value without duplicate object fields")
        }

        fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
            Ok(StrictValue(Value::Bool(value)))
        }

        fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
            Ok(StrictValue(Value::Number(value.into())))
        }

        fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
            Ok(StrictValue(Value::Number(value.into())))
        }

        fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            serde_json::Number::from_f64(value)
                .map(Value::Number)
                .map(StrictValue)
                .ok_or_else(|| E::custom("non-finite JSON number"))
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
            Ok(StrictValue(Value::String(value.to_owned())))
        }

        fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
            Ok(StrictValue(Value::String(value)))
        }

        fn visit_none<E>(self) -> Result<Self::Value, E> {
            Ok(StrictValue(Value::Null))
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok(StrictValue(Value::Null))
        }

        fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
        where
            A: SeqAccess<'de>,
        {
            let mut values = Vec::new();
            while let Some(value) = sequence.next_element::<StrictValue>()? {
                values.push(value.0);
            }
            Ok(StrictValue(Value::Array(values)))
        }

        fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
        where
            A: MapAccess<'de>,
        {
            let mut fields = serde_json::Map::new();
            let mut names = BTreeSet::new();
            while let Some(name) = map.next_key::<String>()? {
                if !names.insert(name.clone()) {
                    return Err(serde::de::Error::custom("duplicate JSON object field"));
                }
                let value = map.next_value::<StrictValue>()?;
                fields.insert(name, value.0);
            }
            Ok(StrictValue(Value::Object(fields)))
        }
    }

    let mut deserializer = serde_json::Deserializer::from_str(text);
    let value = StrictValue::deserialize(&mut deserializer)?.0;
    deserializer.end()?;
    Ok(value)
}

fn validate_json_depth(value: &Value, depth: usize) -> Result<(), ()> {
    if depth > MAX_JSON_DEPTH {
        return Err(());
    }
    match value {
        Value::Array(array) => {
            for child in array {
                validate_json_depth(child, depth + 1)?;
            }
        }
        Value::Object(object) => {
            for child in object.values() {
                validate_json_depth(child, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}
