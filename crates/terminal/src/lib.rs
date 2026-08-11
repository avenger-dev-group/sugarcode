mod containment;
mod embedded;

pub use embedded::EmbeddedTerminal;
pub use embedded::EmbeddedTerminalEvent;
pub use embedded::EmbeddedTerminalExitReason;
pub use embedded::EmbeddedTerminalInfo;
pub use embedded::TerminalError;

#[cfg(test)]
#[path = "tests/embedded.rs"]
mod embedded_tests;
