use std::fs;
use sugarcode_state::CURRENT_CONFIG_SCHEMA_VERSION;
use sugarcode_state::ConfigError;
use sugarcode_state::HomeResolutionInputs;
use sugarcode_state::MAX_CONFIG_BYTES;
use sugarcode_state::load_effective_config_for_home;
use sugarcode_state::resolve_sugarcode_home;
use tempfile::tempdir;

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
fn config_symlink_to_regular_file_is_allowed() {
    use std::os::unix::fs::symlink;

    let (directory, home) = resolved_home();
    let target = directory.path().join("shared.toml");
    fs::write(&target, "schema_version = 1\n").expect("write target");
    symlink(&target, directory.path().join("config.toml")).expect("create config symlink");

    assert_eq!(
        load_effective_config_for_home(home)
            .expect("load symlink")
            .schema_version(),
        CURRENT_CONFIG_SCHEMA_VERSION
    );
}
