use super::*;
use std::fs;
use tempfile::tempdir;

#[test]
fn returns_complete_utf8_and_strips_a_bom() {
    let root = tempdir().expect("root");
    fs::write(root.path().join("notes.txt"), b"\xef\xbb\xbfalpha\nbeta\n").expect("write");
    let tool = WorkspaceTool::open(root.path()).expect("workspace");
    assert_eq!(
        tool.inspect_now(&WorkspaceInspectArguments {
            path: "notes.txt".to_string(),
        }),
        WorkspaceInspectOutcome::Complete {
            content: "alpha\nbeta\n".to_string(),
            bytes: 14,
            lines: 2,
            has_utf8_bom: true,
        }
    );
}

#[test]
fn rejects_binary_invalid_encoding_and_links() {
    let root = tempdir().expect("root");
    fs::write(root.path().join("binary"), b"a\0b").expect("binary");
    fs::write(root.path().join("invalid"), [0xff]).expect("invalid");
    let tool = WorkspaceTool::open(root.path()).expect("workspace");
    assert_eq!(
        tool.inspect_now(&WorkspaceInspectArguments {
            path: "binary".to_string(),
        }),
        WorkspaceInspectOutcome::Error {
            kind: WorkspaceInspectErrorKind::Binary,
        }
    );
    assert_eq!(
        tool.inspect_now(&WorkspaceInspectArguments {
            path: "invalid".to_string(),
        }),
        WorkspaceInspectOutcome::Error {
            kind: WorkspaceInspectErrorKind::InvalidEncoding,
        }
    );
}

#[test]
fn returns_a_bounded_preview_for_large_text() {
    let root = tempdir().expect("root");
    let content = "x\n".repeat(MAX_WORKSPACE_INSPECT_COMPLETE_BYTES / 2 + 1);
    fs::write(root.path().join("large.txt"), &content).expect("large");
    let tool = WorkspaceTool::open(root.path()).expect("workspace");
    let WorkspaceInspectOutcome::Truncated {
        bytes,
        returned_bytes,
        ..
    } = tool.inspect_now(&WorkspaceInspectArguments {
        path: "large.txt".to_string(),
    })
    else {
        panic!("expected truncated preview");
    };
    assert_eq!(bytes, content.len());
    assert!(returned_bytes <= MAX_WORKSPACE_INSPECT_PREVIEW_BYTES);
}
