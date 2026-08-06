use rusqlite::Connection;
use serde_json::Value;

use super::persistence::Store;

fn seeded_store(directory: &tempfile::TempDir) -> Store {
    let mut store = Store::open(directory.path()).expect("open v3 store");
    store
        .ensure_workspace("workspace-1", "/fixture/workspace")
        .expect("workspace");
    store
        .ensure_thread("thread-1", "workspace-1", Some("Fixture"))
        .expect("thread");
    store
}

#[test]
fn persists_provider_neutral_thread_history_and_deduplicates_items() {
    let directory = tempfile::tempdir().expect("tempdir");
    let mut store = seeded_store(&directory);
    store
        .start_turn(
            "turn-1",
            "thread-1",
            "request-1",
            "openaiResponses",
            "fixture-model",
        )
        .expect("start turn");
    assert!(
        store
            .append_item(
                "item-1",
                "turn-1",
                1,
                "assistantText",
                r#"{"text":"Hello"}"#,
            )
            .expect("append item")
    );
    assert!(
        !store
            .append_item(
                "item-1",
                "turn-1",
                1,
                "assistantText",
                r#"{"text":"Hello"}"#,
            )
            .expect("deduplicate item")
    );
    assert!(
        store
            .finish_turn("turn-1", "completed", None)
            .expect("finish turn")
    );
    let snapshot: Value =
        serde_json::from_str(&store.load_thread_json("thread-1").expect("load thread"))
            .expect("snapshot JSON");
    assert_eq!(snapshot["turns"][0]["status"], "completed");
    assert_eq!(snapshot["items"][0]["payload"]["text"], "Hello");
}

#[test]
fn approval_and_operation_ids_are_idempotent_but_cannot_be_reused() {
    let directory = tempfile::tempdir().expect("tempdir");
    let mut store = seeded_store(&directory);
    store
        .start_turn(
            "turn-1",
            "thread-1",
            "request-1",
            "anthropicMessages",
            "fixture-model",
        )
        .expect("start turn");
    assert!(
        store
            .propose_operation(
                "operation-1",
                "approval-1",
                "turn-1",
                "workspace_patch",
                "sha256:fixture",
                r#"{"patch":"fixture"}"#,
            )
            .expect("proposal")
    );
    assert!(
        !store
            .propose_operation(
                "operation-1",
                "approval-1",
                "turn-1",
                "workspace_patch",
                "sha256:fixture",
                r#"{"patch":"fixture"}"#,
            )
            .expect("same proposal")
    );
    assert!(
        store
            .resolve_approval("approval-1", "approved")
            .expect("approve")
    );
    assert!(
        !store
            .resolve_approval("approval-1", "approved")
            .expect("same approval")
    );
    assert!(
        store
            .complete_operation("operation-1", r#"{"changed":true}"#, true)
            .expect("complete")
    );
    assert!(
        !store
            .complete_operation("operation-1", r#"{"changed":true}"#, true)
            .expect("same completion")
    );
    assert!(store.resolve_approval("approval-1", "denied").is_err());
}

#[test]
fn reopening_marks_running_work_interrupted_without_resolving_pending_approval() {
    let directory = tempfile::tempdir().expect("tempdir");
    {
        let mut store = seeded_store(&directory);
        store
            .start_turn(
                "turn-1",
                "thread-1",
                "request-1",
                "openaiChatCompletions",
                "fixture-model",
            )
            .expect("start turn");
        store
            .propose_operation(
                "operation-1",
                "approval-1",
                "turn-1",
                "shell_command",
                "sha256:fixture",
                r#"{"command":"pwd"}"#,
            )
            .expect("proposal");
    }
    let mut reopened = Store::open(directory.path()).expect("reopen v3 store");
    let snapshot: Value =
        serde_json::from_str(&reopened.load_thread_json("thread-1").expect("load thread"))
            .expect("snapshot JSON");
    assert_eq!(snapshot["turns"][0]["status"], "interrupted");
    assert!(snapshot["turns"][0]["errorJson"].is_string());

    let connection = Connection::open(Store::database_path(directory.path())).expect("database");
    let approval_status: String = connection
        .query_row(
            "SELECT status FROM approvals WHERE id = 'approval-1'",
            [],
            |row| row.get(0),
        )
        .expect("approval status");
    assert_eq!(approval_status, "pending");
}
