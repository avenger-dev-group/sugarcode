use super::bridge::Utf8StreamDecoder;
#[cfg(windows)]
use super::bridge::canonical_workspace_path_matches;

#[test]
fn preserves_utf8_split_across_pty_reads() {
    let mut decoder = Utf8StreamDecoder::default();
    assert_eq!(decoder.push(&[0xe4, 0xbd]), "");
    assert_eq!(decoder.push(&[0xa0, 0xe5, 0xa5]), "你");
    assert_eq!(decoder.push(&[0xbd]), "好");
    assert_eq!(decoder.finish(), None);
}

#[test]
fn replaces_invalid_and_incomplete_utf8_deterministically() {
    let mut decoder = Utf8StreamDecoder::default();
    assert_eq!(decoder.push(b"ok\xfftail\xe2"), "ok\u{fffd}tail");
    assert_eq!(decoder.finish().as_deref(), Some("\u{fffd}"));
    assert_eq!(decoder.finish(), None);
}

#[test]
#[cfg(windows)]
fn accepts_equivalent_windows_canonical_path_representations() {
    use std::path::Path;

    assert!(canonical_workspace_path_matches(
        Path::new(r"\\?\D:\a\sugarcode"),
        Path::new(r"d:\a\sugarcode"),
    ));
    assert!(canonical_workspace_path_matches(
        Path::new(r"\\?\UNC\server\share\sugarcode"),
        Path::new(r"\\server\share\sugarcode"),
    ));
    assert!(!canonical_workspace_path_matches(
        Path::new(r"\\?\D:\a\sugarcode"),
        Path::new(r"D:\a\other"),
    ));
}
