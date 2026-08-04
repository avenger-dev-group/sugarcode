use super::*;

#[test]
fn archives_across_two_processes_and_rebuilds_both_projections_from_rollouts() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let mut first = RunningServer::spawn(home.path());
    first.initialize();
    for sequence in 1..=3 {
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": format!("thread-{sequence}"),
                "method": "thread/start",
                "params": {}
            }),
            2,
        );
        if sequence < 3 {
            first.send(
                json!({
                    "jsonrpc": "2.0",
                    "id": format!("turn-{sequence}"),
                    "method": "turn/start",
                    "params": {"threadId": format!("00000000-0000-7000-8000-{sequence:012}"), "input": [{"type":"text","text":"Hello"}]}
                }),
                8,
            );
        }
    }

    let archived = "00000000-0000-7000-8000-000000000002";
    let archive = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "archive",
            "method": "thread/archive",
            "params": {"threadId": archived}
        }),
        1,
    );
    assert_eq!(archive[0]["result"], json!({}));
    let idempotent = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "archive-again",
            "method": "thread/archive",
            "params": {"threadId": archived}
        }),
        1,
    );
    assert_eq!(idempotent[0]["result"], json!({}));
    assert_active_archive_views(&mut first, "first");
    first.finish();

    let projections = home.path().join("projections/v1");
    fs::remove_file(projections.join("thread-discovery.sqlite3"))
        .expect("remove discovery projection");
    let search_projection = projections.join("thread-search.sqlite3");
    let sentinel = "archived-search-corruption-secret-must-not-leak";
    fs::write(&search_projection, sentinel).expect("corrupt search projection");

    let mut second = RunningServer::spawn(home.path());
    second.initialize();
    assert_active_archive_views(&mut second, "second");
    let resumed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "resume-active",
            "method": "thread/resume",
            "params": {"threadId": "00000000-0000-7000-8000-000000000001"}
        }),
        1,
    );
    assert_eq!(
        resumed[0]["result"]["turns"][0]["items"][1]["text"],
        "SugarCode deterministic response."
    );
    let next = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "thread-4",
            "method": "thread/start",
            "params": {}
        }),
        2,
    );
    assert_eq!(
        next[0]["result"]["thread"]["id"],
        "00000000-0000-7000-8000-000000000004"
    );
    let next_turn = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "turn-3",
            "method": "turn/start",
            "params": {"threadId": "00000000-0000-7000-8000-000000000004", "input": [{"type":"text","text":"Hello"}]}
        }),
        8,
    );
    assert_eq!(
        next_turn[0]["result"]["turn"]["id"],
        "00000000-0001-7000-8000-000000000003"
    );
    assert_eq!(
        next_turn[4]["params"]["item"]["id"],
        "00000000-0002-7000-8000-000000000006"
    );

    let stderr = second.finish_with_diagnostics();
    assert!(stderr.contains("thread-search.sqlite3"));
    assert!(stderr.contains("thread search rebuild"));
    assert!(stderr.contains("invalidHeaderRecovered"));
    assert!(!stderr.contains(sentinel));
    assert!(!stderr.contains("SugarCode deterministic response."));
}

#[test]
fn unarchives_across_two_processes_and_rebuilds_both_projections_from_rollouts() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let mut first = RunningServer::spawn(home.path());
    first.initialize();
    for sequence in 1..=2 {
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": format!("thread-{sequence}"),
                "method": "thread/start",
                "params": {}
            }),
            2,
        );
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": format!("turn-{sequence}"),
                "method": "turn/start",
                "params": {"threadId": format!("00000000-0000-7000-8000-{sequence:012}"), "input": [{"type":"text","text":"Hello"}]}
            }),
            8,
        );
    }

    let restored = "00000000-0000-7000-8000-000000000002";
    assert_eq!(
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": "archive",
                "method": "thread/archive",
                "params": {"threadId": restored}
            }),
            1,
        )[0]["result"],
        json!({})
    );
    let hidden = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "hidden-list",
            "method": "thread/list"
        }),
        1,
    );
    assert_eq!(
        hidden[0]["result"]["data"],
        json!([{"id": "00000000-0000-7000-8000-000000000001"}])
    );
    assert_eq!(
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": "unarchive",
                "method": "thread/unarchive",
                "params": {"threadId": restored}
            }),
            1,
        )[0]["result"],
        json!({})
    );
    let restored_list = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "restored-list",
            "method": "thread/list"
        }),
        1,
    );
    assert_eq!(
        restored_list[0]["result"]["data"],
        json!([
            {"id": "00000000-0000-7000-8000-000000000002"},
            {"id": "00000000-0000-7000-8000-000000000001"}
        ])
    );
    let turn_after_restore = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "turn-after-restore",
            "method": "turn/start",
            "params": {"threadId": restored, "input": [{"type":"text","text":"Hello"}]}
        }),
        8,
    );
    assert_eq!(
        turn_after_restore[0]["result"]["turn"]["id"],
        "00000000-0001-7000-8000-000000000003"
    );
    first.finish();

    let projections = home.path().join("projections/v1");
    fs::remove_file(projections.join("thread-discovery.sqlite3"))
        .expect("remove discovery projection");
    let search_projection = projections.join("thread-search.sqlite3");
    let sentinel = "unarchive-search-corruption-secret-must-not-leak";
    fs::write(&search_projection, sentinel).expect("corrupt search projection");

    let mut second = RunningServer::spawn(home.path());
    second.initialize();
    let listed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "list-after-restart",
            "method": "thread/list"
        }),
        1,
    );
    assert_eq!(
        listed[0]["result"]["data"],
        json!([
            {"id": "00000000-0000-7000-8000-000000000002"},
            {"id": "00000000-0000-7000-8000-000000000001"}
        ])
    );
    let searched = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "search-after-restart",
            "method": "thread/search",
            "params": {"query": "SugarCode deterministic"}
        }),
        1,
    );
    assert_eq!(
        searched[0]["result"]["data"],
        json!([
            {"id": "00000000-0000-7000-8000-000000000002"},
            {"id": "00000000-0000-7000-8000-000000000001"}
        ])
    );
    let resumed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "resume-after-restart",
            "method": "thread/resume",
            "params": {"threadId": restored}
        }),
        1,
    );
    assert_eq!(
        resumed[0]["result"]["turns"]
            .as_array()
            .expect("restored turns")
            .len(),
        2
    );
    assert_eq!(
        resumed[0]["result"]["turns"][0]["id"],
        "00000000-0001-7000-8000-000000000002"
    );
    assert_eq!(
        resumed[0]["result"]["turns"][1]["id"],
        "00000000-0001-7000-8000-000000000003"
    );
    let next_turn = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "turn-after-restart",
            "method": "turn/start",
            "params": {"threadId": restored, "input": [{"type":"text","text":"Hello"}]}
        }),
        8,
    );
    assert_eq!(
        next_turn[0]["result"]["turn"]["id"],
        "00000000-0001-7000-8000-000000000004"
    );
    assert_eq!(
        next_turn[4]["params"]["item"]["id"],
        "00000000-0002-7000-8000-000000000008"
    );

    let stderr = second.finish_with_diagnostics();
    assert!(stderr.contains("thread-search.sqlite3"));
    assert!(stderr.contains("thread search rebuild"));
    assert!(stderr.contains("invalidHeaderRecovered"));
    assert!(!stderr.contains(sentinel));
    assert!(!stderr.contains("SugarCode deterministic response."));
}

#[test]
fn deletes_across_two_processes_and_rebuilds_both_projections_from_rollouts() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let mut first = RunningServer::spawn(home.path());
    first.initialize();
    for sequence in 1..=3 {
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": format!("thread-{sequence}"),
                "method": "thread/start",
                "params": {}
            }),
            2,
        );
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": format!("turn-{sequence}"),
                "method": "turn/start",
                "params": {"threadId": format!("00000000-0000-7000-8000-{sequence:012}"), "input": [{"type":"text","text":"Hello"}]}
            }),
            8,
        );
    }

    assert_eq!(
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": "delete-active",
                "method": "thread/delete",
                "params": {"workspaceId": "unbound", "threadId": "00000000-0000-7000-8000-000000000001"}
            }),
            1,
        )[0]["result"],
        json!({})
    );
    assert_eq!(
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": "archive",
                "method": "thread/archive",
                "params": {"threadId": "00000000-0000-7000-8000-000000000002"}
            }),
            1,
        )[0]["result"],
        json!({})
    );
    assert_eq!(
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": "delete-archived",
                "method": "thread/delete",
                "params": {"workspaceId": "unbound", "threadId": "00000000-0000-7000-8000-000000000002"}
            }),
            1,
        )[0]["result"],
        json!({})
    );
    assert_eq!(
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": "delete-again",
                "method": "thread/delete",
                "params": {"workspaceId": "unbound", "threadId": "00000000-0000-7000-8000-000000000001"}
            }),
            1,
        )[0]["result"],
        json!({})
    );
    assert_deleted_views(&mut first, "first");
    first.finish();

    let projections = home.path().join("projections/v1");
    fs::remove_file(projections.join("thread-discovery.sqlite3"))
        .expect("remove discovery projection");
    let search_projection = projections.join("thread-search.sqlite3");
    let sentinel = "deleted-search-corruption-secret-must-not-leak";
    fs::write(&search_projection, sentinel).expect("corrupt search projection");

    let mut second = RunningServer::spawn(home.path());
    second.initialize();
    assert_deleted_views(&mut second, "second");
    for (request_id, method) in [
        ("resume-deleted", "thread/resume"),
        ("archive-deleted", "thread/archive"),
        ("unarchive-deleted", "thread/unarchive"),
        ("turn-deleted", "turn/start"),
    ] {
        let params = if method == "turn/start" {
            json!({"threadId": "00000000-0000-7000-8000-000000000001", "input": [{"type":"text","text":"Hello"}]})
        } else {
            json!({"threadId": "00000000-0000-7000-8000-000000000001"})
        };
        let response = second.send(
            json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params
            }),
            1,
        );
        assert_eq!(response[0]["error"]["code"], -32004);
        assert_eq!(
            response[0]["error"]["data"],
            json!({"threadId": "00000000-0000-7000-8000-000000000001"})
        );
    }

    let next = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "thread-4",
            "method": "thread/start",
            "params": {}
        }),
        2,
    );
    assert_eq!(
        next[0]["result"]["thread"]["id"],
        "00000000-0000-7000-8000-000000000004"
    );
    let next_turn = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "turn-4",
            "method": "turn/start",
            "params": {"threadId": "00000000-0000-7000-8000-000000000004", "input": [{"type":"text","text":"Hello"}]}
        }),
        8,
    );
    assert_eq!(
        next_turn[0]["result"]["turn"]["id"],
        "00000000-0001-7000-8000-000000000004"
    );
    assert_eq!(
        next_turn[4]["params"]["item"]["id"],
        "00000000-0002-7000-8000-000000000008"
    );

    let stderr = second.finish_with_diagnostics();
    assert!(stderr.contains("thread-search.sqlite3"));
    assert!(stderr.contains("thread search rebuild"));
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
