use crate::MAX_MESSAGE_BYTES;

pub(super) struct SseDecoder {
    buffer: Vec<u8>,
}

pub(super) struct SseEvent {
    pub(super) data: String,
    pub(super) raw_bytes: usize,
}

impl SseDecoder {
    pub(super) fn new() -> Self {
        Self { buffer: Vec::new() }
    }

    pub(super) fn push(&mut self, bytes: &[u8]) -> Result<(), ()> {
        if self.buffer.len().saturating_add(bytes.len()) > MAX_MESSAGE_BYTES {
            return Err(());
        }
        self.buffer.extend_from_slice(bytes);
        Ok(())
    }

    pub(super) fn next_event(&mut self) -> Result<Option<SseEvent>, ()> {
        loop {
            let Some((end, delimiter)) = event_boundary(&self.buffer) else {
                return Ok(None);
            };
            let raw_bytes = end + delimiter;
            let raw = self.buffer[..end].to_vec();
            self.buffer.drain(..raw_bytes);
            if let Some(event) = parse_event(&raw, raw_bytes)? {
                return Ok(Some(event));
            }
        }
    }
}

fn event_boundary(bytes: &[u8]) -> Option<(usize, usize)> {
    let lf = bytes.windows(2).position(|window| window == b"\n\n");
    let crlf = bytes.windows(4).position(|window| window == b"\r\n\r\n");
    match (lf, crlf) {
        (Some(left), Some(right)) if left <= right => Some((left, 2)),
        (Some(_), Some(right)) => Some((right, 4)),
        (Some(left), None) => Some((left, 2)),
        (None, Some(right)) => Some((right, 4)),
        (None, None) => None,
    }
}

fn parse_event(raw: &[u8], raw_bytes: usize) -> Result<Option<SseEvent>, ()> {
    let text = std::str::from_utf8(raw).map_err(|_| ())?;
    let mut event_type = None;
    let mut data = Vec::new();
    for line in text.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.starts_with(':') {
            continue;
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => event_type = Some(value),
            "data" => data.push(value),
            "id" if !value.contains('\0') => {}
            "retry" if value.bytes().all(|byte| byte.is_ascii_digit()) => {}
            "id" | "retry" => return Err(()),
            _ => {}
        }
    }
    if !matches!(event_type, None | Some("") | Some("message")) {
        return Err(());
    }
    if data.is_empty() {
        return Ok(None);
    }
    let data = data.join("\n");
    if data.len() > MAX_MESSAGE_BYTES {
        return Err(());
    }
    Ok(Some(SseEvent { data, raw_bytes }))
}
