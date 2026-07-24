use crate::CredentialReference;
use crate::CredentialStore;
use crate::CredentialStoreError;
use crate::CredentialStoreErrorKind;
use crate::SecretValue;
use keyring::Entry;
use keyring::Error as KeyringError;
use sha2::Digest;
use sha2::Sha256;
use std::fmt;
use std::path::Path;

const KEYRING_SERVICE: &str = "dev.sugarcode.credentials.v1";

pub struct OsCredentialStore {
    home_namespace: String,
}

impl OsCredentialStore {
    pub fn new(home: &Path) -> Self {
        Self {
            home_namespace: home_namespace(home),
        }
    }

    fn account(&self, reference: &CredentialReference) -> String {
        format!("home:{}:{}", self.home_namespace, reference.as_str())
    }

    fn entry(&self, reference: &CredentialReference) -> Result<Entry, CredentialStoreError> {
        ensure_backend_session()?;
        let account = self.account(reference);
        Entry::new(KEYRING_SERVICE, &account).map_err(map_keyring_error)
    }

    #[cfg(test)]
    pub(crate) fn account_for_test(&self, reference: &CredentialReference) -> String {
        self.account(reference)
    }
}

impl fmt::Debug for OsCredentialStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OsCredentialStore")
    }
}

impl CredentialStore for OsCredentialStore {
    fn get(
        &self,
        reference: &CredentialReference,
    ) -> Result<Option<SecretValue>, CredentialStoreError> {
        match self.entry(reference)?.get_secret() {
            Ok(secret) => SecretValue::new(secret).map(Some),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(map_keyring_error(error)),
        }
    }

    fn set(
        &self,
        reference: &CredentialReference,
        secret: &SecretValue,
    ) -> Result<(), CredentialStoreError> {
        self.entry(reference)?
            .set_secret(secret.expose())
            .map_err(map_keyring_error)
    }

    fn delete(&self, reference: &CredentialReference) -> Result<bool, CredentialStoreError> {
        match self.entry(reference)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(KeyringError::NoEntry) => Ok(false),
            Err(error) => Err(map_keyring_error(error)),
        }
    }
}

fn home_namespace(home: &Path) -> String {
    let mut hasher = Sha256::new();
    update_hasher_with_path(&mut hasher, home);
    format!("{:x}", hasher.finalize())
}

#[cfg(unix)]
fn update_hasher_with_path(hasher: &mut Sha256, path: &Path) {
    use std::os::unix::ffi::OsStrExt;
    hasher.update(path.as_os_str().as_bytes());
}

#[cfg(windows)]
fn update_hasher_with_path(hasher: &mut Sha256, path: &Path) {
    use std::os::windows::ffi::OsStrExt;
    for unit in path.as_os_str().encode_wide() {
        hasher.update(unit.to_le_bytes());
    }
}

#[cfg(not(any(unix, windows)))]
fn update_hasher_with_path(hasher: &mut Sha256, path: &Path) {
    hasher.update(path.as_os_str().to_string_lossy().as_bytes());
}

#[cfg(target_os = "linux")]
fn ensure_backend_session() -> Result<(), CredentialStoreError> {
    let has_session_address =
        std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some_and(|value| !value.is_empty());
    let has_runtime_directory =
        std::env::var_os("XDG_RUNTIME_DIR").is_some_and(|value| !value.is_empty());
    if has_session_address || has_runtime_directory {
        Ok(())
    } else {
        Err(CredentialStoreError::new(
            CredentialStoreErrorKind::BackendUnavailable,
        ))
    }
}

#[cfg(not(target_os = "linux"))]
fn ensure_backend_session() -> Result<(), CredentialStoreError> {
    Ok(())
}

pub(crate) fn map_keyring_error(error: KeyringError) -> CredentialStoreError {
    let kind = match error {
        KeyringError::NoEntry => CredentialStoreErrorKind::PlatformFailure,
        KeyringError::NoStorageAccess(_) => CredentialStoreErrorKind::AccessUnavailable,
        KeyringError::BadEncoding(_)
        | KeyringError::BadDataFormat(_, _)
        | KeyringError::BadStoreFormat(_)
        | KeyringError::Ambiguous(_) => CredentialStoreErrorKind::CorruptEntry,
        KeyringError::TooLong(_, _) => CredentialStoreErrorKind::TooLarge,
        KeyringError::NoDefaultStore | KeyringError::NotSupportedByStore(_) => {
            CredentialStoreErrorKind::BackendUnavailable
        }
        KeyringError::PlatformFailure(_) | KeyringError::Invalid(_, _) => {
            CredentialStoreErrorKind::PlatformFailure
        }
        _ => CredentialStoreErrorKind::PlatformFailure,
    };
    CredentialStoreError::new(kind)
}
