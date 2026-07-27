mod approval;
mod event_mapping;
mod session;
mod stdio;

pub use session::Session;
pub use session::SessionState;
pub use stdio::serve;
pub use stdio::serve_with_events;
pub use stdio::serve_with_session;

use approval::ChannelCommandApprovalRequester;
use std::io;
use std::sync::Arc;
use sugarcode_core::Core;
use sugarcode_core::CoreRuntime;
use sugarcode_credential_store::CredentialReference;
use sugarcode_credential_store::CredentialStore;
use sugarcode_credential_store::OsCredentialStore;
use sugarcode_model_provider::OpenAiChatCompletionsProvider;
use sugarcode_state::EffectiveConfig;
use sugarcode_state::ModelApiFormat;
use sugarcode_state::RolloutRepository;
use zeroize::Zeroizing;

pub async fn run_stdio(
    config: EffectiveConfig,
    workspace: Option<std::path::PathBuf>,
    workspace_scope: Option<String>,
    allow_workspace_write: bool,
    allow_command_workspace_write: bool,
) -> io::Result<()> {
    if workspace.is_none() && workspace_scope.is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "workspace scope requires a workspace",
        ));
    }
    let workspace_root = workspace
        .as_deref()
        .map(sugarcode_tools::WorkspaceTool::open)
        .transpose()
        .map_err(|kind| io::Error::new(io::ErrorKind::InvalidInput, format!("{kind:?}")))?
        .map(Arc::new);
    let (workspace, workspace_instructions, workspace_skills) = match workspace_root.as_ref() {
        Some(tool) => {
            let (scope, instructions, skills) = tool
                .derive_scope_with_context(workspace_scope.as_deref().unwrap_or("."))
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
    let workspace_patch: Option<Arc<dyn sugarcode_tools::WorkspacePatchExecutor>> =
        allow_workspace_write
            .then(|| {
                workspace.as_ref().map(|tool| {
                    Arc::clone(tool) as Arc<dyn sugarcode_tools::WorkspacePatchExecutor>
                })
            })
            .flatten();
    let model = config.model().cloned();
    let model_token = model
        .as_ref()
        .and_then(|model| model.credential_reference())
        .map(|reference| load_model_token(config.home().path(), reference))
        .transpose();
    let repository = RolloutRepository::open(config.home()).map_err(io::Error::other)?;
    for diagnostic in repository.diagnostics() {
        eprintln!("sugarcode: {diagnostic}");
    }
    for diagnostic in repository.projection_diagnostics() {
        eprintln!("sugarcode: {diagnostic}");
    }
    for diagnostic in repository.search_projection_diagnostics() {
        eprintln!("sugarcode: {diagnostic}");
    }
    let core = Core::with_repository(Box::new(repository));
    let (approval_requester, approvals) = ChannelCommandApprovalRequester::channel(4);
    let (runtime, events) = match (model, model_token) {
        (Some(_), Err(_)) => {
            eprintln!("sugarcode: configured model credential is unavailable");
            CoreRuntime::without_model(core)
        }
        (Some(model), Ok(token)) => {
            let provider: Arc<dyn sugarcode_model_provider::ModelProvider> =
                match model.api_format() {
                    ModelApiFormat::OpenAiChatCompletions => Arc::new(
                        OpenAiChatCompletionsProvider::new_secret(model.endpoint().clone(), token)
                            .map_err(io::Error::other)?,
                    ),
                };
            if let Some(Ok(command_workspace_root)) = command_workspace_root {
                let executable = std::env::current_exe()?;
                let command_policy = if allow_command_workspace_write {
                    sugarcode_tools::CommandSandboxPolicy::FILESYSTEM_READ_ONLY_COMMAND_WORKSPACE_WRITE_NETWORK_DENIED_V1
                } else {
                    sugarcode_tools::CommandSandboxPolicy::FILESYSTEM_READ_ONLY_NETWORK_DENIED_V1
                };
                match sugarcode_tools::NativeShellCommandExecutor::new_with_policy(
                    executable,
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
                        eprintln!("sugarcode: shell/exec unavailable: sandboxUnavailable");
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
                eprintln!("sugarcode: shell/exec unavailable: sandboxUnavailable");
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
        (None, Ok(Some(_))) | (None, Err(_)) => unreachable!("token lookup requires a model"),
    };
    let session = Session::with_core(
        runtime
            .with_workspace_patch(workspace_patch)
            .with_workspace_instructions(workspace_instructions)
            .with_workspace_skills(workspace_skills),
    );
    let input = tokio::io::BufReader::new(tokio::io::stdin());
    let output = tokio::io::BufWriter::new(tokio::io::stdout());
    stdio::serve_with_events_and_approvals(input, output, session, events, approvals).await
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

pub fn generate_typescript(out_dir: &std::path::Path) -> io::Result<()> {
    sugarcode_app_server_protocol::generate_typescript(out_dir)
}

pub fn generate_json_schema(out_dir: &std::path::Path) -> io::Result<()> {
    sugarcode_app_server_protocol::generate_json_schema(out_dir)
}
