use crate::ModelMessage;
use crate::ModelRequest;
use crate::ModelToolCall;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

const MAX_WIRE_TOOL_NAME_BYTES: usize = 64;
const MAX_WIRE_CALL_ID_BYTES: usize = 64;

pub(crate) struct NormalizedRequest {
    pub request: ModelRequest,
    wire_to_internal: BTreeMap<String, String>,
}

impl NormalizedRequest {
    #[cfg(test)]
    pub fn internal_tool_name<'a>(&'a self, wire_name: &'a str) -> &'a str {
        self.wire_to_internal
            .get(wire_name)
            .map_or(wire_name, String::as_str)
    }

    pub fn into_parts(self) -> (ModelRequest, BTreeMap<String, String>) {
        (self.request, self.wire_to_internal)
    }
}

pub(crate) fn normalize_request(mut request: ModelRequest) -> NormalizedRequest {
    let mut names = request
        .tools
        .iter()
        .map(|tool| tool.name.clone())
        .collect::<BTreeSet<_>>();
    for message in &request.messages {
        match message {
            ModelMessage::ToolCall(call) => {
                names.insert(call.name.clone());
            }
            ModelMessage::ToolCallBatch(calls) => {
                names.extend(calls.iter().map(|call| call.name.clone()));
            }
            _ => {}
        }
    }
    let mut used = BTreeMap::<String, String>::new();
    let mut internal_to_wire = BTreeMap::<String, String>::new();
    for name in names {
        let base = sanitized_tool_name(&name);
        let wire = match used.get(&base) {
            None => base,
            Some(existing) if existing == &name => base,
            Some(_) => with_hash_suffix(&base, &name),
        };
        used.insert(wire.clone(), name.clone());
        internal_to_wire.insert(name, wire);
    }
    for tool in &mut request.tools {
        if let Some(wire) = internal_to_wire.get(&tool.name) {
            tool.name.clone_from(wire);
        }
    }
    for message in &mut request.messages {
        match message {
            ModelMessage::ToolCall(call) => normalize_call(call, &internal_to_wire),
            ModelMessage::ToolCallBatch(calls) => {
                for call in calls {
                    normalize_call(call, &internal_to_wire);
                }
            }
            ModelMessage::ToolResult { call_id, .. } => {
                *call_id = normalized_call_id(call_id);
            }
            _ => {}
        }
    }
    NormalizedRequest {
        request,
        wire_to_internal: internal_to_wire
            .into_iter()
            .map(|(internal, wire)| (wire, internal))
            .collect(),
    }
}

fn normalize_call(call: &mut ModelToolCall, names: &BTreeMap<String, String>) {
    if let Some(wire) = names.get(&call.name) {
        call.name.clone_from(wire);
    }
    call.id = normalized_call_id(&call.id);
}

fn sanitized_tool_name(name: &str) -> String {
    let mut value = name
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-') {
                char::from(byte)
            } else {
                '_'
            }
        })
        .collect::<String>();
    if value.is_empty() {
        value.push_str("tool");
    }
    value.truncate(MAX_WIRE_TOOL_NAME_BYTES);
    value
}

fn with_hash_suffix(base: &str, internal: &str) -> String {
    let suffix = format!("_{}", hash8(internal.as_bytes()));
    let keep = MAX_WIRE_TOOL_NAME_BYTES.saturating_sub(suffix.len());
    format!("{}{}", &base[..base.len().min(keep)], suffix)
}

fn normalized_call_id(call_id: &str) -> String {
    if !call_id.is_empty()
        && call_id.len() <= MAX_WIRE_CALL_ID_BYTES
        && call_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        call_id.to_owned()
    } else {
        format!("call_{}", hash8(call_id.as_bytes()))
    }
}

fn hash8(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest[..4]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ModelToolDefinition;

    #[test]
    fn normalizes_colliding_names_and_pairs_historical_call_ids() {
        let request = ModelRequest {
            model: "fixture".to_owned(),
            instructions: Vec::new(),
            tools: vec![
                ModelToolDefinition {
                    name: "workspace/read".to_owned(),
                    description: "read".to_owned(),
                    parameters: serde_json::json!({"type": "object"}),
                },
                ModelToolDefinition {
                    name: "workspace_read".to_owned(),
                    description: "collision".to_owned(),
                    parameters: serde_json::json!({"type": "object"}),
                },
            ],
            messages: vec![
                ModelMessage::ToolCall(ModelToolCall {
                    id: "call/with/slashes".to_owned(),
                    name: "workspace/read".to_owned(),
                    arguments: serde_json::json!({"path": "README.md"}),
                }),
                ModelMessage::ToolResult {
                    call_id: "call/with/slashes".to_owned(),
                    content: "ok".to_owned(),
                },
            ],
        };
        let normalized = normalize_request(request);
        assert_eq!(normalized.request.tools[0].name, "workspace_read");
        assert_ne!(
            normalized.request.tools[0].name,
            normalized.request.tools[1].name
        );
        assert_eq!(
            normalized.internal_tool_name(&normalized.request.tools[0].name),
            "workspace/read"
        );
        let ModelMessage::ToolCall(call) = &normalized.request.messages[0] else {
            panic!("tool call");
        };
        let ModelMessage::ToolResult { call_id, .. } = &normalized.request.messages[1] else {
            panic!("tool result");
        };
        assert_eq!(call.id, *call_id);
        assert!(call.id.starts_with("call_"));
    }
}
