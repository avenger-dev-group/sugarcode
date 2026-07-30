use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn hidden_desktop_bridge_runs_a_real_interactive_pty() {
    let workspace = tempfile::tempdir().expect("temporary workspace");
    let workspace_path = workspace
        .path()
        .canonicalize()
        .expect("canonical workspace");
    let mut child = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args([
            "__desktop-terminal",
            "--workspace",
            workspace_path.to_str().expect("UTF-8 workspace"),
            "--columns",
            "80",
            "--rows",
            "24",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn terminal bridge");
    let mut input = child.stdin.take().expect("bridge stdin");
    let output = child.stdout.take().expect("bridge stdout");
    let (lines_tx, lines_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            if lines_tx.send(line).is_err() {
                return;
            }
        }
    });

    let ready = receive_json(&lines_rx, Duration::from_secs(20));
    assert_eq!(ready["type"], "ready");
    assert_eq!(ready["version"], 1);
    assert_eq!(ready["encoding"], "utf-8-replacement");

    writeln!(
        input,
        "{}",
        serde_json::json!({
            "type": "resize",
            "sequence": 1,
            "columns": 92,
            "rows": 31
        })
    )
    .expect("resize terminal");
    let terminal_input = if cfg!(windows) {
        "echo SUGARCODE_PTY_ACCEPTANCE\r\nexit\r\n"
    } else {
        "printf 'SUGARCODE_PTY_ACCEPTANCE\\n'\nexit\n"
    };
    writeln!(
        input,
        "{}",
        serde_json::json!({
            "type": "input",
            "sequence": 2,
            "data": terminal_input
        })
    )
    .expect("write terminal input");
    input.flush().expect("flush commands");

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut transcript = String::new();
    let mut exited = false;
    while Instant::now() < deadline {
        let event = receive_json(
            &lines_rx,
            deadline.saturating_duration_since(Instant::now()),
        );
        match event["type"].as_str() {
            Some("output") => {
                transcript.push_str(event["data"].as_str().expect("output data"));
            }
            Some("exit") => {
                exited = true;
                assert_eq!(event["reason"], "natural");
                break;
            }
            Some("error") => panic!("terminal bridge error: {event}"),
            _ => {}
        }
    }
    assert!(exited, "terminal bridge did not publish an exit event");
    assert!(
        transcript.contains("SUGARCODE_PTY_ACCEPTANCE"),
        "missing marker in PTY transcript: {transcript:?}"
    );
    drop(input);
    let status = child.wait().expect("wait for bridge");
    assert!(status.success(), "bridge failed: {status}");
}

fn receive_json(
    receiver: &std::sync::mpsc::Receiver<Result<String, std::io::Error>>,
    timeout: Duration,
) -> Value {
    let line = receiver
        .recv_timeout(timeout)
        .expect("timed out waiting for bridge event")
        .expect("read bridge event");
    serde_json::from_str(&line).expect("valid bridge JSON event")
}
