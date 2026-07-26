use super::*;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use sugarcode_credential_store::CredentialStoreErrorKind;

#[derive(Default)]
struct MemoryCredentialStore {
    values: Mutex<HashMap<String, Zeroizing<Vec<u8>>>>,
    failure: Mutex<Option<CredentialStoreError>>,
}

impl fmt::Debug for MemoryCredentialStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MemoryCredentialStore([REDACTED])")
    }
}

impl MemoryCredentialStore {
    fn fail_with(&self, kind: CredentialStoreErrorKind) {
        *self.failure.lock().expect("failure lock") = Some(CredentialStoreError::new(kind));
    }

    fn take_failure(&self) -> Result<(), CredentialStoreError> {
        match self.failure.lock().expect("failure lock").take() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

impl CredentialStore for MemoryCredentialStore {
    fn get(
        &self,
        reference: &CredentialReference,
    ) -> Result<Option<SecretValue>, CredentialStoreError> {
        self.take_failure()?;
        self.values
            .lock()
            .expect("values lock")
            .get(reference.as_str())
            .map(|secret| SecretValue::new(secret.to_vec()))
            .transpose()
    }

    fn set(
        &self,
        reference: &CredentialReference,
        secret: &SecretValue,
    ) -> Result<(), CredentialStoreError> {
        self.take_failure()?;
        self.values.lock().expect("values lock").insert(
            reference.as_str().to_owned(),
            Zeroizing::new(secret.expose().to_vec()),
        );
        Ok(())
    }

    fn delete(&self, reference: &CredentialReference) -> Result<bool, CredentialStoreError> {
        self.take_failure()?;
        Ok(self
            .values
            .lock()
            .expect("values lock")
            .remove(reference.as_str())
            .is_some())
    }
}

fn run(
    action: CredentialAction,
    store: &dyn CredentialStore,
    input: &[u8],
) -> Result<String, CredentialCommandError> {
    let mut input = input;
    let mut output = Vec::new();
    run_credential_action(action, store, &mut input, false, &mut output)?;
    Ok(String::from_utf8(output).expect("UTF-8 output"))
}

#[test]
fn set_status_and_delete_use_the_injected_store_without_echoing_the_secret() {
    let store = MemoryCredentialStore::default();
    let sentinel = b"credential-secret-sentinel";

    let stored = run(
        CredentialAction::Set {
            reference: "default".into(),
            read_stdin: true,
        },
        &store,
        sentinel,
    )
    .expect("store credential");
    assert_eq!(stored, "Credential stored.\n");
    assert_eq!(format!("{store:?}"), "MemoryCredentialStore([REDACTED])");
    assert!(
        !stored
            .as_bytes()
            .windows(sentinel.len())
            .any(|part| part == sentinel)
    );

    assert_eq!(
        run(
            CredentialAction::Status {
                reference: "default".into(),
            },
            &store,
            &[],
        )
        .expect("credential status"),
        "Credential is present.\n"
    );
    assert_eq!(
        run(
            CredentialAction::Delete {
                reference: "default".into(),
            },
            &store,
            &[],
        )
        .expect("delete credential"),
        "Credential deleted.\n"
    );
    assert_eq!(
        run(
            CredentialAction::Status {
                reference: "default".into(),
            },
            &store,
            &[],
        )
        .expect("missing status"),
        "Credential is missing.\n"
    );
    assert_eq!(
        run(
            CredentialAction::Delete {
                reference: "default".into(),
            },
            &store,
            &[],
        )
        .expect("idempotent delete"),
        "Credential was not present.\n"
    );
}

#[test]
fn rejects_unmarked_interactive_empty_and_oversized_input() {
    let store = MemoryCredentialStore::default();
    let mut output = Vec::new();

    let unmarked = run_credential_action(
        CredentialAction::Set {
            reference: "default".into(),
            read_stdin: false,
        },
        &store,
        &mut &b"secret"[..],
        false,
        &mut output,
    )
    .expect_err("stdin marker required");
    assert_eq!(unmarked, CredentialCommandError::StdinRequired);

    let interactive = run_credential_action(
        CredentialAction::Set {
            reference: "default".into(),
            read_stdin: true,
        },
        &store,
        &mut &b"secret"[..],
        true,
        &mut output,
    )
    .expect_err("terminal input rejected");
    assert_eq!(
        interactive,
        CredentialCommandError::InteractiveInputRejected
    );

    let empty = run(
        CredentialAction::Set {
            reference: "default".into(),
            read_stdin: true,
        },
        &store,
        &[],
    )
    .expect_err("empty input");
    assert_eq!(
        empty,
        CredentialCommandError::Store(CredentialStoreError::new(
            CredentialStoreErrorKind::EmptySecret
        ))
    );

    let oversized = run(
        CredentialAction::Set {
            reference: "default".into(),
            read_stdin: true,
        },
        &store,
        &vec![b'x'; MAX_SECRET_BYTES + 1],
    )
    .expect_err("oversized input");
    assert_eq!(
        oversized,
        CredentialCommandError::Store(CredentialStoreError::new(
            CredentialStoreErrorKind::TooLarge
        ))
    );
}

#[test]
fn stable_errors_do_not_expose_secret_or_backend_details() {
    let store = MemoryCredentialStore::default();
    store.fail_with(CredentialStoreErrorKind::AccessUnavailable);
    let error = run(
        CredentialAction::Set {
            reference: "default".into(),
            read_stdin: true,
        },
        &store,
        b"error-secret-sentinel",
    )
    .expect_err("injected failure");
    assert_eq!(error.to_string(), "credential store access is unavailable");
    assert!(!format!("{error:?}").contains("sentinel"));
    assert!(std::error::Error::source(&error).is_none());
}

#[test]
fn credential_commands_do_not_write_secrets_into_ordinary_state() {
    let home = tempfile::tempdir().expect("temporary home");
    let config = home.path().join("config.toml");
    let rollout = home.path().join("rollouts/v1/thread.jsonl");
    let projection = home.path().join("projections/v1/thread-discovery.sqlite3");
    let search_projection = home.path().join("projections/v1/thread-search.sqlite3");
    fs::create_dir_all(rollout.parent().expect("rollout parent")).expect("rollout directory");
    fs::create_dir_all(projection.parent().expect("projection parent"))
        .expect("projection directory");
    fs::write(&config, "schema_version = 1\n").expect("config");
    fs::write(&rollout, b"safe rollout fixture\n").expect("rollout");
    fs::write(&projection, b"safe projection fixture").expect("projection");
    fs::write(&search_projection, b"safe search projection fixture").expect("search projection");

    let store = MemoryCredentialStore::default();
    let sentinel = b"ordinary-state-secret-sentinel";
    run(
        CredentialAction::Set {
            reference: "default".into(),
            read_stdin: true,
        },
        &store,
        sentinel,
    )
    .expect("store credential");

    for path in [&config, &rollout, &projection, &search_projection] {
        assert_file_does_not_contain(path, sentinel);
    }
}

fn assert_file_does_not_contain(path: &Path, sentinel: &[u8]) {
    let bytes = fs::read(path).expect("read fixture");
    assert!(
        !bytes.windows(sentinel.len()).any(|part| part == sentinel),
        "{} contained the secret sentinel",
        path.display()
    );
}
