use serde::Serialize;
use std::io;
use std::io::Write;
use sugarcode_protocol::CoreCommandApprovalDecision;
use sugarcode_protocol::CoreEvent;
use sugarcode_protocol::CoreEventKind;
use sugarcode_protocol::CoreItemKind;
use sugarcode_protocol::CoreItemSnapshot;
use sugarcode_protocol::CoreMcpToolResult;
use sugarcode_protocol::CoreProcessOutcome;
use sugarcode_protocol::CoreToolResult;
use sugarcode_protocol::CoreTurnErrorKind;

pub const EXEC_OUTPUT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecOutputFormat {
    Human,
    JsonLines,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExecRunModeV1 {
    New,
    Resume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExecRunStatusV1 {
    Completed,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExecErrorCategoryV1 {
    Input,
    Configuration,
    TurnFailed,
    Interrupted,
    Output,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExecRecordV1 {
    RunStarted {
        version: u32,
        sequence: u64,
        thread_id: String,
        mode: ExecRunModeV1,
    },
    Event {
        version: u32,
        sequence: u64,
        thread_id: Option<String>,
        turn_id: Option<String>,
        event: Box<ExecEventV1>,
    },
    RunFinished {
        version: u32,
        sequence: u64,
        thread_id: String,
        turn_id: Option<String>,
        status: ExecRunStatusV1,
    },
    Error {
        version: u32,
        sequence: u64,
        exit_code: u8,
        category: ExecErrorCategoryV1,
        message: &'static str,
        thread_id: Option<String>,
        turn_id: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExecEventV1 {
    ThreadStarted,
    TurnStarted,
    ItemStarted {
        item: ExecItemV1,
    },
    AgentMessageDelta {
        item_id: String,
        delta: String,
    },
    ItemCompleted {
        item: ExecItemV1,
    },
    TurnCompleted,
    TurnFailed {
        error_kind: &'static str,
        retryable: bool,
    },
    TurnInterrupted,
    RuntimeFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecItemV1 {
    pub id: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strategy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ordinal: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_context_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_context_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_messages: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary_sha256: Option<String>,
}

pub(crate) struct MappedExecEvent {
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub event: ExecEventV1,
}

pub(crate) struct OutputEmitter<'a, W> {
    format: ExecOutputFormat,
    writer: &'a mut W,
    sequence: u64,
    human_line_open: bool,
}

impl<'a, W> OutputEmitter<'a, W>
where
    W: Write,
{
    pub(crate) fn new(format: ExecOutputFormat, writer: &'a mut W) -> Self {
        Self {
            format,
            writer,
            sequence: 0,
            human_line_open: false,
        }
    }

    pub(crate) fn run_started(&mut self, thread_id: &str, mode: ExecRunModeV1) -> io::Result<()> {
        match self.format {
            ExecOutputFormat::Human => {
                writeln!(
                    self.writer,
                    "Thread: {thread_id} ({})",
                    match mode {
                        ExecRunModeV1::New => "new",
                        ExecRunModeV1::Resume => "resumed",
                    }
                )?;
            }
            ExecOutputFormat::JsonLines => {
                let sequence = self.next_sequence()?;
                self.write_json(&ExecRecordV1::RunStarted {
                    version: EXEC_OUTPUT_VERSION,
                    sequence,
                    thread_id: thread_id.to_string(),
                    mode,
                })?;
            }
        }
        self.writer.flush()
    }

    pub(crate) fn event(&mut self, event: &CoreEvent) -> io::Result<()> {
        let Some(mapped) = map_core_event(event) else {
            return Ok(());
        };
        match self.format {
            ExecOutputFormat::Human => self.write_human_event(&mapped)?,
            ExecOutputFormat::JsonLines => {
                let sequence = self.next_sequence()?;
                self.write_json(&ExecRecordV1::Event {
                    version: EXEC_OUTPUT_VERSION,
                    sequence,
                    thread_id: mapped.thread_id,
                    turn_id: mapped.turn_id,
                    event: Box::new(mapped.event),
                })?;
            }
        }
        self.writer.flush()
    }

    pub(crate) fn finished(
        &mut self,
        thread_id: &str,
        turn_id: Option<&str>,
        status: ExecRunStatusV1,
    ) -> io::Result<()> {
        match self.format {
            ExecOutputFormat::Human => {
                if self.human_line_open {
                    writeln!(self.writer)?;
                    self.human_line_open = false;
                }
                writeln!(
                    self.writer,
                    "Status: {}",
                    match status {
                        ExecRunStatusV1::Completed => "completed",
                        ExecRunStatusV1::Failed => "failed",
                        ExecRunStatusV1::Interrupted => "interrupted",
                    }
                )?;
            }
            ExecOutputFormat::JsonLines => {
                let sequence = self.next_sequence()?;
                self.write_json(&ExecRecordV1::RunFinished {
                    version: EXEC_OUTPUT_VERSION,
                    sequence,
                    thread_id: thread_id.to_string(),
                    turn_id: turn_id.map(str::to_string),
                    status,
                })?;
            }
        }
        self.writer.flush()
    }

    pub(crate) fn error(
        &mut self,
        exit_code: u8,
        category: ExecErrorCategoryV1,
        message: &'static str,
        thread_id: Option<&str>,
        turn_id: Option<&str>,
    ) -> io::Result<()> {
        if self.format == ExecOutputFormat::JsonLines {
            let sequence = self.next_sequence()?;
            self.write_json(&ExecRecordV1::Error {
                version: EXEC_OUTPUT_VERSION,
                sequence,
                exit_code,
                category,
                message,
                thread_id: thread_id.map(str::to_string),
                turn_id: turn_id.map(str::to_string),
            })?;
            self.writer.flush()?;
        }
        Ok(())
    }

    fn write_human_event(&mut self, mapped: &MappedExecEvent) -> io::Result<()> {
        match &mapped.event {
            ExecEventV1::ThreadStarted | ExecEventV1::TurnStarted => {}
            ExecEventV1::AgentMessageDelta { delta, .. } => {
                self.writer.write_all(delta.as_bytes())?;
                self.human_line_open = !delta.ends_with('\n');
            }
            ExecEventV1::ItemStarted { item } => {
                if let Some(label) = human_item_label(item) {
                    self.ensure_human_line_break()?;
                    writeln!(self.writer, "[{label}]")?;
                }
            }
            ExecEventV1::ItemCompleted { item } => {
                if matches!(
                    item.kind,
                    "contextCompaction"
                        | "fileChange"
                        | "commandApprovalDecision"
                        | "mcpApprovalDecision"
                ) && let Some(label) = human_item_label(item)
                {
                    self.ensure_human_line_break()?;
                    writeln!(self.writer, "[{label}]")?;
                }
            }
            ExecEventV1::TurnCompleted => {}
            ExecEventV1::TurnFailed { error_kind, .. } => {
                self.ensure_human_line_break()?;
                writeln!(self.writer, "[turn failed: {error_kind}]")?;
            }
            ExecEventV1::TurnInterrupted => {
                self.ensure_human_line_break()?;
                writeln!(self.writer, "[turn interrupted]")?;
            }
            ExecEventV1::RuntimeFailed => {
                self.ensure_human_line_break()?;
                writeln!(self.writer, "[runtime failed]")?;
            }
        }
        Ok(())
    }

    fn ensure_human_line_break(&mut self) -> io::Result<()> {
        if self.human_line_open {
            writeln!(self.writer)?;
            self.human_line_open = false;
        }
        Ok(())
    }

    fn write_json(&mut self, record: &ExecRecordV1) -> io::Result<()> {
        serde_json::to_writer(&mut self.writer, record).map_err(io::Error::other)?;
        self.writer.write_all(b"\n")
    }

    fn next_sequence(&mut self) -> io::Result<u64> {
        let sequence = self
            .sequence
            .checked_add(1)
            .ok_or_else(|| io::Error::other("exec output sequence exhausted"))?;
        self.sequence = sequence;
        Ok(sequence)
    }
}

pub(crate) fn write_standalone_error<W>(
    writer: &mut W,
    format: ExecOutputFormat,
    exit_code: u8,
    category: ExecErrorCategoryV1,
    message: &'static str,
) -> io::Result<()>
where
    W: Write,
{
    let mut output = OutputEmitter::new(format, writer);
    output.error(exit_code, category, message, None, None)
}

pub(crate) fn map_core_event(event: &CoreEvent) -> Option<MappedExecEvent> {
    Some(match &event.kind {
        CoreEventKind::ThreadStarted { thread_id } => MappedExecEvent {
            thread_id: Some(thread_id.as_str().to_string()),
            turn_id: None,
            event: ExecEventV1::ThreadStarted,
        },
        CoreEventKind::ThreadTitleUpdated { .. } => return None,
        CoreEventKind::TurnStarted { thread_id, turn_id } => MappedExecEvent {
            thread_id: Some(thread_id.as_str().to_string()),
            turn_id: Some(turn_id.as_str().to_string()),
            event: ExecEventV1::TurnStarted,
        },
        CoreEventKind::ItemStarted {
            thread_id,
            turn_id,
            item,
        } => MappedExecEvent {
            thread_id: Some(thread_id.as_str().to_string()),
            turn_id: Some(turn_id.as_str().to_string()),
            event: ExecEventV1::ItemStarted {
                item: map_item(item),
            },
        },
        CoreEventKind::AgentOutputDelta { .. } => return None,
        CoreEventKind::AgentOutputDiscarded { .. } => return None,
        CoreEventKind::CommandOutputDelta { .. } => return None,
        CoreEventKind::AgentOutputResolved {
            thread_id,
            turn_id,
            item,
            ..
        } => MappedExecEvent {
            thread_id: Some(thread_id.as_str().to_string()),
            turn_id: Some(turn_id.as_str().to_string()),
            event: ExecEventV1::ItemStarted {
                item: map_item(item),
            },
        },
        CoreEventKind::AgentMessageDelta {
            thread_id,
            turn_id,
            item_id,
            delta,
        } => MappedExecEvent {
            thread_id: Some(thread_id.as_str().to_string()),
            turn_id: Some(turn_id.as_str().to_string()),
            event: ExecEventV1::AgentMessageDelta {
                item_id: item_id.as_str().to_string(),
                delta: delta.clone(),
            },
        },
        CoreEventKind::ItemCompleted {
            thread_id,
            turn_id,
            item,
        } => MappedExecEvent {
            thread_id: Some(thread_id.as_str().to_string()),
            turn_id: Some(turn_id.as_str().to_string()),
            event: ExecEventV1::ItemCompleted {
                item: map_item(item),
            },
        },
        CoreEventKind::TokenUsageUpdated { .. } => return None,
        CoreEventKind::Warning { .. } => return None,
        CoreEventKind::TurnCompleted { thread_id, turn_id } => MappedExecEvent {
            thread_id: Some(thread_id.as_str().to_string()),
            turn_id: Some(turn_id.as_str().to_string()),
            event: ExecEventV1::TurnCompleted,
        },
        CoreEventKind::TurnFailed {
            thread_id,
            turn_id,
            error,
        } => MappedExecEvent {
            thread_id: Some(thread_id.as_str().to_string()),
            turn_id: Some(turn_id.as_str().to_string()),
            event: ExecEventV1::TurnFailed {
                error_kind: turn_error_kind(error.kind),
                retryable: error.retryable,
            },
        },
        CoreEventKind::TurnInterrupted { thread_id, turn_id } => MappedExecEvent {
            thread_id: Some(thread_id.as_str().to_string()),
            turn_id: Some(turn_id.as_str().to_string()),
            event: ExecEventV1::TurnInterrupted,
        },
        CoreEventKind::RuntimeFailed => MappedExecEvent {
            thread_id: None,
            turn_id: None,
            event: ExecEventV1::RuntimeFailed,
        },
    })
}

fn map_item(item: &CoreItemSnapshot) -> ExecItemV1 {
    let mut mapped = ExecItemV1 {
        id: item.id.as_str().to_string(),
        kind: item_kind(&item.kind),
        call_id: None,
        name: None,
        path: None,
        diff: None,
        decision: None,
        result: None,
        strategy: None,
        ordinal: None,
        pre_context_bytes: None,
        post_context_bytes: None,
        source_messages: None,
        source_bytes: None,
        source_sha256: None,
        summary_bytes: None,
        summary_sha256: None,
    };
    match &item.kind {
        CoreItemKind::UserMessage { .. }
        | CoreItemKind::AgentMessage { .. }
        | CoreItemKind::AgentCommentary { .. } => {}
        CoreItemKind::AgentTask {
            task_id,
            title,
            role,
            ..
        } => {
            mapped.call_id = Some(task_id.clone());
            mapped.name = Some(title.clone());
            mapped.result = Some(role.clone());
        }
        CoreItemKind::AgentTaskAmendment { task_id, .. } => {
            mapped.call_id = Some(task_id.clone());
            mapped.result = Some("amended".to_string());
        }
        CoreItemKind::AgentTaskResult {
            task_id, status, ..
        } => {
            mapped.call_id = Some(task_id.clone());
            mapped.result = Some(status.clone());
        }
        CoreItemKind::ContextCompaction {
            strategy,
            ordinal,
            pre_context_bytes,
            source_messages,
            source_bytes,
            source_sha256,
            outcome,
        } => {
            mapped.strategy = Some(match strategy {
                sugarcode_protocol::CoreContextCompactionStrategy::ModelGeneratedActiveTurnV1 => {
                    "modelGeneratedActiveTurnV1".to_string()
                }
            });
            mapped.ordinal = Some(*ordinal);
            mapped.pre_context_bytes = Some(*pre_context_bytes);
            mapped.source_messages = Some(*source_messages);
            mapped.source_bytes = Some(*source_bytes);
            mapped.source_sha256 = Some(source_sha256.clone());
            mapped.result = Some(match outcome {
                None => "inProgress".to_string(),
                Some(sugarcode_protocol::CoreContextCompactionOutcome::Completed {
                    post_context_bytes,
                    summary_bytes,
                    summary_sha256,
                }) => {
                    mapped.post_context_bytes = Some(*post_context_bytes);
                    mapped.summary_bytes = Some(*summary_bytes);
                    mapped.summary_sha256 = Some(summary_sha256.clone());
                    "completed".to_string()
                }
                Some(sugarcode_protocol::CoreContextCompactionOutcome::Failed { kind }) => {
                    format!("failed:{kind}")
                }
                Some(sugarcode_protocol::CoreContextCompactionOutcome::Interrupted) => {
                    "interrupted".to_string()
                }
            });
        }
        CoreItemKind::ToolCall {
            call_id,
            name,
            arguments,
        } => {
            mapped.call_id = Some(call_id.clone());
            mapped.name = Some(name.clone());
            mapped.path = arguments
                .get("path")
                .or_else(|| arguments.get("cwd"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
        }
        CoreItemKind::ToolValidationRejected {
            call_id,
            name,
            kind,
            suggested_action,
            ..
        } => {
            mapped.call_id = Some(call_id.clone());
            mapped.name = Some(name.clone());
            mapped.result = Some(format!("{kind}:{suggested_action}"));
        }
        CoreItemKind::FileChange {
            call_id,
            path,
            diff,
            ..
        } => {
            mapped.call_id = Some(call_id.clone());
            mapped.path = Some(path.clone());
            mapped.diff = Some(diff.clone());
        }
        CoreItemKind::CommandApprovalRequest {
            approval_id,
            call_id,
            command,
            ..
        } => {
            mapped.call_id = Some(call_id.clone());
            mapped.name = Some(command.clone());
            mapped.result = Some(approval_id.clone());
        }
        CoreItemKind::CommandApprovalDecision {
            approval_id,
            decision,
            ..
        } => {
            mapped.call_id = Some(approval_id.clone());
            mapped.decision = Some(approval_decision(*decision).to_string());
        }
        CoreItemKind::CommandExecutionAttempt {
            approval_id,
            call_id,
        } => {
            mapped.call_id = Some(call_id.clone());
            mapped.result = Some(approval_id.clone());
        }
        CoreItemKind::McpToolCall { call_id, name, .. }
        | CoreItemKind::McpToolCallApprovalRequest { call_id, name, .. } => {
            mapped.call_id = Some(call_id.clone());
            mapped.name = Some(name.clone());
        }
        CoreItemKind::McpToolCallApprovalDecision {
            approval_id,
            decision,
        } => {
            mapped.call_id = Some(approval_id.clone());
            mapped.decision = Some(approval_decision(*decision).to_string());
        }
        CoreItemKind::McpToolExecutionAttempt {
            approval_id,
            call_id,
            ..
        } => {
            mapped.call_id = Some(call_id.clone());
            mapped.result = Some(approval_id.clone());
        }
        CoreItemKind::McpToolResult {
            call_id,
            name,
            result,
        } => {
            mapped.call_id = Some(call_id.clone());
            mapped.name = Some(name.clone());
            mapped.result = Some(match result {
                CoreMcpToolResult::Completed { is_error, .. } => {
                    if *is_error {
                        "completedError".to_string()
                    } else {
                        "completed".to_string()
                    }
                }
                CoreMcpToolResult::Error { kind, .. } => format!("error:{kind}"),
            });
        }
        CoreItemKind::ToolResult {
            call_id,
            name,
            result,
        } => {
            mapped.call_id = Some(call_id.clone());
            mapped.name = Some(name.clone());
            mapped.result = Some(tool_result(result));
        }
    }
    mapped
}

fn item_kind(kind: &CoreItemKind) -> &'static str {
    match kind {
        CoreItemKind::UserMessage { .. } => "userMessage",
        CoreItemKind::AgentMessage { .. } => "agentMessage",
        CoreItemKind::AgentCommentary { .. } => "agentCommentary",
        CoreItemKind::AgentTask { .. } => "agentTask",
        CoreItemKind::AgentTaskAmendment { .. } => "agentTaskAmendment",
        CoreItemKind::AgentTaskResult { .. } => "agentTaskResult",
        CoreItemKind::ContextCompaction { .. } => "contextCompaction",
        CoreItemKind::ToolCall { .. } => "toolCall",
        CoreItemKind::ToolValidationRejected { .. } => "toolValidationRejected",
        CoreItemKind::FileChange { .. } => "fileChange",
        CoreItemKind::CommandApprovalRequest { .. } => "commandApprovalRequest",
        CoreItemKind::CommandApprovalDecision { .. } => "commandApprovalDecision",
        CoreItemKind::CommandExecutionAttempt { .. } => "commandExecutionAttempt",
        CoreItemKind::McpToolCall { .. } => "mcpToolCall",
        CoreItemKind::McpToolCallApprovalRequest { .. } => "mcpApprovalRequest",
        CoreItemKind::McpToolCallApprovalDecision { .. } => "mcpApprovalDecision",
        CoreItemKind::McpToolExecutionAttempt { .. } => "mcpExecutionAttempt",
        CoreItemKind::McpToolResult { .. } => "mcpToolResult",
        CoreItemKind::ToolResult { .. } => "toolResult",
    }
}

fn approval_decision(decision: CoreCommandApprovalDecision) -> &'static str {
    match decision {
        CoreCommandApprovalDecision::Approved => "approved",
        CoreCommandApprovalDecision::Denied => "denied",
        CoreCommandApprovalDecision::TimedOut => "timedOut",
        CoreCommandApprovalDecision::Unsupported => "unsupported",
        CoreCommandApprovalDecision::Cancelled => "cancelled",
        CoreCommandApprovalDecision::ClientDisconnected => "clientDisconnected",
    }
}

fn tool_result(result: &CoreToolResult) -> String {
    match result {
        CoreToolResult::Success { bytes, .. } => format!("success:{bytes}"),
        CoreToolResult::Error { kind } => format!("error:{kind}"),
        CoreToolResult::Process(process) => match &process.outcome {
            CoreProcessOutcome::ExitCode { code } => format!("exitCode:{code}"),
            CoreProcessOutcome::Signal { signal } => format!("signal:{signal}"),
            CoreProcessOutcome::TimedOut => "timedOut".to_string(),
        },
    }
}

fn turn_error_kind(kind: CoreTurnErrorKind) -> &'static str {
    match kind {
        CoreTurnErrorKind::Authentication => "authentication",
        CoreTurnErrorKind::ContextWindowExceeded => "contextWindowExceeded",
        CoreTurnErrorKind::InvalidRequest => "invalidRequest",
        CoreTurnErrorKind::RateLimited => "rateLimited",
        CoreTurnErrorKind::Timeout => "timeout",
        CoreTurnErrorKind::Transport => "transport",
        CoreTurnErrorKind::Disconnected => "disconnected",
        CoreTurnErrorKind::Server => "server",
        CoreTurnErrorKind::Protocol => "protocol",
        CoreTurnErrorKind::Incomplete => "incomplete",
        CoreTurnErrorKind::Filtered => "filtered",
        CoreTurnErrorKind::UnsupportedOutput => "unsupportedOutput",
        CoreTurnErrorKind::UnsupportedToolArguments => "unsupportedToolArguments",
        CoreTurnErrorKind::ProviderRequestTooLarge => "providerRequestTooLarge",
        CoreTurnErrorKind::ProviderResponseTooLarge => "providerResponseTooLarge",
        CoreTurnErrorKind::OutputTooLarge => "outputTooLarge",
        CoreTurnErrorKind::StateUnavailable => "stateUnavailable",
    }
}

fn human_item_label(item: &ExecItemV1) -> Option<String> {
    match item.kind {
        "contextCompaction" => Some(match item.result.as_deref() {
            Some("completed") => "context compacted".to_string(),
            Some("interrupted") => "context compaction interrupted".to_string(),
            Some(result) if result.starts_with("failed:") => {
                format!("context compaction {result}")
            }
            _ => "compacting context…".to_string(),
        }),
        "toolCall" => Some(format!(
            "tool: {} {}",
            item.name.as_deref().unwrap_or("unknown"),
            item.path.as_deref().unwrap_or("")
        )),
        "fileChange" => Some(format!(
            "file change: {}",
            item.path.as_deref().unwrap_or("unknown")
        )),
        "commandApprovalRequest" => Some(format!(
            "command approval requested: {}",
            item.name.as_deref().unwrap_or("unknown")
        )),
        "commandApprovalDecision" | "mcpApprovalDecision" => Some(format!(
            "approval: {}",
            item.decision.as_deref().unwrap_or("unknown")
        )),
        "mcpToolCall" | "mcpApprovalRequest" => Some(format!(
            "MCP tool: {}",
            item.name.as_deref().unwrap_or("unknown")
        )),
        _ => None,
    }
}
