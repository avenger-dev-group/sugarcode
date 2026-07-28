use crate::DiscoveryError;
use crate::DiscoveryErrorKind;
use crate::MAX_INVENTORY_BYTES;
use crate::MAX_SCHEMA_DEPTH;
use crate::MAX_SCHEMA_NODES;
use crate::MAX_SERVER_TOOLS;
use crate::MAX_TOOL_DEFINITION_BYTES;
use crate::MAX_TOOL_DESCRIPTION_BYTES;
use crate::MAX_TOOL_NAME_BYTES;
use crate::MAX_TOOL_SCHEMA_BYTES;
use serde_json::Map;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeSet;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StdioServerSpec {
    pub(crate) id: String,
    pub(crate) executable: PathBuf,
    pub(crate) argv: Vec<String>,
    pub(crate) cwd: PathBuf,
}

impl StdioServerSpec {
    pub fn new(id: String, executable: PathBuf, argv: Vec<String>, cwd: PathBuf) -> Self {
        Self {
            id,
            executable,
            argv,
            cwd,
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct McpToolDefinition {
    name: String,
    description: Option<String>,
    input_schema: Value,
    output_schema: Option<Value>,
}

impl McpToolDefinition {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }

    pub fn input_schema(&self) -> &Value {
        &self.input_schema
    }

    pub fn output_schema(&self) -> Option<&Value> {
        self.output_schema.as_ref()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct McpServerInventory {
    server_id: String,
    server_name: String,
    server_version: String,
    tools: Vec<McpToolDefinition>,
    canonical_sha256: String,
}

impl McpServerInventory {
    pub fn server_id(&self) -> &str {
        &self.server_id
    }

    pub fn server_name(&self) -> &str {
        &self.server_name
    }

    pub fn server_version(&self) -> &str {
        &self.server_version
    }

    pub fn tools(&self) -> &[McpToolDefinition] {
        &self.tools
    }

    pub fn canonical_sha256(&self) -> &str {
        &self.canonical_sha256
    }

    pub fn callable_name(&self, raw_name: &str) -> Option<String> {
        self.tools
            .iter()
            .any(|tool| tool.name == raw_name)
            .then(|| format!("mcp__{}__{raw_name}", self.server_id))
    }

    pub fn tool_for_callable(&self, callable_name: &str) -> Option<&McpToolDefinition> {
        let prefix = format!("mcp__{}__", self.server_id);
        let raw_name = callable_name.strip_prefix(&prefix)?;
        self.tools.iter().find(|tool| tool.name == raw_name)
    }

    pub(crate) fn from_protocol(
        server_id: &str,
        server_name: String,
        server_version: String,
        raw_tools: Vec<Value>,
    ) -> Result<Self, DiscoveryError> {
        if raw_tools.len() > MAX_SERVER_TOOLS {
            return Err(invalid(server_id));
        }
        validate_info(&server_name).map_err(|()| invalid(server_id))?;
        validate_info(&server_version).map_err(|()| invalid(server_id))?;

        let mut names = BTreeSet::new();
        let mut tools = Vec::with_capacity(raw_tools.len());
        let mut inventory_bytes = server_name.len().saturating_add(server_version.len());
        for raw_tool in raw_tools {
            let tool = parse_tool(server_id, raw_tool)?;
            if !names.insert(tool.name.clone()) {
                return Err(invalid(server_id));
            }
            let definition_bytes = serde_json::to_vec(&canonical_tool_value(&tool))
                .map_err(|_| invalid(server_id))?
                .len();
            if definition_bytes > MAX_TOOL_DEFINITION_BYTES {
                return Err(invalid(server_id));
            }
            inventory_bytes = inventory_bytes.saturating_add(definition_bytes);
            if inventory_bytes > MAX_INVENTORY_BYTES {
                return Err(invalid(server_id));
            }
            tools.push(tool);
        }
        tools.sort_by(|left, right| left.name.as_bytes().cmp(right.name.as_bytes()));

        let canonical_sha256 =
            canonical_inventory_sha256(server_id, &server_name, &server_version, &tools)
                .map_err(|()| invalid(server_id))?;
        Ok(Self {
            server_id: server_id.to_owned(),
            server_name,
            server_version,
            tools,
            canonical_sha256,
        })
    }
}

fn canonical_inventory_sha256(
    server_id: &str,
    server_name: &str,
    server_version: &str,
    tools: &[McpToolDefinition],
) -> Result<String, ()> {
    let value = serde_json::json!({
        "protocolVersion": crate::MCP_PROTOCOL_VERSION,
        "serverId": server_id,
        "serverInfo": {
            "name": server_name,
            "version": server_version,
        },
        "tools": tools.iter().map(canonical_tool_value).collect::<Vec<_>>(),
    });
    let bytes = serde_json::to_vec(&value).map_err(|_| ())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn parse_tool(server_id: &str, value: Value) -> Result<McpToolDefinition, DiscoveryError> {
    let object = value.as_object().ok_or_else(|| invalid(server_id))?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(server_id))?;
    if !valid_tool_name(name) {
        return Err(invalid(server_id));
    }
    let description = match object.get("description") {
        None | Some(Value::Null) => None,
        Some(Value::String(value))
            if value.len() <= MAX_TOOL_DESCRIPTION_BYTES
                && !value.chars().any(char::is_control) =>
        {
            Some(value.clone())
        }
        Some(_) => return Err(invalid(server_id)),
    };
    let input_schema = object
        .get("inputSchema")
        .ok_or_else(|| invalid(server_id))?
        .clone();
    validate_schema(&input_schema).map_err(|()| invalid(server_id))?;
    let output_schema = match object.get("outputSchema") {
        None | Some(Value::Null) => None,
        Some(schema) => {
            validate_schema(schema).map_err(|()| invalid(server_id))?;
            Some(schema.clone())
        }
    };

    Ok(McpToolDefinition {
        name: name.to_owned(),
        description,
        input_schema,
        output_schema,
    })
}

fn valid_tool_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_TOOL_NAME_BYTES
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

fn validate_info(value: &str) -> Result<(), ()> {
    if value.is_empty()
        || value.len() > MAX_TOOL_DESCRIPTION_BYTES
        || value.chars().any(char::is_control)
    {
        Err(())
    } else {
        Ok(())
    }
}

fn validate_schema(schema: &Value) -> Result<(), ()> {
    let object = schema.as_object().ok_or(())?;
    if let Some(dialect) = object.get("$schema") {
        let dialect = dialect.as_str().ok_or(())?;
        if !matches!(
            dialect,
            "https://json-schema.org/draft/2020-12/schema"
                | "http://json-schema.org/draft-07/schema#"
                | "https://json-schema.org/draft-07/schema"
        ) {
            return Err(());
        }
    }
    let bytes = serde_json::to_vec(schema).map_err(|_| ())?;
    if bytes.len() > MAX_TOOL_SCHEMA_BYTES {
        return Err(());
    }
    let mut nodes = 0_usize;
    validate_schema_node(schema, 1, &mut nodes)
}

fn validate_schema_node(value: &Value, depth: usize, nodes: &mut usize) -> Result<(), ()> {
    *nodes = nodes.saturating_add(1);
    if depth > MAX_SCHEMA_DEPTH || *nodes > MAX_SCHEMA_NODES {
        return Err(());
    }
    match value {
        Value::Object(object) => {
            if let Some(reference) = object.get("$ref") {
                let reference = reference.as_str().ok_or(())?;
                if !reference.starts_with('#') {
                    return Err(());
                }
            }
            for child in object.values() {
                validate_schema_node(child, depth + 1, nodes)?;
            }
        }
        Value::Array(array) => {
            for child in array {
                validate_schema_node(child, depth + 1, nodes)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn canonical_tool_value(tool: &McpToolDefinition) -> Value {
    let mut object = Map::new();
    object.insert("name".to_owned(), Value::String(tool.name.clone()));
    if let Some(description) = tool.description.as_ref() {
        object.insert("description".to_owned(), Value::String(description.clone()));
    }
    object.insert("inputSchema".to_owned(), tool.input_schema.clone());
    if let Some(output_schema) = tool.output_schema.as_ref() {
        object.insert("outputSchema".to_owned(), output_schema.clone());
    }
    Value::Object(object)
}

fn invalid(server_id: &str) -> DiscoveryError {
    DiscoveryError::new(server_id, DiscoveryErrorKind::InvalidToolInventory)
}
