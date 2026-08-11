use super::embedded::Utf8StreamDecoder;
#[cfg(windows)]
use super::embedded::canonical_workspace_path_matches;
use super::{EmbeddedTerminal, EmbeddedTerminalEvent};

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
fn embedded_terminal_streams_output_and_exits() {
    let workspace = tempfile::tempdir().expect("workspace");
    let canonical_workspace = workspace
        .path()
        .canonicalize()
        .expect("canonical workspace");
    let terminal = EmbeddedTerminal::spawn(&canonical_workspace, 80, 24).expect("spawn terminal");
    #[cfg(not(windows))]
    terminal
        .input("printf 'SUGARCODE_EMBEDDED_PTY\\n'\nexit\n".to_owned())
        .expect("terminal input");

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut transcript = String::new();
    let mut exited = false;
    #[cfg(windows)]
    let mut command_sent = false;
    while std::time::Instant::now() < deadline && !exited {
        for event in terminal.drain_events(128).expect("drain terminal") {
            match event {
                EmbeddedTerminalEvent::Output { data, .. } => {
                    transcript.push_str(&data);
                    #[cfg(windows)]
                    if !command_sent && transcript.contains("\u{1b}[6n") {
                        // ConPTY asks its terminal peer for the cursor position while
                        // cmd.exe starts. xterm.js answers before forwarding user input;
                        // mirror that handshake in this headless native test.
                        terminal
                            .input("\u{1b}[1;1R".to_owned())
                            .expect("terminal cursor-position response");
                        terminal
                            .input("echo SUGARCODE_EMBEDDED_PTY & exit\r".to_owned())
                            .expect("terminal input");
                        command_sent = true;
                    }
                }
                EmbeddedTerminalEvent::Exit { .. } => exited = true,
                EmbeddedTerminalEvent::Error {
                    fatal: true,
                    message,
                    ..
                } => {
                    panic!("terminal failed: {message}")
                }
                EmbeddedTerminalEvent::Error { fatal: false, .. } => {}
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(
        exited,
        "embedded terminal did not exit; shell: {:?}; transcript: {transcript:?}",
        terminal.info().shell
    );
    #[cfg(windows)]
    assert!(command_sent, "ConPTY did not request a cursor position");
    assert!(
        transcript.contains("SUGARCODE_EMBEDDED_PTY"),
        "missing terminal output: {transcript:?}"
    );
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
