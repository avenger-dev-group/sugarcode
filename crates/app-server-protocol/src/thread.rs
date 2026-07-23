use schemars::JsonSchema;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::de;
use serde::de::MapAccess;
use serde::de::Visitor;
use std::fmt;
use ts_rs::TS;

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
