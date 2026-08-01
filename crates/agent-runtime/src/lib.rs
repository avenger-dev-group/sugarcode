mod approval;
mod mcp;
mod session;

#[cfg(test)]
#[path = "tests/session.rs"]
mod session_tests;

pub use approval::PendingCommandApproval;
pub use approval::PendingMcpToolApproval;
pub use session::AgentSurfaceSession;

use approval::ChannelCommandApprovalRequester;
use approval::ChannelMcpToolApprovalRequester;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use sugarcode_core::Core;
use sugarcode_core::CoreRuntime;
use sugarcode_core::McpToolCapability;
use sugarcode_core::ModelCapabilities;
use sugarcode_core::ModelResolver;
use sugarcode_core::ResolvedModel;
use sugarcode_model_provider::ModelError;
use sugarcode_model_provider::ModelErrorKind;
use sugarcode_model_provider::ModelStrictToolsMode;
use sugarcode_model_provider::NativeModelProvider;
use sugarcode_model_provider::OpenAiChatCompletionsProvider;
use sugarcode_protocol::CoreEvent;
use sugarcode_state::ContentStore;
use sugarcode_state::EffectiveConfig;
use sugarcode_state::ModelCapabilityMode;
use sugarcode_state::ModelWireApi;
use sugarcode_state::RolloutRepository;
use sugarcode_state::SugarCodeHome;
use sugarcode_tools::WorkspaceTool;
use tokio::sync::mpsc;
use zeroize::Zeroizing;

pub const IN_PROCESS_AGENT_SURFACE_RUNTIME_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ThreadWorkspaceBinding {
    Workspace,
    Unbound,
}

#[derive(Debug)]
pub struct AgentSurfaceLaunchOptions {
    pub config: EffectiveConfig,
    pub workspace: Option<PathBuf>,
    pub workspace_scope: Option<String>,
    pub thread_workspace_binding: ThreadWorkspaceBinding,
    pub allow_workspace_write: bool,
    pub allow_command_workspace_write: bool,
    pub mcp_servers: Vec<String>,
    pub command_supervisor_executable: PathBuf,
}

pub struct AgentSurfaceRuntime {
    session: AgentSurfaceSession<CoreRuntime>,
    events: mpsc::Receiver<CoreEvent>,
    command_approvals: mpsc::Receiver<PendingCommandApproval>,
    mcp_approvals: mpsc::Receiver<PendingMcpToolApproval>,
    workspace: Option<Arc<WorkspaceTool>>,
    mcp_capability: Option<McpToolCapability>,
    diagnostics: Vec<String>,
    content_store: Arc<ContentStore>,
}

impl std::fmt::Debug for AgentSurfaceRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AgentSurfaceRuntime")
            .field("version", &IN_PROCESS_AGENT_SURFACE_RUNTIME_VERSION)
            .field("workspace", &self.workspace.is_some())
            .field("mcp", &self.mcp_capability.is_some())
            .field("diagnostic_count", &self.diagnostics.len())
            .finish_non_exhaustive()
    }
}

pub struct AgentSurfaceRuntimeParts {
    pub session: AgentSurfaceSession<CoreRuntime>,
    pub events: mpsc::Receiver<CoreEvent>,
    pub command_approvals: mpsc::Receiver<PendingCommandApproval>,
    pub mcp_approvals: mpsc::Receiver<PendingMcpToolApproval>,
    pub workspace: Option<Arc<WorkspaceTool>>,
    pub mcp_capability: Option<McpToolCapability>,
    pub diagnostics: Vec<String>,
    pub content_store: Arc<ContentStore>,
}

#[derive(Clone)]
struct LocalModelResolver {
    home: SugarCodeHome,
}

impl ModelResolver for LocalModelResolver {
    fn resolve(&self, profile_id: Option<&str>) -> Result<ResolvedModel, ModelError> {
        let config = sugarcode_state::load_effective_config_for_home(self.home.clone())
            .map_err(|_| ModelError::new(ModelErrorKind::InvalidRequest, false))?;
        let models = config
            .models()
            .ok_or_else(|| ModelError::new(ModelErrorKind::InvalidRequest, false))?;
        let profile = models
            .profile(profile_id.unwrap_or_else(|| models.default_profile_id()))
            .ok_or_else(|| ModelError::new(ModelErrorKind::InvalidRequest, false))?;
        let connection = models
            .connection(profile.connection_id())
            .filter(|connection| connection.enabled())
            .ok_or_else(|| ModelError::new(ModelErrorKind::InvalidRequest, false))?;
        let token = connection
            .api_key()
            .map(|api_key| Zeroizing::new(api_key.to_owned()));
        let ceiling = WireCapabilityCeiling::for_wire_api(connection.wire_api());
        let tool_calls = resolve_capability(profile.tool_calls(), ceiling.tool_calls);
        let strict_tools = resolve_capability(profile.strict_tools(), ceiling.strict_tools);
        let strict_tools_mode =
            resolve_strict_tools_mode(profile.strict_tools(), ceiling.strict_tools);
        let parallel_tools = resolve_capability(profile.parallel_tools(), ceiling.parallel_tools);
        let image_input = resolve_capability(profile.image_input(), ceiling.image_input);
        let pdf_input = resolve_capability(profile.pdf_input(), ceiling.pdf_input);
        let capabilities = ModelCapabilities::new(
            profile.effective_context_window_tokens(),
            tool_calls,
            strict_tools,
            parallel_tools,
            image_input,
            pdf_input,
        );
        let provider: Arc<dyn sugarcode_model_provider::ModelProvider> = match connection.wire_api()
        {
            ModelWireApi::OpenAiChatCompletions => {
                let endpoint = sugarcode_model_provider::append_path(
                    connection.base_url(),
                    "chat/completions",
                )?;
                Arc::new(OpenAiChatCompletionsProvider::new_secret_with_capabilities(
                    endpoint,
                    token,
                    strict_tools_mode,
                    parallel_tools,
                )?)
            }
            ModelWireApi::OpenAiResponses => Arc::new(NativeModelProvider::openai_responses(
                connection.base_url().clone(),
                token,
                strict_tools_mode,
                parallel_tools,
                capabilities.output_reserve_tokens,
            )?),
            ModelWireApi::AnthropicMessages => Arc::new(NativeModelProvider::anthropic_messages(
                connection.base_url().clone(),
                token,
                strict_tools_mode,
                parallel_tools,
                capabilities.output_reserve_tokens,
            )?),
            ModelWireApi::GeminiGenerateContent => {
                Arc::new(NativeModelProvider::gemini_generate_content(
                    connection.base_url().clone(),
                    token,
                    strict_tools_mode,
                    parallel_tools,
                    capabilities.output_reserve_tokens,
                )?)
            }
        };
        Ok(ResolvedModel {
            provider,
            model: profile.model_id().to_string(),
            profile_id: profile.id().to_owned(),
            provider_family: connection.provider_family().as_str().to_owned(),
            wire_api: connection.wire_api().as_str().to_owned(),
            display_name: profile.display_name().to_owned(),
            capabilities,
        })
    }
}

#[derive(Debug, Clone, Copy)]
struct WireCapabilityCeiling {
    tool_calls: bool,
    strict_tools: bool,
    parallel_tools: bool,
    image_input: bool,
    pdf_input: bool,
}

impl WireCapabilityCeiling {
    const fn for_wire_api(wire_api: ModelWireApi) -> Self {
        Self {
            tool_calls: true,
            strict_tools: true,
            parallel_tools: true,
            image_input: true,
            pdf_input: !matches!(wire_api, ModelWireApi::OpenAiChatCompletions),
        }
    }
}

fn resolve_capability(mode: ModelCapabilityMode, automatic: bool) -> bool {
    match mode {
        ModelCapabilityMode::Auto => automatic,
        ModelCapabilityMode::Enabled => true,
        ModelCapabilityMode::Disabled => false,
    }
}

fn resolve_strict_tools_mode(mode: ModelCapabilityMode, supported: bool) -> ModelStrictToolsMode {
    if !supported {
        return ModelStrictToolsMode::Disabled;
    }
    match mode {
        ModelCapabilityMode::Auto => ModelStrictToolsMode::Auto,
        ModelCapabilityMode::Enabled => ModelStrictToolsMode::Enabled,
        ModelCapabilityMode::Disabled => ModelStrictToolsMode::Disabled,
    }
}

impl AgentSurfaceRuntime {
    pub async fn launch(options: AgentSurfaceLaunchOptions) -> io::Result<Self> {
        if options.workspace.is_none() && options.workspace_scope.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "workspace scope requires a workspace",
            ));
        }
        if !options.command_supervisor_executable.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "command supervisor executable must be absolute",
            ));
        }

        let workspace_root = options
            .workspace
            .as_deref()
            .map(WorkspaceTool::open)
            .transpose()
            .map_err(|kind| io::Error::new(io::ErrorKind::InvalidInput, format!("{kind:?}")))?
            .map(Arc::new);
        let (workspace, workspace_instructions, workspace_skills) = match workspace_root.as_ref() {
            Some(tool) => {
                let (scope, instructions, skills) = tool
                    .derive_scope_with_context(options.workspace_scope.as_deref().unwrap_or("."))
                    .map_err(|kind| {
                        let kind = match kind {
                            sugarcode_tools::WorkspaceScopeContextErrorKind::Scope(kind) => {
                                format!("{kind:?}")
                            }
                            sugarcode_tools::WorkspaceScopeContextErrorKind::Instructions(kind) => {
                                format!("{kind:?}")
                            }
                            sugarcode_tools::WorkspaceScopeContextErrorKind::Skills(kind) => {
                                format!("{kind:?}")
                            }
                        };
                        io::Error::new(io::ErrorKind::InvalidInput, kind)
                    })?;
                (Some(Arc::new(scope)), Some(instructions), Some(skills))
            }
            None => (None, None, None),
        };
        let command_workspace_root = workspace.as_ref().map(|tool| tool.command_workspace_root());
        let workspace_read: Option<Arc<dyn sugarcode_tools::WorkspaceReadExecutor>> = workspace
            .as_ref()
            .map(|tool| Arc::clone(tool) as Arc<dyn sugarcode_tools::WorkspaceReadExecutor>);
        let workspace_list: Option<Arc<dyn sugarcode_tools::WorkspaceListExecutor>> = workspace
            .as_ref()
            .map(|tool| Arc::clone(tool) as Arc<dyn sugarcode_tools::WorkspaceListExecutor>);
        let workspace_search: Option<Arc<dyn sugarcode_tools::WorkspaceSearchExecutor>> = workspace
            .as_ref()
            .map(|tool| Arc::clone(tool) as Arc<dyn sugarcode_tools::WorkspaceSearchExecutor>);
        let workspace_patch: Option<Arc<dyn sugarcode_tools::WorkspacePatchExecutor>> = options
            .allow_workspace_write
            .then(|| {
                workspace.as_ref().map(|tool| {
                    Arc::clone(tool) as Arc<dyn sugarcode_tools::WorkspacePatchExecutor>
                })
            })
            .flatten();
        let mcp = discover_selected_mcp_servers(&options.config, options.mcp_servers).await?;
        let model_resolver: Arc<dyn ModelResolver> = Arc::new(LocalModelResolver {
            home: options.config.home().clone(),
        });
        let active_workspace_binding = match options.thread_workspace_binding {
            ThreadWorkspaceBinding::Workspace => {
                workspace.as_ref().map(|workspace| workspace.binding_id())
            }
            ThreadWorkspaceBinding::Unbound => None,
        };
        let repository = RolloutRepository::open_with_workspace_binding(
            options.config.home(),
            active_workspace_binding,
        )
        .map_err(io::Error::other)?;
        let content_store =
            Arc::new(ContentStore::open(options.config.home()).map_err(io::Error::other)?);
        let mut diagnostics = repository
            .diagnostics()
            .iter()
            .map(ToString::to_string)
            .chain(
                repository
                    .projection_diagnostics()
                    .iter()
                    .map(ToString::to_string),
            )
            .chain(
                repository
                    .search_projection_diagnostics()
                    .iter()
                    .map(ToString::to_string),
            )
            .collect::<Vec<_>>();
        let core = Core::with_repository(Box::new(repository));
        let (approval_requester, command_approvals) = ChannelCommandApprovalRequester::channel(4);
        let (mcp_approval_requester, mcp_approvals) = ChannelMcpToolApprovalRequester::channel(1);
        let (runtime, events) = CoreRuntime::new_with_model_resolver(
            core,
            model_resolver,
            workspace_read,
            workspace_list,
            workspace_search,
        );
        let runtime = if let Some(Ok(command_workspace_root)) = command_workspace_root {
            let command_policy = if options.allow_command_workspace_write {
                sugarcode_tools::CommandSandboxPolicy::FILESYSTEM_READ_ONLY_COMMAND_WORKSPACE_WRITE_NETWORK_DENIED_V1
            } else {
                sugarcode_tools::CommandSandboxPolicy::FILESYSTEM_READ_ONLY_NETWORK_DENIED_V1
            };
            match sugarcode_tools::NativeShellCommandExecutor::new_with_policy(
                options.command_supervisor_executable,
                command_workspace_root,
                command_policy,
            ) {
                Ok(shell_executor) => runtime
                    .with_shell_capability(Arc::new(shell_executor), Arc::new(approval_requester)),
                Err(_) => {
                    diagnostics.push("shell/exec unavailable: sandboxUnavailable".to_string());
                    runtime
                }
            }
        } else {
            if command_workspace_root.is_some() {
                diagnostics.push("shell/exec unavailable: sandboxUnavailable".to_string());
            }
            runtime
        };
        let mut core = runtime
            .with_workspace_patch(workspace_patch)
            .with_workspace_instructions(workspace_instructions)
            .with_workspace_skills(workspace_skills)
            .with_content_store(Arc::clone(&content_store));
        let mcp_capability = McpToolCapability::default();
        let has_mcp = !mcp.is_empty();
        if has_mcp {
            let adapter = mcp::McpRuntimeAdapter::new(mcp).map_err(io::Error::other)?;
            core = core.with_mcp(
                Arc::new(adapter),
                Arc::new(mcp_approval_requester),
                mcp_capability.clone(),
            );
        }

        Ok(Self {
            session: AgentSurfaceSession::new(core),
            events,
            command_approvals,
            mcp_approvals,
            workspace,
            mcp_capability: has_mcp.then_some(mcp_capability),
            diagnostics,
            content_store,
        })
    }

    pub fn into_parts(self) -> AgentSurfaceRuntimeParts {
        AgentSurfaceRuntimeParts {
            session: self.session,
            events: self.events,
            command_approvals: self.command_approvals,
            mcp_approvals: self.mcp_approvals,
            workspace: self.workspace,
            mcp_capability: self.mcp_capability,
            diagnostics: self.diagnostics,
            content_store: self.content_store,
        }
    }
}

async fn discover_selected_mcp_servers(
    config: &EffectiveConfig,
    mut selected_server_ids: Vec<String>,
) -> io::Result<Vec<(mcp::McpServerSpec, sugarcode_mcp::McpServerInventory)>> {
    if selected_server_ids.len() > sugarcode_state::MAX_MCP_SERVERS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "too many MCP servers selected for this process",
        ));
    }
    selected_server_ids.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    if selected_server_ids.windows(2).any(|ids| ids[0] == ids[1]) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "duplicate MCP server selection",
        ));
    }

    let selected = selected_server_ids
        .into_iter()
        .map(|selected_server_id| {
            config
                .mcp_servers()
                .iter()
                .find(|server| server.id() == selected_server_id)
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!(
                            "MCP server `{selected_server_id}` is not configured for this process"
                        ),
                    )
                })
        })
        .collect::<io::Result<Vec<_>>>()?;
    if selected
        .iter()
        .any(|server| server.as_loopback_streamable_http().is_some())
        && (selected.len() != 1 || selected[0].as_loopback_streamable_http().is_none())
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Streamable HTTP MCP requires exactly one selected HTTP server",
        ));
    }
    let specs = selected
        .into_iter()
        .map(|server| {
            if let Some(server) = server.as_stdio() {
                Ok(mcp::McpServerSpec::Stdio(
                    sugarcode_mcp::StdioServerSpec::new(
                        server.id().to_owned(),
                        server.executable().to_path_buf(),
                        server.argv().to_vec(),
                        server.cwd().to_path_buf(),
                    ),
                ))
            } else if let Some(server) = server.as_loopback_streamable_http() {
                sugarcode_mcp::LoopbackStreamableHttpServerSpec::new(
                    server.id().to_owned(),
                    server.endpoint().as_str().to_owned(),
                )
                .map(mcp::McpServerSpec::LoopbackStreamableHttp)
                .map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "invalid loopback Streamable HTTP MCP endpoint",
                    )
                })
            } else {
                Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "unsupported MCP transport",
                ))
            }
        })
        .collect::<io::Result<Vec<_>>>()?;

    let mut discovered = Vec::with_capacity(specs.len());
    for spec in specs {
        let inventory = match &spec {
            mcp::McpServerSpec::Stdio(spec) => sugarcode_mcp::discover_stdio(spec).await,
            mcp::McpServerSpec::LoopbackStreamableHttp(spec) => {
                sugarcode_mcp::discover_loopback_streamable_http(spec).await
            }
        }
        .map_err(io::Error::other)?;
        discovered.push((spec, inventory));
    }
    Ok(discovered)
}
