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

fn data_url(media_type: &str, bytes: &[u8]) -> String {
    format!("data:{media_type};base64,{}", BASE64_STANDARD.encode(bytes))
}
