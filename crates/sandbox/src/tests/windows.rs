use std::ffi::OsString;
use std::io;

use super::FILESYSTEM_READ_ONLY_COMPAT_TOKEN_FLAGS;
use super::FILESYSTEM_READ_ONLY_INTEGRITY_SID;
use super::FILESYSTEM_READ_ONLY_RESTRICTING_SID;
use super::FILESYSTEM_READ_ONLY_TOKEN_FLAGS;
use super::command_line;
use super::environment_block;
use super::quote_windows_argument;
use super::setup_operation_error;
use super::should_retry_without_lua;
use windows_sys::Win32::Security::DISABLE_MAX_PRIVILEGE;
use windows_sys::Win32::Security::LUA_TOKEN;
use windows_sys::Win32::Security::WRITE_RESTRICTED;
use windows_sys::Win32::Security::WinUntrustedLabelSid;
use windows_sys::Win32::Security::WinWriteRestrictedCodeSid;

#[test]
fn filesystem_delete_restriction_uses_the_windows_untrusted_integrity_sid() {
    assert_eq!(FILESYSTEM_READ_ONLY_INTEGRITY_SID, WinUntrustedLabelSid);
}

#[test]
fn filesystem_write_restriction_uses_the_windows_write_restricted_code_sid() {
    assert_eq!(
        FILESYSTEM_READ_ONLY_RESTRICTING_SID,
        WinWriteRestrictedCodeSid
    );
}

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
fn windows_setup_errors_identify_the_failed_operation() {
    let error = setup_operation_error("CreateRestrictedToken", io::Error::from_raw_os_error(87));
    assert!(
        error
            .to_string()
            .starts_with("CreateRestrictedToken failed:")
    );
}

#[test]
fn quotes_spaces_quotes_and_trailing_backslashes_for_create_process() {
    assert_eq!(quote_windows_argument("plain"), "plain");
    assert_eq!(quote_windows_argument("/D"), "/D");
    assert_eq!(quote_windows_argument(""), r#""""#);
    assert_eq!(quote_windows_argument("two words"), r#""two words""#);
    assert_eq!(quote_windows_argument(r#"a"b"#), r#""a\"b""#);
    assert_eq!(
        quote_windows_argument(r#"C:\path with space\"#),
        r#""C:\path with space\\""#
    );
}

#[test]
fn cmd_switches_remain_unquoted_in_the_create_process_command_line() {
    let command_line = command_line(
        r"C:\Windows\System32\cmd.exe",
        &["/D".to_owned(), "/C".to_owned(), "exit 0".to_owned()],
    );
    assert_eq!(
        String::from_utf16_lossy(&command_line[..command_line.len() - 1]),
        r#"C:\Windows\System32\cmd.exe /D /C "exit 0""#
    );
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
