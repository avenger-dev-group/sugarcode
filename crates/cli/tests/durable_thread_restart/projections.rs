use super::*;

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
            "params": {"threadId": thread_id, "input": [{"type":"text","text":"Hello"}]}
        }),
        8,
    );
    let expected_item = lifecycle[6]["params"]["item"].clone();
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
    assert_eq!(resumed[0]["result"]["turns"][0]["items"][1], expected_item);
    let stderr = second.finish_with_diagnostics();
    assert!(stderr.contains("thread-discovery.sqlite3"));
    assert!(stderr.contains("thread discovery rebuild"));
    assert!(stderr.contains("invalidHeaderRecovered"));
    assert!(!stderr.contains(sentinel));
    assert!(!stderr.contains("SugarCode deterministic response."));
}

#[test]
fn rebuilds_search_across_processes_without_affecting_list_or_resume() {
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
                    "params": {
                        "threadId": format!("00000000-0000-7000-8000-{sequence:012}"),
                        "input": [{"type":"text","text":"Hello"}]
                    }
                }),
                8,
            );
        }
    }
    first.finish();

    let projection = home.path().join("projections/v1/thread-search.sqlite3");
    let corruption_sentinel = "search-corruption-secret-must-not-leak";
    fs::write(&projection, corruption_sentinel).expect("corrupt search projection");

    let mut second = RunningServer::spawn(home.path());
    second.initialize();
    let query_sentinel = "private-query-sentinel";
    let empty = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "private-search",
            "method": "thread/search",
            "params": {"query": query_sentinel}
        }),
        1,
    );
    assert_eq!(empty[0]["result"]["data"], json!([]));
    let searched = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "search",
            "method": "thread/search",
            "params": {"query": "SugarCode deterministic", "limit": 50}
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
    assert_eq!(searched[0]["result"]["nextCursor"], Value::Null);

    let listed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "list",
            "method": "thread/list"
        }),
        1,
    );
    assert_eq!(
        listed[0]["result"]["data"]
            .as_array()
            .expect("threads")
            .len(),
        3
    );
    let resumed = second.send(
        json!({
            "jsonrpc": "2.0",
            "id": "resume",
            "method": "thread/resume",
            "params": {"threadId": "00000000-0000-7000-8000-000000000001"}
        }),
        1,
    );
    assert_eq!(
        resumed[0]["result"]["turns"][0]["items"][1]["text"],
        "SugarCode deterministic response."
    );

    let stderr = second.finish_with_diagnostics();
    assert!(stderr.contains("thread-search.sqlite3"));
    assert!(stderr.contains("thread search rebuild"));
    assert!(stderr.contains("invalidHeaderRecovered"));
    assert!(!stderr.contains(corruption_sentinel));
    assert!(!stderr.contains(query_sentinel));
    assert!(
        !fs::read(&projection)
            .expect("read rebuilt projection")
            .windows(query_sentinel.len())
            .any(|window| window == query_sentinel.as_bytes())
    );
}
