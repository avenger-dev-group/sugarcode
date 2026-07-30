use portable_pty::CommandBuilder;
use portable_pty::PtySize;
use portable_pty::native_pty_system;
use std::io::Read;
use std::io::Write;
use std::process::Command;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;

#[test]
fn no_subcommand_rejects_non_terminal_stdio() {
    let home = tempfile::tempdir().expect("home");
    let output = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .arg("--home")
        .arg(home.path())
        .output()
        .expect("run sugarcode");

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8(output.stderr).expect("UTF-8 stderr");
    assert!(stderr.contains("interactive TUI requires terminal stdin and stdout"));
    assert!(stderr.contains("sugarcode exec"));
}

#[test]
fn real_pty_launch_and_safe_exit_restore_terminal_mode() {
    run_real_pty(ExitAction::CtrlQ);
}

#[cfg(unix)]
#[test]
fn termination_signal_restores_terminal_mode() {
    run_real_pty(ExitAction::Terminate);
}

#[derive(Clone, Copy)]
enum ExitAction {
    CtrlQ,
    #[cfg(unix)]
    Terminate,
}

fn run_real_pty(exit_action: ExitAction) {
    let home = tempfile::tempdir().expect("home");
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 90,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("open PTY");
    let mut command = CommandBuilder::new(env!("CARGO_BIN_EXE_sugarcode"));
    command.arg("--home");
    command.arg(home.path());
    command.env("TERM", "xterm-256color");
    let mut child = pair.slave.spawn_command(command).expect("spawn TUI in PTY");
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().expect("clone PTY reader");
    let (terminal_ready, terminal_ready_receiver) = mpsc::channel();
    let output_thread = std::thread::spawn(move || {
        let mut output = Vec::new();
        let mut chunk = [0_u8; 4096];
        let mut reported_ready = false;
        loop {
            let count = reader.read(&mut chunk).expect("read PTY");
            if count == 0 {
                break;
            }
            output.extend_from_slice(&chunk[..count]);
            if !reported_ready
                && (output
                    .windows(b"\x1b[6n".len())
                    .any(|bytes| bytes == b"\x1b[6n")
                    || output
                        .windows(b"SugarCode".len())
                        .any(|bytes| bytes == b"SugarCode"))
            {
                let needs_cursor_answer = output
                    .windows(b"\x1b[6n".len())
                    .any(|bytes| bytes == b"\x1b[6n");
                let _ = terminal_ready.send(needs_cursor_answer);
                reported_ready = true;
            }
        }
        output
    });
    let mut writer = pair.master.take_writer().expect("take PTY writer");
    let needs_cursor_answer = terminal_ready_receiver
        .recv_timeout(Duration::from_secs(5))
        .expect("wait for TUI terminal initialization");
    if needs_cursor_answer {
        writer
            .write_all(b"\x1b[24;1R")
            .expect("answer cursor-position query");
        writer.flush().expect("flush cursor position");
    }
    std::thread::sleep(Duration::from_millis(200));
    match exit_action {
        ExitAction::CtrlQ => {
            writer.write_all(&[0x11]).expect("send Ctrl+Q");
            writer.flush().expect("flush Ctrl+Q");
        }
        #[cfg(unix)]
        ExitAction::Terminate => {
            let process_id = child.process_id().expect("TUI process id");
            // SAFETY: the PTY child remains live and its exact process identifier
            // is used only to deliver the signal exercised by this test.
            let result = unsafe { libc::kill(process_id as i32, libc::SIGTERM) };
            assert_eq!(result, 0, "send SIGTERM");
        }
    }

    let deadline = Instant::now() + Duration::from_secs(10);
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child.try_wait().expect("poll TUI") {
            break status;
        }
        if Instant::now() >= deadline {
            child.kill().expect("kill stuck TUI");
            timed_out = true;
            break child.wait().expect("wait for killed TUI");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    drop(writer);
    drop(pair.master);
    let output = output_thread.join().expect("join PTY reader");
    assert!(
        !timed_out,
        "TUI did not exit safely\n{}",
        String::from_utf8_lossy(&output)
    );
    assert!(
        status.success(),
        "TUI exit status: {status:?}\n{}",
        String::from_utf8_lossy(&output)
    );
    assert!(
        output
            .windows(b"\x1b[?1049h".len())
            .any(|bytes| bytes == b"\x1b[?1049h"),
        "alternate screen was not entered"
    );
    assert!(
        output
            .windows(b"\x1b[?1049l".len())
            .any(|bytes| bytes == b"\x1b[?1049l"),
        "alternate screen was not restored"
    );
    assert!(
        output
            .windows(b"\x1b[?25h".len())
            .any(|bytes| bytes == b"\x1b[?25h"),
        "cursor was not restored"
    );
}
