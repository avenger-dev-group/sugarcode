use crate::ModelError;
use serde_json::Map;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelStrictToolsMode {
    Auto,
    Enabled,
    Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolSchemaDialect {
    OpenAi,
    Anthropic,
    Gemini,
}

pub(crate) fn strict_for_tool(
    tool_name: &str,
    schema: &Value,
    dialect: ToolSchemaDialect,
    mode: ModelStrictToolsMode,
) -> Result<bool, ModelError> {
    if mode == ModelStrictToolsMode::Disabled {
        return Ok(false);
    }
    match validate_schema(schema, dialect, "$parameters") {
        Ok(()) => Ok(true),
        Err(_) if mode == ModelStrictToolsMode::Auto => Ok(false),
        Err(reason) => Err(ModelError::strict_tool_schema(tool_name.to_owned(), reason)),
    }
}

fn validate_schema(schema: &Value, dialect: ToolSchemaDialect, path: &str) -> Result<(), String> {
    let object = schema
        .as_object()
        .ok_or_else(|| format!("{path} must be a JSON Schema object"))?;
    reject_unsupported_keywords(object, dialect, path)?;
    let schema_type = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{path}.type must be explicit"))?;
    if path == "$parameters" && schema_type != "object" {
        return Err("$parameters.type must be object".to_owned());
    }
    match schema_type {
        "object" => validate_object_schema(object, dialect, path),
        "array" => {
            let items = object
                .get("items")
                .ok_or_else(|| format!("{path}.items is required for arrays"))?;
            validate_schema(items, dialect, &format!("{path}.items"))
        }
        "string" | "number" | "integer" | "boolean" | "null" => Ok(()),
        other => Err(format!("{path}.type {other:?} is unsupported")),
    }
}

fn validate_object_schema(
    object: &Map<String, Value>,
    dialect: ToolSchemaDialect,
    path: &str,
) -> Result<(), String> {
    let properties = object
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{path}.properties must be an object"))?;
    if matches!(
        dialect,
        ToolSchemaDialect::OpenAi | ToolSchemaDialect::Anthropic
    ) && object.get("additionalProperties").and_then(Value::as_bool) != Some(false)
    {
        return Err(format!(
            "{path}.additionalProperties must be false for strict tools"
        ));
    }
    if matches!(dialect, ToolSchemaDialect::Gemini)
        && object
            .get("additionalProperties")
            .is_some_and(|value| value != false)
    {
        return Err(format!(
            "{path}.additionalProperties is unsupported by Gemini"
        ));
    }
    let required = object
        .get("required")
        .and_then(Value::as_array)
        .map(|required| {
            required
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .ok_or_else(|| format!("{path}.required must contain only strings"))
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    if matches!(
        dialect,
        ToolSchemaDialect::OpenAi | ToolSchemaDialect::Anthropic
    ) && properties
        .keys()
        .any(|property| !required.contains(&property.as_str()))
    {
        return Err(format!(
            "{path}.required must include every property for strict tools"
        ));
    }
    for required_property in &required {
        if !properties.contains_key(*required_property) {
            return Err(format!(
                "{path}.required references missing property {required_property:?}"
            ));
        }
    }
    for (name, property) in properties {
        validate_schema(property, dialect, &format!("{path}.properties.{name}"))?;
    }
    Ok(())
}

fn reject_unsupported_keywords(
    object: &Map<String, Value>,
    dialect: ToolSchemaDialect,
    path: &str,
) -> Result<(), String> {
    const COMMON_UNSUPPORTED: &[&str] = &[
        "$ref",
        "$defs",
        "definitions",
        "allOf",
        "anyOf",
        "oneOf",
        "not",
        "if",
        "then",
        "else",
        "patternProperties",
        "dependentSchemas",
        "unevaluatedProperties",
    ];
    for keyword in COMMON_UNSUPPORTED {
        if object.contains_key(*keyword) {
            return Err(format!("{path}.{keyword} is unsupported"));
        }
    }
    if matches!(dialect, ToolSchemaDialect::Gemini) {
        for keyword in ["const", "contains", "prefixItems", "propertyNames"] {
            if object.contains_key(keyword) {
                return Err(format!("{path}.{keyword} is unsupported by Gemini"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn auto_downgrades_only_the_incompatible_tool() {
        let strict = json!({
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
            "additionalProperties": false
        });
        let loose = json!({
            "type": "object",
            "properties": {"path": {"type": "string"}}
        });
        assert!(
            strict_for_tool(
                "strict",
                &strict,
                ToolSchemaDialect::OpenAi,
                ModelStrictToolsMode::Auto
            )
            .expect("strict schema")
        );
        assert!(
            !strict_for_tool(
                "loose",
                &loose,
                ToolSchemaDialect::OpenAi,
                ModelStrictToolsMode::Auto
            )
            .expect("auto downgrade")
        );
    }

    #[test]
    fn enabled_reports_the_tool_and_schema_reason() {
        let error = strict_for_tool(
            "mcp__fixture__loose",
            &json!({"type": "object", "properties": {}}),
            ToolSchemaDialect::OpenAi,
            ModelStrictToolsMode::Enabled,
        )
        .expect_err("enabled strict must reject");
        assert_eq!(error.kind(), crate::ModelErrorKind::InvalidRequest);
        assert_eq!(error.tool_name(), Some("mcp__fixture__loose"));
        assert!(
            error
                .schema_reason()
                .is_some_and(|reason| { reason.contains("additionalProperties must be false") })
        );
    }
}
