use base64::Engine;
use rusqlite::Connection;
use serde_json::Value;

use super::NativeRuntime;
use super::persistence::Store;

fn quicktime_fixture() -> Vec<u8> {
    vec![
        0x00, 0x00, 0x00, 0x14, b'f', b't', b'y', b'p', b'q', b't', b' ', b' ', 0x00, 0x00, 0x00,
        0x00, b'q', b't', b' ', b' ',
    ]
}

fn import_quicktime_fixture(directory: &tempfile::TempDir) -> Value {
    let video_path = directory.path().join("录屏.mov");
    std::fs::write(&video_path, quicktime_fixture()).expect("video fixture");
    let runtime = NativeRuntime::open(directory.path().join("data").to_string_lossy().into_owned())
        .expect("native runtime");
    let imported: Value = serde_json::from_str(
        &runtime
            .import_video_path_json(
                "录屏.mov".to_owned(),
                Some("video/quicktime".to_owned()),
                video_path.to_string_lossy().into_owned(),
            )
            .expect("import video path"),
    )
    .expect("video descriptor JSON");
    let stored: Value = serde_json::from_str(
        &runtime
            .read_video_asset_path_json(
                imported["assetId"]
                    .as_str()
                    .expect("video asset ID")
                    .to_owned(),
            )
            .expect("read verified video path"),
    )
    .expect("stored video JSON");
    assert_eq!(stored["asset"], imported);
    imported
}

#[test]
fn native_runtime_imports_and_persists_video_paths() {
    let directory = tempfile::tempdir().expect("tempdir");
    let imported = import_quicktime_fixture(&directory);
    assert_eq!(imported["kind"], "video");
    assert_eq!(imported["mediaType"], "video/quicktime");
    assert_eq!(imported["sizeBytes"], 20);
}

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
fn durable_goals_enforce_cas_budget_soft_clear_and_restart_recovery() {
    let directory = tempfile::tempdir().expect("tempdir");
    let mut store = seeded_store(&directory);
    let created: Value = serde_json::from_str(
        &store
            .mutate_goal_json(
                "thread-1",
                &serde_json::json!({
                    "action": "create",
                    "goalId": "goal-1",
                    "objective": "Ship durable Goal mode",
                    "modelProfileId": "default",
                    "modelRequest": {"reasoningEffort":"high","serviceTier":"auto"},
                    "budget": {"maxTokens": 10}
                })
                .to_string(),
            )
            .expect("create goal"),
    )
    .expect("goal JSON");
    assert_eq!(created["status"], "active");
    assert_eq!(created["revision"], 1);
    assert!(
        store
            .mutate_goal_json(
                "thread-1",
                &serde_json::json!({
                    "action":"edit",
                    "goalId":"goal-1",
                    "expectedRevision": 99,
                    "objective":"stale"
                })
                .to_string(),
            )
            .is_err()
    );

    let claimed: Value = serde_json::from_str(
        &store
            .claim_goal_turn_json(
                "goal-1",
                1,
                "turn-goal-1",
                "thread-1",
                "request-1",
                "openaiResponses",
                "fixture",
                &serde_json::json!({
                    "content":[{"type":"text","text":"hidden Goal context"}]
                })
                .to_string(),
            )
            .expect("claim goal turn"),
    )
    .expect("claimed JSON");
    assert_eq!(claimed["activeTurnId"], "turn-goal-1");
    let claimed_snapshot: Value = serde_json::from_str(
        &store
            .load_thread_json("thread-1")
            .expect("load claimed Goal Turn"),
    )
    .expect("claimed thread JSON");
    let objective_item = claimed_snapshot["items"]
        .as_array()
        .expect("claimed Turn items")
        .iter()
        .find(|item| item["kind"] == "turn.goalObjective")
        .expect("visible Goal objective");
    assert_eq!(
        objective_item["payload"]["content"][0]["text"],
        "Ship durable Goal mode"
    );
    let settled: Value = serde_json::from_str(
        &store
            .settle_goal_turn_json(
                "goal-1",
                1,
                "turn-goal-1",
                &serde_json::json!({
                    "status":"in_progress",
                    "summary":"implemented storage",
                    "nextStep":"wire runtime",
                    "evidence":[{
                        "kind":"artifact",
                        "label":"storage schema",
                        "result":"persisted"
                    }]
                })
                .to_string(),
                12,
                250,
            )
            .expect("settle goal turn"),
    )
    .expect("settled JSON");
    assert_eq!(settled["status"], "paused");
    assert_eq!(settled["pauseReason"], "budget");
    assert_eq!(settled["activationUsage"]["tokens"], 12);
    assert_eq!(settled["progress"]["evidence"][0]["kind"], "artifact");

    let resumed: Value = serde_json::from_str(
        &store
            .mutate_goal_json(
                "thread-1",
                &serde_json::json!({
                    "action":"resume",
                    "goalId":"goal-1",
                    "expectedRevision": settled["revision"]
                })
                .to_string(),
            )
            .expect("resume goal"),
    )
    .expect("resumed JSON");
    assert_eq!(resumed["activationUsage"]["tokens"], 0);
    assert_eq!(resumed["lifetimeUsage"]["tokens"], 12);
    drop(store);

    let mut reopened = Store::open(directory.path()).expect("reopen store");
    let recovered: Value = serde_json::from_str(
        &reopened
            .current_goal_json("thread-1")
            .expect("recovered goal"),
    )
    .expect("recovered JSON");
    assert_eq!(recovered["status"], "paused");
    assert_eq!(recovered["pauseReason"], "restart");
    let cleared: Value = serde_json::from_str(
        &reopened
            .mutate_goal_json(
                "thread-1",
                &serde_json::json!({
                    "action":"clear",
                    "goalId":"goal-1",
                    "expectedRevision": recovered["revision"]
                })
                .to_string(),
            )
            .expect("soft clear"),
    )
    .expect("cleared JSON");
    assert!(cleared.is_null());
    drop(reopened);
    let inspection =
        Connection::open(Store::database_path(directory.path())).expect("open goal database");
    let retained: i64 = inspection
        .query_row(
            "SELECT COUNT(*) FROM goals WHERE id = 'goal-1'",
            [],
            |row| row.get(0),
        )
        .expect("retained goal history");
    assert_eq!(retained, 1);
}

#[test]
fn durable_goal_objective_is_visible_only_on_the_first_automatic_turn() {
    let directory = tempfile::tempdir().expect("tempdir");
    let mut store = seeded_store(&directory);
    let created: Value = serde_json::from_str(
        &store
            .mutate_goal_json(
                "thread-1",
                &serde_json::json!({
                    "action": "create",
                    "goalId": "goal-visible",
                    "objective": "Visible once",
                    "modelProfileId": "default",
                    "modelRequest": {"reasoningEffort":"high","serviceTier":"auto"}
                })
                .to_string(),
            )
            .expect("create visible Goal"),
    )
    .expect("created Goal JSON");
    store
        .claim_goal_turn_json(
            "goal-visible",
            created["revision"].as_i64().expect("created revision"),
            "turn-visible-1",
            "thread-1",
            "request-visible-1",
            "openaiResponses",
            "fixture",
            &serde_json::json!({
                "content":[{"type":"text","text":"hidden Goal context"}]
            })
            .to_string(),
        )
        .expect("claim first visible Goal Turn");
    let settled: Value = serde_json::from_str(
        &store
            .settle_goal_turn_json(
                "goal-visible",
                created["revision"].as_i64().expect("claimed revision"),
                "turn-visible-1",
                &serde_json::json!({
                    "status":"in_progress",
                    "summary":"first checkpoint",
                    "nextStep":"continue"
                })
                .to_string(),
                0,
                1,
            )
            .expect("settle first visible Goal Turn"),
    )
    .expect("settled Goal JSON");
    store
        .claim_goal_turn_json(
            "goal-visible",
            settled["revision"].as_i64().expect("settled revision"),
            "turn-visible-2",
            "thread-1",
            "request-visible-2",
            "openaiResponses",
            "fixture",
            &serde_json::json!({
                "content":[{"type":"text","text":"next hidden Goal context"}]
            })
            .to_string(),
        )
        .expect("claim second visible Goal Turn");

    let snapshot: Value = serde_json::from_str(
        &store
            .load_thread_json("thread-1")
            .expect("load visible Goal thread"),
    )
    .expect("visible Goal thread JSON");
    let objective_items = snapshot["items"]
        .as_array()
        .expect("visible Goal items")
        .iter()
        .filter(|item| item["kind"] == "turn.goalObjective")
        .collect::<Vec<_>>();
    assert_eq!(objective_items.len(), 1);
    assert_eq!(objective_items[0]["turnId"], "turn-visible-1");
}

#[test]
fn schema_eighteen_database_migrates_to_durable_goals() {
    let directory = tempfile::tempdir().expect("tempdir");
    drop(seeded_store(&directory));
    let database_path = Store::database_path(directory.path());
    let connection = Connection::open(&database_path).expect("database");
    connection
        .execute_batch("DROP TABLE goals; PRAGMA user_version = 18;")
        .expect("downgrade to v18 fixture");
    drop(connection);

    drop(Store::open(directory.path()).expect("migrate v18 store"));
    let connection = Connection::open(database_path).expect("migrated database");
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("schema version");
    assert_eq!(version, 19);
    let goal_table: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'goals'",
            [],
            |row| row.get(0),
        )
        .expect("goal table");
    assert_eq!(goal_table, 1);
}

#[test]
fn durable_thread_queue_enforces_fifo_revisions_capacity_and_restart_pause() {
    let directory = tempfile::tempdir().expect("tempdir");
    let content = |index: usize| {
        serde_json::json!([{"type":"text","text":format!("queued {index}")}]).to_string()
    };
    {
        let mut store = seeded_store(&directory);
        for index in 1..=10 {
            let queue: Value = serde_json::from_str(
                &store
                    .create_queued_message_json(
                        "thread-1",
                        &format!("queue-{index}"),
                        &content(index),
                        Some("profile-1"),
                        Some(r#"{"reasoningEffort":"high","serviceTier":"fast"}"#),
                    )
                    .expect("enqueue"),
            )
            .expect("queue JSON");
            assert_eq!(queue["messages"].as_array().expect("messages").len(), index);
            assert_eq!(
                queue["messages"][index - 1]["modelRequest"]["reasoningEffort"],
                "high"
            );
            assert_eq!(
                queue["messages"][index - 1]["modelRequest"]["serviceTier"],
                "fast"
            );
        }
        assert!(
            store
                .create_queued_message_json("thread-1", "queue-11", &content(11), None, None)
                .expect_err("queue capacity")
                .to_string()
                .contains("queueFull")
        );

        let updated: Value = serde_json::from_str(
            &store
                .update_queued_message_json(
                    "thread-1",
                    "queue-1",
                    1,
                    &content(101),
                    Some("profile-2"),
                    Some(r#"{"reasoningEffort":"low","serviceTier":"standard"}"#),
                )
                .expect("update queue head"),
        )
        .expect("updated queue JSON");
        assert_eq!(updated["messages"][0]["revision"], 2);
        assert_eq!(
            updated["messages"][0]["modelRequest"]["reasoningEffort"],
            "low"
        );
        assert!(
            store
                .update_queued_message_json("thread-1", "queue-1", 1, &content(102), None, None)
                .expect_err("stale revision")
                .to_string()
                .contains("queueRevisionMismatch")
        );

        store
            .delete_queued_message_json("thread-1", "queue-2", 1)
            .expect("delete queued message");
        store
            .create_queued_message_json("thread-1", "queue-11", &content(11), None, None)
            .expect("reuse queue capacity");

        let promoted: Value = serde_json::from_str(
            &store
                .promote_queued_message_json(
                    "thread-1",
                    "queue-1",
                    2,
                    "turn-queued",
                    "request-queued",
                    "openaiResponses",
                    "fixture-model",
                )
                .expect("atomically promote queue head"),
        )
        .expect("promoted queue JSON");
        assert_eq!(promoted["message"]["id"], "queue-1");
        assert_eq!(promoted["queue"]["messages"][0]["id"], "queue-3");
        let steered: Value = serde_json::from_str(
            &store
                .steer_queued_message_json(
                    "thread-1",
                    "queue-3",
                    1,
                    "turn-queued",
                    "turn-queued:steer:queue-3",
                    5,
                )
                .expect("atomically steer queue head"),
        )
        .expect("steered queue JSON");
        assert_eq!(steered["message"]["id"], "queue-3");
        assert_eq!(steered["queue"]["messages"][0]["id"], "queue-4");
        let snapshot: Value =
            serde_json::from_str(&store.load_thread_json("thread-1").expect("thread snapshot"))
                .expect("snapshot JSON");
        assert_eq!(snapshot["turns"][0]["id"], "turn-queued");
        assert_eq!(snapshot["items"][0]["kind"], "turn.userMessage");
        assert_eq!(snapshot["items"].as_array().expect("items").len(), 2);
        assert_eq!(
            snapshot["queue"]["messages"]
                .as_array()
                .expect("queue")
                .len(),
            8
        );
    }

    let mut reopened = Store::open(directory.path()).expect("reopen store");
    let recovered: Value = serde_json::from_str(
        &reopened
            .load_thread_json("thread-1")
            .expect("recovered thread"),
    )
    .expect("recovered JSON");
    assert_eq!(recovered["turns"][0]["status"], "interrupted");
    assert_eq!(recovered["queue"]["paused"], true);
    assert!(
        reopened
            .delete_thread("thread-1", "workspace-1")
            .expect("delete thread")
    );
    let connection = Connection::open(Store::database_path(directory.path())).expect("database");
    let queued: i64 = connection
        .query_row("SELECT COUNT(*) FROM queued_messages", [], |row| row.get(0))
        .expect("queued count");
    assert_eq!(queued, 0);
}

#[test]
fn project_environment_trust_is_durable_and_bound_to_the_exact_hash() {
    let directory = tempfile::tempdir().expect("tempdir");
    let root = "/fixture/workspace";
    let original_hash = "a".repeat(64);
    let changed_hash = "b".repeat(64);
    {
        let mut store = seeded_store(&directory);
        assert!(
            !store
                .project_environment_trusted(root, &original_hash)
                .expect("initial trust")
        );
        store
            .trust_project_environment(root, &original_hash)
            .expect("trust project environment");
        assert!(
            store
                .project_environment_trusted(root, &original_hash)
                .expect("exact trust")
        );
        assert!(
            !store
                .project_environment_trusted(root, &changed_hash)
                .expect("changed hash")
        );
    }
    let mut reopened = Store::open(directory.path()).expect("reopen store");
    assert!(
        reopened
            .project_environment_trusted(root, &original_hash)
            .expect("durable trust")
    );
}

#[test]
fn task_workspace_defaults_to_local_and_persists_worktree_binding() {
    let directory = tempfile::tempdir().expect("tempdir");
    {
        let mut store = seeded_store(&directory);
        let local = store
            .task_workspace("thread-1", "workspace-1")
            .expect("default task workspace");
        assert_eq!(local.mode, "local");
        assert_eq!(local.task_root, None);
        let worktree = store
            .set_task_workspace(
                "thread-1",
                "workspace-1",
                "worktree",
                Some("/fixture/worktrees/thread-1"),
                Some("sugarcode/thread-1"),
            )
            .expect("set task worktree");
        assert_eq!(worktree.mode, "worktree");
    }
    let mut reopened = Store::open(directory.path()).expect("reopen store");
    let worktree = reopened
        .task_workspace("thread-1", "workspace-1")
        .expect("persisted task worktree");
    assert_eq!(
        worktree.task_root.as_deref(),
        Some("/fixture/worktrees/thread-1")
    );
    assert_eq!(worktree.branch.as_deref(), Some("sugarcode/thread-1"));
    let local = reopened
        .set_task_workspace("thread-1", "workspace-1", "local", None, None)
        .expect("restore local task workspace");
    assert_eq!(local.mode, "local");
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

#[test]
fn native_workspace_instruction_contract_uses_priority_and_nearest_parent() {
    let directory = tempfile::tempdir().expect("data directory");
    let workspace = tempfile::tempdir().expect("workspace");
    std::fs::create_dir(workspace.path().join("src")).expect("src");
    std::fs::write(workspace.path().join("AGENTS.md"), "root\n").expect("root rules");
    std::fs::write(workspace.path().join("CLAUDE.md"), "ignored\n").expect("fallback rules");
    std::fs::write(workspace.path().join("src/AGENTS.override.md"), "nested\n")
        .expect("nested rules");
    let runtime = NativeRuntime::open(directory.path().to_string_lossy().into_owned())
        .expect("native runtime");
    runtime
        .ensure_workspace(
            "workspace-1".to_owned(),
            workspace.path().to_string_lossy().into_owned(),
        )
        .expect("register workspace");

    let contract: Value = serde_json::from_str(
        &runtime
            .workspace_instructions_json(
                "workspace-1".to_owned(),
                r#"["src/new/directory"]"#.to_owned(),
            )
            .expect("instruction contract"),
    )
    .expect("contract JSON");

    assert_eq!(contract["contractVersion"], 1);
    assert_eq!(contract["errors"].as_array().map(Vec::len), Some(0));
    assert_eq!(contract["chains"][0]["scope"], "src/new/directory");
    assert_eq!(
        contract["chains"][0]["paths"],
        serde_json::json!(["AGENTS.md", "src/AGENTS.override.md"])
    );
    assert_eq!(contract["documents"][0]["scope"], ".");
    assert_eq!(contract["documents"][1]["scope"], "src");
    assert_eq!(contract["documents"][1]["content"], "nested\n");
    assert_eq!(
        contract["documents"][1]["sha256"].as_str().map(str::len),
        Some(64)
    );
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
fn replacing_latest_turn_is_atomic_and_removes_its_dependent_records() {
    let directory = tempfile::tempdir().expect("tempdir");
    let mut store = seeded_store(&directory);
    store
        .start_turn(
            "turn-old",
            "thread-1",
            "request-old",
            "openaiResponses",
            "fixture-model",
        )
        .expect("start old turn");
    store
        .append_item(
            "item-old",
            "turn-old",
            1,
            "turn.userMessage",
            r#"{"content":[{"type":"text","text":"Old"}]}"#,
        )
        .expect("old item");
    store
        .finish_turn("turn-old", "completed", None)
        .expect("finish old turn");

    store
        .replace_latest_turn_with_user_message(
            "turn-old",
            "turn-new",
            "thread-1",
            "request-new",
            "anthropicMessages",
            "new-model",
            r#"[{"type":"text","text":"New"}]"#,
        )
        .expect("replace latest turn");

    let snapshot: Value = serde_json::from_str(
        &store
            .load_thread_json("thread-1")
            .expect("load revised thread"),
    )
    .expect("snapshot JSON");
    assert_eq!(snapshot["turns"].as_array().map(Vec::len), Some(1));
    assert_eq!(snapshot["turns"][0]["id"], "turn-new");
    assert_eq!(snapshot["turns"][0]["status"], "running");
    assert_eq!(snapshot["items"].as_array().map(Vec::len), Some(1));
    assert_eq!(snapshot["items"][0]["id"], "turn-new:user");
    assert_eq!(snapshot["items"][0]["kind"], "turn.userMessage");
    assert_eq!(snapshot["items"][0]["payload"]["content"][0]["text"], "New");

    assert!(
        store
            .replace_latest_turn_with_user_message(
                "turn-old",
                "turn-invalid",
                "thread-1",
                "request-invalid",
                "openaiResponses",
                "fixture-model",
                r#"[{"type":"text","text":"Invalid"}]"#,
            )
            .is_err()
    );
    let unchanged: Value = serde_json::from_str(
        &store
            .load_thread_json("thread-1")
            .expect("reload revised thread"),
    )
    .expect("unchanged snapshot JSON");
    assert_eq!(unchanged["turns"].as_array().map(Vec::len), Some(1));
    assert_eq!(unchanged["turns"][0]["id"], "turn-new");

    drop(store);
    let mut reopened = Store::open(directory.path()).expect("reopen revised store");
    let recovered: Value = serde_json::from_str(
        &reopened
            .load_thread_json("thread-1")
            .expect("load recovered revised thread"),
    )
    .expect("recovered snapshot JSON");
    assert_eq!(recovered["turns"][0]["status"], "interrupted");
    assert_eq!(recovered["items"][0]["kind"], "turn.userMessage");
    assert_eq!(
        recovered["items"][0]["payload"]["content"][0]["text"],
        "New"
    );
}

#[test]
fn failed_latest_turn_replacement_rolls_back_every_delete() {
    let directory = tempfile::tempdir().expect("tempdir");
    let mut store = seeded_store(&directory);
    store
        .start_turn(
            "turn-anchor",
            "thread-1",
            "request-anchor",
            "openaiResponses",
            "fixture-model",
        )
        .expect("start anchor turn");
    store
        .finish_turn("turn-anchor", "completed", None)
        .expect("finish anchor turn");
    store
        .start_turn(
            "turn-old",
            "thread-1",
            "request-old",
            "openaiResponses",
            "fixture-model",
        )
        .expect("start old turn");
    store
        .append_item(
            "item-old",
            "turn-old",
            1,
            "turn.userMessage",
            r#"{"content":[{"type":"text","text":"Old"}]}"#,
        )
        .expect("old item");
    store
        .finish_turn("turn-old", "completed", None)
        .expect("finish old turn");

    assert!(
        store
            .replace_latest_turn_with_user_message(
                "turn-old",
                "turn-anchor",
                "thread-1",
                "request-new",
                "openaiResponses",
                "fixture-model",
                r#"[{"type":"text","text":"New"}]"#,
            )
            .is_err()
    );
    let snapshot: Value = serde_json::from_str(
        &store
            .load_thread_json("thread-1")
            .expect("load rolled back thread"),
    )
    .expect("rolled back snapshot JSON");
    assert_eq!(snapshot["turns"].as_array().map(Vec::len), Some(2));
    assert_eq!(snapshot["turns"][1]["id"], "turn-old");
    assert_eq!(snapshot["items"][0]["id"], "item-old");
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
             DROP TABLE knowledge_index_jobs;
             DROP TABLE knowledge_retrieval_settings;
             DROP TABLE knowledge_semantic_indexes;
             DROP TABLE knowledge_chunk_embeddings;
             DROP TABLE skill_update_history;
             DROP TABLE skill_market_sources;
             DROP TABLE knowledge_chunks_fts;
             DROP TABLE knowledge_chunks;
             DROP TABLE knowledge_documents;
             DROP TABLE knowledge_sources;
             DROP TABLE knowledge_base_workspaces;
             DROP TABLE knowledge_bases;
             DROP TABLE model_credentials;
             DROP TABLE model_config;
             DROP TABLE content_assets;
             DROP TABLE mcp_config;
             DROP TABLE skill_preferences;
             DROP TABLE project_environment_trust;
             DROP TABLE task_workspaces;
             DROP TABLE queued_messages;
             DROP TABLE thread_queues;
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
    assert_eq!(version, 19);
}

#[test]
fn schema_sixteen_database_migrates_to_video_assets() {
    let directory = tempfile::tempdir().expect("tempdir");
    let data_directory = directory.path().join("data");
    {
        let _runtime = NativeRuntime::open(data_directory.to_string_lossy().into_owned())
            .expect("create current database");
    }
    let database_path = Store::database_path(&data_directory);
    let connection = Connection::open(&database_path).expect("database");
    connection
        .execute_batch(
            "ALTER TABLE content_assets RENAME TO content_assets_v17;
             CREATE TABLE content_assets (
               asset_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE,
               media_type TEXT NOT NULL, original_name TEXT NOT NULL,
               size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
               kind TEXT NOT NULL CHECK(kind IN ('image','pdf','text')),
               pdf_pages INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch())
             ) STRICT;
             INSERT INTO content_assets
               (asset_id, sha256, media_type, original_name, size_bytes, kind, pdf_pages, created_at)
             SELECT asset_id, sha256, media_type, original_name, size_bytes, kind, pdf_pages, created_at
               FROM content_assets_v17;
             DROP TABLE content_assets_v17;
             ALTER TABLE queued_messages DROP COLUMN model_request_json;
             PRAGMA user_version = 16;",
        )
        .expect("downgrade content asset schema");
    drop(connection);

    let imported = import_quicktime_fixture(&directory);
    assert_eq!(imported["kind"], "video");
    let connection = Connection::open(database_path).expect("migrated database");
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("schema version");
    assert_eq!(version, 19);
}

#[test]
fn schema_fourteen_database_migrates_to_durable_knowledge_index_jobs() {
    let directory = tempfile::tempdir().expect("tempdir");
    {
        let _store = Store::open(directory.path()).expect("create current store");
    }
    let database_path = Store::database_path(directory.path());
    let connection = Connection::open(&database_path).expect("database");
    connection
        .execute_batch(
            "DROP TABLE knowledge_retrieval_settings;
             DROP TABLE knowledge_semantic_indexes;
             DROP TABLE knowledge_chunk_embeddings;
             CREATE TABLE knowledge_chunk_embeddings (
               chunk_id TEXT PRIMARY KEY REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
               knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
               content_hash TEXT NOT NULL, model_version TEXT NOT NULL,
               dimensions INTEGER NOT NULL CHECK(dimensions = 384), vector BLOB NOT NULL,
               updated_at INTEGER NOT NULL DEFAULT (unixepoch())
             ) STRICT;
             CREATE INDEX knowledge_chunk_embeddings_base_model
               ON knowledge_chunk_embeddings(knowledge_base_id, model_version);
             CREATE TABLE knowledge_semantic_indexes (
               knowledge_base_id TEXT PRIMARY KEY REFERENCES knowledge_bases(id) ON DELETE CASCADE,
               model_version TEXT NOT NULL,
               status TEXT NOT NULL CHECK(status IN ('notIndexed','indexing','ready','error')),
               error TEXT, updated_at INTEGER NOT NULL DEFAULT (unixepoch())
             ) STRICT;
             ALTER TABLE knowledge_bases DROP COLUMN semantic_enabled;
             DROP TABLE knowledge_index_jobs;
             ALTER TABLE knowledge_sources DROP COLUMN last_scanned_at;
             ALTER TABLE knowledge_sources DROP COLUMN last_error;
             ALTER TABLE knowledge_sources DROP COLUMN status;
             ALTER TABLE knowledge_chunks DROP COLUMN estimated_tokens;
             ALTER TABLE knowledge_chunks DROP COLUMN end_line;
             ALTER TABLE knowledge_chunks DROP COLUMN start_line;
             ALTER TABLE knowledge_chunks DROP COLUMN language;
             ALTER TABLE knowledge_chunks DROP COLUMN content_kind;
             ALTER TABLE queued_messages DROP COLUMN model_request_json;
             PRAGMA user_version = 14;",
        )
        .expect("downgrade to v14 fixture");
    drop(connection);

    let _store = Store::open(directory.path()).expect("migrate v14 store");
    let connection = Connection::open(database_path).expect("migrated database");
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("schema version");
    assert_eq!(version, 19);
    let job_table: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_index_jobs'",
            [],
            |row| row.get(0),
        )
        .expect("job table");
    assert_eq!(job_table, 1);
}

#[test]
fn schema_fifteen_migration_preserves_existing_semantic_vectors_and_indexes() {
    let directory = tempfile::tempdir().expect("tempdir");
    {
        let _store = Store::open(directory.path()).expect("create current store");
    }
    let database_path = Store::database_path(directory.path());
    let connection = Connection::open(&database_path).expect("database");
    connection
        .execute_batch(
            "INSERT INTO knowledge_bases (id, name, description, scope, status)
               VALUES ('kb_11111111111111111111111111111111', '迁移测试', '', 'global', 'ready');
             INSERT INTO knowledge_sources (id, knowledge_base_id, kind, path, display_name)
               VALUES ('ks_22222222222222222222222222222222', 'kb_11111111111111111111111111111111',
                 'managedFile', '/fixture/migrate.md', 'migrate.md');
             INSERT INTO knowledge_documents
               (id, knowledge_base_id, source_id, relative_path, file_name, media_type,
                size_bytes, modified_at, sha256, parse_status)
               VALUES ('kd_33333333333333333333333333333333', 'kb_11111111111111111111111111111111',
                 'ks_22222222222222222222222222222222', 'migrate.md', 'migrate.md', 'text/markdown',
                 7, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ready');
             INSERT INTO knowledge_chunks
               (id, knowledge_base_id, document_id, ordinal, content, content_hash)
               VALUES ('kc_44444444444444444444444444444444', 'kb_11111111111111111111111111111111',
                 'kd_33333333333333333333333333333333', 0, '迁移内容',
                 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
             INSERT INTO knowledge_chunk_embeddings
               (chunk_id, knowledge_base_id, content_hash, model_id, model_version, dimensions, vector)
               VALUES ('kc_44444444444444444444444444444444', 'kb_11111111111111111111111111111111',
                 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                 'intfloat/multilingual-e5-small', '2026-04-02', 384, zeroblob(1536));
             INSERT INTO knowledge_semantic_indexes
               (knowledge_base_id, model_id, model_version, status)
               VALUES ('kb_11111111111111111111111111111111',
                 'intfloat/multilingual-e5-small', '2026-04-02', 'ready');
             DROP TABLE knowledge_retrieval_settings;
             DROP INDEX knowledge_chunk_embeddings_base_model;
             ALTER TABLE knowledge_chunk_embeddings RENAME TO knowledge_chunk_embeddings_v16;
             CREATE TABLE knowledge_chunk_embeddings (
               chunk_id TEXT PRIMARY KEY REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
               knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
               content_hash TEXT NOT NULL, model_version TEXT NOT NULL,
               dimensions INTEGER NOT NULL CHECK(dimensions = 384), vector BLOB NOT NULL,
               updated_at INTEGER NOT NULL DEFAULT (unixepoch())
             ) STRICT;
             INSERT INTO knowledge_chunk_embeddings
               (chunk_id, knowledge_base_id, content_hash, model_version, dimensions, vector, updated_at)
               SELECT chunk_id, knowledge_base_id, content_hash, model_version, dimensions, vector, updated_at
                 FROM knowledge_chunk_embeddings_v16;
             DROP TABLE knowledge_chunk_embeddings_v16;
             CREATE INDEX knowledge_chunk_embeddings_base_model
               ON knowledge_chunk_embeddings(knowledge_base_id, model_version);
             DROP INDEX knowledge_semantic_indexes_model_status;
             ALTER TABLE knowledge_semantic_indexes RENAME TO knowledge_semantic_indexes_v16;
             CREATE TABLE knowledge_semantic_indexes (
               knowledge_base_id TEXT PRIMARY KEY REFERENCES knowledge_bases(id) ON DELETE CASCADE,
               model_version TEXT NOT NULL,
               status TEXT NOT NULL CHECK(status IN ('notIndexed','indexing','ready','error')),
               error TEXT, updated_at INTEGER NOT NULL DEFAULT (unixepoch())
             ) STRICT;
             INSERT INTO knowledge_semantic_indexes
               (knowledge_base_id, model_version, status, error, updated_at)
               SELECT knowledge_base_id, model_version, status, error, updated_at
                 FROM knowledge_semantic_indexes_v16;
             DROP TABLE knowledge_semantic_indexes_v16;
             ALTER TABLE knowledge_bases DROP COLUMN semantic_enabled;
             ALTER TABLE queued_messages DROP COLUMN model_request_json;
             PRAGMA user_version = 15;",
        )
        .expect("downgrade to v15 fixture");
    drop(connection);

    let mut store = Store::open(directory.path()).expect("migrate v15 store");
    let settings = store
        .knowledge_retrieval_settings()
        .expect("retrieval settings");
    assert_eq!(settings.strategy, "semantic");
    assert_eq!(
        settings.active_model_id.as_deref(),
        Some("intfloat/multilingual-e5-small")
    );
    assert_eq!(settings.active_model_version.as_deref(), Some("2026-04-02"));
    let connection = Connection::open(database_path).expect("migrated database");
    let migrated: (String, String, i64, i64) = connection
        .query_row(
            "SELECT model_id, model_version, dimensions, length(vector)
             FROM knowledge_chunk_embeddings",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("migrated embedding");
    assert_eq!(
        migrated,
        (
            "intfloat/multilingual-e5-small".to_owned(),
            "2026-04-02".to_owned(),
            384,
            1_536,
        )
    );
}

#[test]
fn retrieval_model_request_keeps_active_model_until_atomic_activation() {
    let directory = tempfile::tempdir().expect("tempdir");
    let mut store = Store::open(directory.path()).expect("store");
    let initial = store
        .knowledge_retrieval_settings()
        .expect("initial settings");
    assert_eq!(initial.strategy, "fullText");
    assert_eq!(initial.selected_plan_id, "fullText");
    assert!(initial.active_model_id.is_none());

    store
        .request_knowledge_retrieval_model("BAAI/bge-small-zh-v1.5", "bge-v1")
        .expect("request BGE");
    let pending = store
        .knowledge_retrieval_settings()
        .expect("pending settings");
    assert_eq!(pending.strategy, "fullText");
    assert_eq!(pending.selected_plan_id, "BAAI/bge-small-zh-v1.5");
    assert_eq!(
        pending.pending_model_id.as_deref(),
        Some("BAAI/bge-small-zh-v1.5")
    );
    assert!(pending.active_model_id.is_none());

    assert!(
        store
            .activate_pending_knowledge_retrieval_model("BAAI/bge-small-zh-v1.5", "bge-v1",)
            .expect("activate BGE")
    );
    store
        .request_knowledge_retrieval_model("intfloat/multilingual-e5-small", "e5-v1")
        .expect("request E5");
    let switching = store
        .knowledge_retrieval_settings()
        .expect("switching settings");
    assert_eq!(switching.strategy, "semantic");
    assert_eq!(
        switching.active_model_id.as_deref(),
        Some("BAAI/bge-small-zh-v1.5")
    );
    assert_eq!(
        switching.pending_model_id.as_deref(),
        Some("intfloat/multilingual-e5-small")
    );
    assert!(
        store
            .cancel_pending_knowledge_retrieval_model("intfloat/multilingual-e5-small", "e5-v1",)
            .expect("cancel E5")
    );
    let restored = store
        .knowledge_retrieval_settings()
        .expect("restored settings");
    assert_eq!(restored.selected_plan_id, "BAAI/bge-small-zh-v1.5");
    assert!(restored.pending_model_id.is_none());
    store
        .set_semantic_index_paused(true)
        .expect("pause semantic index");
    drop(store);
    let mut reopened = Store::open(directory.path()).expect("reopen store");
    assert!(
        reopened
            .knowledge_retrieval_settings()
            .expect("persisted pause")
            .index_paused
    );
}
