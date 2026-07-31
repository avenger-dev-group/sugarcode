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
use sugarcode_credential_store::CredentialReference;
use sugarcode_credential_store::CredentialStore;
use sugarcode_credential_store::OsCredentialStore;
use sugarcode_model_provider::OpenAiChatCompletionsProvider;
use sugarcode_protocol::CoreEvent;
use sugarcode_state::EffectiveConfig;
use sugarcode_state::ModelApiFormat;
use sugarcode_state::RolloutRepository;
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
        let model = options.config.model().cloned();
        let model_token = model
            .as_ref()
            .and_then(|model| model.credential_reference())
            .map(|reference| load_model_token(options.config.home().path(), reference))
            .transpose();
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
        let (runtime, events) = match (model, model_token) {
            (Some(_), Err(_)) => {
                diagnostics.push("configured model credential is unavailable".to_string());
                CoreRuntime::without_model(core)
            }
            (Some(model), Ok(token)) => {
                let provider: Arc<dyn sugarcode_model_provider::ModelProvider> = match model
                    .api_format()
                {
                    ModelApiFormat::OpenAiChatCompletions => Arc::new(
                        OpenAiChatCompletionsProvider::new_secret(model.endpoint().clone(), token)
                            .map_err(io::Error::other)?,
                    ),
                };
                if let Some(Ok(command_workspace_root)) = command_workspace_root {
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
                        Ok(shell_executor) => CoreRuntime::new_with_shell(
                            core,
                            provider,
                            model.model().to_string(),
                            workspace_read,
                            workspace_list,
                            workspace_search,
                            Arc::new(shell_executor),
                            Arc::new(approval_requester),
                        ),
                        Err(_) => {
                            diagnostics
                                .push("shell/exec unavailable: sandboxUnavailable".to_string());
                            CoreRuntime::new_with_workspace_search(
                                core,
                                provider,
                                model.model().to_string(),
                                workspace_read,
                                workspace_list,
                                workspace_search,
                            )
                        }
                    }
                } else if command_workspace_root.is_some() {
                    diagnostics.push("shell/exec unavailable: sandboxUnavailable".to_string());
                    CoreRuntime::new_with_workspace_search(
                        core,
                        provider,
                        model.model().to_string(),
                        workspace_read,
                        workspace_list,
                        workspace_search,
                    )
                } else {
                    CoreRuntime::new_with_workspace_search(
                        core,
                        provider,
                        model.model().to_string(),
                        workspace_read,
                        workspace_list,
                        workspace_search,
                    )
                }
            }
            (None, Ok(None)) => CoreRuntime::without_model(core),
            (None, Ok(Some(_))) | (None, Err(_)) => {
                unreachable!("token lookup requires a model")
            }
        };
        let mut core = runtime
            .with_workspace_patch(workspace_patch)
            .with_workspace_instructions(workspace_instructions)
            .with_workspace_skills(workspace_skills);
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

fn load_model_token(home: &std::path::Path, reference: &str) -> io::Result<Zeroizing<String>> {
    let reference = CredentialReference::parse(reference).map_err(io::Error::other)?;
    let store = OsCredentialStore::new(home);
    let Some(secret) = store.get(&reference).map_err(io::Error::other)? else {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "configured model credential is missing",
        ));
    };
    let token = std::str::from_utf8(secret.expose())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "model credential is not UTF-8"))?;
    if token.len() > sugarcode_credential_store::MAX_SECRET_BYTES
        || !token.bytes().all(|byte| matches!(byte, 0x21..=0x7e))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "model credential is invalid",
        ));
    }
    Ok(Zeroizing::new(token.to_owned()))
}
