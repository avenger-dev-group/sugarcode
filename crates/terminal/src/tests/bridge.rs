use super::bridge::Utf8StreamDecoder;

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
