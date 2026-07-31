use super::*;
use crate::runtime::collaboration::{
    AgentAccess, AgentRole, CollaborationCoordinator, DispatchTask, validate_dispatch_shape,
    validate_initial_dispatch,
};

#[derive(Debug)]
struct RoutingCollaborationProvider {
    root_round: AtomicUsize,
    requests: Arc<Mutex<Vec<ModelRequest>>>,
}

impl RoutingCollaborationProvider {
    fn root_events(&self) -> Vec<Result<ModelEvent, ModelError>> {
        match self.root_round.fetch_add(1, Ordering::AcqRel) {
            0 => {
                let task_markdown = [
                    "# Objective",
                    "SUBAGENT_MARKER inspect the workspace.",
                    "# Context",
                    "A bounded integration fixture.",
                    "# Scope",
                    "Read-only inspection.",
                    "# Constraints",
                    "Do not write.",
                    "# Deliverables",
                    "A concise summary.",
                    "# Acceptance criteria",
                    "Report completion.",
                    "# Report format",
                    "Markdown.",
                ]
                .join("\n\n");
                vec![
                    Ok(model_event::tool_call_batch(vec![
                        ModelToolCall {
                            id: "call_dispatch".to_string(),
                            name: "collaboration/dispatch".to_string(),
                            arguments: serde_json::json!({
                                "tasks": [{
                                    "clientTaskKey": "explore",
                                    "title": "Inspect the workspace",
                                    "role": "explorer",
                                    "access": "readOnly",
                                    "dependsOn": [],
                                    "taskMarkdown": task_markdown
                                }]
                            }),
                        },
                        ModelToolCall {
                            id: "call_wait".to_string(),
                            name: "collaboration/wait".to_string(),
                            arguments: serde_json::json!({
                                "clientTaskKeys": ["explore"]
                            }),
                        },
                    ])),
                    Ok(model_event::COMPLETED),
                ]
            }
            1 => vec![
                Ok(model_event::text_delta(
                    "Delegation completed after the child result was recorded.".to_string(),
                )),
                Ok(model_event::COMPLETED),
            ],
            _ => panic!("unexpected root model round"),
        }
    }
}

impl ModelProvider for RoutingCollaborationProvider {
    fn stream(&self, request: ModelRequest) -> BoxModelFuture<'_> {
        self.requests
            .lock()
            .expect("requests")
            .push(request.clone());
        let is_child = request.messages.iter().any(|message| {
            matches!(
                message,
                ModelMessage::Text { text, .. } if text.contains("SUBAGENT_MARKER")
            )
        });
        let events = if is_child {
            vec![
                Ok(model_event::text_delta(
                    "Workspace inspection completed.".to_string(),
                )),
                Ok(model_event::COMPLETED),
            ]
        } else {
            self.root_events()
        };
        let events = normalize_model_events(events);
        async move { Ok(stream::iter(events).boxed()) }.boxed()
    }
}

#[tokio::test]
async fn dispatch_wait_persists_hidden_child_origin_and_public_result() {
    let mut core = Core::new();
    let started = core
        .start_thread(CoreRequestId::new(1))
        .expect("start parent thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    let provider = RoutingCollaborationProvider {
        root_round: AtomicUsize::new(0),
        requests: Arc::new(Mutex::new(Vec::new())),
    };
    let requests = provider.requests.clone();
    let (mut runtime, mut events) =
        CoreRuntime::new(core, Arc::new(provider), "fixture-model".to_string());
    let TurnStartOutcome::Accepted { turn_id } = runtime
        .start_text_turn(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Use delegation for this fixture.".to_string()),
        )
        .expect("start parent turn")
    else {
        panic!("asynchronous turn");
    };

    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let event = events.recv().await.expect("runtime event");
            if let CoreEventKind::TurnCompleted {
                thread_id: completed_thread,
                turn_id: completed_turn,
            } = event.kind
                && completed_thread == thread_id
                && completed_turn == turn_id
            {
                break;
            }
        }
    })
    .await
    .expect("collaboration turn must finish");

    let parent = runtime.resume_thread(&thread_id).expect("resume parent");
    let parent_turn = parent
        .turns
        .iter()
        .find(|candidate| candidate.id == turn_id)
        .expect("parent turn");
    assert!(parent_turn.items.iter().any(|item| matches!(
        item,
        sugarcode_state::DurableItemSnapshot::AgentTask {
            client_task_key,
            role,
            access,
            ..
        } if client_task_key == "explore" && role == "explorer" && access == "readOnly"
    )));
    assert!(parent_turn.items.iter().any(|item| matches!(
        item,
        sugarcode_state::DurableItemSnapshot::AgentTaskResult {
            status,
            summary_markdown,
            ..
        } if status == "completed" && summary_markdown == "Workspace inspection completed."
    )));

    let descendants = runtime
        .list_descendants(&thread_id)
        .expect("list hidden descendants");
    assert_eq!(descendants.len(), 1);
    let origin = descendants[0].origin.as_ref().expect("subagent origin");
    assert_eq!(origin.parent_thread_id, thread_id);
    assert_eq!(origin.parent_turn_id, turn_id);
    assert_eq!(origin.role, "explorer");
    assert_eq!(
        descendants[0].turns.last().expect("child turn").status,
        DurableTurnStatus::Completed
    );
    assert!(requests.lock().expect("requests").iter().any(|request| {
        matches!(
            request.messages.as_slice(),
            [
                ..,
                ModelMessage::ToolCallBatch(calls),
                ModelMessage::ToolResult { call_id: dispatch, .. },
                ModelMessage::ToolResult { call_id: wait, .. },
            ] if calls.len() == 2 && dispatch == "call_dispatch" && wait == "call_wait"
        )
    }));
}

#[test]
fn collaboration_dispatch_shape_requires_auditor_and_core_markdown() {
    let task = DispatchTask {
        client_task_key: "writer".to_string(),
        title: "Write".to_string(),
        role: AgentRole::Worker,
        access: AgentAccess::WorkspaceWrite,
        depends_on: Vec::new(),
        task_markdown: "# Objective\nWrite".to_string(),
    };
    assert!(validate_dispatch_shape(&[task]).is_err());
}

#[test]
fn collaboration_dispatch_treats_markdown_structure_as_advisory() {
    let task = DispatchTask {
        client_task_key: "explore".to_string(),
        title: "Explore".to_string(),
        role: AgentRole::Explorer,
        access: AgentAccess::ReadOnly,
        depends_on: Vec::new(),
        task_markdown: "Inspect the project and report the evidence.".to_string(),
    };
    assert!(validate_dispatch_shape(&[task]).is_ok());
}

fn valid_task_markdown(objective: &str) -> String {
    format!(
        "# Objective\n{objective}\n\n# Context\nFixture.\n\n# Scope\nBounded.\n\n\
         # Constraints\nSafe.\n\n# Deliverables\nReport.\n\n\
         # Acceptance criteria\nVerified.\n\n# Report format\nMarkdown."
    )
}

fn task(key: &str, role: AgentRole, access: AgentAccess, depends_on: &[&str]) -> DispatchTask {
    DispatchTask {
        client_task_key: key.to_string(),
        title: key.to_string(),
        role,
        access,
        depends_on: depends_on
            .iter()
            .map(|dependency| (*dependency).to_string())
            .collect(),
        task_markdown: valid_task_markdown(key),
    }
}

#[test]
fn collaboration_validates_bounds_dag_and_two_audit_limit() {
    let writer = task(
        "writer",
        AgentRole::Worker,
        AgentAccess::WorkspaceWrite,
        &[],
    );
    assert!(validate_initial_dispatch(std::slice::from_ref(&writer)).is_err());

    let auditor = task(
        "audit",
        AgentRole::Auditor,
        AgentAccess::ReadOnly,
        &["writer"],
    );
    assert!(validate_initial_dispatch(&[writer.clone(), auditor]).is_ok());

    let unknown = task(
        "unknown",
        AgentRole::Explorer,
        AgentAccess::ReadOnly,
        &["missing"],
    );
    assert!(validate_initial_dispatch(&[unknown]).is_err());

    let cycle_a = task("a", AgentRole::Explorer, AgentAccess::ReadOnly, &["b"]);
    let cycle_b = task("b", AgentRole::Explorer, AgentAccess::ReadOnly, &["a"]);
    assert!(validate_initial_dispatch(&[cycle_a, cycle_b]).is_err());

    let audits = ["audit-1", "audit-2", "audit-3"]
        .map(|key| task(key, AgentRole::Auditor, AgentAccess::ReadOnly, &[]));
    assert!(validate_initial_dispatch(&audits).is_err());

    let too_many = (0..13)
        .map(|index| {
            task(
                &format!("task-{index}"),
                AgentRole::Explorer,
                AgentAccess::ReadOnly,
                &[],
            )
        })
        .collect::<Vec<_>>();
    assert!(validate_initial_dispatch(&too_many).is_err());
}

#[tokio::test]
async fn collaboration_workspace_permit_allows_many_readers_or_one_writer() {
    let coordinator = CollaborationCoordinator::default();
    let first_read = coordinator.acquire_workspace(AgentAccess::ReadOnly).await;
    let second_read = coordinator.acquire_workspace(AgentAccess::ReadOnly).await;
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(20),
            coordinator.acquire_workspace(AgentAccess::WorkspaceWrite),
        )
        .await
        .is_err()
    );
    drop(first_read);
    drop(second_read);

    let write = coordinator
        .acquire_workspace(AgentAccess::WorkspaceWrite)
        .await;
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(20),
            coordinator.acquire_workspace(AgentAccess::ReadOnly),
        )
        .await
        .is_err()
    );
    drop(write);
    tokio::time::timeout(
        std::time::Duration::from_millis(50),
        coordinator.acquire_workspace(AgentAccess::ReadOnly),
    )
    .await
    .expect("reader proceeds after writer");
}
