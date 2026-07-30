use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
#[ignore = "native PTY acceptance is run by the dedicated cross-platform CI gate"]
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

    let ready = receive_json(&lines_rx, Duration::from_secs(20), "bridge ready");
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
    let marker_input = if cfg!(windows) {
        "echo SUGARCODE_PTY_ACCEPTANCE\r"
    } else {
        "printf 'SUGARCODE_PTY_ACCEPTANCE\\n'\n"
    };
    writeln!(
        input,
        "{}",
        serde_json::json!({
            "type": "input",
            "sequence": 2,
            "data": marker_input
        })
    )
    .expect("write terminal input");
    input.flush().expect("flush marker command");

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut transcript = String::new();
    while !transcript.contains("SUGARCODE_PTY_ACCEPTANCE") {
        let event = receive_json(
            &lines_rx,
            deadline.saturating_duration_since(Instant::now()),
            "shell marker output",
        );
        match event["type"].as_str() {
            Some("output") => {
                transcript.push_str(event["data"].as_str().expect("output data"));
            }
            Some("exit") => panic!("shell exited before processing the marker: {event}"),
            Some("error") => panic!("terminal bridge error: {event}"),
            _ => {}
        }
    }

    let exit_input = if cfg!(windows) { "exit\r" } else { "exit\n" };
    writeln!(
        input,
        "{}",
        serde_json::json!({
            "type": "input",
            "sequence": 3,
            "data": exit_input
        })
    )
    .expect("write shell exit");
    input.flush().expect("flush shell exit");

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut exited = false;
    while Instant::now() < deadline {
        let event = receive_json(
            &lines_rx,
            deadline.saturating_duration_since(Instant::now()),
            "natural shell exit",
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
    phase: &str,
) -> Value {
    let line = receiver
        .recv_timeout(timeout)
        .unwrap_or_else(|error| panic!("timed out waiting for {phase}: {error:?}"))
        .expect("read bridge event");
    serde_json::from_str(&line).expect("valid bridge JSON event")
}
