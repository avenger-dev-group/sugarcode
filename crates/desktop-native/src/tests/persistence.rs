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
fn thread_title_generation_is_conditional_and_manual_rename_is_authoritative() {
    let directory = tempfile::tempdir().expect("tempdir");
    let mut store = seeded_store(&directory);
    let unchanged: Value = serde_json::from_str(
        &store
            .update_thread_title_json("thread-1", "workspace-1", "Generated", true)
            .expect("conditional title"),
    )
    .expect("unchanged snapshot");
    assert_eq!(unchanged["thread"]["title"], "Fixture");

    let renamed: Value = serde_json::from_str(
        &store
            .update_thread_title_json("thread-1", "workspace-1", "Manual title", false)
            .expect("manual title"),
    )
    .expect("renamed snapshot");
    assert_eq!(renamed["thread"]["title"], "Manual title");

    store
        .ensure_thread("thread-untitled", "workspace-1", None)
        .expect("untitled thread");
    let generated: Value = serde_json::from_str(
        &store
            .update_thread_title_json("thread-untitled", "workspace-1", "Generated title", true)
            .expect("generated title"),
    )
    .expect("generated snapshot");
    assert_eq!(generated["thread"]["title"], "Generated title");
}

#[test]
fn skill_preferences_are_durable_and_reject_malformed_identifiers() {
    let directory = tempfile::tempdir().expect("tempdir");
    let skill_id = format!("skl_{}", "a".repeat(64));
    {
        let mut store = Store::open(directory.path()).expect("open store");
        store
            .set_skill_enabled(&skill_id, false)
            .expect("disable Skill");
        assert!(
            store
                .set_skill_enabled(&format!("skl_{}", "z".repeat(64)), true)
                .is_err()
        );
    }
    let mut reopened = Store::open(directory.path()).expect("reopen store");
    assert_eq!(
        reopened
            .skill_preferences()
            .expect("preferences")
            .get(&skill_id),
        Some(&false)
    );
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

#[tokio::test]
async fn native_workspace_patch_receipt_retains_reviewable_diff_metadata() {
    let directory = tempfile::tempdir().expect("data directory");
    let workspace = tempfile::tempdir().expect("workspace");
    std::fs::write(workspace.path().join("notes.txt"), "before\n").expect("seed file");
    let runtime = NativeRuntime::open(directory.path().to_string_lossy().into_owned())
        .expect("native runtime");
    runtime
        .ensure_workspace(
            "workspace-1".to_owned(),
            workspace.path().to_string_lossy().into_owned(),
        )
        .expect("register workspace");

    let result: Value = serde_json::from_str(
        &runtime
            .workspace_apply_patch(
                "workspace-1".to_owned(),
                concat!(
                    "*** Begin Patch\n",
                    "*** Update File: notes.txt\n",
                    "-before\n",
                    "+after\n",
                    "*** End Patch",
                )
                .to_owned(),
            )
            .await
            .expect("apply patch"),
    )
    .expect("patch result JSON");

    assert_eq!(result["ok"], true, "patch failed: {result}");
    assert_eq!(result["files"][0]["path"], "notes.txt");
    assert_eq!(result["files"][0]["newlineStyle"], "lf");
    assert_eq!(result["files"][0]["finalNewline"], true);
    assert!(
        result["files"][0]["diff"]
            .as_str()
            .is_some_and(|diff| diff.contains("-before\n+after"))
    );
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
fn thread_index_delete_is_workspace_bound_and_durable() {
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

    let listed: Value = serde_json::from_str(
        &store
            .list_threads_json("workspace-1", Some("Fixture"))
            .expect("list threads"),
    )
    .expect("list JSON");
    assert_eq!(listed.as_array().map(Vec::len), Some(1));
    assert!(
        store
            .delete_thread("thread-1", "workspace-1")
            .expect("delete thread")
    );
    assert!(
        !store
            .delete_thread("thread-1", "workspace-1")
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
                r#"{"kind":"command","argumentsSummary":"workspace patch","fullAccess":false}"#,
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
                r#"{"kind":"command","argumentsSummary":"workspace patch","fullAccess":false}"#,
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
fn agent_task_dag_state_is_durable_and_restart_interrupts_unfinished_work() {
    let directory = tempfile::tempdir().expect("tempdir");
    {
        let mut store = seeded_store(&directory);
        store
            .start_turn(
                "turn-agent",
                "thread-1",
                "request-agent",
                "openaiResponses",
                "fixture-model",
            )
            .expect("start Agent turn");
        let queued = serde_json::json!({
            "orchestrationId": "orch/thread-1/turn-agent",
            "taskId": "task-worker",
            "clientTaskKey": "worker",
            "childThreadId": "child-worker",
            "title": "Implement",
            "role": "worker",
            "access": "workspaceWrite",
            "dependsOn": [],
            "taskMarkdown": "Implement the change.",
            "status": "queued",
            "amendments": []
        });
        store
            .create_agent_tasks_json(
                "turn-agent",
                &serde_json::to_string(&vec![serde_json::json!({
                    "id": "task-worker",
                    "parentTaskId": null,
                    "title": "Implement",
                    "status": "queued",
                    "payload": queued
                })])
                .expect("task batch JSON"),
            )
            .expect("create task");
        let mut running = queued.clone();
        running["status"] = Value::String("running".to_owned());
        assert!(
            store
                .update_agent_task(
                    "task-worker",
                    "running",
                    &serde_json::to_string(&running).expect("running JSON"),
                )
                .expect("run task")
        );
        running["amendments"] = serde_json::json!([{
            "id": "amendment-1",
            "markdown": "Also add a regression test."
        }]);
        assert!(
            store
                .update_agent_task(
                    "task-worker",
                    "running",
                    &serde_json::to_string(&running).expect("amendment JSON"),
                )
                .expect("persist amendment")
        );
    }

    let mut reopened = Store::open(directory.path()).expect("recover store");
    let snapshot: Value = serde_json::from_str(
        &reopened
            .load_thread_json("thread-1")
            .expect("load recovered Thread"),
    )
    .expect("snapshot JSON");
    assert_eq!(snapshot["turns"][0]["status"], "interrupted");
    assert_eq!(snapshot["agentTasks"][0]["status"], "interrupted");
    assert_eq!(
        snapshot["agentTasks"][0]["payload"]["taskId"],
        "task-worker"
    );
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
                r#"{"kind":"command","argumentsSummary":"pwd","fullAccess":false}"#,
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
    let pending: Value = serde_json::from_str(
        &reopened
            .list_pending_approvals_json()
            .expect("list pending approvals"),
    )
    .expect("pending approval JSON");
    assert_eq!(pending.as_array().map(Vec::len), Some(1));
    assert_eq!(pending[0]["approvalId"], "approval-1");
    assert_eq!(pending[0]["workspaceId"], "workspace-1");
    assert_eq!(pending[0]["approval"]["kind"], "command");
}

#[test]
fn reopening_never_requeues_an_approved_operation_claim() {
    let directory = tempfile::tempdir().expect("tempdir");
    {
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
            .propose_operation(
                "operation-1",
                "approval-1",
                "turn-1",
                "workspace_apply_patch",
                "sha256:fixture",
                r#"{"patch":"fixture"}"#,
                r#"{"kind":"command","argumentsSummary":"patch","fullAccess":false}"#,
            )
            .expect("proposal");
        store
            .resolve_approval("approval-1", "approved")
            .expect("atomically approve and claim operation");
    }

    let mut reopened = Store::open(directory.path()).expect("recover store");
    let pending: Value = serde_json::from_str(
        &reopened
            .list_pending_approvals_json()
            .expect("list pending approvals"),
    )
    .expect("pending JSON");
    assert_eq!(pending.as_array().map(Vec::len), Some(0));
    let connection = Connection::open(Store::database_path(directory.path())).expect("database");
    let statuses: (String, String) = connection
        .query_row(
            "SELECT a.status, o.status FROM approvals a \
             JOIN operations o ON o.id = a.operation_id WHERE a.id = 'approval-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("approval and operation statuses");
    assert_eq!(statuses, ("approved".to_owned(), "failed".to_owned()));
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
fn mcp_configuration_is_validated_revisioned_and_persisted_in_v3_sqlite() {
    let directory = tempfile::tempdir().expect("tempdir");
    let mut store = Store::open(directory.path()).expect("open v3 store");
    let initial: Value =
        serde_json::from_str(&store.inspect_mcp_config_json().expect("inspect MCP config"))
            .expect("MCP inspection JSON");
    assert_eq!(initial["contractVersion"], 1);
    assert_eq!(initial["servers"], serde_json::json!([]));

    #[cfg(not(windows))]
    let (executable, cwd) = ("/usr/bin/env", "/tmp");
    #[cfg(windows)]
    let (executable, cwd) = (r"C:\Program Files\nodejs\node.exe", r"C:\workspace");
    let servers = serde_json::json!([{
        "id": "fixture",
        "transport": "stdio",
        "executable": executable,
        "argv": ["node", "server.mjs"],
        "cwd": cwd
    }]);
    let saved: Value = serde_json::from_str(
        &store
            .save_mcp_config_json(
                initial["revision"].as_str().expect("initial revision"),
                &servers.to_string(),
            )
            .expect("save MCP config"),
    )
    .expect("MCP save JSON");
    assert_eq!(saved["accepted"], true);
    assert_eq!(saved["inspection"]["servers"], servers);

    let stale: Value = serde_json::from_str(
        &store
            .save_mcp_config_json(initial["revision"].as_str().expect("old revision"), "[]")
            .expect("stale MCP save"),
    )
    .expect("stale MCP JSON");
    assert_eq!(stale["reason"], "stale");

    drop(store);
    let mut reopened = Store::open(directory.path()).expect("reopen v3 store");
    let persisted: Value = serde_json::from_str(
        &reopened
            .inspect_mcp_config_json()
            .expect("persisted MCP config"),
    )
    .expect("persisted MCP JSON");
    assert_eq!(persisted["servers"], servers);
    assert!(reopened
        .save_mcp_config_json(
            persisted["revision"].as_str().expect("persisted revision"),
            r#"[{"id":"remote","transport":"loopbackStreamableHttp","endpoint":"https://example.com/mcp"}]"#,
        )
        .is_err());
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
             DROP TABLE mcp_config;
             DROP TABLE skill_preferences;
             ALTER TABLE approvals DROP COLUMN payload_json;
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
    assert_eq!(version, 8);
}
