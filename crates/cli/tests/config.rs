use std::fs;
use std::process::Command;
use tempfile::tempdir;

#[test]
fn validates_missing_and_explicit_v1_configuration() {
    let home = tempdir().expect("SugarCode home");

    let missing = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["config", "validate"])
        .env("SUGARCODE_HOME", home.path())
        .output()
        .expect("run config validate");
    assert!(missing.status.success(), "{missing:?}");
    assert_eq!(
        String::from_utf8(missing.stdout).expect("UTF-8 stdout"),
        "SugarCode configuration is valid (schema version 1).\n"
    );
    assert!(missing.stderr.is_empty());

    fs::write(home.path().join("config.toml"), "schema_version = 1\n").expect("write config");
    let explicit = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["config", "validate"])
        .env("SUGARCODE_HOME", home.path())
        .output()
        .expect("run config validate");
    assert!(explicit.status.success(), "{explicit:?}");
}

#[test]
fn cli_home_wins_over_environment_home() {
    let cli_home = tempdir().expect("CLI home");
    let environment_home = tempdir().expect("environment home");
    fs::write(
        environment_home.path().join("config.toml"),
        "schema_version = 2\n",
    )
    .expect("write invalid environment config");

    let output = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .arg("--home")
        .arg(cli_home.path())
        .args(["config", "validate"])
        .env("SUGARCODE_HOME", environment_home.path())
        .output()
        .expect("run config validate");

    assert!(output.status.success(), "{output:?}");
}

#[test]
fn invalid_configuration_has_no_stdout_and_redacts_values() {
    let home = tempdir().expect("SugarCode home");
    let sentinel = "do-not-leak-this-secret";
    fs::write(
        home.path().join("config.toml"),
        format!("api_key = \"{sentinel}\"\n"),
    )
    .expect("write invalid config");

    let output = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["app-server", "--stdio"])
        .env("SUGARCODE_HOME", home.path())
        .output()
        .expect("run app server");

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8(output.stderr).expect("UTF-8 stderr");
    assert!(stderr.contains("unknown configuration field `api_key`"));
    assert!(!stderr.contains(sentinel));
}
