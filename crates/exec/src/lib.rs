mod output;
mod signal;

#[cfg(test)]
#[path = "tests/output.rs"]
mod output_tests;

pub use output::EXEC_OUTPUT_VERSION;
pub use output::ExecErrorCategoryV1;
pub use output::ExecEventV1;
pub use output::ExecItemV1;
pub use output::ExecOutputFormat;
pub use output::ExecRecordV1;
pub use output::ExecRunModeV1;
pub use output::ExecRunStatusV1;
pub use signal::termination_token;

use output::OutputEmitter;
use output::write_standalone_error;
use std::io;
use std::io::Write;
use std::path::PathBuf;
use sugarcode_agent_runtime::AgentSurfaceLaunchOptions;
use sugarcode_agent_runtime::AgentSurfaceRuntime;
use sugarcode_agent_runtime::AgentSurfaceRuntimeParts;
use sugarcode_agent_runtime::AgentSurfaceSession;
use sugarcode_agent_runtime::ThreadWorkspaceBinding;
use sugarcode_core::CommandApprovalOutcome;
use sugarcode_core::CoreContentAsset;
use sugarcode_core::CoreError;
use sugarcode_core::CoreRuntime;
use sugarcode_core::CoreUserContentPart;
use sugarcode_core::McpToolApprovalOutcome;
use sugarcode_core::TurnInterruptOutcome;
use sugarcode_core::TurnStartOutcome;
use sugarcode_protocol::CoreEvent;
use sugarcode_protocol::CoreEventKind;
use sugarcode_protocol::ThreadId;
use sugarcode_protocol::TurnId;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub const EXEC_EXIT_SUCCESS: u8 = 0;
pub const EXEC_EXIT_INPUT: u8 = 2;
pub const EXEC_EXIT_CONFIGURATION: u8 = 3;
pub const EXEC_EXIT_TURN_FAILED: u8 = 4;
pub const EXEC_EXIT_INTERRUPTED: u8 = 5;
pub const EXEC_EXIT_OUTPUT: u8 = 6;
pub const EXEC_EXIT_INTERNAL: u8 = 7;
pub const MAX_EXEC_PROMPT_BYTES: usize = sugarcode_core::MAX_USER_MESSAGE_BYTES;

#[derive(Debug)]
pub struct ExecRequest {
    pub home: Option<PathBuf>,
    pub workspace: Option<PathBuf>,
    pub workspace_scope: Option<String>,
    pub allow_workspace_write: bool,
    pub allow_command_workspace_write: bool,
    pub mcp_servers: Vec<String>,
    pub resume_thread_id: Option<String>,
    pub model_profile_id: Option<String>,
    pub prompt: String,
    pub attachments: Vec<PathBuf>,
    pub output_format: ExecOutputFormat,
}

pub async fn run<W, D>(
    request: ExecRequest,
    stdout: &mut W,
    stderr: &mut D,
    cancellation: CancellationToken,
) -> u8
where
    W: Write,
    D: Write,
{
    if let Err(message) = validate_request(&request) {
        return surface_error(
            stdout,
            stderr,
            request.output_format,
            EXEC_EXIT_INPUT,
            ExecErrorCategoryV1::Input,
            message,
        );
    }

    let config = match sugarcode_state::load_effective_config(request.home.clone()) {
        Ok(config) => config,
        Err(_) => {
            return surface_error(
                stdout,
                stderr,
                request.output_format,
                EXEC_EXIT_CONFIGURATION,
                ExecErrorCategoryV1::Configuration,
                "configuration unavailable",
            );
        }
    };
    if config.models().is_none() {
        return surface_error(
            stdout,
            stderr,
            request.output_format,
            EXEC_EXIT_CONFIGURATION,
            ExecErrorCategoryV1::Configuration,
            "model unavailable",
        );
    }
    let content_store = match sugarcode_state::ContentStore::open(config.home()) {
        Ok(store) => store,
        Err(_) => {
            return surface_error(
                stdout,
                stderr,
                request.output_format,
                EXEC_EXIT_CONFIGURATION,
                ExecErrorCategoryV1::Configuration,
                "content store unavailable",
            );
        }
    };
    let input = match import_turn_content(&content_store, request.prompt, request.attachments) {
        Ok(input) => input,
        Err(message) => {
            return surface_error(
                stdout,
                stderr,
                request.output_format,
                EXEC_EXIT_INPUT,
                ExecErrorCategoryV1::Input,
                message,
            );
        }
    };
    let command_supervisor_executable = match std::env::current_exe() {
        Ok(path) => path,
        Err(_) => {
            return surface_error(
                stdout,
                stderr,
                request.output_format,
                EXEC_EXIT_CONFIGURATION,
                ExecErrorCategoryV1::Configuration,
                "runtime executable unavailable",
            );
        }
    };
    let runtime = match AgentSurfaceRuntime::launch(AgentSurfaceLaunchOptions {
        config,
        workspace: request.workspace,
        workspace_scope: request.workspace_scope,
        thread_workspace_binding: ThreadWorkspaceBinding::Workspace,
        allow_workspace_write: request.allow_workspace_write,
        allow_command_workspace_write: request.allow_command_workspace_write,
        mcp_servers: request.mcp_servers,
        command_supervisor_executable,
        repository: None,
    })
    .await
    {
        Ok(runtime) => runtime,
        Err(_) => {
            return surface_error(
                stdout,
                stderr,
                request.output_format,
                EXEC_EXIT_CONFIGURATION,
                ExecErrorCategoryV1::Configuration,
                "agent runtime unavailable",
            );
        }
    };
    run_with_runtime(
        runtime.into_parts(),
        RuntimeTurnRequest {
            resume_thread_id: request.resume_thread_id,
            model_profile_id: request.model_profile_id,
            input,
            output_format: request.output_format,
        },
        stdout,
        stderr,
        cancellation,
    )
    .await
}

struct RuntimeTurnRequest {
    resume_thread_id: Option<String>,
    model_profile_id: Option<String>,
    input: Vec<CoreUserContentPart>,
    output_format: ExecOutputFormat,
}

async fn run_with_runtime<W, D>(
    parts: AgentSurfaceRuntimeParts,
    request: RuntimeTurnRequest,
    stdout: &mut W,
    stderr: &mut D,
    cancellation: CancellationToken,
) -> u8
where
    W: Write,
    D: Write,
{
    let AgentSurfaceRuntimeParts {
        mut session,
        mut events,
        command_approvals,
        mcp_approvals,
        workspace: _,
        mcp_capability: _,
        diagnostics,
        content_store: _,
    } = parts;
    if write_diagnostics(stderr, &diagnostics).is_err() {
        let _ = session.shutdown().await;
        return EXEC_EXIT_OUTPUT;
    }
    let command_approval_task = tokio::spawn(deny_command_approvals(command_approvals));
    let mcp_approval_task = tokio::spawn(deny_mcp_approvals(mcp_approvals));
    let mut output = OutputEmitter::new(request.output_format, stdout);

    let (thread_id, mode, initial_event) = match request.resume_thread_id {
        Some(thread_id) => {
            let thread_id = match ThreadId::parse(thread_id) {
                Ok(thread_id) => thread_id,
                Err(_) => {
                    let _ = session.shutdown().await;
                    let code = emitter_error(
                        &mut output,
                        stderr,
                        EXEC_EXIT_INPUT,
                        ExecErrorCategoryV1::Input,
                        "thread ID must be a canonical UUIDv7",
                        None,
                        None,
                    );
                    command_approval_task.abort();
                    mcp_approval_task.abort();
                    return code;
                }
            };
            match session.resume_thread(&thread_id) {
                Ok(_) => (thread_id, ExecRunModeV1::Resume, None),
                Err(CoreError::ThreadNotFound(_)) => {
                    let _ = session.shutdown().await;
                    let code = emitter_error(
                        &mut output,
                        stderr,
                        EXEC_EXIT_INPUT,
                        ExecErrorCategoryV1::Input,
                        "thread not found",
                        None,
                        None,
                    );
                    finish_tasks(command_approval_task, mcp_approval_task);
                    return code;
                }
                Err(_) => {
                    let _ = session.shutdown().await;
                    let code = emitter_error(
                        &mut output,
                        stderr,
                        EXEC_EXIT_CONFIGURATION,
                        ExecErrorCategoryV1::Configuration,
                        "durable thread state unavailable",
                        None,
                        None,
                    );
                    finish_tasks(command_approval_task, mcp_approval_task);
                    return code;
                }
            }
        }
        None => match session.start_thread() {
            Ok(event) => {
                let thread_id = match &event.kind {
                    CoreEventKind::ThreadStarted { thread_id } => thread_id.clone(),
                    _ => {
                        let _ = session.shutdown().await;
                        let code = emitter_error(
                            &mut output,
                            stderr,
                            EXEC_EXIT_INTERNAL,
                            ExecErrorCategoryV1::Internal,
                            "invalid runtime event",
                            None,
                            None,
                        );
                        finish_tasks(command_approval_task, mcp_approval_task);
                        return code;
                    }
                };
                (thread_id, ExecRunModeV1::New, Some(event))
            }
            Err(CoreError::StateUnavailable) => {
                let _ = session.shutdown().await;
                let code = emitter_error(
                    &mut output,
                    stderr,
                    EXEC_EXIT_CONFIGURATION,
                    ExecErrorCategoryV1::Configuration,
                    "durable thread state unavailable",
                    None,
                    None,
                );
                finish_tasks(command_approval_task, mcp_approval_task);
                return code;
            }
            Err(_) => {
                let _ = session.shutdown().await;
                let code = emitter_error(
                    &mut output,
                    stderr,
                    EXEC_EXIT_INTERNAL,
                    ExecErrorCategoryV1::Internal,
                    "thread start failed",
                    None,
                    None,
                );
                finish_tasks(command_approval_task, mcp_approval_task);
                return code;
            }
        },
    };
    if output.run_started(thread_id.as_str(), mode).is_err()
        || initial_event
            .as_ref()
            .is_some_and(|event| output.event(event).is_err())
    {
        let _ = session.shutdown().await;
        let _ = write_diagnostic(stderr, "output unavailable");
        finish_tasks(command_approval_task, mcp_approval_task);
        return EXEC_EXIT_OUTPUT;
    }
    if cancellation.is_cancelled() {
        let _ = session.shutdown().await;
        let code = emitter_error(
            &mut output,
            stderr,
            EXEC_EXIT_INTERRUPTED,
            ExecErrorCategoryV1::Interrupted,
            "execution interrupted",
            Some(thread_id.as_str()),
            None,
        );
        finish_tasks(command_approval_task, mcp_approval_task);
        return code;
    }

    let (core_request_id, outcome) = match session.start_content_turn_with_model(
        thread_id.clone(),
        Some(request.input),
        request.model_profile_id,
    ) {
        Ok(result) => result,
        Err(CoreError::ModelUnavailable) => {
            let _ = session.shutdown().await;
            let code = emitter_error(
                &mut output,
                stderr,
                EXEC_EXIT_CONFIGURATION,
                ExecErrorCategoryV1::Configuration,
                "model unavailable",
                Some(thread_id.as_str()),
                None,
            );
            finish_tasks(command_approval_task, mcp_approval_task);
            return code;
        }
        Err(CoreError::InvalidInput | CoreError::ContextTooLarge) => {
            let _ = session.shutdown().await;
            let code = emitter_error(
                &mut output,
                stderr,
                EXEC_EXIT_INPUT,
                ExecErrorCategoryV1::Input,
                "invalid prompt",
                Some(thread_id.as_str()),
                None,
            );
            finish_tasks(command_approval_task, mcp_approval_task);
            return code;
        }
        Err(CoreError::StateUnavailable) => {
            let _ = session.shutdown().await;
            let code = emitter_error(
                &mut output,
                stderr,
                EXEC_EXIT_CONFIGURATION,
                ExecErrorCategoryV1::Configuration,
                "durable thread state unavailable",
                Some(thread_id.as_str()),
                None,
            );
            finish_tasks(command_approval_task, mcp_approval_task);
            return code;
        }
        Err(_) => {
            let _ = session.shutdown().await;
            let code = emitter_error(
                &mut output,
                stderr,
                EXEC_EXIT_INTERNAL,
                ExecErrorCategoryV1::Internal,
                "turn start failed",
                Some(thread_id.as_str()),
                None,
            );
            finish_tasks(command_approval_task, mcp_approval_task);
            return code;
        }
    };

    let mut active_turn_id = match &outcome {
        TurnStartOutcome::Accepted { turn_id } => Some(turn_id.clone()),
        TurnStartOutcome::Immediate(events) => events.iter().find_map(|event| match &event.kind {
            CoreEventKind::TurnStarted { turn_id, .. } => Some(turn_id.clone()),
            _ => None,
        }),
    };
    if let TurnStartOutcome::Immediate(immediate) = outcome {
        for event in immediate {
            if event.request_id != core_request_id {
                output_failure_shutdown(
                    &mut session,
                    &mut events,
                    &thread_id,
                    active_turn_id.as_ref(),
                )
                .await;
                let code = emitter_error(
                    &mut output,
                    stderr,
                    EXEC_EXIT_INTERNAL,
                    ExecErrorCategoryV1::Internal,
                    "invalid runtime event",
                    Some(thread_id.as_str()),
                    active_turn_id.as_ref().map(TurnId::as_str),
                );
                finish_tasks(command_approval_task, mcp_approval_task);
                return code;
            }
            if output.event(&event).is_err() {
                output_failure_shutdown(
                    &mut session,
                    &mut events,
                    &thread_id,
                    active_turn_id.as_ref(),
                )
                .await;
                let _ = write_diagnostic(stderr, "output unavailable");
                finish_tasks(command_approval_task, mcp_approval_task);
                return EXEC_EXIT_OUTPUT;
            }
            if let Some(status) = terminal_status(&event) {
                let code = finish_terminal(
                    &mut session,
                    &mut output,
                    stderr,
                    &thread_id,
                    active_turn_id.as_ref(),
                    status,
                )
                .await;
                finish_tasks(command_approval_task, mcp_approval_task);
                return code;
            }
        }
        output_failure_shutdown(
            &mut session,
            &mut events,
            &thread_id,
            active_turn_id.as_ref(),
        )
        .await;
        let code = emitter_error(
            &mut output,
            stderr,
            EXEC_EXIT_INTERNAL,
            ExecErrorCategoryV1::Internal,
            "turn ended without terminal event",
            Some(thread_id.as_str()),
            active_turn_id.as_ref().map(TurnId::as_str),
        );
        finish_tasks(command_approval_task, mcp_approval_task);
        return code;
    }

    let mut signal_requested = false;
    loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled(), if !signal_requested => {
                signal_requested = true;
                if let Some(turn_id) = active_turn_id.as_ref() {
                    match session.interrupt_turn(&thread_id, turn_id) {
                        Ok(TurnInterruptOutcome::Accepted | TurnInterruptOutcome::AlreadyTerminal) => {}
                        Err(_) => {
                            let _ = session.shutdown().await;
                            let code = emitter_error(
                                &mut output,
                                stderr,
                                EXEC_EXIT_INTERNAL,
                                ExecErrorCategoryV1::Internal,
                                "turn interruption failed",
                                Some(thread_id.as_str()),
                                Some(turn_id.as_str()),
                            );
                            finish_tasks(command_approval_task, mcp_approval_task);
                            return code;
                        }
                    }
                }
            }
            event = events.recv() => {
                let Some(event) = event else {
                    output_failure_shutdown(
                        &mut session,
                        &mut events,
                        &thread_id,
                        active_turn_id.as_ref(),
                    ).await;
                    let code = emitter_error(
                        &mut output,
                        stderr,
                        EXEC_EXIT_INTERNAL,
                        ExecErrorCategoryV1::Internal,
                        "runtime event stream closed",
                        Some(thread_id.as_str()),
                        active_turn_id.as_ref().map(TurnId::as_str),
                    );
                    finish_tasks(command_approval_task, mcp_approval_task);
                    return code;
                };
                if !belongs_to_exec_request(&event, core_request_id) {
                    // Collaboration children share Core's event channel but are hidden from the
                    // exec-v1 surface. Their public lifecycle is represented by the parent
                    // AgentTask and AgentTaskResult items.
                    continue;
                }
                if let CoreEventKind::TurnStarted { turn_id, .. } = &event.kind {
                    active_turn_id = Some(turn_id.clone());
                }
                if output.event(&event).is_err() {
                    output_failure_shutdown(
                        &mut session,
                        &mut events,
                        &thread_id,
                        active_turn_id.as_ref(),
                    ).await;
                    let _ = write_diagnostic(stderr, "output unavailable");
                    finish_tasks(command_approval_task, mcp_approval_task);
                    return EXEC_EXIT_OUTPUT;
                }
                if let Some(status) = terminal_status(&event) {
                    let code = finish_terminal(
                        &mut session,
                        &mut output,
                        stderr,
                        &thread_id,
                        active_turn_id.as_ref(),
                        status,
                    ).await;
                    finish_tasks(command_approval_task, mcp_approval_task);
                    return code;
                }
            }
        }
    }
}

#[derive(Clone, Copy)]
enum TerminalStatus {
    Completed,
    Failed,
    Interrupted,
    RuntimeFailed,
}

fn terminal_status(event: &CoreEvent) -> Option<TerminalStatus> {
    match event.kind {
        CoreEventKind::TurnCompleted { .. } => Some(TerminalStatus::Completed),
        CoreEventKind::TurnFailed { .. } => Some(TerminalStatus::Failed),
        CoreEventKind::TurnInterrupted { .. } => Some(TerminalStatus::Interrupted),
        CoreEventKind::RuntimeFailed => Some(TerminalStatus::RuntimeFailed),
        _ => None,
    }
}

async fn finish_terminal<W, D>(
    session: &mut AgentSurfaceSession<CoreRuntime>,
    output: &mut OutputEmitter<'_, W>,
    stderr: &mut D,
    thread_id: &ThreadId,
    turn_id: Option<&TurnId>,
    status: TerminalStatus,
) -> u8
where
    W: Write,
    D: Write,
{
    if session.shutdown().await.is_err() {
        return emitter_error(
            output,
            stderr,
            EXEC_EXIT_INTERNAL,
            ExecErrorCategoryV1::Internal,
            "runtime shutdown failed",
            Some(thread_id.as_str()),
            turn_id.map(TurnId::as_str),
        );
    }
    let (exit_code, run_status, category, message) = match status {
        TerminalStatus::Completed => (EXEC_EXIT_SUCCESS, ExecRunStatusV1::Completed, None, None),
        TerminalStatus::Failed => (
            EXEC_EXIT_TURN_FAILED,
            ExecRunStatusV1::Failed,
            Some(ExecErrorCategoryV1::TurnFailed),
            Some("turn failed"),
        ),
        TerminalStatus::Interrupted => (
            EXEC_EXIT_INTERRUPTED,
            ExecRunStatusV1::Interrupted,
            Some(ExecErrorCategoryV1::Interrupted),
            Some("execution interrupted"),
        ),
        TerminalStatus::RuntimeFailed => {
            return emitter_error(
                output,
                stderr,
                EXEC_EXIT_INTERNAL,
                ExecErrorCategoryV1::Internal,
                "runtime failed",
                Some(thread_id.as_str()),
                turn_id.map(TurnId::as_str),
            );
        }
    };
    if let (Some(category), Some(message)) = (category, message)
        && output
            .error(
                exit_code,
                category,
                message,
                Some(thread_id.as_str()),
                turn_id.map(TurnId::as_str),
            )
            .is_err()
    {
        let _ = write_diagnostic(stderr, "output unavailable");
        return EXEC_EXIT_OUTPUT;
    }
    if output
        .finished(thread_id.as_str(), turn_id.map(TurnId::as_str), run_status)
        .is_err()
    {
        let _ = write_diagnostic(stderr, "output unavailable");
        return EXEC_EXIT_OUTPUT;
    }
    if let Some(message) = message
        && write_diagnostic(stderr, message).is_err()
    {
        return EXEC_EXIT_OUTPUT;
    }
    exit_code
}

async fn output_failure_shutdown(
    session: &mut AgentSurfaceSession<CoreRuntime>,
    events: &mut mpsc::Receiver<CoreEvent>,
    thread_id: &ThreadId,
    turn_id: Option<&TurnId>,
) {
    if let Some(turn_id) = turn_id {
        let _ = session.interrupt_turn(thread_id, turn_id);
    }
    let _ = session.shutdown().await;
    while events.try_recv().is_ok() {}
}

fn belongs_to_exec_request(
    event: &CoreEvent,
    request_id: sugarcode_protocol::CoreRequestId,
) -> bool {
    event.request_id == request_id
}

async fn deny_command_approvals(
    mut approvals: mpsc::Receiver<sugarcode_agent_runtime::PendingCommandApproval>,
) {
    while let Some(pending) = approvals.recv().await {
        let _ = pending.response.send(CommandApprovalOutcome::Denied);
    }
}

async fn deny_mcp_approvals(
    mut approvals: mpsc::Receiver<sugarcode_agent_runtime::PendingMcpToolApproval>,
) {
    while let Some(pending) = approvals.recv().await {
        let _ = pending.response.send(McpToolApprovalOutcome::Denied);
    }
}

fn finish_tasks(command_task: tokio::task::JoinHandle<()>, mcp_task: tokio::task::JoinHandle<()>) {
    command_task.abort();
    mcp_task.abort();
}

fn validate_request(request: &ExecRequest) -> Result<(), &'static str> {
    if request.workspace.is_none() && request.workspace_scope.is_some() {
        return Err("workspace scope requires a workspace");
    }
    if (request.prompt.trim().is_empty() && request.attachments.is_empty())
        || request.prompt.len() > MAX_EXEC_PROMPT_BYTES
        || request.attachments.len() > sugarcode_state::MAX_TURN_ATTACHMENTS
    {
        return Err("invalid prompt");
    }
    if request
        .resume_thread_id
        .as_deref()
        .is_some_and(|thread_id| !is_canonical_thread_id(thread_id))
    {
        return Err("invalid thread id");
    }
    if request.model_profile_id.as_ref().is_some_and(|profile_id| {
        profile_id.is_empty()
            || profile_id.len() > 64
            || !profile_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    }) {
        return Err("invalid model profile id");
    }
    Ok(())
}

fn import_turn_content(
    store: &sugarcode_state::ContentStore,
    prompt: String,
    attachments: Vec<PathBuf>,
) -> Result<Vec<CoreUserContentPart>, &'static str> {
    let mut content = Vec::with_capacity(usize::from(!prompt.is_empty()) + attachments.len());
    if !prompt.is_empty() {
        content.push(CoreUserContentPart::Text { text: prompt });
    }
    let mut total_bytes = 0u64;
    for path in attachments {
        let metadata = std::fs::symlink_metadata(&path).map_err(|_| "invalid attachment")?;
        if !metadata.file_type().is_file() {
            return Err("invalid attachment");
        }
        total_bytes = total_bytes
            .checked_add(metadata.len())
            .ok_or("attachments are too large")?;
        if total_bytes > sugarcode_state::MAX_TURN_ATTACHMENT_BYTES {
            return Err("attachments are too large");
        }
        let original_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .ok_or("invalid attachment")?
            .to_owned();
        let bytes = std::fs::read(&path).map_err(|_| "invalid attachment")?;
        let asset = store
            .import(original_name, None, &bytes)
            .map_err(|_| "invalid attachment")?;
        let asset_ref = CoreContentAsset {
            asset_id: asset.asset_id,
            sha256: asset.sha256,
            media_type: asset.media_type,
            original_name: asset.original_name,
            size_bytes: asset.size_bytes,
        };
        content.push(match asset.kind {
            sugarcode_state::ContentAssetKind::Image => {
                CoreUserContentPart::Image { asset: asset_ref }
            }
            sugarcode_state::ContentAssetKind::Pdf | sugarcode_state::ContentAssetKind::Text => {
                CoreUserContentPart::Document { asset: asset_ref }
            }
        });
    }
    Ok(content)
}

fn is_canonical_thread_id(value: &str) -> bool {
    ThreadId::parse(value).is_ok()
}

fn surface_error<W, D>(
    stdout: &mut W,
    stderr: &mut D,
    format: ExecOutputFormat,
    exit_code: u8,
    category: ExecErrorCategoryV1,
    message: &'static str,
) -> u8
where
    W: Write,
    D: Write,
{
    if write_standalone_error(stdout, format, exit_code, category, message).is_err() {
        let _ = write_diagnostic(stderr, "output unavailable");
        return EXEC_EXIT_OUTPUT;
    }
    if write_diagnostic(stderr, message).is_err() {
        return EXEC_EXIT_OUTPUT;
    }
    exit_code
}

fn emitter_error<W, D>(
    output: &mut OutputEmitter<'_, W>,
    stderr: &mut D,
    exit_code: u8,
    category: ExecErrorCategoryV1,
    message: &'static str,
    thread_id: Option<&str>,
    turn_id: Option<&str>,
) -> u8
where
    W: Write,
    D: Write,
{
    if output
        .error(exit_code, category, message, thread_id, turn_id)
        .is_err()
    {
        let _ = write_diagnostic(stderr, "output unavailable");
        return EXEC_EXIT_OUTPUT;
    }
    if write_diagnostic(stderr, message).is_err() {
        return EXEC_EXIT_OUTPUT;
    }
    exit_code
}

fn write_diagnostics<D>(stderr: &mut D, diagnostics: &[String]) -> io::Result<()>
where
    D: Write,
{
    for diagnostic in diagnostics {
        write_diagnostic(stderr, diagnostic)?;
    }
    Ok(())
}

fn write_diagnostic<D>(stderr: &mut D, diagnostic: &str) -> io::Result<()>
where
    D: Write,
{
    writeln!(stderr, "sugarcode exec: {diagnostic}")?;
    stderr.flush()
}
