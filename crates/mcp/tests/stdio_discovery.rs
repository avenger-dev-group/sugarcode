use serde_json::Value;
use serde_json::json;
use std::io::BufRead;
use std::io::Write;
use sugarcode_mcp::DiscoveryErrorKind;
use sugarcode_mcp::StdioServerSpec;

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.get(1).map(String::as_str) == Some("--fixture-server") {
        fixture_server(
            args.get(2).map(String::as_str).unwrap_or("ok"),
            args.get(3).map(String::as_str),
        );
        return;
    }
    if args.get(1).map(String::as_str) == Some("--fixture-leaf") {
        std::thread::sleep(std::time::Duration::from_secs(60));
        return;
    }

    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    runtime.block_on(async {
        discovers_and_canonicalizes_a_real_stdio_server().await;
        rejects_protocol_mismatch().await;
        rejects_stderr_overflow().await;
        rejects_oversized_and_excess_messages().await;
        cancellation_reaps_the_process_tree().await;
    });
}

async fn discovers_and_canonicalizes_a_real_stdio_server() {
    let inventory = sugarcode_mcp::discover_stdio(&fixture_spec("ok"))
        .await
        .expect("discover");
    assert_eq!(inventory.server_id(), "fixture");
    assert_eq!(inventory.server_name(), "real-fixture");
    assert_eq!(inventory.server_version(), "1.0.0");
    assert_eq!(
        inventory
            .tools()
            .iter()
            .map(|tool| tool.name())
            .collect::<Vec<_>>(),
        vec!["alpha", "zeta"]
    );
}

async fn rejects_protocol_mismatch() {
    let error = sugarcode_mcp::discover_stdio(&fixture_spec("bad-version"))
        .await
        .expect_err("version mismatch");
    assert_eq!(error.kind(), DiscoveryErrorKind::UnsupportedProtocolVersion);
}

async fn rejects_stderr_overflow() {
    let error = sugarcode_mcp::discover_stdio(&fixture_spec("stderr-overflow"))
        .await
        .expect_err("stderr overflow");
    assert_eq!(error.kind(), DiscoveryErrorKind::StderrTooLarge);
}

async fn rejects_oversized_and_excess_messages() {
    let oversized = sugarcode_mcp::discover_stdio(&fixture_spec("oversized-message"))
        .await
        .expect_err("oversized message");
    assert_eq!(oversized.kind(), DiscoveryErrorKind::MessageTooLarge);

    let excess = sugarcode_mcp::discover_stdio(&fixture_spec("too-many-messages"))
        .await
        .expect_err("too many messages");
    assert_eq!(excess.kind(), DiscoveryErrorKind::TooManyMessages);
}

async fn cancellation_reaps_the_process_tree() {
    let directory = tempfile::tempdir().expect("tempdir");
    let marker = directory.path().join("pids");
    let spec = StdioServerSpec::new(
        "fixture".to_owned(),
        std::env::current_exe().expect("current exe"),
        vec![
            "--fixture-server".to_owned(),
            "hang-tree".to_owned(),
            marker.to_string_lossy().into_owned(),
        ],
        std::env::current_dir().expect("current dir"),
    );
    let discovery = tokio::spawn(async move { sugarcode_mcp::discover_stdio(&spec).await });
    let pids = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            if let Ok(contents) = std::fs::read_to_string(&marker) {
                let pids = contents
                    .split_whitespace()
                    .map(|value| value.parse::<u32>().expect("pid"))
                    .collect::<Vec<_>>();
                if pids.len() == 2 {
                    break pids;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("fixture PIDs");
    discovery.abort();
    let _ = discovery.await;

    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while pids.iter().copied().any(process_exists) {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("process tree was reaped");
}

fn fixture_spec(mode: &str) -> StdioServerSpec {
    StdioServerSpec::new(
        "fixture".to_owned(),
        std::env::current_exe().expect("current exe"),
        vec!["--fixture-server".to_owned(), mode.to_owned()],
        std::env::current_dir().expect("current dir"),
    )
}

fn fixture_server(mode: &str, argument: Option<&str>) {
    if mode == "hang-tree" {
        let mut leaf = std::process::Command::new(std::env::current_exe().expect("current exe"))
            .arg("--fixture-leaf")
            .spawn()
            .expect("spawn leaf");
        std::fs::write(
            argument.expect("PID marker"),
            format!("{} {}\n", std::process::id(), leaf.id()),
        )
        .expect("write PID marker");
        let _ = leaf.wait();
        return;
    }
    let mut input = std::io::BufReader::new(std::io::stdin().lock());
    let mut output = std::io::stdout().lock();
    let initialize = read_message(&mut input);
    assert_eq!(initialize["method"], "initialize");
    assert_eq!(
        initialize["params"]["protocolVersion"],
        sugarcode_mcp::MCP_PROTOCOL_VERSION
    );
    assert!(std::env::var_os("PATH").is_none());
    if mode == "oversized-message" {
        output
            .write_all(&vec![b' '; sugarcode_mcp::MAX_MESSAGE_BYTES + 1])
            .expect("oversized stdout");
        output.write_all(b"\n").expect("newline");
        output.flush().expect("flush");
        wait_for_eof(&mut input);
        return;
    }
    if mode == "too-many-messages" {
        for _ in 0..sugarcode_mcp::MAX_MESSAGES {
            write_message(
                &mut output,
                &json!({
                    "jsonrpc": "2.0",
                    "method": "notifications/message",
                    "params": {"level": "info", "data": "bounded"}
                }),
            );
        }
        wait_for_eof(&mut input);
        return;
    }
    let protocol_version = if mode == "bad-version" {
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
                "protocolVersion": protocol_version,
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {"name": "real-fixture", "version": "1.0.0"}
            }
        }),
    );
    if mode == "bad-version" {
        wait_for_eof(&mut input);
        return;
    }

    let initialized = read_message(&mut input);
    assert_eq!(initialized["method"], "notifications/initialized");
    let list = read_message(&mut input);
    assert_eq!(list["method"], "tools/list");
    if mode == "stderr-overflow" {
        std::io::stderr()
            .lock()
            .write_all(&vec![b'x'; sugarcode_mcp::MAX_STDERR_BYTES + 1])
            .expect("stderr");
    }
    write_message(
        &mut output,
        &json!({"jsonrpc": "2.0", "id": 91, "method": "ping"}),
    );
    let ping = read_message(&mut input);
    assert_eq!(ping["id"], 91);
    write_message(
        &mut output,
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "result": {
                "tools": [
                    {
                        "name": "zeta",
                        "description": "later",
                        "inputSchema": {"type": "object"}
                    },
                    {
                        "name": "alpha",
                        "inputSchema": {
                            "$schema": "https://json-schema.org/draft/2020-12/schema",
                            "type": "object",
                            "properties": {"value": {"type": "string"}}
                        },
                        "outputSchema": {"type": "object"}
                    }
                ]
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
    serde_json::to_writer(&mut *output, value).expect("write JSON");
    output.write_all(b"\n").expect("newline");
    output.flush().expect("flush");
}

fn wait_for_eof(input: &mut impl BufRead) {
    let mut line = String::new();
    assert_eq!(input.read_line(&mut line).expect("EOF"), 0);
}

#[cfg(unix)]
fn process_exists(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn process_exists(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
    use windows_sys::Win32::System::Threading::OpenProcess;
    use windows_sys::Win32::System::Threading::PROCESS_SYNCHRONIZE;
    use windows_sys::Win32::System::Threading::WaitForSingleObject;

    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return false;
        }
        let exists = WaitForSingleObject(handle, 0) == WAIT_TIMEOUT;
        CloseHandle(handle);
        exists
    }
}
