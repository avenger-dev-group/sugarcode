use serde::{Deserialize, Serialize};

pub(crate) const MAX_COMMAND_BYTES: u64 = 131_072;
pub(crate) const MAX_INPUT_BYTES: usize = 65_536;
pub(crate) const MIN_COLUMNS: u16 = 2;
pub(crate) const MAX_COLUMNS: u16 = 500;
pub(crate) const MIN_ROWS: u16 = 2;
pub(crate) const MAX_ROWS: u16 = 300;

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum InputCommand {
    Input {
        sequence: u64,
        data: String,
    },
    Resize {
        sequence: u64,
        columns: u16,
        rows: u16,
    },
    Terminate {
        sequence: u64,
    },
}

impl InputCommand {
    pub(crate) fn sequence(&self) -> u64 {
        match self {
            Self::Input { sequence, .. }
            | Self::Resize { sequence, .. }
            | Self::Terminate { sequence } => *sequence,
        }
    }

    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::Input { data, .. } if data.len() > MAX_INPUT_BYTES => {
                Err("terminal input exceeded the bounded chunk size")
            }
            Self::Resize { columns, rows, .. }
                if !(MIN_COLUMNS..=MAX_COLUMNS).contains(columns)
                    || !(MIN_ROWS..=MAX_ROWS).contains(rows) =>
            {
                Err("terminal dimensions were outside the supported range")
            }
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum OutputEvent<'a> {
    Ready {
        version: u32,
        shell: &'a str,
        encoding: &'static str,
        process_group_id: Option<u32>,
    },
    Output {
        sequence: u64,
        data: &'a str,
    },
    Error {
        code: &'static str,
        message: &'a str,
        fatal: bool,
    },
    Exit {
        exit_code: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        signal: Option<&'a str>,
        reason: ExitReason,
    },
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ExitReason {
    Natural,
    Requested,
    OwnerLost,
    ProtocolError,
    IoError,
}
