use crate::bridge::{Utf8StreamDecoder, pty_size, validate_size, validate_workspace};
use crate::containment::ProcessContainment;
use crate::protocol::MAX_INPUT_BYTES;
use portable_pty::{ChildKiller, CommandBuilder, ExitStatus, native_pty_system};
use serde::Serialize;
use std::fmt;
use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::Mutex;
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::thread;
use std::time::Duration;

const COMMAND_QUEUE_CAPACITY: usize = 64;
const EVENT_QUEUE_CAPACITY: usize = 128;
const INTERNAL_QUEUE_CAPACITY: usize = 64;
const OUTPUT_CHUNK_BYTES: usize = 8_192;
const OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const FORCE_KILL_TIMEOUT: Duration = Duration::from_millis(750);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedTerminalInfo {
    pub shell: String,
    pub process_group_id: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EmbeddedTerminalEvent {
    Output {
        sequence: u64,
        data: String,
    },
    Error {
        code: String,
        message: String,
        fatal: bool,
    },
    Exit {
        exit_code: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        signal: Option<String>,
        reason: EmbeddedTerminalExitReason,
    },
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EmbeddedTerminalExitReason {
    Natural,
    Requested,
    OwnerLost,
    ProtocolError,
    IoError,
}

#[derive(Debug)]
enum EmbeddedCommand {
    Input(String),
    Resize { columns: u16, rows: u16 },
    Terminate,
}

enum DriverEvent {
    Command(EmbeddedCommand),
    OwnerLost,
    Output(String),
    OutputClosed,
    OutputError(String),
    ChildExited(io::Result<ExitStatus>),
    ForceKill,
    DrainTimeout,
}

pub struct EmbeddedTerminal {
    info: EmbeddedTerminalInfo,
    commands: SyncSender<EmbeddedCommand>,
    events: Mutex<Receiver<EmbeddedTerminalEvent>>,
}

impl fmt::Debug for EmbeddedTerminal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EmbeddedTerminal")
            .field("info", &self.info)
            .finish_non_exhaustive()
    }
}

impl EmbeddedTerminal {
    pub fn spawn(workspace: &Path, columns: u16, rows: u16) -> Result<Self, crate::BridgeError> {
        validate_workspace(workspace)?;
        validate_size(columns, rows)?;
        let mut containment = ProcessContainment::prepare().map_err(|error| {
            crate::BridgeError::new(format!("process containment failed: {error}"))
        })?;
        let pair = native_pty_system()
            .openpty(pty_size(columns, rows))
            .map_err(|error| crate::BridgeError::new(format!("PTY creation failed: {error}")))?;
        let mut command = CommandBuilder::new_default_prog();
        command.cwd(workspace);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let shell = command.get_shell();
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| crate::BridgeError::new(format!("shell launch failed: {error}")))?;
        drop(pair.slave);

        #[cfg(unix)]
        containment
            .bind_process_group(child.process_id().ok_or_else(|| {
                crate::BridgeError::new("PTY child did not expose a process identifier")
            })?)
            .map_err(|error| {
                crate::BridgeError::new(format!("process containment failed: {error}"))
            })?;
        #[cfg(windows)]
        containment
            .bind_process_handle(child.as_raw_handle().ok_or_else(|| {
                crate::BridgeError::new("PTY child did not expose a process handle")
            })?)
            .map_err(|error| {
                crate::BridgeError::new(format!("process containment failed: {error}"))
            })?;

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| crate::BridgeError::new(format!("PTY reader failed: {error}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| crate::BridgeError::new(format!("PTY writer failed: {error}")))?;
        let killer = child.clone_killer();
        let info = EmbeddedTerminalInfo {
            shell,
            process_group_id: containment.public_process_group_id(),
        };
        let (commands_tx, commands_rx) = mpsc::sync_channel(COMMAND_QUEUE_CAPACITY);
        let (driver_tx, driver_rx) = mpsc::sync_channel(INTERNAL_QUEUE_CAPACITY);
        let (events_tx, events_rx) = mpsc::sync_channel(EVENT_QUEUE_CAPACITY);
        spawn_command_forwarder(commands_rx, driver_tx.clone());
        spawn_output_reader(reader, driver_tx.clone());
        spawn_child_waiter(child, driver_tx.clone());
        thread::spawn(move || {
            drive(
                driver_rx,
                driver_tx,
                events_tx,
                pair.master,
                writer,
                killer,
                containment,
            );
        });
        Ok(Self {
            info,
            commands: commands_tx,
            events: Mutex::new(events_rx),
        })
    }

    pub fn info(&self) -> &EmbeddedTerminalInfo {
        &self.info
    }

    pub fn input(&self, data: String) -> Result<(), crate::BridgeError> {
        if data.is_empty() || data.len() > MAX_INPUT_BYTES {
            return Err(crate::BridgeError::new("terminal input was invalid"));
        }
        self.send(EmbeddedCommand::Input(data))
    }

    pub fn resize(&self, columns: u16, rows: u16) -> Result<(), crate::BridgeError> {
        validate_size(columns, rows)?;
        self.send(EmbeddedCommand::Resize { columns, rows })
    }

    pub fn terminate(&self) -> Result<(), crate::BridgeError> {
        self.send(EmbeddedCommand::Terminate)
    }

    pub fn drain_events(
        &self,
        maximum: usize,
    ) -> Result<Vec<EmbeddedTerminalEvent>, crate::BridgeError> {
        if maximum == 0 || maximum > EVENT_QUEUE_CAPACITY {
            return Err(crate::BridgeError::new("terminal event limit was invalid"));
        }
        let events = self
            .events
            .lock()
            .map_err(|_| crate::BridgeError::new("terminal event lock was poisoned"))?;
        let mut drained = Vec::new();
        while drained.len() < maximum {
            match events.try_recv() {
                Ok(event) => drained.push(event),
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
            }
        }
        Ok(drained)
    }

    fn send(&self, command: EmbeddedCommand) -> Result<(), crate::BridgeError> {
        self.commands
            .try_send(command)
            .map_err(|error| match error {
                TrySendError::Full(_) => crate::BridgeError::new("terminal command queue was full"),
                TrySendError::Disconnected(_) => {
                    crate::BridgeError::new("terminal session has exited")
                }
            })
    }
}

impl Drop for EmbeddedTerminal {
    fn drop(&mut self) {
        let _ = self.commands.try_send(EmbeddedCommand::Terminate);
    }
}

fn drive(
    events: Receiver<DriverEvent>,
    events_tx: SyncSender<DriverEvent>,
    output: SyncSender<EmbeddedTerminalEvent>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    mut writer: Box<dyn Write + Send>,
    mut killer: Box<dyn ChildKiller + Send + Sync>,
    containment: ProcessContainment,
) {
    let mut output_sequence = 0_u64;
    let mut exit_status: Option<ExitStatus> = None;
    let mut output_closed = false;
    let mut reason = EmbeddedTerminalExitReason::Natural;
    let mut termination_requested = false;
    while let Ok(event) = events.recv() {
        match event {
            DriverEvent::Command(EmbeddedCommand::Input(data)) => {
                if writer
                    .write_all(data.as_bytes())
                    .and_then(|()| writer.flush())
                    .is_err()
                {
                    reason = EmbeddedTerminalExitReason::IoError;
                    request_termination(
                        &mut *killer,
                        &containment,
                        &events_tx,
                        &mut termination_requested,
                    );
                }
            }
            DriverEvent::Command(EmbeddedCommand::Resize { columns, rows }) => {
                if let Err(error) = master.resize(pty_size(columns, rows)) {
                    let _ = output.try_send(EmbeddedTerminalEvent::Error {
                        code: "resizeFailed".to_owned(),
                        message: format!("Terminal resize failed: {error}"),
                        fatal: false,
                    });
                }
            }
            DriverEvent::Command(EmbeddedCommand::Terminate) => {
                reason = EmbeddedTerminalExitReason::Requested;
                request_termination(
                    &mut *killer,
                    &containment,
                    &events_tx,
                    &mut termination_requested,
                );
            }
            DriverEvent::OwnerLost => {
                reason = EmbeddedTerminalExitReason::OwnerLost;
                request_termination(
                    &mut *killer,
                    &containment,
                    &events_tx,
                    &mut termination_requested,
                );
            }
            DriverEvent::Output(data) => {
                output_sequence = output_sequence.saturating_add(1);
                if output
                    .try_send(EmbeddedTerminalEvent::Output {
                        sequence: output_sequence,
                        data,
                    })
                    .is_err()
                {
                    containment.force_kill();
                    let _ = output.send(EmbeddedTerminalEvent::Error {
                        code: "outputOverload".to_owned(),
                        message: "Terminal output exceeded the bounded event queue.".to_owned(),
                        fatal: true,
                    });
                    return;
                }
            }
            DriverEvent::OutputClosed => output_closed = true,
            DriverEvent::OutputError(message) => {
                reason = EmbeddedTerminalExitReason::IoError;
                output_closed = true;
                let _ = output.try_send(EmbeddedTerminalEvent::Error {
                    code: "outputFailed".to_owned(),
                    message,
                    fatal: true,
                });
                request_termination(
                    &mut *killer,
                    &containment,
                    &events_tx,
                    &mut termination_requested,
                );
            }
            DriverEvent::ChildExited(status) => {
                match status {
                    Ok(status) => exit_status = Some(status),
                    Err(error) => {
                        let _ = output.try_send(EmbeddedTerminalEvent::Error {
                            code: "waitFailed".to_owned(),
                            message: format!("Waiting for PTY child failed: {error}"),
                            fatal: true,
                        });
                        return;
                    }
                }
                containment.terminate();
                spawn_timer(
                    events_tx.clone(),
                    OUTPUT_DRAIN_TIMEOUT,
                    DriverEvent::DrainTimeout,
                );
            }
            DriverEvent::ForceKill => containment.force_kill(),
            DriverEvent::DrainTimeout => output_closed = true,
        }
        if output_closed && let Some(status) = exit_status.as_ref() {
            let _ = output.try_send(EmbeddedTerminalEvent::Exit {
                exit_code: status.exit_code(),
                signal: status.signal().map(str::to_owned),
                reason,
            });
            return;
        }
    }
}

fn request_termination(
    killer: &mut dyn ChildKiller,
    containment: &ProcessContainment,
    events: &SyncSender<DriverEvent>,
    requested: &mut bool,
) {
    if *requested {
        return;
    }
    *requested = true;
    containment.terminate();
    let _ = killer.kill();
    spawn_timer(events.clone(), FORCE_KILL_TIMEOUT, DriverEvent::ForceKill);
}

fn spawn_timer(sender: SyncSender<DriverEvent>, delay: Duration, event: DriverEvent) {
    thread::spawn(move || {
        thread::sleep(delay);
        let _ = sender.send(event);
    });
}

fn spawn_command_forwarder(commands: Receiver<EmbeddedCommand>, events: SyncSender<DriverEvent>) {
    thread::spawn(move || {
        while let Ok(command) = commands.recv() {
            if events.send(DriverEvent::Command(command)).is_err() {
                return;
            }
        }
        let _ = events.send(DriverEvent::OwnerLost);
    });
}

fn spawn_output_reader(mut reader: Box<dyn Read + Send>, events: SyncSender<DriverEvent>) {
    thread::spawn(move || {
        let mut decoder = Utf8StreamDecoder::default();
        let mut bytes = [0_u8; OUTPUT_CHUNK_BYTES];
        loop {
            match reader.read(&mut bytes) {
                Ok(0) => {
                    if let Some(residual) = decoder.finish() {
                        let _ = events.send(DriverEvent::Output(residual));
                    }
                    let _ = events.send(DriverEvent::OutputClosed);
                    return;
                }
                Ok(read) => {
                    let decoded = decoder.push(&bytes[..read]);
                    if !decoded.is_empty() && events.send(DriverEvent::Output(decoded)).is_err() {
                        return;
                    }
                }
                Err(error) => {
                    let _ = events.send(DriverEvent::OutputError(format!(
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
    events: SyncSender<DriverEvent>,
) {
    thread::spawn(move || {
        let _ = events.send(DriverEvent::ChildExited(child.wait()));
    });
}
