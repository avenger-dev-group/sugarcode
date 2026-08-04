use super::*;

#[test]
fn forks_complete_history_across_processes_with_independent_lifecycle_and_ids() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let mut first = RunningServer::spawn(home.path());
    first.initialize();

    first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "source",
            "method": "thread/start"
        }),
        2,
    );
    for sequence in 1..=2 {
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": format!("source-turn-{sequence}"),
                "method": "turn/start",
                "params": {"threadId": "00000000-0000-7000-8000-000000000001", "input": [{"type":"text","text":"Hello"}]}
            }),
            8,
        );
    }

    let source_rollout = rollout_path(home.path(), 1);
    let source_before_fork = fs::read(&source_rollout).expect("read source rollout before fork");
    let forked = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "fork",
            "method": "thread/fork",
            "params": {"threadId": "00000000-0000-7000-8000-000000000001"}
        }),
        2,
    );
    assert_eq!(
        forked[0]["result"]["thread"]["id"],
        "00000000-0000-7000-8000-000000000002"
    );
    assert_eq!(
        forked[0]["result"]["turns"][0]["id"],
        "00000000-0001-7000-8000-000000000003"
    );
    assert_eq!(
        forked[0]["result"]["turns"][0]["items"][0]["id"],
        "00000000-0002-7000-8000-000000000005"
    );
    assert_eq!(
        forked[0]["result"]["turns"][1]["id"],
        "00000000-0001-7000-8000-000000000004"
    );
    assert_eq!(
        forked[0]["result"]["turns"][1]["items"][0]["id"],
        "00000000-0002-7000-8000-000000000007"
    );
    assert_eq!(forked[1]["method"], "thread/started");
    assert_eq!(
        fs::read(&source_rollout).expect("read source rollout after fork"),
        source_before_fork,
        "forking must not append to or rewrite the source rollout"
    );

    assert_eq!(
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": "archive-fork",
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
                "id": "resume-hidden-fork",
                "method": "thread/resume",
                "params": {"threadId": "00000000-0000-7000-8000-000000000002"}
            }),
            1,
        )[0]["error"]["code"],
        -32004
    );
    assert_eq!(
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": "resume-source",
                "method": "thread/resume",
                "params": {"threadId": "00000000-0000-7000-8000-000000000001"}
            }),
            1,
        )[0]["result"]["turns"]
            .as_array()
            .expect("source turns")
            .len(),
        2
    );
    assert_eq!(
        first.send(
            json!({
                "jsonrpc": "2.0",
                "id": "unarchive-fork",
                "method": "thread/unarchive",
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
                "id": "delete-source",
                "method": "thread/delete",
                "params": {"workspaceId": "unbound", "threadId": "00000000-0000-7000-8000-000000000001"}
            }),
            1,
        )[0]["result"],
        json!({})
    );
    let continued = first.send(
        json!({
            "jsonrpc": "2.0",
            "id": "continue-fork",
            "method": "turn/start",
            "params": {"threadId": "00000000-0000-7000-8000-000000000002", "input": [{"type":"text","text":"Hello"}]}
        }),
        8,
    );
    assert_eq!(
        continued[0]["result"]["turn"]["id"],
        "00000000-0001-7000-8000-000000000005"
    );
    assert_eq!(
        continued[4]["params"]["item"]["id"],
        "00000000-0002-7000-8000-000000000010"
    );
    first.finish();

    let projections = home.path().join("projections/v1");
    fs::remove_file(projections.join("thread-discovery.sqlite3"))
        .expect("remove discovery projection");
    let search_projection = projections.join("thread-search.sqlite3");
    let sentinel = "fork-search-corruption-secret-must-not-leak";
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
        json!([{"id": "00000000-0000-7000-8000-000000000002"}])
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
        json!([{"id": "00000000-0000-7000-8000-000000000002"}])
    );
    let resumed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "resume-fork-after-restart",
            "method": "thread/resume",
            "params": {"threadId": "00000000-0000-7000-8000-000000000002"}
        }),
        1,
    );
    assert_eq!(
        resumed[0]["result"]["turns"]
            .as_array()
            .expect("fork turns")
            .len(),
        3
    );
    for (index, sequence) in (3..=5).enumerate() {
        assert_eq!(
            resumed[0]["result"]["turns"][index]["id"],
            format!("00000000-0001-7000-8000-{sequence:012}")
        );
        assert_eq!(
            resumed[0]["result"]["turns"][index]["items"][0]["id"],
            format!("00000000-0002-7000-8000-{:012}", sequence * 2 - 1)
        );
    }
    assert_eq!(
        second.send(
            json!({
                "jsonrpc": "2.0",
                "id": "fork-deleted-source",
                "method": "thread/fork",
                "params": {"threadId": "00000000-0000-7000-8000-000000000001"}
            }),
            1,
        )[0]["error"]["code"],
        -32004
    );
    let next_turn = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "fork-turn-after-restart",
            "method": "turn/start",
            "params": {"threadId": "00000000-0000-7000-8000-000000000002", "input": [{"type":"text","text":"Hello"}]}
        }),
        8,
    );
    assert_eq!(
        next_turn[0]["result"]["turn"]["id"],
        "00000000-0001-7000-8000-000000000006"
    );
    assert_eq!(
        next_turn[4]["params"]["item"]["id"],
        "00000000-0002-7000-8000-000000000012"
    );
    let next_thread = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "next-thread",
            "method": "thread/start"
        }),
        2,
    );
    assert_eq!(
        next_thread[0]["result"]["thread"]["id"],
        "00000000-0000-7000-8000-000000000003"
    );
    let other_turn = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "other-turn",
            "method": "turn/start",
            "params": {"threadId": "00000000-0000-7000-8000-000000000003", "input": [{"type":"text","text":"Hello"}]}
        }),
        8,
    );
    assert_eq!(
        other_turn[0]["result"]["turn"]["id"],
        "00000000-0001-7000-8000-000000000007"
    );
    assert_eq!(
        other_turn[4]["params"]["item"]["id"],
        "00000000-0002-7000-8000-000000000014"
    );

    let stderr = second.finish_with_diagnostics();
    assert!(stderr.contains("thread-search.sqlite3"));
    assert!(stderr.contains("thread search rebuild"));
    assert!(stderr.contains("invalidHeaderRecovered"));
    assert!(!stderr.contains(sentinel));
    assert!(!stderr.contains("SugarCode deterministic response."));
}
