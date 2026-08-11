use std::path::Path;
use url::Url;

pub const MAX_MCP_SERVERS: usize = 2;
const MAX_MCP_SERVER_ID_BYTES: usize = 32;
const MAX_MCP_PATH_BYTES: usize = 1024;
const MAX_MCP_ENDPOINT_BYTES: usize = 1024;
const MAX_MCP_ARG_COUNT: usize = 32;
const MAX_MCP_ARG_BYTES: usize = 8 * 1024;
const MAX_MCP_ARGV_BYTES: usize = 32 * 1024;

pub fn validate_mcp_stdio_server(
    id: &str,
    executable: &Path,
    argv: &[String],
    cwd: &Path,
) -> Result<(), &'static str> {
    validate_server_id(id)?;
    validate_path(executable)?;
    validate_path(cwd)?;
    if argv.len() > MAX_MCP_ARG_COUNT {
        return Err("tooManyArguments");
    }
    let mut total = 0_usize;
    for argument in argv {
        if argument.len() > MAX_MCP_ARG_BYTES || argument.chars().any(char::is_control) {
            return Err("invalidArgument");
        }
        total = total.saturating_add(argument.len());
    }
    if total > MAX_MCP_ARGV_BYTES {
        return Err("argumentsTooLarge");
    }
    Ok(())
}

pub fn validate_mcp_loopback_streamable_http_server(
    id: &str,
    raw_endpoint: &str,
) -> Result<(), &'static str> {
    validate_server_id(id)?;
    if raw_endpoint.is_empty()
        || raw_endpoint.len() > MAX_MCP_ENDPOINT_BYTES
        || raw_endpoint
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte == b'\\')
        || raw_endpoint.contains(['?', '#'])
    {
        return Err("invalidEndpoint");
    }
    let authority_and_path = raw_endpoint
        .strip_prefix("http://127.0.0.1:")
        .or_else(|| raw_endpoint.strip_prefix("http://[::1]:"))
        .ok_or("invalidEndpoint")?;
    let (port, path) = authority_and_path
        .split_once('/')
        .ok_or("invalidEndpoint")?;
    if port.is_empty()
        || port.len() > 5
        || !port.bytes().all(|byte| byte.is_ascii_digit())
        || port.parse::<u16>().ok().filter(|port| *port != 0).is_none()
        || path.is_empty()
    {
        return Err("invalidEndpoint");
    }
    let endpoint = Url::parse(raw_endpoint).map_err(|_| "invalidEndpoint")?;
    if endpoint.scheme() != "http"
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.port().is_none()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
        || endpoint.path() == "/"
    {
        return Err("invalidEndpoint");
    }
    match endpoint.host() {
        Some(url::Host::Ipv4(address)) if address.is_loopback() => Ok(()),
        Some(url::Host::Ipv6(address)) if address == std::net::Ipv6Addr::LOCALHOST => Ok(()),
        _ => Err("invalidEndpoint"),
    }
}

fn validate_server_id(id: &str) -> Result<(), &'static str> {
    let bytes = id.as_bytes();
    if bytes.is_empty()
        || bytes.len() > MAX_MCP_SERVER_ID_BYTES
        || !bytes[0].is_ascii_lowercase()
        || !is_ascii_lowercase_or_digit(bytes[bytes.len() - 1])
        || !bytes
            .iter()
            .all(|byte| is_ascii_lowercase_or_digit(*byte) || *byte == b'-')
    {
        return Err("invalidServerId");
    }
    Ok(())
}

fn validate_path(path: &Path) -> Result<(), &'static str> {
    let value = path.to_str().ok_or("invalidPath")?;
    if value.is_empty() || value.len() > MAX_MCP_PATH_BYTES || value.chars().any(char::is_control) {
        return Err("invalidPath");
    }
    if !path.is_absolute() || has_forbidden_windows_path_prefix(path) {
        return Err("pathMustBeExplicitAbsolute");
    }
    Ok(())
}

const fn is_ascii_lowercase_or_digit(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit()
}

fn has_forbidden_windows_path_prefix(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::path::Component;
        use std::path::Prefix;
        matches!(
            path.components().next(),
            Some(Component::Prefix(prefix))
                if matches!(
                    prefix.kind(),
                    Prefix::UNC(..)
                        | Prefix::Verbatim(..)
                        | Prefix::DeviceNS(..)
                        | Prefix::VerbatimUNC(..)
                        | Prefix::VerbatimDisk(..)
                )
        )
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}
