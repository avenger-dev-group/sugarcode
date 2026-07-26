use super::MAX_WORKSPACE_FILE_LINES;
use super::MAX_WORKSPACE_LINE_BYTES;
use super::WorkspaceNewlineStyle;
use super::WorkspacePatchErrorKind;

pub(super) struct TextFile {
    pub(super) lines: Vec<String>,
    pub(super) newline: WorkspaceNewlineStyle,
    pub(super) final_newline: bool,
}

impl TextFile {
    pub(super) fn parse(bytes: &[u8]) -> Result<Self, WorkspacePatchErrorKind> {
        if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
            return Err(WorkspacePatchErrorKind::InvalidEncoding);
        }
        if bytes.contains(&0) {
            return Err(WorkspacePatchErrorKind::BinaryFile);
        }
        let text =
            std::str::from_utf8(bytes).map_err(|_| WorkspacePatchErrorKind::InvalidEncoding)?;
        let has_crlf = text.contains("\r\n");
        let mut has_lf = false;
        let bytes_view = text.as_bytes();
        for (index, byte) in bytes_view.iter().enumerate() {
            if *byte == b'\r' && bytes_view.get(index + 1) != Some(&b'\n') {
                return Err(WorkspacePatchErrorKind::InvalidNewline);
            }
            if *byte == b'\n' && (index == 0 || bytes_view[index - 1] != b'\r') {
                has_lf = true;
            }
        }
        if has_crlf && has_lf {
            return Err(WorkspacePatchErrorKind::InvalidNewline);
        }
        let newline = if has_crlf {
            WorkspaceNewlineStyle::CrLf
        } else {
            WorkspaceNewlineStyle::Lf
        };
        let separator = match newline {
            WorkspaceNewlineStyle::Lf => "\n",
            WorkspaceNewlineStyle::CrLf => "\r\n",
        };
        let final_newline = !text.is_empty() && text.ends_with(separator);
        let body = if final_newline {
            &text[..text.len() - separator.len()]
        } else {
            text
        };
        let lines = if body.is_empty() {
            if final_newline {
                vec![String::new()]
            } else {
                Vec::new()
            }
        } else {
            body.split(separator)
                .map(str::to_string)
                .collect::<Vec<_>>()
        };
        if lines.len() > MAX_WORKSPACE_FILE_LINES {
            return Err(WorkspacePatchErrorKind::TooManyLines);
        }
        if lines
            .iter()
            .any(|line| line.len() > MAX_WORKSPACE_LINE_BYTES)
        {
            return Err(WorkspacePatchErrorKind::LineTooLong);
        }
        Ok(Self {
            lines,
            newline,
            final_newline,
        })
    }
}

pub(super) fn encode_text(
    lines: &[String],
    newline: WorkspaceNewlineStyle,
    final_newline: bool,
) -> Vec<u8> {
    let separator = match newline {
        WorkspaceNewlineStyle::Lf => "\n",
        WorkspaceNewlineStyle::CrLf => "\r\n",
    };
    let mut text = lines.join(separator);
    if final_newline {
        text.push_str(separator);
    }
    text.into_bytes()
}
