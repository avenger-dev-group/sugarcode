use std::ffi::OsString;
use std::io;

use super::FILESYSTEM_READ_ONLY_COMPAT_TOKEN_FLAGS;
use super::FILESYSTEM_READ_ONLY_TOKEN_FLAGS;
use super::PROCESS_CREATION_MITIGATION_POLICY_WIN32K_SYSTEM_CALL_DISABLE_ALWAYS_ON;
use super::environment_block;
use super::quote_windows_argument;
use super::setup_operation_error;
use super::should_retry_without_lua;
use super::should_retry_without_mitigation;
use windows_sys::Win32::Security::DISABLE_MAX_PRIVILEGE;
use windows_sys::Win32::Security::LUA_TOKEN;
use windows_sys::Win32::Security::WRITE_RESTRICTED;

#[test]
fn compatibility_token_flags_only_omit_lua_token() {
    assert_eq!(
        FILESYSTEM_READ_ONLY_TOKEN_FLAGS,
        DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED
    );
    assert_eq!(
        FILESYSTEM_READ_ONLY_COMPAT_TOKEN_FLAGS,
        DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED
    );
    assert_eq!(
        FILESYSTEM_READ_ONLY_TOKEN_FLAGS ^ FILESYSTEM_READ_ONLY_COMPAT_TOKEN_FLAGS,
        LUA_TOKEN
    );
}

#[test]
fn compatibility_token_retry_is_limited_to_invalid_parameter() {
    assert!(should_retry_without_lua(&io::Error::from_raw_os_error(87)));
    assert!(!should_retry_without_lua(&io::Error::from_raw_os_error(5)));
}

#[test]
fn compatibility_mitigation_retry_is_limited_to_optional_attribute_errors() {
    assert!(should_retry_without_mitigation(
        &io::Error::from_raw_os_error(87)
    ));
    assert!(should_retry_without_mitigation(
        &io::Error::from_raw_os_error(50)
    ));
    assert!(!should_retry_without_mitigation(
        &io::Error::from_raw_os_error(5)
    ));
}

#[test]
fn windows_setup_errors_identify_the_failed_operation() {
    let error = setup_operation_error("CreateRestrictedToken", io::Error::from_raw_os_error(87));
    assert!(
        error
            .to_string()
            .starts_with("CreateRestrictedToken failed:")
    );
}

#[test]
fn uses_the_documented_win32k_system_call_disable_bit() {
    assert_eq!(
        PROCESS_CREATION_MITIGATION_POLICY_WIN32K_SYSTEM_CALL_DISABLE_ALWAYS_ON,
        0x1000_0000
    );
}

#[test]
fn quotes_spaces_quotes_and_trailing_backslashes_for_create_process() {
    assert_eq!(quote_windows_argument("plain"), r#""plain""#);
    assert_eq!(quote_windows_argument("two words"), r#""two words""#);
    assert_eq!(quote_windows_argument(r#"a"b"#), r#""a\"b""#);
    assert_eq!(quote_windows_argument(r#"C:\path\"#), r#""C:\path\\""#);
}

#[test]
fn builds_sorted_double_nul_terminated_unicode_environment() {
    let block = environment_block(vec![
        (OsString::from("ZED"), OsString::from("last")),
        (OsString::from("Alpha"), OsString::from("糖")),
    ]);
    assert_eq!(*block.last().expect("final nul"), 0);
    assert_eq!(block[block.len() - 2], 0);
    let entries = block[..block.len() - 1]
        .split(|value| *value == 0)
        .filter(|entry| !entry.is_empty())
        .map(String::from_utf16_lossy)
        .collect::<Vec<_>>();
    assert_eq!(entries, ["Alpha=糖", "ZED=last"]);
}
