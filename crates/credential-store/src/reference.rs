use crate::CredentialStoreError;
use crate::CredentialStoreErrorKind;
use std::fmt;

const MAX_REFERENCE_BYTES: usize = 64;

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct CredentialReference(String);

impl CredentialReference {
    pub fn parse(value: &str) -> Result<Self, CredentialStoreError> {
        let bytes = value.as_bytes();
        let valid = !bytes.is_empty()
            && bytes.len() <= MAX_REFERENCE_BYTES
            && bytes[0].is_ascii_lowercase()
            && bytes
                .iter()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-');
        if !valid {
            return Err(CredentialStoreError::new(
                CredentialStoreErrorKind::InvalidReference,
            ));
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for CredentialReference {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("CredentialReference")
            .field(&self.0)
            .finish()
    }
}
