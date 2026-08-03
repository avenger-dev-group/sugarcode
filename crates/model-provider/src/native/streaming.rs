use super::*;
use std::collections::BTreeSet;

#[derive(Default)]
pub(super) struct OpenAiStreamState {
    output_items: Vec<CompletedOpenAiOutputItem>,
    text_previews: BTreeMap<u32, String>,
    canonical_preview_indices: BTreeMap<u32, u32>,
    suppressed_text_previews: BTreeSet<u32>,
}

struct CompletedOpenAiOutputItem {
    output_index: Option<usize>,
    item: Value,
}

impl OpenAiStreamState {
    pub(super) async fn consume(
        &mut self,
        event_name: &str,
        value: Value,
        sender: &mpsc::Sender<Result<ModelEvent, ModelError>>,
        tool_names: &BTreeMap<String, String>,
    ) -> Result<StreamProgress, ModelError> {
        let kind = if event_name.is_empty() || event_name == "message" {
            value
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
        } else {
            event_name
        };
        match kind {
            "response.output_text.delta" => {
                let provider_output_index = u32_field(&value, "output_index").unwrap_or(0);
                if self
                    .suppressed_text_previews
                    .contains(&provider_output_index)
                {
                    return Ok(StreamProgress::Continue);
                }
                let next_canonical_index =
                    u32::try_from(self.canonical_preview_indices.len()).unwrap_or(u32::MAX);
                let output_index = *self
                    .canonical_preview_indices
                    .entry(provider_output_index)
                    .or_insert(next_canonical_index);
                let delta = required_string(&value, "delta")?;
                let preview = self.text_previews.entry(provider_output_index).or_default();
                let normalized = if delta.starts_with(preview.as_str()) {
                    let suffix = delta[preview.len()..].to_owned();
                    *preview = delta.to_owned();
                    suffix
                } else {
                    preview.push_str(delta);
                    delta.to_owned()
                };
                if preview.len() > MAX_SEMANTIC_OUTPUT_BYTES {
                    self.text_previews.remove(&provider_output_index);
                    self.suppressed_text_previews.insert(provider_output_index);
                    return Ok(StreamProgress::Continue);
                }
                if !normalized.is_empty() {
                    send_text_delta(sender, output_index, &normalized).await?;
                }
                Ok(StreamProgress::Continue)
            }
            "response.output_item.done" => {
                let item = value.get("item").cloned().ok_or_else(|| {
                    protocol_error_for_json(
                        ModelProtocolStage::StreamEvent,
                        ModelProtocolCode::InvalidEventShape,
                        Some(kind),
                        &value,
                    )
                })?;
                let output_index = value
                    .get("output_index")
                    .map(|index| {
                        index
                            .as_u64()
                            .and_then(|index| usize::try_from(index).ok())
                            .ok_or_else(|| {
                                protocol_error_for_json(
                                    ModelProtocolStage::StreamEvent,
                                    ModelProtocolCode::InvalidEventShape,
                                    Some(kind),
                                    &value,
                                )
                            })
                    })
                    .transpose()?;
                self.output_items
                    .push(CompletedOpenAiOutputItem { output_index, item });
                Ok(StreamProgress::Continue)
            }
            "response.completed" => {
                let mut response = value.get("response").cloned().ok_or_else(protocol_error)?;
                if !self.output_items.is_empty() {
                    let snapshot = response
                        .get("output")
                        .and_then(Value::as_array)
                        .ok_or_else(protocol_error)?;
                    let completed = std::mem::take(&mut self.output_items);
                    // The completed response is the semantic source of truth.
                    // Done items are only a recovery source for gateways that
                    // omit the output snapshot entirely or return it empty.
                    let output = if snapshot.is_empty() {
                        reconcile_openai_output_items(snapshot, completed)?
                    } else {
                        snapshot.to_vec()
                    };
                    response
                        .as_object_mut()
                        .ok_or_else(protocol_error)?
                        .insert("output".to_owned(), Value::Array(output));
                }
                let response = normalize_response_output(parse_openai_response(response)?);
                let response = map_response_tool_names(response, tool_names);
                Ok(StreamProgress::Complete(Box::new(response)))
            }
            "response.failed" | "response.incomplete" | "error" => Err(ModelError::new(
                if kind == "response.incomplete" {
                    ModelErrorKind::Incomplete
                } else {
                    ModelErrorKind::Server
                },
                false,
            )),
            "response.created"
            | "response.in_progress"
            | "response.output_item.added"
            | "response.content_part.added"
            | "response.content_part.done"
            | "response.output_text.done"
            | "response.function_call_arguments.delta"
            | "response.function_call_arguments.done"
            | "response.reasoning_summary_part.added"
            | "response.reasoning_summary_part.done"
            | "response.reasoning_summary_text.delta"
            | "response.reasoning_summary_text.done" => Ok(StreamProgress::Continue),
            // Lifecycle and usage come from response.completed; output items
            // come from output_item.done. Optional progress events are ignored.
            kind if kind.starts_with("response.") => Ok(StreamProgress::Continue),
            _ if value.get("choices").is_some() || event_name == "message" => {
                Err(protocol_error_for_json(
                    ModelProtocolStage::StreamEvent,
                    ModelProtocolCode::WireMismatch,
                    Some(event_name),
                    &value,
                ))
            }
            _ => Err(ModelError::new(ModelErrorKind::UnsupportedOutput, false)),
        }
    }
}

fn reconcile_openai_output_items(
    snapshot: &[Value],
    completed: Vec<CompletedOpenAiOutputItem>,
) -> Result<Vec<Value>, ModelError> {
    let diagnostic_shape = json!({
        "snapshot": snapshot,
        "completed": completed
            .iter()
            .map(|item| json!({
                "output_index": item.output_index,
                "item": &item.item,
            }))
            .collect::<Vec<_>>(),
    });
    let ambiguous = || {
        protocol_error_for_json(
            ModelProtocolStage::ResponseAssembly,
            ModelProtocolCode::AmbiguousOutputReconciliation,
            Some("response.completed"),
            &diagnostic_shape,
        )
    };
    // The completed response is the semantic source of truth. Streamed done
    // items are only a recovery source when a gateway omitted the response
    // output entirely. Their numeric output_index is never used to reorder or
    // reject an otherwise coherent completed response.
    if snapshot.is_empty() {
        let mut recovered = Vec::new();
        let mut stable_items = BTreeMap::<(String, String), Value>::new();
        for completed_item in completed {
            if let Some(key) = openai_output_item_key(&completed_item.item) {
                match stable_items.get(&key) {
                    Some(existing) if existing == &completed_item.item => continue,
                    Some(_) => return Err(ambiguous()),
                    None => {
                        stable_items.insert(key, completed_item.item.clone());
                    }
                }
            }
            recovered.push(completed_item.item);
        }
        return Ok(recovered);
    }
    let mut merged = snapshot.to_vec();
    let mut snapshot_keys = BTreeMap::<(String, String), usize>::new();
    for (index, item) in snapshot.iter().enumerate() {
        if let Some(key) = openai_output_item_key(item)
            && snapshot_keys.insert(key, index).is_some()
        {
            return Err(ambiguous());
        }
    }
    for completed_item in completed {
        let Some(key) = openai_output_item_key(&completed_item.item) else {
            continue;
        };
        if let Some(index) = snapshot_keys.get(&key).copied() {
            if !openai_output_items_same_kind(&merged[index], &completed_item.item) {
                return Err(ambiguous());
            }
            continue;
        }
        // Preserve a stable function call that the gateway streamed but
        // accidentally omitted from response.completed. Text/commentary is
        // intentionally not appended because the completed snapshot owns the
        // visible answer.
        if completed_item.item.get("type").and_then(Value::as_str) == Some("function_call") {
            merged.push(completed_item.item);
        }
    }
    Ok(merged)
}

fn openai_output_item_key(item: &Value) -> Option<(String, String)> {
    let kind = item.get("type")?.as_str()?;
    let id = if kind == "function_call" {
        item.get("call_id")
            .and_then(Value::as_str)
            .or_else(|| item.get("id").and_then(Value::as_str))?
    } else {
        item.get("id")
            .and_then(Value::as_str)
            .or_else(|| item.get("call_id").and_then(Value::as_str))?
    };
    Some((kind.to_owned(), id.to_owned()))
}

fn openai_output_items_same_kind(snapshot: &Value, completed: &Value) -> bool {
    snapshot.get("type").and_then(Value::as_str) == completed.get("type").and_then(Value::as_str)
}

#[derive(Default)]
pub(super) struct AnthropicStreamState {
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
    pub(super) async fn consume(
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

    pub(super) fn response(
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

pub(super) struct GeminiStreamState {
    output: Vec<ModelOutputItem>,
    raw_parts: Vec<Value>,
    usage: Option<ModelUsage>,
    semantic_bytes: usize,
    finish_reason: Option<String>,
    provider_request_id: Option<String>,
}

impl Default for GeminiStreamState {
    fn default() -> Self {
        Self::new(true)
    }
}

impl GeminiStreamState {
    pub(super) fn new(_parallel_tools: bool) -> Self {
        Self {
            output: Vec::new(),
            raw_parts: Vec::new(),
            usage: None,
            semantic_bytes: 0,
            finish_reason: None,
            provider_request_id: None,
        }
    }

    pub(super) async fn consume(
        &mut self,
        value: Value,
        sender: &mpsc::Sender<Result<ModelEvent, ModelError>>,
        tool_names: &BTreeMap<String, String>,
    ) -> Result<(), ModelError> {
        if let Some(reason) = value
            .pointer("/promptFeedback/blockReason")
            .and_then(Value::as_str)
        {
            return Err(ModelError::new(
                if reason == "SAFETY" {
                    ModelErrorKind::Filtered
                } else {
                    ModelErrorKind::UnsupportedOutput
                },
                false,
            ));
        }
        if value
            .get("candidates")
            .and_then(Value::as_array)
            .is_some_and(|candidates| candidates.len() > 1)
        {
            return Err(ModelError::new(ModelErrorKind::UnsupportedOutput, false));
        }
        self.provider_request_id = value
            .get("responseId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| self.provider_request_id.take());
        self.finish_reason = value
            .pointer("/candidates/0/finishReason")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| self.finish_reason.take());
        if let Some(parts) = value
            .pointer("/candidates/0/content/parts")
            .and_then(Value::as_array)
        {
            for part in parts {
                self.raw_parts.push(part.clone());
                if part.get("thought").and_then(Value::as_bool) == Some(true) {
                    continue;
                }
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    let (output_index, delta) = self.push_text_chunk(text)?;
                    if !delta.is_empty() {
                        send_text_delta(sender, output_index, &delta).await?;
                    }
                } else if let Some(call) = part.get("functionCall") {
                    let index = self.output.len();
                    let id = call
                        .get("id")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                        .unwrap_or_else(|| format!("gemini_call_{index}"));
                    let wire_name = required_string(call, "name")?;
                    let name = tool_names.get(wire_name).map_or(wire_name, String::as_str);
                    let arguments = call.get("args").cloned().unwrap_or_else(|| json!({}));
                    self.add_bytes(
                        id.len()
                            .saturating_add(name.len())
                            .saturating_add(arguments.to_string().len()),
                    )?;
                    push_tool(&mut self.output, &id, name, arguments);
                } else {
                    return Err(ModelError::new(ModelErrorKind::UnsupportedOutput, false));
                }
            }
        }
        if let Some(usage) = value.get("usageMetadata") {
            self.usage = Some(ModelUsage {
                input_tokens: u64_field(usage, "promptTokenCount"),
                cached_input_tokens: u64_field(usage, "cachedContentTokenCount"),
                output_tokens: u64_field(usage, "candidatesTokenCount"),
                reasoning_output_tokens: u64_field(usage, "thoughtsTokenCount"),
                total_tokens: u64_field(usage, "totalTokenCount"),
            });
        }
        Ok(())
    }

    fn push_text_chunk(&mut self, chunk: &str) -> Result<(u32, String), ModelError> {
        let last_text = self.output.last().and_then(|item| match &item.kind {
            ModelOutputItemKind::AssistantText { text, .. } => {
                Some((item.output_index, text.as_str()))
            }
            ModelOutputItemKind::ToolCall(_) => None,
        });
        let Some((output_index, current)) = last_text else {
            self.add_bytes(chunk.len())?;
            push_text(&mut self.output, chunk);
            let output_index = self
                .output
                .last()
                .map(|item| item.output_index)
                .unwrap_or(0);
            return Ok((output_index, chunk.to_owned()));
        };
        let (delta, cumulative) = if let Some(delta) = chunk.strip_prefix(current) {
            (delta.to_owned(), true)
        } else {
            (chunk.to_owned(), false)
        };
        self.add_bytes(delta.len())?;
        let Some(ModelOutputItem {
            kind: ModelOutputItemKind::AssistantText { text, .. },
            ..
        }) = self.output.last_mut()
        else {
            return Err(protocol_error());
        };
        if cumulative {
            *text = chunk.to_owned();
        } else {
            text.push_str(chunk);
        }
        Ok((output_index, delta))
    }

    fn add_bytes(&mut self, bytes: usize) -> Result<(), ModelError> {
        self.semantic_bytes = self.semantic_bytes.saturating_add(bytes);
        if self.semantic_bytes > MAX_SEMANTIC_OUTPUT_BYTES {
            Err(ModelError::new(ModelErrorKind::OutputTooLarge, false))
        } else {
            Ok(())
        }
    }

    pub(super) fn response(&self) -> Result<ModelResponse, ModelError> {
        let tool_call_count = self
            .output
            .iter()
            .filter(|item| matches!(item.kind, ModelOutputItemKind::ToolCall(_)))
            .count();
        let mut response = complete_response(self.output.clone(), self.usage)?;
        response.terminal = ModelTerminalMetadata {
            finish_reason: match self.finish_reason.as_deref() {
                Some("STOP") => ModelFinishReason::Stop,
                Some("MAX_TOKENS") => ModelFinishReason::MaxTokens,
                Some("SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT") => {
                    ModelFinishReason::Safety
                }
                Some(reason) => ModelFinishReason::Unknown(reason.to_owned()),
                None if tool_call_count > 0 => ModelFinishReason::ToolCalls,
                // Gemini streaming uses a clean HTTP/SSE EOF as its normal
                // transport terminator. Semantic output is sufficient
                // terminal evidence when the final chunk omits finishReason.
                None => ModelFinishReason::Stop,
            },
            provider_request_id: self.provider_request_id.clone(),
            continuation: if tool_call_count > 0 {
                ModelContinuation::ToolCalls
            } else {
                ModelContinuation::Complete
            },
        };
        response.provider_context =
            Some(Box::new(ProviderContextEnvelope::new_with_replay_tokens(
                ProviderWireApi::GeminiGenerateContent,
                self.provider_request_id.clone(),
                serde_json::to_vec(&json!({
                    "role": "model",
                    "parts": self.raw_parts,
                }))
                .map_err(|_| protocol_error())?,
                self.usage.and_then(|usage| usage.output_tokens),
            )?));
        Ok(response)
    }
}
