use serde_json::Value;
use serde_json::json;
use std::fs;
use std::io::BufRead;
use std::io::Write;
use std::path::Path;
use std::process::Command;
use tempfile::tempdir;

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.get(1).map(String::as_str) == Some("--fixture-server") {
        fixture_server(args.get(2).map(String::as_str).unwrap_or("ok"));
        return;
    }

    selected_server_completes_real_cli_discovery();
    configured_server_is_inert_without_explicit_selection();
    selection_and_discovery_fail_before_rollout_open();
}

fn selected_server_completes_real_cli_discovery() {
    let home = tempdir().expect("home");
    write_config(
        home.path(),
        "ok",
        std::env::current_exe().expect("test executable"),
    );
    let output = sugarcode(home.path())
        .args(["app-server", "--stdio", "--mcp-server", "fixture"])
        .output()
        .expect("run SugarCode");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn configured_server_is_inert_without_explicit_selection() {
    let home = tempdir().expect("home");
    write_config(
        home.path(),
        "ok",
        home.path().join("does-not-exist-mcp-server"),
    );
    let output = sugarcode(home.path())
        .args(["app-server", "--stdio"])
        .output()
        .expect("run SugarCode");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn selection_and_discovery_fail_before_rollout_open() {
    for (selected, mode) in [("missing", "ok"), ("fixture", "bad-version")] {
        let home = tempdir().expect("home");
        write_config(
            home.path(),
            mode,
            std::env::current_exe().expect("test executable"),
        );
        let output = sugarcode(home.path())
            .args(["app-server", "--stdio", "--mcp-server", selected])
            .output()
            .expect("run SugarCode");
        assert!(!output.status.success());
        let entries = fs::read_dir(home.path())
            .expect("read home")
            .map(|entry| entry.expect("entry").file_name())
            .collect::<Vec<_>>();
        assert_eq!(entries, vec![std::ffi::OsString::from("config.toml")]);
    }
}

fn sugarcode(home: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_sugarcode"));
    command.arg("--home").arg(home);
    command
}

fn write_config(home: &Path, mode: &str, executable: impl AsRef<Path>) {
    let cwd = std::env::current_dir().expect("cwd");
    fs::write(
        home.join("config.toml"),
        format!(
            "schema_version = 1\n\
             [[mcp.servers]]\n\
             id = \"fixture\"\n\
             transport = \"stdio\"\n\
             executable = {}\n\
             argv = [\"--fixture-server\", {}]\n\
             cwd = {}\n",
            toml::Value::String(executable.as_ref().to_string_lossy().into_owned()),
            toml::Value::String(mode.to_owned()),
            toml::Value::String(cwd.to_string_lossy().into_owned()),
        ),
    )
    .expect("write config");
}

fn fixture_server(mode: &str) {
    assert!(std::env::var_os("PATH").is_none());
    let mut input = std::io::BufReader::new(std::io::stdin().lock());
    let mut output = std::io::stdout().lock();
    let initialize = read_message(&mut input);
    assert_eq!(initialize["method"], "initialize");
    let version = if mode == "bad-version" {
        "2024-11-05"
    } else {
        sugarcode_mcp::MCP_PROTOCOL_VERSION
    };
    write_message(
        &mut output,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "protocolVersion": version,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "cli-fixture", "version": "1.0.0"}
            }
        }),
    );
    if mode == "bad-version" {
        wait_for_eof(&mut input);
        return;
    }
    assert_eq!(
        read_message(&mut input)["method"],
        "notifications/initialized"
    );
    assert_eq!(read_message(&mut input)["method"], "tools/list");
    write_message(
        &mut output,
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "result": {
                "tools": [{
                    "name": "inspect",
                    "description": "discovery only",
                    "inputSchema": {"type": "object"}
                }]
            }
        }),
    );
    wait_for_eof(&mut input);
}

fn read_message(input: &mut impl BufRead) -> Value {
    let mut line = String::new();
    assert_ne!(input.read_line(&mut line).expect("read"), 0);
    serde_json::from_str(&line).expect("JSON")
}

fn write_message(output: &mut impl Write, value: &Value) {
    serde_json::to_writer(&mut *output, value).expect("JSON");
    output.write_all(b"\n").expect("newline");
    output.flush().expect("flush");
}

fn wait_for_eof(input: &mut impl BufRead) {
    let mut line = String::new();
    assert_eq!(input.read_line(&mut line).expect("EOF"), 0);
}
