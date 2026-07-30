use crate::TERMINAL_BRIDGE_PROTOCOL_VERSION;
use crate::containment::ProcessContainment;
use crate::protocol::{
    ExitReason, InputCommand, MAX_COLUMNS, MAX_COMMAND_BYTES, MAX_ROWS, MIN_COLUMNS, MIN_ROWS,
    OutputEvent,
};
use portable_pty::{ChildKiller, CommandBuilder, ExitStatus, PtySize, native_pty_system};
use std::fmt;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::Path;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread;
use std::time::Duration;

const OUTPUT_CHUNK_BYTES: usize = 8_192;
const EVENT_QUEUE_CAPACITY: usize = 64;
const OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const FORCE_KILL_TIMEOUT: Duration = Duration::from_millis(750);

#[derive(Debug)]
pub struct BridgeError {
    message: String,
}

impl BridgeError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for BridgeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for BridgeError {}

enum BridgeEvent {
    Command(InputCommand),
    InputClosed,
    ProtocolError(String),
    Output(String),
    OutputClosed,
    OutputError(String),
    ChildExited(io::Result<ExitStatus>),
    ForceKill,
    DrainTimeout,
}

pub(crate) fn run_stdio(workspace: &Path, columns: u16, rows: u16) -> Result<(), BridgeError> {
    validate_workspace(workspace)?;
    validate_size(columns, rows)?;

    let mut containment = ProcessContainment::prepare()
        .map_err(|error| BridgeError::new(format!("process containment failed: {error}")))?;
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(pty_size(columns, rows))
        .map_err(|error| BridgeError::new(format!("PTY creation failed: {error}")))?;
    let mut command = CommandBuilder::new_default_prog();
    command.cwd(workspace);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    let shell = command.get_shell();
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| BridgeError::new(format!("shell launch failed: {error}")))?;
    drop(pair.slave);

    #[cfg(unix)]
    {
        let process_id = child
            .process_id()
            .ok_or_else(|| BridgeError::new("PTY child did not expose a process identifier"))?;
        containment
            .bind_process_group(process_id)
            .map_err(|error| BridgeError::new(format!("process containment failed: {error}")))?;
    }
    #[cfg(windows)]
    containment
        .bind_process_handle(
            child
                .as_raw_handle()
                .ok_or_else(|| BridgeError::new("PTY child did not expose a process handle"))?,
        )
        .map_err(|error| BridgeError::new(format!("process containment failed: {error}")))?;
    let mut master = Some(pair.master);
    let reader = master
        .as_ref()
        .expect("master is present")
        .try_clone_reader()
        .map_err(|error| BridgeError::new(format!("PTY reader failed: {error}")))?;
    let mut writer = Some(
        master
            .as_ref()
            .expect("master is present")
            .take_writer()
            .map_err(|error| BridgeError::new(format!("PTY writer failed: {error}")))?,
    );
    let mut killer = child.clone_killer();

    let (events_tx, events_rx) = mpsc::sync_channel(EVENT_QUEUE_CAPACITY);
    spawn_input_reader(events_tx.clone());
    spawn_output_reader(reader, events_tx.clone());
    spawn_child_waiter(child, events_tx.clone());

    let stdout = io::stdout();
    let mut output = stdout.lock();
    write_event(
        &mut output,
        &OutputEvent::Ready {
            version: TERMINAL_BRIDGE_PROTOCOL_VERSION,
            shell: &shell,
            encoding: "utf-8-replacement",
            process_group_id: containment.public_process_group_id(),
        },
    )?;

    drive_bridge(
        &events_rx,
        &events_tx,
        &mut output,
        &mut master,
        &mut writer,
        &mut *killer,
        &containment,
    )
}

#[allow(clippy::too_many_arguments)]
fn drive_bridge(
    events: &Receiver<BridgeEvent>,
    events_tx: &SyncSender<BridgeEvent>,
    output: &mut impl Write,
    master: &mut Option<Box<dyn portable_pty::MasterPty + Send>>,
    writer: &mut Option<Box<dyn Write + Send>>,
    killer: &mut dyn ChildKiller,
    containment: &ProcessContainment,
) -> Result<(), BridgeError> {
    let mut expected_command_sequence = 1_u64;
    let mut output_sequence = 0_u64;
    let mut exit_status: Option<ExitStatus> = None;
    let mut output_closed = false;
    let mut reason = ExitReason::Natural;
    let mut termination_requested = false;

    loop {
        let event = events
            .recv()
            .map_err(|_| BridgeError::new("terminal bridge event queue closed"))?;
        match event {
            BridgeEvent::Command(command) => {
                if command.sequence() != expected_command_sequence {
                    reason = ExitReason::ProtocolError;
                    write_event(
                        output,
                        &OutputEvent::Error {
                            code: "invalidSequence",
                            message: "Terminal command sequence was not contiguous.",
                            fatal: true,
                        },
                    )?;
                    request_termination(killer, containment, events_tx, &mut termination_requested);
                    continue;
                }
                expected_command_sequence = expected_command_sequence.saturating_add(1);
                if let Err(message) = command.validate() {
                    reason = ExitReason::ProtocolError;
                    write_event(
                        output,
                        &OutputEvent::Error {
                            code: "invalidCommand",
                            message,
                            fatal: true,
                        },
                    )?;
                    request_termination(killer, containment, events_tx, &mut termination_requested);
                    continue;
                }
                match command {
                    InputCommand::Input { data, .. } => {
                        let Some(pty_input) = writer.as_mut() else {
                            continue;
                        };
                        if let Err(error) = pty_input
                            .write_all(data.as_bytes())
                            .and_then(|()| pty_input.flush())
                        {
                            reason = ExitReason::IoError;
                            let message = format!("Terminal input failed: {error}");
                            write_event(
                                output,
                                &OutputEvent::Error {
                                    code: "inputFailed",
                                    message: &message,
                                    fatal: true,
                                },
                            )?;
                            request_termination(
                                killer,
                                containment,
                                events_tx,
                                &mut termination_requested,
                            );
                        }
                    }
                    InputCommand::Resize { columns, rows, .. } => {
                        let resize_result = master
                            .as_ref()
                            .map_or(Ok(()), |pty| pty.resize(pty_size(columns, rows)));
                        if let Err(error) = resize_result {
                            let message = format!("Terminal resize failed: {error}");
                            write_event(
                                output,
                                &OutputEvent::Error {
                                    code: "resizeFailed",
                                    message: &message,
                                    fatal: false,
                                },
                            )?;
                        }
                    }
                    InputCommand::Terminate { .. } => {
                        reason = ExitReason::Requested;
                        request_termination(
                            killer,
                            containment,
                            events_tx,
                            &mut termination_requested,
                        );
                    }
                }
            }
            BridgeEvent::InputClosed => {
                reason = ExitReason::OwnerLost;
                request_termination(killer, containment, events_tx, &mut termination_requested);
            }
            BridgeEvent::ProtocolError(message) => {
                reason = ExitReason::ProtocolError;
                write_event(
                    output,
                    &OutputEvent::Error {
                        code: "invalidProtocol",
                        message: &message,
                        fatal: true,
                    },
                )?;
                request_termination(killer, containment, events_tx, &mut termination_requested);
            }
            BridgeEvent::Output(data) => {
                output_sequence = output_sequence.saturating_add(1);
                write_event(
                    output,
                    &OutputEvent::Output {
                        sequence: output_sequence,
                        data: &data,
                    },
                )?;
            }
            BridgeEvent::OutputClosed => output_closed = true,
            BridgeEvent::OutputError(message) => {
                reason = ExitReason::IoError;
                output_closed = true;
                write_event(
                    output,
                    &OutputEvent::Error {
                        code: "outputFailed",
                        message: &message,
                        fatal: true,
                    },
                )?;
                request_termination(killer, containment, events_tx, &mut termination_requested);
            }
            BridgeEvent::ChildExited(status) => {
                exit_status = Some(status.map_err(|error| {
                    BridgeError::new(format!("waiting for PTY child failed: {error}"))
                })?);
                containment.terminate();
                writer.take();
                master.take();
                spawn_timer(
                    events_tx.clone(),
                    OUTPUT_DRAIN_TIMEOUT,
                    BridgeEvent::DrainTimeout,
                );
            }
            BridgeEvent::ForceKill => containment.force_kill(),
            BridgeEvent::DrainTimeout => {
                output_closed = true;
            }
        }

        if output_closed && let Some(status) = exit_status.as_ref() {
            write_event(
                output,
                &OutputEvent::Exit {
                    exit_code: status.exit_code(),
                    signal: status.signal(),
                    reason,
                },
            )?;
            return Ok(());
        }
    }
}

fn request_termination(
    killer: &mut dyn ChildKiller,
    containment: &ProcessContainment,
    events_tx: &SyncSender<BridgeEvent>,
    requested: &mut bool,
) {
    if *requested {
        return;
    }
    *requested = true;
    containment.terminate();
    let _ = killer.kill();
    spawn_timer(
        events_tx.clone(),
        FORCE_KILL_TIMEOUT,
        BridgeEvent::ForceKill,
    );
}

fn spawn_timer(sender: SyncSender<BridgeEvent>, delay: Duration, event: BridgeEvent) {
    thread::spawn(move || {
        thread::sleep(delay);
        let _ = sender.send(event);
    });
}

fn spawn_input_reader(sender: SyncSender<BridgeEvent>) {
    thread::spawn(move || {
        let stdin = io::stdin();
        let mut input = BufReader::new(stdin.lock());
        loop {
            let mut line = Vec::new();
            let read = match (&mut input)
                .take(MAX_COMMAND_BYTES + 1)
                .read_until(b'\n', &mut line)
            {
                Ok(read) => read,
                Err(error) => {
                    let _ = sender.send(BridgeEvent::ProtocolError(format!(
                        "Terminal command read failed: {error}"
                    )));
                    return;
                }
            };
            if read == 0 {
                let _ = sender.send(BridgeEvent::InputClosed);
                return;
            }
            if u64::try_from(read).unwrap_or(u64::MAX) > MAX_COMMAND_BYTES || !line.ends_with(b"\n")
            {
                let _ = sender.send(BridgeEvent::ProtocolError(
                    "Terminal command exceeded the bounded line size.".to_owned(),
                ));
                return;
            }
            let parsed = serde_json::from_slice::<InputCommand>(&line)
                .map_err(|error| format!("Invalid terminal command: {error}"))
                .and_then(|command| command.validate().map_err(str::to_owned).map(|()| command));
            match parsed {
                Ok(command) => {
                    if sender.send(BridgeEvent::Command(command)).is_err() {
                        return;
                    }
                }
                Err(message) => {
                    let _ = sender.send(BridgeEvent::ProtocolError(message));
                    return;
                }
            }
        }
    });
}

fn spawn_output_reader(mut reader: Box<dyn Read + Send>, sender: SyncSender<BridgeEvent>) {
    thread::spawn(move || {
        let mut decoder = Utf8StreamDecoder::default();
        let mut bytes = [0_u8; OUTPUT_CHUNK_BYTES];
        loop {
            match reader.read(&mut bytes) {
                Ok(0) => {
                    if let Some(residual) = decoder.finish()
                        && sender.send(BridgeEvent::Output(residual)).is_err()
                    {
                        return;
                    }
                    let _ = sender.send(BridgeEvent::OutputClosed);
                    return;
                }
                Ok(read) => {
                    let decoded = decoder.push(&bytes[..read]);
                    if !decoded.is_empty() && sender.send(BridgeEvent::Output(decoded)).is_err() {
                        return;
                    }
                }
                Err(error) => {
                    let _ = sender.send(BridgeEvent::OutputError(format!(
                        "PTY output read failed: {error}"
                    )));
                    return;
                }
            }
        }
    });
}

fn spawn_child_waiter(
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    sender: SyncSender<BridgeEvent>,
) {
    thread::spawn(move || {
        let _ = sender.send(BridgeEvent::ChildExited(child.wait()));
    });
}

fn write_event(output: &mut impl Write, event: &OutputEvent<'_>) -> Result<(), BridgeError> {
    serde_json::to_writer(&mut *output, event)
        .map_err(|error| BridgeError::new(format!("terminal event encoding failed: {error}")))?;
    output
        .write_all(b"\n")
        .and_then(|()| output.flush())
        .map_err(|error| BridgeError::new(format!("terminal event write failed: {error}")))
}

fn validate_workspace(workspace: &Path) -> Result<(), BridgeError> {
    if !workspace.is_absolute() {
        return Err(BridgeError::new("terminal workspace must be absolute"));
    }
    let metadata = workspace
        .symlink_metadata()
        .map_err(|error| BridgeError::new(format!("terminal workspace is unavailable: {error}")))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(BridgeError::new(
            "terminal workspace must be a canonical directory",
        ));
    }
    let canonical = workspace
        .canonicalize()
        .map_err(|error| BridgeError::new(format!("terminal workspace is unavailable: {error}")))?;
    if canonical != workspace {
        return Err(BridgeError::new(
            "terminal workspace path must already be canonical",
        ));
    }
    Ok(())
}

fn validate_size(columns: u16, rows: u16) -> Result<(), BridgeError> {
    if !(MIN_COLUMNS..=MAX_COLUMNS).contains(&columns) || !(MIN_ROWS..=MAX_ROWS).contains(&rows) {
        return Err(BridgeError::new(
            "terminal dimensions were outside the supported range",
        ));
    }
    Ok(())
}

fn pty_size(columns: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols: columns,
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[derive(Default)]
pub(crate) struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    pub(crate) fn push(&mut self, bytes: &[u8]) -> String {
        let mut combined = std::mem::take(&mut self.pending);
        combined.extend_from_slice(bytes);
        let mut decoded = String::with_capacity(combined.len());
        let mut remaining = combined.as_slice();
        while !remaining.is_empty() {
            match std::str::from_utf8(remaining) {
                Ok(valid) => {
                    decoded.push_str(valid);
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    decoded.push_str(
                        std::str::from_utf8(&remaining[..valid])
                            .expect("UTF-8 validator identified a valid prefix"),
                    );
                    remaining = &remaining[valid..];
                    if let Some(invalid) = error.error_len() {
                        decoded.push('\u{fffd}');
                        remaining = &remaining[invalid..];
                    } else {
                        self.pending.extend_from_slice(remaining);
                        break;
                    }
                }
            }
        }
        decoded
    }

    pub(crate) fn finish(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            None
        } else {
            self.pending.clear();
            Some("\u{fffd}".to_owned())
        }
    }
}
