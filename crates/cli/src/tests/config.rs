use super::*;
use std::collections::BTreeMap;
use std::sync::Mutex;
use sugarcode_credential_store::CredentialStoreError;
use sugarcode_state::HomeResolutionInputs;

#[derive(Debug, Default)]
struct MemoryCredentialStore {
    values: Mutex<BTreeMap<String, Vec<u8>>>,
    unavailable: bool,
}

impl CredentialStore for MemoryCredentialStore {
    fn get(
        &self,
        reference: &CredentialReference,
    ) -> Result<Option<SecretValue>, CredentialStoreError> {
        if self.unavailable {
            return Err(CredentialStoreError::new(
                CredentialStoreErrorKind::AccessUnavailable,
            ));
        }
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

fn resolved_home(directory: &tempfile::TempDir) -> SugarCodeHome {
    sugarcode_state::resolve_sugarcode_home(HomeResolutionInputs {
        cli_override: Some(directory.path().to_path_buf()),
        ..Default::default()
    })
    .expect("resolved home")
}

fn config_value(reference: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "apiFormat": "openai-chat-completions",
        "endpoint": "http://127.0.0.1:18080/v1/chat/completions",
        "model": "fixture-model",
        "credentialReference": reference
    })
}

#[test]
fn validation_is_strict_and_returns_the_rust_owned_shape() {
    let input = serde_json::to_vec(&serde_json::json!({
        "contractVersion": 1,
        "config": config_value(Some("model-api-token"))
    }))
    .expect("input");
    let mut output = Vec::new();
    validate_model_config(&mut input.as_slice(), &mut output).expect("validate");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output).expect("JSON"),
        serde_json::json!({
            "contractVersion": 1,
            "valid": true,
            "config": config_value(Some("model-api-token"))
        })
    );

    let mut unknown = br#"{"contractVersion":1,"config":{"apiFormat":"openai-chat-completions","endpoint":"http://127.0.0.1:18080/v1/chat/completions","model":"fixture-model","credentialReference":null,"token":"secret"}}"#.as_slice();
    assert_eq!(
        validate_model_config(&mut unknown, &mut Vec::new()),
        Err(ModelConfigCommandError::InvalidInput)
    );
}

#[test]
fn set_requires_revision_preserves_mcp_and_never_accepts_a_token() {
    let directory = tempfile::tempdir().expect("home");
    std::fs::write(
        directory.path().join("config.toml"),
        format!(
            "schema_version = 1\n\n[[mcp.servers]]\nid = \"local\"\ntransport = \"stdio\"\nexecutable = {:?}\ncwd = {:?}\nargv = []\n",
            std::env::current_exe().expect("executable"),
            directory.path()
        ),
    )
    .expect("config");
    let home = resolved_home(&directory);
    let store = MemoryCredentialStore::default();
    let current = sugarcode_state::load_effective_config_for_home(home.clone()).expect("current");
    let revision = config_revision(current.model());
    let sentinel = "credential-secret-sentinel";
    let input = serde_json::to_vec(&serde_json::json!({
        "contractVersion": 1,
        "expectedRevision": revision,
        "config": config_value(Some("model-api-token"))
    }))
    .expect("input");
    let mut output = Vec::new();
    set_model_config(&home, &store, &mut input.as_slice(), &mut output).expect("set");
    let receipt = serde_json::from_slice::<serde_json::Value>(&output).expect("receipt JSON");
    assert_eq!(receipt["contractVersion"], 1);
    assert_eq!(receipt["credentialStatus"], "missing");
    let stored =
        std::fs::read_to_string(directory.path().join("config.toml")).expect("config TOML");
    assert!(stored.contains("[[mcp.servers]]"));
    assert!(stored.contains("credential = \"model-api-token\""));
    assert!(!stored.contains(sentinel));
    assert!(!stored.contains("token ="));

    let stale = serde_json::to_vec(&serde_json::json!({
        "contractVersion": 1,
        "expectedRevision": "0".repeat(64),
        "config": config_value(None)
    }))
    .expect("input");
    assert_eq!(
        set_model_config(&home, &store, &mut stale.as_slice(), &mut Vec::new()),
        Err(ModelConfigCommandError::RevisionMismatch)
    );
}

#[test]
fn model_credential_is_bounded_header_safe_and_redacted() {
    let store = MemoryCredentialStore::default();
    let sentinel = b"credential-secret-sentinel";
    let mut output = Vec::new();
    set_model_credential(
        &store,
        "model-api-token",
        &mut sentinel.as_slice(),
        &mut output,
    )
    .expect("set credential");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output).expect("JSON"),
        serde_json::json!({
            "contractVersion": 1,
            "reference": "model-api-token",
            "status": "present"
        })
    );
    assert!(
        !String::from_utf8(output)
            .expect("UTF-8")
            .contains("sentinel")
    );
    for invalid in [
        Vec::new(),
        b"contains space".to_vec(),
        b"contains\nnewline".to_vec(),
        vec![b'a'; MAX_SECRET_BYTES + 1],
    ] {
        assert_eq!(
            set_model_credential(
                &store,
                "model-api-token",
                &mut invalid.as_slice(),
                &mut Vec::new()
            ),
            Err(ModelConfigCommandError::InvalidConfiguration)
        );
    }
}

#[test]
fn inspect_reports_unavailable_without_backend_details() {
    let directory = tempfile::tempdir().expect("home");
    let home = resolved_home(&directory);
    let initial =
        sugarcode_state::load_effective_config_for_home(home.clone()).expect("initial config");
    let model = parse_model(ModelConfigInput {
        api_format: "openai-chat-completions".to_string(),
        endpoint: "http://127.0.0.1:18080/v1/chat/completions".to_string(),
        model: "fixture-model".to_string(),
        credential_reference: Some("model-api-token".to_string()),
    })
    .expect("model");
    sugarcode_state::save_model_config(&home, &model).expect("save");
    assert!(initial.model().is_none());
    let store = MemoryCredentialStore {
        unavailable: true,
        ..Default::default()
    };
    let mut output = Vec::new();
    inspect_model_config(&home, &store, &mut output).expect("inspect");
    let text = String::from_utf8(output).expect("UTF-8");
    assert!(text.contains("\"credentialStatus\":\"unavailable\""));
    assert!(!text.contains("AccessUnavailable"));
    assert!(!text.contains("backend"));
}

#[test]
fn delete_receipt_is_idempotent() {
    let store = MemoryCredentialStore::default();
    let mut first = Vec::new();
    delete_model_credential(&store, "model-api-token", &mut first).expect("delete");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&first).expect("JSON"),
        serde_json::json!({
            "contractVersion": 1,
            "reference": "model-api-token",
            "status": "missing",
            "deleted": false
        })
    );
}

#[test]
fn mcp_inventory_is_sorted_and_redacted() {
    let directory = tempfile::tempdir().expect("home");
    std::fs::write(
        directory.path().join("config.toml"),
        format!(
            "schema_version = 1\n\n[[mcp.servers]]\nid = \"zeta\"\ntransport = \"streamable-http\"\nendpoint = \"http://127.0.0.1:8080/private\"\n\n[[mcp.servers]]\nid = \"alpha\"\ntransport = \"stdio\"\nexecutable = {:?}\ncwd = {:?}\nargv = [\"secret-argument\"]\n",
            std::env::current_exe().expect("executable"),
            directory.path()
        ),
    )
    .expect("config");
    let config = sugarcode_state::load_effective_config(Some(directory.path().to_path_buf()))
        .expect("effective config");
    let mut output = Vec::new();
    list_mcp_servers(&config, &mut output).expect("inventory");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output).expect("JSON"),
        serde_json::json!({
            "servers": [
                {"id": "alpha", "transport": "stdio"},
                {"id": "zeta", "transport": "loopbackStreamableHttp"}
            ]
        })
    );
    let output = String::from_utf8(output).expect("UTF-8");
    assert!(!output.contains("secret-argument"));
    assert!(!output.contains("private"));
}

#[test]
fn mcp_management_validates_replaces_and_preserves_model_configuration() {
    let directory = tempfile::tempdir().expect("home");
    let home = resolved_home(&directory);
    let model = parse_model(ModelConfigInput {
        api_format: "openai-chat-completions".to_string(),
        endpoint: "http://127.0.0.1:18080/v1/chat/completions".to_string(),
        model: "fixture-model".to_string(),
        credential_reference: Some("model-api-token".to_string()),
    })
    .expect("model");
    sugarcode_state::save_model_config(&home, &model).expect("save model");

    let servers = serde_json::json!([
        {
            "id": "zeta",
            "transport": "loopbackStreamableHttp",
            "endpoint": "http://127.0.0.1:8080/mcp"
        },
        {
            "id": "alpha",
            "transport": "stdio",
            "executable": std::env::current_exe().expect("executable"),
            "argv": ["--stdio", "exact argument"],
            "cwd": directory.path()
        }
    ]);
    let validation = serde_json::to_vec(&serde_json::json!({
        "contractVersion": 1,
        "servers": servers
    }))
    .expect("validation input");
    let mut validation_output = Vec::new();
    validate_mcp_config(&mut validation.as_slice(), &mut validation_output).expect("validate MCP");
    let validation_receipt =
        serde_json::from_slice::<serde_json::Value>(&validation_output).expect("receipt");
    assert_eq!(validation_receipt["valid"], true);
    assert_eq!(validation_receipt["servers"][0]["id"], "alpha");
    assert_eq!(validation_receipt["servers"][1]["id"], "zeta");
    let initial = sugarcode_state::load_effective_config_for_home(home.clone())
        .expect("initial configuration");
    let input = serde_json::to_vec(&serde_json::json!({
        "contractVersion": 1,
        "expectedRevision": mcp_config_revision(initial.mcp_servers()),
        "servers": servers
    }))
    .expect("set input");
    let mut output = Vec::new();
    set_mcp_config(&home, &mut input.as_slice(), &mut output).expect("set MCP");
    let receipt = serde_json::from_slice::<serde_json::Value>(&output).expect("set receipt");
    assert_eq!(receipt["contractVersion"], 1);
    assert_eq!(receipt["servers"][0]["id"], "alpha");
    let stored = sugarcode_state::load_effective_config_for_home(home.clone())
        .expect("stored configuration");
    assert_eq!(stored.mcp_servers().len(), 2);
    assert_eq!(
        stored.model().expect("preserved model").model(),
        "fixture-model"
    );

    let stale = serde_json::to_vec(&serde_json::json!({
        "contractVersion": 1,
        "expectedRevision": "0".repeat(64),
        "servers": []
    }))
    .expect("stale input");
    assert_eq!(
        set_mcp_config(&home, &mut stale.as_slice(), &mut Vec::new()),
        Err(McpConfigCommandError::RevisionMismatch)
    );

    let delete_all = serde_json::to_vec(&serde_json::json!({
        "contractVersion": 1,
        "expectedRevision": receipt["revision"],
        "servers": []
    }))
    .expect("delete input");
    set_mcp_config(&home, &mut delete_all.as_slice(), &mut Vec::new())
        .expect("delete all MCP servers");
    let stored =
        sugarcode_state::load_effective_config_for_home(home).expect("configuration after delete");
    assert!(stored.mcp_servers().is_empty());
    assert_eq!(
        stored.model().expect("model retained after delete").model(),
        "fixture-model"
    );
}

#[test]
fn mcp_management_rejects_duplicate_ids_and_remote_http() {
    for servers in [
        serde_json::json!([
            {
                "id": "duplicate",
                "transport": "loopbackStreamableHttp",
                "endpoint": "http://127.0.0.1:8080/one"
            },
            {
                "id": "duplicate",
                "transport": "loopbackStreamableHttp",
                "endpoint": "http://127.0.0.1:8081/two"
            }
        ]),
        serde_json::json!([
            {
                "id": "remote",
                "transport": "loopbackStreamableHttp",
                "endpoint": "https://example.com/mcp"
            }
        ]),
    ] {
        let input = serde_json::to_vec(&serde_json::json!({
            "contractVersion": 1,
            "servers": servers
        }))
        .expect("input");
        assert_eq!(
            validate_mcp_config(&mut input.as_slice(), &mut Vec::new()),
            Err(McpConfigCommandError::InvalidConfiguration)
        );
    }
}
