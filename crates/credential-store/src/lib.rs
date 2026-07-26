mod os;
mod reference;
mod secret;

pub use os::OsCredentialStore;
pub use reference::CredentialReference;
pub use secret::MAX_SECRET_BYTES;
pub use secret::SecretValue;

use std::error::Error;
use std::fmt;

pub const MODEL_TOKEN_CREDENTIAL_REFERENCE: &str = "model-api-token";

pub trait CredentialStore: fmt::Debug + Send + Sync {
    fn get(
        &self,
        reference: &CredentialReference,
    ) -> Result<Option<SecretValue>, CredentialStoreError>;

    fn set(
        &self,
        reference: &CredentialReference,
        secret: &SecretValue,
    ) -> Result<(), CredentialStoreError>;

    fn delete(&self, reference: &CredentialReference) -> Result<bool, CredentialStoreError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialStoreErrorKind {
    InvalidReference,
    EmptySecret,
    TooLarge,
    AccessUnavailable,
    BackendUnavailable,
    CorruptEntry,
    PlatformFailure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CredentialStoreError {
    kind: CredentialStoreErrorKind,
}

impl CredentialStoreError {
    pub const fn new(kind: CredentialStoreErrorKind) -> Self {
        Self { kind }
    }

    pub const fn kind(&self) -> CredentialStoreErrorKind {
        self.kind
    }
}

impl fmt::Display for CredentialStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self.kind {
            CredentialStoreErrorKind::InvalidReference => {
                "credential reference must be 1-64 lowercase ASCII letters, digits, or hyphens and start with a letter"
            }
            CredentialStoreErrorKind::EmptySecret => "credential secret must not be empty",
            CredentialStoreErrorKind::TooLarge => {
                "credential secret exceeds the 2048 byte limit"
            }
            CredentialStoreErrorKind::AccessUnavailable => {
                "credential store access is unavailable"
            }
            CredentialStoreErrorKind::BackendUnavailable => {
                "credential store backend is unavailable"
            }
            CredentialStoreErrorKind::CorruptEntry => {
                "stored credential is unreadable"
            }
            CredentialStoreErrorKind::PlatformFailure => {
                "credential store operation failed"
            }
        })
    }
}

impl Error for CredentialStoreError {}

#[cfg(test)]
#[path = "tests/mod.rs"]
mod tests;
