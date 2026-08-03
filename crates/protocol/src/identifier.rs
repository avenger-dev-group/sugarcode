use std::error::Error;
use std::fmt;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentifierParseError {
    kind: &'static str,
    value: String,
}

impl IdentifierParseError {
    pub(crate) fn new(kind: &'static str, value: String) -> Self {
        Self { kind, value }
    }
}

impl fmt::Display for IdentifierParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} must be a canonical lowercase UUIDv7, got {:?}",
            self.kind, self.value
        )
    }
}

impl Error for IdentifierParseError {}

pub(crate) fn new_v7() -> String {
    Uuid::now_v7().hyphenated().to_string()
}

pub(crate) fn parse_v7(
    kind: &'static str,
    value: impl Into<String>,
) -> Result<String, IdentifierParseError> {
    let value = value.into();
    let parsed =
        Uuid::parse_str(&value).map_err(|_| IdentifierParseError::new(kind, value.clone()))?;
    if parsed.get_version_num() != 7 || parsed.hyphenated().to_string() != value {
        return Err(IdentifierParseError::new(kind, value));
    }
    Ok(value)
}
