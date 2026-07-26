use crate::CredentialReference;
use crate::CredentialStoreErrorKind;
use crate::MAX_SECRET_BYTES;
use crate::OsCredentialStore;
use crate::SecretValue;
use crate::os::map_keyring_error;
use keyring::Error as KeyringError;
use std::io;
use std::path::Path;
use zeroize::Zeroizing;

#[test]
fn validates_non_secret_logical_references() {
    for valid in ["default", "provider-1", "a", &"a".repeat(64)] {
        let reference = CredentialReference::parse(valid).expect("valid reference");
        assert_eq!(reference.as_str(), valid);
    }

    for invalid in [
        "",
        "1default",
        "Uppercase",
        "contains_underscore",
        "contains.dot",
        &"a".repeat(65),
    ] {
        let error = CredentialReference::parse(invalid).expect_err("invalid reference");
        assert_eq!(error.kind(), CredentialStoreErrorKind::InvalidReference);
    }
}

#[test]
fn bounds_binary_secret_values_and_redacts_debug_output() {
    let binary = vec![0xff, 0xfe, 0xfd];
    let secret = SecretValue::new(binary.clone()).expect("binary secret");
    assert_eq!(secret.expose(), binary);
    assert_eq!(format!("{secret:?}"), "SecretValue([REDACTED])");

    let empty = SecretValue::new(Vec::new()).expect_err("empty secret");
    assert_eq!(empty.kind(), CredentialStoreErrorKind::EmptySecret);

    let oversized =
        SecretValue::new(vec![b'x'; MAX_SECRET_BYTES + 1]).expect_err("oversized secret");
    assert_eq!(oversized.kind(), CredentialStoreErrorKind::TooLarge);
}

#[test]
fn accepts_caller_owned_zeroizing_buffers_without_copying() {
    let bytes = Zeroizing::new(vec![b's'; MAX_SECRET_BYTES]);
    let secret = SecretValue::from_zeroizing(bytes).expect("bounded secret");
    assert_eq!(secret.expose().len(), MAX_SECRET_BYTES);
}

#[test]
fn derives_a_stable_home_namespace_without_exposing_it_in_debug() {
    let first = OsCredentialStore::new(Path::new("/tmp/sugarcode-home"));
    let second = OsCredentialStore::new(Path::new("/tmp/sugarcode-home"));
    let other = OsCredentialStore::new(Path::new("/tmp/other-home"));
    let reference = CredentialReference::parse("default").expect("reference");
    let account = first.account_for_test(&reference);
    assert_eq!(account, second.account_for_test(&reference));
    assert_ne!(account, other.account_for_test(&reference));
    assert!(account.ends_with(":default"));
    assert!(!account.contains("/tmp/sugarcode-home"));
    assert_eq!(format!("{first:?}"), "OsCredentialStore");
    assert_eq!(format!("{second:?}"), "OsCredentialStore");
}

#[test]
fn discards_secret_bearing_keyring_error_payloads() {
    let sentinel = b"keyring-error-secret-sentinel".to_vec();
    let platform: Box<dyn std::error::Error + Send + Sync> =
        Box::new(io::Error::other("safe platform marker"));
    let error = map_keyring_error(KeyringError::BadDataFormat(sentinel, platform));
    assert_eq!(error.kind(), CredentialStoreErrorKind::CorruptEntry);
    assert!(!format!("{error}").contains("sentinel"));
    assert!(!format!("{error:?}").contains("sentinel"));
    assert!(std::error::Error::source(&error).is_none());
}

#[test]
fn normalizes_keyring_failures_without_platform_details() {
    let access: Box<dyn std::error::Error + Send + Sync> =
        Box::new(io::Error::other("secret platform detail"));
    let access = map_keyring_error(KeyringError::NoStorageAccess(access));
    assert_eq!(access.kind(), CredentialStoreErrorKind::AccessUnavailable);
    assert_eq!(access.to_string(), "credential store access is unavailable");

    let unavailable = map_keyring_error(KeyringError::NoDefaultStore);
    assert_eq!(
        unavailable.kind(),
        CredentialStoreErrorKind::BackendUnavailable
    );

    let too_large = map_keyring_error(KeyringError::TooLong("backend-field-sentinel".into(), 10));
    assert_eq!(too_large.kind(), CredentialStoreErrorKind::TooLarge);
    assert!(!too_large.to_string().contains("backend-field-sentinel"));
}
