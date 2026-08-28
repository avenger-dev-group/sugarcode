use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{PersistenceError, Result, Store, validate_id};

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoalBudget {
    #[serde(skip_serializing_if = "Option::is_none")]
    max_turns: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_duration_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum GoalMutation {
    Create {
        goal_id: String,
        objective: String,
        model_profile_id: String,
        model_request: Value,
        #[serde(default)]
        budget: GoalBudget,
    },
    Edit {
        goal_id: String,
        expected_revision: i64,
        objective: Option<String>,
        model_profile_id: Option<String>,
        model_request: Option<Value>,
        budget: Option<GoalBudget>,
    },
    Pause {
        goal_id: String,
        expected_revision: i64,
        #[serde(default = "default_user_pause_reason")]
        pause_reason: String,
    },
    Resume {
        goal_id: String,
        expected_revision: i64,
        #[serde(default)]
        preserve_activation: bool,
    },
    Clear {
        goal_id: String,
        expected_revision: i64,
    },
}

fn default_user_pause_reason() -> String {
    "user".to_owned()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GoalRow {
    id: String,
    thread_id: String,
    objective: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pause_reason: Option<String>,
    revision: i64,
    model: Value,
    budget: GoalBudget,
    activation_usage: Value,
    lifetime_usage: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_turn_id: Option<String>,
    created_at: i64,
    updated_at: i64,
}

fn validate_objective(value: &str) -> Result<()> {
    if value.trim().is_empty() || value.chars().count() > 4_000 {
        return Err(PersistenceError::InvalidInput(
            "Goal objective must contain 1 to 4000 characters".to_owned(),
        ));
    }
    Ok(())
}

fn validate_model(profile_id: &str, request: &Value) -> Result<()> {
    if profile_id.is_empty()
        || profile_id.len() > 64
        || !profile_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        || !request.is_object()
    {
        return Err(PersistenceError::InvalidInput(
            "Goal model selection is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn validate_budget(budget: &GoalBudget) -> Result<()> {
    if [budget.max_turns, budget.max_duration_ms, budget.max_tokens]
        .into_iter()
        .flatten()
        .any(|value| value <= 0 || value > 9_007_199_254_740_991)
    {
        return Err(PersistenceError::InvalidInput(
            "Goal budget values must be positive safe integers".to_owned(),
        ));
    }
    Ok(())
}

fn validate_pause_reason(value: &str) -> Result<()> {
    if !matches!(
        value,
        "user"
            | "blocked"
            | "budget"
            | "failure"
            | "restart"
            | "modelUnavailable"
            | "queueBlocked"
            | "protocolViolation"
    ) {
        return Err(PersistenceError::InvalidInput(
            "Goal pause reason is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn load_goal_from_connection(
    connection: &rusqlite::Connection,
    thread_id: &str,
) -> Result<Option<GoalRow>> {
    let raw = connection
        .query_row(
            "SELECT id, thread_id, objective, status, pause_reason, revision, \
             model_profile_id, model_request_json, budget_json, \
             activation_turns, activation_duration_ms, activation_tokens, \
             lifetime_turns, lifetime_duration_ms, lifetime_tokens, progress_json, \
             active_turn_id, created_at, updated_at FROM goals \
             WHERE thread_id = ?1 AND cleared_at IS NULL AND status != 'cancelled' \
             ORDER BY created_at DESC, id DESC LIMIT 1",
            [thread_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, i64>(13)?,
                    row.get::<_, i64>(14)?,
                    row.get::<_, Option<String>>(15)?,
                    row.get::<_, Option<String>>(16)?,
                    row.get::<_, i64>(17)?,
                    row.get::<_, i64>(18)?,
                ))
            },
        )
        .optional()?;
    raw.map(
        |(
            id,
            thread_id,
            objective,
            status,
            pause_reason,
            revision,
            model_profile_id,
            model_request,
            budget,
            activation_turns,
            activation_duration_ms,
            activation_tokens,
            lifetime_turns,
            lifetime_duration_ms,
            lifetime_tokens,
            progress,
            active_turn_id,
            created_at,
            updated_at,
        )| {
            Ok(GoalRow {
                id,
                thread_id,
                objective,
                status,
                pause_reason,
                revision,
                model: json!({
                    "profileId": model_profile_id,
                    "request": serde_json::from_str::<Value>(&model_request)?,
                }),
                budget: serde_json::from_str(&budget)?,
                activation_usage: json!({
                    "turns": activation_turns,
                    "activeDurationMs": activation_duration_ms,
                    "tokens": activation_tokens,
                }),
                lifetime_usage: json!({
                    "turns": lifetime_turns,
                    "activeDurationMs": lifetime_duration_ms,
                    "tokens": lifetime_tokens,
                }),
                progress: progress
                    .map(|value| serde_json::from_str(&value))
                    .transpose()?,
                active_turn_id,
                created_at,
                updated_at,
            })
        },
    )
    .transpose()
}

pub(super) fn load_current_goal(
    connection: &rusqlite::Connection,
    thread_id: &str,
) -> Result<Option<GoalRow>> {
    load_goal_from_connection(connection, thread_id)
}

fn require_revision(
    transaction: &Transaction<'_>,
    goal_id: &str,
    expected_revision: i64,
) -> Result<(String, String)> {
    let current = transaction
        .query_row(
            "SELECT thread_id, status FROM goals WHERE id = ?1 AND revision = ?2 \
             AND cleared_at IS NULL",
            params![goal_id, expected_revision],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    current.ok_or_else(|| PersistenceError::Conflict("goalRevisionMismatch".to_owned()))
}

impl Store {
    pub(crate) fn current_goal_json(&mut self, thread_id: &str) -> Result<String> {
        validate_id("thread_id", thread_id)?;
        Ok(serde_json::to_string(&load_goal_from_connection(
            &self.connection,
            thread_id,
        )?)?)
    }

    pub(crate) fn mutate_goal_json(
        &mut self,
        thread_id: &str,
        mutation_json: &str,
    ) -> Result<String> {
        validate_id("thread_id", thread_id)?;
        let mutation: GoalMutation = serde_json::from_str(mutation_json)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        match mutation {
            GoalMutation::Create {
                goal_id,
                objective,
                model_profile_id,
                model_request,
                budget,
            } => {
                validate_id("goal_id", &goal_id)?;
                validate_objective(&objective)?;
                validate_model(&model_profile_id, &model_request)?;
                validate_budget(&budget)?;
                let unfinished: Option<String> = transaction
                    .query_row(
                        "SELECT id FROM goals WHERE thread_id = ?1 AND cleared_at IS NULL \
                         AND status IN ('active','paused') LIMIT 1",
                        [thread_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if unfinished.is_some() {
                    return Err(PersistenceError::Conflict("goalConflict".to_owned()));
                }
                transaction.execute(
                    "UPDATE goals SET cleared_at = unixepoch(), updated_at = unixepoch() \
                     WHERE thread_id = ?1 AND cleared_at IS NULL",
                    [thread_id],
                )?;
                transaction.execute(
                    "INSERT INTO goals (id, thread_id, objective, status, revision, \
                     model_profile_id, model_request_json, budget_json, activation_started_at) \
                     VALUES (?1, ?2, ?3, 'active', 1, ?4, ?5, ?6, unixepoch())",
                    params![
                        goal_id,
                        thread_id,
                        objective,
                        model_profile_id,
                        serde_json::to_string(&model_request)?,
                        serde_json::to_string(&budget)?,
                    ],
                )?;
            }
            GoalMutation::Edit {
                goal_id,
                expected_revision,
                objective,
                model_profile_id,
                model_request,
                budget,
            } => {
                validate_id("goal_id", &goal_id)?;
                let (stored_thread_id, status) =
                    require_revision(&transaction, &goal_id, expected_revision)?;
                if stored_thread_id != thread_id || !matches!(status.as_str(), "active" | "paused")
                {
                    return Err(PersistenceError::Conflict("goalNotFound".to_owned()));
                }
                if let Some(value) = objective.as_deref() {
                    validate_objective(value)?;
                }
                if let Some(value) = budget.as_ref() {
                    validate_budget(value)?;
                }
                if let Some(profile_id) = model_profile_id.as_deref() {
                    let request = model_request.as_ref().ok_or_else(|| {
                        PersistenceError::InvalidInput(
                            "Goal model edits require modelRequest".to_owned(),
                        )
                    })?;
                    validate_model(profile_id, request)?;
                } else if model_request.is_some() {
                    return Err(PersistenceError::InvalidInput(
                        "Goal model edits require modelProfileId".to_owned(),
                    ));
                }
                transaction.execute(
                    "UPDATE goals SET objective = COALESCE(?3, objective), \
                     model_profile_id = COALESCE(?4, model_profile_id), \
                     model_request_json = COALESCE(?5, model_request_json), \
                     budget_json = COALESCE(?6, budget_json), revision = revision + 1, \
                     updated_at = unixepoch() WHERE id = ?1 AND thread_id = ?2",
                    params![
                        goal_id,
                        thread_id,
                        objective,
                        model_profile_id,
                        model_request
                            .map(|value| serde_json::to_string(&value))
                            .transpose()?,
                        budget
                            .map(|value| serde_json::to_string(&value))
                            .transpose()?,
                    ],
                )?;
            }
            GoalMutation::Pause {
                goal_id,
                expected_revision,
                pause_reason,
            } => {
                validate_pause_reason(&pause_reason)?;
                let (stored_thread_id, status) =
                    require_revision(&transaction, &goal_id, expected_revision)?;
                if stored_thread_id != thread_id || status != "active" {
                    return Err(PersistenceError::Conflict("goalNotFound".to_owned()));
                }
                transaction.execute(
                    "UPDATE goals SET status = 'paused', pause_reason = ?3, revision = revision + 1, \
                     active_turn_id = NULL, activation_started_at = NULL, updated_at = unixepoch() \
                     WHERE id = ?1 AND thread_id = ?2",
                    params![goal_id, thread_id, pause_reason],
                )?;
            }
            GoalMutation::Resume {
                goal_id,
                expected_revision,
                preserve_activation,
            } => {
                let (stored_thread_id, status) =
                    require_revision(&transaction, &goal_id, expected_revision)?;
                if stored_thread_id != thread_id || status != "paused" {
                    return Err(PersistenceError::Conflict("goalNotFound".to_owned()));
                }
                transaction.execute(
                    if preserve_activation {
                        "UPDATE goals SET status = 'active', pause_reason = NULL, revision = revision + 1, \
                         activation_started_at = unixepoch(), updated_at = unixepoch() \
                         WHERE id = ?1 AND thread_id = ?2"
                    } else {
                        "UPDATE goals SET status = 'active', pause_reason = NULL, revision = revision + 1, \
                         activation_turns = 0, activation_duration_ms = 0, activation_tokens = 0, \
                         activation_started_at = unixepoch(), updated_at = unixepoch() \
                         WHERE id = ?1 AND thread_id = ?2"
                    },
                    params![goal_id, thread_id],
                )?;
            }
            GoalMutation::Clear {
                goal_id,
                expected_revision,
            } => {
                let (stored_thread_id, _) =
                    require_revision(&transaction, &goal_id, expected_revision)?;
                if stored_thread_id != thread_id {
                    return Err(PersistenceError::Conflict("goalNotFound".to_owned()));
                }
                transaction.execute(
                    "UPDATE goals SET status = 'cancelled', pause_reason = NULL, \
                     active_turn_id = NULL, revision = revision + 1, cleared_at = unixepoch(), \
                     updated_at = unixepoch() WHERE id = ?1 AND thread_id = ?2",
                    params![goal_id, thread_id],
                )?;
            }
        }
        transaction.execute(
            "UPDATE threads SET updated_at = unixepoch() WHERE id = ?1",
            [thread_id],
        )?;
        transaction.commit()?;
        self.current_goal_json(thread_id)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn claim_goal_turn_json(
        &mut self,
        goal_id: &str,
        expected_revision: i64,
        turn_id: &str,
        thread_id: &str,
        request_id: &str,
        provider_wire_api: &str,
        model: &str,
        context_json: &str,
    ) -> Result<String> {
        for (name, value) in [
            ("goal_id", goal_id),
            ("turn_id", turn_id),
            ("thread_id", thread_id),
            ("request_id", request_id),
        ] {
            validate_id(name, value)?;
        }
        let context: Value = serde_json::from_str(context_json)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (stored_thread_id, status) =
            require_revision(&transaction, goal_id, expected_revision)?;
        if stored_thread_id != thread_id || status != "active" {
            return Err(PersistenceError::Conflict("goalNotFound".to_owned()));
        }
        let (budget_json, turns, duration, tokens, lifetime_turns, objective, active_turn): (
            String,
            i64,
            i64,
            i64,
            i64,
            String,
            Option<String>,
        ) = transaction.query_row(
            "SELECT budget_json, activation_turns, activation_duration_ms, activation_tokens, \
             lifetime_turns, objective, active_turn_id FROM goals WHERE id = ?1",
            [goal_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )?;
        if active_turn.is_some() {
            return Err(PersistenceError::Conflict("goalTurnActive".to_owned()));
        }
        let budget: GoalBudget = serde_json::from_str(&budget_json)?;
        if budget.max_turns.is_some_and(|limit| turns >= limit)
            || budget
                .max_duration_ms
                .is_some_and(|limit| duration >= limit)
            || budget.max_tokens.is_some_and(|limit| tokens >= limit)
        {
            transaction.execute(
                "UPDATE goals SET status = 'paused', pause_reason = 'budget', revision = revision + 1, \
                 activation_started_at = NULL, updated_at = unixepoch() WHERE id = ?1",
                [goal_id],
            )?;
            transaction.commit()?;
            return self.current_goal_json(thread_id);
        }
        transaction.execute(
            "INSERT INTO turns (id, thread_id, request_id, status, provider_wire_api, model) \
             VALUES (?1, ?2, ?3, 'running', ?4, ?5)",
            params![turn_id, thread_id, request_id, provider_wire_api, model],
        )?;
        transaction.execute(
            "INSERT INTO turn_items (id, turn_id, sequence, kind, payload_json) \
             VALUES (?1, ?2, 0, 'turn.goalContext', ?3)",
            params![
                format!("{turn_id}:goal"),
                turn_id,
                serde_json::to_string(&context)?
            ],
        )?;
        if lifetime_turns == 0 {
            transaction.execute(
                "INSERT INTO turn_items (id, turn_id, sequence, kind, payload_json) \
                 VALUES (?1, ?2, -1, 'turn.goalObjective', ?3)",
                params![
                    format!("{turn_id}:goal-objective"),
                    turn_id,
                    serde_json::to_string(&json!({
                        "content": [{ "type": "text", "text": objective }]
                    }))?
                ],
            )?;
        }
        transaction.execute(
            "UPDATE goals SET active_turn_id = ?2, activation_turns = activation_turns + 1, \
             lifetime_turns = lifetime_turns + 1, updated_at = unixepoch() WHERE id = ?1",
            params![goal_id, turn_id],
        )?;
        transaction.execute(
            "UPDATE threads SET updated_at = unixepoch() WHERE id = ?1",
            [thread_id],
        )?;
        transaction.commit()?;
        self.current_goal_json(thread_id)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn settle_goal_turn_json(
        &mut self,
        goal_id: &str,
        expected_revision: i64,
        turn_id: &str,
        settlement_json: &str,
        tokens: i64,
        duration_ms: i64,
    ) -> Result<String> {
        validate_id("goal_id", goal_id)?;
        validate_id("turn_id", turn_id)?;
        if tokens < 0 || duration_ms < 0 {
            return Err(PersistenceError::InvalidInput(
                "Goal usage cannot be negative".to_owned(),
            ));
        }
        let settlement: Value = serde_json::from_str(settlement_json)?;
        let status = settlement
            .get("status")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                PersistenceError::InvalidInput("Goal settlement is invalid".to_owned())
            })?;
        if !matches!(status, "in_progress" | "blocked" | "complete" | "failed") {
            return Err(PersistenceError::InvalidInput(
                "Goal settlement is invalid".to_owned(),
            ));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let thread_id: String = transaction
            .query_row(
                "SELECT thread_id FROM goals WHERE id = ?1 AND revision = ?2 \
             AND status = 'active' AND active_turn_id = ?3",
                params![goal_id, expected_revision, turn_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| PersistenceError::Conflict("goalRevisionMismatch".to_owned()))?;
        let progress = match status {
            "in_progress" => json!({
                "summary": settlement.get("summary").cloned().unwrap_or(Value::Null),
                "nextStep": settlement.get("nextStep").cloned().unwrap_or(Value::Null),
            }),
            "blocked" => json!({
                "summary": settlement.get("summary").cloned().unwrap_or(Value::Null),
                "blocker": settlement.get("blocker").cloned().unwrap_or(Value::Null),
            }),
            "complete" => json!({
                "summary": settlement.get("summary").cloned().unwrap_or(Value::Null),
                "evidence": settlement.get("evidence").cloned().unwrap_or(Value::Null),
            }),
            _ => json!({ "summary": "Goal Turn failed before a durable progress update." }),
        };
        let (mut goal_status, mut pause_reason, turn_status) = match status {
            "blocked" => ("paused", Some("blocked"), "completed"),
            "complete" => ("completed", None, "completed"),
            "failed" => (
                "paused",
                Some(
                    settlement
                        .get("pauseReason")
                        .and_then(Value::as_str)
                        .unwrap_or("failure"),
                ),
                "failed",
            ),
            _ => ("active", None, "completed"),
        };
        if let Some(reason) = pause_reason {
            validate_pause_reason(reason)?;
        }
        let (budget_json, activation_turns, activation_duration, activation_tokens): (
            String,
            i64,
            i64,
            i64,
        ) = transaction.query_row(
                "SELECT budget_json, activation_turns, activation_duration_ms, activation_tokens FROM goals WHERE id = ?1",
                [goal_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
        let budget: GoalBudget = serde_json::from_str(&budget_json)?;
        if status == "in_progress"
            && (budget
                .max_turns
                .is_some_and(|limit| activation_turns >= limit)
                || budget
                    .max_duration_ms
                    .is_some_and(|limit| activation_duration.saturating_add(duration_ms) >= limit)
                || budget
                    .max_tokens
                    .is_some_and(|limit| activation_tokens.saturating_add(tokens) >= limit))
        {
            goal_status = "paused";
            pause_reason = Some("budget");
        }
        transaction.execute(
            "UPDATE turns SET status = ?2, completed_at = unixepoch(), \
             error_json = CASE WHEN ?2 = 'failed' THEN '{\"kind\":\"goalTurnFailure\",\"retryable\":true}' ELSE NULL END \
             WHERE id = ?1 AND status = 'running'",
            params![turn_id, turn_status],
        )?;
        transaction.execute(
            "UPDATE goals SET status = ?2, pause_reason = ?3, progress_json = ?4, \
             active_turn_id = NULL, activation_duration_ms = activation_duration_ms + ?5, \
             activation_tokens = activation_tokens + ?6, \
             lifetime_duration_ms = lifetime_duration_ms + ?5, \
             lifetime_tokens = lifetime_tokens + ?6, revision = revision + 1, \
             activation_started_at = CASE WHEN ?2 = 'active' THEN activation_started_at ELSE NULL END, \
             updated_at = unixepoch() WHERE id = ?1",
            params![
                goal_id,
                goal_status,
                pause_reason,
                serde_json::to_string(&progress)?,
                duration_ms,
                tokens,
            ],
        )?;
        transaction.commit()?;
        self.current_goal_json(&thread_id)
    }
}
