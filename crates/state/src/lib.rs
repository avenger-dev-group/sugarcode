mod content;
mod mcp_config;

pub use content::ContentAsset;
pub use content::ContentAssetKind;
pub use content::ContentStore;
pub use content::ContentStoreError;
pub use content::MAX_IMAGE_BYTES;
pub use content::MAX_PDF_BYTES;
pub use content::MAX_PDF_PAGES;
pub use content::MAX_TEXT_BYTES;
pub use content::MAX_TURN_ATTACHMENT_BYTES;
pub use content::MAX_TURN_ATTACHMENTS;
pub use mcp_config::MAX_MCP_SERVERS;
pub use mcp_config::validate_mcp_loopback_streamable_http_server;
pub use mcp_config::validate_mcp_stdio_server;

#[cfg(test)]
#[path = "tests/content.rs"]
mod content_tests;

#[cfg(test)]
#[path = "tests/mcp_config.rs"]
mod mcp_config_tests;
