use crate::ModelError;
use crate::ModelErrorKind;
use sha2::Digest;
use sha2::Sha256;
use std::fmt;
use std::fs::File;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::sync::Arc;
use std::sync::Mutex;

pub const INLINE_PROVIDER_CONTEXT_BYTES: usize = 256 * 1024;
pub const MAX_PROVIDER_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_PROVIDER_CONTEXT_BYTES_PER_TURN: usize = 128 * 1024 * 1024;

#[derive(Clone)]
pub(crate) struct ProviderContextPayload {
    storage: ProviderContextStorage,
    len: usize,
    sha256: [u8; 32],
}

#[derive(Clone)]
enum ProviderContextStorage {
    Inline(Arc<[u8]>),
    AnonymousFile(Arc<Mutex<File>>),
}

impl ProviderContextPayload {
    pub(crate) fn new(bytes: Vec<u8>) -> Result<Self, ModelError> {
        if bytes.len() > MAX_PROVIDER_RESPONSE_BYTES {
            return Err(ModelError::new(
                ModelErrorKind::ProviderResponseTooLarge,
                false,
            ));
        }
        let len = bytes.len();
        let sha256: [u8; 32] = Sha256::digest(&bytes).into();
        let storage = if len <= INLINE_PROVIDER_CONTEXT_BYTES {
            ProviderContextStorage::Inline(bytes.into())
        } else {
            let mut file = tempfile::tempfile()
                .map_err(|_| ModelError::new(ModelErrorKind::ProviderResponseTooLarge, false))?;
            std::io::Write::write_all(&mut file, &bytes)
                .map_err(|_| ModelError::new(ModelErrorKind::ProviderResponseTooLarge, false))?;
            file.seek(SeekFrom::Start(0))
                .map_err(|_| ModelError::new(ModelErrorKind::ProviderResponseTooLarge, false))?;
            ProviderContextStorage::AnonymousFile(Arc::new(Mutex::new(file)))
        };
        Ok(Self {
            storage,
            len,
            sha256,
        })
    }

    pub(crate) const fn len(&self) -> usize {
        self.len
    }

    pub(crate) const fn sha256(&self) -> &[u8; 32] {
        &self.sha256
    }

    pub(crate) fn read(&self) -> Result<Vec<u8>, ModelError> {
        match &self.storage {
            ProviderContextStorage::Inline(bytes) => Ok(bytes.to_vec()),
            ProviderContextStorage::AnonymousFile(file) => {
                let mut file = file
                    .lock()
                    .map_err(|_| ModelError::new(ModelErrorKind::Protocol, false))?;
                file.seek(SeekFrom::Start(0))
                    .map_err(|_| ModelError::new(ModelErrorKind::Protocol, false))?;
                let mut bytes = Vec::with_capacity(self.len);
                file.read_to_end(&mut bytes)
                    .map_err(|_| ModelError::new(ModelErrorKind::Protocol, false))?;
                if bytes.len() != self.len
                    || <[u8; 32]>::from(Sha256::digest(&bytes)) != self.sha256
                {
                    return Err(ModelError::new(ModelErrorKind::Protocol, false));
                }
                Ok(bytes)
            }
        }
    }

    pub(crate) fn is_spilled(&self) -> bool {
        matches!(self.storage, ProviderContextStorage::AnonymousFile(_))
    }
}

impl PartialEq for ProviderContextPayload {
    fn eq(&self, other: &Self) -> bool {
        self.len == other.len && self.sha256 == other.sha256
    }
}

impl Eq for ProviderContextPayload {}

impl fmt::Debug for ProviderContextPayload {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderContextPayload")
            .field("bytes", &self.len)
            .field("spilled", &self.is_spilled())
            .field("content", &"<redacted>")
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spills_large_payload_and_replays_it_exactly() {
        let bytes = vec![0x5a; INLINE_PROVIDER_CONTEXT_BYTES + 1];
        let payload = ProviderContextPayload::new(bytes.clone()).expect("payload");
        assert!(payload.is_spilled());
        assert_eq!(payload.read().expect("replay"), bytes);
    }

    #[test]
    fn rejects_only_the_resource_safety_limit() {
        let error = ProviderContextPayload::new(vec![0; MAX_PROVIDER_RESPONSE_BYTES + 1])
            .expect_err("oversized provider response");
        assert_eq!(error.kind(), ModelErrorKind::ProviderResponseTooLarge);
    }
}
