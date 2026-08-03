use crate::ModelContentPart;
use crate::ModelError;
use crate::ModelErrorKind;
use crate::ModelMessage;
use crate::ModelRequest;
use crate::ModelRole;
use crate::ModelStrictToolsMode;
use crate::ModelToolCall;
use crate::ModelToolResultContent;
use crate::ProviderContextEnvelope;
use crate::ProviderWireApi;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use serde_json::Value;
use serde_json::json;

pub(crate) fn anthropic_request(
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

fn rendered_instructions(request: &ModelRequest) -> String {
    request
        .instructions
        .iter()
        .map(|instruction| instruction.rendered_content())
        .collect::<Vec<_>>()
        .join("\n\n")
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

fn sole_provider_context(
    message: &ModelMessage,
) -> Result<Option<&ProviderContextEnvelope>, ModelError> {
    let mut contexts = message.content.iter().filter_map(|part| match part {
        ModelContentPart::ProviderContext(context) => Some(context),
        _ => None,
    });
    let context = contexts.next();
    if contexts.next().is_some() || context.is_some_and(|_| message.content.len() != 1) {
        return Err(protocol_error());
    }
    Ok(context)
}

fn ensure_context_wire(
    context: &ProviderContextEnvelope,
    expected: ProviderWireApi,
) -> Result<(), ModelError> {
    if context.wire_api() == expected {
        Ok(())
    } else {
        Err(ModelError::new(ModelErrorKind::InvalidRequest, false))
    }
}

fn tool_result_text(content: &ModelToolResultContent) -> String {
    match content {
        ModelToolResultContent::Json(value) => value.to_string(),
        ModelToolResultContent::Text(text) => text.clone(),
        ModelToolResultContent::Error { kind, message } => {
            json!({"error": {"kind": kind, "message": message}}).to_string()
        }
    }
}

fn protocol_error() -> ModelError {
    ModelError::new(ModelErrorKind::Protocol, false)
}
