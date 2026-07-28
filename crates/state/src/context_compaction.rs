use crate::DurableContextCompaction;
use crate::DurableContextCompactionStrategy;
use crate::DurableItemSnapshot;
use crate::DurableMcpToolResult;
use crate::DurableProcessOutcome;
use crate::DurableToolResult;
use crate::DurableTurnSnapshot;
use crate::DurableTurnStatus;
use sha2::Digest;
use sha2::Sha256;

pub const MAX_CONTEXT_COMPACTION_MESSAGE_BYTES: usize = 32 * 1024;
const COMPACTION_PREFIX: &str = "SugarCode deterministic persisted compaction v1";

pub fn build_context_compaction(
    turns: &[DurableTurnSnapshot],
    pre_context_bytes: u64,
    post_context_bytes: u64,
) -> Option<DurableContextCompaction> {
    let completed = turns
        .iter()
        .filter(|turn| turn.status == DurableTurnStatus::Completed)
        .collect::<Vec<_>>();
    let through_turn_id = completed.last()?.id.clone();
    let mut canonical = String::new();
    let mut source_messages = 0u64;
    for turn in &completed {
        canonical.push_str("{\"type\":\"turn\"}\n");
        let mut index = 0usize;
        while index < turn.items.len() {
            match &turn.items[index] {
                DurableItemSnapshot::UserMessage { text, .. } => {
                    push_text_entry(&mut canonical, "user", text);
                    source_messages = source_messages.checked_add(1)?;
                }
                DurableItemSnapshot::AgentMessage { text, .. } if !text.is_empty() => {
                    push_text_entry(&mut canonical, "assistant", text);
                    source_messages = source_messages.checked_add(1)?;
                }
                DurableItemSnapshot::AgentMessage { .. } => {}
                call @ DurableItemSnapshot::ToolCall { call_id, .. } => {
                    let result_index = ((index + 1)..turn.items.len()).find(|candidate| {
                        matches!(
                            turn.items[*candidate],
                            DurableItemSnapshot::ToolResult { .. }
                                | DurableItemSnapshot::UserMessage { .. }
                                | DurableItemSnapshot::AgentMessage { .. }
                                | DurableItemSnapshot::ToolCall { .. }
                        )
                    })?;
                    let result = turn.items.get(result_index)?;
                    let DurableItemSnapshot::ToolResult {
                        call_id: result_call_id,
                        name: result_name,
                        result,
                        ..
                    } = result
                    else {
                        return None;
                    };
                    let DurableItemSnapshot::ToolCall { name, .. } = call else {
                        unreachable!();
                    };
                    if result_call_id != call_id || result_name != name {
                        return None;
                    }
                    push_tool_entry(&mut canonical, call, result);
                    source_messages = source_messages.checked_add(1)?;
                    index = result_index;
                }
                DurableItemSnapshot::ToolResult { .. } => return None,
                call @ DurableItemSnapshot::McpToolCall { call_id, .. } => {
                    let result_index = ((index + 1)..turn.items.len()).find(|candidate| {
                        matches!(
                            turn.items[*candidate],
                            DurableItemSnapshot::McpToolResult { .. }
                                | DurableItemSnapshot::UserMessage { .. }
                                | DurableItemSnapshot::AgentMessage { .. }
                                | DurableItemSnapshot::ToolCall { .. }
                                | DurableItemSnapshot::McpToolCall { .. }
                        )
                    })?;
                    let DurableItemSnapshot::McpToolResult {
                        call_id: result_call_id,
                        name: result_name,
                        result,
                        ..
                    } = turn.items.get(result_index)?
                    else {
                        return None;
                    };
                    let DurableItemSnapshot::McpToolCall { name, .. } = call else {
                        unreachable!();
                    };
                    if result_call_id != call_id || result_name != name {
                        return None;
                    }
                    push_mcp_tool_entry(&mut canonical, call, result);
                    source_messages = source_messages.checked_add(1)?;
                    index = result_index;
                }
                DurableItemSnapshot::McpToolResult { .. } => return None,
                DurableItemSnapshot::FileChange { .. }
                | DurableItemSnapshot::CommandApprovalRequest { .. }
                | DurableItemSnapshot::CommandApprovalDecision { .. }
                | DurableItemSnapshot::CommandExecutionAttempt { .. }
                | DurableItemSnapshot::McpToolCallApprovalRequest { .. }
                | DurableItemSnapshot::McpToolCallApprovalDecision { .. }
                | DurableItemSnapshot::McpToolExecutionAttempt { .. } => {}
            }
            index += 1;
        }
    }

    let source_bytes = u64::try_from(canonical.len()).ok()?;
    let source_sha256 = sha256(canonical.as_bytes());
    let source_turns = u64::try_from(completed.len()).ok()?;
    let message = render_message(
        &canonical,
        source_turns,
        source_messages,
        source_bytes,
        &source_sha256,
    )?;
    let message_bytes = u64::try_from(message.len()).ok()?;
    let message_sha256 = sha256(message.as_bytes());
    Some(DurableContextCompaction {
        strategy: DurableContextCompactionStrategy::DeterministicExtractiveV1,
        through_turn_id,
        source_turns,
        source_messages,
        source_bytes,
        source_sha256,
        message_bytes,
        message_sha256,
        message,
        pre_context_bytes,
        post_context_bytes,
    })
}

fn push_mcp_tool_entry(
    canonical: &mut String,
    call: &DurableItemSnapshot,
    result: &DurableMcpToolResult,
) {
    let DurableItemSnapshot::McpToolCall {
        name,
        arguments,
        arguments_bytes,
        arguments_sha256,
        inventory_sha256,
        ..
    } = call
    else {
        unreachable!();
    };
    canonical.push_str("{\"type\":\"mcpTool\",\"name\":");
    canonical.push_str(&json_string(name));
    canonical.push_str(",\"arguments\":");
    canonical.push_str(&serde_json::to_string(arguments).expect("MCP arguments must serialize"));
    canonical.push_str(",\"argumentsBytes\":");
    canonical.push_str(&arguments_bytes.to_string());
    canonical.push_str(",\"argumentsSha256\":");
    canonical.push_str(&json_string(arguments_sha256));
    canonical.push_str(",\"inventorySha256\":");
    canonical.push_str(&json_string(inventory_sha256));
    canonical.push_str(",\"result\":");
    match result {
        DurableMcpToolResult::Completed {
            is_error,
            observed_bytes,
            canonical_bytes,
            retained_bytes,
            truncated,
            sha256,
            content_blocks,
            structured_content,
            ..
        } => {
            canonical.push_str("{\"type\":\"completed\",\"isError\":");
            canonical.push_str(if *is_error { "true" } else { "false" });
            canonical.push_str(",\"observedBytes\":");
            canonical.push_str(&observed_bytes.to_string());
            canonical.push_str(",\"canonicalBytes\":");
            canonical.push_str(&canonical_bytes.to_string());
            canonical.push_str(",\"retainedBytes\":");
            canonical.push_str(&retained_bytes.to_string());
            canonical.push_str(",\"truncated\":");
            canonical.push_str(if *truncated { "true" } else { "false" });
            canonical.push_str(",\"sha256\":");
            canonical.push_str(&json_string(sha256));
            canonical.push_str(",\"contentBlocks\":");
            canonical.push_str(&content_blocks.to_string());
            canonical.push_str(",\"structuredContent\":");
            canonical.push_str(if *structured_content { "true" } else { "false" });
            canonical.push('}');
        }
        DurableMcpToolResult::Error {
            kind,
            request_state,
        } => {
            canonical.push_str("{\"type\":\"error\",\"kind\":");
            canonical.push_str(&json_string(kind));
            canonical.push_str(",\"requestState\":");
            canonical.push_str(&json_string(request_state));
            canonical.push('}');
        }
    }
    canonical.push_str("}\n");
}

pub fn validate_context_compaction(
    prior_turns: &[DurableTurnSnapshot],
    compaction: &DurableContextCompaction,
) -> bool {
    compaction.strategy == DurableContextCompactionStrategy::DeterministicExtractiveV1
        && compaction.message_bytes == u64::try_from(compaction.message.len()).unwrap_or(u64::MAX)
        && compaction.message.len() <= MAX_CONTEXT_COMPACTION_MESSAGE_BYTES
        && compaction.message_sha256 == sha256(compaction.message.as_bytes())
        && build_context_compaction(
            prior_turns,
            compaction.pre_context_bytes,
            compaction.post_context_bytes,
        )
        .as_ref()
            == Some(compaction)
}

fn push_text_entry(canonical: &mut String, role: &str, text: &str) {
    canonical.push_str("{\"type\":\"text\",\"role\":");
    canonical.push_str(&json_string(role));
    canonical.push_str(",\"text\":");
    canonical.push_str(&json_string(text));
    canonical.push_str("}\n");
}

fn push_tool_entry(canonical: &mut String, call: &DurableItemSnapshot, result: &DurableToolResult) {
    let DurableItemSnapshot::ToolCall {
        name,
        path,
        query,
        patch,
        command,
        arguments,
        ..
    } = call
    else {
        unreachable!();
    };
    canonical.push_str("{\"type\":\"tool\",\"name\":");
    canonical.push_str(&json_string(name));
    canonical.push_str(",\"path\":");
    canonical.push_str(&json_string(path));
    if let Some(query) = query {
        canonical.push_str(",\"query\":");
        canonical.push_str(&json_string(query));
    }
    if let Some(patch) = patch {
        canonical.push_str(",\"patchBytes\":");
        canonical.push_str(&patch.len().to_string());
        canonical.push_str(",\"patchSha256\":");
        canonical.push_str(&json_string(&sha256(patch.as_bytes())));
    }
    if let Some(command) = command {
        canonical.push_str(",\"command\":");
        canonical.push_str(&json_string(command));
    }
    if let Some(arguments) = arguments {
        canonical.push_str(",\"arguments\":");
        canonical
            .push_str(&serde_json::to_string(arguments).expect("tool arguments must serialize"));
    }
    canonical.push_str(",\"result\":");
    push_result_receipt(canonical, result);
    canonical.push_str("}\n");
}

fn push_result_receipt(canonical: &mut String, result: &DurableToolResult) {
    match result {
        DurableToolResult::Success { content, bytes } => {
            canonical.push_str("{\"type\":\"success\",\"bytes\":");
            canonical.push_str(&bytes.to_string());
            canonical.push_str(",\"contentBytes\":");
            canonical.push_str(&content.len().to_string());
            canonical.push_str(",\"contentSha256\":");
            canonical.push_str(&json_string(&sha256(content.as_bytes())));
            canonical.push('}');
        }
        DurableToolResult::Error { kind } => {
            canonical.push_str("{\"type\":\"error\",\"kind\":");
            canonical.push_str(&json_string(kind));
            canonical.push('}');
        }
        DurableToolResult::Process(process) => {
            canonical.push_str("{\"type\":\"process\",\"outcome\":");
            match process.outcome {
                DurableProcessOutcome::ExitCode { code } => {
                    canonical.push_str("{\"type\":\"exitCode\",\"code\":");
                    canonical.push_str(&code.to_string());
                    canonical.push('}');
                }
                DurableProcessOutcome::Signal { signal } => {
                    canonical.push_str("{\"type\":\"signal\",\"signal\":");
                    canonical.push_str(&signal.to_string());
                    canonical.push('}');
                }
                DurableProcessOutcome::TimedOut => {
                    canonical.push_str("{\"type\":\"timedOut\"}");
                }
            }
            canonical.push_str(",\"stdoutBytes\":");
            canonical.push_str(&process.stdout_bytes.to_string());
            canonical.push_str(",\"stdoutTruncated\":");
            canonical.push_str(if process.stdout_truncated {
                "true"
            } else {
                "false"
            });
            canonical.push_str(",\"stdoutSha256\":");
            canonical.push_str(&json_string(&sha256(process.stdout.as_bytes())));
            canonical.push_str(",\"stderrBytes\":");
            canonical.push_str(&process.stderr_bytes.to_string());
            canonical.push_str(",\"stderrTruncated\":");
            canonical.push_str(if process.stderr_truncated {
                "true"
            } else {
                "false"
            });
            canonical.push_str(",\"stderrSha256\":");
            canonical.push_str(&json_string(&sha256(process.stderr.as_bytes())));
            canonical.push('}');
        }
    }
}

fn render_message(
    canonical: &str,
    source_turns: u64,
    source_messages: u64,
    source_bytes: u64,
    source_sha256: &str,
) -> Option<String> {
    let untruncated_header = header(
        source_turns,
        source_messages,
        source_bytes,
        source_sha256,
        false,
    );
    if untruncated_header.len().checked_add(canonical.len())?
        <= MAX_CONTEXT_COMPACTION_MESSAGE_BYTES
    {
        return Some(format!("{untruncated_header}{canonical}"));
    }
    let truncated_header = header(
        source_turns,
        source_messages,
        source_bytes,
        source_sha256,
        true,
    );
    let available = MAX_CONTEXT_COMPACTION_MESSAGE_BYTES.checked_sub(truncated_header.len())?;
    let mut start = canonical.len().saturating_sub(available);
    while !canonical.is_char_boundary(start) {
        start = start.checked_add(1)?;
    }
    Some(format!("{truncated_header}{}", &canonical[start..]))
}

fn header(
    source_turns: u64,
    source_messages: u64,
    source_bytes: u64,
    source_sha256: &str,
    truncated: bool,
) -> String {
    format!(
        "{COMPACTION_PREFIX}\ncoveredTurns:{source_turns}\ncoveredMessages:{source_messages}\nsourceBytes:{source_bytes}\nsourceSha256:{source_sha256}\ntruncated:{truncated}\nrecentCanonicalTranscript:\n"
    )
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).expect("string must serialize")
}

fn sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}
