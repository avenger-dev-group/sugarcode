use schemars::JsonSchema;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::de;
use ts_rs::TS;

pub const MAX_WORKSPACE_BROWSER_PATH_BYTES: usize = 1024;
pub const MAX_WORKSPACE_BROWSER_PATH_COMPONENTS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct WorkspaceListParams {
    #[schemars(length(max = 1024))]
    pub path: String,
}

impl<'de> Deserialize<'de> for WorkspaceListParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = WorkspacePathWire::deserialize(deserializer)?;
        validate_browser_path(&wire.path).map_err(de::Error::custom)?;
        Ok(Self { path: wire.path })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct WorkspaceInspectParams {
    #[schemars(length(min = 1, max = 1024))]
    pub path: String,
}

impl<'de> Deserialize<'de> for WorkspaceInspectParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = WorkspacePathWire::deserialize(deserializer)?;
        validate_browser_path(&wire.path).map_err(de::Error::custom)?;
        if wire.path.is_empty() {
            return Err(de::Error::custom("path must name a file"));
        }
        Ok(Self { path: wire.path })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WorkspacePathWire {
    path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum WorkspaceEntryKind {
    File,
    Directory,
    Link,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub name: String,
    pub path: String,
    pub kind: WorkspaceEntryKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct WorkspaceListResponse {
    pub path: String,
    pub entries: Vec<WorkspaceEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum WorkspaceInspectErrorKind {
    InvalidPath,
    NotFound,
    AccessDenied,
    PathNotAllowed,
    NotRegularFile,
    Oversized,
    Binary,
    InvalidEncoding,
    LongLine,
    Changed,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "status", rename_all = "camelCase")]
#[ts(tag = "status", rename_all = "camelCase")]
pub enum WorkspaceInspectResponse {
    Complete {
        path: String,
        content: String,
        bytes: u32,
        lines: u32,
        #[serde(rename = "hasUtf8Bom")]
        #[ts(rename = "hasUtf8Bom")]
        has_utf8_bom: bool,
    },
    Truncated {
        path: String,
        content: String,
        bytes: u32,
        #[serde(rename = "returnedBytes")]
        #[ts(rename = "returnedBytes")]
        returned_bytes: u32,
        lines: u32,
        #[serde(rename = "hasUtf8Bom")]
        #[ts(rename = "hasUtf8Bom")]
        has_utf8_bom: bool,
    },
    Error {
        path: String,
        kind: WorkspaceInspectErrorKind,
    },
}

fn validate_browser_path(path: &str) -> Result<(), &'static str> {
    if path.len() > MAX_WORKSPACE_BROWSER_PATH_BYTES
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.chars().any(char::is_control)
    {
        return Err("invalid workspace-relative path");
    }
    if path.is_empty() {
        return Ok(());
    }
    let mut components = 0usize;
    for component in path.split(['/', '\\']) {
        if component.is_empty() || matches!(component, "." | "..") {
            return Err("invalid workspace-relative path");
        }
        components += 1;
    }
    if components > MAX_WORKSPACE_BROWSER_PATH_COMPONENTS {
        return Err("workspace-relative path has too many components");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_accepts_root_and_rejects_unknown_fields() {
        let params: WorkspaceListParams = serde_json::from_str(r#"{"path":""}"#).expect("root");
        assert_eq!(params.path, "");
        assert!(
            serde_json::from_str::<WorkspaceListParams>(r#"{"path":"","absolutePath":"/private"}"#)
                .is_err()
        );
    }

    #[test]
    fn inspect_requires_a_safe_relative_file_path() {
        assert!(serde_json::from_str::<WorkspaceInspectParams>(r#"{"path":"src/lib.rs"}"#).is_ok());
        for value in [
            r#"{"path":""}"#,
            r#"{"path":"/etc/passwd"}"#,
            r#"{"path":"../secret"}"#,
            r#"{"path":"src//lib.rs"}"#,
        ] {
            assert!(serde_json::from_str::<WorkspaceInspectParams>(value).is_err());
        }
    }
}
