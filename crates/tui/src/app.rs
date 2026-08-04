use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;
use std::collections::BTreeMap;
use std::io;
use sugarcode_agent_runtime::AgentSurfaceSession;
use sugarcode_agent_runtime::PendingCommandApproval;
use sugarcode_agent_runtime::PendingMcpToolApproval;
use sugarcode_core::CommandApprovalOutcome;
use sugarcode_core::CoreRuntime;
use sugarcode_core::McpToolApprovalOutcome;
use sugarcode_core::TurnStartOutcome;
use sugarcode_protocol::CoreAgentOutputRef;
use sugarcode_protocol::CoreEvent;
use sugarcode_protocol::CoreEventKind;
use sugarcode_protocol::CoreItemKind;
use sugarcode_protocol::CoreRequestId;
use sugarcode_protocol::ItemId;
use sugarcode_protocol::ThreadId;
use sugarcode_protocol::TurnId;
use sugarcode_state::DurableItemSnapshot;
use sugarcode_state::DurableThreadSnapshot;
use tokio::sync::oneshot;

const MAX_PASTE_BYTES: usize = sugarcode_core::MAX_USER_MESSAGE_BYTES;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Focus {
    Threads,
    Transcript,
    Input,
    Diff,
    Approval,
}

#[derive(Debug, Clone)]
pub(crate) struct TranscriptEntry {
    pub(crate) id: Option<ItemId>,
    pub(crate) label: String,
    pub(crate) text: String,
}

pub(crate) enum PendingApproval {
    Command {
        detail: String,
        response: oneshot::Sender<CommandApprovalOutcome>,
    },
    Mcp {
        detail: String,
        response: oneshot::Sender<McpToolApprovalOutcome>,
    },
}

impl PendingApproval {
    pub(crate) fn detail(&self) -> &str {
        match self {
            Self::Command { detail, .. } | Self::Mcp { detail, .. } => detail,
        }
    }
}

pub(crate) struct App {
    pub(crate) threads: Vec<ThreadId>,
    pub(crate) selected_thread: usize,
    pub(crate) current_thread: ThreadId,
    pub(crate) transcript: Vec<TranscriptEntry>,
    pub(crate) pending_outputs: BTreeMap<CoreAgentOutputRef, String>,
    pub(crate) input: String,
    pub(crate) status: String,
    pub(crate) focus: Focus,
    pub(crate) scroll: u16,
    pub(crate) diff_scroll: u16,
    pub(crate) latest_diff: Option<(String, String)>,
    pub(crate) approval: Option<PendingApproval>,
    active_request: Option<CoreRequestId>,
    active_turn: Option<TurnId>,
    resolved_agent_outputs: BTreeMap<ItemId, CoreAgentOutputRef>,
    quitting_after_turn: bool,
    quit: bool,
}

impl App {
    #[cfg(test)]
    pub(crate) fn fixture() -> Self {
        Self {
            threads: vec![
                ThreadId::parse("00000000-0000-7000-8000-000000000001")
                    .expect("valid thread UUIDv7"),
            ],
            selected_thread: 0,
            current_thread: ThreadId::parse("00000000-0000-7000-8000-000000000001")
                .expect("valid thread UUIDv7"),
            transcript: vec![
                TranscriptEntry {
                    id: Some(
                        ItemId::parse("00000000-0002-7000-8000-000000000001")
                            .expect("valid item UUIDv7"),
                    ),
                    label: "You".to_string(),
                    text: "你好，SugarCode".to_string(),
                },
                TranscriptEntry {
                    id: Some(
                        ItemId::parse("00000000-0002-7000-8000-000000000002")
                            .expect("valid item UUIDv7"),
                    ),
                    label: "Agent".to_string(),
                    text: "Ready ✓".to_string(),
                },
            ],
            pending_outputs: BTreeMap::new(),
            input: String::new(),
            status: "Ready".to_string(),
            focus: Focus::Input,
            scroll: 0,
            diff_scroll: 0,
            latest_diff: Some((
                "src/main.rs".to_string(),
                "@@ -1 +1 @@\n-old\n+新".to_string(),
            )),
            approval: None,
            active_request: None,
            active_turn: None,
            resolved_agent_outputs: BTreeMap::new(),
            quitting_after_turn: false,
            quit: false,
        }
    }

    pub(crate) fn load(
        session: &mut AgentSurfaceSession<CoreRuntime>,
        diagnostics: Vec<String>,
    ) -> io::Result<Self> {
        let page = session
            .list_threads(None, 100)
            .map_err(core_error("thread list unavailable"))?;
        let mut threads = page
            .data
            .into_iter()
            .map(|summary| summary.id)
            .collect::<Vec<_>>();
        let (current_thread, transcript, latest_diff) = if let Some(id) = threads.first().cloned() {
            let snapshot = session
                .resume_thread(&id)
                .map_err(core_error("thread resume unavailable"))?;
            let (transcript, diff) = transcript_from_snapshot(&snapshot);
            (id, transcript, diff)
        } else {
            let event = session
                .start_thread()
                .map_err(core_error("thread start unavailable"))?;
            let CoreEventKind::ThreadStarted { thread_id } = event.kind else {
                return Err(io::Error::other("invalid thread start response"));
            };
            threads.push(thread_id.clone());
            (thread_id, Vec::new(), None)
        };
        let status = if diagnostics.is_empty() {
            "Ready".to_string()
        } else {
            diagnostics.join(" · ")
        };
        Ok(Self {
            threads,
            selected_thread: 0,
            current_thread,
            transcript,
            pending_outputs: BTreeMap::new(),
            input: String::new(),
            status,
            focus: Focus::Input,
            scroll: 0,
            diff_scroll: 0,
            latest_diff,
            approval: None,
            active_request: None,
            active_turn: None,
            resolved_agent_outputs: BTreeMap::new(),
            quitting_after_turn: false,
            quit: false,
        })
    }

    pub(crate) fn should_quit(&self) -> bool {
        self.quit
    }

    pub(crate) fn handle_key(
        &mut self,
        key: KeyEvent,
        session: &mut AgentSurfaceSession<CoreRuntime>,
    ) -> io::Result<()> {
        if key.kind != KeyEventKind::Press {
            return Ok(());
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('q') {
            return self.request_quit(session);
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            if self.active_turn.is_some() {
                self.interrupt(session)?;
            } else {
                self.input.clear();
                self.status = "Input cleared".to_string();
            }
            return Ok(());
        }
        if self.approval.is_some() {
            if let Some(approved) = approval_decision(key.code) {
                self.resolve_approval(approved);
            }
            return Ok(());
        }
        match key.code {
            KeyCode::Tab => self.next_focus(),
            KeyCode::BackTab => self.previous_focus(),
            KeyCode::Esc => self.focus = Focus::Input,
            KeyCode::PageUp => self.scroll = self.scroll.saturating_add(10),
            KeyCode::PageDown => self.scroll = self.scroll.saturating_sub(10),
            KeyCode::Char('d') if self.focus != Focus::Input && self.latest_diff.is_some() => {
                self.focus = Focus::Diff;
            }
            KeyCode::Char('n') if self.focus == Focus::Threads && self.active_turn.is_none() => {
                self.new_thread(session)?;
            }
            KeyCode::Up if self.focus == Focus::Threads => {
                self.selected_thread = self.selected_thread.saturating_sub(1);
            }
            KeyCode::Down if self.focus == Focus::Threads => {
                self.selected_thread =
                    (self.selected_thread + 1).min(self.threads.len().saturating_sub(1));
            }
            KeyCode::Enter if self.focus == Focus::Threads && self.active_turn.is_none() => {
                self.resume_selected(session)?;
            }
            KeyCode::Up if self.focus == Focus::Transcript => {
                self.scroll = self.scroll.saturating_add(1);
            }
            KeyCode::Down if self.focus == Focus::Transcript => {
                self.scroll = self.scroll.saturating_sub(1);
            }
            KeyCode::Up if self.focus == Focus::Diff => {
                self.diff_scroll = self.diff_scroll.saturating_sub(1);
            }
            KeyCode::Down if self.focus == Focus::Diff => {
                self.diff_scroll = self.diff_scroll.saturating_add(1);
            }
            KeyCode::Enter if self.focus == Focus::Input => self.send(session)?,
            KeyCode::Backspace if self.focus == Focus::Input => {
                self.input.pop();
            }
            KeyCode::Char(character)
                if self.focus == Focus::Input
                    && !key
                        .modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                    && self.input.len() + character.len_utf8() <= MAX_PASTE_BYTES =>
            {
                self.input.push(character);
            }
            _ => {}
        }
        Ok(())
    }

    pub(crate) fn handle_paste(&mut self, text: &str) {
        if self.focus != Focus::Input {
            return;
        }
        let remaining = MAX_PASTE_BYTES.saturating_sub(self.input.len());
        let mut end = text.len().min(remaining);
        while !text.is_char_boundary(end) {
            end = end.saturating_sub(1);
        }
        self.input.push_str(&text[..end]);
        if end != text.len() {
            self.status = "Paste truncated to the input limit".to_string();
        }
    }

    pub(crate) fn handle_core_event(&mut self, event: CoreEvent) {
        if self
            .active_request
            .is_some_and(|request| request != event.request_id)
        {
            self.status = "Ignored an unrelated runtime event".to_string();
            return;
        }
        match event.kind {
            CoreEventKind::TurnStarted { turn_id, .. } => {
                self.active_turn = Some(turn_id);
                self.status = "Agent is working…".to_string();
            }
            CoreEventKind::ItemStarted { item, .. } | CoreEventKind::ItemCompleted { item, .. } => {
                self.upsert_item(item.id, item.kind)
            }
            CoreEventKind::AgentOutputDelta { output, delta, .. } => {
                self.pending_outputs
                    .entry(output)
                    .or_default()
                    .push_str(&delta);
                self.scroll = 0;
            }
            CoreEventKind::AgentOutputDiscarded { output, .. } => {
                self.pending_outputs.remove(&output);
            }
            CoreEventKind::AgentOutputResolved { output, item, .. } => {
                let should_upsert = match &item.kind {
                    CoreItemKind::AgentMessage { text } if text.is_empty() => {
                        self.resolved_agent_outputs.insert(item.id.clone(), output);
                        false
                    }
                    CoreItemKind::AgentCommentary { text } => {
                        if self
                            .pending_outputs
                            .get(&output)
                            .is_some_and(|preview| preview != text)
                        {
                            self.status = "Agent output preview mismatch".to_string();
                        }
                        self.pending_outputs.remove(&output);
                        true
                    }
                    _ => {
                        self.status = "Unsupported resolved Agent output".to_string();
                        true
                    }
                };
                if should_upsert {
                    self.upsert_item(item.id, item.kind);
                }
            }
            CoreEventKind::AgentMessageDelta { item_id, delta, .. } => {
                if let Some(output) = self.resolved_agent_outputs.remove(&item_id) {
                    if self
                        .pending_outputs
                        .get(&output)
                        .is_some_and(|preview| preview != &delta)
                    {
                        self.status = "Agent output preview mismatch".to_string();
                    }
                    self.pending_outputs.remove(&output);
                }
                if let Some(entry) = self
                    .transcript
                    .iter_mut()
                    .rev()
                    .find(|entry| entry.id.as_ref() == Some(&item_id))
                {
                    entry.text.push_str(&delta);
                } else {
                    self.transcript.push(TranscriptEntry {
                        id: Some(item_id),
                        label: "Agent".to_string(),
                        text: delta,
                    });
                }
                self.scroll = 0;
            }
            CoreEventKind::TurnCompleted { .. } => self.finish_turn("Completed"),
            CoreEventKind::TurnFailed { error, .. } => self.finish_turn(&format!(
                "Failed: {:?} (retryable: {})",
                error.kind, error.retryable
            )),
            CoreEventKind::TurnInterrupted { .. } => self.finish_turn("Interrupted"),
            CoreEventKind::RuntimeFailed => self.finish_turn("Runtime failed"),
            CoreEventKind::TokenUsageUpdated { .. } => {}
            CoreEventKind::Warning { .. } => {}
            CoreEventKind::ThreadStarted { .. } => {}
            CoreEventKind::ThreadTitleUpdated { .. } => {}
        }
    }

    pub(crate) fn offer_command_approval(
        &mut self,
        approval: PendingCommandApproval,
        fallback: CommandApprovalOutcome,
    ) {
        if self.approval.is_some() {
            let _ = approval.response.send(fallback);
            return;
        }
        let detail = approval.request.description.clone();
        self.approval = Some(PendingApproval::Command {
            detail,
            response: approval.response,
        });
        self.focus = Focus::Approval;
        self.status = "Approval required (default: deny)".to_string();
    }

    pub(crate) fn offer_mcp_approval(
        &mut self,
        approval: PendingMcpToolApproval,
        fallback: McpToolApprovalOutcome,
    ) {
        if self.approval.is_some() {
            let _ = approval.response.send(fallback);
            return;
        }
        let detail = format!(
            "MCP tool\n{}\n\narguments:\n{}",
            approval.request.name,
            serde_json::to_string_pretty(&approval.request.arguments)
                .unwrap_or_else(|_| "<unavailable>".to_string())
        );
        self.approval = Some(PendingApproval::Mcp {
            detail,
            response: approval.response,
        });
        self.focus = Focus::Approval;
        self.status = "Approval required (default: deny)".to_string();
    }

    pub(crate) fn deny_pending_approval(&mut self) {
        self.resolve_approval(false);
    }

    pub(crate) fn runtime_disconnected(&mut self) {
        self.status = "Runtime event stream disconnected".to_string();
        self.active_request = None;
        self.active_turn = None;
        if self.quitting_after_turn {
            self.quit = true;
        }
    }

    pub(crate) fn request_quit(
        &mut self,
        session: &mut AgentSurfaceSession<CoreRuntime>,
    ) -> io::Result<()> {
        self.deny_pending_approval();
        if self.active_turn.is_some() {
            self.quitting_after_turn = true;
            self.interrupt(session)?;
            self.status = "Interrupting before exit…".to_string();
        } else {
            self.quit = true;
        }
        Ok(())
    }

    fn send(&mut self, session: &mut AgentSurfaceSession<CoreRuntime>) -> io::Result<()> {
        let prompt = self.input.trim().to_string();
        if prompt.is_empty() || self.active_turn.is_some() {
            return Ok(());
        }
        let (request, outcome) =
            match session.start_text_turn(self.current_thread.clone(), Some(prompt)) {
                Ok(result) => result,
                Err(error) => {
                    self.status = format!("Turn not started: {error:?}");
                    return Ok(());
                }
            };
        self.input.clear();
        self.active_request = Some(request);
        match outcome {
            TurnStartOutcome::Accepted { turn_id } => {
                self.active_turn = Some(turn_id);
                self.status = "Agent is working…".to_string();
            }
            TurnStartOutcome::Immediate(events) => {
                for event in events {
                    self.handle_core_event(event);
                }
            }
        }
        Ok(())
    }

    fn interrupt(&mut self, session: &mut AgentSurfaceSession<CoreRuntime>) -> io::Result<()> {
        if let Some(turn) = self.active_turn.as_ref() {
            match session.interrupt_turn(&self.current_thread, turn) {
                Ok(_) => self.status = "Interrupt requested…".to_string(),
                Err(error) => self.status = format!("Interrupt failed: {error:?}"),
            }
        }
        Ok(())
    }

    fn finish_turn(&mut self, status: &str) {
        self.status = status.to_string();
        self.active_request = None;
        self.active_turn = None;
        self.pending_outputs.clear();
        self.resolved_agent_outputs.clear();
        if self.quitting_after_turn {
            self.quit = true;
        }
    }

    fn upsert_item(&mut self, id: ItemId, kind: CoreItemKind) {
        let (label, text, diff) = live_item(kind);
        if let Some((path, diff)) = diff {
            self.latest_diff = Some((path, diff));
        }
        if let Some(entry) = self
            .transcript
            .iter_mut()
            .find(|entry| entry.id.as_ref() == Some(&id))
        {
            entry.label = label;
            entry.text = text;
        } else {
            self.transcript.push(TranscriptEntry {
                id: Some(id),
                label,
                text,
            });
        }
        self.scroll = 0;
    }

    fn new_thread(&mut self, session: &mut AgentSurfaceSession<CoreRuntime>) -> io::Result<()> {
        let event = match session.start_thread() {
            Ok(event) => event,
            Err(error) => {
                self.status = format!("Thread not created: {error:?}");
                return Ok(());
            }
        };
        let CoreEventKind::ThreadStarted { thread_id } = event.kind else {
            return Err(io::Error::other("invalid thread start response"));
        };
        self.threads.insert(0, thread_id.clone());
        self.selected_thread = 0;
        self.current_thread = thread_id;
        self.transcript.clear();
        self.pending_outputs.clear();
        self.resolved_agent_outputs.clear();
        self.latest_diff = None;
        self.status = "New thread".to_string();
        self.focus = Focus::Input;
        Ok(())
    }

    fn resume_selected(
        &mut self,
        session: &mut AgentSurfaceSession<CoreRuntime>,
    ) -> io::Result<()> {
        let Some(thread_id) = self.threads.get(self.selected_thread).cloned() else {
            return Ok(());
        };
        let snapshot = match session.resume_thread(&thread_id) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                self.status = format!("Thread not resumed: {error:?}");
                return Ok(());
            }
        };
        let (transcript, diff) = transcript_from_snapshot(&snapshot);
        self.current_thread = thread_id;
        self.transcript = transcript;
        self.pending_outputs.clear();
        self.resolved_agent_outputs.clear();
        self.latest_diff = diff;
        self.scroll = 0;
        self.status = "Thread resumed".to_string();
        self.focus = Focus::Input;
        Ok(())
    }

    fn resolve_approval(&mut self, approved: bool) {
        let Some(approval) = self.approval.take() else {
            return;
        };
        match approval {
            PendingApproval::Command { response, .. } => {
                let _ = response.send(if approved {
                    CommandApprovalOutcome::Approved
                } else {
                    CommandApprovalOutcome::Denied
                });
            }
            PendingApproval::Mcp { response, .. } => {
                let _ = response.send(if approved {
                    McpToolApprovalOutcome::Approved
                } else {
                    McpToolApprovalOutcome::Denied
                });
            }
        }
        self.focus = Focus::Input;
        self.status = if approved {
            "Approved once".to_string()
        } else {
            "Denied".to_string()
        };
    }

    fn next_focus(&mut self) {
        self.focus = match self.focus {
            Focus::Threads => Focus::Transcript,
            Focus::Transcript => Focus::Input,
            Focus::Input => {
                if self.latest_diff.is_some() {
                    Focus::Diff
                } else {
                    Focus::Threads
                }
            }
            Focus::Diff | Focus::Approval => Focus::Threads,
        };
    }

    fn previous_focus(&mut self) {
        self.focus = match self.focus {
            Focus::Threads => {
                if self.latest_diff.is_some() {
                    Focus::Diff
                } else {
                    Focus::Input
                }
            }
            Focus::Transcript => Focus::Threads,
            Focus::Input => Focus::Transcript,
            Focus::Diff => Focus::Input,
            Focus::Approval => Focus::Input,
        };
    }
}

fn core_error(message: &'static str) -> impl FnOnce(sugarcode_core::CoreError) -> io::Error {
    move |error| io::Error::other(format!("{message}: {error:?}"))
}

pub(crate) fn approval_decision(key: KeyCode) -> Option<bool> {
    match key {
        KeyCode::Char('y') | KeyCode::Char('Y') => Some(true),
        KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => Some(false),
        _ => None,
    }
}

fn transcript_from_snapshot(
    snapshot: &DurableThreadSnapshot,
) -> (Vec<TranscriptEntry>, Option<(String, String)>) {
    let mut transcript = Vec::new();
    let mut latest_diff = None;
    for turn in &snapshot.turns {
        for item in &turn.items {
            let (id, label, text, diff) = durable_item(item);
            if let Some(diff) = diff {
                latest_diff = Some(diff);
            }
            transcript.push(TranscriptEntry {
                id: Some(id),
                label,
                text,
            });
        }
        transcript.push(TranscriptEntry {
            id: None,
            label: "Turn".to_string(),
            text: format!("{:?}", turn.status),
        });
    }
    (transcript, latest_diff)
}

fn durable_item(item: &DurableItemSnapshot) -> (ItemId, String, String, Option<(String, String)>) {
    match item {
        DurableItemSnapshot::UserMessage { id, content } => (
            id.clone(),
            "You".to_string(),
            durable_user_content_text(content),
            None,
        ),
        DurableItemSnapshot::AgentMessage { id, text } => {
            (id.clone(), "Agent".to_string(), text.clone(), None)
        }
        DurableItemSnapshot::AgentCommentary { id, text } => {
            (id.clone(), "Progress".to_string(), text.clone(), None)
        }
        DurableItemSnapshot::ContextCompaction {
            id,
            ordinal,
            pre_context_bytes,
            outcome,
            ..
        } => {
            let (label, detail) = match outcome {
                None => (
                    "Compacting context…",
                    format!("pass {ordinal} · {pre_context_bytes} bytes"),
                ),
                Some(sugarcode_state::DurableActiveTurnCompactionOutcome::Completed {
                    post_context_bytes,
                    ..
                }) => (
                    "Context compacted",
                    format!("{pre_context_bytes} → {post_context_bytes} bytes"),
                ),
                Some(sugarcode_state::DurableActiveTurnCompactionOutcome::Failed { kind }) => {
                    ("Context compaction failed", kind.clone())
                }
                Some(sugarcode_state::DurableActiveTurnCompactionOutcome::Interrupted) => {
                    ("Context compaction interrupted", format!("pass {ordinal}"))
                }
            };
            (id.clone(), label.to_string(), detail, None)
        }
        DurableItemSnapshot::ToolCall {
            id,
            name,
            arguments,
            ..
        } => (
            id.clone(),
            "Tool".to_string(),
            format!("{name} {arguments}"),
            None,
        ),
        DurableItemSnapshot::FileChange { id, path, diff, .. } => (
            id.clone(),
            "File change".to_string(),
            path.clone(),
            Some((path.clone(), diff.clone())),
        ),
        DurableItemSnapshot::CommandApprovalRequest {
            id,
            command,
            arguments,
            ..
        } => (
            id.clone(),
            "Approval".to_string(),
            format!("{command} {}", arguments.join(" ")),
            None,
        ),
        DurableItemSnapshot::McpToolCall { id, name, .. }
        | DurableItemSnapshot::McpToolCallApprovalRequest { id, name, .. } => {
            (id.clone(), "MCP".to_string(), name.clone(), None)
        }
        DurableItemSnapshot::ToolResult {
            id, name, result, ..
        } => (
            id.clone(),
            "Tool result".to_string(),
            format!("{name}: {result:?}"),
            None,
        ),
        DurableItemSnapshot::McpToolResult {
            id, name, result, ..
        } => (
            id.clone(),
            "MCP result".to_string(),
            format!("{name}: {result:?}"),
            None,
        ),
        other => {
            let id = durable_item_id(other);
            (id, "Activity".to_string(), format!("{other:?}"), None)
        }
    }
}

fn durable_item_id(item: &DurableItemSnapshot) -> ItemId {
    match item {
        DurableItemSnapshot::UserMessage { id, .. }
        | DurableItemSnapshot::AgentMessage { id, .. }
        | DurableItemSnapshot::AgentCommentary { id, .. }
        | DurableItemSnapshot::AgentTask { id, .. }
        | DurableItemSnapshot::AgentTaskAmendment { id, .. }
        | DurableItemSnapshot::AgentTaskResult { id, .. }
        | DurableItemSnapshot::ContextCompaction { id, .. }
        | DurableItemSnapshot::ToolCall { id, .. }
        | DurableItemSnapshot::ToolValidationRejected { id, .. }
        | DurableItemSnapshot::FileChange { id, .. }
        | DurableItemSnapshot::CommandApprovalRequest { id, .. }
        | DurableItemSnapshot::CommandApprovalDecision { id, .. }
        | DurableItemSnapshot::CommandExecutionAttempt { id, .. }
        | DurableItemSnapshot::McpToolCall { id, .. }
        | DurableItemSnapshot::McpToolCallApprovalRequest { id, .. }
        | DurableItemSnapshot::McpToolCallApprovalDecision { id, .. }
        | DurableItemSnapshot::McpToolExecutionAttempt { id, .. }
        | DurableItemSnapshot::McpToolResult { id, .. }
        | DurableItemSnapshot::ToolResult { id, .. } => id.clone(),
    }
}

fn live_item(kind: CoreItemKind) -> (String, String, Option<(String, String)>) {
    match kind {
        CoreItemKind::UserMessage { content } => {
            ("You".to_string(), core_user_content_text(&content), None)
        }
        CoreItemKind::AgentMessage { text } => ("Agent".to_string(), text, None),
        CoreItemKind::AgentCommentary { text } => ("Progress".to_string(), text, None),
        CoreItemKind::ContextCompaction {
            ordinal,
            pre_context_bytes,
            outcome,
            ..
        } => {
            let (label, detail) = match outcome {
                None => (
                    "Compacting context…",
                    format!("pass {ordinal} · {pre_context_bytes} bytes"),
                ),
                Some(sugarcode_protocol::CoreContextCompactionOutcome::Completed {
                    post_context_bytes,
                    ..
                }) => (
                    "Context compacted",
                    format!("{pre_context_bytes} → {post_context_bytes} bytes"),
                ),
                Some(sugarcode_protocol::CoreContextCompactionOutcome::Failed { kind }) => {
                    ("Context compaction failed", kind)
                }
                Some(sugarcode_protocol::CoreContextCompactionOutcome::Interrupted) => {
                    ("Context compaction interrupted", format!("pass {ordinal}"))
                }
            };
            (label.to_string(), detail, None)
        }
        CoreItemKind::ToolCall {
            name, arguments, ..
        } => ("Tool".to_string(), format!("{name} {arguments}"), None),
        CoreItemKind::ToolValidationRejected {
            name,
            kind,
            suggested_action,
            ..
        } => (
            "Tool validation".to_string(),
            format!("{name}: {kind} · {suggested_action}"),
            None,
        ),
        CoreItemKind::FileChange { path, diff, .. } => {
            ("File change".to_string(), path.clone(), Some((path, diff)))
        }
        CoreItemKind::CommandApprovalRequest {
            command, arguments, ..
        } => (
            "Approval".to_string(),
            format!("{command} {}", arguments.join(" ")),
            None,
        ),
        CoreItemKind::McpToolCall { name, .. }
        | CoreItemKind::McpToolCallApprovalRequest { name, .. } => ("MCP".to_string(), name, None),
        CoreItemKind::ToolResult { name, result, .. } => (
            "Tool result".to_string(),
            format!("{name}: {result:?}"),
            None,
        ),
        CoreItemKind::McpToolResult { name, result, .. } => (
            "MCP result".to_string(),
            format!("{name}: {result:?}"),
            None,
        ),
        other => ("Activity".to_string(), format!("{other:?}"), None),
    }
}

fn durable_user_content_text(content: &[sugarcode_state::DurableUserContentPart]) -> String {
    content
        .iter()
        .map(|part| match part {
            sugarcode_state::DurableUserContentPart::Text { text } => text.clone(),
            sugarcode_state::DurableUserContentPart::Image { asset } => {
                format!("[image: {}]", asset.original_name)
            }
            sugarcode_state::DurableUserContentPart::Document { asset } => {
                format!("[document: {}]", asset.original_name)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn core_user_content_text(content: &[sugarcode_protocol::CoreUserContentPart]) -> String {
    content
        .iter()
        .map(|part| match part {
            sugarcode_protocol::CoreUserContentPart::Text { text } => text.clone(),
            sugarcode_protocol::CoreUserContentPart::Image { asset } => {
                format!("[image: {}]", asset.original_name)
            }
            sugarcode_protocol::CoreUserContentPart::Document { asset } => {
                format!("[document: {}]", asset.original_name)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}
