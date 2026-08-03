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
    let input = request
        .messages
        .iter()
        .map(openai_input_items)
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let tools = request
        .tools
        .iter()
        .map(|tool| {
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
    let mut body = openai_request(
        &managed_request,
        strict_tools,
        parallel_tools,
        max_output_tokens,
    )?;
    body["store"] = Value::Bool(true);
    if let Some(previous_response_id) = previous_response_id {
        body["previous_response_id"] = Value::String(previous_response_id);
    }
    Ok(body)
}

fn openai_input_items(message: &ModelMessage) -> Result<Vec<Value>, ModelError> {
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
            ModelContentPart::ToolCall { call } => Ok(openai_tool_call(call)),
            ModelContentPart::ToolResult { result } => Ok(json!({
                "type": "function_call_output",
                "call_id": result.call_id,
                "output": tool_result_text(&result.content),
            })),
            ModelContentPart::ImageAsset(_) | ModelContentPart::PdfDocument(_) => {
                Err(ModelError::new(ModelErrorKind::InvalidRequest, false))
            }
            ModelContentPart::ProviderContext(_) => Err(protocol_error()),
        })
        .collect()
}

fn openai_tool_call(call: &ModelToolCall) -> Value {
    json!({
        "type": "function_call",
        "call_id": call.id,
        "name": call.name,
        "arguments": serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".to_owned()),
    })
}

pub(super) fn anthropic_request(
    request: &ModelRequest,
    strict_tools: ModelStrictToolsMode,
    max_output_tokens: u32,
) -> Result<Value, ModelError> {
    let messages = anthropic_messages(request)?;
    let tools = request
        .tools
        .iter()
        .map(|tool| {
            let strict = crate::tool_schema::strict_for_tool(
                &tool.name,
                &tool.parameters,
                crate::tool_schema::ToolSchemaDialect::Anthropic,
                strict_tools,
            )?;
            let mut definition = json!({
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.parameters,
            });
            if strict_tools != ModelStrictToolsMode::Disabled {
                definition["strict"] = Value::Bool(strict);
            }
            Ok(definition)
        })
        .collect::<Result<Vec<_>, ModelError>>()?;
    Ok(json!({
        "model": request.model,
        "max_tokens": max_output_tokens,
        "system": rendered_instructions(request),
        "messages": messages,
        "tools": tools,
        "stream": true,
    }))
}

fn anthropic_messages(request: &ModelRequest) -> Result<Vec<Value>, ModelError> {
    let mut messages = Vec::<Value>::new();
    for source in &request.messages {
        let mut message = anthropic_message(source)?;
        if let Some(previous) = messages.last_mut()
            && previous.get("role") == message.get("role")
        {
            let previous_content = previous
                .get_mut("content")
                .and_then(Value::as_array_mut)
                .ok_or_else(protocol_error)?;
            let content = message
                .get_mut("content")
                .and_then(Value::as_array_mut)
                .ok_or_else(protocol_error)?;
            previous_content.append(content);
            continue;
        }
        messages.push(message);
    }
    Ok(messages)
}

fn anthropic_message(message: &ModelMessage) -> Result<Value, ModelError> {
    if let Some(context) = sole_provider_context(message)? {
        ensure_context_wire(context, ProviderWireApi::AnthropicMessages)?;
        let content = serde_json::from_slice::<Vec<Value>>(&context.payload()?)
            .map_err(|_| protocol_error())?;
        return Ok(json!({"role": "assistant", "content": content}));
    }
    let content = message
        .content
        .iter()
        .map(|part| match part {
            ModelContentPart::Text { text, .. }
            | ModelContentPart::ContextCompaction { content: text } => {
                Ok(json!({"type": "text", "text": text}))
            }
            ModelContentPart::ToolCall { call } => Ok(anthropic_tool_call(call)),
            ModelContentPart::ToolResult { result } => Ok(json!({
                "type": "tool_result",
                "tool_use_id": result.call_id,
                "content": tool_result_text(&result.content),
                "is_error": matches!(&result.content, ModelToolResultContent::Error { .. }),
            })),
            ModelContentPart::ImageAsset(asset) => Ok(json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": asset.media_type,
                    "data": BASE64_STANDARD.encode(&asset.bytes),
                },
            })),
            ModelContentPart::PdfDocument(asset) => Ok(json!({
                "type": "document",
                "source": {
                    "type": "base64",
                    "media_type": asset.media_type,
                    "data": BASE64_STANDARD.encode(&asset.bytes),
                },
            })),
            ModelContentPart::ProviderContext(_) => Err(protocol_error()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "role": match message.role {
            ModelRole::User => "user",
            ModelRole::Assistant => "assistant",
        },
        "content": content,
    }))
}

fn anthropic_tool_call(call: &ModelToolCall) -> Value {
    json!({
        "type": "tool_use",
        "id": call.id,
        "name": call.name,
        "input": call.arguments,
    })
}

pub(super) fn gemini_request(
    request: &ModelRequest,
    strict_tools: ModelStrictToolsMode,
    max_output_tokens: u32,
) -> Result<Value, ModelError> {
    let mut call_names = request
        .messages
        .iter()
        .flat_map(|message| {
            message.content.iter().filter_map(|part| match part {
                ModelContentPart::ToolCall { call } => Some((call.id.clone(), call.name.clone())),
                _ => None,
            })
        })
        .collect::<BTreeMap<_, _>>();
    for message in &request.messages {
        let Some(context) = sole_provider_context(message)? else {
            continue;
        };
        ensure_context_wire(context, ProviderWireApi::GeminiGenerateContent)?;
        let value: Value =
            serde_json::from_slice(&context.payload()?).map_err(|_| protocol_error())?;
        for call in value
            .get("parts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|part| part.get("functionCall"))
        {
            if let (Some(id), Some(name)) = (
                call.get("id").and_then(Value::as_str),
                call.get("name").and_then(Value::as_str),
            ) {
                call_names.insert(id.to_owned(), name.to_owned());
            }
        }
    }
    let contents = request
        .messages
        .iter()
        .map(|message| gemini_message(message, &call_names))
        .collect::<Result<Vec<_>, _>>()?;
    let declarations = request
        .tools
        .iter()
        .map(|tool| {
            crate::tool_schema::strict_for_tool(
                &tool.name,
                &tool.parameters,
                crate::tool_schema::ToolSchemaDialect::Gemini,
                strict_tools,
            )?;
            Ok(json!({
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            }))
        })
        .collect::<Result<Vec<_>, ModelError>>()?;
    Ok(json!({
        "systemInstruction": {
            "parts": [{ "text": rendered_instructions(request) }],
        },
        "contents": contents,
        "tools": [{ "functionDeclarations": declarations }],
        "generationConfig": { "maxOutputTokens": max_output_tokens },
    }))
}

fn gemini_message(
    message: &ModelMessage,
    call_names: &BTreeMap<String, String>,
) -> Result<Value, ModelError> {
    if let Some(context) = sole_provider_context(message)? {
        ensure_context_wire(context, ProviderWireApi::GeminiGenerateContent)?;
        return serde_json::from_slice(&context.payload()?).map_err(|_| protocol_error());
    }
    let parts = message
        .content
        .iter()
        .map(|part| match part {
            ModelContentPart::Text { text, .. }
            | ModelContentPart::ContextCompaction { content: text } => Ok(json!({"text": text})),
            ModelContentPart::ToolCall { call } => Ok(json!({"functionCall": {
                "id": call.id,
                "name": call.name,
                "args": call.arguments,
            }})),
            ModelContentPart::ToolResult { result } => Ok(json!({"functionResponse": {
                "id": result.call_id,
                "name": call_names
                    .get(result.call_id.as_str())
                    .map(String::as_str)
                    .unwrap_or("sugarcode_tool"),
                "response": match &result.content {
                    ModelToolResultContent::Json(value) => value.clone(),
                    ModelToolResultContent::Text(text) => json!({"result": text}),
                    ModelToolResultContent::Error { kind, message } => {
                        json!({"error": {"kind": kind, "message": message}})
                    }
                },
            }})),
            ModelContentPart::ImageAsset(asset) | ModelContentPart::PdfDocument(asset) => {
                Ok(json!({"inlineData": {
                    "mimeType": asset.media_type,
                    "data": BASE64_STANDARD.encode(&asset.bytes),
                }}))
            }
            ModelContentPart::ProviderContext(_) => Err(protocol_error()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "role": match message.role {
            ModelRole::User => "user",
            ModelRole::Assistant => "model",
        },
        "parts": parts,
    }))
}

fn data_url(media_type: &str, bytes: &[u8]) -> String {
    format!("data:{media_type};base64,{}", BASE64_STANDARD.encode(bytes))
}
