mod event_mapping;
mod session;
mod stdio;
mod workspace_registry;

pub use session::Session;
pub use session::SessionState;
pub use stdio::serve;
pub use stdio::serve_with_events;
pub use stdio::serve_with_session;

use std::io;
use sugarcode_agent_runtime::AgentSurfaceLaunchOptions;
use sugarcode_agent_runtime::AgentSurfaceRuntime;
use sugarcode_agent_runtime::ThreadWorkspaceBinding;
use sugarcode_state::EffectiveConfig;

pub struct StdioOptions {
    pub config: EffectiveConfig,
    pub multi_workspace: bool,
    pub workspace: Option<std::path::PathBuf>,
    pub workspace_scope: Option<String>,
    pub unbound_threads: bool,
    pub allow_workspace_write: bool,
    pub allow_command_workspace_write: bool,
    pub mcp_servers: Vec<String>,
}

pub async fn run_stdio(options: StdioOptions) -> io::Result<()> {
    let StdioOptions {
        config,
        multi_workspace,
        workspace,
        workspace_scope,
        unbound_threads,
        allow_workspace_write,
        allow_command_workspace_write,
        mcp_servers,
    } = options;
    let command_supervisor_executable = std::env::current_exe()?;
    if multi_workspace {
        let (registry, runtime_inputs) = workspace_registry::WorkspaceRegistry::new(
            config,
            mcp_servers,
            command_supervisor_executable,
        )?;
        let input = tokio::io::BufReader::new(tokio::io::stdin());
        let output = tokio::io::BufWriter::new(tokio::io::stdout());
        return stdio::serve_workspace_registry(input, output, registry, runtime_inputs).await;
    }
    let runtime = AgentSurfaceRuntime::launch(AgentSurfaceLaunchOptions {
        config,
        workspace,
        workspace_scope,
        thread_workspace_binding: if unbound_threads {
            ThreadWorkspaceBinding::Unbound
        } else {
            ThreadWorkspaceBinding::Workspace
        },
        allow_workspace_write,
        allow_command_workspace_write,
        mcp_servers,
        command_supervisor_executable,
        repository: None,
    })
    .await?;
    let parts = runtime.into_parts();
    for diagnostic in parts.diagnostics {
        eprintln!("sugarcode: {diagnostic}");
    }
    let session = Session::with_agent_session_and_workspace(
        parts.session,
        parts.workspace,
        parts.mcp_capability,
    )
    .with_content_store(parts.content_store);
    let input = tokio::io::BufReader::new(tokio::io::stdin());
    let output = tokio::io::BufWriter::new(tokio::io::stdout());
    stdio::serve_with_events_and_approvals(
        input,
        output,
        session,
        parts.events,
        parts.command_approvals,
        parts.mcp_approvals,
    )
    .await
}

pub fn generate_typescript(out_dir: &std::path::Path) -> io::Result<()> {
    sugarcode_app_server_protocol::generate_typescript(out_dir)
}

pub fn generate_json_schema(out_dir: &std::path::Path) -> io::Result<()> {
    sugarcode_app_server_protocol::generate_json_schema(out_dir)
}
