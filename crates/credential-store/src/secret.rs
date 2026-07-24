use crate::CredentialStoreError;
use crate::CredentialStoreErrorKind;
use std::fmt;
use zeroize::Zeroizing;

pub const MAX_SECRET_BYTES: usize = 2 * 1024;

pub struct SecretValue(Zeroizing<Vec<u8>>);

impl SecretValue {
    pub fn new(bytes: Vec<u8>) -> Result<Self, CredentialStoreError> {
        Self::from_zeroizing(Zeroizing::new(bytes))
    }

    pub fn from_zeroizing(bytes: Zeroizing<Vec<u8>>) -> Result<Self, CredentialStoreError> {
        if bytes.is_empty() {
            return Err(CredentialStoreError::new(
                CredentialStoreErrorKind::EmptySecret,
            ));
        }
        if bytes.len() > MAX_SECRET_BYTES {
            return Err(CredentialStoreError::new(
                CredentialStoreErrorKind::TooLarge,
            ));
        }
        Ok(Self(bytes))
    }

    pub fn expose(&self) -> &[u8] {
        self.0.as_slice()
    }
}

impl fmt::Debug for SecretValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretValue([REDACTED])")
    }
}
