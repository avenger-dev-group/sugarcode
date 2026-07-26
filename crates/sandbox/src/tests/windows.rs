use std::ffi::OsString;

use super::environment_block;
use super::quote_windows_argument;

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
