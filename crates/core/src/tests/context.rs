use super::*;

#[test]
fn default_context_budget_is_128k_tokens_with_output_headroom() {
    assert_eq!(DEFAULT_PROVIDER_CONTEXT_TOKENS, 128 * 1024);
    assert_eq!(PROVIDER_OUTPUT_RESERVE_TOKENS, 16 * 1024);
    assert_eq!(
        COMPACTION_TARGET_BYTES,
        (112 * 1024) * CONSERVATIVE_UTF8_BYTES_PER_TOKEN
    );
}
