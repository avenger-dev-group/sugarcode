use serde_json::Value;
use serde_json::json;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;

#[test]
fn initialization_happy_path_matches_golden_trace() {
    assert_golden("initialize-happy");
}

#[test]
fn initialization_failures_match_golden_trace() {
    assert_golden("initialize-errors");
}

#[test]
fn thread_start_happy_path_matches_golden_trace() {
    assert_golden("thread-start-happy");
}

#[test]
fn thread_start_failures_match_golden_trace() {
    assert_golden("thread-start-errors");
}

#[test]
fn turn_start_happy_path_matches_golden_trace() {
    assert_golden("turn-start-happy");
}

#[test]
fn turn_start_failures_match_golden_trace() {
    assert_golden("turn-start-errors");
}

#[test]
fn thread_resume_failures_match_golden_trace() {
    assert_golden("thread-resume-errors");
}

#[test]
fn thread_list_happy_path_matches_golden_trace() {
    assert_golden("thread-list-happy");
}

#[test]
fn thread_list_failures_match_golden_trace() {
    assert_golden("thread-list-errors");
}

#[test]
fn thread_search_happy_path_matches_golden_trace() {
    assert_golden("thread-search-happy");
}

#[test]
fn thread_search_failures_match_golden_trace() {
    assert_golden("thread-search-errors");
}

#[test]
fn thread_archive_happy_path_matches_golden_trace() {
    assert_golden("thread-archive-happy");
}

#[test]
fn thread_archive_failures_match_golden_trace() {
    assert_golden("thread-archive-errors");
}

#[test]
fn thread_unarchive_happy_path_matches_golden_trace() {
    assert_golden("thread-unarchive-happy");
}

#[test]
fn thread_unarchive_failures_match_golden_trace() {
    assert_golden("thread-unarchive-errors");
}

fn assert_golden(name: &str) {
    let sugarcode_home = tempfile::tempdir().expect("create isolated SugarCode home");
    let fixture_root =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../protocol-fixtures/app-server/v1");
    let input =
        fs::read(fixture_root.join(format!("{name}.stdin.jsonl"))).expect("read golden stdin");
    let expected = fs::read_to_string(fixture_root.join(format!("{name}.stdout.jsonl")))
        .expect("read golden stdout");

    let mut child = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .args(["app-server", "--stdio"])
        .env("SUGARCODE_HOME", sugarcode_home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn sugarcode app-server");
    child
        .stdin
        .take()
        .expect("child stdin")
        .write_all(&input)
        .expect("write fixture input");
    let output = child.wait_with_output().expect("wait for app-server");

    assert!(output.status.success(), "app-server failed: {output:?}");
    assert!(
        output.stderr.is_empty(),
        "protocol run wrote diagnostics to stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let actual = normalize_trace(&String::from_utf8(output.stdout).expect("UTF-8 stdout"));
    let expected = normalize_trace(&expected);
    assert_eq!(actual, expected);
}

fn normalize_trace(output: &str) -> String {
    let mut normalized = String::new();
    for line in output.lines() {
        let mut value = serde_json::from_str::<Value>(line).expect("stdout line is JSON");
        if let Some(platform) = value
            .get_mut("result")
            .and_then(|result| result.get_mut("platform"))
        {
            *platform = json!({
                "arch": "<arch>",
                "family": "<family>",
                "os": "<os>"
            });
        }
        normalized.push_str(&serde_json::to_string(&value).expect("normalized JSON serializes"));
        normalized.push('\n');
    }
    normalized
}
