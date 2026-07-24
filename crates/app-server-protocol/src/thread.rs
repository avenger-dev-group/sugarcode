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

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
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

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum TurnSnapshotStatus {
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct TurnSnapshot {
    pub id: String,
    pub status: TurnSnapshotStatus,
    pub items: Vec<Item>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ThreadResumeResponse {
    pub thread: Thread,
    pub turns: Vec<TurnSnapshot>,
}
