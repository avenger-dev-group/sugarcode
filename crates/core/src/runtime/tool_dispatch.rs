use super::*;

pub(super) fn workspace_tool_definitions(runtime: &CoreRuntime) -> Vec<ModelToolDefinition> {
    let mut definitions = Vec::with_capacity(37);
    if runtime.workspace_read.is_some() {
        definitions.push(ModelToolDefinition {
            name: "workspace/read".to_string(),
            description: "Read one UTF-8 text file inside the active workspace scope. Returns JSON with content, byte count and the exact SHA-256 of the observed content."
                .to_string(),
            parameters: workspace_path_parameters(),
            freeform: None,
        });
    }
    if runtime.workspace_list.is_some() {
        definitions.push(ModelToolDefinition {
            name: "workspace/list".to_string(),
            description:
                "List one directory inside the active workspace scope. Set recursive to true to traverse descendants without following symbolic links. Use '.' for the active workspace scope."
                    .to_string(),
            parameters: workspace_list_parameters(),
            freeform: None,
        });
    }
    if runtime.workspace_search.is_some() {
        definitions.push(ModelToolDefinition {
            name: "workspace/search".to_string(),
            description:
                "Search recursively inside one active workspace scope directory. mode content searches UTF-8 file contents and mode path searches relative paths. Content search supports literal or regular-expression matching, case control and a file glob."
                    .to_string(),
            parameters: workspace_search_parameters(),
            freeform: None,
        });
    }
    if runtime.workspace_patch.is_some() {
        definitions.push(ModelToolDefinition {
            name: "workspace/apply-patch".to_string(),
            description:
                "Apply one atomic Codex-style patch across up to 64 workspace files. This is a FREEFORM tool on supported providers: send the patch directly from *** Begin Patch through *** End Patch without JSON wrapping. Use Add File, Update File or Delete File markers with workspace-relative paths; updates use @@ context and lines prefixed with space, + or -. On JSON-only providers pass the identical text in the patch field."
                    .to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "patch": {
                        "type": "string",
                        "description": "The complete Codex-style patch from *** Begin Patch through *** End Patch."
                    }
                },
                "required": ["patch"]
            }),
            freeform: Some(ModelToolGrammar {
                syntax: ModelToolGrammarSyntax::Lark,
                definition: sugarcode_tools::WORKSPACE_APPLY_PATCH_LARK_GRAMMAR.to_string(),
                fallback_argument: "patch".to_string(),
            }),
        });
    }
    if let (Some(shell_executor), Some(_)) = (
        runtime.shell_executor.as_ref(),
        runtime.approval_requester.as_ref(),
    ) {
        let workspace_root = shell_executor
            .workspace_root_path()
            .and_then(std::path::Path::to_str);
        let encoded_workspace_root = workspace_root
            .and_then(|root| serde_json::to_string(root).ok())
            .unwrap_or_else(|| "unavailable".to_string());
        let description = format!(
            "Execute either one exact absolute program (kind direct) in the sandbox, or on macOS/Windows one complete command string (kind shell) through the account login shell after explicit Full Access approval. Prefer direct whenever one executable plus argv is sufficient. Direct-mode network access is denied; writes inside the active workspace scope require the separately enabled workspace-write policy. Shell mode supports pipes, redirections, conditionals, variables and globs; it can access the network and paths outside the workspace. The authoritative active workspace root is {encoded_workspace_root}. Never guess, translate or invent another workspace path."
        );
        let cwd_description = workspace_root.map_or_else(
            || {
                "Use a single dot for the active workspace root. The process starts in cwd, so do not prepend a guessed absolute cd command."
                    .to_string()
            },
            |root| {
                let encoded = serde_json::to_string(root)
                    .expect("UTF-8 workspace root must serialize as JSON");
                format!(
                    "For both direct and shell commands, use the exact authoritative absolute workspace root {encoded}. A single dot and shell-relative subdirectories are accepted only for runtime compatibility. The process starts in cwd, so do not prepend cd merely to enter the active workspace."
                )
            },
        );
        let cwd_parameters = workspace_root.map_or_else(
            || {
                serde_json::json!({
                    "type": "string",
                    "const": ".",
                    "description": cwd_description
                })
            },
            |root| {
                serde_json::json!({
                    "type": "string",
                    "const": root,
                    "description": cwd_description
                })
            },
        );
        let direct_parameters = serde_json::json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "description": {
                    "type": "string",
                    "description": "A short plain-language explanation shown in the approval UI. Describe the user-visible action without executable paths, argv, cwd, or policy names."
                },
                "kind": {
                    "type": "string",
                    "const": "direct"
                },
                "command": {
                    "type": "string",
                    "description": "One exact absolute executable path. Bare names are rejected."
                },
                "argvJson": {
                    "type": "string",
                    "description": "A JSON-encoded array of argv strings after command, for example [\"status\",\"--short\"]. This is JSON array syntax, never a shell command line."
                },
                "cwd": cwd_parameters.clone()
            },
            "required": ["description", "kind", "command", "argvJson", "cwd"]
        });
        let parameters = if cfg!(any(target_os = "macos", windows)) {
            let shell_parameters = serde_json::json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "description": {
                        "type": "string",
                        "description": "A short plain-language explanation shown in the approval UI. Describe the user-visible action without executable paths, argv, cwd, or policy names."
                    },
                    "kind": {
                        "type": "string",
                        "const": "shell"
                    },
                    "command": {
                        "type": "string",
                        "description": "One complete shell command string. Use this branch only when shell syntax such as pipes, redirections, conditionals, variables or globs is required."
                    },
                    "cwd": cwd_parameters,
                    "timeoutMs": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": sugarcode_tools::MAX_FULL_ACCESS_SHELL_TIMEOUT_MS
                    }
                },
                "required": ["description", "kind", "command", "cwd"]
            });
            serde_json::json!({
                "type": "object",
                "oneOf": [direct_parameters, shell_parameters]
            })
        } else {
            direct_parameters
        };
        definitions.push(ModelToolDefinition {
            name: "shell/exec".to_string(),
            description,
            parameters,
            freeform: None,
        });
    }
    if runtime.mcp_capability.is_enabled()
        && let (Some(executor), Some(_)) = (
            runtime.mcp_executor.as_ref(),
            runtime.mcp_approval_requester.as_ref(),
        )
    {
        definitions.extend(executor.definitions());
    }
    definitions
}

pub(super) fn shell_workspace_root(runtime: &CoreRuntime) -> Option<&std::path::Path> {
    runtime
        .shell_executor
        .as_ref()
        .and_then(|executor| executor.workspace_root_path())
}

fn workspace_path_parameters() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "path": { "type": "string" }
        },
        "required": ["path"]
    })
}

fn workspace_search_parameters() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "path": { "type": "string" },
            "query": { "type": "string" },
            "mode": { "type": "string", "enum": ["content", "path"] },
            "regex": { "type": "boolean" },
            "caseSensitive": { "type": "boolean" },
            "filePattern": { "type": "string" }
        },
        "required": ["path", "query"]
    })
}

fn workspace_list_parameters() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "path": { "type": "string" },
            "recursive": { "type": "boolean" }
        },
        "required": ["path"]
    })
}

fn compatible_boolean(value: &serde_json::Value) -> Option<bool> {
    value.as_bool().or_else(|| match value.as_str() {
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => None,
    })
}

pub(super) struct WorkspaceToolArguments {
    pub path: String,
    pub recursive: bool,
    pub query: Option<String>,
    pub advanced_search: Option<sugarcode_tools::WorkspaceAdvancedSearchArguments>,
    pub freeform_patch: Option<String>,
}

pub(super) struct ShellToolArguments {
    pub description: String,
    pub kind: ShellToolKind,
    pub command: String,
    pub arguments: Vec<String>,
    pub cwd: String,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ShellToolKind {
    Direct,
    Shell,
}

#[derive(Clone)]
pub(super) struct ToolArgumentGuidance {
    pub field_path: Option<String>,
    pub reason: &'static str,
    pub expected_summary: &'static str,
    pub actual_summary: Option<String>,
    pub suggested_action: &'static str,
}

impl ToolArgumentGuidance {
    fn generic(expected_summary: &'static str, suggested_action: &'static str) -> Self {
        Self {
            field_path: None,
            reason: "schemaMismatch",
            expected_summary,
            actual_summary: None,
            suggested_action,
        }
    }

    fn at(
        field_path: impl Into<String>,
        reason: &'static str,
        expected_summary: &'static str,
        actual: Option<&serde_json::Value>,
        suggested_action: &'static str,
    ) -> Self {
        Self {
            field_path: Some(field_path.into()),
            reason,
            expected_summary,
            actual_summary: actual.map(|value| format!("type={}", json_value_type(value))),
            suggested_action,
        }
    }

    pub(super) fn durable_expected_summary(&self) -> String {
        match self.field_path.as_deref() {
            Some(path) => format!(
                "{path}: {}; expected {}",
                self.reason, self.expected_summary
            ),
            None => self.expected_summary.to_string(),
        }
    }
}

fn json_value_type(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

pub(super) fn shell_tool_argument_guidance(
    call: &ModelToolCall,
    workspace_root: Option<&std::path::Path>,
) -> Option<ToolArgumentGuidance> {
    if call.name != "shell/exec" {
        return None;
    }
    if shell_tool_arguments(call, workspace_root).is_ok() {
        return None;
    }
    let is_shell = call
        .arguments
        .get("kind")
        .and_then(serde_json::Value::as_str)
        == Some("shell");
    if is_shell
        && call
            .arguments
            .get("timeoutMs")
            .is_some_and(|value| shell_timeout_ms(value).is_none())
    {
        return Some(ToolArgumentGuidance::generic(
            "timeoutMs must be a bounded positive integer number of milliseconds; compatible decimal strings may contain ASCII digits only",
            "useBoundedTimeoutMilliseconds",
        ));
    }
    Some(if is_shell {
        ToolArgumentGuidance::generic(
            "kind shell requires description, a complete bounded command string, the advertised authoritative absolute workspace root or a workspace-relative cwd, and optional timeoutMs; argvJson is not used",
            "useFullAccessShellSchema",
        )
    } else {
        ToolArgumentGuidance::generic(
            "command must be one absolute executable path; kind direct also requires description, argvJson, and the advertised authoritative absolute workspace root as cwd; legacy calls may use cwd \".\" or omit kind",
            "useAbsoluteExecutablePath",
        )
    })
}

fn shell_timeout_ms(value: &serde_json::Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| {
            value.as_str().and_then(|value| {
                (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
                    .then(|| value.parse::<u64>().ok())
                    .flatten()
            })
        })
        .filter(|value| *value > 0 && *value <= sugarcode_tools::MAX_FULL_ACCESS_SHELL_TIMEOUT_MS)
}

fn shell_argv(
    arguments: &serde_json::Map<String, serde_json::Value>,
) -> Result<Vec<String>, ToolArgumentGuidance> {
    if let Some(value) = arguments.get("argvJson") {
        let Some(encoded) = value.as_str() else {
            return Err(ToolArgumentGuidance::generic(
                "argvJson must be a string containing JSON array syntax such as [\"status\",\"--short\"]",
                "encodeArgvAsJsonArray",
            ));
        };
        return serde_json::from_str::<Vec<String>>(encoded).map_err(|_| {
            ToolArgumentGuidance::generic(
                "argvJson must contain only one valid JSON array of strings, never a shell command line",
                "encodeArgvAsJsonArray",
            )
        });
    }
    let values = arguments
        .get("argv")
        .or_else(|| arguments.get("arguments"))
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            ToolArgumentGuidance::generic(
                "argvJson must contain JSON array syntax such as [\"status\",\"--short\"]",
                "encodeArgvAsJsonArray",
            )
        })?;
    values
        .iter()
        .map(|value| {
            value.as_str().map(ToOwned::to_owned).ok_or_else(|| {
                ToolArgumentGuidance::generic(
                    "every argv item must be a string",
                    "encodeArgvAsJsonArray",
                )
            })
        })
        .collect()
}

pub(super) fn shell_tool_arguments(
    call: &ModelToolCall,
    workspace_root: Option<&std::path::Path>,
) -> Result<ShellToolArguments, ModelError> {
    if call.name != "shell/exec" {
        return Err(ModelError::new(ModelErrorKind::UnsupportedOutput, false));
    }
    let Some(arguments) = call.arguments.as_object() else {
        return Err(ModelError::new(ModelErrorKind::Protocol, false));
    };
    let argv_sources = ["argvJson", "argv", "arguments"]
        .into_iter()
        .filter(|name| arguments.contains_key(*name))
        .count();
    let allowed = [
        "description",
        "kind",
        "command",
        "argvJson",
        "argv",
        "arguments",
        "cwd",
        "timeoutMs",
    ];
    if arguments.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(ModelError::new(ModelErrorKind::InvalidRequest, false));
    }
    let kind = match arguments.get("kind").and_then(serde_json::Value::as_str) {
        None if argv_sources == 1 => ShellToolKind::Direct,
        Some("direct") => ShellToolKind::Direct,
        Some("shell") if cfg!(any(target_os = "macos", windows)) => ShellToolKind::Shell,
        _ => return Err(ModelError::new(ModelErrorKind::InvalidRequest, false)),
    };
    let description = arguments
        .get("description")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| ModelError::new(ModelErrorKind::InvalidRequest, false))?;
    let command = arguments
        .get("command")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| ModelError::new(ModelErrorKind::InvalidRequest, false))?;
    let cwd = arguments
        .get("cwd")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| ModelError::new(ModelErrorKind::InvalidRequest, false))?;
    if description.is_empty()
        || description.len() > 512
        || invalid_command_text(description)
        || command.is_empty()
        || command.len() > sugarcode_tools::MAX_SHELL_COMMAND_BYTES
        || command.contains('\0')
    {
        return Err(ModelError::new(ModelErrorKind::InvalidRequest, false));
    }
    let timeout_ms = arguments
        .get("timeoutMs")
        .map(|value| {
            shell_timeout_ms(value)
                .ok_or_else(|| ModelError::new(ModelErrorKind::InvalidRequest, false))
        })
        .transpose()?
        .unwrap_or(sugarcode_tools::DEFAULT_FULL_ACCESS_SHELL_TIMEOUT_MS);
    if kind == ShellToolKind::Shell {
        if argv_sources != 0
            || !shell_cwd_is_valid(cwd, workspace_root)
            || arguments.len() < 4
            || arguments.len() > 5
        {
            return Err(ModelError::new(ModelErrorKind::InvalidRequest, false));
        }
        return Ok(ShellToolArguments {
            description: description.to_string(),
            kind,
            command: command.to_string(),
            arguments: Vec::new(),
            cwd: cwd.to_string(),
            timeout_ms,
        });
    }
    let legacy = !arguments.contains_key("kind");
    if argv_sources != 1
        || !direct_cwd_is_valid(cwd, workspace_root)
        || !std::path::Path::new(command).is_absolute()
        || invalid_command_path(command)
        || invalid_command_text(command)
        || arguments.contains_key("timeoutMs")
        || arguments.len() != if legacy { 4 } else { 5 }
    {
        return Err(ModelError::new(ModelErrorKind::InvalidRequest, false));
    }
    let values = shell_argv(arguments)
        .map_err(|_| ModelError::new(ModelErrorKind::InvalidRequest, false))?;
    if values.len() > sugarcode_tools::MAX_SHELL_ARGUMENT_COUNT {
        return Err(ModelError::new(ModelErrorKind::InvalidRequest, false));
    }
    let mut parsed = Vec::with_capacity(values.len());
    let mut total = command.len();
    for value in values {
        total = total
            .checked_add(value.len())
            .ok_or_else(|| ModelError::new(ModelErrorKind::InvalidRequest, false))?;
        if value.len() > sugarcode_tools::MAX_SHELL_ARGUMENT_BYTES
            || invalid_command_text(&value)
            || total > sugarcode_tools::MAX_SHELL_TOTAL_ARGUMENT_BYTES
        {
            return Err(ModelError::new(ModelErrorKind::InvalidRequest, false));
        }
        parsed.push(value);
    }
    Ok(ShellToolArguments {
        description: description.to_string(),
        kind,
        command: command.to_string(),
        arguments: parsed,
        cwd: cwd.to_string(),
        timeout_ms,
    })
}

fn direct_cwd_is_valid(cwd: &str, workspace_root: Option<&std::path::Path>) -> bool {
    cwd == "." || workspace_root.is_some_and(|root| std::path::Path::new(cwd) == root)
}

fn shell_cwd_is_valid(cwd: &str, workspace_root: Option<&std::path::Path>) -> bool {
    let path = std::path::Path::new(cwd);
    cwd == "."
        || (!cwd.is_empty()
            && !path.is_absolute()
            && path
                .components()
                .all(|component| matches!(component, std::path::Component::Normal(_))))
        || (path.is_absolute() && workspace_root == Some(path))
}

fn invalid_command_text(value: &str) -> bool {
    value
        .chars()
        .any(|character| character == '\0' || character.is_control())
}

#[cfg(windows)]
fn invalid_command_path(value: &str) -> bool {
    value.starts_with(r"\\") || value.starts_with(r"\\?\") || value.starts_with(r"\\.\")
}

#[cfg(not(windows))]
fn invalid_command_path(_value: &str) -> bool {
    false
}

pub(super) fn workspace_tool_argument_guidance(
    call: &ModelToolCall,
) -> Option<ToolArgumentGuidance> {
    if workspace_tool_arguments(call).is_ok() {
        return None;
    }
    if call.name == "workspace/apply-patch" {
        let patch = call.arguments.as_str().or_else(|| {
            call.arguments
                .as_object()
                .filter(|arguments| arguments.len() == 1)
                .and_then(|arguments| arguments.get("patch"))
                .and_then(serde_json::Value::as_str)
        });
        return Some(ToolArgumentGuidance::at(
            if call.arguments.is_string() {
                "$"
            } else {
                "$.patch"
            },
            if patch.is_some() {
                "invalidPatch"
            } else {
                "invalidType"
            },
            "a complete Codex-style patch from *** Begin Patch through *** End Patch",
            Some(&call.arguments),
            "correctPatch",
        ));
    }
    let Some(arguments) = call.arguments.as_object() else {
        return Some(ToolArgumentGuidance::at(
            "$",
            "invalidType",
            "an object",
            Some(&call.arguments),
            "useObjectArguments",
        ));
    };
    let allowed = match call.name.as_str() {
        "workspace/read" => &["path"][..],
        "workspace/list" => &["path", "recursive"][..],
        "workspace/search" => &[
            "path",
            "query",
            "mode",
            "regex",
            "caseSensitive",
            "filePattern",
        ][..],
        _ => return None,
    };
    if let Some((key, value)) = arguments
        .iter()
        .find(|(key, _)| !allowed.contains(&key.as_str()))
    {
        return Some(ToolArgumentGuidance::at(
            format!("$.{key}"),
            "unexpectedField",
            "only fields declared by this tool",
            Some(value),
            "removeUnexpectedField",
        ));
    }

    match call.name.as_str() {
        "workspace/read" => diagnose_exact_string_object(arguments, &["path"]),
        "workspace/list" => diagnose_exact_string_object(arguments, &["path"]).or_else(|| {
            arguments.get("recursive").and_then(|value| {
                compatible_boolean(value).is_none().then(|| {
                    ToolArgumentGuidance::at(
                        "$.recursive",
                        "invalidType",
                        "a boolean",
                        Some(value),
                        "correctField",
                    )
                })
            })
        }),
        "workspace/search" => diagnose_workspace_search(arguments),
        _ => None,
    }
    .or_else(|| {
        Some(ToolArgumentGuidance::at(
            "$",
            "schemaMismatch",
            "the exact advertised tool argument schema",
            Some(&call.arguments),
            "correctArguments",
        ))
    })
}

fn diagnose_exact_string_object(
    arguments: &serde_json::Map<String, serde_json::Value>,
    required: &[&str],
) -> Option<ToolArgumentGuidance> {
    for name in required {
        match arguments.get(*name) {
            None => {
                return Some(ToolArgumentGuidance::at(
                    format!("$.{name}"),
                    "missingRequiredField",
                    "a string",
                    None,
                    "addRequiredField",
                ));
            }
            Some(value) if !value.is_string() => {
                return Some(ToolArgumentGuidance::at(
                    format!("$.{name}"),
                    "invalidType",
                    "a string",
                    Some(value),
                    "correctField",
                ));
            }
            Some(_) => {}
        }
    }
    None
}

fn diagnose_workspace_search(
    arguments: &serde_json::Map<String, serde_json::Value>,
) -> Option<ToolArgumentGuidance> {
    if let Some(guidance) = diagnose_exact_string_object(arguments, &["path", "query"]) {
        return Some(guidance);
    }
    if let Some(value) = arguments.get("mode")
        && !matches!(value.as_str(), Some("content" | "path"))
    {
        return Some(ToolArgumentGuidance::at(
            "$.mode",
            "invalidEnum",
            "one of: content, path",
            Some(value),
            "correctField",
        ));
    }
    for name in ["regex", "caseSensitive"] {
        if let Some(value) = arguments.get(name)
            && !value.is_boolean()
        {
            return Some(ToolArgumentGuidance::at(
                format!("$.{name}"),
                "invalidType",
                "a boolean",
                Some(value),
                "correctField",
            ));
        }
    }
    if let Some(value) = arguments.get("filePattern")
        && !value.is_string()
    {
        return Some(ToolArgumentGuidance::at(
            "$.filePattern",
            "invalidType",
            "a string",
            Some(value),
            "correctField",
        ));
    }
    None
}

pub(super) fn workspace_tool_arguments(
    call: &ModelToolCall,
) -> Result<WorkspaceToolArguments, ModelError> {
    if !matches!(
        call.name.as_str(),
        "workspace/read" | "workspace/list" | "workspace/search" | "workspace/apply-patch"
    ) {
        return Err(ModelError::new(ModelErrorKind::UnsupportedOutput, false));
    }
    if call.name == "workspace/apply-patch" {
        let patch = call.arguments.as_str().or_else(|| {
            call.arguments
                .as_object()
                .filter(|arguments| arguments.len() == 1)
                .and_then(|arguments| arguments.get("patch"))
                .and_then(serde_json::Value::as_str)
        });
        let patch = patch
            .filter(|patch| sugarcode_tools::validate_workspace_freeform_patch(patch).is_ok())
            .ok_or_else(|| ModelError::new(ModelErrorKind::InvalidRequest, false))?;
        return Ok(WorkspaceToolArguments {
            path: String::new(),
            recursive: false,
            query: None,
            advanced_search: None,
            freeform_patch: Some(patch.to_owned()),
        });
    }
    let Some(arguments) = call.arguments.as_object() else {
        return Err(ModelError::new(ModelErrorKind::Protocol, false));
    };
    let allowed = match call.name.as_str() {
        "workspace/read" => &["path"][..],
        "workspace/list" => &["path", "recursive"][..],
        "workspace/search" => &[
            "path",
            "query",
            "mode",
            "regex",
            "caseSensitive",
            "filePattern",
        ][..],
        _ => unreachable!(),
    };
    if arguments.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(ModelError::new(ModelErrorKind::InvalidRequest, false));
    }
    let valid_shape_size = match call.name.as_str() {
        "workspace/read" => arguments.len() == 1,
        "workspace/list" => matches!(arguments.len(), 1 | 2),
        "workspace/search" => (2..=6).contains(&arguments.len()),
        _ => false,
    };
    if !valid_shape_size {
        return Err(ModelError::new(ModelErrorKind::InvalidRequest, false));
    }
    let path = arguments
        .get("path")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ModelError::new(ModelErrorKind::InvalidRequest, false))?;
    let recursive = if call.name == "workspace/list" {
        arguments
            .get("recursive")
            .map(|value| {
                compatible_boolean(value)
                    .ok_or_else(|| ModelError::new(ModelErrorKind::InvalidRequest, false))
            })
            .transpose()?
            .unwrap_or(false)
    } else {
        false
    };
    let query = if call.name == "workspace/search" {
        Some(
            arguments
                .get("query")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| ModelError::new(ModelErrorKind::InvalidRequest, false))?,
        )
    } else {
        None
    };
    let advanced_search = if call.name == "workspace/search"
        && arguments.keys().any(|key| {
            matches!(
                key.as_str(),
                "mode" | "regex" | "caseSensitive" | "filePattern"
            )
        }) {
        let mode = match arguments.get("mode").and_then(serde_json::Value::as_str) {
            None | Some("content") => sugarcode_tools::WorkspaceSearchMode::Content,
            Some("path") => sugarcode_tools::WorkspaceSearchMode::Path,
            Some(_) => return Err(ModelError::new(ModelErrorKind::InvalidRequest, false)),
        };
        let bool_argument = |name: &str| -> Result<Option<bool>, ModelError> {
            arguments
                .get(name)
                .map(|value| {
                    value
                        .as_bool()
                        .ok_or_else(|| ModelError::new(ModelErrorKind::InvalidRequest, false))
                })
                .transpose()
        };
        let regex = bool_argument("regex")?.unwrap_or(false);
        let case_sensitive = bool_argument("caseSensitive")?
            .unwrap_or(mode == sugarcode_tools::WorkspaceSearchMode::Content);
        let file_pattern = arguments
            .get("filePattern")
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| ModelError::new(ModelErrorKind::InvalidRequest, false))
            })
            .transpose()?;
        Some(sugarcode_tools::WorkspaceAdvancedSearchArguments {
            path: path.clone(),
            query: query.clone().expect("validated workspace/search query"),
            mode,
            case_sensitive,
            regex,
            file_pattern,
        })
    } else {
        None
    };
    Ok(WorkspaceToolArguments {
        path,
        recursive,
        query,
        advanced_search,
        freeform_patch: None,
    })
}

pub(super) fn map_workspace_recursive_list_outcome(
    outcome: sugarcode_tools::WorkspaceRecursiveListOutcome,
) -> (CoreToolResult, String) {
    match outcome {
        sugarcode_tools::WorkspaceRecursiveListOutcome::Entries {
            entries,
            scanned,
            truncated,
        } => {
            let entries = entries
                .into_iter()
                .map(|entry| {
                    serde_json::json!({
                        "path": entry.path,
                        "name": entry.name,
                        "kind": entry.kind.as_str(),
                    })
                })
                .collect::<Vec<_>>();
            let content = serde_json::to_string(&serde_json::json!({
                "entries": entries,
                "scanned": scanned,
                "truncated": truncated,
            }))
            .expect("recursive workspace/list result must serialize");
            (
                CoreToolResult::Success {
                    bytes: u64::try_from(content.len()).unwrap_or(u64::MAX),
                    content: content.clone(),
                },
                content,
            )
        }
        sugarcode_tools::WorkspaceRecursiveListOutcome::Error { kind } => {
            map_workspace_list_outcome(WorkspaceListOutcome::Error { kind })
        }
    }
}

pub(super) fn is_workspace_write_tool(name: &str) -> bool {
    name == "workspace/apply-patch"
}

pub(super) fn map_workspace_read_outcome(
    outcome: WorkspaceReadOutcome,
) -> (CoreToolResult, String) {
    match outcome {
        WorkspaceReadOutcome::Content { content, bytes } => {
            use sha2::Digest;

            let sha256 = format!("{:x}", sha2::Sha256::digest(content.as_bytes()));
            let payload = serde_json::to_string(&serde_json::json!({
                "content": content,
                "bytes": bytes,
                "sha256": sha256,
            }))
            .expect("workspace/read result must serialize");
            (
                CoreToolResult::Success {
                    content: payload.clone(),
                    bytes: u64::try_from(bytes).unwrap_or(u64::MAX),
                },
                payload,
            )
        }
        WorkspaceReadOutcome::Error { kind } => {
            let kind = match kind {
                WorkspaceReadErrorKind::InvalidPath => CoreToolErrorKind::InvalidPath,
                WorkspaceReadErrorKind::NotFound => CoreToolErrorKind::NotFound,
                WorkspaceReadErrorKind::AccessDenied => CoreToolErrorKind::AccessDenied,
                WorkspaceReadErrorKind::PathNotAllowed => CoreToolErrorKind::PathNotAllowed,
                WorkspaceReadErrorKind::NotRegularFile => CoreToolErrorKind::NotRegularFile,
                WorkspaceReadErrorKind::FileTooLarge => CoreToolErrorKind::FileTooLarge,
                WorkspaceReadErrorKind::BinaryFile => CoreToolErrorKind::BinaryFile,
                WorkspaceReadErrorKind::ChangedDuringRead => CoreToolErrorKind::ChangedDuringRead,
                WorkspaceReadErrorKind::Cancelled => CoreToolErrorKind::Unavailable,
                WorkspaceReadErrorKind::Unavailable => CoreToolErrorKind::Unavailable,
            };
            (
                CoreToolResult::Error { kind },
                format!("workspace/read error: {kind}"),
            )
        }
    }
}

pub(super) fn map_workspace_list_outcome(
    outcome: WorkspaceListOutcome,
) -> (CoreToolResult, String) {
    match outcome {
        WorkspaceListOutcome::Entries {
            entries,
            name_bytes: _,
        } => {
            let entries = entries
                .into_iter()
                .map(|entry| {
                    serde_json::json!({
                        "name": entry.name,
                        "kind": entry.kind.as_str(),
                    })
                })
                .collect::<Vec<_>>();
            let content = serde_json::to_string(&serde_json::json!({ "entries": entries }))
                .expect("workspace/list result must serialize");
            (
                CoreToolResult::Success {
                    bytes: u64::try_from(content.len()).unwrap_or(u64::MAX),
                    content: content.clone(),
                },
                content,
            )
        }
        WorkspaceListOutcome::Error { kind } => {
            let kind = match kind {
                WorkspaceListErrorKind::InvalidPath => CoreToolErrorKind::InvalidPath,
                WorkspaceListErrorKind::NotFound => CoreToolErrorKind::NotFound,
                WorkspaceListErrorKind::AccessDenied => CoreToolErrorKind::AccessDenied,
                WorkspaceListErrorKind::PathNotAllowed => CoreToolErrorKind::PathNotAllowed,
                WorkspaceListErrorKind::NotDirectory => CoreToolErrorKind::NotDirectory,
                WorkspaceListErrorKind::InvalidEncoding => CoreToolErrorKind::InvalidEncoding,
                WorkspaceListErrorKind::InvalidName => CoreToolErrorKind::InvalidName,
                WorkspaceListErrorKind::TooManyEntries => CoreToolErrorKind::TooManyEntries,
                WorkspaceListErrorKind::ChangedDuringList => CoreToolErrorKind::ChangedDuringList,
                WorkspaceListErrorKind::ResultTooLarge => CoreToolErrorKind::ResultTooLarge,
                WorkspaceListErrorKind::Cancelled => CoreToolErrorKind::Unavailable,
                WorkspaceListErrorKind::Unavailable => CoreToolErrorKind::Unavailable,
            };
            (
                CoreToolResult::Error { kind },
                format!("workspace/list error: {kind}"),
            )
        }
    }
}

pub(super) fn map_workspace_search_outcome(
    outcome: WorkspaceSearchOutcome,
) -> (CoreToolResult, String) {
    match outcome {
        WorkspaceSearchOutcome::Matches { matches, truncated } => {
            let matches = matches
                .into_iter()
                .map(|matched| {
                    serde_json::json!({
                        "path": matched.path,
                        "line": matched.line,
                    })
                })
                .collect::<Vec<_>>();
            let content = serde_json::to_string(&serde_json::json!({
                "matches": matches,
                "truncated": truncated,
            }))
            .expect("workspace/search result must serialize");
            (
                CoreToolResult::Success {
                    bytes: u64::try_from(content.len()).unwrap_or(u64::MAX),
                    content: content.clone(),
                },
                content,
            )
        }
        WorkspaceSearchOutcome::Error { kind } => {
            let kind = match kind {
                WorkspaceSearchErrorKind::InvalidPath => CoreToolErrorKind::InvalidPath,
                WorkspaceSearchErrorKind::InvalidQuery => CoreToolErrorKind::InvalidQuery,
                WorkspaceSearchErrorKind::NotFound => CoreToolErrorKind::NotFound,
                WorkspaceSearchErrorKind::AccessDenied => CoreToolErrorKind::AccessDenied,
                WorkspaceSearchErrorKind::PathNotAllowed => CoreToolErrorKind::PathNotAllowed,
                WorkspaceSearchErrorKind::NotDirectory => CoreToolErrorKind::NotDirectory,
                WorkspaceSearchErrorKind::InvalidEncoding => CoreToolErrorKind::InvalidEncoding,
                WorkspaceSearchErrorKind::InvalidName => CoreToolErrorKind::InvalidName,
                WorkspaceSearchErrorKind::TooManyEntries => CoreToolErrorKind::TooManyEntries,
                WorkspaceSearchErrorKind::SearchLimitExceeded => {
                    CoreToolErrorKind::SearchLimitExceeded
                }
                WorkspaceSearchErrorKind::SearchTimedOut => CoreToolErrorKind::SearchTimedOut,
                WorkspaceSearchErrorKind::ChangedDuringSearch => {
                    CoreToolErrorKind::ChangedDuringSearch
                }
                WorkspaceSearchErrorKind::ResultTooLarge => CoreToolErrorKind::ResultTooLarge,
                WorkspaceSearchErrorKind::Cancelled => CoreToolErrorKind::Unavailable,
                WorkspaceSearchErrorKind::Unavailable => CoreToolErrorKind::Unavailable,
            };
            (
                CoreToolResult::Error { kind },
                format!("workspace/search error: {kind}"),
            )
        }
    }
}

pub(super) fn map_workspace_advanced_search_outcome(
    outcome: sugarcode_tools::WorkspaceAdvancedSearchOutcome,
) -> (CoreToolResult, String) {
    match outcome {
        sugarcode_tools::WorkspaceAdvancedSearchOutcome::Matches {
            matches,
            scanned,
            truncated,
        } => {
            let matches = matches
                .into_iter()
                .map(|matched| {
                    serde_json::json!({
                        "path": matched.path,
                        "line": matched.line,
                        "excerpt": matched.excerpt,
                        "kind": matched.kind.map(|kind| kind.as_str()),
                    })
                })
                .collect::<Vec<_>>();
            let content = serde_json::to_string(&serde_json::json!({
                "matches": matches,
                "scanned": scanned,
                "truncated": truncated,
            }))
            .expect("advanced workspace/search result must serialize");
            (
                CoreToolResult::Success {
                    bytes: u64::try_from(content.len()).unwrap_or(u64::MAX),
                    content: content.clone(),
                },
                content,
            )
        }
        sugarcode_tools::WorkspaceAdvancedSearchOutcome::Error { kind } => {
            map_workspace_search_outcome(WorkspaceSearchOutcome::Error { kind })
        }
    }
}

pub(super) fn map_workspace_patch_error(kind: WorkspacePatchErrorKind) -> CoreToolErrorKind {
    match kind {
        WorkspacePatchErrorKind::InvalidPath => CoreToolErrorKind::InvalidPath,
        WorkspacePatchErrorKind::NotFound => CoreToolErrorKind::NotFound,
        WorkspacePatchErrorKind::AccessDenied => CoreToolErrorKind::AccessDenied,
        WorkspacePatchErrorKind::PathNotAllowed => CoreToolErrorKind::PathNotAllowed,
        WorkspacePatchErrorKind::NotRegularFile => CoreToolErrorKind::NotRegularFile,
        WorkspacePatchErrorKind::FileTooLarge => CoreToolErrorKind::FileTooLarge,
        WorkspacePatchErrorKind::BinaryFile => CoreToolErrorKind::BinaryFile,
        WorkspacePatchErrorKind::InvalidEncoding => CoreToolErrorKind::InvalidEncoding,
        WorkspacePatchErrorKind::InvalidNewline => CoreToolErrorKind::InvalidNewline,
        WorkspacePatchErrorKind::HeaderCountMismatch => CoreToolErrorKind::HeaderCountMismatch,
        WorkspacePatchErrorKind::RangeOutOfBounds => CoreToolErrorKind::RangeOutOfBounds,
        WorkspacePatchErrorKind::ExpectedMismatch => CoreToolErrorKind::ExpectedMismatch,
        WorkspacePatchErrorKind::BaseRevisionMismatch => CoreToolErrorKind::BaseRevisionMismatch,
        WorkspacePatchErrorKind::UnsupportedDiffFeature => {
            CoreToolErrorKind::UnsupportedDiffFeature
        }
        WorkspacePatchErrorKind::TooManyLines => CoreToolErrorKind::TooManyLines,
        WorkspacePatchErrorKind::LineTooLong => CoreToolErrorKind::LineTooLong,
        WorkspacePatchErrorKind::ResultTooLarge => CoreToolErrorKind::ResultTooLarge,
        WorkspacePatchErrorKind::HardLinkNotAllowed => CoreToolErrorKind::HardLinkNotAllowed,
        WorkspacePatchErrorKind::CrossDeviceNotAllowed => CoreToolErrorKind::CrossDeviceNotAllowed,
        WorkspacePatchErrorKind::Conflict => CoreToolErrorKind::Conflict,
        WorkspacePatchErrorKind::AtomicReplaceUnavailable => {
            CoreToolErrorKind::AtomicReplaceUnavailable
        }
        WorkspacePatchErrorKind::Cancelled | WorkspacePatchErrorKind::Unavailable => {
            CoreToolErrorKind::Unavailable
        }
    }
}

pub(super) fn serialized_file_change_bytes(kind: &CoreItemKind) -> usize {
    let CoreItemKind::FileChange {
        call_id,
        path,
        kind,
        diff,
        before_sha256,
        after_sha256,
        before_bytes,
        after_bytes,
        newline_style,
        final_newline,
    } = kind
    else {
        return usize::MAX;
    };
    serde_json::to_vec(&serde_json::json!({
        "type": "fileChange",
        "callId": call_id,
        "path": path,
        "kind": match kind {
            sugarcode_protocol::CoreFileChangeKind::Create => "create",
            sugarcode_protocol::CoreFileChangeKind::Update => "update",
            sugarcode_protocol::CoreFileChangeKind::Delete => "delete",
        },
        "diff": diff,
        "beforeSha256": before_sha256,
        "afterSha256": after_sha256,
        "beforeBytes": before_bytes,
        "afterBytes": after_bytes,
        "newlineStyle": match newline_style {
            sugarcode_protocol::CoreFileChangeNewlineStyle::Lf => "lf",
            sugarcode_protocol::CoreFileChangeNewlineStyle::CrLf => "crLf",
        },
        "finalNewline": final_newline,
    }))
    .map_or(usize::MAX, |bytes| bytes.len())
}

pub(super) fn serialized_tool_result_bytes(result: &CoreToolResult) -> usize {
    let value = match result {
        CoreToolResult::Success { content, bytes } => serde_json::json!({
            "type": "success",
            "content": content,
            "bytes": bytes,
        }),
        CoreToolResult::Error { kind } => serde_json::json!({
            "type": "error",
            "kind": kind.to_string(),
        }),
        CoreToolResult::Process(process) => serde_json::json!({
            "type": "process",
            "stdout": process.stdout,
            "stderr": process.stderr,
            "stdoutBytes": process.stdout_bytes,
            "stderrBytes": process.stderr_bytes,
            "stdoutTruncated": process.stdout_truncated,
            "stderrTruncated": process.stderr_truncated,
            "encoding": process.encoding,
            "durationMs": process.duration_ms,
            "outcome": match process.outcome {
                sugarcode_protocol::CoreProcessOutcome::ExitCode { code } =>
                    serde_json::json!({"type": "exitCode", "code": code}),
                sugarcode_protocol::CoreProcessOutcome::Signal { signal } =>
                    serde_json::json!({"type": "signal", "signal": signal}),
                sugarcode_protocol::CoreProcessOutcome::TimedOut =>
                    serde_json::json!({"type": "timedOut"}),
            },
        }),
    };
    serde_json::to_vec(&value).map_or(usize::MAX, |bytes| bytes.len())
}

pub(super) async fn append_completed_tool_item(
    runtime: &CoreRuntime,
    prepared: &crate::PreparedTextTurn,
    kind: CoreItemKind,
) -> Result<CoreItemSnapshot, Terminal> {
    let item = runtime
        .lock_core()
        .and_then(|mut core| {
            core.append_completed_item(&prepared.thread_id, &prepared.turn_id, kind)
        })
        .map_err(terminal_for_item_append)?;
    let durable_event = CancellationToken::new();
    if !send_event(
        runtime,
        &durable_event,
        prepared.request_id,
        CoreEventKind::ItemStarted {
            thread_id: prepared.thread_id.clone(),
            turn_id: prepared.turn_id.clone(),
            item: item.clone(),
        },
    )
    .await
    {
        return Err(Terminal::Interrupted);
    }
    if !send_event(
        runtime,
        &durable_event,
        prepared.request_id,
        CoreEventKind::ItemCompleted {
            thread_id: prepared.thread_id.clone(),
            turn_id: prepared.turn_id.clone(),
            item: item.clone(),
        },
    )
    .await
    {
        return Err(Terminal::Interrupted);
    }
    Ok(item)
}

pub(super) async fn append_completed_agent_output_item(
    runtime: &CoreRuntime,
    prepared: &crate::PreparedTextTurn,
    output: CoreAgentOutputRef,
    kind: CoreItemKind,
) -> Result<CoreItemSnapshot, Terminal> {
    let item = runtime
        .lock_core()
        .and_then(|mut core| {
            core.append_completed_item(&prepared.thread_id, &prepared.turn_id, kind)
        })
        .map_err(terminal_for_item_append)?;
    let durable_event = CancellationToken::new();
    if !send_event(
        runtime,
        &durable_event,
        prepared.request_id,
        CoreEventKind::AgentOutputResolved {
            thread_id: prepared.thread_id.clone(),
            turn_id: prepared.turn_id.clone(),
            output,
            item: item.clone(),
        },
    )
    .await
    {
        return Err(Terminal::Interrupted);
    }
    if !send_event(
        runtime,
        &durable_event,
        prepared.request_id,
        CoreEventKind::ItemCompleted {
            thread_id: prepared.thread_id.clone(),
            turn_id: prepared.turn_id.clone(),
            item: item.clone(),
        },
    )
    .await
    {
        return Err(Terminal::Interrupted);
    }
    Ok(item)
}

fn terminal_for_item_append(error: CoreError) -> Terminal {
    match error {
        CoreError::ContextTooLarge | CoreError::OutputTooLarge => {
            Terminal::Failed(output_too_large_error())
        }
        CoreError::ThreadIdExhausted
        | CoreError::TurnIdExhausted
        | CoreError::ItemIdExhausted
        | CoreError::ThreadNotFound(_)
        | CoreError::NoActiveTurn(_)
        | CoreError::TurnAlreadyActive { .. }
        | CoreError::TurnNotInProgress(_)
        | CoreError::ItemNotInProgress(_)
        | CoreError::InvalidInput
        | CoreError::ModelUnavailable
        | CoreError::StateUnavailable
        | CoreError::Internal(_) => Terminal::StateUnavailable,
    }
}
