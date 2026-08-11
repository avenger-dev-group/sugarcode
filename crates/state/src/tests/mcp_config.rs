use crate::validate_mcp_loopback_streamable_http_server;
use crate::validate_mcp_stdio_server;
use std::path::Path;

#[cfg(unix)]
const EXECUTABLE: &str = "/usr/bin/node";
#[cfg(unix)]
const CWD: &str = "/tmp";
#[cfg(windows)]
const EXECUTABLE: &str = r"C:\Program Files\nodejs\node.exe";
#[cfg(windows)]
const CWD: &str = r"C:\workspace";

#[test]
fn stdio_validation_requires_explicit_bounded_authority() {
    assert_eq!(
        validate_mcp_stdio_server(
            "local-tools",
            Path::new(EXECUTABLE),
            &["server.mjs".to_owned()],
            Path::new(CWD),
        ),
        Ok(()),
    );
    assert_eq!(
        validate_mcp_stdio_server("Bad", Path::new(EXECUTABLE), &[], Path::new(CWD)),
        Err("invalidServerId"),
    );
    assert_eq!(
        validate_mcp_stdio_server("local", Path::new("node"), &[], Path::new(CWD)),
        Err("pathMustBeExplicitAbsolute"),
    );
    assert_eq!(
        validate_mcp_stdio_server(
            "local",
            Path::new(EXECUTABLE),
            &["bad\nargument".to_owned()],
            Path::new(CWD),
        ),
        Err("invalidArgument"),
    );
}

#[test]
fn http_validation_accepts_only_explicit_loopback_endpoints() {
    assert_eq!(
        validate_mcp_loopback_streamable_http_server("local-http", "http://127.0.0.1:4318/mcp",),
        Ok(()),
    );
    assert_eq!(
        validate_mcp_loopback_streamable_http_server("local-http", "http://[::1]:4318/mcp",),
        Ok(()),
    );
    for endpoint in [
        "http://localhost:4318/mcp",
        "https://127.0.0.1:4318/mcp",
        "http://127.0.0.1:0/mcp",
        "http://127.0.0.1:4318/",
        "http://127.0.0.1:4318/mcp?token=secret",
    ] {
        assert_eq!(
            validate_mcp_loopback_streamable_http_server("local-http", endpoint),
            Err("invalidEndpoint"),
        );
    }
}
