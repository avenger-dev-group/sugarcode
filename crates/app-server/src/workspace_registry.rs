use crate::Session;
use crate::SessionState;
use crate::session::error;
use crate::session::parse_request_id;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;
use sugarcode_agent_runtime::AgentSurfaceLaunchOptions;
use sugarcode_agent_runtime::AgentSurfaceRepository;
use sugarcode_agent_runtime::AgentSurfaceRuntime;
use sugarcode_agent_runtime::PendingCommandApproval;
use sugarcode_agent_runtime::PendingMcpToolApproval;
use sugarcode_agent_runtime::ThreadWorkspaceBinding;
use sugarcode_app_server_protocol::ERROR_INVALID_PARAMS;
use sugarcode_app_server_protocol::ERROR_METHOD_NOT_FOUND;
use sugarcode_app_server_protocol::ERROR_NOT_INITIALIZED;
use sugarcode_app_server_protocol::ERROR_THREAD_NOT_FOUND;
use sugarcode_app_server_protocol::ERROR_WORKSPACE_UNAVAILABLE;
use sugarcode_app_server_protocol::InitializeParams;
use sugarcode_app_server_protocol::JSON_RPC_VERSION;
use sugarcode_app_server_protocol::JsonRpcMessage;
use sugarcode_app_server_protocol::JsonRpcResponse;
use sugarcode_app_server_protocol::JsonRpcVersion;
use sugarcode_app_server_protocol::WorkspaceOpenParams;
use sugarcode_app_server_protocol::WorkspaceOpenResponse;
use sugarcode_core::Core;
use sugarcode_core::CoreIdAllocator;
use sugarcode_core::CoreRuntime;
use sugarcode_protocol::CoreEvent;
use sugarcode_protocol::CoreEventKind;
use sugarcode_protocol::ThreadId;
use sugarcode_protocol::TurnId;
use sugarcode_state::EffectiveConfig;
use sugarcode_state::RolloutRepositoryStore;
use sugarcode_tools::WorkspaceTool;
use tokio::sync::mpsc;

const RUNTIME_INPUT_CAPACITY: usize = 256;
const WORKSPACE_IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Clone)]
struct WorkspaceDescriptor {
    root: PathBuf,
    params: WorkspaceOpenParams,
}

struct LoadedWorkspace {
    session: Session<CoreRuntime>,
    active_turns: BTreeSet<TurnId>,
    last_used: Instant,
}

impl LoadedWorkspace {
    fn touch(&mut self) {
        self.last_used = Instant::now();
    }

    fn can_unload(&self, now: Instant, foreground: bool) -> bool {
        self.active_turns.is_empty()
            && !self.session.has_pending_approvals()
            && !foreground
            && now.duration_since(self.last_used) >= WORKSPACE_IDLE_TIMEOUT
    }
}

pub(crate) enum RuntimeInput {
    Event {
        workspace_id: String,
        event: CoreEvent,
    },
    CommandApproval {
        workspace_id: String,
        approval: PendingCommandApproval,
    },
    McpApproval {
        workspace_id: String,
        approval: PendingMcpToolApproval,
    },
}

pub(crate) struct WorkspaceRegistry {
    control: Session<Core>,
    initialize_params: Option<InitializeParams>,
    config: EffectiveConfig,
    mcp_servers: Vec<String>,
    command_supervisor_executable: PathBuf,
    repository_store: RolloutRepositoryStore,
    id_allocator: CoreIdAllocator,
    repository_diagnostics: Option<Vec<String>>,
    registered: HashMap<String, WorkspaceDescriptor>,
    contexts: HashMap<String, LoadedWorkspace>,
    foreground_workspace_id: Option<String>,
    thread_contexts: HashMap<ThreadId, String>,
    runtime_tx: mpsc::Sender<RuntimeInput>,
}

impl WorkspaceRegistry {
    pub(crate) fn new(
        config: EffectiveConfig,
        mcp_servers: Vec<String>,
        command_supervisor_executable: PathBuf,
    ) -> std::io::Result<(Self, mpsc::Receiver<RuntimeInput>)> {
        let (runtime_tx, runtime_rx) = mpsc::channel(RUNTIME_INPUT_CAPACITY);
        let repository_store =
            RolloutRepositoryStore::open(config.home()).map_err(std::io::Error::other)?;
        let id_allocator = CoreIdAllocator::new(repository_store.id_sequences());
        let repository_diagnostics = repository_store.diagnostics();
        Ok((
            Self {
                control: Session::new(),
                initialize_params: None,
                config,
                mcp_servers,
                command_supervisor_executable,
                repository_store,
                id_allocator,
                repository_diagnostics: Some(repository_diagnostics),
                registered: HashMap::new(),
                contexts: HashMap::new(),
                foreground_workspace_id: None,
                thread_contexts: HashMap::new(),
                runtime_tx,
            },
            runtime_rx,
        ))
    }

    pub(crate) async fn process_line(&mut self, line: &str) -> Vec<JsonRpcMessage> {
        let value = match serde_json::from_str::<Value>(line) {
            Ok(value) => value,
            Err(_) => return self.control.process_line(line),
        };
        let Some(object) = value.as_object() else {
            return self.control.process_line(line);
        };
        if object.get("jsonrpc").and_then(Value::as_str) != Some(JSON_RPC_VERSION) {
            return self.control.process_line(line);
        }
        let method = object.get("method").and_then(Value::as_str);
        match method {
            Some("initialize") => {
                let params = object
                    .get("params")
                    .cloned()
                    .and_then(|value| serde_json::from_value::<InitializeParams>(value).ok());
                let messages = self.control.process_line(line);
                if messages
                    .iter()
                    .any(|message| matches!(message, JsonRpcMessage::Response(_)))
                {
                    self.initialize_params = params;
                }
                messages
            }
            Some("initialized") => self.control.process_line(line),
            Some("workspace/open") => self.open_workspace(object).await,
            None => {
                for context in self.contexts.values_mut() {
                    context.touch();
                    let _ = context.session.process_line(line);
                }
                Vec::new()
            }
            Some(_) if self.control.state() != SessionState::Ready => {
                request_error(object, ERROR_NOT_INITIALIZED, "Not initialized")
            }
            Some(method) => {
                let workspace_id = explicit_workspace_id(object);
                if let Some(workspace_id) = workspace_id {
                    if !self.contexts.contains_key(workspace_id)
                        && self.load_workspace(workspace_id).await.is_err()
                    {
                        return request_error(
                            object,
                            ERROR_WORKSPACE_UNAVAILABLE,
                            "Workspace unavailable",
                        );
                    }
                    let context = self
                        .contexts
                        .get_mut(workspace_id)
                        .expect("loaded workspace exists");
                    context.touch();
                    let messages = context.session.process_line(line);
                    if method == "thread/resume"
                        && !messages.iter().any(is_error_response)
                        && let Some(thread_id) = request_thread_id(object)
                    {
                        self.thread_contexts
                            .insert(ThreadId::new(thread_id.to_owned()), workspace_id.to_owned());
                    }
                    return messages;
                }
                if method == "asset/import" {
                    let workspace_id = self.registered.keys().next().cloned();
                    let Some(workspace_id) = workspace_id else {
                        return request_error(
                            object,
                            ERROR_WORKSPACE_UNAVAILABLE,
                            "Workspace unavailable",
                        );
                    };
                    if self.load_workspace(&workspace_id).await.is_err() {
                        return request_error(
                            object,
                            ERROR_WORKSPACE_UNAVAILABLE,
                            "Workspace unavailable",
                        );
                    }
                    let context = self
                        .contexts
                        .get_mut(&workspace_id)
                        .expect("loaded workspace exists");
                    context.touch();
                    return context.session.process_line(line);
                }
                if let Some(thread_id) = request_thread_id(object) {
                    let thread_id = ThreadId::new(thread_id.to_owned());
                    let workspace_id =
                        self.thread_contexts.get(&thread_id).cloned().or_else(|| {
                            self.contexts.iter().find_map(|(workspace_id, context)| {
                                context
                                    .session
                                    .contains_thread_id(&thread_id)
                                    .then(|| workspace_id.clone())
                            })
                        });
                    if let Some(workspace_id) = workspace_id {
                        if self.load_workspace(&workspace_id).await.is_err() {
                            return request_error(
                                object,
                                ERROR_WORKSPACE_UNAVAILABLE,
                                "Workspace unavailable",
                            );
                        }
                        let context = self
                            .contexts
                            .get_mut(&workspace_id)
                            .expect("loaded workspace exists");
                        context.touch();
                        return context.session.process_line(line);
                    }
                    return request_error(object, ERROR_THREAD_NOT_FOUND, "Thread not found");
                }
                request_error(object, ERROR_METHOD_NOT_FOUND, "Method not found")
            }
        }
    }

    async fn open_workspace(
        &mut self,
        object: &serde_json::Map<String, Value>,
    ) -> Vec<JsonRpcMessage> {
        let Some(id) = parse_request_id(object.get("id")) else {
            return Vec::new();
        };
        if self.control.state() != SessionState::Ready {
            return vec![error(
                Some(id),
                ERROR_NOT_INITIALIZED,
                "Not initialized",
                None,
            )];
        }
        let params =
            match object.get("params").cloned().ok_or(()).and_then(|value| {
                serde_json::from_value::<WorkspaceOpenParams>(value).map_err(|_| ())
            }) {
                Ok(params) => params,
                Err(()) => {
                    return vec![error(
                        Some(id),
                        ERROR_INVALID_PARAMS,
                        "Invalid params",
                        None,
                    )];
                }
            };
        let root = PathBuf::from(&params.root);
        if !root.is_absolute() {
            return vec![error(
                Some(id),
                ERROR_INVALID_PARAMS,
                "Workspace root must be absolute",
                None,
            )];
        }
        let canonical_root = match std::fs::canonicalize(&root) {
            Ok(root) if root.is_absolute() => root,
            _ => {
                return vec![error(
                    Some(id),
                    ERROR_WORKSPACE_UNAVAILABLE,
                    "Workspace unavailable",
                    None,
                )];
            }
        };
        let workspace_id = match WorkspaceTool::open(&canonical_root) {
            Ok(workspace) => workspace.binding_id().to_owned(),
            Err(_) => {
                return vec![error(
                    Some(id),
                    ERROR_WORKSPACE_UNAVAILABLE,
                    "Workspace unavailable",
                    None,
                )];
            }
        };
        let descriptor = WorkspaceDescriptor {
            root: canonical_root,
            params,
        };
        let descriptor_changed = self.registered.get(&workspace_id).is_some_and(|existing| {
            existing.root != descriptor.root || existing.params != descriptor.params
        });
        if descriptor_changed && let Some(mut context) = self.contexts.remove(&workspace_id) {
            let _ = context.session.shutdown().await;
        }
        self.registered.insert(workspace_id.clone(), descriptor);
        self.foreground_workspace_id = Some(workspace_id.clone());
        if self.load_workspace(&workspace_id).await.is_err() {
            return vec![error(
                Some(id),
                ERROR_WORKSPACE_UNAVAILABLE,
                "Workspace unavailable",
                None,
            )];
        }
        vec![JsonRpcMessage::Response(JsonRpcResponse {
            jsonrpc: JsonRpcVersion::V2,
            id,
            result: serde_json::to_value(WorkspaceOpenResponse { workspace_id })
                .expect("workspace/open response serializes"),
        })]
    }

    async fn load_workspace(&mut self, workspace_id: &str) -> std::io::Result<()> {
        if let Some(context) = self.contexts.get_mut(workspace_id) {
            context.touch();
            return Ok(());
        }
        let descriptor = self
            .registered
            .get(workspace_id)
            .cloned()
            .ok_or_else(|| std::io::Error::other("workspace is not registered"))?;
        let runtime = match AgentSurfaceRuntime::launch(AgentSurfaceLaunchOptions {
            config: self.config.clone(),
            workspace: Some(descriptor.root),
            workspace_scope: None,
            thread_workspace_binding: ThreadWorkspaceBinding::Workspace,
            allow_workspace_write: descriptor.params.allow_workspace_write,
            allow_command_workspace_write: descriptor.params.allow_command_workspace_write,
            mcp_servers: self.mcp_servers.clone(),
            command_supervisor_executable: self.command_supervisor_executable.clone(),
            repository: Some(AgentSurfaceRepository {
                repository: Box::new(self.repository_store.workspace(Some(workspace_id))),
                id_allocator: self.id_allocator.clone(),
                diagnostics: self.repository_diagnostics.take().unwrap_or_default(),
            }),
        })
        .await
        {
            Ok(runtime) => runtime,
            Err(error) => return Err(error),
        };
        let parts = runtime.into_parts();
        let Some(workspace) = parts.workspace.as_ref() else {
            return Err(std::io::Error::other("workspace runtime is unbound"));
        };
        debug_assert_eq!(workspace.binding_id(), workspace_id);
        for diagnostic in &parts.diagnostics {
            eprintln!("sugarcode: {diagnostic}");
        }
        let mut session = Session::with_agent_session_and_workspace(
            parts.session,
            parts.workspace,
            parts.mcp_capability,
        )
        .with_content_store(parts.content_store);
        self.initialize_child(&mut session);
        forward_runtime_inputs(
            workspace_id.to_owned(),
            self.runtime_tx.clone(),
            parts.events,
            parts.command_approvals,
            parts.mcp_approvals,
        );
        self.contexts.insert(
            workspace_id.to_owned(),
            LoadedWorkspace {
                session,
                active_turns: BTreeSet::new(),
                last_used: Instant::now(),
            },
        );
        Ok(())
    }

    fn initialize_child(&self, session: &mut Session<CoreRuntime>) {
        let Some(params) = self.initialize_params.as_ref() else {
            return;
        };
        let initialize = json!({
            "jsonrpc": JSON_RPC_VERSION,
            "id": "__workspace_initialize",
            "method": "initialize",
            "params": params,
        });
        let _ = session.process_line(&initialize.to_string());
        let initialized = json!({
            "jsonrpc": JSON_RPC_VERSION,
            "method": "initialized",
            "params": {},
        });
        let _ = session.process_line(&initialized.to_string());
    }

    pub(crate) fn process_runtime_input(&mut self, input: RuntimeInput) -> Vec<JsonRpcMessage> {
        match input {
            RuntimeInput::Event {
                workspace_id,
                event,
            } => {
                match &event.kind {
                    CoreEventKind::ThreadStarted { thread_id } => {
                        self.thread_contexts
                            .insert(thread_id.clone(), workspace_id.clone());
                    }
                    CoreEventKind::TurnStarted { thread_id, turn_id } => {
                        self.thread_contexts
                            .insert(thread_id.clone(), workspace_id.clone());
                        if let Some(context) = self.contexts.get_mut(&workspace_id) {
                            context.active_turns.insert(turn_id.clone());
                        }
                    }
                    CoreEventKind::TurnCompleted { turn_id, .. }
                    | CoreEventKind::TurnFailed { turn_id, .. }
                    | CoreEventKind::TurnInterrupted { turn_id, .. } => {
                        if let Some(context) = self.contexts.get_mut(&workspace_id) {
                            context.active_turns.remove(turn_id);
                        }
                    }
                    CoreEventKind::RuntimeFailed => {
                        if let Some(context) = self.contexts.get_mut(&workspace_id) {
                            context.active_turns.clear();
                        }
                    }
                    _ => {}
                }
                self.contexts
                    .get_mut(&workspace_id)
                    .and_then(|context| {
                        context.touch();
                        context.session.process_core_event(event).ok()
                    })
                    .unwrap_or_default()
            }
            RuntimeInput::CommandApproval {
                workspace_id,
                approval,
            } => self
                .contexts
                .get_mut(&workspace_id)
                .and_then(|context| {
                    context.touch();
                    context.session.process_approval_request(approval)
                })
                .into_iter()
                .collect(),
            RuntimeInput::McpApproval {
                workspace_id,
                approval,
            } => self
                .contexts
                .get_mut(&workspace_id)
                .and_then(|context| {
                    context.touch();
                    context.session.process_mcp_approval_request(approval)
                })
                .into_iter()
                .collect(),
        }
    }

    pub(crate) async fn unload_idle(&mut self) {
        let now = Instant::now();
        let idle = self
            .contexts
            .iter()
            .filter(|(workspace_id, context)| {
                context.can_unload(
                    now,
                    self.foreground_workspace_id.as_deref() == Some(workspace_id),
                )
            })
            .map(|(workspace_id, _)| workspace_id.clone())
            .collect::<Vec<_>>();
        for workspace_id in idle {
            if let Some(mut context) = self.contexts.remove(&workspace_id) {
                let _ = context.session.shutdown().await;
            }
        }
    }

    pub(crate) async fn shutdown(&mut self) {
        let mut contexts = std::mem::take(&mut self.contexts);
        for context in contexts.values_mut() {
            let _ = context.session.shutdown().await;
        }
    }
}

fn forward_runtime_inputs(
    workspace_id: String,
    sender: mpsc::Sender<RuntimeInput>,
    mut events: mpsc::Receiver<CoreEvent>,
    mut command_approvals: mpsc::Receiver<PendingCommandApproval>,
    mut mcp_approvals: mpsc::Receiver<PendingMcpToolApproval>,
) {
    let event_workspace_id = workspace_id.clone();
    let event_sender = sender.clone();
    tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            if event_sender
                .send(RuntimeInput::Event {
                    workspace_id: event_workspace_id.clone(),
                    event,
                })
                .await
                .is_err()
            {
                return;
            }
        }
    });
    let approval_workspace_id = workspace_id.clone();
    let approval_sender = sender.clone();
    tokio::spawn(async move {
        while let Some(approval) = command_approvals.recv().await {
            if approval_sender
                .send(RuntimeInput::CommandApproval {
                    workspace_id: approval_workspace_id.clone(),
                    approval,
                })
                .await
                .is_err()
            {
                return;
            }
        }
    });
    tokio::spawn(async move {
        while let Some(approval) = mcp_approvals.recv().await {
            if sender
                .send(RuntimeInput::McpApproval {
                    workspace_id: workspace_id.clone(),
                    approval,
                })
                .await
                .is_err()
            {
                return;
            }
        }
    });
}

fn explicit_workspace_id(object: &serde_json::Map<String, Value>) -> Option<&str> {
    object
        .get("params")
        .and_then(Value::as_object)
        .and_then(|params| params.get("workspaceId"))
        .and_then(Value::as_str)
}

fn request_thread_id(object: &serde_json::Map<String, Value>) -> Option<&str> {
    object
        .get("params")
        .and_then(Value::as_object)
        .and_then(|params| params.get("threadId"))
        .and_then(Value::as_str)
}

fn request_error(
    object: &serde_json::Map<String, Value>,
    code: i32,
    message: &str,
) -> Vec<JsonRpcMessage> {
    let Some(id) = parse_request_id(object.get("id")) else {
        return Vec::new();
    };
    vec![error(Some(id), code, message, None)]
}

fn is_error_response(message: &JsonRpcMessage) -> bool {
    matches!(message, JsonRpcMessage::Error(_))
}
