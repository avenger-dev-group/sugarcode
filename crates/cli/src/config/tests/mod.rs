use super::*;
use std::collections::BTreeMap;
use std::sync::Mutex;
use sugarcode_credential_store::CredentialStoreError;
use sugarcode_state::HomeResolutionInputs;

#[derive(Debug, Default)]
struct MemoryCredentialStore {
    values: Mutex<BTreeMap<String, Vec<u8>>>,
}

impl CredentialStore for MemoryCredentialStore {
    fn get(
        &self,
        reference: &CredentialReference,
    ) -> Result<Option<SecretValue>, CredentialStoreError> {
        self.values
            .lock()
            .expect("credential lock")
            .get(reference.as_str())
            .cloned()
            .map(SecretValue::new)
            .transpose()
    }

    fn set(
        &self,
        reference: &CredentialReference,
        secret: &SecretValue,
    ) -> Result<(), CredentialStoreError> {
        self.values
            .lock()
            .expect("credential lock")
            .insert(reference.as_str().to_string(), secret.expose().to_vec());
        Ok(())
    }

    fn delete(&self, reference: &CredentialReference) -> Result<bool, CredentialStoreError> {
        Ok(self
            .values
            .lock()
            .expect("credential lock")
            .remove(reference.as_str())
            .is_some())
    }
}

#[test]
fn model_set_routes_token_to_store_and_only_reference_to_toml() {
    let directory = tempfile::tempdir().expect("home");
    let home = sugarcode_state::resolve_sugarcode_home(HomeResolutionInputs {
        cli_override: Some(directory.path().to_path_buf()),
        ..Default::default()
    })
    .expect("resolved home");
    let store = MemoryCredentialStore::default();
    let sentinel = "credential-secret-sentinel";
    let input = serde_json::to_vec(&serde_json::json!({
        "apiFormat": "openai-chat-completions",
        "endpoint": "http://127.0.0.1:18080/v1/chat/completions",
        "model": "fixture-model",
        "token": sentinel
    }))
    .expect("input JSON");
    let mut output = Vec::new();
    set_model_config(&home, &store, &mut input.as_slice(), &mut output).expect("set model");

    assert_eq!(output, b"Model configuration saved.\n");
    assert_eq!(
        store
            .values
            .lock()
            .expect("credential lock")
            .get(MODEL_TOKEN_CREDENTIAL_REFERENCE)
            .map(Vec::as_slice),
        Some(sentinel.as_bytes())
    );
    let stored =
        std::fs::read_to_string(directory.path().join("config.toml")).expect("config TOML");
    assert!(stored.contains("credential = \"model-api-token\""));
    assert!(!stored.contains(sentinel));
    assert!(!stored.contains("token ="));
}

#[test]
fn model_token_validation_happens_before_store_mutation() {
    let directory = tempfile::tempdir().expect("home");
    let home = sugarcode_state::resolve_sugarcode_home(HomeResolutionInputs {
        cli_override: Some(directory.path().to_path_buf()),
        ..Default::default()
    })
    .expect("resolved home");
    let store = MemoryCredentialStore::default();
    for token in [
        "contains space".to_string(),
        "contains\nnewline".to_string(),
        "a".repeat(MAX_SECRET_BYTES + 1),
    ] {
        let input = serde_json::to_vec(&serde_json::json!({
            "apiFormat": "openai-chat-completions",
            "endpoint": "http://127.0.0.1:18080/v1/chat/completions",
            "model": "fixture-model",
            "token": token
        }))
        .expect("input JSON");
        assert_eq!(
            set_model_config(&home, &store, &mut input.as_slice(), &mut Vec::new()),
            Err(ModelConfigCommandError::InvalidConfiguration)
        );
    }
    assert!(store.values.lock().expect("credential lock").is_empty());
}
