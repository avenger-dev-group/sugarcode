mod app;
mod render;
mod terminal;

#[cfg(test)]
#[path = "tests/app.rs"]
mod app_tests;

#[cfg(test)]
#[path = "tests/render.rs"]
mod render_tests;

use app::App;
use crossterm::event::Event;
use crossterm::event::EventStream;
use futures_util::StreamExt;
use std::io;
use std::path::PathBuf;
use std::time::Duration;
use sugarcode_agent_runtime::AgentSurfaceLaunchOptions;
use sugarcode_agent_runtime::AgentSurfaceRuntime;
use sugarcode_agent_runtime::AgentSurfaceRuntimeParts;
use sugarcode_agent_runtime::ThreadWorkspaceBinding;
use sugarcode_core::CommandApprovalOutcome;
use sugarcode_core::McpToolApprovalOutcome;
use terminal::TerminalSession;

pub const TERMINAL_TUI_VERSION: u32 = 1;

#[derive(Debug)]
pub struct TuiRequest {
    pub home: Option<PathBuf>,
    pub workspace: Option<PathBuf>,
    pub workspace_scope: Option<String>,
    pub allow_workspace_write: bool,
    pub allow_command_workspace_write: bool,
    pub mcp_servers: Vec<String>,
}

pub async fn run(request: TuiRequest) -> io::Result<()> {
    let config = sugarcode_state::load_effective_config(request.home)
        .map_err(|_| io::Error::other("configuration unavailable"))?;
    let runtime = AgentSurfaceRuntime::launch(AgentSurfaceLaunchOptions {
        config,
        workspace: request.workspace,
        workspace_scope: request.workspace_scope,
        thread_workspace_binding: ThreadWorkspaceBinding::Workspace,
        allow_workspace_write: request.allow_workspace_write,
        allow_command_workspace_write: request.allow_command_workspace_write,
        mcp_servers: request.mcp_servers,
        command_supervisor_executable: std::env::current_exe()?,
        repository: None,
    })
    .await?;
    let AgentSurfaceRuntimeParts {
        mut session,
        mut events,
        mut command_approvals,
        mut mcp_approvals,
        diagnostics,
        ..
    } = runtime.into_parts();
    let mut app = App::load(&mut session, diagnostics)?;
    let mut terminal = TerminalSession::enter()?;
    let mut input = EventStream::new();
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    let signal = termination_signal();
    tokio::pin!(signal);
    let mut signal_received = false;
    let mut events_open = true;
    let mut command_approvals_open = true;
    let mut mcp_approvals_open = true;

    loop {
        terminal.draw(&app)?;
        if app.should_quit() {
            break;
        }
        tokio::select! {
            event = input.next() => {
                match event {
                    Some(Ok(Event::Key(key))) => app.handle_key(key, &mut session)?,
                    Some(Ok(Event::Paste(text))) => app.handle_paste(&text),
                    Some(Ok(Event::Resize(_, _))) => {}
                    Some(Ok(_)) => {}
                    Some(Err(error)) => return Err(error),
                    None => app.request_quit(&mut session)?,
                }
            }
            event = events.recv(), if events_open => {
                match event {
                    Some(event) => app.handle_core_event(event),
                    None => {
                        events_open = false;
                        app.runtime_disconnected();
                    }
                }
            }
            approval = command_approvals.recv(), if command_approvals_open => {
                match approval {
                    Some(approval) => {
                        app.offer_command_approval(approval, CommandApprovalOutcome::Denied);
                    }
                    None => command_approvals_open = false,
                }
            }
            approval = mcp_approvals.recv(), if mcp_approvals_open => {
                match approval {
                    Some(approval) => {
                        app.offer_mcp_approval(approval, McpToolApprovalOutcome::Denied);
                    }
                    None => mcp_approvals_open = false,
                }
            }
            _ = tick.tick() => {}
            result = &mut signal, if !signal_received => {
                signal_received = true;
                result?;
                app.request_quit(&mut session)?;
            }
        }
    }

    app.deny_pending_approval();
    session.shutdown().await.map_err(io::Error::other)
}

async fn termination_signal() -> io::Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result,
            _ = terminate.recv() => Ok(()),
        }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await
    }
}
