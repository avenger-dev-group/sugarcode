use std::error::Error;
use std::fmt;
use std::io;
use std::io::Read;
use std::io::Write;
use sugarcode_credential_store::CredentialReference;
use sugarcode_credential_store::CredentialStore;
use sugarcode_credential_store::CredentialStoreError;
use sugarcode_credential_store::MAX_SECRET_BYTES;
use sugarcode_credential_store::SecretValue;
use zeroize::Zeroizing;

#[derive(Debug)]
pub enum CredentialAction {
    Set { reference: String, read_stdin: bool },
    Status { reference: String },
    Delete { reference: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialCommandError {
    Store(CredentialStoreError),
    StdinRequired,
    InteractiveInputRejected,
    InputUnavailable(io::ErrorKind),
    OutputUnavailable(io::ErrorKind),
}

impl fmt::Display for CredentialCommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Store(error) => error.fmt(formatter),
            Self::StdinRequired => {
                formatter.write_str("credential set requires the --stdin flag")
            }
            Self::InteractiveInputRejected => formatter.write_str(
                "credential input must be piped on standard input; interactive terminal input is not accepted",
            ),
            Self::InputUnavailable(kind) => {
                write!(formatter, "credential input is unavailable ({kind:?})")
            }
            Self::OutputUnavailable(kind) => {
                write!(formatter, "credential status output is unavailable ({kind:?})")
            }
        }
    }
}

impl Error for CredentialCommandError {}

impl From<CredentialStoreError> for CredentialCommandError {
    fn from(error: CredentialStoreError) -> Self {
        Self::Store(error)
    }
}

pub fn run_credential_action(
    action: CredentialAction,
    store: &dyn CredentialStore,
    input: &mut dyn Read,
    input_is_terminal: bool,
    output: &mut dyn Write,
) -> Result<(), CredentialCommandError> {
    match action {
        CredentialAction::Set {
            reference,
            read_stdin,
        } => {
            if !read_stdin {
                return Err(CredentialCommandError::StdinRequired);
            }
            if input_is_terminal {
                return Err(CredentialCommandError::InteractiveInputRejected);
            }
            let reference = CredentialReference::parse(&reference)?;
            let mut bytes = Zeroizing::new(Vec::with_capacity(MAX_SECRET_BYTES));
            input
                .take((MAX_SECRET_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|error| CredentialCommandError::InputUnavailable(error.kind()))?;
            let secret = SecretValue::from_zeroizing(bytes)?;
            store.set(&reference, &secret)?;
            write_safe_line(output, "Credential stored.")
        }
        CredentialAction::Status { reference } => {
            let reference = CredentialReference::parse(&reference)?;
            let message = if store.get(&reference)?.is_some() {
                "Credential is present."
            } else {
                "Credential is missing."
            };
            write_safe_line(output, message)
        }
        CredentialAction::Delete { reference } => {
            let reference = CredentialReference::parse(&reference)?;
            let message = if store.delete(&reference)? {
                "Credential deleted."
            } else {
                "Credential was not present."
            };
            write_safe_line(output, message)
        }
    }
}

fn write_safe_line(output: &mut dyn Write, message: &str) -> Result<(), CredentialCommandError> {
    writeln!(output, "{message}")
        .map_err(|error| CredentialCommandError::OutputUnavailable(error.kind()))
}

#[cfg(test)]
#[path = "tests/credential.rs"]
mod tests;
