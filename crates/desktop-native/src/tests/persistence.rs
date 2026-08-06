use base64::Engine;
use rusqlite::Connection;
use serde_json::Value;

use super::NativeRuntime;
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
fn native_asset_store_persists_metadata_and_verifies_content() {
    let directory = tempfile::tempdir().expect("tempdir");
    let runtime = NativeRuntime::open(directory.path().to_string_lossy().into_owned())
        .expect("native runtime");
    let imported: Value = serde_json::from_str(
        &runtime
            .import_asset_json(
                "fixture.txt".to_owned(),
                Some("text/plain".to_owned()),
                base64::engine::general_purpose::STANDARD.encode(b"fixture"),
            )
            .expect("import asset"),
    )
    .expect("asset JSON");
    assert_eq!(imported["kind"], "text");
    assert_eq!(imported["sizeBytes"], 7);
    let asset_id = imported["assetId"].as_str().expect("asset id");
    let loaded: Value = serde_json::from_str(
        &runtime
            .read_asset_json(asset_id.to_owned())
            .expect("read asset"),
    )
    .expect("loaded asset JSON");
    assert_eq!(loaded["asset"], imported);
    assert_eq!(loaded["data"], "Zml4dHVyZQ==");
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
fn thread_index_mutations_are_workspace_bound_and_durable() {
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
    store
        .append_item(
            "item-1",
            "turn-1",
            1,
            "turn.userMessage",
            r#"{"content":[{"type":"text","text":"Hello"}]}"#,
        )
        .expect("user item");
    store
        .finish_turn("turn-1", "completed", None)
        .expect("finish turn");

    let fork: Value = serde_json::from_str(
        &store
            .fork_thread_json("thread-1", "workspace-1")
            .expect("fork thread"),
    )
    .expect("fork JSON");
    let fork_id = fork["thread"]["id"].as_str().expect("fork id");
    assert_ne!(fork_id, "thread-1");
    assert_eq!(fork["thread"]["parentThreadId"], "thread-1");
    assert_eq!(fork["turns"].as_array().map(Vec::len), Some(1));

    let listed: Value = serde_json::from_str(
        &store
            .list_threads_json("workspace-1", Some("Fixture"))
            .expect("list threads"),
    )
    .expect("list JSON");
    assert_eq!(listed.as_array().map(Vec::len), Some(2));

    store
        .set_thread_archived_json(fork_id, "workspace-1", true)
        .expect("archive thread");
    let listed: Value = serde_json::from_str(
        &store
            .list_threads_json("workspace-1", None)
            .expect("list active threads"),
    )
    .expect("list JSON");
    assert_eq!(listed.as_array().map(Vec::len), Some(1));
    store
        .set_thread_archived_json(fork_id, "workspace-1", false)
        .expect("restore thread");
    assert!(
        store
            .delete_thread(fork_id, "workspace-1")
            .expect("delete thread")
    );
    assert!(
        !store
            .delete_thread(fork_id, "workspace-1")
            .expect("idempotent absent delete")
    );
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
            .is_err(),
        "an approved operation cannot complete before native dispatch begins"
    );
    assert!(
        store
            .begin_operation("operation-1")
            .expect("begin operation")
    );
    assert!(
        !store
            .begin_operation("operation-1")
            .expect("same operation claim")
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

#[test]
fn model_configuration_is_revisioned_and_never_echoes_credentials() {
    let directory = tempfile::tempdir().expect("tempdir");
    let mut store = Store::open(directory.path()).expect("open v3 store");
    let initial: Value = serde_json::from_str(
        &store
            .inspect_model_config_json()
            .expect("initial inspection"),
    )
    .expect("inspection JSON");
    let config = serde_json::json!({
        "defaultProfileId": "profile-1",
        "connections": [{
            "id": "connection-1",
            "providerFamily": "openai",
            "displayName": "Fixture",
            "baseUrl": "https://example.invalid/v1",
            "enabled": true,
            "wireApi": "openaiResponses",
            "continuationMode": "localReplay"
        }],
        "profiles": [{
            "id": "profile-1",
            "connectionId": "connection-1",
            "displayName": "Fixture",
            "modelId": "fixture-model",
            "toolCalls": "enabled",
            "strictTools": "auto",
            "parallelTools": "disabled",
            "imageInput": "disabled",
            "pdfInput": "disabled"
        }]
    });
    let updates = serde_json::json!([{
        "action": "set",
        "connectionId": "connection-1",
        "value": "fixture-secret"
    }]);
    let action: Value = serde_json::from_str(
        &store
            .save_model_config_json(
                initial["revision"].as_str().expect("revision"),
                &config.to_string(),
                &updates.to_string(),
            )
            .expect("save model config"),
    )
    .expect("action JSON");
    assert_eq!(action["accepted"], true);
    assert_eq!(
        action["inspection"]["credentialStatuses"][0]["status"],
        "present"
    );
    assert!(!action.to_string().contains("fixture-secret"));

    let resolved: Value = serde_json::from_str(
        &store
            .model_profile_json(Some("profile-1"))
            .expect("resolve profile"),
    )
    .expect("profile JSON");
    assert_eq!(resolved["apiKey"], "fixture-secret");

    let stale: Value = serde_json::from_str(
        &store
            .save_model_config_json(
                initial["revision"].as_str().expect("old revision"),
                &config.to_string(),
                &serde_json::json!([{
                    "action": "preserve",
                    "connectionId": "connection-1"
                }])
                .to_string(),
            )
            .expect("stale save"),
    )
    .expect("stale JSON");
    assert_eq!(stale["reason"], "stale");
}

#[test]
fn schema_one_database_migrates_to_model_configuration_schema() {
    let directory = tempfile::tempdir().expect("tempdir");
    {
        let _store = Store::open(directory.path()).expect("open v3 store");
    }
    let database_path = Store::database_path(directory.path());
    let connection = Connection::open(&database_path).expect("database");
    connection
        .execute_batch(
            "PRAGMA foreign_keys = OFF;
             DROP TABLE model_credentials;
             DROP TABLE model_config;
             DROP TABLE content_assets;
             DROP INDEX threads_workspace_archive_updated;
             CREATE TABLE threads_v1 (
               id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
               title TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()),
               updated_at INTEGER NOT NULL DEFAULT (unixepoch())
             ) STRICT;
             INSERT INTO threads_v1 (id, workspace_id, title, created_at, updated_at)
               SELECT id, workspace_id, title, created_at, updated_at FROM threads;
             DROP TABLE threads;
             ALTER TABLE threads_v1 RENAME TO threads;
             CREATE INDEX threads_workspace_updated ON threads(workspace_id, updated_at DESC);
             PRAGMA user_version = 1;",
        )
        .expect("downgrade fixture");
    drop(connection);

    let mut reopened = Store::open(directory.path()).expect("migrate schema one");
    let inspection: Value = serde_json::from_str(
        &reopened
            .inspect_model_config_json()
            .expect("inspection after migration"),
    )
    .expect("inspection JSON");
    assert!(inspection["config"].is_null());
    let connection = Connection::open(database_path).expect("database");
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("schema version");
    assert_eq!(version, 4);
}
