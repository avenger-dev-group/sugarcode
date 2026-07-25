use std::fs;
use sugarcode_state::CURRENT_CONFIG_SCHEMA_VERSION;
use sugarcode_state::ConfigError;
use sugarcode_state::HomeResolutionInputs;
use sugarcode_state::MAX_CONFIG_BYTES;
use sugarcode_state::MAX_CREDENTIAL_REFERENCE_BYTES;
use sugarcode_state::ModelApiFormat;
use sugarcode_state::ModelConfig;
use sugarcode_state::load_effective_config_for_home;
use sugarcode_state::resolve_sugarcode_home;
use sugarcode_state::save_model_config;
use tempfile::tempdir;
use url::Url;

fn resolved_home() -> (tempfile::TempDir, sugarcode_state::SugarCodeHome) {
    let directory = tempdir().expect("home");
    let home = resolve_sugarcode_home(HomeResolutionInputs {
        cli_override: Some(directory.path().to_path_buf()),
        ..Default::default()
    })
    .expect("resolve home");
    (directory, home)
}

#[test]
fn missing_empty_and_explicit_v1_config_use_v1() {
    let (directory, home) = resolved_home();
    let missing = load_effective_config_for_home(home.clone()).expect("missing config");
    assert_eq!(missing.schema_version(), CURRENT_CONFIG_SCHEMA_VERSION);
    assert!(!missing.config_path().exists());

    fs::write(directory.path().join("config.toml"), "").expect("write empty config");
    let empty = load_effective_config_for_home(home.clone()).expect("empty config");
    assert_eq!(empty.schema_version(), CURRENT_CONFIG_SCHEMA_VERSION);

    fs::write(directory.path().join("config.toml"), "schema_version = 1\n")
        .expect("write v1 config");
    let explicit = load_effective_config_for_home(home).expect("v1 config");
    assert_eq!(explicit.schema_version(), CURRENT_CONFIG_SCHEMA_VERSION);
}

#[test]
fn invalid_unknown_and_unsupported_config_are_safe_errors() {
    let (directory, home) = resolved_home();
    let config = directory.path().join("config.toml");

    fs::write(&config, "schema_version = [\n").expect("write invalid TOML");
    let invalid = load_effective_config_for_home(home.clone()).expect_err("invalid TOML");
    assert!(matches!(invalid, ConfigError::InvalidToml { .. }));

    let sentinel = "do-not-leak-this-secret";
    fs::write(&config, format!("api_key = \"{sentinel}\"\n")).expect("write unknown config");
    let unknown = load_effective_config_for_home(home.clone()).expect_err("unknown field");
    assert!(matches!(unknown, ConfigError::UnknownField { .. }));
    assert!(!unknown.to_string().contains(sentinel));

    fs::write(&config, "schema_version = 2\n").expect("write future config");
    let unsupported = load_effective_config_for_home(home).expect_err("future version");
    assert!(matches!(
        unsupported,
        ConfigError::UnsupportedSchemaVersion { version: 2, .. }
    ));
}

#[test]
fn invalid_encoding_non_file_and_oversize_are_rejected() {
    let (directory, home) = resolved_home();
    let config = directory.path().join("config.toml");

    fs::write(&config, [0xff]).expect("write invalid UTF-8");
    assert!(matches!(
        load_effective_config_for_home(home.clone()),
        Err(ConfigError::InvalidUtf8 { .. })
    ));

    fs::remove_file(&config).expect("remove config");
    fs::create_dir(&config).expect("create config directory");
    assert!(matches!(
        load_effective_config_for_home(home.clone()),
        Err(ConfigError::NotRegularFile { .. })
    ));

    fs::remove_dir(&config).expect("remove config directory");
    fs::write(&config, vec![b' '; MAX_CONFIG_BYTES as usize + 1]).expect("write large config");
    assert!(matches!(
        load_effective_config_for_home(home),
        Err(ConfigError::TooLarge { .. })
    ));
}

#[cfg(unix)]
#[test]
fn config_symlink_to_regular_file_is_rejected() {
    use std::os::unix::fs::symlink;

    let (directory, home) = resolved_home();
    let target = directory.path().join("shared.toml");
    fs::write(&target, "schema_version = 1\n").expect("write target");
    symlink(&target, directory.path().join("config.toml")).expect("create config symlink");

    assert!(matches!(
        load_effective_config_for_home(home),
        Err(ConfigError::NotRegularFile { .. })
    ));
}

#[cfg(unix)]
#[test]
fn saving_model_config_refuses_to_replace_a_symlink() {
    use std::os::unix::fs::symlink;

    let (directory, home) = resolved_home();
    let target = directory.path().join("shared.toml");
    let sentinel = "do-not-overwrite";
    fs::write(&target, sentinel).expect("write target");
    symlink(&target, directory.path().join("config.toml")).expect("create config symlink");
    let model = ModelConfig::new(
        ModelApiFormat::OpenAiChatCompletions,
        Url::parse("https://example.com/v1/chat/completions").expect("URL"),
        "fixture-model".to_string(),
        None,
    )
    .expect("model config");

    assert!(matches!(
        save_model_config(&home, &model),
        Err(ConfigError::NotRegularFile { .. })
    ));
    assert_eq!(fs::read_to_string(target).expect("read target"), sentinel);
}

#[test]
fn model_endpoint_requires_https_except_for_exact_loopback_hosts() {
    for endpoint in [
        "https://example.com/v1/chat/completions",
        "http://localhost:18080/v1/chat/completions",
        "http://127.0.0.1:18080/v1/chat/completions",
        "http://[::1]:18080/v1/chat/completions",
    ] {
        ModelConfig::new(
            ModelApiFormat::OpenAiChatCompletions,
            Url::parse(endpoint).expect("URL"),
            "fixture-model".to_string(),
            None,
        )
        .expect("safe endpoint");
    }

    for endpoint in [
        "http://example.com/v1/chat/completions",
        "http://localhost.example/v1/chat/completions",
        "https://user@example.com/v1/chat/completions",
        "https://example.com/v1/chat/completions?debug=true",
        "https://example.com/v1/chat/completions#fragment",
        "https://example.com/v1/responses",
    ] {
        assert!(
            ModelConfig::new(
                ModelApiFormat::OpenAiChatCompletions,
                Url::parse(endpoint).expect("URL"),
                "fixture-model".to_string(),
                None,
            )
            .is_err(),
            "{endpoint} must be rejected"
        );
    }
}

#[test]
fn model_config_accepts_only_non_secret_credential_references() {
    for reference in [
        "model-api-token",
        "a",
        &"a".repeat(MAX_CREDENTIAL_REFERENCE_BYTES),
    ] {
        let model = ModelConfig::new(
            ModelApiFormat::OpenAiChatCompletions,
            Url::parse("https://example.com/v1/chat/completions").expect("URL"),
            "fixture-model".to_string(),
            Some(reference.to_string()),
        )
        .expect("credential reference");
        assert_eq!(model.credential_reference(), Some(reference));
    }
    for invalid in [
        String::new(),
        "Uppercase".to_string(),
        "contains_underscore".to_string(),
        "a".repeat(MAX_CREDENTIAL_REFERENCE_BYTES + 1),
    ] {
        assert!(
            ModelConfig::new(
                ModelApiFormat::OpenAiChatCompletions,
                Url::parse("https://example.com/v1/chat/completions").expect("URL"),
                "fixture-model".to_string(),
                Some(invalid),
            )
            .is_err()
        );
    }
}

#[test]
fn model_config_persists_only_the_non_secret_credential_reference() {
    let (directory, home) = resolved_home();
    let model = ModelConfig::new(
        ModelApiFormat::OpenAiChatCompletions,
        Url::parse("https://example.com/v1/chat/completions").expect("URL"),
        "fixture-model".to_string(),
        Some("model-api-token".to_string()),
    )
    .expect("model config");
    let config = save_model_config(&home, &model).expect("save config");
    assert_eq!(
        config.model().and_then(ModelConfig::credential_reference),
        Some("model-api-token")
    );
    let stored = fs::read_to_string(directory.path().join("config.toml")).expect("stored config");
    assert!(stored.contains("credential = \"model-api-token\""));
    assert!(!stored.contains("token ="));
}

#[test]
fn saving_model_config_atomically_replaces_an_existing_regular_file() {
    let (directory, home) = resolved_home();
    let first = ModelConfig::new(
        ModelApiFormat::OpenAiChatCompletions,
        Url::parse("https://first.example/v1/chat/completions").expect("URL"),
        "first-model".to_string(),
        None,
    )
    .expect("first model config");
    save_model_config(&home, &first).expect("initial save");

    let replacement = ModelConfig::new(
        ModelApiFormat::OpenAiChatCompletions,
        Url::parse("https://second.example/v1/chat/completions").expect("URL"),
        "second-model".to_string(),
        Some("model-api-token".to_string()),
    )
    .expect("replacement model config");
    let loaded = save_model_config(&home, &replacement).expect("replacement save");

    let model = loaded.model().expect("saved model");
    assert_eq!(model.endpoint(), replacement.endpoint());
    assert_eq!(model.model(), "second-model");
    assert_eq!(model.credential_reference(), Some("model-api-token"));
    let entries = fs::read_dir(directory.path())
        .expect("read home")
        .map(|entry| entry.expect("home entry").file_name())
        .collect::<Vec<_>>();
    assert_eq!(entries, vec![std::ffi::OsString::from("config.toml")]);
}

#[test]
fn legacy_plaintext_model_token_is_rejected_without_echoing_it() {
    let (directory, home) = resolved_home();
    let sentinel = "do-not-leak-legacy-token";
    fs::write(
        directory.path().join("config.toml"),
        format!(
            "schema_version = 1\n\
             [model]\n\
             api_format = \"openai-chat-completions\"\n\
             endpoint = \"https://example.com/v1/chat/completions\"\n\
             model = \"fixture-model\"\n\
             token = \"{sentinel}\"\n"
        ),
    )
    .expect("write legacy config");

    let error = load_effective_config_for_home(home).expect_err("plaintext token is unknown");
    assert!(matches!(error, ConfigError::UnknownField { .. }));
    assert!(!error.to_string().contains(sentinel));
}
