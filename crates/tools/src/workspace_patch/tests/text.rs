use super::*;

#[test]
fn text_parser_rejects_bom_nul_bare_cr_mixed_newlines_and_invalid_utf8() {
    for (bytes, expected) in [
        (
            &b"\xef\xbb\xbfone\n"[..],
            WorkspacePatchErrorKind::InvalidEncoding,
        ),
        (&b"one\0two\n"[..], WorkspacePatchErrorKind::BinaryFile),
        (&b"one\rtwo"[..], WorkspacePatchErrorKind::InvalidNewline),
        (
            &b"one\r\ntwo\n"[..],
            WorkspacePatchErrorKind::InvalidNewline,
        ),
        (&b"\xff"[..], WorkspacePatchErrorKind::InvalidEncoding),
    ] {
        assert!(matches!(TextFile::parse(bytes), Err(kind) if kind == expected));
    }
}

#[test]
fn text_round_trip_preserves_newline_style_and_final_newline_semantics() {
    for bytes in [&b"one\ntwo\n"[..], &b"one\r\ntwo"[..], &b""[..]] {
        let text = TextFile::parse(bytes).expect("valid text");
        assert_eq!(
            encode_text(&text.lines, text.newline, text.final_newline),
            bytes
        );
    }
}

#[test]
fn text_parser_enforces_file_line_count_and_line_byte_limits() {
    let too_many_lines = "x\n".repeat(MAX_WORKSPACE_FILE_LINES + 1);
    assert!(matches!(
        TextFile::parse(too_many_lines.as_bytes()),
        Err(WorkspacePatchErrorKind::TooManyLines)
    ));

    let long_line = "x".repeat(MAX_WORKSPACE_LINE_BYTES + 1);
    assert!(matches!(
        TextFile::parse(long_line.as_bytes()),
        Err(WorkspacePatchErrorKind::LineTooLong)
    ));
}
