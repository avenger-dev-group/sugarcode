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
        if matches!(
            completed_item.item.get("type").and_then(Value::as_str),
            Some("function_call" | "custom_tool_call")
        ) {
            merged.push(completed_item.item);
        }
    }
    Ok(merged)
}

fn openai_output_item_key(item: &Value) -> Option<(String, String)> {
    let kind = item.get("type")?.as_str()?;
    let id = if matches!(kind, "function_call" | "custom_tool_call") {
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
