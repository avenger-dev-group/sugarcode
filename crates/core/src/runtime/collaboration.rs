use super::*;
use serde::Deserialize;
use std::collections::BTreeSet;
use std::sync::atomic::AtomicU64;
use std::time::Instant;

pub(super) const MAX_SUBAGENTS_PER_TURN: usize = 12;
pub(super) const MAX_TASK_MARKDOWN_BYTES: usize = 64 * 1024;
pub(super) const MAX_AMENDMENT_BYTES: usize = 16 * 1024;
pub(super) const MAX_TOTAL_AMENDMENT_BYTES: usize = 64 * 1024;
const MAX_PUBLIC_SUMMARY_BYTES: usize = 16 * 1024;
const MAX_AUDITS_PER_ORCHESTRATION: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum AgentRole {
    Explorer,
    Worker,
    Auditor,
}

impl AgentRole {
    fn as_str(self) -> &'static str {
        match self {
            Self::Explorer => "explorer",
            Self::Worker => "worker",
            Self::Auditor => "auditor",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum AgentAccess {
    ReadOnly,
    WorkspaceWrite,
}

impl AgentAccess {
    fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "readOnly",
            Self::WorkspaceWrite => "workspaceWrite",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct DispatchTask {
    pub client_task_key: String,
    pub title: String,
    pub role: AgentRole,
    pub access: AgentAccess,
    #[serde(default)]
    pub depends_on: Vec<String>,
    pub task_markdown: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct DispatchArguments {
    pub tasks: Vec<DispatchTask>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct AmendArguments {
    pub client_task_key: String,
    pub amendment_markdown: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct WaitArguments {
    #[serde(default)]
    pub client_task_keys: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct InterruptArguments {
    pub client_task_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TaskStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Interrupted,
    Cancelled,
}

impl TaskStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
            Self::Cancelled => "cancelled",
        }
    }

    fn terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Interrupted | Self::Cancelled
        )
    }
}

#[derive(Debug, Clone)]
struct TaskRecord {
    envelope: DispatchTask,
    task_id: String,
    child_thread_id: ThreadId,
    status: TaskStatus,
    amendments: Vec<String>,
    delivered_amendments: usize,
    summary_markdown: String,
    duration_ms: u64,
    result_persisted: bool,
}

#[derive(Debug)]
struct Orchestration {
    id: String,
    parent_thread_id: ThreadId,
    parent_turn_id: TurnId,
    tasks: BTreeMap<String, TaskRecord>,
}

#[derive(Debug, Default)]
struct CollaborationState {
    orchestrations: BTreeMap<String, Orchestration>,
    child_to_orchestration: BTreeMap<ThreadId, (String, String)>,
}

#[derive(Debug)]
pub(super) struct CollaborationCoordinator {
    state: Mutex<CollaborationState>,
    notify: Notify,
    execution_slots: Arc<tokio::sync::Semaphore>,
    workspace: Arc<tokio::sync::RwLock<()>>,
    next_request_id: AtomicU64,
}

impl Default for CollaborationCoordinator {
    fn default() -> Self {
        Self {
            state: Mutex::new(CollaborationState::default()),
            notify: Notify::new(),
            execution_slots: Arc::new(tokio::sync::Semaphore::new(4)),
            workspace: Arc::new(tokio::sync::RwLock::new(())),
            next_request_id: AtomicU64::new(1u64 << 63),
        }
    }
}

impl CollaborationCoordinator {
    pub(super) fn tool_definitions(&self) -> Vec<ModelToolDefinition> {
        vec![
            ModelToolDefinition {
                name: "collaboration/dispatch".to_string(),
                description: "Create or extend the current Turn's bounded subagent DAG. Use only when independent exploration, implementation, or a fresh audit materially improves a complex task. Every workspaceWrite wave must include a readOnly auditor depending on all writes in that wave.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "tasks": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": MAX_SUBAGENTS_PER_TURN,
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "properties": {
                                    "clientTaskKey": { "type": "string" },
                                    "title": { "type": "string" },
                                    "role": { "type": "string", "enum": ["explorer", "worker", "auditor"] },
                                    "access": { "type": "string", "enum": ["readOnly", "workspaceWrite"] },
                                    "dependsOn": { "type": "array", "items": { "type": "string" } },
                                    "taskMarkdown": { "type": "string" }
                                },
                                "required": ["clientTaskKey", "title", "role", "access", "dependsOn", "taskMarkdown"]
                            }
                        }
                    },
                    "required": ["tasks"]
                }),
            },
            ModelToolDefinition {
                name: "collaboration/amend".to_string(),
                description: "Append an immutable Markdown amendment to one task. A running subagent receives it at its next model-round boundary.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "clientTaskKey": { "type": "string" },
                        "amendmentMarkdown": { "type": "string" }
                    },
                    "required": ["clientTaskKey", "amendmentMarkdown"]
                }),
            },
            ModelToolDefinition {
                name: "collaboration/wait".to_string(),
                description: "Wait for selected tasks, or for the entire current DAG when clientTaskKeys is empty. Returns bounded public statuses and final summaries.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "clientTaskKeys": { "type": "array", "items": { "type": "string" } }
                    },
                    "required": ["clientTaskKeys"]
                }),
            },
            ModelToolDefinition {
                name: "collaboration/interrupt".to_string(),
                description: "Cancel one queued or running task in the current Turn's orchestration.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "clientTaskKey": { "type": "string" }
                    },
                    "required": ["clientTaskKey"]
                }),
            },
        ]
    }

    pub(super) fn is_child_thread(&self, thread_id: &ThreadId) -> bool {
        self.state
            .lock()
            .is_ok_and(|state| state.child_to_orchestration.contains_key(thread_id))
    }

    pub(super) fn access_for_child(&self, thread_id: &ThreadId) -> Option<AgentAccess> {
        let state = self.state.lock().ok()?;
        let (orchestration_id, key) = state.child_to_orchestration.get(thread_id)?;
        Some(
            state
                .orchestrations
                .get(orchestration_id)?
                .tasks
                .get(key)?
                .envelope
                .access,
        )
    }

    pub(super) async fn acquire_workspace(
        &self,
        access: AgentAccess,
    ) -> WorkspaceCollaborationPermit {
        match access {
            AgentAccess::ReadOnly => WorkspaceCollaborationPermit {
                _guard: WorkspaceCollaborationGuard::Read {
                    _guard: self.workspace.clone().read_owned().await,
                },
            },
            AgentAccess::WorkspaceWrite => WorkspaceCollaborationPermit {
                _guard: WorkspaceCollaborationGuard::Write {
                    _guard: self.workspace.clone().write_owned().await,
                },
            },
        }
    }

    pub(super) fn take_amendments(&self, thread_id: &ThreadId) -> Vec<String> {
        let Ok(mut state) = self.state.lock() else {
            return Vec::new();
        };
        let Some((orchestration_id, key)) = state.child_to_orchestration.get(thread_id).cloned()
        else {
            return Vec::new();
        };
        let Some(task) = state
            .orchestrations
            .get_mut(&orchestration_id)
            .and_then(|orchestration| orchestration.tasks.get_mut(&key))
        else {
            return Vec::new();
        };
        let pending = task.amendments[task.delivered_amendments..].to_vec();
        task.delivered_amendments = task.amendments.len();
        pending
    }

    pub(super) fn validate_call(&self, call: &ModelToolCall) -> Result<(), ModelError> {
        match call.name.as_str() {
            "collaboration/dispatch" => {
                let arguments: DispatchArguments = parse_arguments(call)?;
                validate_dispatch_shape(&arguments.tasks)
            }
            "collaboration/amend" => {
                let arguments: AmendArguments = parse_arguments(call)?;
                if arguments.client_task_key.is_empty()
                    || arguments.amendment_markdown.is_empty()
                    || arguments.amendment_markdown.len() > MAX_AMENDMENT_BYTES
                {
                    return Err(invalid_request());
                }
                Ok(())
            }
            "collaboration/wait" => {
                let _: WaitArguments = parse_arguments(call)?;
                Ok(())
            }
            "collaboration/interrupt" => {
                let arguments: InterruptArguments = parse_arguments(call)?;
                if arguments.client_task_key.is_empty() {
                    return Err(invalid_request());
                }
                Ok(())
            }
            _ => Err(unsupported_output()),
        }
    }

    pub(super) async fn dispatch(
        self: &Arc<Self>,
        runtime: &CoreRuntime,
        prepared: &PreparedTextTurn,
        call: &ModelToolCall,
    ) -> Result<String, Terminal> {
        let arguments: DispatchArguments = parse_arguments(call).map_err(Terminal::Failed)?;
        validate_dispatch_shape(&arguments.tasks).map_err(Terminal::Failed)?;
        if self.is_child_thread(&prepared.thread_id) {
            return Err(Terminal::Failed(unsupported_output()));
        }
        let orchestration_id = format!(
            "orch/{}/{}",
            prepared.thread_id.as_str(),
            prepared.turn_id.as_str()
        );

        {
            let state = self.state.lock().map_err(|_| Terminal::StateUnavailable)?;
            validate_dispatch_against_orchestration(
                state.orchestrations.get(&orchestration_id),
                &arguments.tasks,
            )
            .map_err(Terminal::Failed)?;
        }

        let mut created = Vec::with_capacity(arguments.tasks.len());
        for task in &arguments.tasks {
            let task_id = format!("{orchestration_id}/{}", task.client_task_key);
            let request_id =
                CoreRequestId::new(self.next_request_id.fetch_add(1, Ordering::AcqRel));
            let event = match runtime.lock_core().and_then(|mut core| {
                core.start_subagent_thread(
                    request_id,
                    DurableThreadOrigin {
                        parent_thread_id: prepared.thread_id.clone(),
                        parent_turn_id: prepared.turn_id.clone(),
                        orchestration_id: orchestration_id.clone(),
                        task_id,
                        role: task.role.as_str().to_string(),
                    },
                )
            }) {
                Ok(event) => event,
                Err(_) => {
                    delete_created_threads(runtime, &created);
                    return Err(Terminal::StateUnavailable);
                }
            };
            let CoreEventKind::ThreadStarted { thread_id } = event.kind else {
                delete_created_threads(runtime, &created);
                return Err(Terminal::StateUnavailable);
            };
            created.push((task.clone(), thread_id));
        }

        {
            let mut state = self.state.lock().map_err(|_| Terminal::StateUnavailable)?;
            let orchestration = state
                .orchestrations
                .entry(orchestration_id.clone())
                .or_insert_with(|| Orchestration {
                    id: orchestration_id.clone(),
                    parent_thread_id: prepared.thread_id.clone(),
                    parent_turn_id: prepared.turn_id.clone(),
                    tasks: BTreeMap::new(),
                });
            for (task, child_thread_id) in &created {
                let task_id = format!("{orchestration_id}/{}", task.client_task_key);
                orchestration.tasks.insert(
                    task.client_task_key.clone(),
                    TaskRecord {
                        envelope: task.clone(),
                        task_id,
                        child_thread_id: child_thread_id.clone(),
                        status: TaskStatus::Queued,
                        amendments: Vec::new(),
                        delivered_amendments: 0,
                        summary_markdown: String::new(),
                        duration_ms: 0,
                        result_persisted: false,
                    },
                );
            }
            for (task, child_thread_id) in &created {
                state.child_to_orchestration.insert(
                    child_thread_id.clone(),
                    (orchestration_id.clone(), task.client_task_key.clone()),
                );
            }
        }

        for (task, child_thread_id) in &created {
            let task_id = format!("{orchestration_id}/{}", task.client_task_key);
            if append_completed_tool_item(
                runtime,
                prepared,
                CoreItemKind::AgentTask {
                    orchestration_id: orchestration_id.clone(),
                    task_id,
                    client_task_key: task.client_task_key.clone(),
                    child_thread_id: child_thread_id.clone(),
                    title: task.title.clone(),
                    role: task.role.as_str().to_string(),
                    access: task.access.as_str().to_string(),
                    depends_on: task.depends_on.clone(),
                    task_markdown: task.task_markdown.clone(),
                },
            )
            .await
            .is_none()
            {
                return Err(Terminal::StateUnavailable);
            }
        }

        let coordinator = self.clone();
        let runtime = runtime.clone();
        let orchestration_for_task = orchestration_id.clone();
        tokio::spawn(async move {
            coordinator.schedule(runtime, orchestration_for_task).await;
        });
        Ok(serde_json::json!({
            "orchestrationId": orchestration_id,
            "accepted": created.iter().map(|(task, _)| task.client_task_key.as_str()).collect::<Vec<_>>(),
        })
        .to_string())
    }

    pub(super) async fn amend(
        &self,
        runtime: &CoreRuntime,
        prepared: &PreparedTextTurn,
        call: &ModelToolCall,
    ) -> Result<String, Terminal> {
        let arguments: AmendArguments = parse_arguments(call).map_err(Terminal::Failed)?;
        let orchestration_id = format!(
            "orch/{}/{}",
            prepared.thread_id.as_str(),
            prepared.turn_id.as_str()
        );
        let task_id = {
            let mut state = self.state.lock().map_err(|_| Terminal::StateUnavailable)?;
            let task = state
                .orchestrations
                .get_mut(&orchestration_id)
                .and_then(|orchestration| orchestration.tasks.get_mut(&arguments.client_task_key))
                .ok_or_else(|| Terminal::Failed(invalid_request()))?;
            if task.status.terminal()
                || task
                    .amendments
                    .iter()
                    .map(String::len)
                    .sum::<usize>()
                    .checked_add(arguments.amendment_markdown.len())
                    .is_none_or(|bytes| bytes > MAX_TOTAL_AMENDMENT_BYTES)
            {
                return Err(Terminal::Failed(invalid_request()));
            }
            task.amendments.push(arguments.amendment_markdown.clone());
            task.task_id.clone()
        };
        if append_completed_tool_item(
            runtime,
            prepared,
            CoreItemKind::AgentTaskAmendment {
                orchestration_id,
                task_id,
                amendment_markdown: arguments.amendment_markdown,
            },
        )
        .await
        .is_none()
        {
            return Err(Terminal::StateUnavailable);
        }
        self.notify.notify_waiters();
        Ok("{\"accepted\":true}".to_string())
    }

    pub(super) async fn wait(
        &self,
        runtime: &CoreRuntime,
        prepared: &PreparedTextTurn,
        call: &ModelToolCall,
        cancellation: &CancellationToken,
    ) -> Result<String, Terminal> {
        let arguments: WaitArguments = parse_arguments(call).map_err(Terminal::Failed)?;
        let orchestration_id = format!(
            "orch/{}/{}",
            prepared.thread_id.as_str(),
            prepared.turn_id.as_str()
        );
        loop {
            let ready = {
                let state = self.state.lock().map_err(|_| Terminal::StateUnavailable)?;
                let orchestration = state
                    .orchestrations
                    .get(&orchestration_id)
                    .ok_or_else(|| Terminal::Failed(invalid_request()))?;
                let selected = selected_tasks(orchestration, &arguments.client_task_keys)
                    .map_err(Terminal::Failed)?;
                selected.iter().all(|task| task.status.terminal())
            };
            if ready {
                break;
            }
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(Terminal::Interrupted),
                _ = self.notify.notified() => {}
            }
        }

        let mut completed_items = Vec::new();
        let response = {
            let mut state = self.state.lock().map_err(|_| Terminal::StateUnavailable)?;
            let orchestration = state
                .orchestrations
                .get_mut(&orchestration_id)
                .ok_or_else(|| Terminal::Failed(invalid_request()))?;
            let selected_keys = if arguments.client_task_keys.is_empty() {
                orchestration.tasks.keys().cloned().collect::<Vec<_>>()
            } else {
                arguments.client_task_keys.clone()
            };
            let mut summaries = Vec::with_capacity(selected_keys.len());
            for key in selected_keys {
                let task = orchestration
                    .tasks
                    .get_mut(&key)
                    .ok_or_else(|| Terminal::Failed(invalid_request()))?;
                if !task.result_persisted {
                    completed_items.push(CoreItemKind::AgentTaskResult {
                        orchestration_id: orchestration_id.clone(),
                        task_id: task.task_id.clone(),
                        status: task.status.as_str().to_string(),
                        summary_markdown: task.summary_markdown.clone(),
                        duration_ms: task.duration_ms,
                    });
                    task.result_persisted = true;
                }
                summaries.push(serde_json::json!({
                    "clientTaskKey": key,
                    "status": task.status.as_str(),
                    "summaryMarkdown": task.summary_markdown,
                    "durationMs": task.duration_ms,
                }));
            }
            serde_json::json!({
                "orchestrationId": orchestration.id,
                "tasks": summaries,
            })
            .to_string()
        };
        for item in completed_items {
            if append_completed_tool_item(runtime, prepared, item)
                .await
                .is_none()
            {
                return Err(Terminal::StateUnavailable);
            }
        }
        Ok(response)
    }

    pub(super) fn interrupt(
        &self,
        runtime: &CoreRuntime,
        prepared: &PreparedTextTurn,
        call: &ModelToolCall,
    ) -> Result<String, Terminal> {
        let arguments: InterruptArguments = parse_arguments(call).map_err(Terminal::Failed)?;
        let orchestration_id = format!(
            "orch/{}/{}",
            prepared.thread_id.as_str(),
            prepared.turn_id.as_str()
        );
        let child_thread = {
            let mut state = self.state.lock().map_err(|_| Terminal::StateUnavailable)?;
            let task = state
                .orchestrations
                .get_mut(&orchestration_id)
                .and_then(|orchestration| orchestration.tasks.get_mut(&arguments.client_task_key))
                .ok_or_else(|| Terminal::Failed(invalid_request()))?;
            if task.status.terminal() {
                return Ok("{\"accepted\":false,\"alreadyTerminal\":true}".to_string());
            }
            task.status = TaskStatus::Cancelled;
            task.child_thread_id.clone()
        };
        if let Ok(active) = runtime.active.lock()
            && let Some(turn) = active.get(&child_thread)
        {
            turn.cancellation.cancel();
        }
        self.notify.notify_waiters();
        Ok("{\"accepted\":true}".to_string())
    }

    pub(super) fn cancel_descendants(
        &self,
        parent_thread_id: &ThreadId,
        parent_turn_id: &TurnId,
    ) -> Vec<ThreadId> {
        let Ok(mut state) = self.state.lock() else {
            return Vec::new();
        };
        let mut descendants = Vec::new();
        for orchestration in state.orchestrations.values_mut() {
            if &orchestration.parent_thread_id != parent_thread_id
                || &orchestration.parent_turn_id != parent_turn_id
            {
                continue;
            }
            for task in orchestration.tasks.values_mut() {
                if !task.status.terminal() {
                    task.status = TaskStatus::Cancelled;
                    descendants.push(task.child_thread_id.clone());
                }
            }
        }
        if !descendants.is_empty() {
            self.notify.notify_waiters();
        }
        descendants
    }

    pub(super) fn parent_can_complete(
        &self,
        parent_thread_id: &ThreadId,
        parent_turn_id: &TurnId,
    ) -> bool {
        self.state.lock().is_ok_and(|state| {
            state
                .orchestrations
                .values()
                .find(|orchestration| {
                    &orchestration.parent_thread_id == parent_thread_id
                        && &orchestration.parent_turn_id == parent_turn_id
                })
                .is_none_or(|orchestration| {
                    orchestration
                        .tasks
                        .values()
                        .all(|task| task.status.terminal() && task.result_persisted)
                })
        })
    }

    async fn schedule(self: Arc<Self>, runtime: CoreRuntime, orchestration_id: String) {
        loop {
            let launches = {
                let Ok(mut state) = self.state.lock() else {
                    return;
                };
                let Some(orchestration) = state.orchestrations.get_mut(&orchestration_id) else {
                    return;
                };
                let snapshot = orchestration
                    .tasks
                    .iter()
                    .map(|(key, task)| (key.clone(), task.status))
                    .collect::<BTreeMap<_, _>>();
                let mut launches = Vec::new();
                for (key, task) in &mut orchestration.tasks {
                    if task.status != TaskStatus::Queued {
                        continue;
                    }
                    let dependency_statuses = task
                        .envelope
                        .depends_on
                        .iter()
                        .filter_map(|dependency| snapshot.get(dependency).copied())
                        .collect::<Vec<_>>();
                    let ready = if task.envelope.role == AgentRole::Auditor {
                        dependency_statuses.iter().all(|status| status.terminal())
                    } else {
                        dependency_statuses
                            .iter()
                            .all(|status| *status == TaskStatus::Completed)
                    };
                    let blocked = task.envelope.role != AgentRole::Auditor
                        && dependency_statuses
                            .iter()
                            .any(|status| status.terminal() && *status != TaskStatus::Completed);
                    if blocked {
                        task.status = TaskStatus::Cancelled;
                        task.summary_markdown =
                            "Cancelled because a dependency did not complete successfully."
                                .to_string();
                    } else if ready {
                        task.status = TaskStatus::Running;
                        launches.push(key.clone());
                    }
                }
                launches
            };
            for key in launches {
                let coordinator = self.clone();
                let runtime = runtime.clone();
                let orchestration_id = orchestration_id.clone();
                tokio::spawn(async move {
                    coordinator.run_task(runtime, orchestration_id, key).await;
                });
            }
            let done = self.state.lock().is_ok_and(|state| {
                state
                    .orchestrations
                    .get(&orchestration_id)
                    .is_none_or(|orchestration| {
                        orchestration
                            .tasks
                            .values()
                            .all(|task| task.status.terminal())
                    })
            });
            if done {
                self.notify.notify_waiters();
                return;
            }
            self.notify.notified().await;
        }
    }

    async fn run_task(
        self: Arc<Self>,
        mut runtime: CoreRuntime,
        orchestration_id: String,
        key: String,
    ) {
        let (task, dependency_context) = {
            let Ok(state) = self.state.lock() else {
                return;
            };
            let Some(orchestration) = state.orchestrations.get(&orchestration_id) else {
                return;
            };
            let Some(task) = orchestration.tasks.get(&key).cloned() else {
                return;
            };
            let dependency_context = task
                .envelope
                .depends_on
                .iter()
                .filter_map(|dependency| orchestration.tasks.get(dependency))
                .map(|dependency| {
                    format!(
                        "## Dependency result: {}\n\nStatus: {}\n\n{}",
                        dependency.envelope.title,
                        dependency.status.as_str(),
                        dependency.summary_markdown
                    )
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            (task, dependency_context)
        };
        let _slot = match self.execution_slots.clone().acquire_owned().await {
            Ok(slot) => slot,
            Err(_) => return,
        };
        let input = if dependency_context.is_empty() {
            task.envelope.task_markdown.clone()
        } else {
            format!(
                "{}\n\n# Dependency results\n\n{}",
                task.envelope.task_markdown, dependency_context
            )
        };
        let input = if task.envelope.role == AgentRole::Auditor {
            format!(
                "{input}\n\n# Mandatory audit report format\n\n\
                 Return only a Markdown report with these headings:\n\n\
                 ## Verdict\n\n\
                 ## Findings\n\n\
                 ## Acceptance criteria\n\n\
                 ## Residual risks\n\n\
                 Each finding must include severity, evidence, and a concrete remediation."
            )
        } else {
            input
        };
        let still_running = self.state.lock().is_ok_and(|state| {
            state
                .orchestrations
                .get(&orchestration_id)
                .and_then(|orchestration| orchestration.tasks.get(&key))
                .is_some_and(|task| task.status == TaskStatus::Running)
        });
        if !still_running {
            return;
        }
        let started_at = Instant::now();
        let request_id = CoreRequestId::new(self.next_request_id.fetch_add(1, Ordering::AcqRel));
        let start = runtime.start_text_turn(request_id, task.child_thread_id.clone(), Some(input));
        let status = match start {
            Ok(TurnStartOutcome::Accepted { .. }) => {
                let done = runtime.active.lock().ok().and_then(|active| {
                    active
                        .get(&task.child_thread_id)
                        .map(|turn| turn.done.clone())
                });
                if let Some(done) = done {
                    done.wait().await;
                }
                runtime
                    .resume_thread(&task.child_thread_id)
                    .ok()
                    .and_then(|snapshot| snapshot.turns.last().cloned())
            }
            _ => None,
        };
        let (status, summary) =
            match status {
                Some(turn) => {
                    let summary =
                        turn.items
                            .iter()
                            .rev()
                            .find_map(|item| match item {
                                sugarcode_state::DurableItemSnapshot::AgentMessage {
                                    text, ..
                                } if !text.is_empty() => Some(text.clone()),
                                _ => None,
                            })
                            .unwrap_or_default();
                    let status = match turn.status {
                        DurableTurnStatus::Completed => TaskStatus::Completed,
                        DurableTurnStatus::Failed => TaskStatus::Failed,
                        DurableTurnStatus::Interrupted => TaskStatus::Interrupted,
                        DurableTurnStatus::InProgress => TaskStatus::Interrupted,
                    };
                    (status, summary)
                }
                None => (
                    TaskStatus::Failed,
                    "Subagent could not be started.".to_string(),
                ),
            };
        if let Ok(mut state) = self.state.lock()
            && let Some(task) = state
                .orchestrations
                .get_mut(&orchestration_id)
                .and_then(|orchestration| orchestration.tasks.get_mut(&key))
        {
            if task.status != TaskStatus::Cancelled {
                task.status = status;
                task.summary_markdown = truncate_utf8(summary, MAX_PUBLIC_SUMMARY_BYTES);
                task.duration_ms =
                    u64::try_from(started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
            }
        }
        self.notify.notify_waiters();
    }
}

pub(super) struct WorkspaceCollaborationPermit {
    _guard: WorkspaceCollaborationGuard,
}

enum WorkspaceCollaborationGuard {
    Read {
        _guard: tokio::sync::OwnedRwLockReadGuard<()>,
    },
    Write {
        _guard: tokio::sync::OwnedRwLockWriteGuard<()>,
    },
}

fn selected_tasks<'a>(
    orchestration: &'a Orchestration,
    keys: &[String],
) -> Result<Vec<&'a TaskRecord>, ModelError> {
    if keys.is_empty() {
        return Ok(orchestration.tasks.values().collect());
    }
    keys.iter()
        .map(|key| orchestration.tasks.get(key).ok_or_else(invalid_request))
        .collect()
}

pub(super) fn validate_dispatch_shape(tasks: &[DispatchTask]) -> Result<(), ModelError> {
    if tasks.is_empty() || tasks.len() > MAX_SUBAGENTS_PER_TURN {
        return Err(invalid_request());
    }
    let mut keys = BTreeSet::new();
    for task in tasks {
        if task.client_task_key.is_empty()
            || task.client_task_key.len() > 128
            || task.title.is_empty()
            || task.title.len() > 256
            || task.task_markdown.is_empty()
            || task.task_markdown.len() > MAX_TASK_MARKDOWN_BYTES
            || !keys.insert(task.client_task_key.clone())
            || (task.role == AgentRole::Auditor && task.access != AgentAccess::ReadOnly)
            || !required_markdown_sections(&task.task_markdown)
        {
            return Err(invalid_request());
        }
    }
    let writes = tasks
        .iter()
        .filter(|task| task.access == AgentAccess::WorkspaceWrite)
        .map(|task| task.client_task_key.as_str())
        .collect::<Vec<_>>();
    if !writes.is_empty()
        && !tasks.iter().any(|task| {
            task.role == AgentRole::Auditor
                && task.access == AgentAccess::ReadOnly
                && writes
                    .iter()
                    .all(|write| task.depends_on.iter().any(|dependency| dependency == write))
        })
    {
        return Err(invalid_request());
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn validate_initial_dispatch(tasks: &[DispatchTask]) -> Result<(), ModelError> {
    validate_dispatch_shape(tasks)?;
    validate_dispatch_against_orchestration(None, tasks)
}

fn required_markdown_sections(markdown: &str) -> bool {
    [
        "Objective",
        "Context",
        "Scope",
        "Constraints",
        "Deliverables",
        "Acceptance criteria",
        "Report format",
    ]
    .iter()
    .all(|heading| {
        markdown
            .lines()
            .any(|line| line.trim_start_matches('#').trim() == *heading)
    })
}

fn validate_dispatch_against_orchestration(
    existing: Option<&Orchestration>,
    tasks: &[DispatchTask],
) -> Result<(), ModelError> {
    let existing_count = existing.map_or(0, |orchestration| orchestration.tasks.len());
    if existing_count + tasks.len() > MAX_SUBAGENTS_PER_TURN {
        return Err(invalid_request());
    }
    let existing_audits = existing.map_or(0, |orchestration| {
        orchestration
            .tasks
            .values()
            .filter(|task| task.envelope.role == AgentRole::Auditor)
            .count()
    });
    let new_audits = tasks
        .iter()
        .filter(|task| task.role == AgentRole::Auditor)
        .count();
    if existing_audits + new_audits > MAX_AUDITS_PER_ORCHESTRATION {
        return Err(invalid_request());
    }

    let mut graph = existing
        .map(|orchestration| {
            orchestration
                .tasks
                .iter()
                .map(|(key, task)| (key.clone(), task.envelope.depends_on.clone()))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    for task in tasks {
        if graph
            .insert(task.client_task_key.clone(), task.depends_on.clone())
            .is_some()
        {
            return Err(invalid_request());
        }
    }
    if graph
        .values()
        .flatten()
        .any(|dependency| !graph.contains_key(dependency))
        || dependency_graph_has_cycle(&graph)
    {
        return Err(invalid_request());
    }
    Ok(())
}

fn dependency_graph_has_cycle(graph: &BTreeMap<String, Vec<String>>) -> bool {
    fn visit(
        key: &str,
        graph: &BTreeMap<String, Vec<String>>,
        visiting: &mut BTreeSet<String>,
        visited: &mut BTreeSet<String>,
    ) -> bool {
        if visited.contains(key) {
            return false;
        }
        if !visiting.insert(key.to_string()) {
            return true;
        }
        if graph.get(key).is_some_and(|dependencies| {
            dependencies
                .iter()
                .any(|dependency| visit(dependency, graph, visiting, visited))
        }) {
            return true;
        }
        visiting.remove(key);
        visited.insert(key.to_string());
        false
    }

    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    graph
        .keys()
        .any(|key| visit(key, graph, &mut visiting, &mut visited))
}

fn delete_created_threads(runtime: &CoreRuntime, created: &[(DispatchTask, ThreadId)]) {
    if let Ok(mut core) = runtime.lock_core() {
        for (_, thread_id) in created {
            let _ = core.delete_thread(thread_id);
        }
    }
}

fn truncate_utf8(mut value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let mut boundary = max_bytes;
    while !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    value.truncate(boundary);
    value.push_str("\n\n[Summary truncated]");
    value
}

fn parse_arguments<T: for<'de> Deserialize<'de>>(call: &ModelToolCall) -> Result<T, ModelError> {
    serde_json::from_value(call.arguments.clone()).map_err(|_| invalid_request())
}

fn invalid_request() -> ModelError {
    ModelError::new(ModelErrorKind::InvalidRequest, false)
}

fn unsupported_output() -> ModelError {
    ModelError::new(ModelErrorKind::UnsupportedOutput, false)
}
