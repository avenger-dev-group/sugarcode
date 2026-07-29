use std::fs;
use std::io::Write;
use std::process::Command;
use std::process::Stdio;
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
fn lists_only_the_redacted_mcp_inventory() {
    let home = tempdir().expect("SugarCode home");
    let executable = std::env::current_exe().expect("test executable");
    fs::write(
        home.path().join("config.toml"),
        format!(
            "schema_version = 1\n\n[[mcp.servers]]\nid = \"local-tools\"\ntransport = \"stdio\"\nexecutable = {executable:?}\ncwd = {cwd:?}\nargv = [\"sensitive-value\"]\n",
            cwd = home.path()
        ),
    )
    .expect("write config");

    let output = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["config", "mcp", "list", "--json"])
        .env("SUGARCODE_HOME", home.path())
        .output()
        .expect("run config mcp list");
    assert!(output.status.success(), "{output:?}");
    assert!(output.stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output.stdout).expect("JSON"),
        serde_json::json!({
            "servers": [{"id": "local-tools", "transport": "stdio"}]
        })
    );
    assert!(
        !String::from_utf8(output.stdout)
            .expect("UTF-8")
            .contains("sensitive-value")
    );
}

#[test]
fn manages_mcp_registry_through_the_real_cli_with_revision_guard() {
    let home = tempdir().expect("SugarCode home");
    let executable = std::env::current_exe().expect("test executable");
    let inspect = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .arg("--home")
        .arg(home.path())
        .args(["config", "mcp", "inspect", "--json"])
        .output()
        .expect("inspect empty MCP registry");
    assert!(inspect.status.success(), "{inspect:?}");
    let initial =
        serde_json::from_slice::<serde_json::Value>(&inspect.stdout).expect("inspect JSON");

    let request = serde_json::json!({
        "contractVersion": 1,
        "expectedRevision": initial["revision"],
        "servers": [{
            "id": "local-tools",
            "transport": "stdio",
            "executable": executable,
            "argv": ["serve"],
            "cwd": home.path()
        }]
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .arg("--home")
        .arg(home.path())
        .args(["config", "mcp", "set", "--stdin", "--json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("set MCP registry");
    write!(child.stdin.take().expect("stdin"), "{request}").expect("write request");
    let set = child.wait_with_output().expect("wait for MCP set");
    assert!(set.status.success(), "{set:?}");
    assert!(set.stderr.is_empty());
    let receipt = serde_json::from_slice::<serde_json::Value>(&set.stdout).expect("set JSON");
    assert_eq!(receipt["contractVersion"], 1);
    assert_ne!(receipt["revision"], initial["revision"]);
    assert_eq!(receipt["servers"][0]["id"], "local-tools");

    let stored = fs::read_to_string(home.path().join("config.toml")).expect("stored config");
    assert!(stored.contains("[[mcp.servers]]"));
    assert!(stored.contains("id = \"local-tools\""));

    let mut stale = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .arg("--home")
        .arg(home.path())
        .args(["config", "mcp", "set", "--stdin", "--json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("run stale MCP set");
    write!(stale.stdin.take().expect("stdin"), "{request}").expect("write stale request");
    let stale = stale.wait_with_output().expect("wait for stale MCP set");
    assert!(!stale.status.success());
    assert!(stale.stdout.is_empty());
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

#[test]
fn model_configuration_accepts_http_and_show_reports_bearerless_configuration() {
    let home = tempdir().expect("SugarCode home");
    let mut child = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["--home"])
        .arg(home.path())
        .args(["config", "model", "set", "--stdin", "--json"])
        .env_remove("SUGARCODE_HOME")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("run model config set");
    write!(
        child.stdin.take().expect("stdin"),
        "{}",
        serde_json::json!({
            "contractVersion": 1,
            "expectedRevision": "45686ea2c125fee4f29640cef339e7971c01979f11bad3df6db75d8110ffbb78",
            "config": {
                "apiFormat": "openai-chat-completions",
                "endpoint": "http://127.0.0.1:18080/custom/v1/chat/completions",
                "model": "custom-model",
                "credentialReference": null
            }
        })
    )
    .expect("write model config");
    let set = child.wait_with_output().expect("wait for config set");
    assert!(set.status.success(), "{set:?}");
    let set_receipt =
        serde_json::from_slice::<serde_json::Value>(&set.stdout).expect("set receipt");
    assert_eq!(set_receipt["contractVersion"], 1);
    assert!(set.stderr.is_empty());

    let stored = fs::read_to_string(home.path().join("config.toml")).expect("stored config");
    assert!(stored.contains("endpoint = \"http://127.0.0.1:18080/"));
    assert!(!stored.contains("token"));
    assert!(!stored.contains("credential"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(home.path().join("config.toml"))
                .expect("config metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    let mut replacement = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["--home"])
        .arg(home.path())
        .args(["config", "model", "set", "--stdin", "--json"])
        .env_remove("SUGARCODE_HOME")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("run replacement model config set");
    write!(
        replacement.stdin.take().expect("replacement stdin"),
        "{}",
        serde_json::json!({
            "contractVersion": 1,
            "expectedRevision": set_receipt["revision"],
            "config": {
                "apiFormat": "openai-chat-completions",
                "endpoint": "http://127.0.0.1:18081/v1/chat/completions",
                "model": "replacement-model",
                "credentialReference": null
            }
        })
    )
    .expect("write replacement model config");
    let replacement = replacement
        .wait_with_output()
        .expect("wait for replacement config");
    assert!(replacement.status.success(), "{replacement:?}");
    assert!(replacement.stderr.is_empty());

    let show = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["--home"])
        .arg(home.path())
        .args(["config", "model", "inspect", "--json"])
        .env_remove("SUGARCODE_HOME")
        .output()
        .expect("run model config show");
    assert!(show.status.success(), "{show:?}");
    let stdout = String::from_utf8(show.stdout).expect("UTF-8 stdout");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&stdout).expect("show JSON"),
        serde_json::json!({
            "contractVersion": 1,
            "revision": serde_json::from_slice::<serde_json::Value>(&replacement.stdout)
                .expect("replacement receipt")["revision"],
            "config": {
                "apiFormat": "openai-chat-completions",
                "endpoint": "http://127.0.0.1:18081/v1/chat/completions",
                "model": "replacement-model",
                "credentialReference": null
            },
            "credentialStatus": "notConfigured"
        })
    );
}
