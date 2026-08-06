use super::*;

fn rendered_instructions(request: &ModelRequest) -> String {
    request
        .instructions
        .iter()
        .map(|instruction| instruction.rendered_content())
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub(super) fn openai_request(
    request: &ModelRequest,
    strict_tools: ModelStrictToolsMode,
    parallel_tools: bool,
    max_output_tokens: u32,
) -> Result<Value, ModelError> {
    openai_request_with_custom_call_ids(
        request,
        strict_tools,
        parallel_tools,
        max_output_tokens,
        &std::collections::BTreeSet::new(),
    )
}

fn openai_request_with_custom_call_ids(
    request: &ModelRequest,
    strict_tools: ModelStrictToolsMode,
    parallel_tools: bool,
    max_output_tokens: u32,
    inherited_custom_call_ids: &std::collections::BTreeSet<String>,
) -> Result<Value, ModelError> {
    let freeform_fallbacks = request
        .tools
        .iter()
        .filter_map(|tool| {
            tool.freeform
                .as_ref()
                .map(|freeform| (tool.name.clone(), freeform.fallback_argument.clone()))
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut custom_call_ids = custom_call_ids(request, &freeform_fallbacks)?;
    custom_call_ids.extend(inherited_custom_call_ids.iter().cloned());
    let input = request
        .messages
        .iter()
        .map(|message| openai_input_items(message, &freeform_fallbacks, &custom_call_ids))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let tools = request
        .tools
        .iter()
        .map(|tool| {
            if let Some(freeform) = &tool.freeform {
                return Ok(json!({
                    "type": "custom",
                    "name": tool.name,
                    "description": tool.description,
                    "format": {
                        "type": "grammar",
                        "syntax": freeform.syntax.as_str(),
                        "definition": freeform.definition,
                    },
                }));
            }
            let strict = crate::tool_schema::strict_for_tool(
                &tool.name,
                &tool.parameters,
                crate::tool_schema::ToolSchemaDialect::OpenAi,
                strict_tools,
            )?;
            let mut definition = json!({
                "type": "function",
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            });
            if strict_tools != ModelStrictToolsMode::Disabled {
                definition["strict"] = Value::Bool(strict);
            }
            Ok(definition)
        })
        .collect::<Result<Vec<_>, ModelError>>()?;
    let mut body = json!({
        "model": request.model,
        "instructions": rendered_instructions(request),
        "input": input,
        "tools": tools,
        "max_output_tokens": max_output_tokens,
        "store": false,
        "stream": true,
        "include": ["reasoning.encrypted_content"],
    });
    if !request.tools.is_empty() {
        body["parallel_tool_calls"] = Value::Bool(parallel_tools);
    }
    Ok(body)
}

pub(super) fn openai_provider_managed_request(
    request: &ModelRequest,
    strict_tools: ModelStrictToolsMode,
    parallel_tools: bool,
    max_output_tokens: u32,
) -> Result<Value, ModelError> {
    let freeform_fallbacks = request
        .tools
        .iter()
        .filter_map(|tool| {
            tool.freeform
                .as_ref()
                .map(|freeform| (tool.name.clone(), freeform.fallback_argument.clone()))
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    let custom_call_ids = custom_call_ids(request, &freeform_fallbacks)?;
    let mut previous_response_id = None;
    let mut tail_start = 0usize;
    for (index, message) in request.messages.iter().enumerate() {
        if let Some(context) = sole_provider_context(message)? {
            ensure_context_wire(context, ProviderWireApi::OpenAiResponses)?;
            if let Some(response_id) = context.response_id() {
                previous_response_id = Some(response_id.to_owned());
                tail_start = index.saturating_add(1);
            }
        }
    }
    let mut managed_request = request.clone();
    if previous_response_id.is_some() {
        managed_request.messages = request.messages[tail_start..].to_vec();
    }
    let mut body = openai_request_with_custom_call_ids(
        &managed_request,
        strict_tools,
        parallel_tools,
        max_output_tokens,
        &custom_call_ids,
    )?;
    body["store"] = Value::Bool(true);
    if let Some(previous_response_id) = previous_response_id {
        body["previous_response_id"] = Value::String(previous_response_id);
    }
    Ok(body)
}

fn openai_input_items(
    message: &ModelMessage,
    freeform_fallbacks: &std::collections::BTreeMap<String, String>,
    custom_call_ids: &std::collections::BTreeSet<String>,
) -> Result<Vec<Value>, ModelError> {
    if let Some(context) = sole_provider_context(message)? {
        ensure_context_wire(context, ProviderWireApi::OpenAiResponses)?;
        return serde_json::from_slice::<Vec<Value>>(&context.payload()?)
            .map_err(|_| protocol_error());
    }
    if message.role == ModelRole::User
        && message.content.iter().any(|part| {
            matches!(
                part,
                ModelContentPart::ImageAsset(_) | ModelContentPart::PdfDocument(_)
            )
        })
    {
        let content = message
            .content
            .iter()
            .map(|part| match part {
                ModelContentPart::Text { text, .. }
                | ModelContentPart::ContextCompaction { content: text } => {
                    Ok(json!({"type": "input_text", "text": text}))
                }
                ModelContentPart::ImageAsset(asset) => Ok(json!({
                    "type": "input_image",
                    "image_url": data_url(&asset.media_type, &asset.bytes),
                })),
                ModelContentPart::PdfDocument(asset) => Ok(json!({
                    "type": "input_file",
                    "filename": asset.original_name,
                    "file_data": data_url(&asset.media_type, &asset.bytes),
                })),
                ModelContentPart::ToolCall { .. }
                | ModelContentPart::ToolResult { .. }
                | ModelContentPart::ProviderContext(_) => Err(protocol_error()),
            })
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(vec![json!({"role": "user", "content": content})]);
    }
    message
        .content
        .iter()
        .map(|part| match part {
            ModelContentPart::Text { text, .. } => Ok(json!({
                "role": match message.role {
                    ModelRole::User => "user",
                    ModelRole::Assistant => "assistant",
                },
                "content": text,
            })),
            ModelContentPart::ContextCompaction { content } => Ok(json!({
                "role": "user",
                "content": content,
            })),
            ModelContentPart::ToolCall { call } => Ok(openai_tool_call(
                call,
                freeform_fallbacks
                    .get(call.name.as_str())
                    .map(String::as_str),
            )),
            ModelContentPart::ToolResult { result } => {
                let kind = if custom_call_ids.contains(result.call_id.as_str()) {
                    "custom_tool_call_output"
                } else {
                    "function_call_output"
                };
                Ok(json!({
                    "type": kind,
                    "call_id": result.call_id,
                    "output": tool_result_text(&result.content),
                }))
            }
            ModelContentPart::ImageAsset(_) | ModelContentPart::PdfDocument(_) => {
                Err(ModelError::new(ModelErrorKind::InvalidRequest, false))
            }
            ModelContentPart::ProviderContext(_) => Err(protocol_error()),
        })
        .collect()
}

fn openai_tool_call(call: &ModelToolCall, fallback_argument: Option<&str>) -> Value {
    if let Some(fallback_argument) = fallback_argument
        && call.arguments.is_string()
    {
        json!({
            "type": "custom_tool_call",
            "call_id": call.id,
            "name": call.name,
            "input": freeform_input(&call.arguments, fallback_argument),
        })
    } else {
        json!({
            "type": "function_call",
            "call_id": call.id,
            "name": call.name,
            "arguments": serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".to_owned()),
        })
    }
}

fn freeform_input(arguments: &Value, fallback_argument: &str) -> String {
    arguments
        .as_str()
        .or_else(|| arguments.get(fallback_argument).and_then(Value::as_str))
        .map(str::to_owned)
        .unwrap_or_else(|| arguments.to_string())
}

fn custom_call_ids(
    request: &ModelRequest,
    freeform_fallbacks: &std::collections::BTreeMap<String, String>,
) -> Result<std::collections::BTreeSet<String>, ModelError> {
    let mut ids = std::collections::BTreeSet::new();
    for message in &request.messages {
        for part in &message.content {
            if let ModelContentPart::ToolCall { call } = part
                && freeform_fallbacks.contains_key(call.name.as_str())
                && call.arguments.is_string()
            {
                ids.insert(call.id.clone());
            }
        }
        if let Some(context) = sole_provider_context(message)? {
            ensure_context_wire(context, ProviderWireApi::OpenAiResponses)?;
            let output = serde_json::from_slice::<Vec<Value>>(&context.payload()?)
                .map_err(|_| protocol_error())?;
            for item in &output {
                if item.get("type").and_then(Value::as_str) == Some("custom_tool_call")
                    && let Some(call_id) = item.get("call_id").and_then(Value::as_str)
                {
                    ids.insert(call_id.to_owned());
                }
            }
        }
    }
    Ok(ids)
}

fn data_url(media_type: &str, bytes: &[u8]) -> String {
    format!("data:{media_type};base64,{}", BASE64_STANDARD.encode(bytes))
}
