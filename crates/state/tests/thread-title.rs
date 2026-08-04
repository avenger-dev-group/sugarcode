use sugarcode_state::{MAX_THREAD_TITLE_CHARS, is_valid_thread_title};

#[test]
fn generated_title_validation_is_unicode_safe_and_bounded() {
    assert!(is_valid_thread_title("修复会话标题"));
    assert!(is_valid_thread_title(&"改".repeat(MAX_THREAD_TITLE_CHARS)));
    assert!(!is_valid_thread_title(
        &"改".repeat(MAX_THREAD_TITLE_CHARS + 1)
    ));
    assert!(!is_valid_thread_title(" 修复会话标题"));
    assert!(!is_valid_thread_title("修复\0会话标题"));
    assert!(!is_valid_thread_title(
        "00000000-0000-7000-8000-000000000001"
    ));
    assert!(!is_valid_thread_title("任务 a940"));
    assert!(!is_valid_thread_title("Task 2a51"));
}
