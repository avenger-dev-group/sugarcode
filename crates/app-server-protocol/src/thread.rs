use schemars::JsonSchema;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::de;
use serde::de::MapAccess;
use serde::de::Visitor;
use std::fmt;
use ts_rs::TS;

use crate::Item;

pub const DEFAULT_THREAD_LIST_LIMIT: u32 = 50;
pub const MAX_THREAD_LIST_LIMIT: u32 = 100;
pub const DEFAULT_THREAD_SEARCH_LIMIT: u32 = 50;
pub const MAX_THREAD_SEARCH_LIMIT: u32 = 100;
pub const MAX_THREAD_SEARCH_QUERY_BYTES: usize = 256;
pub const MAX_THREAD_SEARCH_QUERY_TERMS: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub origin: Option<ThreadOrigin>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(tag = "type", rename_all = "camelCase")]
pub enum ThreadOrigin {
    Subagent {
        #[serde(rename = "parentThreadId")]
        #[ts(rename = "parentThreadId")]
        parent_thread_id: String,
        #[serde(rename = "parentTurnId")]
        #[ts(rename = "parentTurnId")]
        parent_turn_id: String,
        #[serde(rename = "orchestrationId")]
        #[ts(rename = "orchestrationId")]
        orchestration_id: String,
        #[serde(rename = "taskId")]
        #[ts(rename = "taskId")]
        task_id: String,
        role: crate::AgentTaskRole,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ThreadDescendantsListParams {
    #[schemars(regex(pattern = "^thr_(?:[0-9]{16}|[1-9][0-9]{16,19})$"))]
    pub thread_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ThreadStartParams {}

impl<'de> Deserialize<'de> for ThreadStartParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_map(ThreadStartParamsVisitor)
    }
}

struct ThreadStartParamsVisitor;

impl<'de> Visitor<'de> for ThreadStartParamsVisitor {
    type Value = ThreadStartParams;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("an empty object")
    }

    fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
    where
        M: MapAccess<'de>,
    {
        if let Some(field) = map.next_key::<String>()? {
            return Err(de::Error::unknown_field(&field, &[]));
        }
        Ok(ThreadStartParams {})
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ThreadStartResponse {
    pub thread: Thread,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ThreadArchiveParams {
    #[schemars(regex(pattern = "^thr_(?:[0-9]{16}|[1-9][0-9]{16,19})$"))]
    pub thread_id: String,
}

impl<'de> Deserialize<'de> for ThreadArchiveParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let params = ThreadArchiveParamsWire::deserialize(deserializer)?;
        if !is_canonical_thread_id(&params.thread_id) {
            return Err(de::Error::custom("threadId must be a canonical Thread ID"));
        }
        Ok(Self {
            thread_id: params.thread_id,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ThreadArchiveParamsWire {
    thread_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ThreadArchiveResponse {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ThreadUnarchiveParams {
    #[schemars(regex(pattern = "^thr_(?:[0-9]{16}|[1-9][0-9]{16,19})$"))]
    pub thread_id: String,
}

impl<'de> Deserialize<'de> for ThreadUnarchiveParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let params = ThreadUnarchiveParamsWire::deserialize(deserializer)?;
        if !is_canonical_thread_id(&params.thread_id) {
            return Err(de::Error::custom("threadId must be a canonical Thread ID"));
        }
        Ok(Self {
            thread_id: params.thread_id,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ThreadUnarchiveParamsWire {
    thread_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ThreadUnarchiveResponse {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ThreadDeleteParams {
    #[schemars(regex(pattern = "^thr_(?:[0-9]{16}|[1-9][0-9]{16,19})$"))]
    pub thread_id: String,
}

impl<'de> Deserialize<'de> for ThreadDeleteParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let params = ThreadDeleteParamsWire::deserialize(deserializer)?;
        if !is_canonical_thread_id(&params.thread_id) {
            return Err(de::Error::custom("threadId must be a canonical Thread ID"));
        }
        Ok(Self {
            thread_id: params.thread_id,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ThreadDeleteParamsWire {
    thread_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ThreadDeleteResponse {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ThreadForkParams {
    #[schemars(regex(pattern = "^thr_(?:[0-9]{16}|[1-9][0-9]{16,19})$"))]
    pub thread_id: String,
}

impl<'de> Deserialize<'de> for ThreadForkParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let params = ThreadForkParamsWire::deserialize(deserializer)?;
        if !is_canonical_thread_id(&params.thread_id) {
            return Err(de::Error::custom("threadId must be a canonical Thread ID"));
        }
        Ok(Self {
            thread_id: params.thread_id,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ThreadForkParamsWire {
    thread_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ThreadListParams {
    #[schemars(regex(pattern = "^thr_(?:[0-9]{16}|[1-9][0-9]{16,19})$"))]
    #[ts(optional = nullable)]
    pub cursor: Option<String>,
    #[schemars(range(min = 1, max = 100))]
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
}

impl<'de> Deserialize<'de> for ThreadListParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let params = ThreadListParamsWire::deserialize(deserializer)?;
        if params
            .cursor
            .as_deref()
            .is_some_and(|cursor| !is_canonical_thread_id(cursor))
        {
            return Err(de::Error::custom("cursor must be a canonical Thread ID"));
        }
        if params
            .limit
            .is_some_and(|limit| limit == 0 || limit > MAX_THREAD_LIST_LIMIT)
        {
            return Err(de::Error::custom("limit must be between 1 and 100"));
        }
        Ok(Self {
            cursor: params.cursor,
            limit: params.limit,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ThreadListParamsWire {
    cursor: Option<String>,
    limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ThreadListResponse {
    pub data: Vec<Thread>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ThreadSearchParams {
    #[schemars(length(min = 1, max = 256))]
    pub query: String,
    #[schemars(regex(pattern = "^thr_(?:[0-9]{16}|[1-9][0-9]{16,19})$"))]
    #[ts(optional = nullable)]
    pub cursor: Option<String>,
    #[schemars(range(min = 1, max = 100))]
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
}

impl<'de> Deserialize<'de> for ThreadSearchParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let params = ThreadSearchParamsWire::deserialize(deserializer)?;
        if !is_valid_search_query(&params.query) {
            return Err(de::Error::custom(
                "query must contain 1 to 16 terms and be at most 256 UTF-8 bytes",
            ));
        }
        if params
            .cursor
            .as_deref()
            .is_some_and(|cursor| !is_canonical_thread_id(cursor))
        {
            return Err(de::Error::custom("cursor must be a canonical Thread ID"));
        }
        if params
            .limit
            .is_some_and(|limit| limit == 0 || limit > MAX_THREAD_SEARCH_LIMIT)
        {
            return Err(de::Error::custom("limit must be between 1 and 100"));
        }
        Ok(Self {
            query: params.query.trim().to_string(),
            cursor: params.cursor,
            limit: params.limit,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ThreadSearchParamsWire {
    query: String,
    cursor: Option<String>,
    limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ThreadSearchResponse {
    pub data: Vec<Thread>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ThreadStartedNotification {
    pub thread: Thread,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ThreadResumeParams {
    pub thread_id: String,
}

impl<'de> Deserialize<'de> for ThreadResumeParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let params = ThreadResumeParamsWire::deserialize(deserializer)?;
        if !is_canonical_thread_id(&params.thread_id) {
            return Err(de::Error::custom("threadId must be a canonical Thread ID"));
        }
        Ok(Self {
            thread_id: params.thread_id,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ThreadResumeParamsWire {
    thread_id: String,
}

fn is_canonical_thread_id(value: &str) -> bool {
    let Some(digits) = value.strip_prefix("thr_") else {
        return false;
    };
    if digits.len() < 16 || digits.len() > 20 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    digits
        .parse::<u64>()
        .is_ok_and(|sequence| format!("{sequence:016}") == digits)
}

fn is_valid_search_query(value: &str) -> bool {
    if value.chars().any(char::is_control) {
        return false;
    }
    let query = value.trim();
    !query.is_empty()
        && query.len() <= MAX_THREAD_SEARCH_QUERY_BYTES
        && query.split_whitespace().count() <= MAX_THREAD_SEARCH_QUERY_TERMS
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum TurnSnapshotStatus {
    InProgress,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct TurnSnapshot {
    pub id: String,
    pub status: TurnSnapshotStatus,
    pub items: Vec<Item>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<crate::ModelSelectionSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<crate::TurnError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ThreadResumeResponse {
    pub thread: Thread,
    pub turns: Vec<TurnSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ThreadDescendantsListResponse {
    pub data: Vec<ThreadResumeResponse>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ThreadForkResponse {
    pub thread: Thread,
    pub turns: Vec<TurnSnapshot>,
}
