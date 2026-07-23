use crate::ThreadId;
use crate::TurnId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CoreRequestId(u64);

impl CoreRequestId {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreEvent {
    pub request_id: CoreRequestId,
    pub kind: CoreEventKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreEventKind {
    ThreadStarted {
        thread_id: ThreadId,
    },
    TurnStarted {
        thread_id: ThreadId,
        turn_id: TurnId,
    },
}
