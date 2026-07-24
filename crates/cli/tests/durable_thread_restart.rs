use serde_json::Value;
use serde_json::json;
use std::fs;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::process::Child;
use std::process::ChildStdin;
use std::process::ChildStdout;
use std::process::Command;
use std::process::Stdio;

struct RunningServer {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl RunningServer {
    fn spawn(home: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
            .arg("--home")
            .arg(home)
            .args(["app-server", "--stdio"])
            .env_remove("SUGARCODE_HOME")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn app-server");
        let stdin = child.stdin.take().expect("child stdin");
        let stdout = BufReader::new(child.stdout.take().expect("child stdout"));
        Self {
            child,
            stdin,
            stdout,
        }
    }

    fn send(&mut self, message: Value, output_lines: usize) -> Vec<Value> {
        writeln!(self.stdin, "{message}").expect("write request");
        self.stdin.flush().expect("flush request");
        (0..output_lines)
            .map(|_| {
                let mut line = String::new();
                let bytes = self.stdout.read_line(&mut line).expect("read response");
                assert!(bytes > 0, "app-server closed before expected response");
                serde_json::from_str(&line).expect("response JSON")
            })
            .collect()
    }

    fn initialize(&mut self) {
        let response = self.send(
            json!({
                "jsonrpc": "2.0",
                "id": "initialize",
                "method": "initialize",
                "params": {
                    "protocolVersion": 1,
                    "clientInfo": {
                        "name": "restart-test",
                        "version": "1.0.0"
                    }
                }
            }),
            1,
        );
        assert_eq!(response[0]["id"], "initialize");
        self.send(json!({"jsonrpc": "2.0", "method": "initialized"}), 0);
    }

    fn finish(self) {
        let stderr = self.finish_with_diagnostics();
        assert!(stderr.is_empty(), "unexpected diagnostics: {stderr}");
    }

    fn finish_with_diagnostics(mut self) -> String {
        drop(self.stdin);
        let mut remaining_stdout = String::new();
        self.stdout
            .read_to_string(&mut remaining_stdout)
            .expect("drain stdout");
        assert!(remaining_stdout.is_empty(), "unexpected protocol output");
        let status = self.child.wait().expect("wait for app-server");
        let mut stderr = String::new();
        self.child
            .stderr
            .take()
            .expect("child stderr")
            .read_to_string(&mut stderr)
            .expect("read stderr");
        assert!(status.success(), "app-server failed: {status:?}: {stderr}");
        stderr
    }
}

#[test]
fn resumes_completed_history_across_two_cli_processes() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let mut first = RunningServer::spawn(home.path());
    first.initialize();

    let thread_messages = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "thread-1",
            "method": "thread/start",
            "params": {}
        }),
        2,
    );
    let thread_id = thread_messages[0]["result"]["thread"]["id"]
        .as_str()
        .expect("thread id")
        .to_string();
    let turn_messages = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "turn-1",
            "method": "turn/start",
            "params": {"threadId": thread_id}
        }),
        6,
    );
    let completed_turn = turn_messages[5]["params"]["turn"].clone();
    let completed_item = turn_messages[4]["params"]["item"].clone();
    first.finish();
    fs::remove_file(home.path().join("projections/v1/thread-discovery.sqlite3"))
        .expect("remove disposable projection");

    let mut second = RunningServer::spawn(home.path());
    second.initialize();
    let listed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "list-1",
            "method": "thread/list",
            "params": {}
        }),
        1,
    );
    assert_eq!(listed[0]["result"]["data"], json!([{"id": thread_id}]));
    assert_eq!(listed[0]["result"]["nextCursor"], Value::Null);
    let resumed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "resume-1",
            "method": "thread/resume",
            "params": {"threadId": thread_id}
        }),
        1,
    );
    assert_eq!(resumed[0]["result"]["thread"]["id"], thread_id);
    assert_eq!(resumed[0]["result"]["turns"][0]["id"], completed_turn["id"]);
    assert_eq!(
        resumed[0]["result"]["turns"][0]["status"],
        completed_turn["status"]
    );
    assert_eq!(resumed[0]["result"]["turns"][0]["items"][0], completed_item);

    let next_turn = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "turn-2",
            "method": "turn/start",
            "params": {"threadId": thread_id}
        }),
        6,
    );
    assert_eq!(
        next_turn[0]["result"]["turn"]["id"],
        "turn_0000000000000002"
    );
    assert_eq!(
        next_turn[2]["params"]["item"]["id"],
        "item_0000000000000002"
    );
    second.finish();
}

#[test]
fn rebuilds_an_invalid_projection_then_lists_and_resumes_without_leaking_contents() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let mut first = RunningServer::spawn(home.path());
    first.initialize();
    let started = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "thread-1",
            "method": "thread/start"
        }),
        2,
    );
    let thread_id = started[0]["result"]["thread"]["id"]
        .as_str()
        .expect("thread id")
        .to_string();
    let lifecycle = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "turn-1",
            "method": "turn/start",
            "params": {"threadId": thread_id}
        }),
        6,
    );
    let expected_item = lifecycle[4]["params"]["item"].clone();
    first.finish();

    let projection = home.path().join("projections/v1/thread-discovery.sqlite3");
    let sentinel = "projection-secret-must-not-leak";
    fs::write(&projection, sentinel).expect("replace projection with invalid header");

    let mut second = RunningServer::spawn(home.path());
    second.initialize();
    let listed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "list",
            "method": "thread/list"
        }),
        1,
    );
    assert_eq!(listed[0]["result"]["data"], json!([{"id": thread_id}]));
    let resumed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "resume",
            "method": "thread/resume",
            "params": {"threadId": thread_id}
        }),
        1,
    );
    assert_eq!(resumed[0]["result"]["turns"][0]["items"][0], expected_item);
    let stderr = second.finish_with_diagnostics();
    assert!(stderr.contains("thread-discovery.sqlite3"));
    assert!(stderr.contains("thread discovery rebuild"));
    assert!(stderr.contains("invalidHeaderRecovered"));
    assert!(!stderr.contains(sentinel));
    assert!(!stderr.contains("SugarCode deterministic response."));
}

#[test]
fn rejects_a_second_app_server_using_the_same_home() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let mut first = RunningServer::spawn(home.path());
    first.initialize();

    let second = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .arg("--home")
        .arg(home.path())
        .args(["app-server", "--stdio"])
        .env_remove("SUGARCODE_HOME")
        .stdin(Stdio::null())
        .output()
        .expect("run second app-server");
    assert!(!second.status.success());
    assert!(second.stdout.is_empty());
    let stderr = String::from_utf8(second.stderr).expect("UTF-8 stderr");
    assert!(stderr.contains("rollout writer is busy"));

    first.finish();
}
