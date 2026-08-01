use std::fs;
use sugarcode_state::CURRENT_CONFIG_SCHEMA_VERSION;
use sugarcode_state::ConfigError;
use sugarcode_state::HomeResolutionInputs;
use sugarcode_state::MAX_CONFIG_BYTES;
use sugarcode_state::MAX_MODEL_API_KEY_BYTES;
use sugarcode_state::MAX_MODEL_CONTEXT_WINDOW_TOKENS;
use sugarcode_state::MIN_MODEL_CONTEXT_WINDOW_TOKENS;
use sugarcode_state::ModelCapabilityMode;
use sugarcode_state::ModelCatalog;
use sugarcode_state::ModelConnection;
use sugarcode_state::ModelProfile;
use sugarcode_state::ModelProviderKind;
use sugarcode_state::ModelWireApi;
use sugarcode_state::load_effective_config_for_home;
use sugarcode_state::load_model_edit_config_for_home;
use sugarcode_state::load_runtime_config_for_home;
use sugarcode_state::resolve_sugarcode_home;
use sugarcode_state::save_model_catalog;
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

fn model_catalog(
    endpoint: &str,
    api_key: Option<&str>,
    context_window_tokens: Option<u32>,
) -> ModelCatalog {
    ModelCatalog::new(
        "model_primary".to_owned(),
        vec![
            ModelConnection::new(
                "conn_primary".to_owned(),
                ModelProviderKind::OpenAiCompatible,
                "Fixture provider".to_owned(),
                Url::parse(endpoint).expect("URL"),
                true,
                Some(ModelWireApi::OpenAiChatCompletions),
                api_key.map(str::to_owned),
            )
            .expect("connection"),
        ],
        vec![
            ModelProfile::new(
                "model_primary".to_owned(),
                "conn_primary".to_owned(),
                "Fixture model".to_owned(),
                "fixture-model".to_owned(),
                context_window_tokens,
                ModelCapabilityMode::Auto,
                ModelCapabilityMode::Auto,
            )
            .expect("profile"),
        ],
    )
    .expect("catalog")
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
fn legacy_single_model_is_repairable_and_does_not_block_runtime() {
    let (directory, home) = resolved_home();
    fs::write(
        directory.path().join("config.toml"),
        "schema_version = 1\n\
         [model]\n\
         api_format = \"openai-chat-completions\"\n\
         endpoint = \"https://example.com/v1/chat/completions\"\n\
         model = \"fixture-model\"\n\
         [mcp]\n\
         servers = []\n",
    )
    .expect("write invalid model config");

    assert!(matches!(
        load_effective_config_for_home(home.clone()),
        Err(ConfigError::UnknownField { ref field, .. }) if field == "model"
    ));
    let runtime = load_runtime_config_for_home(home.clone()).expect("runtime config");
    assert!(runtime.models().is_none());
    assert!(runtime.mcp_servers().is_empty());
    let editable = load_model_edit_config_for_home(home).expect("repairable config");
    assert!(editable.models().is_none());
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
fn saving_model_catalog_refuses_to_replace_a_symlink() {
    use std::os::unix::fs::symlink;

    let (directory, home) = resolved_home();
    let target = directory.path().join("shared.toml");
    let sentinel = "do-not-overwrite";
    fs::write(&target, sentinel).expect("write target");
    symlink(&target, directory.path().join("config.toml")).expect("create config symlink");
    let models = model_catalog("https://example.com/v1", None, None);

    assert!(matches!(
        save_model_catalog(&home, &models),
        Err(ConfigError::NotRegularFile { .. })
    ));
    assert_eq!(fs::read_to_string(target).expect("read target"), sentinel);
}

#[test]
fn model_connection_accepts_http_and_https_transports() {
    for endpoint in [
        "https://example.com/v1",
        "http://example.com/v1",
        "http://localhost.example/v1",
        "http://localhost:18080/v1",
        "http://127.0.0.1:18080/v1",
        "http://[::1]:18080/v1",
    ] {
        model_catalog(endpoint, None, None);
    }

    for endpoint in [
        "ftp://example.com/v1",
        "https://user@example.com/v1",
        "https://example.com/v1?debug=true",
        "https://example.com/v1#fragment",
    ] {
        assert!(
            ModelConnection::new(
                "conn_primary".to_owned(),
                ModelProviderKind::OpenAiCompatible,
                "Fixture".to_owned(),
                Url::parse(endpoint).expect("URL"),
                true,
                Some(ModelWireApi::OpenAiChatCompletions),
                None,
            )
            .is_err(),
            "{endpoint} must be rejected"
        );
    }
}

#[test]
fn model_connections_accept_only_bounded_header_safe_api_keys() {
    for api_key in ["secret", "a", &"a".repeat(MAX_MODEL_API_KEY_BYTES)] {
        let models = model_catalog("https://example.com/v1", Some(api_key), None);
        assert_eq!(models.connections()[0].api_key(), Some(api_key));
    }
    for invalid in [
        String::new(),
        "contains space".to_string(),
        "contains\nnewline".to_string(),
        "a".repeat(MAX_MODEL_API_KEY_BYTES + 1),
    ] {
        assert!(
            ModelConnection::new(
                "conn_primary".to_owned(),
                ModelProviderKind::OpenAiCompatible,
                "Fixture".to_owned(),
                Url::parse("https://example.com/v1").expect("URL"),
                true,
                Some(ModelWireApi::OpenAiChatCompletions),
                Some(invalid),
            )
            .is_err()
        );
    }
}

#[test]
fn model_catalog_persists_api_key_without_exposing_it_through_debug() {
    let (directory, home) = resolved_home();
    let sentinel = "local-api-key-sentinel";
    let models = model_catalog("https://example.com/v1", Some(sentinel), None);
    let config = save_model_catalog(&home, &models).expect("save config");
    assert_eq!(
        config.models().unwrap().connections()[0].api_key(),
        Some(sentinel)
    );
    let stored = fs::read_to_string(directory.path().join("config.toml")).expect("stored config");
    assert!(stored.contains(&format!("api_key = \"{sentinel}\"")));
    assert!(!format!("{config:?}").contains(sentinel));
}

#[test]
fn saving_model_catalog_atomically_replaces_and_omits_default_context() {
    let (directory, home) = resolved_home();
    save_model_catalog(
        &home,
        &model_catalog("https://first.example/v1", None, Some(200_000)),
    )
    .expect("initial save");
    let replacement = model_catalog(
        "https://second.example/v1",
        Some("replacement-secret"),
        None,
    );
    let loaded = save_model_catalog(&home, &replacement).expect("replacement save");

    let models = loaded.models().expect("saved models");
    assert_eq!(
        models.connections()[0].base_url().as_str(),
        "https://second.example/v1"
    );
    assert_eq!(models.profiles()[0].model_id(), "fixture-model");
    assert_eq!(models.profiles()[0].context_window_tokens(), None);
    assert_eq!(
        models.profiles()[0].effective_context_window_tokens(),
        131_072
    );
    let stored = fs::read_to_string(directory.path().join("config.toml")).expect("stored config");
    assert!(!stored.contains("context_window_tokens"));
    let entries = fs::read_dir(directory.path())
        .expect("read home")
        .map(|entry| entry.expect("home entry").file_name())
        .collect::<Vec<_>>();
    assert_eq!(entries, vec![std::ffi::OsString::from("config.toml")]);
}

#[test]
fn model_context_window_is_optional_and_bounded() {
    for value in [
        MIN_MODEL_CONTEXT_WINDOW_TOKENS,
        131_072,
        MAX_MODEL_CONTEXT_WINDOW_TOKENS,
    ] {
        assert_eq!(
            model_catalog("https://example.com/v1", None, Some(value)).profiles()[0]
                .effective_context_window_tokens(),
            value
        );
    }
    for invalid in [
        MIN_MODEL_CONTEXT_WINDOW_TOKENS - 1,
        MAX_MODEL_CONTEXT_WINDOW_TOKENS + 1,
    ] {
        assert!(
            ModelProfile::new(
                "model_primary".to_owned(),
                "conn_primary".to_owned(),
                "Fixture".to_owned(),
                "fixture-model".to_owned(),
                Some(invalid),
                ModelCapabilityMode::Auto,
                ModelCapabilityMode::Auto,
            )
            .is_err()
        );
    }
}

#[test]
fn local_stdio_mcp_config_is_explicit_and_bounded() {
    let (directory, home) = resolved_home();
    let executable = std::env::current_exe().expect("current executable");
    let cwd = std::env::current_dir().expect("current directory");
    fs::write(
        directory.path().join("config.toml"),
        format!(
            "schema_version = 1\n\
             [[mcp.servers]]\n\
             id = \"local-fixture\"\n\
             transport = \"stdio\"\n\
             executable = {}\n\
             argv = [\"--stdio\"]\n\
             cwd = {}\n\
             [[mcp.servers]]\n\
             id = \"second-fixture\"\n\
             transport = \"stdio\"\n\
             executable = {}\n\
             argv = [\"--second\"]\n\
             cwd = {}\n",
            toml::Value::String(executable.to_string_lossy().into_owned()),
            toml::Value::String(cwd.to_string_lossy().into_owned()),
            toml::Value::String(executable.to_string_lossy().into_owned()),
            toml::Value::String(cwd.to_string_lossy().into_owned()),
        ),
    )
    .expect("write MCP config");

    let config = load_effective_config_for_home(home).expect("load MCP config");
    let server = config.mcp_servers().first().expect("server");
    assert_eq!(server.id(), "local-fixture");
    let server = server.as_stdio().expect("stdio server");
    assert_eq!(server.executable(), executable);
    assert_eq!(server.argv(), ["--stdio"]);
    assert_eq!(server.cwd(), cwd);
    assert_eq!(config.mcp_servers().len(), 2);
    assert_eq!(config.mcp_servers()[1].id(), "second-fixture");
    assert_eq!(
        config.mcp_servers()[1]
            .as_stdio()
            .expect("stdio server")
            .argv(),
        ["--second"]
    );
}

#[test]
fn loopback_streamable_http_config_is_literal_and_preserved() {
    let (directory, home) = resolved_home();
    fs::write(
        directory.path().join("config.toml"),
        "[[mcp.servers]]\n\
         id = \"http-fixture\"\n\
         transport = \"streamable-http\"\n\
         endpoint = \"http://[::1]:43123/mcp\"\n",
    )
    .expect("write MCP config");

    let config = load_effective_config_for_home(home.clone()).expect("load MCP config");
    let server = config.mcp_servers().first().expect("server");
    assert_eq!(server.id(), "http-fixture");
    assert_eq!(
        server
            .as_loopback_streamable_http()
            .expect("HTTP server")
            .endpoint()
            .as_str(),
        "http://[::1]:43123/mcp"
    );

    let models = model_catalog("https://example.com/v1", None, None);
    let saved = save_model_catalog(&home, &models).expect("save models");
    assert_eq!(
        saved.mcp_servers()[0]
            .as_loopback_streamable_http()
            .expect("HTTP server")
            .endpoint()
            .as_str(),
        "http://[::1]:43123/mcp"
    );
}

#[test]
fn loopback_streamable_http_config_rejects_ambient_or_remote_authority() {
    let (directory, home) = resolved_home();
    let config_path = directory.path().join("config.toml");
    for endpoint in [
        "https://127.0.0.1:443/mcp",
        "http://localhost:43123/mcp",
        "http://example.com:43123/mcp",
        "http://0.0.0.0:43123/mcp",
        "http://127.1:43123/mcp",
        "http://2130706433:43123/mcp",
        "http://[::ffff:127.0.0.1]:43123/mcp",
        "http://127.0.0.1/mcp",
        "http://127.0.0.1:0/mcp",
        "http://127.0.0.1:43123/",
        "http://127.0.0.1:43123/mcp?token=secret",
        "http://127.0.0.1:43123/mcp#fragment",
        "http://user@127.0.0.1:43123/mcp",
        "unix:///tmp/mcp.sock",
    ] {
        fs::write(
            &config_path,
            format!(
                "[[mcp.servers]]\n\
                 id = \"fixture\"\n\
                 transport = \"streamable-http\"\n\
                 endpoint = {endpoint:?}\n"
            ),
        )
        .expect("write invalid MCP config");
        assert!(
            load_effective_config_for_home(home.clone()).is_err(),
            "{endpoint}"
        );
    }
}

#[test]
fn local_stdio_mcp_config_rejects_implicit_authority() {
    let (directory, home) = resolved_home();
    let config_path = directory.path().join("config.toml");
    let cwd = std::env::current_dir().expect("current directory");
    let cwd = toml::Value::String(cwd.to_string_lossy().into_owned());

    for invalid in [
        format!(
            "[[mcp.servers]]\nid = \"fixture\"\ntransport = \"http\"\nexecutable = \"relative\"\nargv = []\ncwd = {cwd}\n"
        ),
        format!(
            "[[mcp.servers]]\nid = \"fixture\"\ntransport = \"stdio\"\nexecutable = \"fixture\"\nargv = []\ncwd = {cwd}\n"
        ),
        format!(
            "[[mcp.servers]]\nid = \"fixture\"\ntransport = \"stdio\"\nexecutable = {cwd}\nargv = []\ncwd = {cwd}\nenv = {{ TOKEN = \"secret\" }}\n"
        ),
        format!(
            "[[mcp.servers]]\nid = \"fixture\"\ntransport = \"stdio\"\nexecutable = {cwd}\nargv = []\ncwd = {cwd}\nendpoint = \"http://127.0.0.1:43123/mcp\"\n"
        ),
        format!(
            "[[mcp.servers]]\nid = \"fixture\"\ntransport = \"streamable-http\"\nendpoint = \"http://127.0.0.1:43123/mcp\"\nexecutable = {cwd}\n"
        ),
        format!(
            "[[mcp.servers]]\nid = \"Invalid\"\ntransport = \"stdio\"\nexecutable = {cwd}\nargv = []\ncwd = {cwd}\n"
        ),
        format!(
            "[[mcp.servers]]\nid = \"one\"\ntransport = \"stdio\"\nexecutable = {cwd}\nargv = []\ncwd = {cwd}\n\
             [[mcp.servers]]\nid = \"two\"\ntransport = \"stdio\"\nexecutable = {cwd}\nargv = []\ncwd = {cwd}\n\
             [[mcp.servers]]\nid = \"three\"\ntransport = \"stdio\"\nexecutable = {cwd}\nargv = []\ncwd = {cwd}\n"
        ),
        format!(
            "[[mcp.servers]]\nid = \"same\"\ntransport = \"stdio\"\nexecutable = {cwd}\nargv = []\ncwd = {cwd}\n\
             [[mcp.servers]]\nid = \"same\"\ntransport = \"stdio\"\nexecutable = {cwd}\nargv = []\ncwd = {cwd}\n"
        ),
        format!(
            "[[mcp.servers]]\nid = \"fixture\"\ntransport = \"stdio\"\nexecutable = {cwd}\nargv = [{}]\ncwd = {cwd}\n",
            std::iter::repeat_n("\"argument\"", 33)
                .collect::<Vec<_>>()
                .join(", ")
        ),
    ] {
        fs::write(&config_path, invalid).expect("write invalid MCP config");
        assert!(load_effective_config_for_home(home.clone()).is_err());
    }
}

#[test]
fn saving_model_catalog_preserves_validated_mcp_authority() {
    let (directory, home) = resolved_home();
    let executable = std::env::current_exe().expect("current executable");
    let cwd = std::env::current_dir().expect("current directory");
    fs::write(
        directory.path().join("config.toml"),
        format!(
            "[[mcp.servers]]\n\
             id = \"fixture\"\n\
             transport = \"stdio\"\n\
             executable = {}\n\
             argv = [\"--server\"]\n\
             cwd = {}\n\
             [[mcp.servers]]\n\
             id = \"second\"\n\
             transport = \"stdio\"\n\
             executable = {}\n\
             argv = [\"--second\"]\n\
             cwd = {}\n",
            toml::Value::String(executable.to_string_lossy().into_owned()),
            toml::Value::String(cwd.to_string_lossy().into_owned()),
            toml::Value::String(executable.to_string_lossy().into_owned()),
            toml::Value::String(cwd.to_string_lossy().into_owned()),
        ),
    )
    .expect("write MCP config");
    let models = model_catalog("https://example.com/v1", None, None);
    let saved = save_model_catalog(&home, &models).expect("save models");
    assert_eq!(saved.mcp_servers().len(), 2);
    assert_eq!(saved.mcp_servers()[0].id(), "fixture");
    assert_eq!(
        saved.mcp_servers()[0]
            .as_stdio()
            .expect("stdio server")
            .argv(),
        ["--server"]
    );
    assert_eq!(saved.mcp_servers()[1].id(), "second");
    assert_eq!(
        saved.mcp_servers()[1]
            .as_stdio()
            .expect("stdio server")
            .argv(),
        ["--second"]
    );
}
