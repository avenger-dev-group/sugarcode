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
        "Each provider round accepts at most one tool call",
        "automatically compact older active-Turn context",
        "without a preamble",
        "workspace/apply-patch",
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
