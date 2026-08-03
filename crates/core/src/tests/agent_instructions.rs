use super::*;

#[test]
fn base_agent_prompt_is_fixed_complete_and_provider_counted() {
    let instruction = sugarcode_base_agent_instruction_v1();

    assert_eq!(
        instruction.source,
        ModelInstructionSource::SugarCodeBaseAgentV1
    );
    assert_eq!(instruction.content, SUGARCODE_BASE_AGENT_PROMPT_V1);
    assert_eq!(
        instruction.context_bytes(),
        SUGARCODE_BASE_AGENT_PROMPT_V1.len()
    );
    assert!(!instruction.content.contains('\0'));
    for required in [
        "You are SugarCode",
        "# Instruction authority",
        "# Autonomy and completion",
        "# Tool protocol and boundaries",
        "one or more independent tool calls",
        "bounded concurrent scheduling",
        "collaboration/dispatch",
        "automatically compact older active-Turn context",
        "one concise process update",
        "workspace/apply-diff",
        "shell/exec",
        "# Engineering workflow",
        "# Final response",
    ] {
        assert!(
            instruction.content.contains(required),
            "missing required base-prompt contract: {required}"
        );
    }
}

#[test]
fn model_switch_prompt_is_provider_neutral_and_forbids_private_replay() {
    let instruction = sugarcode_model_switch_instruction_v1();

    assert_eq!(
        instruction.source,
        ModelInstructionSource::SugarCodeModelSwitchV1
    );
    assert!(instruction.content.contains("portable history"));
    assert!(instruction.content.contains("completed tool calls"));
    assert!(
        instruction
            .content
            .contains("provider-private continuation")
    );
    assert!(!instruction.content.contains("OpenAI"));
    assert!(!instruction.content.contains("Anthropic"));
}
