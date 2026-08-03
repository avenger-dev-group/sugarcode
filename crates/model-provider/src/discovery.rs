use crate::ModelError;
use crate::ModelErrorKind;
use crate::append_path;
use reqwest::header::AUTHORIZATION;
use reqwest::header::HeaderName;
use reqwest::header::HeaderValue;
use serde_json::Value;
use std::time::Duration;
use url::Url;
use zeroize::Zeroizing;

const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_DISCOVERY_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelDiscoveryProtocol {
    OpenAi,
    Anthropic,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredModel {
    pub model_id: String,
    pub display_name: String,
    pub context_window_tokens: Option<u32>,
}

pub async fn discover_models(
    base_url: &Url,
    token: Option<Zeroizing<String>>,
    protocol: ModelDiscoveryProtocol,
) -> Result<Vec<DiscoveredModel>, ModelError> {
    let endpoint = append_path(base_url, "models")?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| ModelError::new(ModelErrorKind::Transport, true))?;
    let mut request = client.get(endpoint);
    match protocol {
        ModelDiscoveryProtocol::OpenAi => {
            if let Some(token) = token.as_ref() {
                request = request.header(AUTHORIZATION, bearer(token)?);
            }
        }
        ModelDiscoveryProtocol::Anthropic => {
            if let Some(token) = token.as_ref() {
                request = request.header(HeaderName::from_static("x-api-key"), sensitive(token)?);
            }
            request = request.header(
                HeaderName::from_static("anthropic-version"),
                HeaderValue::from_static("2023-06-01"),
            );
        }
    }
    let response = tokio::time::timeout(DISCOVERY_TIMEOUT, request.send())
        .await
        .map_err(|_| ModelError::new(ModelErrorKind::Timeout, true))?
        .map_err(|error| {
            ModelError::new(
                if error.is_timeout() {
                    ModelErrorKind::Timeout
                } else {
                    ModelErrorKind::Transport
                },
                true,
            )
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => ModelError::new(ModelErrorKind::Authentication, false),
            408 => ModelError::new(ModelErrorKind::Timeout, true),
            429 => ModelError::new(ModelErrorKind::RateLimited, true),
            400..=499 => ModelError::new(ModelErrorKind::InvalidRequest, false),
            _ => ModelError::new(ModelErrorKind::Server, true),
        });
    }
    let bytes = tokio::time::timeout(DISCOVERY_TIMEOUT, response.bytes())
        .await
        .map_err(|_| ModelError::new(ModelErrorKind::Timeout, true))?
        .map_err(|_| ModelError::new(ModelErrorKind::Transport, true))?;
    if bytes.len() > MAX_DISCOVERY_BYTES {
        return Err(ModelError::new(ModelErrorKind::OutputTooLarge, false));
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| ModelError::new(ModelErrorKind::Protocol, false))?;
    parse_discovered_models(&value)
}

fn parse_discovered_models(value: &Value) -> Result<Vec<DiscoveredModel>, ModelError> {
    let entries = value
        .get("data")
        .or_else(|| value.get("models"))
        .and_then(Value::as_array)
        .ok_or_else(|| ModelError::new(ModelErrorKind::Protocol, false))?;
    let mut models = entries
        .iter()
        .filter_map(|entry| {
            let raw_id = entry
                .get("id")
                .or_else(|| entry.get("name"))
                .and_then(Value::as_str)?;
            let model_id = raw_id.strip_prefix("models/").unwrap_or(raw_id);
            if model_id.is_empty() || model_id.len() > 256 {
                return None;
            }
            let display_name = entry
                .get("display_name")
                .or_else(|| entry.get("displayName"))
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty() && name.len() <= 128)
                .unwrap_or(model_id);
            let context_window_tokens = ["context_window", "contextWindow", "inputTokenLimit"]
                .into_iter()
                .find_map(|field| entry.get(field).and_then(Value::as_u64))
                .and_then(|value| u32::try_from(value).ok())
                .filter(|value| (4_096..=2_097_152).contains(value));
            Some(DiscoveredModel {
                model_id: model_id.to_owned(),
                display_name: display_name.to_owned(),
                context_window_tokens,
            })
        })
        .collect::<Vec<_>>();
    models.sort_by(|left, right| left.model_id.cmp(&right.model_id));
    models.dedup_by(|left, right| left.model_id == right.model_id);
    Ok(models)
}

fn bearer(token: &str) -> Result<HeaderValue, ModelError> {
    let value = Zeroizing::new(format!("Bearer {token}"));
    sensitive(&value)
}

fn sensitive(token: &str) -> Result<HeaderValue, ModelError> {
    let mut value = HeaderValue::from_str(token)
        .map_err(|_| ModelError::new(ModelErrorKind::Authentication, false))?;
    value.set_sensitive(true);
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovered_context_is_only_kept_when_reliable_and_bounded() {
        let models = parse_discovered_models(&serde_json::json!({
            "models": [
                {
                    "name": "models/anthropic-large",
                    "displayName": "Anthropic Large",
                    "inputTokenLimit": 200000
                },
                {
                    "id": "manual-only",
                    "context_window": 1024
                },
                {
                    "id": "anthropic-large",
                    "contextWindow": 128000
                }
            ]
        }))
        .expect("models");
        assert_eq!(
            models,
            vec![
                DiscoveredModel {
                    model_id: "anthropic-large".to_owned(),
                    display_name: "Anthropic Large".to_owned(),
                    context_window_tokens: Some(200_000),
                },
                DiscoveredModel {
                    model_id: "manual-only".to_owned(),
                    display_name: "manual-only".to_owned(),
                    context_window_tokens: None,
                },
            ]
        );
    }
}
