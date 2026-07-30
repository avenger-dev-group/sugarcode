mod bridge;
mod containment;
mod protocol;

use std::path::Path;

pub use bridge::BridgeError;

pub const TERMINAL_BRIDGE_PROTOCOL_VERSION: u32 = 1;

pub fn run_stdio(workspace: &Path, columns: u16, rows: u16) -> Result<(), BridgeError> {
    bridge::run_stdio(workspace, columns, rows)
}

#[cfg(test)]
#[path = "tests/bridge.rs"]
mod bridge_tests;

#[cfg(test)]
#[path = "tests/protocol.rs"]
mod protocol_tests;
