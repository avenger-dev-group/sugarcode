use crate::ModelContinuation;
use crate::ModelError;
use crate::ModelErrorKind;
use crate::ModelEvent;
use crate::ModelFinishReason;
use crate::ModelOutputItem;
use crate::ModelOutputItemKind;
use crate::ModelProtocolCode;
use crate::ModelProtocolDiagnostic;
use crate::ModelProtocolStage;
use crate::ModelResponse;
use crate::ModelTerminalMetadata;
use crate::ModelTextPhase;
use crate::ModelToolCall;
use crate::ModelUsage;
use crate::ProviderContextEnvelope;
use crate::ProviderWireApi;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use tokio::sync::mpsc;

const MAX_SEMANTIC_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct AnthropicStreamState {
    blocks: BTreeMap<u32, AnthropicBlock>,
    message_id: Option<String>,
    stop_reason: Option<String>,
    input_tokens: Option<u64>,
    cached_input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    semantic_bytes: usize,
}

enum AnthropicBlock {
    Text(String),
    Thinking {
        thinking: String,
        signature: String,
    },
    RedactedThinking {
        data: String,
    },
    Tool {
        id: String,
        name: String,
        arguments: String,
    },
}

impl AnthropicStreamState {
    pub(crate) async fn consume(
        &mut self,
        event_name: &str,
        value: Value,
        sender: &mpsc::Sender<Result<ModelEvent, ModelError>>,
    ) -> Result<(), ModelError> {
        match event_name {
            "message_start" => {
                self.message_id = value
                    .pointer("/message/id")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
                if let Some(usage) = value.pointer("/message/usage") {
                    self.input_tokens = u64_field(usage, "input_tokens");
                    self.cached_input_tokens = u64_field(usage, "cache_read_input_tokens");
                }
            }
            "content_block_start" => {
                let index = u32_field(&value, "index").ok_or_else(protocol_error)?;
                let block = value.get("content_block").ok_or_else(protocol_error)?;
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let text = block
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        self.add_bytes(text.len())?;
                        self.blocks
                            .insert(index, AnthropicBlock::Text(text.to_owned()));
                        if !text.is_empty() {
                            send_text_delta(sender, 0, text).await?;
                        }
                    }
                    Some("tool_use") => {
                        self.blocks.insert(
                            index,
                            AnthropicBlock::Tool {
                                id: required_string(block, "id")?.to_owned(),
                                name: required_string(block, "name")?.to_owned(),
                                arguments: String::new(),
                            },
                        );
                    }
                    Some("thinking") => {
                        let thinking = block
                            .get("thinking")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned();
                        let signature = block
                            .get("signature")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned();
                        self.add_bytes(thinking.len().saturating_add(signature.len()))?;
                        self.blocks.insert(
                            index,
                            AnthropicBlock::Thinking {
                                thinking,
                                signature,
                            },
                        );
                    }
                    Some("redacted_thinking") => {
                        let data = required_string(block, "data")?.to_owned();
                        self.add_bytes(data.len())?;
                        self.blocks
                            .insert(index, AnthropicBlock::RedactedThinking { data });
                    }
                    _ => {
                        return Err(ModelError::new(ModelErrorKind::UnsupportedOutput, false));
                    }
                }
            }
            "content_block_delta" => {
                let index = u32_field(&value, "index").ok_or_else(protocol_error)?;
                let delta = value.get("delta").ok_or_else(protocol_error)?;
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        let text = required_string(delta, "text")?;
                        self.add_bytes(text.len())?;
                        match self.blocks.get_mut(&index) {
                            Some(AnthropicBlock::Text(current)) => current.push_str(text),
                            _ => return Err(protocol_error()),
                        }
                        send_text_delta(sender, 0, text).await?;
                    }
                    Some("input_json_delta") => {
                        let partial = required_string(delta, "partial_json")?;
                        self.add_bytes(partial.len())?;
                        match self.blocks.get_mut(&index) {
                            Some(AnthropicBlock::Tool { arguments, .. }) => {
                                arguments.push_str(partial);
                            }
                            _ => return Err(protocol_error()),
                        }
                    }
                    Some("thinking_delta") => {
                        let partial = required_string(delta, "thinking")?;
                        self.add_bytes(partial.len())?;
                        match self.blocks.get_mut(&index) {
                            Some(AnthropicBlock::Thinking { thinking, .. }) => {
                                thinking.push_str(partial);
                            }
                            _ => return Err(protocol_error()),
                        }
                    }
                    Some("signature_delta") => {
                        let partial = required_string(delta, "signature")?;
                        self.add_bytes(partial.len())?;
                        match self.blocks.get_mut(&index) {
                            Some(AnthropicBlock::Thinking { signature, .. }) => {
                                signature.push_str(partial);
                            }
                            _ => return Err(protocol_error()),
                        }
                    }
                    _ => return Err(protocol_error()),
                }
            }
            "message_delta" => {
                self.stop_reason = value
                    .pointer("/delta/stop_reason")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .or_else(|| self.stop_reason.take());
                if let Some(usage) = value.get("usage") {
                    self.output_tokens = u64_field(usage, "output_tokens");
                }
            }
            "error" => return Err(ModelError::new(ModelErrorKind::Server, false)),
            _ => {}
        }
        Ok(())
    }

    fn add_bytes(&mut self, bytes: usize) -> Result<(), ModelError> {
        self.semantic_bytes = self.semantic_bytes.saturating_add(bytes);
        if self.semantic_bytes > MAX_SEMANTIC_OUTPUT_BYTES {
            Err(ModelError::new(ModelErrorKind::OutputTooLarge, false))
        } else {
            Ok(())
        }
    }

    pub(crate) fn response(
        &self,
        tool_names: &BTreeMap<String, String>,
    ) -> Result<ModelResponse, ModelError> {
        let mut output = Vec::new();
        let mut raw_blocks = Vec::new();
        for block in self.blocks.values() {
            match block {
                AnthropicBlock::Text(text) => {
                    raw_blocks.push(json!({"type": "text", "text": text}));
                    if !text.is_empty() {
                        push_text(&mut output, text);
                    }
                }
                AnthropicBlock::Thinking {
                    thinking,
                    signature,
                } => raw_blocks.push(json!({
                    "type": "thinking",
                    "thinking": thinking,
                    "signature": signature,
                })),
                AnthropicBlock::RedactedThinking { data } => raw_blocks.push(json!({
                    "type": "redacted_thinking",
                    "data": data,
                })),
                AnthropicBlock::Tool {
                    id,
                    name,
                    arguments,
                } => {
                    let raw_arguments = serde_json::from_str::<Value>(arguments)
                        .map_err(|_| ModelError::new(ModelErrorKind::Protocol, false))?;
                    raw_blocks.push(json!({
                        "type": "tool_use",
                        "id": id,
                        "name": name,
                        "input": raw_arguments,
                    }));
                    let arguments = serde_json::from_str(arguments)
                        .map_err(|_| ModelError::new(ModelErrorKind::Protocol, false))?;
                    push_tool(
                        &mut output,
                        id,
                        tool_names.get(name).map_or(name.as_str(), String::as_str),
                        arguments,
                    );
                }
            }
        }
        let mut response = complete_response(
            output,
            usage_from_parts(
                self.input_tokens,
                self.cached_input_tokens,
                self.output_tokens,
                None,
            ),
        )?;
        response.terminal = ModelTerminalMetadata {
            finish_reason: match self.stop_reason.as_deref() {
                Some("end_turn" | "stop_sequence") => {
                    if self.stop_reason.as_deref() == Some("stop_sequence") {
                        ModelFinishReason::StopSequence
                    } else {
                        ModelFinishReason::Stop
                    }
                }
                Some("tool_use") => ModelFinishReason::ToolCalls,
                Some("max_tokens") => ModelFinishReason::MaxTokens,
                Some(reason) => ModelFinishReason::Unknown(reason.to_owned()),
                None => ModelFinishReason::Unknown("missing".to_owned()),
            },
            provider_request_id: self.message_id.clone(),
            continuation: if self
                .blocks
                .values()
                .any(|block| matches!(block, AnthropicBlock::Tool { .. }))
            {
                ModelContinuation::ToolCalls
            } else {
                ModelContinuation::Complete
            },
        };
        response.provider_context =
            Some(Box::new(ProviderContextEnvelope::new_with_replay_tokens(
                ProviderWireApi::AnthropicMessages,
                self.message_id.clone(),
                serde_json::to_vec(&raw_blocks).map_err(|_| protocol_error())?,
                self.output_tokens,
            )?));
        Ok(response)
    }
}

fn complete_response(
    output: Vec<ModelOutputItem>,
    usage: Option<ModelUsage>,
) -> Result<ModelResponse, ModelError> {
    if output.is_empty() {
        Err(ModelError::new(ModelErrorKind::Incomplete, false))
    } else {
        let continuation = if output
            .iter()
            .any(|item| matches!(item.kind, ModelOutputItemKind::ToolCall(_)))
        {
            ModelContinuation::ToolCalls
        } else {
            ModelContinuation::Complete
        };
        Ok(normalize_response_output(ModelResponse {
            output,
            usage,
            terminal: ModelTerminalMetadata::completed(continuation),
            provider_context: None,
        }))
    }
}

fn normalize_response_output(mut response: ModelResponse) -> ModelResponse {
    let has_tool_calls = response
        .output
        .iter()
        .any(|item| matches!(item.kind, ModelOutputItemKind::ToolCall(_)));
    for (index, item) in response.output.iter_mut().enumerate() {
        item.output_index = u32::try_from(index).unwrap_or(u32::MAX);
        if let ModelOutputItemKind::AssistantText { phase, .. } = &mut item.kind {
            *phase = if has_tool_calls {
                ModelTextPhase::Commentary
            } else {
                ModelTextPhase::Final
            };
        }
    }
    response
}

fn usage_from_parts(
    input_tokens: Option<u64>,
    cached_input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    reasoning_output_tokens: Option<u64>,
) -> Option<ModelUsage> {
    if input_tokens.is_none() && output_tokens.is_none() {
        return None;
    }
    Some(ModelUsage {
        input_tokens,
        cached_input_tokens,
        output_tokens,
        reasoning_output_tokens,
        total_tokens: input_tokens
            .zip(output_tokens)
            .and_then(|(input, output)| input.checked_add(output)),
    })
}

async fn send_text_delta(
    sender: &mpsc::Sender<Result<ModelEvent, ModelError>>,
    output_index: u32,
    delta: &str,
) -> Result<(), ModelError> {
    sender
        .send(Ok(ModelEvent::OutputTextDelta {
            output_index,
            delta: delta.to_owned(),
        }))
        .await
        .map_err(|_| ModelError::new(ModelErrorKind::Disconnected, false))
}

fn push_text(items: &mut Vec<ModelOutputItem>, text: &str) {
    if text.is_empty() {
        return;
    }
    items.push(ModelOutputItem {
        output_index: u32::try_from(items.len()).unwrap_or(u32::MAX),
        kind: ModelOutputItemKind::AssistantText {
            phase: ModelTextPhase::Final,
            text: text.to_owned(),
        },
    });
}

fn push_tool(items: &mut Vec<ModelOutputItem>, id: &str, name: &str, arguments: Value) {
    items.push(ModelOutputItem {
        output_index: u32::try_from(items.len()).unwrap_or(u32::MAX),
        kind: ModelOutputItemKind::ToolCall(ModelToolCall {
            id: id.to_owned(),
            name: name.to_owned(),
            arguments,
        }),
    });
}

fn required_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, ModelError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(protocol_error)
}

fn u64_field(value: &Value, field: &str) -> Option<u64> {
    value.get(field).and_then(Value::as_u64)
}

fn u32_field(value: &Value, field: &str) -> Option<u32> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
}

fn protocol_error() -> ModelError {
    ModelError::new(ModelErrorKind::Protocol, false).with_protocol_diagnostic(
        ModelProtocolDiagnostic::from_json_shape(
            ModelProtocolStage::ResponseAssembly,
            ModelProtocolCode::InvalidEventShape,
            None,
            &Value::Null,
        ),
    )
}
